import { createHash, randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { startCodex } from "@/utils/ai/codexHost";
import type { CodexPacket, CodexRpc } from "@/utils/ai/codexRpc";
import { codexErrorMessage } from "@/utils/ai/codexRpc";

type Output = ReturnType<typeof createAssistantMessageEventStream>;
type Scope = {
  rpc: CodexRpc; threadId: string; turnId?: string; modelId: string; prefix: string; tools: string;
  pending: Map<string, { requestIds: (string | number)[]; name: string; arguments: Record<string, unknown>; delivered: boolean; callId: string }>;
  calls: Map<string, { hash: string; id: string; result?: unknown }>;
  output?: Output; message?: AssistantMessage; timer?: ReturnType<typeof setTimeout>;
  abort?: () => void; signal?: AbortSignal; failure?: string; toolCount: number;
};
const scopes = new Map<string, Scope>();
const starting = new Map<string, AbortController>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function emptyMessage(model: Model<any>): AssistantMessage {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "pending",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

function finishSegment(scope: Scope, reason: "stop" | "toolUse") {
  if (!scope.output || !scope.message) return;
  scope.message.stopReason = reason;
  scope.message.content.forEach((part, contentIndex) => {
    if (part.type === "text") scope.output!.push({ type: "text_end", contentIndex, content: part.text, partial: scope.message! });
    if (part.type === "toolCall") scope.output!.push({ type: "toolcall_end", contentIndex, toolCall: part, partial: scope.message! });
  });
  scope.output.push({ type: "done", reason, message: scope.message });
  scope.output.end();
  scope.output = undefined;
  scope.message = undefined;
  scope.signal?.removeEventListener("abort", scope.abort!);
  scope.signal = undefined;
}

function fail(scope: Scope, reason: string, aborted = false) {
  if (scope.failure) return;
  scope.failure = reason;
  clearTimeout(scope.timer);
  scope.signal?.removeEventListener("abort", scope.abort!);
  if (scope.output && scope.message) {
    const message = { ...scope.message, stopReason: aborted ? "aborted" as const : "error" as const, errorMessage: reason };
    scope.output.push({ type: "error", reason: message.stopReason, error: message });
    scope.output.end();
    scope.output = undefined;
  }
  scope.rpc.close(reason);
  // 保留失败标记至任务结束，阻止 SDK 自动重试重放已发起的工具或媒体请求。
}

export function cancelCodexTask(taskId: string) {
  starting.get(taskId)?.abort();
  const scope = scopes.get(taskId);
  if (scope && !scope.rpc.closed) fail(scope, "Codex 任务已取消", true);
}

function armTimeout(scope: Scope, pending = false) {
  clearTimeout(scope.timer);
  scope.timer = setTimeout(() => fail(scope, pending ? "等待 Toonflow 工具结果超时，任务不会重放" : "Codex 推理超时，任务不会自动重试"), pending ? 900000 : 300000);
  scope.timer.unref();
}

function bindOutput(scope: Scope, output: Output, message: AssistantMessage, signal?: AbortSignal) {
  scope.output = output;
  scope.message = message;
  scope.signal = signal;
  scope.abort = () => fail(scope, "Codex 任务已取消", true);
  signal?.addEventListener("abort", scope.abort, { once: true });
  signal?.throwIfAborted();
  output.push({ type: "start", partial: message });
  armTimeout(scope);
}

function handleNotification(scope: Scope, packet: CodexPacket) {
  const p = packet.params;
  if (p?.threadId !== scope.threadId || scope.failure) return;
  if (packet.method === "turn/started") scope.turnId ??= p.turn?.id;
  if (p.turnId && scope.turnId && p.turnId !== scope.turnId) return;
  if (packet.method === "item/agentMessage/delta" && typeof p.delta === "string" && scope.output && scope.message) {
    armTimeout(scope);
    const content = scope.message.content;
    let index = content.length - 1;
    if (content[index]?.type !== "text") {
      index = content.push({ type: "text", text: "" }) - 1;
      scope.output.push({ type: "text_start", contentIndex: index, partial: scope.message });
    }
    const text = content[index];
    if (text?.type === "text") text.text += p.delta;
    scope.output.push({ type: "text_delta", contentIndex: index, delta: p.delta, partial: scope.message });
  }
  if (packet.method === "item/started" && ["commandExecution", "fileChange", "mcpToolCall", "collabAgentToolCall", "imageGeneration"].includes(p.item?.type)) {
    fail(scope, "Codex 尝试调用宿主未授权的内置工具，任务已停止；请通过 Toonflow 工具操作");
  }
  if (packet.method === "error") fail(scope, `${codexErrorMessage(p.error)}；当前任务不会自动重试`);
  if (packet.method === "thread/tokenUsage/updated" && scope.message) {
    const usage = p.tokenUsage?.last;
    if (usage && [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens, usage.totalTokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
      Object.assign(scope.message.usage, { input: Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens), output: usage.outputTokens,
        cacheRead: usage.cachedInputTokens, cacheWrite: usage.cacheWriteInputTokens, totalTokens: usage.totalTokens });
    }
  }
  if (packet.method === "turn/completed") {
    if (scope.turnId && p.turn?.id !== scope.turnId) return;
    if (p.turn?.status !== "completed") { fail(scope, codexErrorMessage(p.turn?.error)); return; }
    if (scope.pending.size) { fail(scope, "Codex 在工具结果返回前结束了任务"); return; }
    clearTimeout(scope.timer);
    finishSegment(scope, "stop");
    scope.rpc.close();
  }
}

function handleRequest(scope: Scope, packet: CodexPacket, context: Context) {
  const p = packet.params;
  if (scope.failure || packet.method !== "item/tool/call" || packet.id === undefined || p?.threadId !== scope.threadId
    || (scope.turnId && p.turnId !== scope.turnId) || p.namespace != null || !context.tools?.some(tool => tool.name === p.tool)
    || !p.arguments || typeof p.arguments !== "object" || Array.isArray(p.arguments) || typeof p.callId !== "string") {
    fail(scope, "Codex 发起了无效或未授权的工具请求，任务已停止");
    return;
  }
  scope.turnId ??= p.turnId;
  const fingerprint = hash([p.tool, p.arguments]);
  const previous = scope.calls.get(p.callId);
  if (previous) {
    if (previous.hash !== fingerprint) { fail(scope, "Codex 重复工具调用的参数发生变化，已停止任务"); return; }
    if (previous.result !== undefined) scope.rpc.send({ id: packet.id, result: previous.result });
    else scope.pending.get(previous.id)?.requestIds.push(packet.id);
    return;
  }
  if (++scope.toolCount > 40) { fail(scope, "Codex 已达到单任务 40 次工具调用上限，请缩小任务"); return; }
  const id = randomUUID();
  scope.calls.set(p.callId, { hash: fingerprint, id });
  scope.pending.set(id, { requestIds: [packet.id], name: p.tool, arguments: p.arguments, delivered: false, callId: p.callId });
  deliverTools(scope);
  armTimeout(scope, true);
}

function deliverTools(scope: Scope) {
  if (!scope.output || !scope.message) return;
  for (const [id, call] of scope.pending) {
    if (call.delivered) continue;
    call.delivered = true;
    const contentIndex = scope.message.content.push({ type: "toolCall", id, name: call.name, arguments: call.arguments }) - 1;
    scope.output.push({ type: "toolcall_start", contentIndex, partial: scope.message });
  }
  if (scope.message.content.some(part => part.type === "toolCall")) finishSegment(scope, "toolUse");
}

function requestPayload(context: Context) {
  return { input: context.messages.flatMap<Record<string, unknown>>(message => {
    if (message.role === "toolResult") return [{ type: "function_call_output", call_id: message.toolCallId, output: JSON.stringify(message.content) }];
    if (typeof message.content === "string") return [{ role: message.role, content: [{ type: "input_text", text: message.content }] }];
    const content = message.content.flatMap<Record<string, unknown>>(part => part.type === "image"
      ? [{ type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` }]
      : part.type === "text" ? [{ type: message.role === "assistant" ? "output_text" : "input_text", text: part.text }] : []);
    return [{ role: message.role, content }, ...message.content.flatMap(part => part.type === "toolCall"
      ? [{ type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.arguments) }] : [])];
  }) };
}

function turnInput(payload: ReturnType<typeof requestPayload>) {
  const input: { type: string; text?: string; url?: string; text_elements?: unknown[] }[] = [];
  // ACT: 已保存的历史只作为带角色的上下文导入，不复原/执行旧工具调用；活跃工具严格走同一 RPC 续接。
  const history = payload.input.map(message => ({ ...message, ...(Array.isArray(message.content)
    ? { content: message.content.filter(part => part.type !== "input_image") } : {}) }));
  input.push({ type: "text", text: `以下 JSON 是 Toonflow 保存的对话上下文；历史工具调用仅供理解，禁止重放。执行最后一条用户请求，并通过当前提供的 Toonflow 工具进行操作。\n${JSON.stringify(history)}`, text_elements: [] });
  for (const message of payload.input) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "input_image") {
        if (typeof part.image_url !== "string" || !part.image_url.startsWith("data:image/")) throw new Error("Codex 图片上下文必须使用有效内联图片");
        input.push({ type: "image", url: part.image_url });
      } else if (!["input_text", "output_text"].includes(part.type)) throw new Error("Codex 暂不支持此附件类型，请先转换成文本或图片");
    }
  }
  return input;
}

export function streamCodex(model: Model<any>, context: Context, options: SimpleStreamOptions = {}) {
  const output = createAssistantMessageEventStream();
  const message = emptyMessage(model);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  void (async () => {
    const taskId = options.sessionId;
    let scope: Scope | undefined;
    let ownsStart = false;
    try {
      signal.throwIfAborted();
      if (!taskId || !zUuid(taskId)) throw new Error("Codex 请求缺少稳定的任务 UUID，请更新 Toonflow 宿主与节点插件");
      if (starting.has(taskId)) throw new Error("同一 Codex 任务已有请求正在启动，请勿重复提交");
      starting.set(taskId, controller);
      ownsStart = true;
      const toolsHash = hash([context.systemPrompt ?? "", context.tools ?? []]);
      const originalPayload = requestPayload(context);
      const payload = await options.onPayload?.(originalPayload, model) ?? originalPayload;
      signal.throwIfAborted();
      if (!payload || typeof payload !== "object" || !Array.isArray((payload as typeof originalPayload).input)) throw new Error("Codex 请求上下文格式无效");
      if (Buffer.byteLength(JSON.stringify(payload)) > 32 * 1024 * 1024) throw new Error("Codex 请求超过 32 MB，请压缩上下文");
      scope = scopes.get(taskId);
      if (scope?.failure) throw new Error(scope.failure);
      if (scope && !scope.rpc.closed) {
        if (scope.output || scope.modelId !== model.id || scope.tools !== toolsHash || !scope.pending.size) throw new Error("Codex 任务正在运行或工具配置已变更，请重新发起任务");
        const lastAssistant = context.messages.findLastIndex(item => item.role === "assistant");
        if (lastAssistant < 0 || hash(context.messages.slice(0, lastAssistant)) !== scope.prefix) throw new Error("Codex 工具续接上下文不匹配，已阻止重放");
        const suffix = context.messages.slice(lastAssistant + 1);
        const results = suffix.filter(item => item.role === "toolResult");
        const additions = suffix.filter(item => item.role === "user");
        if (results.length !== [...scope.pending.values()].filter(call => call.delivered).length
          || new Set(results.map(item => item.toolCallId)).size !== results.length
          || results.some(item => !scope!.pending.get(item.toolCallId)?.delivered)
          || suffix.some(item => item.role !== "toolResult" && item.role !== "user")) throw new Error("Codex 工具结果与当前任务不匹配");
        bindOutput(scope, output, message, signal);
        scope.prefix = hash(context.messages);
        for (const [index, result] of results.entries()) {
          if (result.role !== "toolResult") continue;
          const call = scope.pending.get(result.toolCallId)!;
          if (call.name !== result.toolName) throw new Error("Codex 工具结果名称不匹配");
          scope.pending.delete(result.toolCallId);
          const value = {
            success: !result.isError,
            contentItems: [
              ...result.content.map(part => part.type === "text" ? { type: "inputText", text: part.text } : { type: "inputImage", imageUrl: `data:${part.mimeType};base64,${part.data}` }),
              // 子 Agent 报告和人工补充由宿主追加到上下文；随最后一个工具结果交回同一回合，不重启或重放调用。
              ...(index === results.length - 1 && additions.length ? [{ type: "inputText", text: `Toonflow 在等待工具期间收到以下上下文补充：\n${JSON.stringify(additions)}` }] : []),
            ],
          };
          scope.calls.get(call.callId)!.result = value;
          for (const id of call.requestIds) scope.rpc.send({ id, result: value });
        }
        deliverTools(scope);
        if (scope.pending.size) armTimeout(scope, true);
        return;
      }
      const lastAssistant = context.messages.findLastIndex(item => item.role === "assistant");
      if (context.messages.slice(lastAssistant + 1).some(item => item.role === "toolResult")) throw new Error("Codex 服务已重启或原工具任务已结束，不能重放工具结果；请重新发起任务");
      if (scopes.size >= 512) {
        for (const [id, previous] of scopes) if (previous.rpc.closed && !previous.failure) scopes.delete(id);
        if (scopes.size >= 512) throw new Error("Codex 任务记录达到上限，请重启 Toonflow 后继续");
      }
      const { rpc, scratch } = await startCodex(model.id, false, signal);
      scope = { rpc, threadId: "", modelId: model.id, prefix: hash(context.messages), tools: toolsHash, pending: new Map(), calls: new Map(), toolCount: 0 };
      scopes.set(taskId, scope);
      const current = scope;
      rpc.on("closed", (error: Error) => { if (current.output || current.pending.size) fail(current, error.message); });
      rpc.on("notification", packet => handleNotification(current, packet));
      rpc.on("request", packet => handleRequest(current, packet, context));
      bindOutput(scope, output, message, signal);
      const thread = await rpc.request("thread/start", {
        model: model.id, allowProviderModelFallback: false, cwd: scratch, ephemeral: true, sandbox: "read-only", approvalPolicy: "never",
        baseInstructions: context.systemPrompt ?? "你是 Toonflow 助手。通过 Toonflow 工具完成用户任务。",
        dynamicTools: (context.tools ?? []).map(tool => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.parameters, deferLoading: false })),
      });
      scope.threadId = thread.thread.id;
      const started = await rpc.request("turn/start", { threadId: scope.threadId, model: model.id, input: turnInput(payload as typeof originalPayload),
        ...(options.reasoning ? { effort: options.reasoning } : {}) });
      scope.turnId ??= started.turn.id;
    } catch (error) {
      const reason = signal.aborted ? "Codex 任务已取消" : error instanceof Error ? error.message : "Codex 请求失败";
      if (scope && !scope.failure) fail(scope, reason, signal.aborted);
      message.stopReason = signal.aborted ? "aborted" : "error";
      message.errorMessage = reason;
      output.push({ type: "error", reason: message.stopReason, error: message });
      output.end();
    } finally {
      if (ownsStart) starting.delete(taskId!);
    }
  })();
  return output;
}

function zUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
