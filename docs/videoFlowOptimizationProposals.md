# 视频生成全流程效率与自动连线分析（含改进方案）

记录日期：2026 年 10 月 19 日。
分析对象：当前仓库 `main` 工作区代码。聚焦两个用户痛点——**生成视频全流程效率低**、**生成内容不会自动连线**。
本文只做分析与出方案，不含代码改动。所有结论尽量标注 `文件:行号` 以便核对。

> 与同目录 `videoWorkflowAnalysis.md` 的关系：那份基于真实会话的墙钟测量（上下文建立、确认关口耗时）；本篇基于代码链路的根因分析与工程改进方案，两者互补。

---

## 一、关键事实：视频生成有三条互不相通的链路

| 路径 | 触发方式 | 执行体 | 轮询方式 |
| --- | --- | --- | --- |
| A. 手动节点 | 在视频生成节点上点"生成" | server 直连供应商 API | server 内阻塞轮询（3–5s/次，上限 30 分钟），前端一个长 POST 挂着等 |
| B. Agent 驱动画布节点 | 对话里让 AI 操作 | LLM 调 `node:generateVideo` | 节点立即返回"生成中"，靠 LLM 一轮轮发 RPC 查询状态 |
| C. 即梦 dreamina（**系统默认**） | 对话让 AI 做视频 | 本机 `dreamina-canvas` CLI 子进程 | 不自动轮询，每个状态都要 LLM 决定再查一次；视频还要用户手动下载 |

系统提示词与技能强制默认走 C：

- `apps/server/src/agent/runtime/prompt.ts:38`（视频默认使用即梦 CLI 的 dreamina 工具）
- `packages/skills/v118workflow/SKILL.md:15`
- `packages/skills/workflow/SKILL.md:17`、`packages/skills/canvas/SKILL.md:15`

体感上的"慢"和"不连线"主要来自 C，叠加 B 的控制通道瓶颈。

> `packages/teams/storyboardTeam` 是纯文字 A2A 团队，提示词明文禁止生成图片/视频（`members/director.md:9`、`writer.md:7`、`reviewer.md:7`），不负责媒体生成。

### 各层调用链速览

- A：`videoGenerationNode/index.vue:startGeneration` → `nodeAi.ts:251` 长 POST `/api/ai/media/generate` → `routes/ai/media/generate.ts`（20s 心跳）→ `utils/media/generation.ts:generateMedia` → provider（compshare/apimart/metaso/tfRouter）。
- B：agent runtime → 画布工具 → server `callControl` 经 SSE → web `mcpControl.ts` → `useCanvasTools.ts` → 节点函数。
- C：agent runtime 加载 dreamina 工具插件 → `capabilities → prepare → quote → submit → status×N → collect`，每步是独立工具调用（独立 LLM 轮次），`collect` 再反向 `canvas.call` 建节点、写产物。

---

## 二、效率低的根因（按影响排序）

### 根因 1：画布控制通道"单页面同时只允许一条命令"，并行被强制串行化（最致命）

`apps/server/src/utils/mcp/control.ts:120`

```ts
if (connection.pending) throw new Error("此页面正在执行另一条控制命令，请等待完成");
```

每条命令还有 120 秒硬超时（`control.ts:136`）；节点侧同样 120s（`packages/nodeScaffold/src/nodeTools.ts:129`）。

Agent 即便用 `Promise.all`（subAgent `agent/tools/subAgent.ts:45`、团队 delegate `agent/teams/index.ts:98`）并行下发，只要操作同一画布，第二条命令直接报错。N 个镜头 = N 倍串行往返，无法真正并发。

### 根因 2：等待生成靠"LLM 多轮对话"驱动，而非服务端推送/回调

- 节点 `generateVideo` 立即返回 `{status:"generating"}`（`packages/nodes/videoGenerationNode/src/index.vue:337`）。
- 之后必须由 LLM 后续轮次调 `getGenerationStatus`（`packages/nodeShared/src/useNodeGeneration.ts:11`）。
- 每查一次 = 一次完整 LLM 推理往返 + 一次独占单通道 RPC。
- 即梦 `dreaminaStatus` 是单次只读（`packages/tools/dreamina/src/workflow.ts:392`），整条线 6～N 轮，每轮还 spawn 一次 CLI（单次超时仅 20s，`packages/tools/dreamina/src/runtime.ts:34`、`runner.ts:48`）。

