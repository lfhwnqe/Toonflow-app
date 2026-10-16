import { randomUUID } from "node:crypto";
import type { QuestionRequest, ToolContext } from "@toonflow/tools-scaffold/runtime";
import { mediaClient } from "./mediaClient";
import { openExecutionVault } from "./executionVault";
import { createNodeId, nodeIdValue } from "./runner";
import { generationPrompt, generationReferences, validatePlan } from "./plan";
import { validateMedia } from "./collect";
import { jobStore, fail, hash, uuid, canonical } from "./store";
import { errorCode, quoteSchema, type Auth, type CloudNode, type Discovery, type ExecutionVault, type Generation, type Job, type Plan, type PlanInput, type Quote } from "./runtime";

export function sessionScope(auth: Auth) {
  if (auth.loggedIn !== true || !auth.expiresAt || !Number.isFinite(Date.parse(auth.expiresAt)) || Date.parse(auth.expiresAt) <= Date.now())
    fail("authentication_required");
  return hash({ profile: auth.profile, region: auth.region, environment: auth.environment ?? "unknown", expiresAt: auth.expiresAt, authMode: auth.authMode ?? "unknown" });
}

export function checkQuote(value: unknown, nodeId: string | null): Quote {
  const parsed = quoteSchema.safeParse(value);
  if (!parsed.success)
    fail("quote_incomplete");
  const quote = parsed.data;
  if (quote.items.length !== 1 || quote.items[0].nodeId !== nodeId || quote.items[0].error || quote.totalMaxCredits !== quote.items[0].maxCredits || quote.confirmable !== true)
    fail("quote_incomplete");
  return { nodeId: nodeIdValue(nodeId), totalMaxCredits: quote.totalMaxCredits, draftVersion: quote.draftVersion };
}

export function generationSnapshot(plan: Plan, node: CloudNode | undefined, job: Job): Generation {
  if (!node || node.type !== plan.mediaType || !node.generation)
    fail("draft_unreadable");
  const g = node.generation;
  const references = generationReferences(plan, job);
  const saved = g.references ?? [];
  if (g.model !== plan.model || g.mode !== plan.mode || g.prompt !== generationPrompt(plan, job) || g.outputCount !== 1 || saved.length !== references.length)
    fail("cloud_plan_mismatch");
  if (saved.some((reference, index) => !reference.writebackSupported ||
    (reference.resource?.resourceId ?? reference.id) !== references[index] ||
    (reference.resource?.type ?? reference.type) !== "image")) fail("cloud_reference_mismatch");
  for (const [key, field] of [["ratio", "ratio"], ["resolution", "resolution"], ["duration", "durationSeconds"]] as const)
    if (plan.params[key] !== undefined && g[field] !== plan.params[key])
      fail("cloud_plan_mismatch");
  return { model: g.model, mode: g.mode, prompt: g.prompt, outputCount: g.outputCount, references, ratio: g.ratio ?? null, resolution: g.resolution ?? null, durationSeconds: g.durationSeconds ?? null };
}

export function publicCanvasUrl(value: unknown) {
  if (typeof value !== "string")
    return null;
  try {
    const u = new URL(value);
    if (u.protocol === "https:" && !u.username && !u.password && !u.hash && [...u.searchParams.keys()].every(key => ["draft_id", "project_id", "draftId", "projectId", "type"].includes(key)) && /(^|\.)jimeng\.jianying\.com$/.test(u.hostname))
      return u.href;
  } catch { }
  return null;
}

export class mediaWorkflow {
  private vault!: ExecutionVault;
  store!: jobStore;
  readonly projectKey: string;
  readonly client: mediaClient;
  constructor(readonly context: ToolContext) {
    this.client = new mediaClient(context.config, context.cwd);
    this.projectKey = `P${hash({ cwd: context.cwd }).slice(0, 24)}`;
  }

