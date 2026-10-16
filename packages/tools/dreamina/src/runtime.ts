import { z } from "zod";

export const businessId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,180}$/).refine(value => !value.includes(".."));
export const planSchema = z.strictObject({
  projectKey: businessId.optional(),
  jobKey: businessId,
  shotId: businessId,
  storyboardVersion: businessId,
  mediaType: z.enum(["image", "video"]),
  model: z.string().min(1).max(200),
  mode: z.enum(["t2i", "t2v"]),
  prompt: z.string().min(1).max(2800).refine(value => !!value.trim()),
  params: z.strictObject({
    ratio: z.string().min(1).max(100).optional(),
    resolution: z.string().min(1).max(100).optional(),
    duration: z.number().finite().positive().optional(),
    count: z.literal(1).optional(),
  }).default({}),
  references: z.array(z.never()).max(0).default([]),
});
export type PlanInput = z.input<typeof planSchema>;
export type Plan = z.output<typeof planSchema> & { projectKey: string };
export type MediaType = Plan["mediaType"];

export const configSchema = z.strictObject({
  executable: z.string().refine(value => !/[\x00-\x1f]/.test(value)).default(""),
  profile: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).default("default"),
  region: z.literal("cn"),
  readOnlyOnline: z.boolean().default(false),
  liveGeneration: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(60000).default(20000),
});
export type Config = z.output<typeof configSchema>;

export const modelSchema = z.object({
  model: z.string(),
  type: z.enum(["image", "video"]),
  modes: z.array(z.object({
    name: z.string(),
    flags: z.array(z.object({
      flag: z.string(), required: z.boolean().optional(),
      values: z.array(z.union([z.string(), z.number()])).optional(),
      min: z.number().optional(), max: z.number().optional(), step: z.number().positive().optional(),
      minLength: z.number().optional(), maxLength: z.number().optional(),
    }).passthrough()).default([]),
    references: z.object({ min: z.number().optional() }).passthrough().optional(),
  }).passthrough()),
}).passthrough();
export type Model = z.output<typeof modelSchema>;
export const authSchema = z.object({
  loggedIn: z.boolean(), profile: z.string(), region: z.string(), expiresAt: z.string().optional(),
  environment: z.string().optional(), authMode: z.string().optional(),
});
export type Auth = z.infer<typeof authSchema>;
export type Discovery = {
  projectKey: string; version: string; readOnlyOnline: boolean; liveGeneration: boolean;
  enabledModes: string[]; profile?: string; region?: string; scopeHash?: string; models?: Model[];
};
export const generationSchema = z.object({
  model: z.string(), mode: z.string(), prompt: z.string(), outputCount: z.number(),
  references: z.array(z.unknown()).optional(), ratio: z.string().nullable().optional(),
  resolution: z.string().nullable().optional(), durationSeconds: z.number().nullable().optional(),
});
export const resourcesSchema = z.array(z.object({ resourceId: z.string(), state: z.string().default("unknown") }));
export const nodeSchema = z.object({
  nodeId: z.string(), type: z.string(), generation: generationSchema.optional(),
  resources: z.array(z.unknown()).optional(), status: z.string().optional(),
});
export const showSchema = z.object({
  draftVersion: z.number().int(),
  nodes: z.array(z.object({ nodeId: z.string().optional(), result: z.string(), node: nodeSchema.optional() })),
});
export type CloudNode = z.infer<typeof nodeSchema>;
export type Generation = {
  model: string; mode: string; prompt: string; outputCount: number; references: never[];
  ratio: string | null; resolution: string | null; durationSeconds: number | null;
};
export const quoteSchema = z.object({
  items: z.array(z.object({ nodeId: z.string(), maxCredits: z.number().int().nonnegative(), error: z.unknown().optional() })),
  totalMaxCredits: z.number().int().nonnegative(), draftVersion: z.number().int(), confirmable: z.boolean(),
});
export type Quote = { nodeId: string; totalMaxCredits: number; draftVersion: number };
export type MediaMetadata = {
  mimeType: string; extension: string; sha256: string; bytes: number; width: number; height: number;
  durationSeconds: number | null; hasAudio: boolean;
};
export type ImportReceipt = { canvasId: string; nodeId: string; relativePath: string; sha256: string; importedAt: string };
export interface Job {
  schemaVersion: 1;
  projectKey: string; jobKey: string; shotId: string; storyboardVersion: string; planHash: string;
  mediaType: MediaType; state: string; submitId: string; nodeId: string | null; remoteProjectId: string | null;
  remoteState: string | null; resources: z.infer<typeof resourcesSchema>;
  cost: { unit: "credits"; settled: null; authorizedCeiling?: number; quoted?: number };
  canceledLocal: boolean; integrity?: string; updateId?: string; submitUpdateId?: string; accountScopeHash?: string;
  hostCanvasId?: string | null; hostNodeId?: string; webUrl?: string | null;
  storyboardApproval?: { approvedBy: "human"; approvedAt: string; planHash: string };
  generationHash?: string; effectiveGeneration?: Pick<Generation, "ratio" | "resolution" | "durationSeconds">;
  quote?: Quote; quoteExpiresAt?: string; approvalId?: string;
  output?: MediaMetadata & { relativePath: string }; importPhase?: string; importReceipt?: ImportReceipt;
}
export interface Signer { sign(job: Job): Job; verify(job: Job): void }
export interface ExecutionVault { signer: Signer; claim(job: Job): Promise<void>; hasClaim(job: Job): Promise<boolean> }

export function errorCode(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(code) ? code : "integration_failed";
}
