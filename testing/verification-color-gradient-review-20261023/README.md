# 色彩、渐变与全量 GLSL 生成器核查（2026-10-23）

本轮只核查和运行已有测试，没有修改产品代码、生成的 shader、实验开关或预算。基线为 `3a264ae625ee3a89f78f3e935ca872f4ab0cf8cb` 加当时工作区的未提交改动；64 色标属于这些工作区改动，不能当成该 commit 单独具备的能力。

核对期间 1594 个源码/构建输入文件 hash 未变化，见 [source-before.json](source-before.json)、[source-after.json](source-after.json)。命令、退出码、日志 hash 在 [results.json](results.json)；工具链及实际原生测试二进制 hash 在 [build-inputs.json](build-inputs.json)。原有[增量合并验证记录](../verification-increment-0741-1338-20261023/README.md)保持不变。

## 当前支持矩阵

| 范围 | 当前实现 | 边界 |
| --- | --- | --- |
| 色彩空间 | Rust 和 TS 模型均有 12 种：sRGB、线性 sRGB、Display P3、线性 P3、Rec.2020、Rec.2100 linear/PQ/HLG、Adobe RGB、ProPhoto RGB、XYZ D50/D65 | 可编辑文档颜色不是任意 CSS 解析器；支持 `#RRGGBB` 和受限数字 `color(space r g b / alpha)`。没有原生 Lab/Oklab/Oklch/CMYK 文档颜色模式 |
| 透明度及 HDR | 非管理模式支持有界 sRGB 色值及 alpha；色彩管理模式以预乘、扩展范围线性 sRGB 工作，保留高于 1 及负的色域分量 | 输入分量、alpha 和 PQ/HLG 信号有边界；显示器上出现 HDR 仍需设备验证 |
| 色彩面板和导出 | “色彩与 HDR”可选择默认空间、参考白和峰值；有 sRGB/P3/Adobe RGB/ProPhoto/PQ/HLG 的 16 位 PNG 导出入口 | 修改默认空间会重新解释 Hex；已有 `color()` 保持自身空间。启用色彩管理会改变混合/渐变外观。入口存在不等于本轮完成 GUI 导出验收 |
| 渐变类型 | 线性、径向、角度、菱形；角度、完整仿射变换、位置、增删色标；可用于填充/描边 | 没有网格/自由渐变，也没有每个渐变独立选择 Oklab/Oklch 等插值空间的模型字段 |
| 渐变色标数量 | 当前工作区上限 64；33–64 色标用独立两行 RGBA32F 参数表，小列表继续使用 uniform；TS、WGSL、GLSL、原生 compositor 均有相应代码 | 36/64 模型往返、65 拒绝、四类渐变分块采样及 mock 参数表通过；尚无本轮 33–64 色标硬件像素一致性结论 |
| 色标 alpha/广色域 | 内核以色标 `color(...)` 表达 alpha 和色彩空间；FIG 与 Sketch 有透明色标导入路径 | 普通 Hex 色标仍使用原生 `input type=color`，未提供独立色标 alpha 控件或从 Hex 切换到扩展输入的入口；已有扩展色标可文本编辑 |
| FIG 导入 | 四类渐变、色标 alpha；有实测 Figma 导出参考图的原生渲染回归 | 文档色彩 profile 只接受未指定/LEGACY/SRGB；非 DEFAULT 插值空间明确拒绝。内核支持 P3 不等于 FIG P3 导入已支持 |
| Sketch 导入/导出 | 有 sRGB/P3 profile、透明渐变、适应性颜色元数据的原生测试 | 测试也验证不支持的 profile、HDR 和实际色域损失会拒绝；不是任意 Sketch 色彩无损互通 |
| SVG 导入 | 线性、中心径向、pad、仿射变换、本地模板继承；当前上限 64 | 仍拒绝独立 stop-opacity、stop currentColor、repeat/reflect、偏心/非零焦点半径径向渐变、linearRGB。旧 SVG 审计文档的 32 色标上限已落后于当前工作区 |

