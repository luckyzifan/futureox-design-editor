# Sketch 渲染与特性覆盖审计（2026-10-26）

结论：**当前不能宣称完整支持 Sketch 渲染或全部 Sketch 特性。** 已有完整设计编辑器的主要渲染基础，但存在明确未建模的输入字段、可执行语义缺失、效果参数差异，以及尚未通过的真实交互验收。逆向材料让机制可研究，并不自动完成移植。

本轮只做源码、原始反汇编、已有验证记录和构建输入核对；未修改运行时代码，未重新运行 GUI、硬件 GPU 或 Sketch 原生像素对照。下文“已有实现”不等于“与 Sketch 像素一致”。本轮数值和文件身份核对见 [audit.json](audit.json)。

## 范围和判定方法

- 参考样本：父目录 `core/sketch-kernel-analysis/32-rendering-mechanisms-atlas.md`、六份 `drafts-32`，必要处回到 `dumps/full`。这些资料针对 Sketch 2025.1.3 样本，不覆盖所有历史或后续版本。
- 本仓库审计时 HEAD：`2954a77fe22a12f806d91351ec95e5186f9b562a`，含其他任务进行中的工作树变更。不能把 HEAD 号当成整个工作树身份；关键文件 hash 另存 `audit.json`。
- 判断链：源文件字段 → 内部模型 → 生产渲染/布局消费者 → 编辑及撤销 → 导出及重开。只保留在 bindings/userInfo 中的字段，不算显示、编辑或 Sketch 原生互通已经支持。
- 不给“支持百分比”：M1–M21 是机制分类，既不是等权功能列表，也不是像素与交互验收分母。

## M1–M21 对照

| 机制 | 当前实现与边界 | 判定 |
| --- | --- | --- |
| M1 帧驱动 | Web/Electron 输入、异步准备 Worker、GPU 呈现；平台不使用 CVDisplayLink。仍需证明连续输入下真实内容及时跟随 | 有对应职责，体验未全面验收 |
| M2 失效分类 | revision、damage、准备/呈现身份与局部材质证明；不使用相同的 renderMask 数字编码 | 有实现；位表不必照搬 |
| M3 等待策略 | 异步准备、取消、迟到结果隔离。Sketch 的 ∞/50ms/0 是特定回灌等待策略，不能直接变成浏览器主线程等待 | 不同实现；不能宣称调度等价 |
| M4 瓦片/mip | 瓦片、LOD、图像 mip、旧内容预览与精确替换已有生产路径 | 有实现；快速缩放体验仍有记录中的失败 |
| M5 脏区 | 布局后材质脏区、蒙版消费容器、页面/隔离范围内背景读传播已落地；根蒙版和未知光学读取仍保守全量 | 局部真实文件已验证，不是所有编辑都局部化 |
| M6 缓存 | 资源身份、编译/准备结果、图像、瓦片、GPU 材质等缓存；语义失效与容量/LRU 各有职责 | 有实现；不同于 Sketch 的单个 MSRenderingCache |
| M7 渲染图 | Rust 准备/编译结果和 GPU packet，由现有模型与所有权边界发布 | 有对应架构；无需移植 Marina FlatBuffers/ECS 才算支持 |
| M8 栅格化 | Rust/WASM 软件路径与 WebGPU 实际几何、效果计算并存 | 有实现；不等同 Quartz，不能据此判定高低或等价 |
| M9 文本 | Rustybuzz shaping、字形轮廓、字体回退/变体、富文本等已有；Sketch 段落属性有折叠，彩色字形管线未建立完整证据 | 部分支持 |
| M10 模糊/效果 | 普通模糊、背景模糊已有；运动/缩放模糊导入未建模；背景模糊 saturation 缺失；核与降采样并非同一算法 | 部分支持，存在参数差异 |
| M11 阴影 | 外/内阴影与 spread 有实现；复杂透明填充、描边、spread 的 Sketch 对照仍缺 | 已有基础，不能声称完全一致 |
| M12 遮罩 | 矢量/alpha 蒙版、消费链及局部失效已有；复杂嵌套边界需原生 oracle | 已有基础与有限实测 |
| M13 混合 | blend.rs 与 GPU 路径有多种混合模式；线性工作空间、隔离组及 alpha 运算仍需逐模式比对 | 已有基础；模式名称一致不证明像素一致 |
| M14 GPU/上传 | 本项目 GPU 不仅贴图，资源上传和精度策略不同；保留浮点/HDR 与现有预算 | 架构差异，不是功能缺口 |
| M15 曲线 | Rust 几何/布尔与解析覆盖相关路径已有；不需要按 Sketch 弧线顶点布局实现 | 已有能力，精度结论以各自验证为准 |
| M16 色彩 | 明确扩展线性 sRGB 工作像素、多色域和 HDR；Sketch 导出受目标格式约束 | 自有模型范围更广，但不证明 Quartz 显示完全一致 |
| M17 overlay | 内容层与选择/交互叠层有分离路径；选框同步和真实对象运动仍是验收门 | 部分实测，不能全面通过 |
| M18 Flow | 自有导航/overlay/变量表达式已有；Sketch hotspot、动画/位置、复杂交互原生互通不完整 | 部分支持 |
| M19 缩放/DPR | 缩放与密度/原生相位替换已有；历史真实快速反向缩放仍有失败 | 功能已有，连续性未完成验收 |
| M20 平移 | 相机与瓦片复用已有；当前用户报告“不能缩放/移动”未在本审计中复现或排除 | 不能认定该问题已修复 |
| M21 导出 | SVG/位图/PDF 等已有；SVG 默认轮廓、可选受限 editable text/字体嵌入；普通图层模糊 σ 存在具体差异 | 部分支持 |