大量时间花在"AI 想起来去查一下"，而非真正生成。

### 根因 3：媒体工具被标记为 `executionMode: "sequential"`

- `packages/tools/mediaGeneration/src/index.ts:40`
- `packages/tools/dreamina/src/index.ts:81`

即使模型在一次回复里并行发起多个独立分镜，运行时也强制串行执行。

### 根因 4：即梦 prepare 参考图全串行 + 每张跑两遍 FFmpeg

- 串行校验/复制：`packages/tools/dreamina/src/workflow.ts:121-132`
- 再次串行校验 + 上传：`workflow.ts:186-191`
- 单次 `validateMedia` 含 probe 20s + 全片解码 20s：`packages/tools/dreamina/src/collect.ts:48,62`

参考图越多，准备阶段线性变慢。

### 根因 5：视频必须人工下载再导入（最长人工断点）

`packages/tools/dreamina/src/collect.ts:87-104`：视频成功后进入 `awaiting_manual_import`，需用户自行去即梦下载、放进工作区、回传路径；图片可自动下载（`collect.ts:105-115`）。

### 根因 6：server 端单请求内参考媒体/产物串行处理

`apps/server/src/utils/media/generation.ts:114-121`（顺序读参考，注释自陈避免探测进程过多）、`:191-206`（逐个下载 + 加锁 + 写盘）。

### 根因 7（次要）：部分供应商轮询无总超时

`packages/providers/src/media/apiMart.ts:116`、`metaso.ts:41` 无 deadline；compshare/tfRouter 有 30 分钟（`compshare.ts:99`、`tfRouter.ts:90`）。上游挂起时请求悬挂。

### 已做得好、勿重复改造的点

- 模型列表跨节点共享缓存/在途去重：`packages/nodeScaffold/src/nodeAi.ts:70-124`。
- 报价 2s 节流 + 30s 缓存：`nodeAi.ts:184-249`、server `billing.ts:129-152`。
- 即梦防重复扣费：Job 账本 + HMAC + claim（`dreamina/store.ts`、`executionVault.ts`）。
- A 路径不同节点前端可各自并发（server 无全局闸），但也因此**缺同参去重/并发上限**。

---

## 三、"不自动连线"的根因（设计缺失，非偶发 bug）

### 即梦回收路径根本没有连线步骤

`packages/tools/dreamina/src/collect.ts`：

1. `:172` 建节点：`call("addNode", { type, label, position: { x: 100, y: 100 } })`
   - 位置硬编码 `(100,100)`，多镜头节点全部叠在同一点；
   - 参数无任何上游节点信息，之后也没有 `connectNodes`。
2. `:192` `node:setVideo/setImage` 只写 outputs，不碰边：
   - `packages/nodes/videoNode/src/index.vue:119`
   - `packages/nodes/imageNode/src/index.vue:145`
3. Job 账本只存 `hostCanvasId/hostNodeId` 与工作区文件路径（`packages/tools/dreamina/src/runtime.ts`），**结构上没有上游节点 id 字段**。

通用 `addNode` 工具同样不建边：`apps/web/src/pages/workspace/panels/canvas/useCanvasTools.ts:140-149`（仅 `flow.addNodes` + 一次 `nextTick`）。

### 对比：会自动连线的路径（能力是现成的）

- 从 handle 拖出新建：`components/nodeMenu.vue:351-395`（`await nextTick()` 等挂载后 addEdges）。
- 图片变体/局部重绘：`packages/nodes/imageNode/src/useImageVariationNode.ts:20-32`（建点 + 连线 + 右侧避让）。
- 全景宫格：`usePanoramaCapture.ts:88-89`。
- 跨画布粘贴：`panels/canvas/index.vue:871-878`。

