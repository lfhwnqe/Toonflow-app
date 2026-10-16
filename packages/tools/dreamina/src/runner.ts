import { spawn } from "node:child_process";
import { access, appendFile, realpath, constants } from "@toonflow/file";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { fail, redact } from "./store";
import { configSchema, errorCode } from "./runtime";

const contractHash = "146f1d781d9ba69f6e18168d5aa8c90d251645475cf9bbe87bda5eecdd192399";

export function createNodeId() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return `node_${[...randomBytes(10)].map(value => alphabet[value & 31]).join("")}`;
}

export function nodeIdValue(value: unknown): string {
  if (typeof value !== "string" || !/^node_[0123456789abcdefghjkmnpqrstvwxyz]{10}$/.test(value)) fail("invalid_node_id");
  return value;
}

export function validateConfig(config: Record<string, unknown>) {
  // ACT: 兼容旧版保存的只读诊断字段，其余未知配置仍严格拒绝。
  const normalized = { ...config };
  delete normalized.readOnlyProjectId;
  delete normalized.readOnlyNodeIds;
  const result = configSchema.parse(normalized);
  if (result.executable && !isAbsolute(result.executable)) fail("absolute_executable_required");
  return result;
}

interface ProcessResult { exitCode: number | null; stdout: string; stderr: string }

function runProcess(executable: string, args: string[], options: { cwd: string; timeoutMs: number; signal?: AbortSignal; env: NodeJS.ProcessEnv }): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(Object.assign(new Error("aborted"), { code: "aborted" }));
    const child = spawn(executable, args, { cwd: options.cwd, shell: false, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let error: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (code: string) => {
      error ??= Object.assign(new Error(code), { code });
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 500);
    };
    const timer = setTimeout(() => stop("process_timeout"), options.timeoutMs);
    const abort = () => stop("aborted");
    options.signal?.addEventListener("abort", abort, { once: true });
    const receive = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) stop("output_limit");
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => receive(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => receive(stderr, chunk));
    child.on("error", () => { error = Object.assign(new Error("process_start_failed"), { code: "process_start_failed" }); });
    child.on("close", exitCode => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (error) return reject(error);
      resolve({ exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

const cliErrorSchema = z.object({
  code: z.string().optional(), message: z.string().optional(), class: z.string().optional(),
  retryable: z.boolean().optional(), requiredAction: z.string().optional(),
  requestId: z.string().optional(), traceId: z.string().optional(),
  validation: z.object({ reasonCode: z.string(), fieldPath: z.string().optional(), detail: z.string() }).optional(),
});

export class cliError extends Error {
  constructor(readonly code: string, readonly diagnostic: z.infer<typeof cliErrorSchema>, readonly requestId?: string) {
    super(diagnostic.message || "cli_failed");
  }
}

const envelopeSchema = z.object({
  schemaVersion: z.literal("1"), ok: z.boolean(), data: z.record(z.string(), z.unknown()).optional(),
  error: cliErrorSchema.optional(),
  meta: z.object({ requestId: z.string().max(200).optional() }).optional(),
});

function parseEnvelope(result: ProcessResult) {
  let value: unknown;
  try { value = JSON.parse(result.stdout); }
  catch {
    if (result.exitCode === 0) fail("invalid_cli_json");
    try { value = JSON.parse(result.stderr); } catch { fail("invalid_cli_json"); }
    const failure = envelopeSchema.safeParse(value);
    if (!failure.success || failure.data.ok !== false || !failure.data.error) fail("invalid_cli_json");
  }
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) fail("invalid_cli_json");
  const envelope = parsed.data;
  if (result.exitCode !== 0 || !envelope.ok || !envelope.data) {
    const code = envelope.error?.code;
    const diagnostic = redact(envelope.error ?? {}) as z.infer<typeof cliErrorSchema>;
    throw new cliError(code && /^[a-zA-Z0-9._-]{1,128}$/.test(code) ? code : "cli_failed", diagnostic,
      diagnostic.requestId ?? envelope.meta?.requestId ?? diagnostic.traceId);
  }
  return envelope;
}

export class cliRunner {
  config;
  requestId?: string;
  constructor(config: Record<string, unknown>, private cwd: string) { this.config = validateConfig(config); }

  async execute(args: string[], signal?: AbortSignal, local = false) {
    this.requestId = undefined;
    if (!local && !this.config.readOnlyOnline) fail("readonly_online_disabled");
    const configured = this.config.executable || Bun.which("dreamina-canvas") || join(homedir(), ".local", "bin", process.platform === "win32" ? "dreamina-canvas.exe" : "dreamina-canvas");
    const executable = await realpath(configured).catch(() => fail("executable_missing"));
    await access(executable, constants.X_OK).catch(() => fail("executable_not_executable"));
    // 仅传官方 CLI 登录和网络所需环境，不继承模型凭据或 shell PATH。
    const env = Object.fromEntries(["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]
      .filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const result = await runProcess(executable, ["--format", "json", "--non-interactive", "--profile", this.config.profile, "--region", this.config.region, ...args], {
      cwd: this.cwd, timeoutMs: this.config.timeoutMs, signal, env,
    });
    let envelope;
    try {
      envelope = parseEnvelope(result);
    } catch (error) {
      if (error instanceof cliError) {
        const command = args.slice(0, args[0] === "node" && ["create", "edit"].includes(args[1]) ? 3 : 2).join(" ");
        const entry = JSON.stringify(redact({ time: new Date().toISOString(), command, exitCode: result.exitCode, ...error.diagnostic, code: error.code, requestId: error.requestId }));
        console.error(`[dreamina] ${entry}`);
        const directory = process.env.TOONFLOW_DATA_DIR;
        if (directory && isAbsolute(directory)) {
          try { await appendFile(join(directory, "dreaminaLog.jsonl"), `${entry}\n`, { mode: 0o600 }); }
          catch (logError) { console.error(`[dreamina] 日志保存失败：${errorCode(logError)}`); }
        }
      }
      throw error;
    }
    this.requestId = envelope.meta?.requestId;
    if (args[0] === "schema" && createHash("sha256").update(result.stdout).digest("hex") !== contractHash) fail("schema_version_unknown");
    return envelope.data!;
  }
}
