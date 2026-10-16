import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delimiter, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { access, constants, mkdtemp, rm, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import conf from "@/utils/conf";
import { CodexRpc } from "@/utils/ai/codexRpc";
import catalogModel from "@/utils/ai/codexCatalog.json";

export const codexConfigSchema = z.object({ executable: z.string().max(4096).refine(value => !value || isAbsolute(value), "Codex CLI 路径必须为绝对路径").optional() });
export const codexProviderId = "codex";
export const codexDefaultModelId = "gpt-6.1-sol";
export type CodexModel = { id: string; label: string; contextWindow: number; maxOutputTokens: number };
let models: CodexModel[] = [{ id: codexDefaultModelId, label: "Codex · GPT-6.1-Sol", contextWindow: 262144, maxOutputTokens: 32768 }];
let defaultCodexModelId = codexDefaultModelId;
const children = new Set<CodexRpc>();
let startingChildren = 0;
let configRevision = 0;
let closing = false;
const execute = promisify(execFile);

export function getCodexProvider() {
  return { id: codexProviderId, label: "Codex（本机登录）", apiUrl: "http://localhost", apiKey: "", protocol: "openai-responses" as const,
    maxRequestImageBytes: 20 * 1024 * 1024, maxRequestBytes: 32 * 1024 * 1024, models };
}

export function getDefaultAiModel() {
  const value = conf.get("settings", {}).defaultTextModel as { providerId?: unknown; modelId?: unknown } | undefined;
  return typeof value?.providerId === "string" && typeof value.modelId === "string" && value.providerId && value.modelId
    ? { providerId: value.providerId, modelId: value.modelId }
    : { providerId: codexProviderId, modelId: defaultCodexModelId };
}

async function executablePath() {
  const config = codexConfigSchema.parse(conf.get("settings", {}).codex ?? {});
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  const candidates = config.executable ? [config.executable] : [
    ...((process.env.PATH ?? "").split(delimiter).filter(Boolean).map(directory => join(directory, name))),
    join(homedir(), ".local", "bin", name), join(homedir(), ".npm-global", "bin", name), "/opt/homebrew/bin/codex", "/usr/local/bin/codex",
  ];
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path; } catch { /* 继续查找标准安装位置。 */ }
  }
  throw new Error("未找到官方 Codex CLI，请在本机安装并登录，或在设置中填写 CLI 绝对路径");
}

export async function startCodex(modelId?: string, image = false, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (closing) throw new Error("Toonflow 正在退出");
  if (children.size + startingChildren >= 16) throw new Error("Codex 同时运行任务已达 16 个，请稍后再试");
  startingChildren++;
  const revision = configRevision;
  try { return await launchCodex(modelId, image, revision, signal); }
  finally { startingChildren--; }
}

