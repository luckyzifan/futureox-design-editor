# 从 Wonder 可迁移的优化：源码复核后的优先级

2026-10-28。沿用 [机制分析](./REPORT.zh-CN.md) 所列 Wonder 发布包；进一步读取当前 Futureox 工作树。本轮是静态路径分析，没有修改渲染实现，也没有实测速率提升。

## 最值得做的两项

### A. 全源画布接入已有的小批量准备流水线

**可见缺口：** `NativeSourceSurface.tsx` 每次只取一个 missing tile，传 `tileViewport:[tile]`，await 完成后再发下一块。下游 `render-worker.ts` 已有 PrepareAhead，但只有同一 tileViewport 存在 next tile、native backend 可以并行准备、开关允许且下一块未命中缓存时，才启动下一块 CPU 编译与当前 GPU 工作重叠。单瓦片请求不能使用这一跨瓦片流水线。

**与 Wonder 的联系：** Wonder 对恢复可见的对象分批推进；可借鉴“有限工作批次”的组织方式。Futureox 的 CPU/GPU overlap 则是自身已有能力，不应声称来自 Wonder 的算法。

**具体候选：** 先用两块相邻、同相机/同源版本的可见缺失瓦片形成一个批次，保持逐块回调和立即呈现。继续使用现有统一 prepareViewport、取消、owner/receipt 和资源生命周期；交互到来时允许在既有安全边界让出。不要一次提交整屏或任意扩大并发。

**预期作用：** 在 CPU 编译与 GPU 工作都占显著时间的视口减少暴露的准备等待；若 GPU 已经完全主导，收益可能很小。不能承诺首个冷瓦片更快，也不能据此宣称滤镜跨瓦片复用已启用——它还有独立的 intent、profile、采样和策略门槛。

**验证重点：** overlappedPreparations、prepare-wait、首次可用瓦片、最后输入至全视口清晰、取消后无用工作量、峰值资源。与单块基线配对；快速反向缩放下若取消成本或首像素时间变差就拒绝候选。

### B. 在几何展开之前筛出无关子树

**Wonder 证据：** 公开 Renderer 有包围盒树、dirty-root 更新和视口查询；text-caret 包按可见集合裁剪根并分批恢复。

**Futureox 现状：** `RenderIndex` 维护父子关系与 connector 信息，不是这里所需的光学包围盒空间索引。`geometry_snapshot::prepare_node_geometry` 已有缓存、叶节点裁剪和中性裁切 frame 的早退。但普通未缓存分组仍会递归；文本路径的建立可发生在叶子离屏判断之前。新相机需要新的设备空间准备时，世界空间的保守支持范围有机会更早排除整棵子树。

**特别约束：** 全源 snapshot 将所有素材放入一个 `clip=false`、`pass-through` 的 stage。只索引 page.children 会得到一个大根，无法筛选其中的素材。应选择可证明安全、彼此不重叠归属的子树边界，并保留原绘制顺序。

**具体候选：** Rust 按源/布局/字体/效果版本维护保守子树支持范围，先查询视口及其采样依赖范围，再准备必要子树。编辑只更新受影响的子树与祖先。空间树只用于排除不可能贡献像素的节点，不能改变文档和保存语义。

**正确性边界：** canvasLayout 的布局提示不能直接当作光学边界。阴影、描边、模糊、跨节点蒙版、背景读取与 zoom-dependent 支持必须计入；证明缺失时回到现有路径。索引必须先建立，首次全量建立仍有成本。全览全部对象都可见时，不会凭空消除全部绘制工作。

**预期作用：** 对大源文件中放大查看少量素材、反复平移和局部编辑，潜在收益最大；它主要减少准备/遍历，不直接解决可见重效果的所有 GPU 成本。

**验证重点：** 新相机下 authored/prepared 节点访问、文本 shaping、flatten 数量、compile 时间及总收敛时间；同时与完整重绘比对像素，覆盖边界外阴影、跨根背景读取、蒙版和结构变更。

## 后续候选

