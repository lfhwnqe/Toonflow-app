import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

export type CodexPacket = { id?: string | number; method?: string; params?: any; result?: any; error?: { code?: number; message?: string } };

export function codexErrorMessage(error: { codexErrorInfo?: unknown } | undefined) {
  const info = error?.codexErrorInfo;
  const reasons: Record<string, string> = {
    contextWindowExceeded: "Codex 上下文超过模型上限，请压缩对话",
    usageLimitExceeded: "Codex 账户额度不足，请检查官方账户",
    sessionBudgetExceeded: "Codex 当前任务预算已耗尽",
    rateLimitExceeded: "Codex 请求受限，请稍后手动重试",
    unauthorized: "Codex 登录已失效，请使用官方 CLI 重新登录",
    serverOverloaded: "Codex 云端服务繁忙，请稍后手动重试",
    badRequest: "Codex 云端拒绝请求，请检查模型及 CLI 协议兼容性",
  };
  if (typeof info === "string" && reasons[info]) return reasons[info]!;
  if (info && typeof info === "object") {
    for (const name of ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"]) {
      if (!(name in info)) continue;
      const value = (info as Record<string, { httpStatusCode?: unknown }>)[name]?.httpStatusCode;
      return `Codex 云端连接失败${typeof value === "number" && Number.isInteger(value) ? `（HTTP ${value}）` : ""}，请检查网络及官方账户状态`;
    }
  }
  return "Codex 云端请求失败，请检查账户额度、网络与模型可用性";
}

// 仅承载官方 JSONL 协议；stderr 和原始 RPC 错误可能含用户内容，不向 UI 或日志转发。
export class CodexRpc extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 0;
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private outputBytes = 0;
  closed = false;
  lastEvent = "starting";
  lastError = "";

  constructor(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    super();
    this.child = spawn(executable, args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.outputBytes += chunk.length;
      if (this.outputBytes > 48 * 1024 * 1024) return this.close("Codex 输出超过安全上限");
      this.buffer += this.decoder.write(chunk);
      let index: number;
      while ((index = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); }
        catch { this.close("Codex 返回了无效协议数据"); return; }
      }
      if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) this.close("Codex 协议消息超过安全上限");
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.outputBytes += chunk.length;
      if (this.outputBytes > 48 * 1024 * 1024) this.close("Codex 输出超过安全上限");
    });
    this.child.stdin.on("error", () => this.close("Codex 连接已断开，请重新发起任务"));
    this.child.on("error", () => this.close("无法启动 Codex CLI，请检查设置中的路径"));
    this.child.on("exit", () => this.close("Codex 服务已退出；当前任务不会自动重放，请重新发起任务"));
  }

  private receive(message: CodexPacket) {
    if (message.method) {
      this.lastEvent = /^[a-zA-Z/]+$/.test(message.method) ? message.method : "notification";
      if (message.method === "error") this.lastError = codexErrorMessage(message.params?.error);
      this.emit(message.id === undefined ? "notification" : "request", message);
      return;
    }
    const pending = this.pending.get(message.id as number);
    if (!pending) return;
    this.pending.delete(message.id as number);
    clearTimeout(pending.timer);
    if (message.error) {
      const raw = message.error.message ?? "";
      const reason = /usage.limit|quota|rate.limit|exceeded/i.test(raw) ? "Codex 额度不足或请求受限，请检查官方账户"
        : /auth|login|unauthorized|401/i.test(raw) ? "Codex 登录已失效，请使用官方 CLI 重新登录"
        : /model.*(?:unavailable|not.found|unsupported)/i.test(raw) ? "当前 Codex 账户无法使用所选模型"
        : `Codex 请求失败（协议错误 ${message.error.code ?? "未知"}），请检查 CLI 状态`;
      pending.reject(new Error(reason));
    } else pending.resolve(message.result);
  }

  send(message: CodexPacket) {
    if (this.closed) throw new Error("Codex 服务已关闭，请重新发起任务");
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > 32 * 1024 * 1024) throw new Error("Codex 请求超过 32 MB，请减少上下文或附件");
    this.child.stdin.write(line);
  }

  request(method: string, params: unknown, timeoutMs = 15000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Codex 服务已关闭，请重新发起任务"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex 服务响应超时；任务状态未知，不会自动重试"));
        this.close("Codex 服务响应超时");
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async initialize() {
    await this.request("initialize", { clientInfo: { name: "toonflowNative", title: "Toonflow Native Codex", version: "1.0.0" }, capabilities: { experimentalApi: true, explicitGatewayOauth: true, requestAttestation: false } });
    this.send({ method: "initialized" });
  }

  close(reason = "Codex 任务已结束") {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)); }
    this.pending.clear();
    this.child.kill("SIGKILL");
    this.emit("closed", new Error(reason));
  }
}