源码入口：[颜色模型](../../frontend/design-client/src/color.ts)、[Rust 颜色内核](../../design-studio/crates/design-kernel/src/color.rs)、[色彩面板](../../frontend/design-client/src/ColorPanel.tsx)、[Paint 模型](../../design-studio/crates/design-kernel/src/scene.rs)、[属性面板](../../frontend/design-client/src/Inspector.tsx)、[色标输入](../../frontend/design-client/src/ColorInput.tsx)、[FIG 导入](../../frontend/design-client/src/import-fig.ts)、[SVG 渐变导入](../../frontend/design-client/src/svg-gradient.ts)。

## 尚存的问题与证据

1. **全量 GLSL 生成器仍然 FAIL，而且不止空参数一处。** `softwareRasterByte()->bool` 的空参数被 `split(',')` 得到一个空字符串，再按冒号解包失败。仅在内存中略过空参数后，MATERIAL MATH 仍因未转换构造失败：包括推断类型的 `let` 和 `bitcast<vec2<u32>>`。因此不能把“跳过空字符串”当成完整修复；还需补全受限转换、生成一致性和 GLSL 编译/像素验证。当前故障会阻塞材质/色彩/渐变所在的整段生成检查，但不直接证明现有运行时像素错误。诊断没有写入 shader，也没有绕过生产 guard，见 [诊断结果](generator-diagnosis.json) 和 [可复跑脚本](inspect-generator.py)。
2. **相同位置的色标仍有 SVG 边界语义缺口。** `GradientCoordinates::locate` 使用 `partition_point(|offset| *offset < t)`；当 `t` 恰好等于多个色标的共同 offset 时会选到较早色标。这与既有 [SVG 审计记录](../../docs/SVG_COMPATIBILITY_AUDIT.zh-CN.md) 中尚未关闭的问题一致。本轮是静态确认，未新增此边界的像素测试，不能用其他渐变测试通过关闭它。
3. **面板展示不能作为内核颜色一致性的证明。** 渐变色带仍通过浏览器 CSS `linear-gradient(...)` 显示；没有复用 Rust 的色彩转换、线性光插值与 HDR 显示编码。色标拾色器能力也弱于纯色填充；“添加色标”按钮尚未在 64 处禁用，超限依靠模型校验拒绝。这些是界面待完善项，本轮没有运行 GUI。

## 本轮验证

| 检查 | 结果 | 实际范围 |
| --- | --- | --- |
| Rust：color、figma_gradient、gradient_grid、gradient_stop_capacity、sketch_adaptable_color、sketch_color_profiles | **35 passed，0 failed，0 ignored** | 当前源码原生 CPU 测试；包括 HDR/负值、线性混合、色彩转换、参考渐变像素、36/64 色标往返、65 拒绝、分块参数一致性及 Sketch profile |
| 前端：gradient、svg-color、gradient-stop-table | **5 passed，0 failed** | TypeScript 数学、模拟 Canvas 颜色解析、模拟 GPU 上传；未调用 WASM 或硬件 GPU |
| rational / certified / bounded sampling 各自生成检查 | **PASS** | 对应单独目标；不是完整 vector GLSL 通过 |
| 全量 GLSL 生成检查 | **FAIL** | 空参数解析错误仍可复现 |
| 新 WASM、浏览器/Electron GUI、硬件 WebGPU/WebGL/native GPU、真实 HDR 显示、整编辑器导出与性能 | **NOT_RUN** | 不形成这些层级的新验收结论 |

复跑命令见 [results.json](results.json)。生成器深入诊断可执行：

```sh
python3 testing/verification-color-gradient-review-20261023/inspect-generator.py
```

后续优先补全生成器及生成/编译验证，再单独关闭重复色标边界、色标编辑入口和格式导入差距；64 色标还需匹配新 WASM 的真实应用及硬件像素验收。