### edge 不只是视觉，是唯一数据流

- 节点输入完全从入边推导：`packages/nodeScaffold/src/nodeInputs.ts:13-52`。
- 引用区与 `{{ref N}}` 依赖入边：`packages/nodeShared/src/useNodeReferences.ts:32,53`、`nodeEvent.ts:31-38`。
- 没有边 → 下游生成节点的"参考 1/2/…"为空 → 后续镜头拿不到上一步图/视频做参考，直接破坏连续性。

### 即便让 LLM 事后补连线，也有真实失败门槛

1. 远端 UMD 节点异步挂载，handles 由 `nodeSkeleton.vue:543-547` 的 watchEffect 同步；`addNode` 后只 `await nextTick()` 一次（`useCanvasTools.ts:146`），handles 可能未就绪 → `validateConnection` 失败。
2. `connectNodes` 要求 source/target/sourceHandle/targetHandle 全填且类型/方向兼容（`packages/tools/canvas/src/runtime.ts:60-62`、`packages/nodeScaffold/src/connection.ts:33-47`）；**videoNode 只有 source、无 target**（`packages/nodes/videoNode/src/index.vue:73`），方向猜错必败。
3. 一批连线任一校验失败则整批不提交：`useCanvasTools.ts:201-209`（重复边幂等跳过，`194-196`）。

### 节点坐标现状

- Agent `addNode` 坐标是模型自填必填项（`packages/tools/canvas/src/runtime.ts:56`），无宿主避让，模型偷懒常给 0,0/100,100。
- 即梦导入固定 `(100,100)`（`collect.ts:172`），完全重叠。
- 全画布自动布局是 dagre，仅手动/显式触发：`arrangeCanvas.ts`（Agent 可通过 `arrangeCanvas` 工具调用）。

---

## 四、三个改进方案（未实施，待选择）

### 方案 1：最小改动 —— 自动连线 + 解决堆叠 + 放开控制通道并发（性价比最高）

A. 生成内容落地即自动连线
- 扩展 `addNode` 画布工具（`useCanvasTools.ts:140-149`）支持可选 `connect: [{source, sourceHandle, targetHandle}]`，同一次调用内完成"建点 → 等 handles 就绪 → 校验 → addEdges"，复用现成 `validateConnection` 与变体节点避让定位（`useImageVariationNode.ts:20-32`）。
- 把"一次 nextTick"升级为"轮询等待该节点 `data.handles` 出现（带超时）"再连线，消除时序竞态。
- 即梦 Job 在 prepare 记录上游节点 id/handle，`collect.ts:172` 建点后同调用连好参考边；坐标改避让布局。
- 方向：素材节点（image/video）为 source，生成节点 `in` 为 target。

B. 放开控制通道单命令锁（`control.ts:117-141`）
- `connection.pending` 单槽改 `Map<callId, pending>` 多槽（SSE 消息本就带 callId，前端按 callId 回复，天然支持）。
- 顺序敏感操作（删节点、切画布）保持串行；只对只读查询和不同节点的独立命令放开。

C. 状态查询批量化
- 新增一次查多节点的 `getGenerationStatus(nodeIds[])`，把 N 次 LLM 往返压成 1 次。

收益：自动连线/布局立即可用；多分镜建点、查询并发。风险：中低（并发画布状态一致性，需命令白名单）。工作量：约 3–5 处文件。

### 方案 2：中等改动 —— 服务端托管任务 + 事件推送，多镜头并行下单

A. 后台任务化 + 主动推送
- 图/视频生成在 server 落成带 jobId 的后台任务（统一 A/B/C 三路径，可借鉴即梦 Job 账本），立即返回 jobId。
- 状态经现有 SSE 主动推送（参考余额推送 `billing.ts:168-190` 的 `connectBalanceEvents`），不再让 LLM 轮询；节点订阅 jobId，终态自动写 outputs，LLM 仅被通知一次。

