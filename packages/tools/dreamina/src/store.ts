import { createHash, randomUUID } from "node:crypto";
import type { ToolFiles } from "@toonflow/tools-scaffold/runtime";
import { businessId, errorCode, type Job, type Plan, type Signer } from "./runtime";

export function fail(code: string, message = code): never {
  throw Object.assign(new Error(message), { code });
}

export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return fail("invalid_json_value");
}

export function hash(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function id(value: unknown) {
  const result = businessId.safeParse(value);
  return result.success ? result.data : fail("invalid_id");
}

export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) fail("invalid_uuid");
  return value;
}

export function safeRelative(value: string) {
  if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").some(part => !part || part === "." || part === "..") || /[\x00-\x1f:]/.test(value)) fail("invalid_path");
  return value;
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /token|secret|password|cookie|authorization|credential|signed.?url|payload|auth.?code/i.test(key) ? "[REDACTED]" : redact(item)]));
  if (typeof value === "string") return value.replace(/https?:\/\/[^\s"'<>]+/gi, "[URL REDACTED]").replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]").replace(/\b(?:sk-|sess-|tok_)[a-zA-Z0-9_-]+/g, "[REDACTED]").replace(/((?:access[_-]?token|secret|password|authorization|code)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  return value;
}

// ACT: 宿主只支持单进程写工作区；进程内锁避免崩溃留下阻塞恢复的锁文件。
// 永久 claim 仍使用独占落盘防重复提交，多进程业务编辑需由宿主升级协调机制。
const busyJobs = new Set<string>();

export class jobStore {
  constructor(private files: ToolFiles, private projectKey: string, private signer: Signer) {}

  path(jobKey: string) { return `integration/jobs/${hash({ projectKey: this.projectKey, jobKey: id(jobKey) })}.json`; }

  async read(jobKey: string): Promise<Job> {
    const job: Job = JSON.parse((await this.files.readFile(this.path(jobKey))).toString("utf8"));
    if (!job || job.projectKey !== this.projectKey || job.jobKey !== jobKey || job.schemaVersion !== 1) fail("ledger_corrupt");
    this.signer.verify(job);
    return job;
  }

  async create(plan: Plan): Promise<Job> {
    if (plan.projectKey !== this.projectKey) fail("project_mismatch");
    await this.files.mkdir("integration/jobs", true);
    const job: Job = {
      schemaVersion: 1, projectKey: this.projectKey, jobKey: id(plan.jobKey), shotId: id(plan.shotId),
      storyboardVersion: id(plan.storyboardVersion), planHash: hash(plan), mediaType: plan.mediaType,
      state: "awaiting_approval", submitId: randomUUID(), nodeId: null, remoteProjectId: null,
      remoteState: null, resources: [], cost: { unit: "credits", settled: null }, canceledLocal: false,
    };
    await this.files.writeFile(this.path(plan.jobKey), `${canonical(this.signer.sign(job))}\n`, true);
    return job;
  }

  async save(job: Job) {
    if (job.projectKey !== this.projectKey) fail("project_mismatch");
    // 宿主 files.writeFile 使用 writeAtomic，完整快照不直接覆盖磁盘。
    await this.files.writeFile(this.path(job.jobKey), `${canonical(this.signer.sign(job))}\n`);
  }

  async withLock<T>(jobKey: string, action: () => Promise<T>): Promise<T> {
    const key = this.path(jobKey);
    if (busyJobs.has(key)) fail("job_busy");
    busyJobs.add(key);
    try { return await action(); }
    finally { busyJobs.delete(key); }
  }

  async claim(jobKey: string) {
    const job = await this.read(jobKey);
    try {
      await this.files.writeFile(`${this.path(jobKey)}.claim`, `${canonical({ submitId: job.submitId, claimedAt: new Date().toISOString() })}\n`, true);
    } catch (error) {
      if (errorCode(error) === "EEXIST") fail("submission_already_claimed");
      throw error;
    }
  }
}
