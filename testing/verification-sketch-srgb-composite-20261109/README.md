# Sketch sRGB 编码合成（2026-11-09）

对照 issue #80、#83。基线是当时的 `origin/main` `70f72c223bca7bd8554766bd0752833457339875`。

## 改了什么

Sketch `document.json` 的 `colorSpace` 1 只表示颜色是 sRGB。原生 Sketch 在这个编码空间里做 source-over。旧导入把它当成线性色彩管理，50% 深色叠白底会先解码再合成再编码。

现在：

- `colorSpace` 0 和未标记的 `colorSpace` 1 都走编码 sRGB 合成。`colorSpace` 1 记在 `sketchDocumentColorSpace`，再导出仍是 1。
- 只有本编辑器写出的 `userInfo.com.futureox.design-kernel.linearSrgbComposite` 才恢复线性 sRGB 管理。Display P3（`colorSpace` 2）不变。
- 原生预览不再把已经是编码 sRGB 的颜料放进线性合成。

没有放宽容差，没有改 HDR 拒绝，没有改蒙版几何。

## 实测

命令（debug 构建，`cargo test -p futureox-design-kernel`）：

```
--test sketch_srgb_composite
--test sketch_import_admission
--test sketch_color_profiles
--test sketch_blur_import
--test sketch_gradient_borders
--test sketch_radial_import
--test sketch_mask
--test sketch_text_attrs
--test sketch_text_behaviour
--test sketch_native_text_contract
--test sketch_native_display
--test sketch_native_preview_contract
--test sketch_shared_styles
--test sketch_format_contract
--test sketch_font_resources
--test sketch_compound_paths
--test sketch_adaptable_color
```

`sketch_srgb_composite` 3/3 通过。其余上列测试通过。

独立参考（不是渲染器自输出）：

- 源色 RGB(45,45,41)、alpha 0.5、白底。编码 source-over 是 RGB(150,150,148)。线性光再编码是 RGB(190,190,189)。
- 修复后 Analytic 16×16 中心像素是 `[150, 150, 148, 255]`。和 issue #80 记录的 Sketch 值一致，和旧线性结果差 40/40/41。
- 同一色块的 `colorSpace` 0 与 `colorSpace` 1 中心像素相同。
- 显式线性 sRGB 文档往返后仍走线性路径，50% 黑叠白与编码结果相差超过 20。
- 8×4 黑白棋盘原尺寸逐字节一致。半尺寸 4×2 内部像素是 128，不是线性滤波大约 188。

## 没跑或夹具缺失

- `Palette examples`、`multi-use-bitmap.sketch` 不在仓库，也不能在这台 Linux 上跑 Sketch。#81 的三行/四行、#83 历史 1.05% 没有用原件重测。
- `uswds.sketch` 在本机对照目录里。`color/system/*` 页没有文字图层；文字字体是未嵌入的 Public Sans / SF Pro。没有原生导出 PNG，#82 的 1.31% 筛查没有重跑。
- `testing/fixtures/design/sketch-color-controls.sketch`、`coreimage-color-controls-vectors.json`、`spectral-q4-natural-vectors.json`、`sketch-official/file-format-series/color-library.sketch` 不在树里。`color_controls`、`cargo test --lib`、`sketch_official_reference` 因此编不过。这不是这次删的。
- 前端 `vitest` 需要 WASM 绑定，这次没有重建，字体匹配单测未跑。产品导入仍走已有的 `matchBundledImportFonts`。

GPU 优先、CPU 兜底没改。这不是 33/100ms，也不是完整 G2/G5。
