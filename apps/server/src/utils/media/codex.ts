import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { lstat, readFile, realpath } from "@toonflow/file";
import { getCodexProvider, getDefaultAiModel, startCodex } from "@/utils/ai/codexHost";
import type { CodexRpc } from "@/utils/ai/codexRpc";
import { codexErrorMessage } from "@/utils/ai/codexRpc";

// 正式内置供应商，源码只声明菜单能力；原生生成由宿主注入，不能通过安装文件替换。
export const codexMediaSource = `export default {
  id: "codex", label: "Codex（本机登录）", version: "1.0.0",
  readme: "使用官方 Codex CLI 当前 ChatGPT 登录。首期仅单张文生图，默认按 9:16 构图；像素尺寸由原生能力决定。参考图、局部重绘、打光、多角度暂不支持。原生单回合可能含多次内部调用，不能保证只消耗一张额度。",
  models: [{ id: "codexImage", label: "Codex · 原生文生图", type: "image", mode: ["text"], imageSizes: ["原生尺寸"], imageRatios: ["9:16"] }],
  rules: [],
  async generateImage() { throw new Error("Codex 图片生成需要 Toonflow 原生宿主"); }
};`;

export async function generateCodexImage(request: ImageRequest, signal?: AbortSignal): Promise<MediaAsset[]> {
  if (request.model !== "codexImage" || request.images?.length || request.mask || (request.n !== undefined && request.n !== 1)) throw new Error("Codex 首期仅支持单张文生图，不支持参考图、局部重绘或多张生成");
  if (request.ratio && request.ratio !== "9:16") throw new Error("Codex 图片当前仅支持按 9:16 构图");
  if (request.size && request.size !== "原生尺寸") throw new Error("Codex 图片尺寸由原生能力决定，请选择原生尺寸");
  if (!request.prompt?.trim() || request.prompt.length > 12000) throw new Error("Codex 图片提示词须为 1 到 12000 字符");
  signal?.throwIfAborted();
  const configured = getDefaultAiModel();
  const models = getCodexProvider().models;
  const modelId = configured.providerId === "codex" ? configured.modelId : models.find(model => model.id === "gpt-6.1-sol")?.id;
  if (!modelId) throw new Error("请在文本模型设置中选择可用的 Codex 默认模型，再生成图片");
  let rpc: CodexRpc | undefined;
  let threadId = "";
  let turnId = "";
  const images: { savedPath?: string; status?: string; failure?: unknown }[] = [];
  const completed = Promise.withResolvers<void>();
  // 任务可能在启动 RPC 应答之前失败，预先消费 rejection，最终 await 仍会抛出。
  void completed.promise.catch(() => {});
  const abort = () => { completed.reject(new Error("Codex 图片生成已取消；不会自动重试")); rpc?.close(); };
  const timer = setTimeout(() => { completed.reject(new Error("Codex 图片生成超时；可能已消费额度，不会自动重试")); rpc?.close(); }, 600000);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const started = await startCodex(modelId, true, signal);
    rpc = started.rpc;
    signal?.throwIfAborted();
    rpc.on("closed", () => completed.reject(new Error("Codex 图片服务已退出；任务状态未知，不会重新提交")));
    rpc.on("request", () => { completed.reject(new Error("Codex 图片回合发起了不支持的额外工具请求")); rpc?.close(); });
    rpc.on("notification", packet => {
      const p = packet.params;
      if (p?.threadId !== threadId) return;
      if (packet.method === "turn/started") turnId ||= p.turn?.id;
      if (p.turnId && turnId && p.turnId !== turnId) return;
      if (packet.method === "error") { completed.reject(new Error(codexErrorMessage(p.error))); rpc?.close(); return; }
      if (packet.method === "item/started" && ["commandExecution", "fileChange", "mcpToolCall", "collabAgentToolCall"].includes(p.item?.type)) {
        completed.reject(new Error("Codex 图片回合尝试执行额外操作，已停止")); rpc?.close();
      }
      if (packet.method === "item/completed" && p.item?.type === "imageGeneration") images.push(p.item);
      if (packet.method === "turn/completed") {
        if (turnId && p.turn?.id !== turnId) return;
        if (p.turn?.status === "completed") completed.resolve();
        else completed.reject(new Error("Codex 图片生成未完成，请检查官方账户图片额度、登录状态与模型能力"));
      }
    });
    const thread = await rpc.request("thread/start", { model: modelId, allowProviderModelFallback: false, cwd: started.scratch, ephemeral: true, sandbox: "read-only", approvalPolicy: "never", dynamicTools: [] });
    threadId = thread.thread.id;
    const turn = await rpc.request("turn/start", { threadId, model: modelId, input: [{ type: "text", text:
      `Use image_gen.imagegen to generate one new image. Do not read or edit existing images. Do not create variants or retry failed calls. Return after the image result. Compose a vertical image with a target aspect ratio of 9:16; native pixel dimensions may vary. Prompt:\n${request.prompt}`, text_elements: [] }] });
    turnId ||= turn.turn.id;
    await completed.promise;
    signal?.throwIfAborted();
    if (images.length !== 1 || images[0]!.status !== "completed" || images[0]!.failure) throw new Error("Codex 没有返回唯一成功图片；不会自动补生成");
    const savedPath = images[0]!.savedPath;
    if (!savedPath || !isAbsolute(savedPath) || !/^[a-zA-Z0-9_-]+$/.test(threadId)) throw new Error("Codex 图片产物路径无效");
    const root = await realpath(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "generated_images", threadId));
    const info = await lstat(savedPath);
    const path = await realpath(savedPath);
    const child = relative(root, path);
    if (info.isSymbolicLink() || !info.isFile() || !child || child.startsWith("..") || isAbsolute(child) || !info.size || info.size > 100 * 1024 * 1024) throw new Error("Codex 图片产物超出允许目录或大小上限");
    const bytes = await readFile(path, { signal });
    if (!bytes.length || bytes.length > 100 * 1024 * 1024) throw new Error("Codex 图片产物为空或超过大小上限");
    const image = new Bun.Image(bytes);
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > 40000000) throw new Error("Codex 图片像素尺寸无效或过大");
    const data = await image.png().toBuffer();
    return [{ mediaType: "image", type: "binary", mimeType: "image/png", data }];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    rpc?.close();
  }
}
