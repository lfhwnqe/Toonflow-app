import { z } from "zod";
import type { ToolPlugin } from "@toonflow/tools-scaffold/runtime";
import { cliError, validateConfig } from "./runner";
import { mediaWorkflow, publicCanvasUrl } from "./workflow";
import { collect } from "./collect";
import { businessId, errorCode, planSchema } from "./runtime";
import { redact } from "./store";

const jobSchema = z.strictObject({ jobKey: businessId });
const schemas = {
  dreaminaCapabilities: z.strictObject({}),
  dreaminaPrepare: planSchema,
  dreaminaQuote: jobSchema,
  dreaminaSubmit: jobSchema,
  dreaminaStatus: jobSchema,
  dreaminaCollect: z.strictObject({ jobKey: businessId, sourcePath: z.string().min(1).max(4096).optional() }),
  dreaminaRecover: jobSchema,
  dreaminaCancelLocal: jobSchema,
};
const labels = {
  dreaminaCapabilities: "即梦可用模型", dreaminaPrepare: "准备即梦镜头", dreaminaQuote: "查看即梦报价", dreaminaSubmit: "确认生成",
  dreaminaStatus: "查看生成进度", dreaminaCollect: "导入生成结果", dreaminaRecover: "恢复已有任务", dreaminaCancelLocal: "停止本地任务",
};
const descriptions = {
  dreaminaCapabilities: "读取本机即梦 CLI 登录状态与实时模型、参数；支持文生图、文生视频、图片参考视频和图片首尾帧，视频默认先查询此工具。",
  dreaminaPrepare: "从 references 按顺序读取工作区图片，正文用 {{ref 1}} 等引用；确认后上传固定副本并保存独立即梦云草稿，不生成。jobKey 唯一绑定本工作区的一份不可变镜头计划。",
  dreaminaQuote: "为已保存镜头获取真实积分报价；只报价，不授权消费。",
  dreaminaSubmit: "显示本次生成及积分上限确认卡，仅用户明确批准后提交一次；模型不能批准。",
  dreaminaStatus: "只读查询原任务进度，不重新生成。",
  dreaminaCollect: "图片经官方 CLI 下载并校验后导入；视频需用户下载到工作区后传 sourcePath 相对路径。只导入，不生成。",
  dreaminaRecover: "只读核对原草稿或原提交，恢复本地状态；不补建，不重提。",
  dreaminaCancelLocal: "停止本地新提交；不会取消云端任务或承诺退款。",
};
const errorMessages: Record<string, string> = {
  executable_missing: "未找到 dreamina-canvas，请安装官方 CLI 或在即梦插件设置中填写绝对路径。",
  readonly_online_disabled: "请在即梦插件设置中开启连接即梦服务；这不会授权保存草稿或生成。",
  live_generation_disabled: "请在即梦插件设置启用“允许逐次人工确认后生成”；每次仍需人工批准。未提交生成。",
  human_confirmation_unavailable: "本对话没有用户确认通道，请在 Toonflow 工作区对话使用。",
  quote_changed_or_expired: "报价已变化或过期，请重新报价再确认。没有重新提交。",
  ledger_integrity_failed: "任务记录无法验证来源，已停止执行。请保留原记录和签名密钥排查。",
  submission_already_claimed: "该任务已领取提交或结果不确定，请查询原任务，不能再次生成。",
  job_busy: "此镜头还有操作进行中，请等待它结束。",
  schema_version_unknown: "即梦 CLI 契约与已迁移版本不匹配，已阻止后续操作。",
  cli_version_unknown: "当前仅适配即梦 CLI 1.0.3 / 244064d / cn，已阻止后续操作。",
  media_tools_required: "请先按 Toonflow 提示安装 FFmpeg/FFprobe。尚未提交生成。",
  FFMPEG_REQUIRED: "参考图和生成结果校验需要 FFmpeg/FFprobe，请在插件市场安装后继续。尚未提交生成。",
  account_session_changed: "登录会话与原任务不一致，已保留原任务并停止后续操作。",
  cloud_node_missing: "原画布存在，但原节点未保存；没有自动补建或生成。",
  cloud_canvas_missing: "未找到原画布，保留原任务等待核对；没有自动重建。",
  cloud_generation_present: "云节点已有生成或资源，请核对原任务；不会自动重新生成。",
  canonical_model_or_mode_unknown: "即梦型号、模式或参考数量不匹配，请先查询 dreaminaCapabilities，不要改走 API 供应商。",
  invalid_reference_count: "参考图片数量超出当前即梦模型允许范围，没有提交生成。",
  required_reference_missing: "此即梦模式需要真实参考图片，请在 references 中按顺序填写工作区图片相对路径。",
  invalid_reference_index: "提示词中的 {{ref N}} 超出 references 图片列表，请核对顺序。",
  inline_reference_not_enabled: "即梦接入只接受 {{ref N}} 图片标记，请按 references 顺序引用；不能直接填入其他平台的节点标识。",
  reference_snapshot_mismatch: "参考图与已确认的固定副本不一致，已停止，没有提交生成。",
  uploaded_reference_mismatch: "即梦返回的上传资源与本次参考图不一致，已保留任务，请查询原草稿。",
  cloud_reference_mismatch: "即梦草稿中的参考图片或顺序已改变，没有提交生成。",
};