| 候选 | 当前证据和应做的增量 | 主要收益与限制 |
| --- | --- | --- |
| 复用已有成本调度 | `NavigationCost` 已按覆盖层级、历史请求耗时和 aging 选块。全源 surface 当前取中心排序后的 missing[0]，未接入该选择器。可用已测成本避开同一层级中极慢任务，同时保证复杂块不饿死。 | 更早获得较多可用清晰内容；不保证全屏总耗时降低。冷场景没有历史成本时应保留现有顺序。 |
| 全源视口的预取与保留缓冲 | `ProgressiveSurface` 已使用 `planTilesWithPrefetchRim`；全源 surface 只调用 `planTilesAligned`。可在可见任务完成、资源空闲时接入有界边缘预取，方向改变及时取消。 | 已访问区域附近平移更快；复杂冷全览先预取会争抢资源，不能提高其优先级。 |
| 无变化时跳过规划和提交 | Wonder 比较相机、DPR、节点和选择版本后早退。全源 surface 的 plan 在 run/paint/ACK 等路径多次构造，paint 会筛选、排序并提交。可先缓存相同输入的瓦片计划，再按当前有效纹理身份和相机判断是否需要重新提交。 | 减少主线程规划/垃圾分配和冗余合成；不能提前确认尚未呈现的画面，也不是复杂滤镜的主要加速。 |
| 补齐全源后台暂停 | 普通 ProgressiveSurface 已根据 visibility 暂停预览；NativeSourceSurface 的 async run 没有同样的显式门。可暂停不可见窗口的可选精修，恢复时只处理最新视口。 | 多窗口减少 CPU/GPU 竞争和功耗；不能暂停保存、导出、已接受编辑，也不能取消后继续循环重启旧任务。 |
| 世界空间与相机相关缓存继续拆分 | 已有 LocalPaths、ResidentStrokes、CameraPrepare、ProgramCache、FragmentCache，不能重写一套同名缓存。应 profile 新相机到底重建了哪些内容，只把可证明与相机无关的几何和依赖保留下来。 | 大幅架构优化候选；不是简单移除 key 中的 zoom，相位相关覆盖程序必须重新计算或精确命中。 |

## 已有或不宜作为首轮目标的部分

- **中心优先：已实现。** `planTilesAligned` 按距视口中心排序；missing[0] 不是随意取第一块。后续应补成本/交互优先，而非重复中心排序。
- **图片分级：已有真实实现。** 文件名 image-mip-cache 对应 level-0 持久解码缓存；实际 mip 选择在 GpuRenderer.imageLevel，调用 Rust image_mip_level，并由渲染策略决定是否启用。应优化已有解码、上传、级别切换，不直接替换成 Wonder 的浏览器缩小图或把策略默认打开。
- **事件合并、编码让出：已有。** EncodeYield 约每 4ms 检查并让出 CPU 编码，渲染队列在瓦片完成后可执行更高优先级任务。让出 CPU 与让新对象像素完成不同；不能说项目完全没有时间片。
- **浮动原点：主要是大坐标稳定性。** Wonder 的实现值得参考，但你已有世界瓦片/局部相机处理。先证明实际远坐标抖动或过大的采样字段，再扩大改动，不能预告它必然加快普通缩放。
- **整套 DOM/Pixi 替换：不属于局部优化。** 会改变独立图形、文字、色彩和导出边界。这里建议借鉴任务组织、驻留与失效机制，保留 Rust 权威语义。
- **直接复制发布 bundle：不适合作为接入方案。** 当前拿到的是压缩发布模块，绑定内部节点模型、样式、事件和模块依赖；可迁移的是已观察到的设计机制，具体实现应接入现有代码。

## 建议执行顺序

第一轮先做 A 的两块小批量候选，连同新输入取消和无用工作统计；这是现有上下游之间明确可验证的接缝。第二轮实现 B 的保守支持索引，优先覆盖普通独立素材，复杂依赖保守回退。随后按 profile 决定成本调度、边缘预取和后台暂停的顺序。

首轮比较需要固定真实素材、构建、DPR、相机序列与精度配置，分别记录首次可见、运动中姿态跟随、最后输入至清晰、compile/graph/finish、峰值资源和像素一致。候选收益尚未实测，完整 G2/G5 与 HDR/export 状态不因这份分析改变。

源码入口：

- `frontend/design-client/src/kernel/NativeSourceSurface.tsx`：全源 run、plan、paint、wake。
- `frontend/design-client/src/kernel/render-worker.ts`：PrepareAhead、compileTile、逐块回调与优先级让出。
- `frontend/design-client/src/kernel/navigation-cost.ts`、`tile-plan-aligned.ts`：已有成本调度和预取。
- `design-studio/crates/design-kernel/src/geometry_snapshot.rs`、`render_index.rs`、`gpu.rs`：前置裁剪、拓扑与准备缓存。
- `design-studio/crates/design-desktop-backend/src/large_document/canvas_snapshot.rs`：单 stage 下的真实素材层级。

公开参考：[Renderer](https://app.wonder.so/assets/Renderer-CDnDYIHg.js)、[transform/culling](https://app.wonder.so/assets/text-caret-DmucM7y2.js)。本轮沿用上轮已下载并记录 hash 的内容，未声称它们在未来部署仍保持相同实现。
