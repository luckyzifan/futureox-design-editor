# 局部补丁与大文件重复准备复核 · 2026-11-05

本轮改了两处：普通编辑画布的局部属性补丁不再复制未改节点和 ID 表；已放置、已校验的原生文档写 mapped 快照时不再做第二次完整校验。没有增加跨视口缓存或调整 CPU/GPU 额度。以下区分代码路径、实际测量和后续建议。

## 原生 CPU 实测

Apple M2 Pro，同一份真实输入、字体、相机和桌面 NativePreparation Worker。每臂预热 3 次，按 6 组 ABBA 各取 12 个样本，单位 ms，见[预先约定的判据](protocol.md)和[全部样本与输入、构建哈希](measurements.json)。

| 完整载入文档上的局部操作 | 提交到脏区（旧 → 新，中位数） | 提交到帧包（旧 → 新，中位数） | 独立像素对照 |
| --- | ---: | ---: | ---: |
| 117.sketch，752 节点，椭圆 5×5 → 25×20 | 4.67 → 4.14（−11.4%） | 18.15 → 17.68（−2.6%） | 398 像素改变 |
| FIG，20,082 节点，深灰色板 opacity 1 → 0.25 | 64.68 → 32.83（−49.2%） | 66.40 → 34.34（−48.3%） | 3,072 像素改变 |

两种情况下正反脏区、改前/改后 64×48 RGBA 在两臂均相同；各自增量画面等于完整载入，逆补丁逐像素恢复原图。FIG 使用桌面实际导出的完整 authored JSON，原 FIG 哈希为 `701877664bf271305c8bc103c4036a228d7bd8816f1d98f18cdc332a75c36c46`；计时不包含导入。这里没有重测旋转松手到清晰、全屏精修、GPU 物理显示或六块重纹理的峰值。117 的到帧包收益也小于补丁本身。

## 实际改变了什么

- [编辑补丁](../../design-studio/crates/design-kernel/src/editing.rs)还需要同时持有 before/after，供校验和损伤计算使用。[节点表](../../design-studio/crates/design-kernel/src/scene/nodes.rs)在安装可编辑文档时把有序 ID 固定为槽号，载荷存入按写复制的持久向量。修改一个现有属性，只替换那个节点和向量树上的路径；键表、其它节点及旧 worker 的画面仍有效。没有保存一串须回溯的补丁，也没有按节点哈希猜测相等。图片变化时只读查找已有的 URI 所有者，只改补丁节点；没有图片变化时不扫全表归并图片。局部布局也是先选中根下的节点，再取得可写引用。
- 导入及只读 projection 仍可直接使用普通有序表；真正增删 ID 时回到普通表，成功安装后再固定新拓扑。文档元数据仍按原模型复制。节点索引和载荷引用有常驻开销，不能从“复制减少”推导出峰值内存降低。局部校验仍检查整个图和跨节点引用；通用补丁仍完整校验并测量 JSON 字节，故补丁总时间不是常数。
- [快照放置](../../design-studio/crates/design-desktop-backend/src/large_document/canvas_snapshot.rs)把最终文档交给内核的 [ValidatedSource](../../design-studio/crates/design-kernel/src/scene_store.rs)。它拥有文档，只能只读使用；要取回可写文档，必须消耗回执。普通放置、索引期间提前打开素材、磁盘已满后的重试都沿用该对象。外部原始文档写 mapped 文件、迁移后从复制的前缀重建目录仍独立校验。公开格式和哈希不变。
- 单独启用 mapped 时，基线的 [目录读取](../../design-studio/crates/design-kernel/src/scene_store/archive.rs)包含手写的 `unsafe`，与 crate 的 `forbid(unsafe_code)` 冲突。现在由现有的自引用容器持有只读匿名映射和经 rkyv 检查的引用。每次查表沿用同一个已检查的引用；没有重复验证、放宽检查或改变启用条件。

## 七条路径的判断

