# Sketch sRGB 编码合成（2026-11-09）

对照 issue #80、#83。基线是当时的 `origin/main` `70f72c223bca7bd8554766bd0752833457339875`。

## 改了什么

Sketch `document.json` 的 `colorSpace` 1 只表示颜色是 sRGB。原生 Sketch 在这个编码空间里做 source-over。旧导入把它当成线性色彩管理，50% 深色叠白底会先解码再合成再编码。

现在：

- `colorSpace` 0 和未标记的 `colorSpace` 1 都走编码 sRGB 合成。`colorSpace` 1 记在 `sketchDocumentColorSpace`，再导出仍是 1。
- 只有本编辑器写出的 `userInfo.com.futureox.design-kernel.linearSrgbComposite` 才恢复线性 sRGB 管理。Display P3（`colorSpace` 2）不变。
- 原生预览默认按编码 sRGB 填色。显式 `linearSrgbComposite` 仍保持线性管理和 `floatCompositing`。

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
- 仓库里没有 `testing/generate-font-fixtures.py`。依赖它的 `font-management`、`font-source-preservation`、`font-test-fixtures` 不能生成夹具。

GPU 优先、CPU 兜底没改。这不是 33/100ms，也不是完整 G2/G5。

## 2026-11-10 变基后的补充

基线是当时的 `origin/main` `fb2a2b982dd438b66afc7467aa802ce85576e471`。完整拓扑打开失败是：无色彩管理时 `color_settings()` 为 JSON `null`，PNG 行解码把它当成 `ColorSettings` 结构体，首批瓦片报 `invalid type: null, expected struct ColorSettings at line 1 column 4`。现在 `null` 走无管理解码，像素与 `Images` 的无管理路径一致，并且和线性解码不同。原生场景库可以重新打开这份文档。

显式 `linearSrgbComposite` 的 Sketch 预览和 display snapshot 保留线性 `ColorSettings` 与 `floatCompositing`。没有这个标记时预览颜色是编码值（0.125 仍是 0.125，不是线性解码）。

本轮实际命令与结果（debug，Linux）：

```
cargo test --locked --manifest-path design-studio/Cargo.toml -p futureox-design-kernel --lib image_rows::tests
```

10/10 通过。

```
cargo test --locked --manifest-path design-studio/Cargo.toml -p futureox-design-kernel --test sketch_srgb_composite --test sketch_native_preview_contract --test sketch_native_display
```

4 + 5 + 4 通过。

```
node --test frontend/design-desktop/test/sketch-preview-contract.test.mjs frontend/design-desktop/test/sketch-alpha-gradient.test.mjs
```

3/3 通过。

`sketch_import_admission` 本轮 11 通过、1 失败：`import_any_reports_archive_limits_instead_of_marker_miss` 得到 `Limit("compression ratio")`，不是 archive resource limit。该用例本轮未改。

随后 `git pull --rebase origin main` 停在 `bcb1a128`，并生成了 dev WASM。

```
vitest run src/bundled-import-fonts.test.ts src/font-catalog.test.ts src/font-matching.test.ts src/import-fig-fidelity.test.ts
```

4 个文件，50 通过，1 跳过。主机把预算钉在 4GiB 时，wasm32 把 `2^32` 截成 0，Sketch 再导入会报 `Limit("archive input")`。输入长度现在用可表示的 `usize`。`load_source_snapshot` 打开 colorSpace 1 源后，返回的设置 JSON 仍是 `null`，行解码和 `render_png` 都完成，错误串没有出现在打开结果里。

这不是 Mac 完整拓扑回放。#81 的行数和 #82/#83 的原生像素图仍然没有。
