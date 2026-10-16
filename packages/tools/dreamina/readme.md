# 即梦生成工具

由已有 `toon-flow-plugins/packages/dreamina-tool` 0.2.3 迁移至新版 Toonflow tool scaffold。来源提交：`38ca2b2667409c6d4bd8b26c059c8cf25eacdb02`；仅迁移即梦能力，没有引入 Codex Provider、网关或测试模块。

在本包执行 `bun run build`，产物为仓库根目录 `build/tools/dreaminaTool.tool.js`。通过“设置 → 插件市场”安装，或使用仓库现有 `dev:plugins` 同步到开发数据目录。生产构建不会修改用户插件或设置。

`dreamina-canvas` 路径留空时自动查找标准安装位置，也可填写绝对路径；官方登录 profile 和区域默认为 `default`、`cn`。未配置或未安装 CLI 不会阻止其他 Agent 工具启动。默认关闭联网和生成；开启联网后才能查询模型、报价与原任务。开启生成开关后，每次仍需用户在确认卡片中明确批准本次计划和积分上限。插件复用官方 CLI 登录，不读取或保存登录凭据。

当前固定适配官方 CLI `1.0.3`、commit `244064d`、`cn`，并核对原集成的完整 schema SHA-256：`146f1d781d9ba69f6e18168d5aa8c90d251645475cf9bbe87bda5eecdd192399`。版本或契约不匹配时停止，不猜测新参数，也不自动升级 CLI。

| 工具 | 行为 |
| --- | --- |
| `dreaminaCapabilities` | 读取版本、契约、认证摘要和实时图片/视频模型目录 |
| `dreaminaPrepare` | 校验并保存本地计划；人工确认后创建独立云画布和草稿，不运行生成 |
| `dreaminaQuote` | 对已保存且未变化的云草稿取得真实报价，不批准消费 |
| `dreaminaSubmit` | 重新核对草稿、登录会话、报价和依赖，人工批准后带明确 ceiling 和原 submitId 提交一次 |
| `dreaminaStatus` | 只读观察原任务，资源全部成功后进入回收阶段 |
| `dreaminaCollect` | 校验、保存既有结果；人工确认后新增 Toonflow 节点并回读输出 |
| `dreaminaRecover` | 有提交证据时仅查询原 operation，否则只读核验原草稿；不会补建或重提 |
| `dreaminaCancelLocal` | 停止本地新提交，不取消云任务，也不承诺退款 |

新版工具名统一小驼峰，分别对应旧版的 `dreamina_capabilities/prepare/quote/submit/status/collect/recover/cancel_local`。插件元数据名仍为 `dreaminaTool`，已有六项公开配置名称保持不变。支持 `t2i`、`t2v`、图片参考 `m2v`、图片首尾帧 `first_last_frame`，一镜一产物。视频默认使用此 CLI 入口；图片默认仍为 Codex。仅用户明确选择 API 供应商时使用普通视频生成节点。不接收视频/音频参考，不开放批量、自动返修或原生媒体 Provider 入口。

`dreaminaPrepare.references` 按顺序传 `{ path }`，路径为 Toonflow 工作区内真实图片；提示词用 `{{ref 1}}` 等引用。宿主核对模型参考数量，固定图片至 `integration/references` 并计算 SHA-256；用户确认保存后才将固定副本上传到独立即梦云画布，使用提前持久化的资源 UUID。提交前回读并核对提示词、实际资源身份、顺序和参数。上传或保存中断保留原任务，不自动新建或重新提交。旧的无参考任务仍可查询和回收。

本地计划、签名任务账本和导入回执仍保存到当前工作区 `integration/plans`、`integration/jobs`、`integration/receipts`。读写走宿主 `context.files`，完整快照由宿主原子保存。素材保存在 `assets/dreamina`，校验大小、文件头、SHA-256、FFprobe 和实际解码；画布使用公开 `setImage/setVideo` 节点函数导入，不直接改画布 JSON。

签名密钥和永久提交记录通过 `@toonflow/file` 存在宿主 `TOONFLOW_DATA_DIR/dreamina`，必须位于当前工作区之外；macOS 已有旧集成私有目录时继续复用其签名和提交记录。不要删除密钥或 claims 来重试生成。旧任务需要保留原工作目录、计划、账本及私有记录；移动工作区会改变项目身份，不自动重签。旧版未公开的只读诊断配置 `readOnlyProjectId/readOnlyNodeIds` 已废弃，加载旧配置时忽略，保存时移除；其他未知配置仍严格拒绝。

同一镜头操作使用进程内互斥，提交同时具有私有永久 claim 和工作区独占 claim。中断、进程重启、响应丢失及 `absent/unknown` 只允许恢复查询；不能通过再次调用 submit 触发新运行。旧版遗留 `.lock` 不再充当操作锁。仍遵循宿主单进程写工作区的边界，不支持多个 Toonflow 实例并发编辑同一工作区。报价仅在本地两分钟有效期内可审查，确认前后都会重新报价；登录会话变化会阻止继续，需人工核对原任务。

图片使用官方 CLI 下载。此 CLI 版本没有已核实的自动视频下载契约：视频成功后保持 `awaiting_manual_import`，用户从官方画布下载至工作区，再提供 `sourcePath` 相对路径。文件和云视频的内容对应由用户确认；不会拼接私有 URL。没有激活 Toonflow 画布时先保留已校验文件，打开原目标画布后继续导入。

报价不代表最终净消费，`cost.settled` 保持 `null`。消费 token、原始 provider payload、签名下载地址和登录材料不会写入账本。开发迁移没有执行真实消费或媒体生成；生成、真实图片回收和桌面交互仍待人工验收。仅构建或类型检查通过不表示真实生成通过。

CLI 失败时，工具结果保留脱敏后的具体错误、校验字段、建议动作和请求编号；同时在服务端终端及 `TOONFLOW_DATA_DIR/dreaminaLog.jsonl` 记录。日志不包含命令参数、完整提示词、图片内容或积分授权 token。`service.2` 只是服务端错误分类，不能仅凭它判断上传失败或模型不支持；按具体诊断核对原任务，不自动重提。
