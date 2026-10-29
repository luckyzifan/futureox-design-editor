# Wonder 与 Futureox 渲染机制对照

日期：2026-10-28（Asia/Shanghai）。结论来自实际操作当前 Chrome 中的 Wonder Basics、检查 Elements、读取公开发布的前端包，以及审阅本仓库当前工作树。源码没有修改。复核来源、SHA-256 和观察边界见 [evidence.json](./evidence.json)。

## 结论

Wonder 的普通设计内容主要走 **DOM/CSS → 浏览器布局、绘制与合成**。它另用 **Pixi/WebGL 透明 Canvas** 承载编辑叠层，并为 shader 填充使用独立 WebGPU 表面。它不是一个把所有设计内容统一光栅化到主 Canvas 的引擎。

Futureox 的核心路径是 **权威文档 → Rust/WASM 或 native 准备/编译 → GPU 效果绘制 → 驻留瓦片合成 → 呈现回执**。主要差距在于交互时需要多少新计算、何时能复用已有资源，以及最终画面多久完成。语言或是否使用 GPU 本身不能解释速度。

Wonder 的结构支持轻量的 Web UI 编辑体验；Futureox 承担更独立的图形、采样、色彩与文件语义。要获得类似交互体验，应让相机和局部编辑的热路径更短，并减少无效光栅工作，保留既有 Rust 权威模型。

## 本次直接观察

- 当前 Wonder Basics 有 6 个顶层素材。Elements 的 `[data-node-id]` 查询匹配 2081 个元素；这是 DOM 元素数量，未证明等于唯一模型节点数。
- 主文档 `//canvas` 精确查询匹配 1 个元素。打开右侧 DevTools 时，它的 backing size 为 1646×1820，CSS size 为 823×910。这一元素的存在不能说明普通设计内容都由它绘制。
- 普通设计内容位于 `data-layer="transform"` 容器。容器使用 `contain: layout style` 和 `matrix3d`；顶层素材有 `data-node-id`、`contain: content`、flex 布局、文字与背景图片 CSS。
- 实际从约 21% 放大到 200%，使用 Hand 平移。根容器矩阵比例由 0.211865 变为 2。200% 检查时 `.wonder-culled` 匹配 4 个根图层，证明离屏裁剪在这个实际页面生效。
- 最后关闭 DevTools，恢复 Move 工具及约 21% 全览；没有编辑素材内容、上传本地文件或发布内容。
- 查看了已运行的 FutureoxTopologyRefinementV43：当前界面显示 8804 图层、159.4%、WebGPU · 清晰。没有改变该文档。其构建与当前源码的对应关系未核验，因此不把旧测试数据当成 V43 的最新结果。
- 没有进行同场景 A/B、逐帧录制或输入到光子的测量。截图及工具调用耗时都不能换算为 FPS。

## Wonder 的实现细节

以下为公开 bundle 的静态证据；与上述 DOM 观察相互印证。内部压缩变量名不作为稳定 API。

| 机制 | 公开实现与实际意义 |
| --- | --- |
| 相机与内容分离 | Renderer 的 camera adapter 缓存 zoom、位置、尺寸和 DPR；未变化便返回。变化时更新一个 DOM transform 容器，保持原设计元素。浏览器可复用其绘制/合成资源；不保证每次变换都完全免重绘。 |
| 浮动原点 | transform 层在相机离原点较远时重设世界原点，给根节点补偿 translate，并按 DPR 修正 CSS zoom。它不是简单地把所有巨大的世界坐标直接乘缩放。 |
| 空间索引与局部同步 | 公开实现有树形包围盒索引、按根节点 upsert/remove/search、dirty root 集合和版本比较；相机、节点版本、选择与播放状态都未变化时跳过后续裁剪。不是每个 tick 都完整重建所有节点。 |
| 离屏裁剪 | `.wonder-culled` 用 `display:none!important`；播放中的特殊根使用 `visibility:hidden` 路径。裁剪还暂停后代 shader。视口外有保留缓冲，选中和生成中的根受到保护；重新显示有分批预算。 |
| 编辑叠层 | Pixi runtime 初始化偏好为 WebGL，透明背景、抗锯齿、DPR 上限 2。对齐线、尺寸标签及生成描边等使用 Pixi Graphics/容器。渲染调度检查 dirty 和 render-group 变动；ticker 活跃不等于每次都提交绘制。 |
| 图片显示 | 独立 downscale Worker 生成 128/256/512/1024/2048 分级副本；按实际显示尺寸和 DPR 选择，在 zoom settled 后协调更新，旧资源延后释放。它是屏幕显示优化，不是全部图片或导出的分辨率上限。 |
| Shader 填充 | geometry 包创建局部 Canvas，shader-gpu 提供共享 WebGPU device 或逐实例 fallback 的路径；尺寸有独立上限，resize 有 settle 策略。当前示例没有额外挂载的 shader Canvas，不能说本次实测了 shader 性能。 |
| 辅助 WASM | store 包包含 resvg WASM 初始化路径。因此“DOM 为主”不等于“完全没有 WASM/GPU”。 |

主要公开来源：

