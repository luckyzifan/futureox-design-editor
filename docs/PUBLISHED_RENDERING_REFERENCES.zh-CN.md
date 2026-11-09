# Figma / Sketch 公开渲染资料与本项目性能适用性

核查日期：2026-10-19（UTC）。代码参照：`71d32153e6f55b3723c99708b4c4c49ac7342e67` 加当前工作区增量。本文只使用厂商公开页面和本仓库源码；未取得、推断或复现闭源实现。源码入口以符号为准，后续增量可能改变行号。

## 结论

当前最值得采用的是减少重复准备、重复遍历、无效分配和提交开销，并保留已接受的渲染输出。公开材料支持这些方向，但不能证明本项目必然提速，也不能证明两个产品内部算法相同。本仓库已具备瓦片、场景缓存、字体轮廓缓存、uniform 批量提交和 bindGroup 缓存等基础，不应为“跟随厂商”重复重写。

优先级建议：先做可由 CPU 完整对照证明的局部快路；随后依据 profile 扩展精确失效与派生数据复用；涉及 shader、离屏合成、采样或 GPU 调度语义的改动，必须另有真实设备像素与时延验收。

## 公开事实与适用边界

下表日期是页面标注的发布日期；所有链接均在上述核查日期重新读取。“已公开”只表示该文章当时描述的实现，不自动代表 2026 年全部平台的现状。

