# FIG 子层拖动与缩小导航：实际复现、热点和方案

2026-10-31。本轮增加诊断脚本和隔离候选产物，没有改变生产选择策略或默认渲染开关。上轮数据布局等修改完整保留。

## 复现对象与边界

- 原件：`/Users/Apple/Downloads/01有料素材.fig`，387,579 字节，SHA-256 `90eb4dc4d09b67cbcc7afa790bb373c28560f97e2111e8adfcfa269bc2afb82c`。每轮结束重新核验，原件未变。
- 实际导入：9,403 节点、21 个页面根、399 个组件相关节点、100 个有效果节点；`designSystem` 约 100,673 个 JSON 字符。所测显示 profile 为 `analytic`，实际 renderer 为 WebGPU。
- 使用当前桌面构建：2026-10-31 05:55:04 UTC，macOS ARM64，`desktop-dev`，Electron 原生准备器、实际 WASM 与 GPU，DPR 2。生产源码 hash 与构建相符；差异仅两份后续测试文件。不是断言用户另一个安装包必然使用同一构建。
- 隔离用户资料、真实 FIG 导入、真实 pointer/wheel 输入。只读从 Canvas 的 React props 找到实际 Editor，用其原有方法设置测试初始选择/相机；拖动和平移通过真实输入执行。未构造替代文档模型或绘制结果。
- FIG 走普通 `ProgressiveSurface` 路径；本例没有调用大源快照 `load_source_snapshot`。因此不把 `SourceViewportPlanner` 当作这次 FIG 卡顿的主路径。
- rAF 间隔是浏览器帧调度观察，不是物理显示 FPS。GPU 探针在原 `queue.submit` 后每 250 ms 最多采样一次 `onSubmittedWorkDone`；其等待包含 GPU 完成及 Worker 回调投递，不等于纯 GPU 着色器耗时。

## 1. 直接拖子层时，实际选中的是父画板

`main-2/report.json` 的八个可见子层样本均显示：

| 入口 | 命中结果 |
| --- | --- |
| 普通悬停 | 小的文本/矩形子层 |
| 未进入层级时的普通按下 | `01_Dashboard` 父 Frame |
| 显式深选 | 子层 |
| 先选定该子层，再普通按下 | 保持子层 |

实际拖动 `Legend 02`，未预先选择时，pointerdown 的 selection 是父画板。最终只有父画板的位置从 `[77,-271]` 变为 `[157,-231]`，其后代随父变换移动。

因果链在 [engine.ts](../../frontend/design-client/src/engine.ts) 的 `hoverHit` / `selectionHit` 与 [selection-hierarchy.ts](../../frontend/design-client/src/selection-hierarchy.ts) 的 `shallowSelectionHit`：悬停寻找较小对象，普通选择则返回未进入的首个 frame/group/component 边界。Canvas 使用后者建立 `drag.ids`。现有 `selectedChildDragIntent` 主要保护**已经选中**的子层，不能改变第一次普通按下的层级提升。

已预选子层的像素反证在 `child-pixels/`：拖动未松手时，旁边绿色兄弟矩形的 7×7 像素仍完全相同；避开粉色吸附辅助线的字形内部 patch 按实际位移对齐后完全相同。实际位移为设备像素 `[15,-1]`，对应启用像素吸附后的文档位移 `[7.5,-0.5]`。不能拿计划的鼠标位移 `[8,0]` 当成实际像素移动；最初未避开辅助线的比较也保留了结果。

**结论：本例的普通拖动确实移动了父节点，触发点是选择层级规则。预先选择子层的这组像素回放没有发现整块父画板误平移。**

## 2. 子层不粘手：跨父边界触发主线程 WASM 布局

目标文本位于一个 90×20 的 `Legend 02` Frame 内，约束是水平 scale / 垂直 center。16 次指针移动中，前几次仍在父边界内；跨出边界后，原 GPU 位姿通路停止，进入换父级预览。

实际调用链：

```text
Canvas.moveImpl
  → canvasMovePreservesParents = false
  → Editor.preview / previewCore
  → movePreviewDocument
  → kernelLayout
  → resolve_components_patch（主线程 WASM）
```

`movePreviewDocument` 每次从事务的原始预览基准重建换父级草稿，并清空约束参考尺寸。普通 move 没有进入 `!move` 才使用的 `PreviewLayout` 入口。稳定落在同一目标父级后的后续移动仍重复走布局；`canvasMovePreservesParents` 和实际 placement 的禁止条件也没有共用一个计划，应同时审计组件/动画阻止换父级的情况。

控制回放（`child-profile/report.json`）：

