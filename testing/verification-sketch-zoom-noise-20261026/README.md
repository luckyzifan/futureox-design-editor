# Sketch 后续画布能力：缩放模糊与噪声图片 · 2026-10-26/27

这是继续“全部支持”任务的第三组，不是全部 Sketch 功能或完整渲染验收。工作在原附属 worktree 进行，`baseline.json` 冻结主目录来源；继承改动单独记录，主目录集成不得整树覆盖。

## 从 core 核对的事实

- `../core/sketch-kernel-analysis/drafts-32/03-effects-mask-blend.md` 与原始 `dumps/full/SketchRendering/_c_functions.txt`：Zoom 初始化 @0xc0b68，@0xc0bc8 将强度转为 float；中心在 @0xc0e48–0xc0e54 按 `(中心−上下文原点)×backingScale` 转换。普通 3×radius 是绘制外扩，不能当作任意焦点下的源采样范围。
- Core Image 的内部采样代码未在这些 Sketch 指令中展开。`zoom-probe.swift` / `zoom-oracle.json` 是本机公共 CIZoomBlur 的浮点测量；指数径向范围属于测量归纳，64 点重建是明确的可移植实现，**不能称为 Core Image 指令级复刻**。
- `05-style.md` 的 noiseIndex/noiseIntensity 字段不代表现代 Sketch 仍执行旧 Noise Fill。Sketch 官方在 [54 更新说明](https://developer.sketch.com/plugins/updates/new-in-sketch-54)中说明噪声填充已改为图片；[当前填充文档](https://www.sketch.com/docs/symbols-and-styles/styling/fills/)也把噪声放在图片预设中。`noise-native-3/` 的有效纯色对照正常绘制，旧 4/5 无图片样本透明；`inactive-noise-native-proof.json` 证明普通填充上残留 noiseIndex/intensity 不改变原生像素。

## 实现

- schema 19 增加 `zoom-blur` / `zoomBlur:{amount,center}`。amount 无量纲、不会被 Inspector 当成距离再次缩放；center 是相对节点局部框的归一化焦点。Rust 验证、动画、共享样式/覆盖扫描、WASM、CPU、Metal、WebGPU、WebGL2、单选/多选控件、操作参数描述和 Sketch 往返一起接入。
- Rust 生成有界的两个坐标轴采样表，保留 f64 坐标计算和现有单次舍入双线性采样；64 点采用固定 4×4×4 求平均顺序，保留 HDR/负值。微小到有效恒等的强度走原值拷贝。坐标表上限 64 MiB、单轴 16384，既有表面/内存/2048 像素依赖限制不变。
- 新的源范围规划区分绘制边界和采样需求，反向遍历前景与背景读取；隔离组终止对外背景依赖，普通框裁剪阻止屏外效果污染当前区域。GPU/CPU 用同一源范围，既有几何缓存身份继续包含准备区域，未开启任何默认关闭实验。
- 本地噪声图片预设由 Rust 确定性生成 64×64 原创纹理，进入既有图片/平铺通道，默认透明度 18%，可编辑平铺尺寸、不透明度及图片参数。**不是复制 Sketch 专有噪声贴图，也不会把旧 noiseIndex 猜成该预设**；FD/Sketch 保存的是普通嵌入图片。
- 修复旧噪声元数据导致的重复填充：已建模的普通填充不再进入“补回未支持填充”列表；残留字段保存在独立元数据中，并回填原填充位置，避免导出多插一层。
- 严格矢量 SVG 对运动/缩放模糊明确拒绝，既有保留视觉效果的 SVG/位图通道可用；旧 blur、高斯、运动、HDR 和预算不变。

## 当前验证

| 范围 | 状态 / 证据 | 不代表什么 |
| --- | --- | --- |
| CPU 模型/互通 | `zoom-support-final-tests.log`：7 项；`noise_fill` 往返通过 | 不是原生像素等价 |
| 局部裁剪 | `zoom-crop-before.log` 最大字节差 120；修复后的全图/裁剪差为 0，含组/背景读取 | 不代表所有 G5 组合 |
| 局部编辑 | `zoom-local-damage.log`：变化覆盖滤镜组，`damage.full=false`，远处图层不失效；增量结果等于全新渲染 | 不宣称端到端性能提升 |
| 原有回归 | `dirty-region-regressions.log`：38 通过；`interop-regressions.log`：47 通过、1 默认忽略 | 真实文件另行显式运行 |
| 真实文件 | `real-111.log`、`real-117.log` 导入/导出/再导入通过 | 不等于完整真实文件 GPU/GUI 验收 |
| 前端 | `client-tests-final.log`：16 通过；TypeScript 检查通过 | 主目录组合需另验 |
| 原生 Metal | `zoom-metal-final.log` 含两个焦点、普通/HDR 仿射、裁剪；后续更小分配范围的复验另列 | 初次冷管线耗时单独记录，未当作 FPS 数据 |
| 浏览器 | HDR、裁剪、preview 的实际 KernelClient 对照，最终日志后补 | 不用 CPU 回退冒充 WebGPU/WebGL2 |
| 本项目 vs Sketch | `native-canvas-difference.json`：zoom alpha 最大 9/10；噪声叠色 RGB 最大 38/61 | **FAIL：原生视觉完全一致仍未达成**。可移植核和现有线性合成不等于 Sketch 的原生重建/叠色 |

早期失败保留：初版源范围裁剪、旧结构误判、测试入口错误信息匹配、噪声 tile=64 与原尺寸 sentinel=0 的测试预期、示例的非 UUID ID 被真实 UI 拒绝。修正后的画布样本使用正式 UUID；没有放宽节点 ID 校验。

`canvas-fixture/fixture.sketch` 是自建的小型合法 Sketch 容器，含两个缩放模糊和两个图片噪声画板。原始 111/117 只读。GUI 通过 CUA 操作真实输入、撤销重做、保存/重开/导出，未注入私有编辑器状态。

## 后续仍未完成

原生 Gaussian/Motion/Zoom 重建与叠色像素校准、缺少原始贴图的历史 Noise Fill 迁移、段落/彩色字形、inferred/modern layout、原型/overlay、库更新和复杂组合矩阵。完整 G2/G4/G5/G7 以及物理显示延迟没有被本增量关闭。

旧 FD 续验：`old-fd-noise-regression.log` 确认历史保留列表里的已建模普通填充不会重复插入，也不会复活已删除的填充；已保存的原生渐变证明可识别同类残留。未知/真正未支持的噪声数据继续保留。增量同步见 `old-fd-fix-integration.json`。


## 主目录集成与 GUI 续验

- 已按 `integration.json` 合入 37 个变更/新增文件；GPU renderer 用精确基线三方合并，保留并发诊断与滤波改动。未复制继承工作树改动覆盖主目录。
- 主目录 `main-build.log` 完整构建通过，`main-build-identity.json` 记录的 2254 个源码输入在核验时全部匹配。原生核心 16 项（zoom 7、noise 1、spatial 5、color 3）与客户端 16 项通过；`main-metal.log` 的普通/HDR/偏心/仿射与裁剪路径通过。
- 实际 GUI：焦点 X 25%→70%，强度 20→35→撤销20→重做35；新增填充选择“噪声图片预设”后变成标准 image，撤销/重做恢复 solid/image；移除旧噪声层后最终仍是两层填充，噪声不透明度改到 30%。
- 保存下载 `gui-saved.fd`，再由主目录生产 bundle 打开，所有参数与两层填充都保留；主目录另验证 35→25→撤销35。625% 与缩回 200% 都达到清晰状态，截图见 `gui-noise.jpg`、`gui-zoom.jpg`、`main-gui-zoom.jpg`。
- `main-gui-export.sketch` 由主目录 GUI 导出。`main-native-pixels.json` / `gui-native-pixels.json` 证明 4 张画板在 Sketch 原生渲染后与对应修改过的原生参考全通道零差异。这证明**原生文件往返**，不替代上表中仍失败的本项目/Sketch 视觉等价。
- 浏览器 `zoom-webgpu-standard.json` / `zoom-webgl2-standard.json` 各 4 例、两个 HDR 文件各 2 例，以及 WebGPU 裁剪/WebGL2 preview 各 2 例通过。使用生产 KernelClient，显式核对实际 backend；managed 案例核对原始 float，未用 SDR 字节通过掩盖 HDR 截断。

最终旧 FD 修复后的构建为 `main-build-final.log`，2254 个构建输入全部匹配（`main-build-identity-final.json`）。主目录旧 FD 回归通过；最新互通总回归见 `main-interop-final.log`。最终构建重新载入后的画布见 `main-gui-final.jpg`，按门分类、命令、退出码、hash 见 `verification.json`。本轮来源字段当前 hash 见 `final-source-hashes.json`。
