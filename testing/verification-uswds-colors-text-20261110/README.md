# USWDS colors text baselines (issue #82)

Linux cloud VM. No Mac, Sketch, Electron, or Metal. The full-page native export that produced the historical 1.31% figure is not in this tree, so that screen was not re-run and the issue stays open.

## Independent reference

Public file `color reference/uswds-colors.sketch` from [uswds/uswds-for-designers](https://github.com/uswds/uswds-for-designers). Page `USWDS colors`, artboard `uswds-colors` (3193×3821). Text is unembedded Public Sans and Roboto Mono. Sketch stored native text previews in `text-previews/text-previews.pdf` (Quartz PDFContext, macOS 10.15.7, 2020-11-02).

Those text matrices are the reference. They are not this renderer's output. For the fixed line boxes that dominate the page, the drawn baseline is the nearest document point of half-leading, and x stays fractional:

| Text | Face | Size | Line box | PDF baseline | PDF x |
| --- | --- | ---: | ---: | ---: | ---: |
| `50v` | Public Sans Regular | 12 | 12 | 10 | 0.458 |
| `5` | Public Sans Regular | 14 | 24 | 17 | 0 |
| `blue cool` | Public Sans Light | 20 | 24 | 19 | 0 |

`50v` is PDF page 1, 22×12 pt. Poppler 24.02.0 `pdftoppm -r 72` rasterized that page once. That PNG is the pixel reference for the crop. It is Poppler's raster of Sketch's vectors, not a Mac screen capture.

## What was wrong

With the same Public Sans files, main `ccaa2ea1` already matched x (0.458 and 0). It drew the unrounded half-leading baseline:

| Text | Main y | Absolute error vs PDF |
| --- | ---: | ---: |
| `50v` | 10.350 | 0.350 |
| `5` | 17.075 | 0.075 |
| `blue cool` | 19.250 | 0.250 |

Color was already the encoded value. The opaque text core was `[46, 46, 46, 255]` (`#2e2e2e`). A 16×16 swatch `color(srgb 0.9058823529411765 0.9490196078431372 0.9607843137254902)` was `[231, 242, 245, 255]` on both analytic and figma profiles.

## Change

Sketch text whose paragraph minimum and maximum line heights are equal and positive now sets `lineBoxBaseline` to `nearest-point`. Layout rounds only that baseline. Authored paragraphs without the flag stay unrounded. x is not snapped. Thresholds are unchanged. The default font substitution for a missing face is unchanged.

## Candidate vs main

Same fonts, same 1× viewport, same channel thresholds (`delta > 0`, `> 1`, `> 2`).

| Check | Main | Candidate |
| --- | ---: | ---: |
| `50v` baseline error | 0.350 | 0 |
| `5` baseline error | 0.075 | 0 |
| `blue cool` baseline error | 0.250 | 0 |
| `50v` x error | 0 | 0 |
| Analytic crop, delta > 0 | 139 / 264 | 130 / 264 |
| Analytic crop, delta > 1 | 136 / 264 | 121 / 264 |
| Analytic crop, delta > 2 | 132 / 264 | 117 / 264 |
| Figma crop, delta > 0 | 131 / 264 | 127 / 264 |
| Figma crop, delta > 1 | 130 / 264 | 124 / 264 |
| Figma crop, delta > 2 | 124 / 264 | 120 / 264 |
| Text core / swatch | exact | exact |

Commands:

```
USWDS_FONT_DIR=/tmp/uswds/fonts cargo test --locked --manifest-path design-studio/Cargo.toml -p futureox-design-kernel --test sketch_uswds_colors_measure -- --nocapture
cargo test --locked --manifest-path design-studio/Cargo.toml -p futureox-design-kernel --test sketch_uswds_colors_measure --test sketch_native_display --test sketch_native_preview_contract --test sketch_text_attrs --test sketch_text_behaviour --test text_paragraph
```

The second command exited 0 after the fix (3 + 4 + 5 + 4 + 7 + 4 tests).

## Not run

- Full artboard versus a Sketch native page export. The 1.31% / 71% figure was not remeasured.
- Mac, Electron, Metal, or a GUI.
- Roboto Mono glyph identity. The PDF subset did not shape `(0.178)` on this VM, so that face was not used as a pixel oracle. Its PDF baseline is still the same nearest-point rule (size 12, line 16, baseline 13).