  async ready() {
    this.vault ??= await openExecutionVault(this.context.cwd);
    this.store ??= new jobStore(this.context.files, this.projectKey, this.vault.signer);
  }

  async discover(signal?: AbortSignal, catalog = false): Promise<Discovery> {
    const v = await this.client.version(signal);
    await this.client.schema(signal);
    if (v.version !== "1.0.3" || v.commit !== "244064d" || v.distribution !== "cn")
      fail("cli_version_unknown");
    if (!this.client.config.readOnlyOnline)
      return { projectKey: this.projectKey, version: v.version, readOnlyOnline: false, liveGeneration: false, enabledModes: ["t2i", "t2v", "m2v", "first_last_frame"] };
    const auth = await this.client.auth(signal);
    if (auth.profile !== this.client.config.profile || auth.region !== this.client.config.region)
      fail("account_scope_unverified");
    const scopeHash = sessionScope(auth);
    const result: Discovery = { projectKey: this.projectKey, version: v.version, readOnlyOnline: true, liveGeneration: this.client.config.liveGeneration, profile: auth.profile, region: auth.region, scopeHash, enabledModes: ["t2i", "t2v", "m2v", "first_last_frame"] };
    if (catalog) {
      result.models = [];
      for (const type of ["image", "video"] as const) {
        const data = await this.client.models(type, signal);
        result.models.push(...data.items.map(model => ({ ...model, modes: model.modes.filter(mode => result.enabledModes.includes(mode.name)).map(mode => ({
          ...mode,
          ...(mode.references ? { references: { ...mode.references,
            max: Math.min(mode.references.max ?? 0, mode.references.types?.find(type => type.mediaType === "image")?.max ?? 0, 30),
            types: mode.references.types?.filter(type => type.mediaType === "image"),
          } } : {}),
        })) })).filter(model => model.modes.length));
      }
    }
    return result;
  }

  async ask(callId: string, request: QuestionRequest, approval: string, signal?: AbortSignal) {
    if (!this.context.question)
      fail("human_confirmation_unavailable");
    const result = await this.context.question.ask(callId, request, signal);
    signal?.throwIfAborted();
    return result?.skipped !== true && result?.answer === approval;
  }

  async plan(job: Job): Promise<Plan> {
    const plan: Plan = JSON.parse((await this.context.files.readFile(`integration/plans/${job.planHash}.json`)).toString("utf8"));
    if (plan.projectKey !== this.projectKey || plan.jobKey !== job.jobKey || hash(plan) !== job.planHash)
      fail("plan_changed");
    return plan;
  }

