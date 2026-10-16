import { fail, hash } from "./store";
import { planSchema, type Model, type Plan, type PlanInput } from "./runtime";

export function validatePlan(input: PlanInput, catalog: Model[], projectKey: string) {
  const plan = planSchema.parse(input) as Plan;
  if (plan.projectKey !== projectKey) fail("project_mismatch");
  const model = catalog.find(model => model.model === plan.model && model.type === plan.mediaType);
  const mode = model?.modes.find(mode => mode.name === plan.mode);
  if (!mode || (plan.mediaType === "image" ? plan.mode !== "t2i" : plan.mode !== "t2v")) fail("canonical_model_or_mode_unknown");
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
  if (mode.references?.min && mode.references.min > 0) fail("required_reference_missing");
  return { plan, planHash: hash(plan) };
}