- [Renderer bundle](https://app.wonder.so/assets/Renderer-CDnDYIHg.js)：camera adapter、空间索引同步、图片分级、Pixi 初始化和 dirty scheduler。
- [text-caret bundle](https://app.wonder.so/assets/text-caret-DmucM7y2.js)：浮动原点、transform 层、裁剪及分批恢复。
- [geometry bundle](https://app.wonder.so/assets/geometry-DZqCVhfg.js)、[shader-gpu bundle](https://app.wonder.so/assets/shader-gpu-COEveJQj.js)：局部 shader 表面和 GPU 生命周期。
- [CSS](https://app.wonder.so/assets/index-B5wXOBkl.css)：裁剪类的实际显示规则。
- [官方更新记录](https://wonder.design/changelog/headless-ai-and-large-files)：宣称改善大文件和缩放、平移、拖动；未提供足以复核的 FPS/相同负载基准，不能据此宣称性能倍数。

## 与当前 Futureox 源码的具体差距

### 1. 新缩放仍可能触发较重的设备空间准备

`design-studio/crates/design-kernel/src/gpu.rs` 的 CameraPrepare key 包含精确 view x/y/zoom、prepare guard、资源/几何谱系及动画；代码已经有 prepared geometry、program、fragment 缓存和 CameraResidency，不能概括成“没有缓存”。

但新密度/采样相位无法任意复用旧设备空间覆盖程序，新的 camera key 仍可能需要准备、编译和光栅。Wonder 普通 DOM 内容的移动和缩放主要由祖先变换表达，浏览器管理后续栅格与合成。

建议：继续区分世界空间不变的几何/效果依赖与相机相关覆盖程序，测量每次相机变化到底失效了什么；提升前者的稳定驻留与局部更新比例。对缓存命中数之外，还要记录本次重建节点、准备耗时、程序上传和实际新像素完成时间。

### 2. 全源画布的单个慢任务仍会拖住后续任务

`frontend/design-client/src/kernel/NativeSourceSurface.tsx:113` 的 run 循环每次取 `missing[0]`，await 一次 `renderSource` 后继续。相机更新会复用旧瓦片、提交当前视口，停手 120ms 后切回 exact phase；较大密度变化或离屏任务可取消。

这已经具备“先呈现、再补绘”的结构，但一个重效果瓦片可能持续很久，后续清晰内容也受影响。这里描述的是全源 surface，不能扩张成所有渲染路径都只有单任务。

建议：对当前视口和指针附近的工作优先排序，按可取消的短任务片段推进；复用同相机准备，避免小块调度反而重复编译。先做成对 profile，再决定是否增加有界流水并行，不能直接扩大并发或显存预算。

### 3. 对象姿态、选择框、最终像素的交接更复杂

`Canvas.tsx` 同时接入 KernelSurface、交互预览、presented camera 和选择叠层；`interaction-renderer.ts` 已有 latest pose 合并、捕获取消、驻留交接和源版本保护。这些是必要能力，但首个捕获较慢时，轻量姿态更新仍可能等重工作。

建议：优先测“首个有效对象移动”和“最终精修”两个延迟，查出姿态是否等待 compile/capture。内容与选择框必须遵循同一份有效呈现身份，不能仅让框跟鼠标就算修复。当前逻辑已有保护，应优化其满足条件的成本，而不是撤掉条件。

### 4. 效果工作量和失效范围仍比框架切换更值得优先处理

Futureox 已有 Rust 材质脏区、蒙版/背景依赖传播、子树片段缓存、图片 mip/分行上传等实现。需要提高真实复杂素材上的命中和局部性，而不是再加一套同名缓存。

建议：按每次编辑记录受影响根、失效瓦片、draw calls、pass pixels、GPU 完成等待和可用画面延迟。首先减少同一效果被多个瓦片重复展开的工作，以及无关根、祖先或背景依赖造成的扩大失效。跨对象蒙版、模糊和背景读取仍须保守正确；不能直接照搬 DOM 的按根隐藏来裁掉真实光学依赖。

### 5. 产品语义目标不同

Wonder 的浏览器布局/文字/CSS 内容与 Web 代码天然贴近；Futureox 的 Rust 内核负责独立文档、Sketch/FIG 语义、精确采样、HDR/浮点和导出。现有证据没有证明 Wonder 在这些要求下有相同性能、保真或能力。

迁移整套引擎到 DOM 会改变语义边界。更合适的借鉴是保留稳定场景、把相机更新做轻、对局部变化只更新必要资源，并让后台补绘及时让出交互机会。

## 历史数据必须单独解读

这些是仓库既有、限定场景的记录，本次没有重跑，也不是对 Wonder 的公平性能对照：

- [2026-10-26 大文件编辑](../verification-large-edit-20261026/README.md)：拓扑工作集首组鼠标释放至精修从 16599ms 降至 6729ms，复测 6801ms；说明改进显著，但最终收敛仍慢。
- [2026-10-26 局部材质失效](../verification-local-edit-cache-20261026/README.md)：FIG 小蒙版从 20 块降至 1 块，有效配对中位数 1380.5ms → 641ms；117 大蒙版减少瓦片后未取得端到端加速。这说明“少画了”仍需验证“更快可用”。
- [2026-10-27 全源 v17 记录](../verification-topology-navigation-20261026/README.md)：124447 节点、306 素材的全源场景，冷高倍首块约 28.64 秒，全览复杂瓦片约 59–62 秒，明确性能 FAIL。它早于当前 V43 窗口，不能当作 V43 的当前耗时。

## 建议实施顺序与验收

1. 先冻结同一源码/构建、相机、DPR、素材和精度配置，测单次平移、连续反向缩放、单节点编辑的完整时间线。已有 V43 需要先完成产物与源码对应核验。
2. 优先解决相机变化的准备复用和长任务抢占；同时保证内容/选框同步。用明确的旧失败、新通过判据，不凭帧保留或提交 ACK 宣称物理呈现通过。
3. 再收窄材质/蒙版/效果失效和重复 pass，并检验图像分级/驻留策略在真实负载是否有收益。
4. 继续完成 G2/G5 固定矩阵、精确像素与 HDR/export、设备丢失和取消晚回。此分析不产生新的性能 PASS，也不授权开启默认关闭的实验选项。

本次已完成的是渲染机制与差距分析。尚未完成同文档跨产品基准、V43 源码身份核验或任何修复实施。