  summary(plan: Plan) { return `${plan.shotId} / ${plan.storyboardVersion}\n${plan.mediaType === "image" ? "图片" : "视频"} · ${plan.model} · ${plan.mode}\n${JSON.stringify(plan.params)}\n${plan.prompt}\n参考图（按顺序）：${plan.references.map((reference, index) => `${index + 1}. ${reference.path}`).join("；") || "无"}\n输出1份；使用当前 ${this.client.config.profile} 登录账号 / ${this.client.config.region}。`; }
  async prepare(input: PlanInput, callId: string, signal?: AbortSignal) {
    await this.ready();
    const d = await this.discover(signal, true);
    if (!d.models)
      fail("readonly_online_disabled");
    const validated = validatePlan({ ...input, projectKey: input.projectKey ?? this.projectKey }, d.models, this.projectKey).plan;
    const snapshots: NonNullable<Job["references"]> = [];
    for (const reference of validated.references) {
      const metadata = await validateMedia(this.context, reference.path, "image", signal);
      if (reference.sha256 && reference.sha256 !== metadata.sha256) fail("reference_snapshot_mismatch");
      const snapshotPath = `integration/references/${metadata.sha256}.${metadata.extension}`;
      await this.context.files.mkdir("integration/references", true);
      try { await this.context.files.copyFile(reference.path, snapshotPath, true); }
      catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
      const snapshot = await validateMedia(this.context, snapshotPath, "image", signal);
      if (snapshot.sha256 !== metadata.sha256) fail("reference_snapshot_mismatch");
      reference.sha256 = metadata.sha256;
      snapshots.push({ path: reference.path, sha256: metadata.sha256, snapshotPath, resourceId: randomUUID() });
    }
    const plan = validated;
    const planHash = hash(plan);
    await this.context.files.mkdir("integration/plans", true);
    try {
      await this.context.files.writeFile(`integration/plans/${planHash}.json`, `${canonical(plan)}\n`, true);
    } catch (e) {
      if (errorCode(e) !== "EEXIST")
        throw e;
      if (hash(JSON.parse((await this.context.files.readFile(`integration/plans/${planHash}.json`)).toString())) !== planHash)
        fail("plan_changed");
    }
    let job: Job;
    try {
      job = await this.store.create(plan);
    } catch (e) {
      if (errorCode(e) !== "EEXIST")
        throw e;
      job = await this.store.read(plan.jobKey);
      if (job.planHash !== planHash)
        fail("job_plan_conflict");
    }
    return this.store.withLock(plan.jobKey, async () => {
      job = await this.store.read(plan.jobKey);
      if (["prepared", "quoted", "observing", "collecting", "awaiting_manual_import", "completed"].includes(job.state))
        return this.view(job);
      if (job.canceledLocal || job.remoteProjectId)
        fail("prepare_reconciliation_required");
      const approval = "确认这份分镜，保存到即梦（不生成、不扣分）";
      const ok = await this.ask(callId, { title: "确认镜头并保存即梦草稿", question: `${this.summary(plan)}\n\n将把上述提示词及 ${plan.references.length} 张参考图的固定副本发至即梦 cn 服务，并新建一个独立云画布及节点。本步骤不运行生成。`, options: [approval, "暂不保存"] }, approval, signal);
      if (!ok) {
        job.state = "draft";
        await this.store.save(job);
        return { ...this.view(job), message: "已保留本地计划，没有创建云草稿。" };
      }
      const current = await this.discover(signal);
      if (current.scopeHash !== d.scopeHash)
        fail("account_session_changed");
      job.remoteProjectId = randomUUID();
      job.nodeId = createNodeId();
      job.updateId = randomUUID();
      job.submitUpdateId = randomUUID();
      job.accountScopeHash = current.scopeHash;
      job.references = snapshots;
      job.hostCanvasId = this.context.canvas?.id ?? null;
      job.state = "preparing";
      job.storyboardApproval = { approvedBy: "human", approvedAt: new Date().toISOString(), planHash };
      await this.store.save(job);
      try {
        const canvas = await this.client.createCanvas(job, signal);
        if (canvas.project?.projectId !== job.remoteProjectId)
          fail("canvas_identity_mismatch");
        job.webUrl = publicCanvasUrl(canvas.project.webUrl);
        await this.store.save(job);
        for (const reference of job.references) {
          const metadata = await validateMedia(this.context, reference.snapshotPath, "image", signal);
          if (metadata.sha256 !== reference.sha256) fail("reference_snapshot_mismatch");
          const uploaded = await this.client.upload(job, reference.resourceId, await this.context.resolvePath(reference.snapshotPath), reference.path.split("/").at(-1)!, signal);
          if (uploaded.resourceId !== reference.resourceId || uploaded.mediaType !== "image") fail("uploaded_reference_mismatch");
        }
        const saved = await this.client.save(plan, job, signal);
        if (saved.node?.nodeId !== job.nodeId)
          fail("node_identity_mismatch");
        const shown = await this.show(job, plan, signal);
        job.generationHash = hash(shown.generation);
        job.effectiveGeneration = { ratio: shown.generation.ratio, resolution: shown.generation.resolution, durationSeconds: shown.generation.durationSeconds };
        job.state = "prepared";
        await this.store.save(job);
        return { ...this.view(job), message: "已保存即梦草稿，尚未生成。下一步获取报价。" };
      } catch (e) {
        job.state = "unknown";
        await this.store.save(job);
        throw e;
      }
    });
  }