async function launchCodex(modelId: string | undefined, image: boolean, revision: number, signal?: AbortSignal) {
  const executable = await executablePath();
  signal?.throwIfAborted();
  const env = Object.fromEntries(["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "CODEX_HOME", "PATH", "TMPDIR", "TEMP", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SystemRoot"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  let servers: { name: string }[];
  try {
    const result = await execute(executable, ["mcp", "list", "--json", "-c", "features.plugins=false"], { env, signal, timeout: 10000, maxBuffer: 1024 * 1024 });
    servers = z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,96}$/) })).parse(JSON.parse(result.stdout));
  } catch {
    signal?.throwIfAborted();
    throw new Error("无法读取 Codex MCP 配置，已阻止启动以避免绕过 Toonflow 工具执行");
  }
  const scratch = await mkdtemp(join(tmpdir(), "toonflowCodex"));
  try {
    const settings = [
      'model_provider="openai"', 'forced_login_method="chatgpt"',
      'features.shell_tool=false', 'features.shell_snapshot=false', 'web_search="disabled"', 'features.hooks=false', 'features.apps=false',
      'features.plugins=false', 'features.remote_plugin=false', 'features.multi_agent=false', 'features.multi_agent_v2=false', 'agents.enabled=false',
      'features.computer_use=false', 'features.browser_use=false', 'features.browser_use_external=false', 'features.in_app_browser=false',
      'features.code_mode=false', 'features.code_mode_host=false', 'features.memories=false', 'features.skip_host_skill_discovery=true',
      'features.skill_search=false', 'features.view_image=false', 'features.goals=false', 'features.sleep_tool=false', 'features.tool_suggest=false',
      'project_doc_max_bytes=0', 'analytics.enabled=false', 'check_for_update_on_startup=false', 'history.persistence="none"',
      `features.image_generation=${image}`, 'model_reasoning_summary="none"', 'features.unbounded_connection_retries=false',
      ...servers.map(server => `mcp_servers.${server.name}.enabled=false`),
    ];
    if (modelId) {
      const path = join(scratch, "modelCatalog.json");
      // ACT: 目录只提供隔离后的工具能力，不复制 CLI 的系统提示词；模型可用性另由官方 model/list 确认。
      await writeAtomic(path, JSON.stringify({ models: [{ ...catalogModel, slug: modelId, display_name: modelId }] }), { exclusive: true });
      settings.push(`model_catalog_json=${JSON.stringify(path)}`);
    }
    signal?.throwIfAborted();
    if (closing || revision !== configRevision) throw new Error("Codex 设置已变更或 Toonflow 正在退出，请重新发起任务");
    const rpc = new CodexRpc(executable, ["app-server", "--listen", "stdio://", ...settings.flatMap(value => ["-c", value])], scratch, env);
    children.add(rpc);
    rpc.once("closed", () => { children.delete(rpc); void rm(scratch, { recursive: true, force: true }).catch(() => {}); });
    const abort = () => rpc.close("Codex 启动已取消");
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await rpc.initialize();
      const account = await rpc.request("account/read", { refreshToken: false });
      if (account.account?.type !== "chatgpt") throw new Error("请先使用官方 Codex CLI 登录 ChatGPT 账户；此入口不使用 API Key");
      signal?.throwIfAborted();
      if (revision !== configRevision) throw new Error("Codex 设置已变更，请重新发起任务");
      return { rpc, scratch, executable };
    } catch (error) { rpc.close(); throw error; }
    finally { signal?.removeEventListener("abort", abort); }
  } catch (error) { await rm(scratch, { recursive: true, force: true }); throw error; }
}

export async function getCodexStatus() {
  let rpc: CodexRpc | undefined;
  try {
    const started = await startCodex();
    rpc = started.rpc;
    const response = await rpc.request("model/list", { includeHidden: false, limit: 100 });
    const available = z.array(z.object({ model: z.string().min(1), displayName: z.string(), isDefault: z.boolean() })).parse(response.data);
    models = available.map(item => ({ id: item.model, label: `Codex · ${item.displayName}`, contextWindow: 262144, maxOutputTokens: 32768 }));
    if (!models.length) throw new Error("官方 Codex 未返回可用模型");
    defaultCodexModelId = models.some(item => item.id === codexDefaultModelId) ? codexDefaultModelId
      : available.find(item => item.isDefault)?.model ?? codexDefaultModelId;
    return { executable: started.executable, authenticated: true, models, activeTasks: [...children].filter(child => child !== rpc).map(child => ({ event: child.lastEvent, error: child.lastError })), text: "可用", image: "原生文生图，账户能力需实际生成确认", message: "使用官方 CLI 当前登录；额度以官方账户为准，工具与媒体消费由 Toonflow 管理。" };
  } catch (error) {
    return { executable: "", authenticated: false, models, text: "不可用", image: "尚未确认", message: error instanceof Error ? error.message : "无法读取 Codex 状态" };
  } finally { rpc?.close(); }
}

export function closeCodexTasks(reason = "Codex 设置已变更，任务已取消，不会自动重放") {
  for (const rpc of children) rpc.close(reason);
}
conf.onDidChange("settings.codex", () => { configRevision++; closeCodexTasks(); });
process.once("exit", () => { closing = true; closeCodexTasks("Toonflow 已退出"); });
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));
