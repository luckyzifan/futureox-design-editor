# VectorCraft 与 Futureox：代码复用及性能对照

日期：2026-10-23。目标：让 Futureox 更适合制作与交付游戏 2D UI 素材。

## 范围与证据

- Futureox 基线：`518d8ddad6bf7b3865035f1c89ad6548befd4a2d`；开始分析时工作区干净。
- VectorCraft 基线：[`445550ea29c2332bd9f40269ea89a547bc7b3d50`](https://github.com/storytold/vectorcraft/commit/445550ea29c2332bd9f40269ea89a547bc7b3d50)。以下远程源码链接均固定到该版本。
- 对照了文档/节点模型、编辑事务、历史、后台渲染、几何与效果缓存、图像缓存、变形、笔刷、形状混合、描摹、素材导出及相关测试入口。
- 这是静态代码分析和现有证据复核。本次没有构建、运行两款应用，也没有执行性能 A/B；源码与测试文件的存在不代表整机验收通过。
- 复杂源文件采用相关生产路径的定向阅读，不是全部仓库逐行审计。
- 本次只新增本报告，没有移植代码、修改渲染设置或启用实验开关。

## 核心结论

1. 最值得先借鉴的是素材收集和多规格导出的产品流程、缓存避免抖动的策略，以及保持未修改数据身份的工程方法。
2. 最适合提取算法的是基础 Warp 点映射、单应变换、九宫格/注册点参数处理；完整工作流仍需接入自己的模型、历史、导出和 UI。
3. 游戏素材功能顺序建议：素材批量交付 → 九宫格和状态清单 → 发光 → 基础变形 → 按美术风格补笔刷/描摹。
4. 性能首要问题是现有增量架构的覆盖范围和端到端效果，不能简化为“还没有 Arc、缓存或 Worker”。
5. 不建议整套替换渲染器、历史系统、文档模型或布尔算法。两边的功能语义、精度和宿主条件不同，缺少同机证据支持整体替换。

## 一、架构与适配成本

| 维度 | VectorCraft | Futureox | 对移植的影响 |
|---|---|---|---|
| 文档结构 | 层级 `Vec<Arc<Node>>`，节点 ID 为 u64，部分大字段通过 `Shared<T>` 写时复制 | TS 平铺节点表与页面引用；Rust 文档、Graph 和渲染派生结构各有职责 | 不能直接替换节点；需映射 ID、层级、单位、资源与样式 |
| 路径 | `PathData/SubPath/Anchor`，节点含入/出控制柄，基于 kurbo | `Network` 顶点/边与独立控制点，允许矢量网络和 filledFaces；内核再生成 Path | 多分支网络不能直接映射成一条简单路径；需先限定支持子集 |
| 编辑 | Rust `Session::edit`；命令更新共享文档，做派生刷新并记录历史 | UI/MCP → 隔离草稿 → `Editor.change` → Rust/WASM 验证/布局与历史 | 保持一个权威提交入口；不要引入另一套 Session/undo |
| 渲染 | 原生后台 CPU 多线程 vello_cpu 光栅化，GPU 合成；浏览器构建无同样的原生渲染线程 | Rust/WASM 准备、WebGPU/原生 GPU 路径、CPU 精确导出、瓦片与交互通道 | 不能因为都用 Rust 就替换 renderer；字体、效果、颜色与输出会变化 |
| 布局 | 插画对象、画板、符号、外观栈 | 自动布局、组件覆盖、变量模式、约束与原型 | VectorCraft 的局部更新判定不能覆盖 Futureox 的布局依赖 |
| 扩展 | WASM 对象过滤器、实时效果、导出器；UI egui | 受信任操作注册表、MCP、React/Electron | egui 面板不能直接复用；操作也不能绕过现有权限与版本检查 |

证据：[VC 文档](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/doc/src/lib.rs#L748)、[节点](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/doc/src/node.rs#L442)、[Shared](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/doc/src/shared.rs#L7)、[编辑入口](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/engine/src/lib.rs#L1810)、[渲染依赖](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/render/Cargo.toml)；本项目 [model](../../frontend/design-client/src/model.ts)、[Editor](../../frontend/design-client/src/engine.ts)、[开发契约](../DEVELOPMENT_CONTRACT_V1.md)。

## 二、可移植功能与优先级

成本是相对工程范围，不是工时承诺。低：纯算法/数据辅助；中：跨模型、操作和界面；高：跨几何、渲染、历史及多格式导出。

| 功能 | 可复用部分 | Futureox 现状与剩余工作 | 优先级 / 成本 |
|---|---|---|---|
| 素材收集、批量导出 | `ExportAsset` 引用源节点；尺寸规则、命名、目录、规格预设、ZIP 输出流程 | 已有图层/切片/倍率导出；缺统一资产列表和多目标任务规划 | P0 / 中 |
| 九宫格、注册点、游戏 manifest | 四边比例与注册点验证 | VC 自身仅提供九宫格交付元数据；两边都需要游戏预览和引擎适配 | P1 / 辅助代码低，闭环中 |
| 内/外发光 | 基于轮廓 alpha 的模糊、反相轮廓与裁切思路 | 已有阴影/模糊/蒙版，可扩展自己的效果模型；不能搬入其 vello 图像路径 | P1 / 中 |
| 基础 Warp 与透视 | `warp_point`、Homography、Coons 思路和参数设计 | 需限定路径子集、误差预算、原生生成路径、拾取与导出一致性 | P1 / 中到高 |
| 艺术/图案笔刷 | 侧边、内外角、起终点笔刷片段，着色模式与拼接策略 | 当前散布保留曲线，Stretch 限直线；多色源与弯曲需要新模型 | P2 / 高 |
| 图像描摹 | `trace` 的量化、轮廓、拟合模块；依赖比 effects 更少 | 适合导入图标/装饰草图；需明确近似、节点上限和保留原图 | P2 / 中到高 |
| 空间形状混合 Blend | 路径起点对齐、段数适配、颜色/描边插值 | 现有动画与 Repeat 不等于空间 Blend；需限制生成量与拓扑 | P2 / 高 |
| 渐变网格/自由渐变 | 网格数据、Coons 求值、采样与编辑交互设计 | 需新增原生绘制、GPU/CPU、色彩、拾取与 SVG/PDF 回退契约 | P3 / 高 |
| 更广文件格式、WASM 插件宿主 | 专用解析器/ABI 可研究 | 非游戏 UI 第一阻塞项；依赖和行为面广 | 暂缓 |
| 整套布尔、历史、渲染替换 | 可当另一套对照实现 | 当前已有完整闭环；没有证明整体替换收益 | 不建议直接替换 |

### 1. 素材收集与批量导出：第一项功能

VC 的 [assets.rs](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/doc/src/assets.rs#L1) 保存资产名和源节点引用，不复制一份素材；删除源节点后清理引用。[screens.rs](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/engine/src/cmd/fileio/screens.rs#L32) 支持倍率、指定宽高、PPI、规格行、命名、子目录以及多种来源。

Futureox 已有 [ExportSetting](../../frontend/design-client/src/model.ts)、[NodeExportPanel](../../frontend/design-client/src/NodeExportPanel.tsx)、[export](../../frontend/design-client/src/export.tsx)、[ExportOwner](../../frontend/design-client/src/export-ownership.ts)。应在这些能力上增加：

- 文档内受支持的资产定义：源节点/切片、稳定 ID、输出名称、用途与状态；跟随删除、复制、跨文档导入做 ID 重映射。
- 一个确定性的导出计划：先计算目标、像素总量、名称冲突和路径，再执行编码。
- 每项记录成功/失败/取消与源修订；不要把多文件写出包装成没有实现的跨文件原子事务。
- 可重用规格和目录模板、任务进度、明确的重新导出动作。
- 游戏 manifest：原始尺寸、实际尺寸、裁切偏移、九宫格边距、注册点、状态和资源路径。

直接提取命名和尺寸规则比复制 900 行导出函数更合理。VC 的函数依赖其 Session、文件写入、编码器和文档拆分。这里必须保留宿主目录授权、资源返回边界、导出快照身份和取消语义，不能将 VC 的任意路径参数直接暴露到本地 MCP。

验收：100 个资产 × 3 个倍率；同名、空素材、旋转切片、阴影边界、删除/撤销、导出中切页或切文档、部分写出失败、保存重开。必须核对文件清单和像素尺寸，不能只检查文件数量。

### 2. 九宫格：已有参数，不是现成功能

VC 的 [symbol_nine_slice.rs](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/doc/src/symbol_nine_slice.rs#L1) 明确是交付元数据，实例在画布中的放置方式不改变。[symbol_registration.rs](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/doc/src/symbol_registration.rs#L1) 可参考九点注册位置。

游戏适配需要新增：

- 可视化四条参考线与不同宽高的实时拉伸预览。
- 区分图形自然边界、含阴影的视觉边界和导出裁切矩形。
- 分数边距转换到目标倍率的像素规则；裁切后修正边距和注册点。
- 边距相交、裁切切掉边框等情形必须给出明确处理。
- Godot 等目标引擎的资源/导入适配，需要另做；源码中有九宫格字段不等于存在该适配。

会参与节点重映射或显示/导出的语义应建立受支持模型，不能随意塞入不透明 FD 扩展并期待导入自动修复 ID。

### 3. 发光：复用构造方法，沿用自己的合成器

VC 在 [fx.rs](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/render/src/fx.rs#L9) 用轮廓阴影形成外发光，用反相或正向轮廓模糊再裁切形成内发光。Futureox [Effect](../../frontend/design-client/src/model.ts) 已有 shadow、inner-shadow、blur 等，优先扩展这一套。

第一批只做内/外发光及预设。浮雕、斜面、复杂光照另立实现范围；不能把 glass.bevelSize 当成通用浮雕已经具备。

适配重点：alpha 与颜色空间、内外裁切、spread、混合模式、透明组、效果边界和采样 halo。CPU/GPU 与导出共同实现，不能仅在 React 预览上画一层 CSS。

### 4. Warp：数学可以借用，误差规则必须重写

可研究 [effects/warp.rs](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/effects/src/warp.rs#L1)、[warp_point](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/doc/src/live.rs#L390) 和 [Homography](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/geom/src/projective.rs#L11)。

重要限制：VC 的 [map_nonlinear_within](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/doc/src/live.rs#L494) 会将曲线分段、映射控制点；每段最多 64 片，超过总锚点预算会加长片段、降低近似精度。这不是任意非线性变形的精确曲线解。

建议从 Arc/Bulge/Flag 中少量类型开始，首版限定独立闭合路径，提供预览和明确烘焙。然后再建立非破坏性源路径+参数模型。开放/分支网络、填充面、路径文字、渐变与描边如何变形，要逐项规定。

用自己的误差与资源预算决定细分；无法达到承诺时明确拒绝或让用户选择近似模式。不能把“资源不足时悄悄粗化”带入现有精确导出契约。

### 5. 笔刷：有价值，但不是复制一个 crate

VC [PatternBrush](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/brush/src/lib.rs#L328) 有侧边片段、内角、外角、起点、终点，以及 Stretch/AddSpace/Approximate 三种适配。游戏卡牌边框、缝线和装饰线适合这一模型。

但其 [warp.rs](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/brush/src/warp.rs#L1) 会把轮廓展平成折线再弯曲，并丢弃该路径不支持的文本/图片/符号节点。Futureox [vector_brush.rs](../../design-studio/crates/design-kernel/src/vector_brush.rs) 则保留源 Bézier 命令，并对弧长做有界误差检查。

建议先增加多轮廓/多色源、笔刷着色和首尾片段，再增加转角拼接，最后做曲线 Stretch。保留当前精确散布行为，不用新实现覆盖旧语义。UI、文件格式、MCP schema、边界、拾取、显式 bake 都要同步。

### 6. 描摹：可作为相对独立的导入模块

[trace/Cargo.toml](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/trace/Cargo.toml) 只依赖自家 geom、kurbo、image、serde、thiserror，耦合小于 effects/brush。可以在临时边界中用其几何结构运行，输出再转换为本项目 Network，不让 VectorCraft Document 进入编辑器。

先做单色图标轮廓及可控拟合；彩色分区、渐变识别后续增加。它是有损重建，不能把“图片变矢量”描述为恢复原始设计。输入缩图和容差必须明确显示/记录。

## 三、性能值得借鉴什么

### A. 先减少增量更新前后的全量工作——P0

VC [Session::edit](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/engine/src/lib.rs#L1810) 在同一 Rust 模型中编辑，未改节点/字段保持共享，渲染器可以使用这些身份。但它也有派生刷新和校验，不能声称所有编辑都是 O(1)。

Futureox 已有：

- TS Immer 草稿和 [shareDocument/documentPatch](../../frontend/design-client/src/document-patch.ts)。
- Rust [NodeStore](../../design-studio/crates/design-kernel/src/snapshot.rs) 的持久化映射、Arc 节点与有界历史。
- 渲染器 [SharedDocument](../../design-studio/crates/design-kernel/src/renderer.rs)。
- [op-sync](../../frontend/design-client/src/kernel/op-sync.ts) 的增量操作，以及原生 [SceneDelta](../../design-studio/crates/design-kernel/src/scene_delta.rs)。

可见的剩余成本：

1. [Editor.change](../../frontend/design-client/src/engine.ts) 仍有节点遍历、组件清理、结构/文档校验。
2. [kernelLayout](../../frontend/design-client/src/kernel/picking.ts) 和 [translationOnlyChanges](../../frontend/design-client/src/kernel/translation-preview.ts) 在部分快路径前仍遍历节点、构造父关系；复杂组件/布局回退会 JSON.stringify 整份文档并交给原生解析。
3. `shareDocument` 需要遍历候选节点并比较；现有转换有意保持创作字段，不能直接改用规范化后的原生节点替代。
4. `SceneDelta` 的一般路径先编译场景，再比较编码；“传输是增量”不等于“编译成本也是增量”。
5. `op-sync.ts` 明确把当前操作词汇无法表达的 fills、strokes、effects、text、network 等内容变化编码为整节点 remove+insert。MCP 的细粒度编辑能力不代表原生同步同样细粒度；应统计该路径的触发率、字节量与派生失效，再选择扩展原生字段操作，保留一次原子提交和原有历史语义。

建议增加/贯通可信提交产生的 changed-ID、changed-field 和拓扑版本证据，复用不可变快照的父索引，逐批扩展原生局部解析。必须由实际草稿/原生提交生成证据，不能把选择集、调用者传入的 draftIds 当作完整变更证明。无法证明时保留完整校验。

先测每段扫描、JSON 字节、原生解析/布局、派生几何构建次数；这是根据代码提出的优化方向，不是已测得的加速比例。

### B. 避免缓存工作集略超预算时反复重建——P0 小范围候选

VC [FrameCache](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/render/src/lru.rs#L99) 有一个很实用的策略：

- 本帧刚用到的项不为新项腾空间。
- 只淘汰往帧的冷项；若本帧热项已占满预算，新结果照常计算和使用，只是不存入缓存。
- 淘汰预留一定空间，避免每次插入都进行完整查找。

Futureox [ResidentStrokes](../../design-studio/crates/design-kernel/src/resident_strokes.rs) 已有有界 LRU、精确依赖键、保留 owner 和摊销队列压缩，但淘汰不区分本帧热项。可以在这类“可重算的 CPU 派生数据缓存”上验证本帧保护，观察接近/超过预算时的 builds/hits。

不要直接复制整个 FrameCache：它在淘汰时收集并排序候选，当前 VecDeque 设计有自己的优势；其“3 帧过期”也不适合原样套到页面驻留/返回缓存。GPU 必需表面分配、仍在队列中的资源与可选派生缓存不是同一类预算。

### C. 按输入依赖缓存派生结果——P0/P1

VC [GeomEntry](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/render/src/lib.rs#L410) 保留 Arc owner，避免指针复用；[live_expanded](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/render/src/live.rs#L393) 同时检查节点身份和外部资源依赖，字体、符号、色彩或插件改变时不能沿用旧结果。

Futureox 已有 [derived_invalidation](../../design-studio/crates/design-kernel/src/derived_invalidation.rs)、[geometry_snapshot](../../design-studio/crates/design-kernel/src/geometry_snapshot.rs)、局部描边与字体缓存。应逐类检查“改颜色是否重建几何”“只平移是否重做字形”“改无关节点是否清空网格/笔刷缓存”，补缺失的依赖边，而不是再叠加一层总缓存。

跨 WASM/Worker/原生进程不能直接共享指针键；应使用各自宿主内受生命周期保护的对象身份，或稳定资源 ID+版本。缓存正确性须包含字体、资源、色彩、相机采样和设备归属。

### D. 交互临时质量与最终质量分离——已有方向，先验收

VC [fx.rs](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/render/src/fx.rs#L714) 在拖动时把新效果栅格限制到约 100 万像素；普通滤镜区域还有约 840 万像素的预算，部分路径通过降低分辨率满足预算。它在交互中复用移动前的效果栅格，随后重算。

Futureox 已有 [interaction-adaptive-density](../../frontend/design-client/src/kernel/interaction-adaptive-density.ts) 的 800 万像素候选，严格默认关闭；精确结算和导出是独立通道。已有真机 [A/B](../../testing/verification-interaction-adaptive-density-20261022/README.md) 只证明该特定候选减少部分捕获成本，未完成画质/全编辑器验收。

可借鉴的是有明确生命周期的交互策略、粗画面退场和最终清晰收敛。不能把 VC 的预算数字与自动粗化直接写入正常/精确输出，也不能借此开启当前未验收的实验标志。对于背景模糊、玻璃和兄弟依赖，单对象缓存不足以证明重用正确。

### E. 后台调度：你的项目已经有，照搬收益低

VC [render_worker.rs](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/ui-egui/src/render_worker.rs#L40) 在开始新渲染前清空排队旧任务，只做最新任务；这不会中断已在运行的渲染，且源码使用无界 channel。WASM 构建返回 None，没有同样的原生后台线程。

[canvas.rs](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/ui-egui/src/canvas.rs#L462) 根据上一次耗时和交互状态选择前台/后台，阈值 8 ms；部分更新会在 UI 线程计算。它还避免在一次交互中来回切换不同 Renderer，导致已热身缓存丢失。

Futureox 已有多通道 Worker、取消、版本栅栏、驻留复用和原生预览交接。值得借鉴的是“同一交互尽量保持缓存拥有者稳定”，不是改成 VC 的队列或在主线程增加同步绘制。已有更细的取消/资源边界应保留。

### F. 图像共享与历史内存——P1/P2，先量账

VC [images.rs](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/render/src/images.rs#L1) 在同一原生进程内共享解码图像，键包含内容、颜色变换、mip 等；[History::trim](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/engine/src/lib.rs#L180) 同时考虑步数和估算保留字节，并保留最低数量，因此不是严格的总内存上限，更不是字面上的无限撤销。

Futureox [Images](../../design-studio/crates/design-kernel/src/paint.rs) 克隆已通过 Arc 共享 Surface/mip，不能声称每个渲染任务都必然重复解码。需要测的是独立 Engine、不同 Worker、缩略图和导出实例之间是否重复，以及 WASM/IPC 的临时内存。

可研究同一原生宿主的解码资源仓库与历史增量保留成本；浏览器 Worker 和 GPU 纹理不能照搬进程内 Arc。不要复制 VC 的 u8 Pixmap 缓存替代自己的 HDR/float Surface。

## 四、哪些东西不能直接照搬

- **整个渲染器**：vello_cpu 的速度数据不等于你的复杂材质、字体、四相关采样和 HDR 路径；其部分效果使用降密度。若研究 vello，应先做隔离试验和明确支持子集。
- **简单脏矩形算法**：VC [changed.rs](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/render/src/changed.rs#L22) 适合其模型的前后视觉边界；其注释“成本只与变化有关”也不能当严格复杂度保证，函数仍检查兄弟列表。Futureox 已有 [dirty_region](../../design-studio/crates/design-kernel/src/dirty_region.rs)，需要保护布局传播、蒙版、backdrop 等依赖。
- **布尔算法的“exact”宣传**：VC [boolean.rs](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/crates/pathops/src/boolean.rs#L1) 以 linesweeper 建拓扑，之后带容差重新拟合，默认 0.01 文档单位。不能因 README 的措辞认定无误差或一定更好。先以共同退化几何语料比较。
- **整套无限历史**：VC 实际有 trim；你已有有界历史与 SQLite 持久修订。编辑 undo 和磁盘恢复继续分开。
- **全部 effects/brush crate**：依赖自己的 doc/color/pathops/text/plugins。更适合挑小算法并适配，或把相对独立的库封在转换边界后。
- **第三方插件的降级行为**：VC 的插件缺失或失败时可能保留记录并显示未应用效果的图形。Futureox 的 required/optional 语义必须明确，不能让必需显示语义静默消失。

## 五、建议实施批次

| 批次 | 交付物 | 完成标准 |
|---|---|---|
| A：先量与稳住 | 当前源码匹配构建；真实游戏 UI 夹具；编辑/预览/结算/导出分段记录；验证本帧缓存保护候选 | 正确性不变；报告 p50/p95、峰值、缓存重建和未通过项，不以函数微基准代替整机 |
| B：打通素材交付 | Asset Export 面板、规格、命名、任务计划、manifest、九宫格参数与目标引擎导入样例 | 实际进入引擎使用；修改、撤销、保存重开、再次导出一致 |
| C：增加高价值绘图 | 内外发光、少量基础 Warp；完整 bake/undo/export | CPU/GPU 输出和边界受检；未知/超预算情况明确处理 |
| D：按画风扩展 | 多色笔刷/图案角部或描摹，二选一先完成 | 有一套实际游戏素材通过完整制作流程 |
| 后续 | Blend、渐变网格、更多格式、插件 | 由真实素材需求推动，避免同时扩大所有渲染与存储语义 |

## 六、可复现比较应该怎样做

1. **一致环境**：记录两个 commit、实际二进制/WASM hash、硬件、系统、窗口、物理像素、DPR、字体和输入素材。先比较双方共同支持的视觉子集；不支持的效果另列。
2. **工作量**：小套 UI（约 300 对象）、整套 UI（约 3,000 对象）、大文档（约 20,000 对象），每组分纯矢量与图片/阴影/蒙版；再做 100 资产×3 倍率导出。
3. **操作**：拖动、旋转、缩放、改文字、改颜色、撤销/重做、连续缩放后再编辑、保存重开。区分首次冷状态与缓存热状态。
4. **指标**：输入到首个可见内容变化、持续画面更新间隔、松手到稳定清晰、编辑提交时间、导出耗时/失败数、JS/WASM/原生/GPU 各自峰值。ACK、rAF 和后台请求完成不等于输入到光子或硬件 FPS。
5. **采样**：预热后交替 A/B，重复同类操作，记录样本与异常，报告 p50/p95；最终时延测量关闭 CPU profiler，另开采样定位热点。
6. **正确性**：内容不丢失、阴影不裁边、当前修订与画面一致、撤销/重做及重开不变、取消不发布半成品、导出尺寸和透明边缘正确。整数/小数像素平移都覆盖。
7. **归因**：先测 Futureox 当前基线，再逐个候选做增量对照；不能把“统一入口”“用了 SIMD”“代码少了”当性能结论。

当前主线最新容量/仿射增量的最终组合构建与整机证据仍不完整，见 [合并记录](../../testing/verification-core-capacity-affine-dev-20261022/README.md)。此前 117/FIG 与高倍率的时间只能说明历史热点，不可归为当前性能，也不是双方对比。

## 许可与后续代码引入

VectorCraft 为 [MIT OR Apache-2.0](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/LICENSE-MIT)，实际复制代码需保留相应声明，依赖/字体等按各自许可处理。[品牌条款](https://github.com/storytold/vectorcraft/blob/445550ea29c2332bd9f40269ea89a547bc7b3d50/docs/brand/LICENSE-brand.txt) 要求公开修改版移除 ArtCraft 标识。本报告没有复制第三方实现到项目，因此没有引入新的运行时依赖。

下一步最合适的小切口：功能做资产导出计划；性能做现有 ResidentStrokes 的工作集超预算对照与本帧保护候选。两者可以各自审查、各自验收，不要求先重写整个内核。

