# Sketch 画布支持：第一组实现与验证

用户要求的全部画布特性仍在实施；本记录只覆盖图案缩放、位图颜色调整、背景饱和度，以及由原生往返暴露的图片引用修复。运动/缩放模糊、普通 Gaussian 参数/算法、噪声填充、完整文本、布局、原型和库更新尚未完成，见 [实施清单](WORK.md)。用户已确认此前不能缩放/平移的症状恢复。

## 已接入的生产路径

- Sketch `patternTileScale` 读取图片头尺寸后写入既有 `Paint.tile.size`，CPU/GPU/SVG/属性编辑复用现有采样路径。只读头信息，不为映射比例解码整张图片。导出从当前尺寸推导均匀比例，编辑后不会回放过期的原始比例；坏图片等无法确定尺寸的情况继续保留来源并报告。
- schema 17 新增 `Effect.colorControls`，覆盖亮度、对比度、饱和度和色相。Rust 生成系数，WASM、原生 GPU、WebGPU/WebGL2 shader 和 SVG 使用同一参数；Inspector 直接编辑既有 Editor 事务。没有改变 FD 容器版本、采样数、HDR 数据或资源预算。
- 色彩运算域显式保存。无 space 时是现有工作空间，Sketch 位图使用编码后 sRGB/P3；用现有色彩变换连接扩展线性工作像素。无条件裁剪负值或 HDR 值的做法没有采用。
- Sketch bitmap 的颜色调整原生生效，普通矢量携带同字段时原生不生效；导入不能一律把字段变成活跃效果。背景滤镜在半径 0、饱和度非 1 时仍须捕获背景。
- 浏览器 compositor modes 预热新增 mode 60。第一轮真实 GUI 抓到了漏预热的失败，修复后重新打开并验证；不以原生 GPU 通过替代浏览器路径。
- 导出纯位图时保留可表达的 bitmap 类，并从 style fills 中剔除位图本体，保留其余填充；原来四处图片引用改为真实归档路径 `images/...`。此前本项目自己的宽容读入器会接受裸文件名，但 Sketch 原生会显示缺图占位。

## 原生参考及实际结果

参考：本机 `sketchtool Version 2025.1.3 (203472)`。测试副本从 117 的合法容器/基本图层结构构造，内容替换为自建单色图片与独立效果，原件只读。它们属于小合成原生参考，不冒充复杂真实文档性能样本。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| Core Image 浮点颜色探针 | Rust 数学对照通过 | 显式 extendedLinearSRGB；基色、混色、负值、HDR、半透明、透明，7 组参数；误差上限 2e-6，仅参考 API 数值对照 |
| Sketch 原生 PNG → Rust PNG | 4/4 全通道零差异 | neutral、saturation0、contrast14、hue07，128×128 不透明单色位图 |
| 导入 → 导出 Sketch → Sketch 原生 PNG | 4/4 全通道零差异 | 同一参考集；早期裸图片引用失败保留 |
| 原生 Metal → CPU | 6/6 最终 RGBA 字节一致 | working/sRGB/P3 × foreground/background；含半透明、分数坐标、零半径背景滤镜；不是全场景 raw-float 逐位声明 |
| 图案比例原生生产测试 | 通过 | 比例改变真实像素；编辑尺寸后导出重开像素相同；不含实际 Sketch 纹理采样对照 |
| 浏览器 WebGPU GUI | 通过所述链路 | 文件选择器导入、选位图、饱和度 0→1 灰变蓝、撤销、重做、FD 下载与重开；200% 放大、滚轮平移、适合全部恢复 |
| 111/117 真实文件 | 导入→导出→导入通过 | 均未包含启用的颜色调整/非 1 图案比例；是原有功能回归，不证明新增特性在复杂场景的像素一致性 |

证据：[Core Image 探针](coreimage-color-probe.swift)、[CPU/Sketch 像素](color-sketch-cpu-pixels.json)、[Sketch 往返像素](color-native-roundtrip-pixels.json)、[Metal 日志](color-metal-2.log)、[GUI 记录](gui-check.json)、[编辑画布](gui-color-edited.jpg)、[重开画布](gui-color-reopened.jpg)、[缩放平移后恢复](gui-color-navigation.jpg)。

定向检查：颜色原生集成 3 项、颜色数学 2 项、interop 46 项通过（另 1 项 ignored）；客户端最新 12 项通过；TypeScript 通过。`real-111-roundtrip.log`、`real-117-roundtrip.log` 是单独显式运行的真实文件测试。主目录集成后的构建与检查另写 `main-*`，不借用 worktree 的通过记录。

## 已知边界

- 没有完成所有 Sketch 特性，也没有关闭完整 G2/G5。尚无复杂透明图片/多效果栈/渐变和全部混合模式的 Sketch 原生像素矩阵。
- WebGPU 和 WebGL2 已各实测 6 例，最终 RGBA 字节与 CPU 一致，且每例有非零可见变化。working 域原始浮点也一致；编码域存在最高 2.384185791015625e-7 的跨后端浮点差异，不能声称全部 raw-float 逐位相等。见 color-webgpu.json / color-webgl2.json。
- 普通矢量上的通用颜色调整属于本编辑器可执行能力；原生 Sketch 的同名样式仅在位图生效。非位图或多个颜色调整导出会报告原生表达限制。
- 编码后 P3 颜色调整不能直接当成 SVG sRGB 矩阵。严格矢量 SVG 对该导出范围明确拒绝；现有保留视觉效果的位图嵌入 SVG/图片导出仍是对应路径。其他页面的 P3 效果不应阻止当前导出。
- 多段段落属性、彩色字形、Inferred/现代布局、hotspot/完整 Flow 和库更新均未完成；本组没有用 raw bindings 冒充它们已在画布运行。
- 新增数据要求 schema 17，旧读取器应拒绝；不降低到旧 schema 让效果被静默丢弃。

## 来源、集成与恢复

基线为 `2954a77` 加 [baseline.json](baseline.json) 的已有工作树修改。附属 worktree 为 `sketch-canvas-support`。主目录并发修改的 pattern alignment 准入与本组 model/schema 改动做了三方合并，保留对方实现，见 `model-merge/`。

`integration-precheck.json` / `integration.json` 逐文件绑定实际前置与结果 hash，只应用本组文件，不覆盖源页面/工作台等并发任务。恢复时必须先确认目标仍匹配本组结果 hash，再用 `before/` 恢复；不覆盖后续修改。本轮没有制作安装包或宣称发行版本完成。

Apple 对颜色调整的运算顺序与工作空间约定见 [Core Image Filter Reference](https://developer.apple.com/library/archive/documentation/GraphicsImaging/Reference/CoreImageFilterReference/index.html)；实际系数、作用范围和编码域由本轮原生探针/Sketch 文件输出进一步核对。

## 中断前完成的主目录复核

第一组已按 integration.json 合入主目录。main-build-2.log 的完整桌面构建通过，main-build-identity.json 当时核对 2240 个输入一致（构建时间 2026-10-26T10:41:42.048Z）；后续并发改动不由此自动验收。主目录颜色集成 3 项、客户端组合 16 项通过。正式构建前端通过 CUA 导入、修改饱和度和导出 Sketch，再由 Sketch 原生渲染四张结果与预期全通道零差异，见 main-gui-check.json / main-gui-native-pixels.json。