const plugin: ToolPlugin = {
  validateConfig,
  createTools(context) {
    const workflow = new mediaWorkflow({ ...context, config: validateConfig(context.config) });
    const operations = {
      dreaminaCapabilities: (_params: unknown, _callId: string, signal?: AbortSignal) => workflow.discover(signal, true),
      dreaminaPrepare: (params: unknown, callId: string, signal?: AbortSignal) => workflow.prepare(planSchema.parse(params), callId, signal),
      dreaminaQuote: (params: unknown, _callId: string, signal?: AbortSignal) => workflow.quote(jobSchema.parse(params).jobKey, signal),
      dreaminaSubmit: (params: unknown, callId: string, signal?: AbortSignal) => workflow.submit(jobSchema.parse(params).jobKey, callId, signal),
      dreaminaStatus: (params: unknown, _callId: string, signal?: AbortSignal) => workflow.status(jobSchema.parse(params).jobKey, signal),
      dreaminaCollect: (params: unknown, callId: string, signal?: AbortSignal) => {
        const input = schemas.dreaminaCollect.parse(params);
        return collect(workflow, input.jobKey, callId, input.sourcePath, signal);
      },
      dreaminaRecover: (params: unknown, _callId: string, signal?: AbortSignal) => workflow.status(jobSchema.parse(params).jobKey, signal),
      dreaminaCancelLocal: (params: unknown) => workflow.cancel(jobSchema.parse(params).jobKey),
    };
    return (Object.keys(schemas) as (keyof typeof schemas)[]).map(name => ({
      name, label: labels[name], description: descriptions[name],
      parameters: z.toJSONSchema(schemas[name], { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      async execute(callId, params, signal) {
        try {
          signal?.throwIfAborted();
          const raw = await operations[name](schemas[name].parse(params), callId, signal);
          const result = redact(raw) as Record<string, unknown>;
          if ("webUrl" in raw) {
            const url = publicCanvasUrl(raw.webUrl);
            if (url) result.webUrl = url;
          }
          if (workflow.client.requestId) result.requestId = workflow.client.requestId;
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        } catch (error) {
          if (signal?.aborted) throw error;
          const code = error instanceof Error && error.name === "FfmpegRequiredError" ? "media_tools_required" : errorCode(error);
          const requestId = error && typeof error === "object" && "requestId" in error ? error.requestId : workflow.client.requestId;
          const diagnostic = error instanceof cliError ? error.diagnostic : undefined;
          const result = { status: "blocked", code,
            message: errorMessages[code] ?? (diagnostic?.message ? `即梦返回：${diagnostic.message}。未自动重新提交生成。` : "本步骤未完成，请保留当前任务并核对错误。不会自动重新提交生成。"),
            ...(diagnostic ? { diagnostic } : {}), ...(typeof requestId === "string" ? { requestId } : {}) };
          return { content: [{ type: "text", text: JSON.stringify(result) }], isError: true, details: result };
        }
      },
    }));
  },
};

export default plugin;