| 路径 | 当前行为及建议 |
| --- | --- |
| 1. 局部属性/旋转 | 上面的修改消除了确认的节点复制。通过位姿证明的叶子旋转在补丁之前就能返回，不能把历史 209.7 ms 全部归给这次改动。要解释剩下的整机延迟，应分别测 TS 校验、原生提交、编包、GPU 完成及最终视口交接。 |
| 2. mapped projection | [LazyRuntime](../../design-studio/crates/design-kernel/src/source_compile/lazy.rs)在单元集合变化时重建 compiler、properties 和 MarginIndex；选择集合相同已有复用。[read_demand](../../design-studio/crates/design-kernel/src/scene_store.rs)前后清的是记录层的图片引用/矢量几何表，这证明重叠记录会重新认证和解析，并不能证明每次都重新做 PNG 像素解码或 GPU 上传。当前[桌面构建](../../frontend/design-desktop/scripts/build.mjs)需要显式 mapped feature，写入还需要选 mapped 格式；默认 legacy 的秒级精修不能直接归因于这条路径。先用真实 A→相邻 B→A 记录实际 mode、交集、nodeReads/nodeBytes、解析/布局时间和驻留字节。若命中，再按打开的已认证源、generation、ID 和记录哈希复用不可变记录；按实际持有的载荷、键、索引共计字节，从现有 64 MiB 共享额度扣除，逐出、取消、换 revision 后不能复活旧结果。同一记录哈希不证明相同的祖先布局、字体、组件或设备采样相位：prepared geometry 应单独按这些依赖准入。 |
| 3. 普通 CPU 分块 | [linear_rect_pixels](../../design-studio/crates/design-kernel/src/renderer.rs)每个需光栅化的块都做分析。[backdrop_padding](../../design-studio/crates/design-kernel/src/export.rs)的累加取决于与当前块扩张区域相交的效果；zoom blur 有自己的源域，不能全页只算一个最终 padding。建议先在单帧内共享只读的场景 halo 和按绘制顺序排列的 backdrop 候选、世界几何，再逐块求交、裁剪和绘制。设备空间的准备结果还要绑定页、revision、精确相机、采样模式/导出密度和有效 guard。这应是默认构建下一项可独立测的优化：固定 1/4/16 块，统计遍历次数、准备时间和峰值驻留；逐通道对照跨块模糊、蒙版、缩放模糊和 HDR 导出。 |
| 4. 转换与最终快照 | [window_cache::convert](../../design-studio/crates/design-desktop-backend/src/large_document/window_cache.rs)的命中仍读完整转换文档，但 build_inner 仅在单素材分支用它；这个分支并没有多批合并。多素材走独立的批转换/归并。RecentMaterials 已经复用最终描述符（最多 8 份、64 MiB **磁盘文件**）。转换文件还没有最终 stage 坐标、依赖闭包或展示用元数据，不能直接顶替最终快照。建议先统计最终描述符失效/驱逐原因和重写字节，再在同一 owner、revision、素材集合、放置/呈现策略与存储格式下复用已写的最终描述符。 |
| 5. mapped 写入校验 | 已处理。回执绑定实际文档；磁盘索引、记录哈希、路径发布、取消及损坏拒绝均保留。 |
| 6. 历史帧往返 | [commitOps](../../frontend/design-client/src/kernel/graph-history-state.ts)仅在非空且能表示为 op 的批次上执行这次往返。可在 Rust 新增单次提交，内部复用相同 codec、revision、事务和权限检查，返回 frameBytes 及提交回执；需要传输时才把帧交给 JS。不要跳过 typed Node 的默认值归一化，保持拒绝原子性、只读、来源和 undo 语义。先分别测 transform 与携带完整子树的 insert/remove。 |
| 7. GPU 场景统计 | [WebGPU prepareScene](../../frontend/design-client/src/kernel/gpu/webgpu.ts)仍分别收集 paths/effects 和 [合成模式](../../frontend/design-client/src/kernel/gpu/compositor-modes.ts)。可用一次节点遍历生成本次 prepare 使用的摘要，保留 WebGL 及独立 driver 入口。gradient-fusion 的上游结果已经传入，无需重做。单独测 prepare CPU 时间，不能用少一次扫描推算密集区域 GPU 精修时间。 |

这里没有重新打开 mip 缓存、RetainedPose、DamageContext、RenderIndex 或 gradient-fusion 的旧问题。[导航](../../testing/verification-navigation-reuse-20261104/README.md)、[密集精修](../../testing/verification-dense-refinement-20261104/README.md)和 [FIG 松手到清晰](../../testing/verification-fig-viewport-20261104/README.md)的历史数据沿用各自环境和计时定义。

## 验证记录

启用 mapped feature 后，Rust 内核库 875 项通过、10 项由套件忽略，桌面后端库 113 项通过、12 项由套件忽略。显式选择 mapped 文件格式后，单画板、材料选择和驱逐后重访的三项生产入口回归均通过。内核、桌面后端和 GPU crate 的全 feature、全 target 编译检查通过。

Release portable WASM 在相同的 117 与 FIG 文档上完成正向补丁、逆补丁和重新载入。两例的脏区与改前、改后像素哈希都匹配原生对照。可用 [WASM 复验脚本](check-wasm.mjs) 和 [原生对照脚本](compare.mjs) 重放。
