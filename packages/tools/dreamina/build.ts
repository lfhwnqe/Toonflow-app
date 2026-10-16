import { createToolConfig } from "@toonflow/tools-scaffold";

await createToolConfig({
  name: "dreaminaTool",
  displayName: "即梦生成",
  description: "通过本机即梦 CLI 生成视频，支持工作区图片参考、首尾帧、真实报价与进度查询；视频下载到工作区后可导入。",
  author: "Toonflow Local Integration",
  github: "",
  prompt: `视频默认经本工具调用本机 dreamina-canvas，复用官方登录，无需媒体供应商 API Key。先用 dreaminaCapabilities 查询当前 canonical 模型及参数，再用 dreaminaPrepare 等待用户确认镜头并保存独立云草稿，dreaminaQuote 获取真实报价，dreaminaSubmit 等待用户单独批准本次积分上限，dreaminaStatus 观察原任务，dreaminaCollect 回收。
支持 t2i/t2v、图片参考 m2v 和图片首尾帧 first_last_frame，一镜一产物；不接收视频/音频参考。把 Toonflow 图片输出的真实工作区相对路径按顺序填入 references:[{path}]，正文用 {{ref 1}} 等绑定，宿主负责固定图片、上传和转换为即梦资源引用，不能把 Toonflow 节点 ID 当成即梦 Node ID。Seedance 型号必须选目录的 canonical 值；不要因即梦与 API 平台有同名模型而改用 API。
Toonflow 文本节点保存完整方案与任务记录，即梦生成不调用普通视频节点的 generateVideo。草稿保存与积分批准使用本工具自身的确认卡，不叠加同内容 askUser。不得通过外部 CLI 绕过本插件或替用户回答确认。默认关闭生成，启用后每次仍须用户明确批准；跳过、取消、沉默不表示授权。
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
