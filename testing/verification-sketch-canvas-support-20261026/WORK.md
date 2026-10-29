# Sketch 画布支持实施记录

用户授权：将 2026-10-26 覆盖审计列出的画布特性接入实现。用户已确认缩放、平移目前恢复；保留交互回归，不把旧症状当成本轮已复现故障。

基线：2954a77 + baseline.json 记录的 10 个继承工作树文件；在附属 worktree 实施，合回前按文件前置 hash 检查。不得覆盖其他任务后续工作。

## 待完成链路

- [ ] 图案缩放：导入、真实采样、Inspector 编辑、往返
- [ ] 普通 Sketch blur 的单位：导入与 SVG/画布一致，保留其他格式及既有 FD 语义
- [ ] 背景 blur saturation
- [ ] Motion blur / Zoom blur：模型、支持域、CPU/GPU、画布参数、导出
- [ ] Sketch colorControls：层合成后的颜色调整、作用域/色域、画布参数、往返
- [ ] Sketch noise fills：真实填充采样、顺序/透明度、编辑、往返
- [ ] 段落文本：每段对齐/行高范围、垂直对齐、tightening
- [ ] 彩色字体/emoji：彩色字形生产路径与字体资源约束
- [ ] Inferred Group Layout：解析为可执行布局，组件/编辑/撤销
- [ ] Modern pins/sizing/flex：确切枚举及坐标语义、可执行约束
- [ ] Hotspot / Flow 动画与 overlay 位置：画布/原型运行及原生往返
- [ ] Symbol 库更新：已授权本地库源到现有实例更新，保持覆盖
- [ ] 复杂混合/蒙版/透明/阴影组合的真实参考验证
- [ ] 全量组合构建、实际 WASM、真实文件导入/编辑/撤销/保存/导出/重开
- [ ] 实际画布缩放/平移/连续编辑回归
- [ ] 主目录 hash 守卫集成及最终组合验收

每项分别记录实现、单元/原生、硬件 GPU、GUI、Sketch oracle 状态；没有证据不能勾选。保留现有浮点/HDR、采样、工作集预算、默认关闭实验与数据所有权。原始用户文件只读。

## 第一组进展（已合回并构建，尚非全部支持）

- 图案缩放已接入现有 tile.size，导入/像素变化/编辑后 Sketch 往返原生用例通过。坏图片仍只保留原始比例并报告。
- 颜色调整新增 schema 17、ColorControls、Rust 数学/WASM/GPU/SVG/Inspector。Core Image 实测 luma=(.2125,.7154,.0721)，原生 hue 矩阵与 SVG hueRotate 不同。HDR 不截断。
- Sketch 原生导出证明 controls 仅在位图生效，普通矢量携带相同字段无效果；原生位图在编码后 RGB 运算。已限制 Sketch 导入作用范围、显式保存 space=srgb/display-p3，避免错误套用线性空间。
- 4 张 Sketch 2025.1.3 原生位图 PNG 与 Rust 输出全通道零差异（color-sketch-cpu-pixels.json）。目前是小合成不透明单色位图，复杂透明/图像/叠加组合尚未测。
- Metal 硬件 6 种组合（working/sRGB/P3 × foreground/background，含半透明、分数坐标、零半径）与 CPU 最终 RGBA 字节一致，见 color-metal-2.log；不等于全部 raw-float 逐位相等。
- CUA 真实 IAB/Chromium WebGPU 导入、饱和度 0→1、可见灰→蓝、撤销、重做、FD 下载与重开已执行。gui-check.json / gui-color-edited.jpg / gui-color-reopened.jpg / gui-saved.fd。初轮暴露 mode 60 未预热，已补 compositor-modes.ts 并加回归。
- 原生 Sketch 重开发现旧导出引用缺少 images/ 前缀（4 处 image ref），且标准模型丢失 bitmap 类；已修复共享图片引用并在可表达的纯位图条件下还原 bitmap，同时从 style fills 中只剔除原生位图本体。4 张原生导出后重开截图全通道零差异，见 color-native-roundtrip-pixels.json。早期缺图占位失败保留。
- TypeScript 检查通过；新客户端/渲染测试最早 10 项通过，后加 pipeline-preparation 回归在 color-client-2.log；颜色原生集成 3 项通过；interop 原有 46 项通过、1 ignored。
- 当前 browser tab handle sketchCanvasTab，IAB ID 2 / tab 1；本轮自己的 Vite 127.0.0.1:1438（exec session 89466）。浏览器视口会随面板缩窄，尚未设置 viewport override。Chrome connector 不可用，未操作用户 Chrome 标签。CUA 文档已经读取。
- WASM 构建 wasm-build-2.log 已成功，但其后又修改了 interop 的 bitmap 类与 ZIP 图片引用、shared style writer；最后集成前必须重建，不把旧 WASM 证明成最新互通。
- 第一组已按 integration.json 合回主目录；main-build-2.log 完整桌面构建通过，主目录生产前端和原生 Sketch 导出已复核。之后的并发改动单独处理，不回写整份旧工作树。
- 仍需检查：111/117 往返新结果、最新 interop/颜色回归、SVG P3 编码域表达、半透明 bitmap 参考、共享样式、完整组合构建及 Electron，随后继续下述未完成特性。用户要求全部支持，不能将第一组当作全部完成。

## 续轮

继续普通/运动/缩放模糊和噪声填充。冻结新的 worktree 文件身份；先用原生 Sketch 的透明脉冲图测量半径、方向与中心语义，再接生产 CPU/GPU/导出路径。没有将第一组当作全部完成。


## 第二组已集成，验收继续

高斯/运动模糊、schema 18、新版 Sketch blurs 数组和共享样式已按文件 hash 守卫合入主目录；保留并发的大半径滤波及诊断改动。原生导出 19 画板零差异；本项目画布与 Sketch 核仍有差异，不标全支持。Metal 8 个普通加 4 个 HDR 仿射用例通过，浏览器/实际 GUI/主目录最新构建见 [第二组记录](../verification-sketch-effects-20261026/README.md)。zoom、noise、文本、布局、原型和库更新保持未完成。


## 第三组 · 2026-10-26/27

缩放模糊、焦点/无量纲强度、源采样规划以及现代噪声图片预设已接入；详见 [第三组记录](../verification-sketch-zoom-noise-20261026/README.md)。旧 noiseIndex 不等于现代在用填充，普通填充的残留字段改为原位保存，避免重复插层。源裁剪旧差 120、新差 0；局部编辑不扩大到全页。此处不关闭原生像素完全一致、历史噪声纹理迁移、文本、布局、原型/库及完整验收矩阵。


## 第四组 · 2026-10-27

分段/垂直文本、标准 paragraphStyle、支持的现代 sizing/pins、hotspot/四向导航和本地 Sketch 库更新已集成并完成主目录实际验证，见 [第四组记录](../verification-sketch-text-layout-flow-20261027/README.md)。保留实例覆盖与图完整性，真实 111/117 往返通过。原生重导出 7 画板差 0，跨渲染器字形仍不等价；彩色字体、tightening、完整 Smart Layout/Relative、overlay 原生位置/动画和全矩阵继续待完成。