| 手势 | 长任务数量 | rAF P95 | 最大 rAF 间隔 |
| --- | ---: | ---: | ---: |
| 父边界内的小移动 | 1 | 10.3 ms | 218.2 ms |
| 普通跨边界拖动 | 13 | 331.4 ms | 491.2 ms |
| 移动期间保留父级，松手前释放该修饰 | 1 | 10.0 ms | 632.5 ms |

最后一行是诊断控制：连续移动阻塞消失，结构提交成本集中到松手。它不是交付的完整交互修复，也没有把 632.5 ms 提交峰值隐藏。

CPU profile 约 5,585 ms，其中累计采样：

- `Editor.preview`：约 3,970 ms。
- `kernelLayout`：约 3,582 ms。
- `resolve_components_patch` / Rust `State::patch`：约 3,389 ms。
- Node 的 serde 序列化：约 2,482 ms。
- `components::encoded_len`：约 1,920 ms。

这些是**包含子调用的时间，互相重叠，不能相加**。见 `child-profile/profile-summary-named.json`。通过重新生成带名字的 WASM 并去掉 name 段，与实际运行的 WASM 逐字节匹配后恢复函数名；证明在 `wasm-name-proof.json`，运行字节 SHA-256 为 `dd3fe521dce4066a3e9cd9f657168ebf8b9bb008f55ffb5dcb68ec3d9dc82683`。

### “patch” 后仍然发生的全表工作

[component_updates.rs](../../design-studio/crates/design-kernel/src/component_updates.rs) 已有 scoped 路径，不能说每次都全量展开所有实例。但它仍然：

1. 在 `patch_scoped` 对完整文档调用 `serialized_document_size`。
2. 在 `resolve_plan → components::resolve_roots` 检查组件并计算完整源的 `encoded_len`。
3. 对完整 `ResolvedDocument` 再算一次 `encoded_len`。
4. `resolve_plan` 的 `components::check_budget` 再编码完整文档计数。

[components.rs](../../design-studio/crates/design-kernel/src/components.rs) 的 `encoded_len` 已使用只计数 writer；**没有临时 JSON Vec，不代表不消耗序列化 CPU**。当选中实例集合为空时，只要整个文档含组件，该函数仍构建全表借用 map、模式上下文并做源/结果预算编码。本例目标分支本身没有组件或实例，其他位置有 399 个组件相关节点。

这解释了为何 Node 变小、Network 共享之后，这条热路径仍会卡顿。不要把本例描述成“每次相机变化重新传整份 JSON”：导航记录中的 native `load_document` 只有一次。

## 3. 小倍率平移与停顿后缩放：GPU 提交过早排队

小倍率扩大可见世界范围。此次日志中有低倍率请求准备 4,359–6,931 个节点，单次 native 准备 wall 约 382–493 ms；`preparedNodes` 是准备窗口的节点数，不等于最终绘制节点数。固定 514×514 的瓦片也不能保证准备工作很少。

真实导航序列：6.25% 缩放、左右各 16 次平移、10 秒静止、48 次放大和 24 次反向缩小。确认轮的 10 秒静止期没有新的 Worker 渲染请求；前一 GPU 完成样本距恢复输入已超过 10 秒。拥堵发生在恢复输入后的新提交中。本例导航 native 日志只有 canvas lane，**没有观测到 interaction capture 抢占**；取消选中状态也没有消除 GPU 等待。

现有 [EncodeYield](../../frontend/design-client/src/kernel/gpu/encode-yield.ts) 已约每 4 ms 让出 Worker 编码。关键在 [renderer.ts](../../frontend/design-client/src/kernel/gpu/renderer.ts) 的 `yieldEncoding`：默认分支让出之后继续 `submitPending()`。CPU 能接收新消息，已经提交给 GPU 的工作仍排在新合成之前；请求 mailbox 的“只留最新”不能撤回这些命令。

### 隔离背压候选，未改正式默认

单独构建 `VITE_DESIGN_RASTER_BACKPRESSURE=1`，复用完全相同的 native 产品、WASM、源文件、质量和内存预算。它在既有编码让出点等待实际队列进度，保持单个 raster owner。完成两轮候选并反向重跑默认构建，结果见 `navigation-comparison.json`：

| 指标 | 默认，两次 | 背压候选，两次 |
| --- | --- | --- |
| GPU 完成回调等待 P95 | 278.7 / 319.1 ms | 32.1 / 26.3 ms |
| GPU 完成回调最大等待 | 424.0 / 384.5 ms | 38.5 / 28.3 ms |
| 低倍平移最大 rAF 间隔 | 208.4 / 174.1 ms | 9.4 / 9.4 ms |
| 停顿后缩放最大 rAF 间隔 | 350.2 / 233.3 ms | 16.6 / 25.1 ms |
| 最后输入到当前画面完成状态 | 690.0 / 570.5 ms | 674.6 / 527.2 ms |

