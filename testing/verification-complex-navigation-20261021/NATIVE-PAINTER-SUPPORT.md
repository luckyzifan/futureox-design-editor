# 原生滤镜区域支撑证书（2026-10-22）

本记录按阶段保留 Rust/portable-WASM 准入，以及独立的小场景实际 GPU 原始像素对照。**小场景像素门通过不代表 117/FIG 的 GPU 内存、快速缩放平移、延迟或完整产品验收通过**。旧失败参考仍保留，不能由 CPU 准入或小场景结果覆盖。

当前实现为严格 opt-in：仅 GPU 请求 envelope 的 `gpuPainterSupport: true` 可准入，缺失/false 保留既有路径，非 Boolean 拒绝；公开 Rust `compile_gpu_region` 与 whole-frame 默认仍关闭。该字段不是文档或 RenderOptions 的持久化设置。当前 phase3 CPU 定向测试 45/45；此前 phase2 的 37 项与 stage 版本 portable WASM 的 20 个实际文档请求、5 个策略对照按历史阶段保留。它们不能代替当前 GPU/实机门。

phase2 实际 GPU 发现 fine rotated backdrop 相位在裁剪后改变了 f32 bilinear 权重。phase3 新增[保守采样相位门](PAINTER-SAMPLING-PHASE-REVIEW.md)，失败时拒整份证书、与同 crop legacy 保持完全相同；不能仅关 stage 仍改变 extent。默认与 shader 算术不变。当前 phase3 WASM 已完成相同 20 请求的 CPU 复核及下述 32 个小场景实际 GPU 对照；真实文档和完整产品门仍独立验收。

## 两个不同的原生拒绝原因

- 117 的已保留高倍率失败相机中，普通背景模糊 device radius 约 1177.215，输入包含更早绘制、前景模糊 radius 约 612.152 的图像。旧 uniform halo 为 2355；64×64 输出会申请至少 22,791,076 像素，超出原生 16,777,216 门。只把 2355 除以二会丢上游支撑。
- FIG 的对应失败相机覆盖一个大矩形底边，单外阴影 device radius 为 1920、Y 偏移为 640、spread 为零。旧 uniform halo 为 4480。这里需要追踪偏移后的 alpha 输入和源形状外严格为零的区域，不能复用 117 的背景依赖结论。

## 本次修改的约束

[gpu.rs](../../design-studio/crates/design-kernel/src/gpu.rs) 增加区域绘制依赖证书：从输出区域倒序遍历实际 `render_children` 与根节点，背景滤镜将完整输入需求传给更早兄弟；前景隔离只扩大自己的源需求。所有所需源区域的并集决定共享 extent。多个独立前景滤镜不会因此错误串联；可观察背景链仍累计支撑。

普通 integrated tent 同时覆盖 authored binary64 与上传 binary32 半径的外侧 fractional tap，保留两个邻居和初始区域 guard。不改变滤镜系数、采样相位、画质档、合成顺序或原生面积门。完整依赖必须在现有准备几何 guard 内，全局坐标也必须在证书域内。

managed 场景只准入普通 blur/background-blur。单外阴影另有窄域：managed 或 coherent integrated profile，单效果叶、normal 合成、无 mask/clip、spread 为零，设备偏移须为 binary32 精确整数。源需求反移偏移后保留完整 tent 支撑，再与未滤波几何界相交；界外 alpha 严格为零。阴影采样位置与中间区域也保留，不能仅保留非零源图。

mask、未知材料、复杂 paint/blend、Gaussian analytic unmanaged profile、不完整准备窗口、分数阴影偏移、spread、混合阴影效果等没有新证书。它们保留既有路径与拒绝行为。显式 opt-in 下，完整证书即使需要比旧 tree-max 更宽的区域也采用，仍受原生 16M 面积门约束；不能为了仅展示“变小”而回到已不足的兄弟链域。准备 guard 只能采用本请求或由相同 prepared Arc 真正持有的保留窗口，没有自动扩大准备窗口。没有 certificate 的 legacy 回退不构成新支撑证明。

GPU scene 增加可选 `backdropOutputBox` 与 `shadowOutputBox`。前者包含后续绘制依赖和本节点前景模糊的消费需求，后者仅为上述单阴影窄域。二者均只在整场证书实际采用时输出；旧 whole-frame 和回退场景省略。它们不能被解释为仅可见输出 crop，也不能改变 `backdropBox` 的 fractional 捕获原点与真实形状边界 clamp。

第二阶段还提供 `rootInputBox`、`childrenInputBox`、`postCompositeBox`，区分根/内部 bundle 的初始 prefix、每节点合成后的完整 suffix，以及独立叶滤镜的源域。每个 suffix 保留当前节点形状之外仍需显示的旧 target。Rust 按新分配域重新编译 interval mask；背景 capture 保留独立输入域，不能仅在 JavaScript 改 path.rect。对于 normal 隔离 frame 根，最终输出 64² 的外层根需求约 68²，frame 内背景输入 prefix 约 2428²，独立 Image 源仍约 3658²。容器含可见效果时暂不发 stage 元数据，保留第一阶段。

这些字段只描述合法区域。GPU 必须先从 wide targets 捕获背景，再按 suffix 裁旧 dst/输出，并保留四相与真实别名。否则四张大面依然超出 256 MiB；不应把元数据本身计为预算或体验修复。

## 已执行的原生检查

最终 targeted 命令：

```sh
cd design-studio
cargo test -p futureox-design-kernel --locked --offline \
  --test gpu_painter_support_regions --test gpu_regional_backdrop \
  --test gpu_analytic_blur_regions --test gpu_tile_culling
```