  async show(job: Job, plan: Plan, signal?: AbortSignal) {
    const data = await this.client.show(job, signal);
    const matches = data.nodes.filter(item => item.node?.nodeId === job.nodeId || item.nodeId === job.nodeId);
    if (matches.length !== 1)
      fail("draft_unreadable");
    const item = matches[0];
    if (item.result !== "FOUND" || item.node?.nodeId !== job.nodeId || (item.nodeId !== undefined && item.nodeId !== job.nodeId))
      fail("draft_unreadable");
    return { generation: generationSnapshot(plan, item.node, job), draftVersion: data.draftVersion };
  }

  async checked(job: Job, signal?: AbortSignal) {
    const d = await this.discover(signal);
    if (!d.readOnlyOnline || d.scopeHash !== job.accountScopeHash)
      fail("account_session_changed");
    const plan = await this.plan(job);
    if (job.storyboardApproval?.planHash !== job.planHash)
      fail("storyboard_unapproved");
    const shown = await this.show(job, plan, signal);
    if (hash(shown.generation) !== job.generationHash)
      fail("cloud_plan_changed");
    return plan;
  }

  async quote(jobKey: string, signal?: AbortSignal) {
    await this.ready();
    return this.store.withLock(jobKey, async () => {
      const job = await this.store.read(jobKey);
      if (!["prepared", "quoted"].includes(job.state) || job.canceledLocal)
        fail("job_not_prepared");
      await this.checked(job, signal);
      job.quote = checkQuote(await this.client.quote(job, signal), job.nodeId);
      job.quoteExpiresAt = new Date(Date.now() + 120000).toISOString();
      job.state = "quoted";
      await this.store.save(job);
      return { ...this.view(job), quotedCredits: job.quote.totalMaxCredits, unit: "credits", message: "仅报价，尚未授权或扣费。调用生成时会向你展示确认按钮。" };
    });
  }

  async submit(jobKey: string, callId: string, signal?: AbortSignal) {
    if (!this.client.config.liveGeneration)
      fail("live_generation_disabled", "请在即梦插件设置启用“允许逐次人工确认后生成”。");
    await this.ready();
    return this.store.withLock(jobKey, async () => {
      const job = await this.store.read(jobKey);
      if (job.state !== "quoted" || job.canceledLocal)
        fail("job_not_quoted");
      if (await this.hasSubmissionEvidence(job))
        fail("submission_already_claimed");
      const plan = await this.checked(job, signal);
      const quote = checkQuote(await this.client.quote(job, signal), job.nodeId);
      if (hash(quote) !== hash(job.quote) || !(Date.parse(job.quoteExpiresAt ?? "") > Date.now()))
        fail("quote_changed_or_expired", "报价已变化或过期，请重新报价。");
      // 消费确认之前先检查宿主媒体依赖。
      if (typeof this.context.ffmpeg !== "function")
        fail("media_tools_required");
      await this.context.ffmpeg(signal);
      const approval = `批准本次生成：最多 ${quote.totalMaxCredits} 积分，仅运行1次`;
      const approved = await this.ask(callId, { title: "确认即梦生成与积分上限", question: `${this.summary(plan)}\n实际保存参数：${JSON.stringify(job.effectiveGeneration)}\n\n报价 ${quote.totalMaxCredits} 积分，上限 ${quote.totalMaxCredits} 积分。只生成本镜头1份；失败/超时不自动重提。不追加音频或其他素材。`, options: [approval, "不生成"] }, approval, signal);
      if (!approved)
        return { ...this.view(job), message: "未批准消费，没有生成。" };
      await this.checked(job, signal);
      const latest = checkQuote(await this.client.quote(job, signal), job.nodeId);
      if (hash(latest) !== hash(quote) || !(Date.parse(job.quoteExpiresAt ?? "") > Date.now()))
        fail("quote_changed_or_expired");
      await this.vault.claim(job);
      await this.store.claim(jobKey);
      job.state = "submitting";
      job.approvalId = randomUUID();
      job.cost.authorizedCeiling = quote.totalMaxCredits;
      job.cost.quoted = quote.totalMaxCredits;
      await this.store.save(job);
      try {
        const effectiveParams = { ...plan.params };
        for (const [key, field] of [["ratio", "ratio"], ["resolution", "resolution"], ["duration", "durationSeconds"]] as const) {
          const value = job.effectiveGeneration?.[field];
          if (value != null)
            Object.assign(effectiveParams, { [key]: value });
        }
        const result = await this.client.submit({ ...plan, params: effectiveParams }, job, quote.totalMaxCredits, signal);
        if (result.submission?.submitId !== job.submitId)
          fail("submission_identity_mismatch");
        const remote = result.submission;
        job.remoteState = String(remote.state);
        job.state = remote.state === "ACCEPTED" ? "observing" : "unknown";
        job.resources = (remote.resources ?? []).map(r => ({ resourceId: uuid(r.resourceId), state: String(r.state ?? "unknown") }));
        await this.store.save(job);
        return { ...this.view(job), message: "已提交，等待远端结果。最终实际净消费尚未知。" };
      } catch (e) {
        job.state = "unknown";
        await this.store.save(job);
        throw e;
      }
    });
  }