主要实现入口：[dirty_region.rs](../../design-studio/crates/design-kernel/src/dirty_region.rs)、[renderer.rs](../../design-studio/crates/design-kernel/src/renderer.rs)、[preparation.rs](../../design-studio/crates/design-kernel/src/preparation.rs)、[GPU packet](../../design-studio/crates/design-kernel/src/gpu/packet.rs)、[render-kernel.ts](../../frontend/design-client/src/kernel/render-kernel.ts)、[tile-scheduler.ts](../../frontend/design-client/src/kernel/tile-scheduler.ts)、[GPU renderer](../../frontend/design-client/src/kernel/gpu/renderer.ts)、[resident-presenter.ts](../../frontend/design-client/src/kernel/gpu/resident-presenter.ts)。

## 直接阻止“全部支持”的特性缺口

| 特性 | 已有部分 | 尚缺部分及代码证据 |
| --- | --- | --- |
| Sketch 效果 | 普通/背景模糊、内外阴影 | `interop.rs:1063` 只将 blur type 0/3 转成效果，1/2 返回；`:1256`–`:1264` 明示 saturation、motion、zoom 未建模 |
| 噪声和颜色调整 | 自有噪声/图像处理模块存在；原始 Sketch 数据可保留 | `interop.rs:1305`–`:1369` 的 noise fill、非 1 的 patternTileScale、colorControls 只进 bindings 并报告 lossy；不能用模块存在代替接通 Sketch 字段 |
| 图片图案和箭头 | Tile/Fill/Stretch/Fit、部分 marker 新近完成映射 | 图案缩放未建模；open marker 到 filled 的近似仍有边界 |
| 富文本 | 字体、字号、颜色、下划线/删除线、每 run 大小写已有 | `interop.rs:1707` 起只用首 run 建立段落默认值；行高范围压缩、tightening、垂直对齐有明确未建模提示 |
| Emoji/彩色字体 | 有字体回退与字形轮廓；有轮廓缓存 | `font.rs:847` 的 outline_glyph 不能代表彩色位图/分层字形实现；本轮未找到完整 COLR/CBDT/sbix/SVG 彩色字形消费者。不能由此断言所有 emoji 均不能显示，但不能承诺 Sketch 彩色 emoji 等价 |
| Smart Layout/现代约束 | 旧 6-bit resizing mask、自己的布局系统已有 | `interop.rs:1426` 起 Inferred Group 保留静态布局/原字段；`:2044` 起 modern pins/sizing/flexItem 保留原字段，不解释执行。自有 inferred_layout 模块不等于 Sketch 字段已接入 |
| Symbol/共享库 | master/instance、覆盖、共享样式及嵌入 foreign symbol 可映射 | `interop.rs:2250` 起明确 library link static：远端库更新不传到本地副本；没有完整 Sketch Libraries 更新闭环 |
| 原型 | 自有表达式、分支与变量逻辑已有，不应沿用旧矩阵说它们缺失 | Sketch hotspot `:1906` 起只保留 raw；导出 `:5380` 起只表达基础单击 flow，animationType=-1；位置/easing/复杂触发转 userInfo。`prototype.ts:257` 起明确拒绝媒体动作和重置交互组件状态 |
| SVG | 默认字形轮廓、可选受限可编辑文本、显式字体嵌入 | `svg-editable-text.tsx:9` 起拒绝路径文字/竖排/两端对齐/OpenType 覆盖等 editable 情形；不能据此说轮廓导出也不支持。图层 blur 的 σ 另见下节 |
| 导出及往返 | guides、assets、exportFormats 等最近已补齐保存；111/117 有往返记录 | 保留未知字段不等于编辑其语义；目标 Sketch 不可表达的 HDR/特殊效果仍须明确拒绝或报告降级 |
| 大文档 | 流式源索引、分段工作集、完整源导出 | 普通 Sketch codec 的展开/条目预算和 large-source 的容量是两条路径；能索引/导出整个文件不等于所有页面全部同时可编辑、驻留和渲染 |
| 产品生态 | 本地编辑器、自己的操作 API/自动化 | 没有证据支持 Sketch CocoaScript 插件、Data supplier、完整历史迁移链、Sketch 云协作及库生态全部兼容；渲染总纲不能证明这些产品功能 |