phase2 定向 37/37 通过（新 13 项、已有 7/5/12 项）。phase3 增加纯相位模块 6 项和集成负例后，当前互不重叠的定向检查共 45/45，详见[相位门记录](PAINTER-SAMPLING-PHASE-REVIEW.md)。覆盖前序兄弟支撑、绘制顺序、独立隔离分支、多个可观察背景链、父前景模糊消费域、JSON/FGPK 一致、未知域回退、整偏移阴影及负例，另加入 strict opt-in、prefix/suffix mask 域、容器效果回退、更宽完整证书与保留准备窗口。独立 CPU exact rational filter 链在四个源相位、输出边界逐位比较旧宽源区域与新支撑区域。它不执行 WGSL。

最初执行先后暴露编译时 `GpuScene` 无 Debug、链场景被保守回退、旧 extent 硬阈值和阴影夹具不可达节点四类问题，最终修正并重跑。测试没有删除可观察效果；旧背景测试现在断言完整真实 tent 支撑及背景效果仍存在，而非必须分配已不再需要的 `2×radius + inner-shadow spread` 区域。

[CPU 预检 example](../../design-studio/crates/design-kernel/examples/profile_painter_support_regions.rs) 接受外部文档、字体与请求数组，不内置私人图层标识，也不执行 GPU。第一阶段保留的失败相机各 10 个输出 crop 中，117 与 FIG 均 10/10 原生编译准入；当时 portable WASM 再通过 [Node/WASM 脚本](painter-support-preflight.mjs) 复测这 20 个请求，运行前后 WASM/module 身份稳定，历史结果见 [来源与区域摘要](native-painter-support-summary.json)。首个 117 输出 64×64 的 extent 为 3658×3658（13,380,964 像素），首个 FIG 输出 64×64 为 3918×2633（10,316,094 像素）。这些仍是大区域，不是低延迟证明，也不是当前 stage 版本的设备结果。原生私有请求/输出保留在 ignored 的 `reference-roi-preflight`；新 WASM 与设备复测须记录其独立来源身份。

第二阶段 WASM `012a65aa1b5bcd10c442ec597da51997b10b07309ee11f55ec342c844c32e541` 对同 20 个实际文档请求创建了独立、显式 `gpuPainterSupport:true` 的请求与输出文件，没有覆盖第一阶段。117 首块 rootInput 为 68×68，背景节点 rect 为 68×68、精确 mask 的 fillRect 为 68×63（含真实形状顶边），完整 capture 仍约 2429×1242，Image 源仍 3658²。FIG 单阴影源和 mask 仍为宽域，消费域为 68²。所有结果运行前后 WASM/module 身份稳定，摘要按 phase 分开记录。

two-backdrop 策略 CPU 对照中，显式 true 的完整 extent 为 `(14,6,130,123)`，false/missing 保持旧 `(24,16,110,103)`；whole-frame 不论 true/false 仍为旧 `(-23,-23,214,191)`，不发 stage 字段。更宽的新证书是补齐跨兄弟源依赖，不能将旧小区域当成更快且完整的正确性证据。该五请求对照只验证原生 packet 与 gate，不执行像素或 GPU。

phase3 portable WASM SHA-256 为 `4efb26d67f71bf031fed9efbdfe3ea15385c57017de46aa5fd465a13136679a9`。对 phase2 原请求字节分别复制到独立的 `deep-painter-phase3-preflight`，117/FIG 各 10/10 CPU 编译成功，20 份完整 native scene 哈希均与 phase2 相同。117 的 8 份采用证书，另 2 份保持既有前景区域路径；FIG 的 10 份采用阴影证书，没有新增相位门回退。原文档、请求及 WASM/module 前后身份均核对，公开摘要只保留计数、区域和哈希。

## phase3 小场景实际 GPU 对照

[实际设备脚本](../../frontend/design-client/scripts/check-painter-support-region.ts) 使用同一 phase3 WASM，覆盖两种倍率下的绘制顺序、外侧 fractional tap、双背景、嵌套、clipping、旋转细相位、透明层/HDR、单阴影及不支持域回退。独立 `deep-painter-phase3-oracle-v2` 的输入清单共 1141 项，运行前后字节相同。32 场景共 466,944 个分量，分成两个严格的门：

- 24 个实际采用证书的场景，对未修改 whole-frame 编译器的更宽 GPU 输出 crop，350,208 个分量逐位零差异；24 个 extent 均缩小。
- 8 个拒绝证书的场景，native scene JSON 与同 crop legacy 完全相同，116,736 个 GPU 分量也逐位零差异。旋转回退对更宽 full-frame 仍分别有 2 和 886 个分量差异，共 888；这是保留的既有 crop-dependent 结果，不能计为更宽参考通过。

输出包含原生 RGBA32F 的 379,392 个分量和 RGBA8 的 87,552 个分量，全部有限。透明层候选实际执行 16 次 compact 写入，包含有限 HDR 测例。没有放宽 ULP 容差或 shader 算术。首次 v1 在完成 20 场景后被合成夹具中的不可达节点阻断，未计为通过；修正夹具后独立运行 v2。绑定输入及逐场景输出哈希见[分阶段摘要](native-painter-support-summary.json)；v2 `gpu-result.json` SHA-256 为 `369974b9dd8678d20d88a9c9e8e6d7da92dacc7807a8cd1578c3c26b72246cff`。

这些小场景不替代真实 117/FIG 的大半径、内存/取消恢复和连续复杂操作，也不证明编辑、撤销、导出或整机延迟。**不能通过只提高 512 常量、提高 16M 面积门、降采样、改变算子或省略 halo 宣称问题解决。**