四次最终相机完全相同，整张桌面 PNG 字节相同，SHA-256 都是 `d29f619a66fbdabde8ecf70dd17c6feb8a96ab19b7bc53290afc8385e9135d5a`。候选显著改善此输入序列的提交拥堵，最终精修仍没有达到 100 ms。初始默认、取消选中、候选和确认轮均保留；没有只选最快样本。

## 建议落地的修改

1. **统一实际目标解析。** 悬停和按下共用明确的层级/遮挡/锁定策略。按用户希望的“拖当前子对象”语义，普通拖动进入可编辑子层；移动容器由标题/边框或显式选中容器承担。保留深选、多选、已有容器选择及只读路径的测试，不能仅把任意最小包围盒当目标。
2. **给手势保留已解析的 placement 基准。** 目标父级变化时计算一次结构预览和约束基准；同一父级下继续用原有 GPU 位姿通路。让 `canvasMovePreservesParents` 与 `movePreviewDocument` 消费同一 placement 计划，处理禁止换父级的组件/动画分支。保留原世界矩阵运算顺序、clip/效果、撤销与最终落位，避免直接跳过重挂父级语义。
3. **让原生 scoped 更新的成本也局部化。** 已证明实例集合为空、无定义默认值工作时跳过组件展开阶段；为预算建立绑定 receipt 的精确字节台账，只重新计数实际变更及派生节点/字段。完整导入、未知依赖或台账失效仍用原路径。不能直接删除预算检查或用粗略大小代替真实编码长度；失败时台账与文档一起原子回滚。
4. **将背压收窄成导航提交策略。** 复用已验证方向，限定可见导航/精修的在途 raster 工作量，让最新相机合成及时提交；补取消、设备丢失、内存压力与连续编辑交接。该现有开关影响面较宽，候选导航通过不等于所有导出/HDR/交互路径均已验证，不能直接整体打开实验开关。
5. **继续压缩低倍视口的 native 准备范围。** 按实际 `preparedNodes`、`prepareReuses`、路径/描边缓存与密度切换计数定位，分别处理可见必需工作和预取。已有字形路径命中和相机复用应保留；无需再创建第二个 GPU owner。最终精修的 0.5–0.7 秒仍是独立未完成项。

参考父目录 Figma 交互资料时，只借鉴明确的容器缓存、交互快照和失效边界；该资料也标明了已验证与推断。本报告的根因与候选结论均来自本项目源码、实际回放及采样，不从 Figma 函数名或固定常数推导性能结论。

## 证据与未通过项

- `main-2/`：默认路径初次诊断；初版等待完成的方法较宽，其低倍 `readyMs` 不用于确认结论。
- `child-profile/`：边界内、跨边界、移动期间保留父级对照及 CPU profile；采样时长不冒充无插桩延迟。
- `child-pixels/`：独立截图回放；不与无截图的延迟样本混合。保留首次受吸附辅助线影响的比较，另有内部字形 patch 与静止兄弟的像素证明。
- `navigation-selected/`、`navigation-unselected/`：默认场景与取消选择对照。
- `navigation-backpressure/`、`navigation-backpressure-confirm/`、`navigation-default-confirm/`：单开关候选、确认和反向默认对照。
- `main/` 是测试启动时过早 reload 的失败记录；不是渲染器回归。
- 完整 G2/G5、所有子层/组件/遮罩、其他 FIG、HDR/导出全矩阵和物理显示延迟未在本轮关闭。100 ms 最终精修目标明确未通过。
- 生产源码前置和结束核对、产物及证据 hash 见 `source-baseline.json`、`manifest.json`。隔离构建目录不应当作发布包覆盖用户安装。

复现示例：

```sh
QA_MODE=profile node testing/investigation-fig-pan-drag-20261031/run.mjs /absolute/source.fig /absolute/fresh-profile-output
QA_MODE=nav QA_NAV_SELECTION=root node testing/investigation-fig-pan-drag-20261031/run.mjs /absolute/source.fig /absolute/fresh-navigation-output
node testing/investigation-fig-pan-drag-20261031/build-candidate.mjs /absolute/fresh-products VITE_DESIGN_RASTER_BACKPRESSURE
QA_MODE=nav QA_PRODUCTS=/absolute/fresh-products node testing/investigation-fig-pan-drag-20261031/run.mjs /absolute/source.fig /absolute/fresh-candidate-output
```

脚本使用 Node 24.12.0、已存在且生产源码相符的桌面产物。每次输出必须是新目录。`run-*.mjs` 保存各已测版本，report 绑定脚本 hash。Worker 原型包装仅记录提交/回复和完成回调，没有替换绘制、源数据或承诺完成的工作。