  async hasSubmissionEvidence(job: Job) {
    // submitId 在本地计划建立时分配；它本身不能证明已经提交。
    if (["submitting", "observing", "collecting", "awaiting_manual_import", "completed", "failed"].includes(job.state) || job.remoteState != null || job.resources?.length || Object.hasOwn(job, "approvalId") || Object.hasOwn(job.cost ?? {}, "authorizedCeiling"))
      return true;
    try {
      const claim = JSON.parse((await this.context.files.readFile(`${this.store.path(job.jobKey)}.claim`)).toString("utf8"));
      if (claim.submitId !== job.submitId)
        fail("submission_fence_mismatch");
      return true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT")
        throw error;
    }
    return this.vault.hasClaim(job);
  }

  async readCanvas(job: Job, signal?: AbortSignal) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const data = await this.client.listCanvases(cursor, signal);
      const matches = data.items.filter(item => item.projectId === job.remoteProjectId);
      if (matches.length > 1)
        fail("canvas_identity_mismatch");
      if (matches.length === 1)
        return matches[0];
      if (!data.hasMore)
        fail("cloud_canvas_missing", "已只读确认原云画布不存在；没有自动创建、保存或生成。");
      if (typeof data.nextCursor !== "string" || !data.nextCursor || data.nextCursor.length > 4096 || seen.has(data.nextCursor))
        fail("cloud_canvas_lookup_incomplete");
      seen.add(data.nextCursor);
      cursor = data.nextCursor;
    }
    fail("cloud_canvas_lookup_incomplete");
  }

  async recoverDraft(job: Job, signal?: AbortSignal) {
    const plan = await this.plan(job);
    if (job.storyboardApproval?.approvedBy !== "human" || job.storyboardApproval?.planHash !== job.planHash)
      fail("storyboard_unapproved");
    const canvas = await this.readCanvas(job, signal);
    let data;
    try {
      data = await this.client.show(job, signal);
    } catch (error) {
      if (errorCode(error) === "cli.invalid_node_id")
        fail("cloud_node_id_invalid", "旧任务的节点标识不符合当前即梦 CLI 格式，无法只读核验；没有自动重建或生成。");
      throw error;
    }
    const item = data.nodes.find(node => node.nodeId === job.nodeId) ?? (data.nodes.length === 1 && data.nodes[0].nodeId === undefined ? data.nodes[0] : undefined);
    if (item?.result === "NOT_FOUND")
      fail("cloud_node_missing", "云画布存在，但原草稿节点不存在；没有自动补建或生成。");
    if (item?.result !== "FOUND" || item.node?.nodeId !== job.nodeId || !Number.isSafeInteger(data.draftVersion))
      fail("draft_unreadable");
    if ((Array.isArray(item.node.resources) && item.node.resources.length) || (typeof item.node.status === "string" && item.node.status !== "empty"))
      fail("cloud_generation_present", "云节点已有生成或资源记录，不能按未提交草稿恢复；请保留原记录并人工核对，不会自动重新生成。");
    const generation = generationSnapshot(plan, item.node, job);
    if (job.generationHash && hash(generation) !== job.generationHash)
      fail("cloud_plan_changed");
    const webUrl = publicCanvasUrl(canvas.webUrl);
    if (!webUrl)
      fail("cloud_canvas_url_unverified");
    const keepQuote = job.state === "quoted" && job.quote && Date.parse(job.quoteExpiresAt ?? "") > Date.now();
    job.webUrl = webUrl;
    job.generationHash = hash(generation);
    job.effectiveGeneration = { ratio: generation.ratio, resolution: generation.resolution, durationSeconds: generation.durationSeconds };
    if (!job.canceledLocal)
      job.state = keepQuote ? "quoted" : "prepared";
    if (!keepQuote) {
      delete job.quote;
      delete job.quoteExpiresAt;
    }
    await this.store.save(job);
    return { ...this.view(job), recovery: "draft_verified", message: job.canceledLocal ? "原云草稿已只读核验；本地停止标记保持不变，没有提交生成。" : "原云草稿已只读核验并恢复为可报价状态，尚未提交生成。" };
  }

  async status(jobKey: string, signal?: AbortSignal) {
    await this.ready();
    return this.store.withLock(jobKey, async () => {
      const job = await this.store.read(jobKey);
      if (!job.remoteProjectId)
        return this.view(job);
      const scope = await this.discover(signal);
      if (scope.scopeHash !== job.accountScopeHash)
        fail("account_session_changed");
      if (!await this.hasSubmissionEvidence(job))
        return this.recoverDraft(job, signal);
      const observed = await this.client.status(job, signal);
      if (observed.operationRef !== job.submitId)
        fail("operation_identity_mismatch");
      job.remoteState = String(observed.state ?? "unknown");
      job.resources = (observed.resources ?? []).map(r => ({ resourceId: uuid(r.resourceId), state: String(r.state ?? "unknown") }));
      const success = observed.state === "succeeded" && job.resources.length && job.resources.every(r => r.state === "succeeded");
      if (success && job.state !== "completed")
        job.state = job.mediaType === "video" ? "awaiting_manual_import" : "collecting";
      else if (["pending", "running"].includes(observed.state) && job.state !== "completed")
        job.state = "observing";
      else if (observed.state === "failed")
        job.state = "failed";
      else if (!success && job.state !== "completed")
        job.state = "unknown";
      await this.store.save(job);
      return this.view(job);
    });
  }

  async cancel(jobKey: string) {
    await this.ready();
    return this.store.withLock(jobKey, async () => {
      const job = await this.store.read(jobKey); job.canceledLocal = true; if (["draft", "prepared", "quoted", "awaiting_approval"].includes(job.state))
        job.state = "canceled_local"; await this.store.save(job); return { ...this.view(job), message: "已停止本地新提交；已在云端运行的任务不受影响，不承诺退款。" };
    });
  }

  view(job: Job) { return { projectKey: job.projectKey, jobKey: job.jobKey, shotId: job.shotId, storyboardVersion: job.storyboardVersion, state: job.state, remoteState: job.remoteState, resources: job.resources, webUrl: job.webUrl ?? null, cost: job.cost, canceledLocal: job.canceledLocal, output: job.output ?? null, imported: !!job.importReceipt }; }
}
