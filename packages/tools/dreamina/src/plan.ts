import { fail, hash, uuid } from "./store";
import { planSchema, type Job, type Model, type Plan, type PlanInput } from "./runtime";

export function validatePlan(input: PlanInput, catalog: Model[], projectKey: string) {
  const plan = planSchema.parse(input) as Plan;
  if (plan.projectKey !== projectKey) fail("project_mismatch");
  const model = catalog.find(model => model.model === plan.model && model.type === plan.mediaType);
  const count = plan.references.length;
  const mode = model?.modes.find(mode => mode.name === plan.mode &&
    count >= (mode.references?.min ?? 0) && count <= (mode.references?.max ?? 0));
  if (!mode || (plan.mediaType === "image" ? plan.mode !== "t2i" : !["t2v", "m2v", "first_last_frame"].includes(plan.mode))) fail("canonical_model_or_mode_unknown");
  if (["t2i", "t2v"].includes(plan.mode) && count) fail("reference_mode_not_enabled");
  if (["m2v", "first_last_frame"].includes(plan.mode) && !count) fail("required_reference_missing");
  const imageSpec = mode.references?.types?.find(type => type.mediaType === "image");
  if (count && (!imageSpec || count < (imageSpec.min ?? 0) || count > (imageSpec.max ?? 0))) fail("invalid_reference_count");
  if (mode.references?.types?.some(type => type.mediaType !== "image" && (type.min ?? 0) > 0)) fail("reference_mode_not_enabled");
  const prompt = plan.prompt.replace(/(?<!\\)\{\{ref ([1-9]\d*)\}\}/g, (_match, number: string) => {
    if (Number(number) > count) fail("invalid_reference_index");
    return "";
  });
  if (/(?<!\\)\{\{/.test(prompt)) fail("inline_reference_not_enabled");
  const promptSpec = mode.flags.find(flag => flag.flag.replace(/^--/, "") === "prompt");
  if (!promptSpec || (promptSpec.minLength !== undefined && plan.prompt.length < promptSpec.minLength) ||
    (promptSpec.maxLength !== undefined && plan.prompt.length > promptSpec.maxLength)) fail("invalid_prompt_length");
  const supported = mode.flags.filter(flag => ["ratio", "resolution", "duration", "count"].includes(flag.flag.replace(/^--/, "")));
  for (const [key, value] of Object.entries(plan.params)) {
    const spec = supported.find(flag => flag.flag.replace(/^--/, "") === key);
    if (!spec) fail("unsupported_parameter", key);
    if (spec.values && !spec.values.some(item => String(item) === String(value))) fail("invalid_parameter", key);
    if (spec.min !== undefined || spec.max !== undefined || spec.step !== undefined) {
      if (typeof value !== "number" || (spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) fail("invalid_parameter", key);
      if (spec.step && Math.abs((value - (spec.min ?? 0)) / spec.step - Math.round((value - (spec.min ?? 0)) / spec.step)) > 1e-8) fail("invalid_parameter_step", key);
    }
  }
  for (const flag of supported) if (flag.required && plan.params[flag.flag.replace(/^--/, "") as keyof Plan["params"]] === undefined) fail("required_parameter_missing", flag.flag);
  return { plan, planHash: hash(plan) };
}

export function generationReferences(plan: Plan, job: Job) {
  const references = job.references ?? [];
  if (references.length !== plan.references.length || references.some((reference, index) =>
    reference.path !== plan.references[index].path || reference.sha256 !== plan.references[index].sha256)) fail("reference_snapshot_mismatch");
  return references.map(reference => uuid(reference.resourceId));
}

export function generationPrompt(plan: Plan, job: Job) {
  const references = generationReferences(plan, job);
  return plan.prompt.replace(/(?<!\\)\{\{ref ([1-9]\d*)\}\}/g, (_match, number: string) => {
    const resourceId = references[Number(number) - 1];
    if (!resourceId) fail("invalid_reference_index");
    return `{{res:${resourceId}}}`;
  });
}
