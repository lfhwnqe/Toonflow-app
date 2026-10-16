import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { z } from "zod";
import type { FfprobeData, ToolContext } from "@toonflow/tools-scaffold/runtime";
import type { mediaWorkflow } from "./workflow";
import type { MediaMetadata, MediaType } from "./runtime";
import { errorCode } from "./runtime";
import { safeRelative, fail, id, hash } from "./store";
const canvasReplySchema = z.object({
  hasMore: z.boolean().optional(),
  nodes: z.array(z.object({
    id: z.string(), label: z.string().optional(), truncated: z.array(z.unknown()).optional(),
    outputs: z.record(z.string(), z.object({ value: z.object({ url: z.string(), mimeType: z.string() }) })).optional(),
  })).optional(),
  node: z.object({ id: z.string() }).optional(),
  availableNodeTypes: z.array(z.object({ type: z.string() })).optional(),
  nodeTools: z.array(z.object({ nodeId: z.string(), name: z.string(), parameters: z.object({ properties: z.record(z.string(), z.unknown()).optional() }) })).optional(),
});
function sniff(bytes: Buffer, mediaType: MediaType) {
  if (mediaType === "image") {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      return { mimeType: "image/png", extension: "png" };
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
      return { mimeType: "image/jpeg", extension: "jpg" };
    if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
      return { mimeType: "image/webp", extension: "webp" };
  }
  if (mediaType === "video" && bytes.toString("ascii", 4, 8) === "ftyp")
    return { mimeType: "video/mp4", extension: "mp4" };
  fail("invalid_media_magic");
}

export async function validateMedia(context: ToolContext, relativePath: string, mediaType: MediaType, signal?: AbortSignal): Promise<MediaMetadata> {
  safeRelative(relativePath);
  signal?.throwIfAborted();
  const stat = await context.files.stat(relativePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 100 * 1024 * 1024)
    fail("invalid_media_size");
  const bytes = await context.files.readFile(relativePath);
  if (bytes.length !== stat.size)
    fail("media_changed_during_read");
  const format = sniff(bytes, mediaType);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ffmpeg = await context.ffmpeg(signal);
  const absolute = await context.resolvePath(relativePath);
  const probe = await new Promise<FfprobeData>((resolve, reject) => {
    const command = ffmpeg(absolute);
    const timer = setTimeout(() => { command.kill("SIGKILL"); reject(Object.assign(new Error("media_probe_timeout"), { code: "media_probe_timeout" })); }, 20000);
    command.ffprobe((error, data) => { clearTimeout(timer); error ? reject(Object.assign(new Error("media_probe_failed"), { code: "media_probe_failed" })) : resolve(data); });
  });
  const video = probe.streams?.find(stream => stream.codec_type === "video");
  if (!video || typeof video.width !== "number" || typeof video.height !== "number" || !Number.isFinite(video.width) || !Number.isFinite(video.height) || video.width <= 0 || video.height <= 0)
    fail("media_probe_failed");
  const durationSeconds = mediaType === "video" ? Number(probe.format?.duration) : null;
  if (mediaType === "video" && (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0))
    fail("invalid_media_duration");
  await new Promise<void>((resolve, reject) => {
    const sink = new PassThrough();
    sink.resume();
    const command = ffmpeg(absolute).outputOptions(mediaType === "image" ? ["-frames:v", "1"] : []).format("null");
    const abort = () => { command.kill("SIGKILL"); reject(Object.assign(new Error("media_decode_aborted"), { code: "media_decode_aborted" })); };
    const timer = setTimeout(abort, 20000);
    signal?.addEventListener("abort", abort, { once: true });
    const done = (error?: Error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); sink.destroy(); error ? reject(Object.assign(new Error("media_decode_failed"), { code: "media_decode_failed" })) : resolve(); };
    command.on("error", done).on("end", () => done());
    if (signal?.aborted)
      abort();
    else
      command.pipe(sink, { end: true });
  });
  return { ...format, sha256, bytes: bytes.length, width: video.width, height: video.height, durationSeconds, hasAudio: probe.streams.some(stream => stream.codec_type === "audio") };
}

