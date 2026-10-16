import { z } from "zod";
import { cliRunner, nodeIdValue } from "./runner";
import { fail, uuid } from "./store";
import { generationPrompt, generationReferences } from "./plan";
import { authSchema, modelSchema, quoteSchema, resourcesSchema, showSchema, type Job, type Plan } from "./runtime";

function mediaArgs(action: "save" | "submit", plan: Plan, job: Job, ceiling?: number) {
  const projectId = uuid(job.remoteProjectId);
  const nodeId = nodeIdValue(job.nodeId);
  const args = ["node", action === "save" ? "create" : "edit", plan.mediaType, "--project-id", projectId,
    "--node-id", nodeId, "--update-id", uuid(action === "save" ? job.updateId : job.submitUpdateId),
    "--title", `${plan.shotId} ${plan.storyboardVersion}`, "--mode", plan.mode, "--model", plan.model, "--prompt", generationPrompt(plan, job)];
  for (const resourceId of generationReferences(plan, job)) args.push("--ref", `res:${resourceId}`);
  if (plan.params.count !== undefined) args.push("--count", "1");
  for (const key of ["ratio", "resolution", "duration"] as const) if (plan.params[key] !== undefined) args.push(`--${key}`, String(plan.params[key]));
  if (action === "submit") {
    if (ceiling === undefined || !Number.isSafeInteger(ceiling) || ceiling < 0) fail("invalid_ceiling");
    // CLI 内部报价、确认并运行，token 不进入日志、前端或持久记录。
    args.push("--run", "--credit-ceiling", String(ceiling), "--submit-id", uuid(job.submitId));
  }
  return args;
}

export class mediaClient extends cliRunner {
  async upload(job: Job, resourceId: string, path: string, name: string, signal?: AbortSignal) {
    return z.object({ resourceId: z.string(), mediaType: z.string() }).parse(await this.execute([
      "resource", "upload", "--project-id", uuid(job.remoteProjectId), "--resource-id", uuid(resourceId),
      "--file", path, "--type", "image", "--name", name, "--import-kind", "external_generated",
    ], signal));
  }
  async version(signal?: AbortSignal) { return z.object({ version: z.string(), commit: z.string(), distribution: z.string() }).parse(await this.execute(["version"], signal, true)); }
  schema(signal?: AbortSignal) { return this.execute(["schema"], signal, true); }
  async auth(signal?: AbortSignal) { return authSchema.parse(await this.execute(["auth", "status"], signal)); }
  async models(type: "image" | "video", signal?: AbortSignal) { return z.object({ items: z.array(modelSchema) }).parse(await this.execute(["model", "list", "--type", type], signal)); }
  async createCanvas(job: Job, signal?: AbortSignal) {
    return z.object({ project: z.object({ projectId: z.string(), webUrl: z.string() }) }).parse(await this.execute(["canvas", "create", `Toonflow ${job.shotId}`, "--project-id", uuid(job.remoteProjectId)], signal));
  }
  async save(plan: Plan, job: Job, signal?: AbortSignal) {
    return z.object({ node: z.object({ nodeId: z.string() }) }).parse(await this.execute(mediaArgs("save", plan, job), signal));
  }
  async submit(plan: Plan, job: Job, ceiling: number, signal?: AbortSignal) {
    if (!this.config.liveGeneration) fail("live_generation_disabled");
    return z.object({ submission: z.object({ submitId: z.string(), state: z.string(), resources: resourcesSchema.default([]) }) })
      .parse(await this.execute(mediaArgs("submit", plan, job, ceiling), signal));
  }
  async show(job: Job, signal?: AbortSignal) {
    return showSchema.parse(await this.execute(["node", "show", "--project-id", uuid(job.remoteProjectId), "--node-id", nodeIdValue(job.nodeId)], signal));
  }
  async quote(job: Job, signal?: AbortSignal) {
    return quoteSchema.parse(await this.execute(["node", "quote", "--project-id", uuid(job.remoteProjectId), "--node-id", nodeIdValue(job.nodeId)], signal));
  }
  async status(job: Job, signal?: AbortSignal) {
    return z.object({ operationRef: z.string(), state: z.string(), resources: resourcesSchema.default([]) })
      .parse(await this.execute(["operation", "status", uuid(job.submitId), "--project-id", uuid(job.remoteProjectId)], signal));
  }
  async resource(job: Job, resourceId: string, signal?: AbortSignal) {
    return z.object({ type: z.string(), status: z.string() }).parse(await this.execute(["resource", "get", uuid(resourceId), "--project-id", uuid(job.remoteProjectId)], signal));
  }
  async download(job: Job, resourceId: string, output: string, signal?: AbortSignal) {
    return z.object({ resourceId: z.string(), size: z.number().int().positive(), sha256: z.string() }).parse(await this.execute(["resource", "download", uuid(resourceId), "--project-id", uuid(job.remoteProjectId), "--output", output], signal));
  }
  async listCanvases(cursor: string | undefined, signal?: AbortSignal) {
    const args = ["canvas", "ls", "--limit", "100"];
    if (cursor) args.push("--cursor", cursor);
    return z.object({ items: z.array(z.object({ projectId: z.string(), webUrl: z.string() })), hasMore: z.boolean(), nextCursor: z.string().nullable().optional() }).parse(await this.execute(args, signal));
  }
}