上述定位对应 [interop.rs](../../design-studio/crates/design-kernel/src/interop.rs)、[font.rs](../../design-studio/crates/design-kernel/src/font.rs)、[prototype.ts](../../frontend/design-client/src/prototype.ts)、[svg-editable-text.tsx](../../frontend/design-client/src/svg-editable-text.tsx)。[10 月 26 日互通补齐记录](../verification-sketch-gap-closure-20261026/README.md)也明确声明不构成 rendering/GUI/hardware acceptance。

## 一个确定的 SVG 参数不一致

普通 `.sketch` 导入路径把 `style.blur.radius` 原样赋给 `Effect.radius`（`interop.rs:1073`），而 [Renderer.tsx:77](../../frontend/design-client/src/Renderer.tsx) 输出 `stdDeviation = radius / 2`。

Sketch 样本的 `MSImmutableStyleBlur(SVGExporter).addFilterWithExporter:` 在 type 0 分支直接取 radius（`0x169d4`），通过数值格式化后调用 `setStdDeviation:`（`0x16a74`），中间没有乘 0.5。证据：[原始反汇编](../../../core/sketch-kernel-analysis/dumps/full/SketchSVG/MSImmutableStyleBlur(SVGExporter).txt)。

因此，输入普通图层模糊 radius=10，这两条已检查路径分别输出 σ=5 与 σ=10。阴影的 `blurRadius/2` 不能推广成所有 blur 的通用换算。这是静态数据流已确认的不一致；尚未运行对应 Sketch 原生导出及像素比较。修复时应明确导入规范化、内部效果定义及各导出目标的单位，不能直接全局把 `/2` 删掉，破坏已有 FD 文档和其他导入格式。

## 逆向材料需要更正或收窄的结论

1. **下采样表抄错了分段，并漏掉 0.5 档。** 原始 `MSBitmapEffectsContext.imageScaleForBlurRadius:`（`0x168024`）的正半径分支如下。`drafts-32/03:65`–`:76` 与总纲“直接可抄”表不一致于这些指令。

   | 输入 r | r≤5 | 5<r≤7 | 7<r≤9 | 9<r≤10 | 10<r≤24 | 24<r≤49 | 49<r≤100 | r>100 |
   | --- | --- | --- | --- | --- | --- | --- | --- | --- |
   | imageScale | 1 | 0.9 | 0.8 | 0.7 | 0.6 | 0.5 | 0.4 | 0.25 |

   `0x4048800000000000` 解码为 **49**，不是 48；`0x16806c` 明确装载 0.5；`0x1680ac` 的阈值是 7。r=100 返回 0.4，不是草稿例子的 0.25；r≤0 单独返回 1。这里说的是此函数的输入，外层 contextScale/clamp 仍需另算。证据：[MSBitmapEffectsContext.txt:39](../../../core/sketch-kernel-analysis/dumps/full/SketchRendering/MSBitmapEffectsContext.txt)。

