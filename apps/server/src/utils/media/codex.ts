import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { appendFile, lstat, readFile, realpath } from "@toonflow/file";
import conf from "@/utils/conf";
import { getCodexProvider, getDefaultAiModel, startCodex } from "@/utils/ai/codexHost";
import type { CodexRpc } from "@/utils/ai/codexRpc";
import { codexErrorMessage } from "@/utils/ai/codexRpc";

const codexImageSizes = ["原生尺寸", "1K", "2K", "4K"];
const codexImageRatios = ["9:16", "16:9", "1:1", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9", "9:21"];

// 正式内置供应商，源码只声明菜单能力；原生生成由宿主注入，不能通过安装文件替换。
export const codexMediaSource = `export default {
  id: "codex", label: "Codex（本机登录）", version: "1.1.0",
  readme: "使用官方 Codex CLI 当前 ChatGPT 登录。支持单张文生图，可选择构图比例及原生尺寸、1K、2K、4K 目标分辨率，通过生成指令传入；实际像素尺寸以产物为准，不保证精确尺寸。参考图、局部重绘、打光、多角度暂不支持。原生单回合可能含多次内部调用，不能保证只消耗一张额度。",
  models: [{ id: "codexImage", label: "Codex · 原生文生图", type: "image", mode: ["text"], imageSizes: ${JSON.stringify(codexImageSizes)}, imageRatios: ${JSON.stringify(codexImageRatios)} }],
  rules: [],
  async generateImage() { throw new Error("Codex 图片生成需要 Toonflow 原生宿主"); }
};`;

function redactImageError(value: unknown) {
  if (typeof value !== "string") return undefined;
  return value.slice(0, 8192)
    .replace(/(?:Bearer\s+|sk-)[a-zA-Z0-9_.-]+/gi, "<redacted>")
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie)["']?\s*[:=]\s*)[^\s,;}]+/gi, "$1<redacted>")
    .replace(/https?:\/\/[^\s"'<>]+/gi, value => {
      try { const url = new URL(value); return `${url.origin}${url.pathname}${url.search ? "?<redacted>" : ""}`; }
      catch { return "<redactedUrl>"; }
    })
    .replace(/[a-zA-Z0-9+/=_-]{120,}/g, "<redactedData>")
    .slice(0, 2048);
}

export async function generateCodexImage(request: ImageRequest, signal?: AbortSignal): Promise<MediaAsset[]> {
  if (request.model !== "codexImage" || request.images?.length || request.mask || (request.n !== undefined && request.n !== 1)) throw new Error("Codex 首期仅支持单张文生图，不支持参考图、局部重绘或多张生成");
  const ratio = request.ratio ?? "9:16";
  const size = request.size ?? "原生尺寸";
  if (!codexImageRatios.includes(ratio)) throw new Error(`Codex 图片比例须为 ${codexImageRatios.join("、")}`);
  if (!codexImageSizes.includes(size)) throw new Error(`Codex 图片目标分辨率须为 ${codexImageSizes.join("、")}`);
  if (!request.prompt?.trim() || request.prompt.length > 12000) throw new Error("Codex 图片提示词须为 1 到 12000 字符");
  signal?.throwIfAborted();
  const configured = getDefaultAiModel();
  const models = getCodexProvider().models;
  const modelId = configured.providerId === "codex" ? configured.modelId : models.find(model => model.id === "gpt-6.1-sol")?.id;
  if (!modelId) throw new Error("请在文本模型设置中选择可用的 Codex 默认模型，再生成图片");
  let rpc: CodexRpc | undefined;
  let threadId = "";
  let turnId = "";
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const logPath = join(dirname(conf.path), "codexImageLog.jsonl");
  let logWrites = Promise.resolve();
  function logImageEvent(event: string, details: Record<string, unknown> = {}) {
    const line = JSON.stringify({ time: new Date().toISOString(), requestId, threadId, turnId, elapsedMs: Date.now() - startedAt, event, ...details });
    console.info(`[codexImage] ${line}`);
    logWrites = logWrites.then(() => appendFile(logPath, `${line}\n`, { mode: 0o600 }))
      .catch(error => { console.error("[codexImage] 日志写入失败：", (error as NodeJS.ErrnoException).code ?? "未知错误"); });
  }
  logImageEvent("started", { modelId, ratio, size, promptLength: request.prompt.length,
    proxyConfigured: !!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY) });
  const images: { savedPath?: string; status?: string; failure?: { type?: string; resetsAt?: number | null } }[] = [];
  const completed = Promise.withResolvers<void>();
  // 任务可能在启动 RPC 应答之前失败，预先消费 rejection，最终 await 仍会抛出。
  void completed.promise.catch(() => {});
  const abort = () => { completed.reject(new Error("Codex 图片生成已取消；不会自动重试")); rpc?.close(); };
  const timer = setTimeout(() => { completed.reject(new Error("Codex 图片生成超时；可能已消费额度，不会自动重试")); rpc?.close(); }, 600000);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const started = await startCodex(modelId, true, signal);
    rpc = started.rpc;
    logImageEvent("connected", { executable: started.executable });
    signal?.throwIfAborted();
    rpc.on("closed", () => completed.reject(new Error("Codex 图片服务已退出；任务状态未知，不会重新提交")));
    rpc.on("request", () => { completed.reject(new Error("Codex 图片回合发起了不支持的额外工具请求")); rpc?.close(); });
    rpc.on("notification", packet => {
      const p = packet.params;
      if (p?.threadId !== threadId) return;
      if (packet.method === "turn/started") turnId ||= p.turn?.id;
      if (p.turnId && turnId && p.turnId !== turnId) return;
      if (packet.method === "error") {
        logImageEvent("rpcError", { error: redactImageError(p.error?.message), code: redactImageError(JSON.stringify(p.error?.codexErrorInfo)) });
        completed.reject(new Error(codexErrorMessage(p.error))); rpc?.close(); return;
      }
      if (packet.method === "item/started" && ["commandExecution", "fileChange", "mcpToolCall", "collabAgentToolCall"].includes(p.item?.type)) {
        completed.reject(new Error("Codex 图片回合尝试执行额外操作，已停止")); rpc?.close();
      }
      if (packet.method === "item/completed" && p.item?.type === "imageGeneration") {
        images.push(p.item);
        logImageEvent("imageCompleted", { itemId: p.item.id, status: p.item.status, failure: redactImageError(JSON.stringify(p.item.failure)),
          hasSavedPath: !!p.item.savedPath, resultLength: typeof p.item.result === "string" ? p.item.result.length : 0,
          error: p.item.status !== "completed" || p.item.failure ? redactImageError(p.item.result) : undefined });
      }
      if (packet.method === "turn/completed") {
        if (turnId && p.turn?.id !== turnId) return;
        logImageEvent("turnCompleted", { status: p.turn?.status, imageCount: images.length, error: redactImageError(p.turn?.error?.message) });
        if (p.turn?.status === "completed") completed.resolve();
        else completed.reject(new Error("Codex 图片生成未完成，请检查官方账户图片额度、登录状态与模型能力"));
      }
    });
    const thread = await rpc.request("thread/start", { model: modelId, allowProviderModelFallback: false, cwd: started.scratch, ephemeral: true, sandbox: "read-only", approvalPolicy: "never", dynamicTools: [] });
    threadId = thread.thread.id;
    // ACT: 当前 CLI 的 imagegen 仅接收 prompt 等参数；比例与分辨率作为目标传入，产物像素单独记录，不用缩放冒充原生清晰度。
    const resolution = size === "原生尺寸" ? "Use the tool's native output resolution."
      : `Target resolution: ${size}. Generate native detail appropriate for ${size}; do not upscale a smaller image or change the requested aspect ratio.`;
    const turn = await rpc.request("turn/start", { threadId, model: modelId, input: [{ type: "text", text:
      `Use image_gen.imagegen to generate one new image. Do not read or edit existing images. Do not create variants or retry failed calls. Return after the image result. Include these output requirements in the imagegen prompt: target aspect ratio ${ratio} (width:height). ${resolution} Native pixel dimensions may vary. Content prompt:\n${request.prompt}`, text_elements: [] }] });
    turnId ||= turn.turn.id;
    await completed.promise;
    signal?.throwIfAborted();
    const limited = images.find(image => image.failure?.type === "usageLimitExceeded");
    if (limited) {
      const resetsAt = limited.failure?.resetsAt;
      const resetTime = typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > 0 && resetsAt < 8640000000000
        ? `，预计 ${new Date(resetsAt * 1000).toLocaleString("zh-CN")} 恢复` : "";
      throw new Error(`Codex 图片额度已用尽${resetTime}；不会自动重试`);
    }
    if (!images.length) throw new Error("Codex 回合已结束，但没有返回图片生成结果；不会自动补生成");
    if (images.length !== 1) throw new Error(`Codex 返回了 ${images.length} 个图片生成结果，无法确认为单张输出；不会自动补生成`);
    if (images[0]!.status !== "completed" || images[0]!.failure) {
      const status = /^[a-zA-Z_]{1,32}$/.test(images[0]!.status ?? "") ? images[0]!.status : "未知";
      throw new Error(`Codex 图片工具未成功完成（状态：${status}）；不会自动重试`);
    }
    const savedPath = images[0]!.savedPath;
    if (!savedPath || !isAbsolute(savedPath) || !/^[a-zA-Z0-9_-]+$/.test(threadId)) throw new Error("Codex 图片产物路径无效");
    const root = await realpath(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "generated_images", threadId));
    const info = await lstat(savedPath);
    const path = await realpath(savedPath);
    const child = relative(root, path);
    if (info.isSymbolicLink() || !info.isFile() || !child || child.startsWith("..") || isAbsolute(child) || !info.size || info.size > 100 * 1024 * 1024) throw new Error("Codex 图片产物超出允许目录或大小上限");
    const bytes = await readFile(path, { signal });
    if (!bytes.length || bytes.length > 100 * 1024 * 1024) throw new Error("Codex 图片产物为空或超过大小上限");
    const image = new Bun.Image(bytes);
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > 40000000) throw new Error("Codex 图片像素尺寸无效或过大");
    const data = await image.png().toBuffer();
    logImageEvent("succeeded", { width: metadata.width, height: metadata.height, bytes: data.length });
    return [{ mediaType: "image", type: "binary", mimeType: "image/png", data }];
  } catch (error) {
    logImageEvent("failed", { error: redactImageError(error instanceof Error ? error.message : String(error)), imageCount: images.length });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    rpc?.close();
    await logWrites;
  }
}
