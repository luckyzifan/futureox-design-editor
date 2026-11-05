# Color gamut and layer opacity — 2026-11-02

Builds on [sRGB tagging and per-run font metrics](../verification-color-fonts-srgb-20261102/README.md) and [the sRGB path](../../docs/COLOR_SPACE_SRGB_PATH.md).

This pass adds an optional Display P3 tag on export and aligns layer opacity with the Mac desktop model: the inspector shows 0–100, and that value multiplies fill, stroke, and shadow coverage. It does not change the 8-bit canvas color space, tile budgets, or experimental flags. Display P3 is still not the default PNG. 33/100ms and full G2/G5 were not run and are not closed.

## Color

- Default 8-bit PNG still writes the `sRGB` chunk. It now also embeds the canonical sRGB ICC profile.
- Export can request Display P3 without enabling document color management. The compositor still produces encoded sRGB samples. Those samples are converted to encoded Display P3 and written as 8-bit PNG with a Display P3 ICC profile and cICP `12/13`. There is no sRGB chunk.
- JPEG, WebP, and bitmap PDF follow that PNG tag. A Display P3 PNG is not relabeled sRGB. Other spaces still have to be PNG.
- A managed document keeps the existing 16-bit color output.
- The live 8-bit canvas stays `colorSpace: 'srgb'`. This is not a Display P3 framebuffer.

## Opacity

Mac desktop Figma shows layer and paint opacity as 0–100%. The stored value stays 0–1.

- Layer, fill, and stroke fields show that percent. Shadow and inner-shadow opacity use the same 0–100 control, labeled 不透明度.
- Effective coverage is layer opacity × paint opacity × the color's own alpha. Ancestor opacity is included.
- On the byte shadow path, the shadow color's alpha now multiplies the effect opacity. The linear path already did this. Layer opacity is applied when the finished layer, including the shadow, is composited.
- Vector PDF writes that product into `/ca` and `/CA`. SVG wraps a parent whose opacity is below 1 around its children so the value is not also written on the parent shape.
- Vector PDF still ignores effects. Overlapping semi-transparent children are not flattened before the group opacity; the raster path does that isolation. Gradient stops that do not share one alpha are not forced into one PDF ExtGState.

## Checks

Ran on the native `futureox-design-kernel` test library (`cargo test -p futureox-design-kernel --lib`), toolchain 1.96.1:

| Filter | Result |
| --- | --- |
| `png_records_srgb_and_preserves_every_byte_of_a_ramp` | passed (sRGB chunk, `iCCP`, decoded ramp unchanged) |
| `unmanaged_display_p3_export_converts_and_tags` | passed (P3 cICP and ICC, no sRGB chunk, sRGB red is not stored as 255,0,0, JPEG carries the Display P3 profile) |
| `layer_fill_color_and_shadow_opacity_multiply` | passed for `analytic` and `figma` (fill alpha about 32/255, shadow alpha about 8/255) |
| `layer_fill_and_ancestor_opacity_include_color_alpha` | passed (`/ca 0.125`) |
| `parent_opacity_wraps_children_once` | passed |
| `export::tests`, `svg_export::tests`, `pdf_export::tests` | passed |
| `noise` (preset and Sketch round-trip) | passed |

The WebAssembly package is built by `design-studio/scripts/build-web.py` and is not stored in git. It was not rebuilt here. A host must rebuild the kernel before the editor binary matches these tests. Frontend `vitest` was not run: this environment has no installed client `node_modules`.

No browser canvas, hardware GPU, or whole-editor latency run. `33/100ms` and full G2/G5 were not run.