2. **9 位有效数字不能保证 double 往返无损。** `drafts-32/06:94` 的建议错误：本轮直接计算 `1.2345678901234567 → %.9g → 1.23456789`，解析后不等。Sketch 采用该序列化格式是特定输出取舍，不是本项目可降低几何/持久化精度的依据。

3. **GPU“只贴图”须限于所分析的内容瓦片主路径。** `MSGPUOverlayItemRenderer` 在 `0x141e4c` 调用 `drawArcVertexBuffer:pathInfoBuffer:modelViewTransform:backingScale:`。GPU overlay 有弧线几何路径；CPU/GPU 双分支不能概括成全部 overlay 每帧先重画整张位图。CPU 调用 CoreImage 也不足以证明系统内部绝不使用 GPU。

4. **“唯一颜色转换是 clear 色”不能覆盖整条管线。** `drafts-32/04` 自己的 §2.4 已说明 CGContext 写像素参与色彩处理，§2.3 也记录文档切色域转换。`beginFrame` 的 colorSpace 只去 layer 属性，不能推出 Canvas/WebGPU 可忽略工作空间转换。现有线性浮点/HDR 链路应保留。

5. **Symbol 内联不等于 SVG 从不生成 `<use>`。** `drafts-32/06:113`、`:169` 明确记载多 fill/stroke/text 的 defs + use 路径。总纲第 3 节的全局表述过宽。

6. **缓存空间谓词是 containment，不能改写为“不相交”。** `MSRenderingCache.removeObjectsWithTraits:orOutsideRect:` 的 block 在 `0x1638e0` 调用 `CGRectContainsRect`。移植前还需核对两操作数的来源及方向，不能仅凭方法名简化成视口相交检测。

本轮未覆盖写父目录逆向文档；这些勘误集中保留在此，供后续修订和实现使用。

## 哪些证据已经有，哪些还没有

[局部材质失效优化](../verification-local-edit-cache-20261026/README.md)已有有限真实文件证据：FIG 小蒙版每次 20→1 瓦片、2825→163 draw calls；有效配对中位 1380.5→641 ms。117 大蒙版 20→10 瓦片，但端到端没有改善结论。三文件内容截图有基线/候选一致性检查。

这些结果证明对应优化没有改变所测内容，并减少了相应编辑的绘制。**它们不是与 Sketch 原生截图的比较，也不能证明所有 Sketch 效果准确。** 拓扑叶蒙版的特定源保存拒绝仍单列；根对象保存通过不代表该叶编辑也已通过。

[运动连续性记录](../verification-motion-continuity-20261025/README.md)及项目工程规范仍保留快速缩放/对象跟随的未通过项。用户本次之前报告不能放缩/移动，本审计没有运行输入复现，不能给出已修复结论或猜测成缓存问题。

审计时桌面 `dist/build-manifest.json` 时间是 `2026-10-26T08:01:51.437Z`。本轮对其 2232 个记录输入重新 hash，9 个与当前工作树不同（主要是 large-document/capacity），详见 `audit.json`。这不能证明任意正在运行的应用使用哪组二进制，但说明旧组合构建的结论不能直接覆盖所有当前源码。

## 建议的实际优先级

1. **先关闭当前画布不能缩放/平移及真实运动失败。** 冻结实际启动构建、输入方式、真实文件和工作集，区分事件未收到、相机未提交、准备取消/失效、GPU 未呈现；以真实输入到内容变化的证据定位。不能靠加缓存名目认定完成。
2. **统一 Sketch 效果单位与参数映射。** 优先普通 blur/shadow/background blur 的 oracle，再补 motion/zoom、saturation、colorControls、noise、pattern scale；不全局降低精度或更换 CPU/GPU 分工。
3. **补模型语义。** 分段段落文本/彩色字形、Inferred/modern layout、原型原生字段和库更新；每项打通导入→编辑→撤销→导出→重开。
4. **建立 Sketch 原生对照集。** 锁定应用版本、字体文件、文档色域、DPR、相机与导出设置；覆盖混合模式×蒙版×半透明×效果组合，辅以 111/117/拓扑等真实文件。现有自比较测试继续保留，不能代替外部 oracle。

无需为相似架构而把现有 WebGPU 几何/效果全部改成 Canvas2D CPU 栅格，也不应采用 RGBA8/9 位数字去替代当前浮点/HDR/几何精度。应参考失效、作用域、调度和资源复用机制，用当前实现完成可验证的语义与体验。