B. 解除并行禁令 + 有界并发闸
- 独立媒体工具由 `sequential` 改为允许并行；LLM 一次提交整批分镜。
- server 加有界并发队列（如同时 3–6 个）替代当前无闸裸奔，顺带同参去重防重复扣费（即梦 claim/账本机制保留）。

C. 即梦环节提速
- `dreaminaStatus` 增加可选服务端自动轮询（submit 后内部轮询到终态再返回，或走 A 推送）。
- prepare 参考图改并行校验/上传，去掉重复的第二遍 FFmpeg（快照不可变，可缓存首检结果）。
- status 类 CLI 调用的 20s 超时分类放宽。

收益：N 个独立分镜总耗时从"串行相加"趋近"单个最慢任务"，消除大量 LLM 往返。风险：中（任务持久化、重连恢复、并发扣费安全）。工作量：较大（server 任务系统 + 工具协议）。

### 方案 3：产品级重构 —— "一键整集编排"确定性流水线

- 阶段 11 分镜面板确认后直接产出确定性制作 DAG：文本 → 分镜图 → 视频，边与布局在规划时算好（复用 dagre `arrangeCanvas.ts`）。
- 新增原生批量编排器（确定性代码，非 LLM）：按 DAG 并行调度整批图、再并行整批视频，内置有界并发、失败隔离/局部重试、断点续跑、进度总览、逐镜头状态回写、自动连线。
- LLM 只负责创意/提示词/验收，不再负责调度与轮询；保留三个确认关口（准备/结果/选用，见 `packages/skills/v118workflow/references/videoProduction.md`）。
- 顺带把视频人工下载导入（根因 5）做成自动（走 CLI 直连下载，与图片同路径）。

收益：从"人盯 AI、AI 反复查"变成"确认一次 → 自动跑完整集 → 统一验收"，连线/布局天然正确。风险/工作量：高（DAG 数据模型、与现有三路径取舍、失败与计费边界）。属长期目标架构。

---

## 五、建议的推进顺序

1. 先做**方案 1**：精准解决"不连线、节点堆叠看不见"，并通过放开单命令通道拿到首批并发收益，diff 小、风险低。
2. 再做**方案 2 的 A（后台任务 + 推送）与 B（并行 + 并发闸）**：全流程效率体感提升最大，把 LLM 从轮询中解放。
3. **方案 3** 作为目标架构：方案 1、2 产出的任务系统、自动连线、DAG 数据都可复用为其地基。

---

## 附：关键代码位置索引

| 主题 | 位置 |
| --- | --- |
| 控制通道单命令锁 / 120s | `apps/server/src/utils/mcp/control.ts:120,136` |
| 节点函数 120s 超时 | `packages/nodeScaffold/src/nodeTools.ts:129` |
| 节点生成立即返回 | `packages/nodes/videoGenerationNode/src/index.vue:321-337` |
| 前端长 POST | `packages/nodeScaffold/src/nodeAi.ts:251-264` |
| server 媒体编排 | `apps/server/src/utils/media/generation.ts:114-214` |
| 媒体工具 sequential | `packages/tools/mediaGeneration/src/index.ts:40` |
| 即梦工具 sequential / 状态单次 | `packages/tools/dreamina/src/index.ts:81`、`workflow.ts:381-409` |
| 即梦 CLI 20s 超时 | `packages/tools/dreamina/src/runtime.ts:34`、`runner.ts:48` |
| 即梦建节点（100,100，无连线） | `packages/tools/dreamina/src/collect.ts:172` |
| 即梦视频人工导入 | `packages/tools/dreamina/src/collect.ts:87-104` |
| 画布 addNode / connectNodes | `apps/web/src/pages/workspace/panels/canvas/useCanvasTools.ts:140-212` |
| 节点输入从边推导 | `packages/nodeScaffold/src/nodeInputs.ts:13-52` |
| 引用区 / {{ref N}} | `packages/nodeShared/src/useNodeReferences.ts` |
| 自动连线参考实现 | `packages/nodes/imageNode/src/useImageVariationNode.ts:20-32` |
| 自动布局（dagre） | `apps/web/src/pages/workspace/panels/canvas/arrangeCanvas.ts` |