| 编号、来源及发布日期 | 可确认的公开事实 | 不应据此声称 |
| --- | --- | --- |
| F1：[Building a professional design tool on the web](https://www.figma.com/blog/building-a-professional-design-tool-on-the-web/)，2015-12-07 | 自研 WebGL、tile-based renderer、自有合成与文字布局；支持遮罩、模糊、混合及嵌套透明度。 | 文章没有给出瓦片尺寸、空间索引类型、裁剪算法、LOD 阈值或字体栅格化算法。历史浏览器限制不能当成今日限制。 |
| F2：[WebAssembly cut Figma's load time by 3x](https://www.figma.com/blog/webassembly-cut-figmas-load-time-by-3x/)，2017-06-08 | C++ 从 asm.js 迁移到 Wasm；文中加载指标包含初始化、下载文件及首次渲染。 | “3×”是当年加载比较，不能套用到 Rust/Wasm、持续帧率或本项目。 |
| F3：[Keeping Figma fast](https://www.figma.com/blog/keeping-figma-fast/)，2023-08-29 | 通过 CPU/GPU profile 和真实设备比较；渲染时间切片优先本地交互。用虚拟机回归门禁与真实硬件测试互补。 | 不保证每种硬件都受益；CPU 指令数、平均值和虚拟机结果不能替代 GPU 与尾延迟。 |
| F4：[Improving performance with incremental frame loading](https://www.figma.com/blog/incremental-frame-loading/)，2024-01-23 | 原型播放器按需加载；该流程依赖主线程状态，不能直接移入 worker，需拆分工作以保持导航响应。 | 不是“整个 Figma 单线程”，也不是无条件启用更多 worker 就能提速。 |
| F5：[Speeding up file load times, one page at a time](https://www.figma.com/blog/speeding-up-file-load-times-one-page-at-a-time/)，2024-05-22 | 按页加载要追踪跨页读写依赖；样式变化会触发文字布局派生缓存更新；服务器文件解码可并行。 | 服务器解码并行不等于客户端渲染并行。不能只看可见节点而漏掉组件、样式、自动布局依赖。 |
| F6：[Figma rendering: Powered by WebGPU](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)，2025-09-18 | 显式 draw 参数、跨 draw 批量 uniform 上传、bindGroup 复用、renderPass 合批；C++ 同时编译 Wasm 与原生。实现运行中 WebGPU→WebGL 回退。 | 单换 API 不保证加速。compute blur、MSAA 和 RenderBundles 在该文结尾是未来方向，不能当成已落地算法。 |
| F7：[Improving performance in the layers panel](https://www.figma.com/blog/improving-performance-in-the-layers-panel/)，2026-06-11 | 先计算行 ID 顺序，再仅计算可见行详情；依赖驱动的惰性派生缓存；rope 式结构共享避免深树重复保存后代列表。 | 文中部分大文件交互 30–50% 改善不是全编辑器普遍收益，更不是本项目的预计数字。 |
| S1：[Why we’re proud to build a truly native Mac app](https://www.sketch.com/blog/part-of-your-world-why-we-re-proud-to-build-a-truly-native-mac-app/)，2020-10-26 | 明确提到使用 Metal、Swift 对渲染、性能、内存的帮助。 | 未公开 Metal pass、shader、瓦片组织或同步算法；不能据此给出所谓“Sketch Metal 内核实现”。 |
| S2：[How we made the Mac app faster with improved rendering](https://www.sketch.com/blog/tech-talk-how-we-made-the-mac-app-faster-with-improved-rendering/)，2021-12-23 | 图层树转 CoreGraphics primitives 的子系统改用 Swift；增加渲染树预判复杂合成，跳过可证明多余的离屏位图。 | 收益统计仅覆盖图结构转命令阶段，作者明确拒绝称整体“最高 3×”。组透明度不能普遍下推给重叠子图层。 |
| S3：[A deep dive into our Canvas tech](https://www.sketch.com/blog/canvas-tech/)，2023-02-23 | Sketch 95 增量更新场景图；图表示与缩放无关。Web 端消费预生成场景图，以 C++/Wasm/Skia 和 WebGL 渲染；交互时调度让步并缓存画布内容。 | 具体缓存键、淘汰、时间片长度和多线程实现未披露；该 Web 浏览流程不是完整 Mac 编辑器实现。 |

## 本仓库适用性矩阵

以下是基于源码的工程判断，**不是厂商公开实现的复述**。这里的“已有”仅指源码存在，不代表当前平台或所有场景已通过验收。

路径简称：`C = frontend/design-client/src`，`K = design-studio/crates/design-kernel/src`。

| 方向 / 优先级 | 本仓库入口及现状 | 可采用的下一步与必要证明 | 主要风险 |
| --- | --- | --- | --- |
| 去掉合成规划中的无效工作 / P0 | `C/kernel/gpu/composite-draw-plan.ts`：`compositeDrawPlan` 对已覆盖矩形逐项执行 subtraction；`compositeRasterQuad` 决定实际像素归属。 | 对严格不相交的输入保留原 fragment，减少临时数组/flatMap。完整比较每个 draw 的顺序、item、placement、clip、UV 与物理像素矩形；稀疏、密集、混合透明及多密度都测。对应 S2 的“证明不需要后再跳过”原则，具体算法为本项目自有。 | 不得把 blend 层当遮挡；不得改 fragment 顺序、gutter、取整或 epsilon。稠密重叠可能没有收益，必须单列。 |
| 增量场景准备 / P0 | `K/gpu.rs`：`CameraPrepare::translated`、`ProgramCache::retain_nodes`；`K/geometry_snapshot.rs`：`prepare_node_geometry`。已有脏节点、祖先与共享准备结果。 | 对照新建 Engine 的完整 packet 与 CPU RGBA；记录局部失效、重新准备、序列化各阶段。借鉴 S3/F5 的依赖完整性，不重复实现整棵场景树。 | 漏祖先/字体/布局依赖；共享读者与写时复制；失败准备误入缓存；缓存命中掩盖未更新内容。 |
| 同次操作共享派生索引 / P0–P1 | `C/kernel/interaction-scene-bounds.ts`：`interactionRootBounds` 已一次遍历分组；`C/engine.ts` 有 pick context；`C/kernel/gpu/scene-index.ts` 有不可变场景索引。 | 保留合并顺序和浮点运算，记录扫描数量及普通数据计时；仅在同一不可变版本内复用。对应 F7 的减少派生计算方向。 | 可变草稿跨版本复用索引导致陈旧父关系；根节点/祖先重叠时成员重复或遗漏。 |
| 图层面板细粒度缓存 / P1，先 profile | `C/Layers.tsx` 已分离 `layerTreeRows` 与可见行窗口；`C/layer-tree.ts` 仍在 doc/折叠/搜索变化时构建行序列。 | F7 的两阶段思想已经部分具备。若 profile 证实 ID 阶段成为瓶颈，再做子树派生缓存或结构共享；先测深链与宽树、搜索、展开、重排、撤销。 | 不应仅因官方文章而重写；直接在每层缓存所有后代可能 O(n²)；搜索及 reveal 必须同步失效。 |
| uniform 与 GPU 描述符复用 / 已有，P1 | `C/kernel/gpu/webgpu.ts`：`uniform`、`submitCommands`；`binding-cache.ts`：`GpuBindingCache`；`resident-uniforms.ts`：`ResidentUniforms`。已有批量 buffer 与 bounded descriptor 缓存。 | F6 可作为架构依据。先测 writeBuffer 字节、groupCreates/groupHits、pass 数及提交 CPU 时间，确认残余热点；任何扩展保留 buffer identity、offset 和 device 生命周期。 | 缓存键遗漏资源或 offset；设备丢失后复用旧对象；跨 pass 重排破坏读写依赖。CPU mock 不证明真实 GPU 改善。 |
| 离屏合成快路 / P1–P2 | `C/kernel/gpu/neutral-group.ts`：`disjointNeutralGroup`，已有严格条件；`renderer.ts` 执行合成。 | S2 支持预判是否需要中间 surface。只扩展能证明像素等价的子集，先保存隔离/未隔离命令及像素基准。 | 组 alpha、重叠子项、背景模糊、mask、色彩空间和中间舍入都可能改变结果；需要真实 GPU 对照。 |
| 保守裁剪与瓦片复用 / 已有，P1 | `K/geometry_snapshot.rs` 有带效果 halo 的 guard 与中性裁剪 frame 分支；`C/kernel/tile-cache.ts`、`tile-computation-key.ts`、`gpu/tile-compositor.ts`。 | F1 只证明 tile-based 架构，不能指定本项目裁剪算法。优化前完整比较 guard、effect/stroke bounds、采样相位、可见集合及覆盖；边缘阴影/背景依赖必须纳入。 | 用几何 bbox 代替效果范围、错误相位复用、漏底图依赖均会丢像素。不能降低采样密度换性能。 |
| 文字布局/轮廓缓存 / 已有，P1 | `K/font.rs`：`Fonts::node_path_shared`；`K/text_path_cache.rs`：预算内的精确输入键及 Arc 轮廓。 | F5 支持按完整依赖重用布局结果。比较冷/热 shaping、命中率、键构造成本与字体资源更换后的输出；覆盖宽度、runs、字距/换行/路径文字变化。 | 本地轮廓与设备采样不能混用；字体更换、量化策略和缺字回退不能漏入失效条件。未找到可据以宣称 Figma 使用特定 SDF/MSDF 的上述官方资料。 |
| 交互优先调度 / 已有，P1 | `C/kernel/render-work-queue.ts`：`RenderWorkQueue`；`render-mailbox.ts`：`RenderMailbox`；`engine.ts`：coalesced view。 | F3/F4/S3 支持以响应性为目标拆分工作。测最终输入到最终正确画面、队列深度、取消/失败、快速连续导航；只在已完成 tile/frame 边界让步。 | 渲染 encoder 内让步、饿死 refinement、发布旧 session/revision、只加更多并行而争用内存。不能用受控 120 Hz 输入测试宣称 120 FPS。 |

## 证据门槛

1. **等价先行。** 固定优化前实现作独立 oracle，不让 oracle 调用新快路。测试有效负例：故意破坏某条边界/顺序/失效规则时必须失败。对于不相交快路，证明结果列表与像素投影完全相同，比只比较绘制数量更有力。
2. **测试真实变化。** 新旧文档、相机与画面确实不同；缓存测试必须证明结果更新，同时证明未变化部分复用。包含取消、撤销/重做、换页/换文档和失败重试。
3. **计时分层。** 分开准备、规划、发布、IPC/序列化与实际 GPU。报告输入规模、冷/热、样本数、中位数与尾部，并保留稀疏/密集/失败场景。交错 A/B 或 ABBA，说明共享主机干扰；工作量计数与计时独立。
4. **不偷换收益。** 某函数缩短 90% 不等于整体 10×；CPU RGBA/packet 一致不等于 WebGPU/WebGL 全平台像素验收。没有真实设备证据时只报告 CPU 阶段结果。
5. **性能预算保持。** 监测缓存上限、淘汰、surface 峰值和资源生命周期。不得用降分辨率、丢弃可见内容、改变颜色/模糊或悄然跳过错误来“达标”。

可复用的仓库验证入口（列出不代表本文已运行）：

- `C/kernel/gpu/composite-draw-plan.test.ts`：遮挡、透明底图、分数像素归属与采样变换。
- `C/kernel/interaction-scene-bounds.test.ts`：冻结旧实现、精确浮点与 CPU/Wasm 对照。
- `design-studio/crates/design-kernel/tests/prepare_invalidation_equivalence.rs`：重复父子变换对照全新 Engine 的 packet 和 CPU 像素。
- `C/kernel/gpu/binding-cache.test.ts`、`resident-uniforms.test.ts`、`neutral-group.test.ts`：资源键、变更范围及合成前置条件。
- `C/kernel/render-work-queue.test.ts`、`render-mailbox.test.ts`：所有权与过时任务处理。

## 未公开信息和现有归因的核对边界

- 本次找到 Sketch 对 Metal 的明确提及，以及 CoreGraphics 命令准备、scene graph、Skia/Wasm/WebGL 的公开说明；**未找到其完整原生 Metal 渲染管线、shader、tile 尺寸/LOD 阈值、空间索引、字体 atlas 或内部调度算法的官方披露**。这是本次检索边界，不是证明资料绝不存在。
- Figma 早期 tile-based 描述不能证明某个具体四倍降采样、四叉树、SDF/MSDF、tile 尺寸或剔除结构。2025 文中未来功能也不能自动视为 2026 已部署；需要另外的发布证据。
- 本文未改产品源码、未做 Figma/Sketch 账户操作、未执行 GPU、浏览器或 socket 测试；只验证资料出处、日期及源码入口。实现与跑分应以对应增量的独立验收记录为准。