export async function collect(workflow: mediaWorkflow, jobKey: string, callId: string, sourcePath?: string, signal?: AbortSignal) {
  await workflow.ready();
  return workflow.store.withLock(jobKey, async () => {
    const job = await workflow.store.read(jobKey);
    if (job.state === "completed")
      return workflow.view(job);
    if (!["collecting", "awaiting_manual_import", "importing"].includes(job.state) || job.resources.length !== 1 || !job.resources.every(r => r.state === "succeeded"))
      fail("successful_resource_required");
    const d = await workflow.discover(signal);
    if (d.scopeHash !== job.accountScopeHash)
      fail("account_session_changed");
    const context = workflow.context;
    if (!job.output) {
      if (job.mediaType === "video" && !sourcePath)
        return { ...workflow.view(job), message: "请在即梦画布下载此视频，放入当前 Toonflow 工作区，再告诉我文件相对路径。我会校验并导入，不会重新生成。" };
      const directory = `assets/dreamina/${id(job.shotId)}/${id(job.storyboardVersion)}`;
      await context.files.mkdir(directory, true);
      const temporaryDirectory = `${directory}/download${randomUUID().replaceAll("-", "")}`;
      await context.files.mkdir(temporaryDirectory);
      const temporary = `${temporaryDirectory}/media.download`;
      let metadata;
      if (job.mediaType === "video") {
        if (!sourcePath)
          fail("manual_video_path_required");
        safeRelative(sourcePath);
        const sourceMetadata = await validateMedia(context, sourcePath, "video", signal);
        await context.files.copyFile(sourcePath, temporary, true);
        metadata = await validateMedia(context, temporary, "video", signal);
        if (metadata.sha256 !== sourceMetadata.sha256)
          fail("manual_source_changed");
      }
      else {
        if (sourcePath)
          fail("manual_image_path_not_expected");
        const resource = await workflow.client.resource(job, job.resources[0].resourceId, signal);
        if (resource.type !== "image" || !["succeeded", "SUCCESS", "SUCCEEDED"].includes(resource.status))
          fail("successful_image_required");
        const output = await context.resolvePath(temporary);
        const downloaded = await workflow.client.download(job, job.resources[0].resourceId, output, signal);
        metadata = await validateMedia(context, temporary, "image", signal);
        if (downloaded.resourceId !== job.resources[0].resourceId || downloaded.size !== metadata.bytes || downloaded.sha256 !== metadata.sha256)
          fail("download_identity_or_hash_mismatch");
      }
      const relativePath = `${directory}/${job.submitId}.${metadata.extension}`;
      try {
        await context.files.rename(temporary, relativePath);
      } catch (error) {
        if (errorCode(error) !== "EEXIST")
          throw error;
        const existing = await validateMedia(context, relativePath, job.mediaType, signal);
        if (existing.sha256 !== metadata.sha256 || existing.bytes !== metadata.bytes)
          fail("output_asset_conflict");
        await context.files.remove(temporary);
      }
      await context.files.remove(temporaryDirectory);
      job.output = { relativePath, ...metadata };
      job.state = "importing";
      await workflow.store.save(job);
    }
    const canvas = context.canvas;
    if (!canvas)
      return { ...workflow.view(job), message: "文件已保存在工作区。请打开目标 Toonflow 画布，再调用回收完成导入。" };
    if (job.hostCanvasId && job.hostCanvasId !== canvas.id)
      fail("host_canvas_changed");
    const approval = "导入当前 Toonflow 画布，保留所有旧版本";
    const approved = await workflow.ask(callId, {
      title: "导入已生成素材", question: `${job.shotId} / ${job.storyboardVersion}\n文件：${job.output.relativePath}\n请确认该文件属于此镜头；手动视频文件与云资源的内容对应由你确认。
将新增${job.mediaType === "image" ? "图片" : "视频"}节点，保留现有节点和原片。不会再生成或扣费。`, options: [approval, "暂不导入"]
    }, approval, signal);
    if (!approved)
      return { ...workflow.view(job), message: "文件已保留，暂未导入画布。" };
    const verified = await validateMedia(context, job.output.relativePath, job.mediaType, signal);
    if (verified.sha256 !== job.output.sha256 || verified.bytes !== job.output.bytes)
      fail("output_asset_changed");
    const canvasId = canvas.id;
    const call = async (name: string, args: Record<string, unknown>) => {
      if (canvas.id !== canvasId)
        fail("host_canvas_changed");
      return canvasReplySchema.parse(await canvas.call({ name, args }, signal));
    };
    const label = `即梦 ${job.shotId} ${job.storyboardVersion} ${job.submitId.slice(0, 8)}`;
    if (!job.hostNodeId) {
      const found = await call("findCanvasNodes", { canvasId: canvas.id, query: label, limit: 100 });
      const matches = (found.nodes ?? []).filter(n => n.label === label);
      if (matches.length > 1 || found.hasMore)
        fail("host_node_reconciliation_required");
      if (matches.length === 1)
        job.hostNodeId = matches[0].id;
      else {
        if (job.importPhase === "creating_node")
          fail("host_node_reconciliation_required");
        const overview = await call("getCanvas", { canvasId: canvas.id, include: ["nodeTypes"], limit: 100 });
        const type = `remote-${job.mediaType}Node`;
        if (!overview.availableNodeTypes?.some(item => item.type === type))
          fail("host_media_node_unavailable");
        job.importPhase = "creating_node";
        job.hostCanvasId = canvas.id;
        await workflow.store.save(job);
        const created = await call("addNode", { type, label, position: { x: 100, y: 100 } });
        if (!created.node?.id)
          fail("host_node_receipt_missing");
        job.hostNodeId = created.node.id;
      }
      job.hostCanvasId = canvas.id;
      job.importPhase = "setting_media";
      await workflow.store.save(job);
    }
    const method = job.mediaType === "image" ? "node:setImage" : "node:setVideo";
    const tools = await call("getNodeTools", { canvasId: canvas.id, nodeIds: [job.hostNodeId], names: [method], limit: 5 });
    const tool = tools.nodeTools?.find(t => t.nodeId === job.hostNodeId && t.name === method);
    if (!tool?.parameters?.properties?.path || !tool.parameters.properties?.mimeType)
      fail("host_import_contract_unknown");
    const finalStat = await context.files.stat(job.output.relativePath);
    if (finalStat.size !== job.output.bytes)
      fail("output_asset_changed");
    const finalBytes = await context.files.readFile(job.output.relativePath);
    if (createHash("sha256").update(finalBytes).digest("hex") !== job.output.sha256)
      fail("output_asset_changed");
    await call("nodeTools", { nodeId: job.hostNodeId, name: method, args: { path: job.output.relativePath, mimeType: job.output.mimeType } });
    const readback = await call("getCanvasNodes", { canvasId: canvas.id, nodeIds: [job.hostNodeId], fields: ["outputs"], valueLimit: 100 });
    const node = readback.nodes?.find(n => n.id === job.hostNodeId);
    const output = node?.outputs?.[job.mediaType];
    if (readback.hasMore || node?.truncated?.length || output?.value?.url !== job.output.relativePath || output.value.mimeType !== job.output.mimeType)
      fail("host_import_readback_failed");
    job.importReceipt = { canvasId: canvas.id, nodeId: job.hostNodeId, relativePath: job.output.relativePath, sha256: job.output.sha256, importedAt: new Date().toISOString() };
    await context.files.mkdir("integration/receipts", true);
    const receiptPath = `integration/receipts/${job.submitId}.json`;
    try {
      await context.files.writeFile(receiptPath, `${JSON.stringify(job.importReceipt, null, 2)}\n`, true);
    } catch (error) {
      if (errorCode(error) !== "EEXIST")
        throw error;
      const existing = JSON.parse((await context.files.readFile(receiptPath)).toString("utf8"));
      const { importedAt, ...identity } = job.importReceipt;
      const { importedAt: previousTime, ...previousIdentity } = existing;
      if (hash(identity) !== hash(previousIdentity))
        fail("import_receipt_conflict");
    }
    job.state = "completed";
    await workflow.store.save(job);
    return { ...workflow.view(job), message: "文件已校验并导入 Toonflow 画布。请预览画面后决定是否选用；旧版本已保留。" };
  });
}
