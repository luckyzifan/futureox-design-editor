# sRGB tagging and per-run font metrics — 2026-11-02

Path: [docs/COLOR_SPACE_SRGB_PATH.md](../../docs/COLOR_SPACE_SRGB_PATH.md).

This pass tags sRGB samples and keeps FIG per-run letter spacing and line height. It does not change unmanaged compositing, tile budgets, or experimental flags. Display P3 is still not the default PNG. 33/100ms and full G2/G5 were not run and are not closed.

## Color

- 8-bit PNG keeps the `sRGB` chunk (perceptual). 16-bit sRGB output also writes that chunk, plus ICC and cICP. Display P3 output keeps cICP and ICC and does not write an sRGB chunk.
- JPEG gains one APP2 `ICC_PROFILE`. WebP is wrapped as VP8X + ICCP. PDF page `DefaultRGB` and RGB images/shadings use `/ICCBased` sRGB (`/N 3`).
- A JPEG that already has an RGB ICC profile keeps that profile. Untagged JPEG RGB is declared sRGB and not re-encoded.
- Untagged 8-bit images embedded in vector PDF stay byte-for-byte and are declared sRGB. A non-sRGB cICP or an ICC profile is converted first. HDR cICP fails that image.
- SVG root and gradients set `color-interpolation="sRGB"`. Color-control matrices stay `color-interpolation-filters="sRGB"` when `space` is omitted. Display P3 controls are still rejected for SVG.

## Fonts

Schema 21. A text run may set `letterSpacing` in design pixels and `lineHeight` as a multiplier of that run's font size. FIG `PIXELS`, `PERCENT`, and `RAW` map onto those fields (100% and RAW 1 are one em, not font-metric auto). Tracking is still once per cluster, and line width still drops the last cluster's tracking. A line with any line-height override uses the max resolved pixel height. Lines without an override keep the node font-size floor, so existing text does not move.

### Still open

- Omitted Figma Auto line height stays the editor 1.35 multiplier, not the face's ascender − descender + line gap.
- Extra line-box space stays below the baseline (no CSS/Figma half-leading).
- Color glyphs and emoji outside the fallback face stay `.notdef`.
- Italic is a face name, not a synthesized slant.
- Per-run alignment, OpenType features, and variation axes stay on the node style.
- Fonts are not downloaded. Matching is embedded bytes, bundled Poppins, or a face the user loads.

## Checks

Ran on the native `futureox-design-kernel` test library (`cargo test -p futureox-design-kernel --lib`), toolchain 1.96.1:

| Filter | Result |
| --- | --- |
| `png_records_srgb_and_preserves_every_byte_of_a_ramp` | passed |
| `encoders_preserve_dimensions_alpha_and_pdf_physical_size` | passed (JPEG `ICC_PROFILE`, WebP `VP8X`/`ICCP`, PDF `DefaultRGB` `/ICCBased`, decoded pixels unchanged) |
| `pdf_export::tests` (9 tests) | passed |
| `run_tracking_and_line_height_override_node_metrics` | passed |
| `per_segment_line_height_and_letter_spacing_are_kept` | passed |

No browser canvas, hardware GPU, or whole-editor latency run. The WebAssembly package is built by `design-studio/scripts/build-web.py` and is not stored in git; it was not rebuilt here. Export tagging and schema 21 admission run in that package, so a host must rebuild the kernel before the editor binary matches these tests. Frontend `vitest` was not run: this environment has no installed client `node_modules`. The TypeScript importer mirrors the Rust FIG test above. `33/100ms` and full G2/G5 were not run.
