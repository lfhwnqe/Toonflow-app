import { createToolConfig } from "@toonflow/tools-scaffold";

await createToolConfig({
  name: "dreaminaTool",
  displayName: "即梦生成",
  description: "确认镜头、获取真实积分报价、逐次批准即梦生成并导入图片；视频下载到工作区后可导入。",
  author: "Toonflow Local Integration",
  github: "",
  prompt: `即梦生成使用 dreaminaCapabilities 查询当前 canonical 模型及参数，再用 dreaminaPrepare 等待用户确认镜头并保存独立云草稿，dreaminaQuote 获取真实报价，dreaminaSubmit 等待用户单独批准本次积分上限，dreaminaStatus 观察原任务，dreaminaCollect 回收。
不得通过外部 CLI 绕过本插件或替用户回答确认。默认关闭生成，启用后每次仍须用户明确批准；跳过、取消、沉默不表示授权。仅支持 t2i/t2v，一镜一产物。
恢复使用原 jobKey 和 dreaminaRecover；超时、失败或 absent/unknown 不创建新提交，不自动再生成。新尝试需新 jobKey 和独立人工批准。不要把草稿、报价、受理或链接称作已交付，最终净消费未知时保持未知。
视频需用户从即梦下载到当前工作区，再将相对路径传给 dreaminaCollect。向用户展示工具返回的官方 webUrl。`,
  configRules: [
    { type: "input", field: "executable", title: "dreamina-canvas 绝对路径（留空自动查找）", value: "" },
    { type: "input", field: "profile", title: "官方登录 profile", value: "default" },
    { type: "input", field: "region", title: "明确区域（当前仅 cn）", value: "cn" },
    { type: "switch", field: "readOnlyOnline", title: "连接即梦服务（保存草稿和生成仍单独确认）", value: false },
    { type: "switch", field: "liveGeneration", title: "允许逐次人工确认后生成", value: false },
    { type: "inputNumber", field: "timeoutMs", title: "命令超时（毫秒）", value: 20000, props: { min: 100, max: 60000 } },
  ],
  components: { dreaminaPrepare: "src/approvalCard.vue", dreaminaSubmit: "src/approvalCard.vue", dreaminaCollect: "src/approvalCard.vue" },
}, import.meta.url);
