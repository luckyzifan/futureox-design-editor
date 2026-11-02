# FIG import parity (2026-11-02)

This increment aligns the browser `.fig` importer with the native reader on the common node and style surface. It does not change zoom, tile navigation, GPU budgets, or experimental render flags. It does not close 33 ms visible P95, 100 ms refinement, or full G2/G5.

`01有料素材.fig` is not in this tree. The committed fixture `testing/fixtures/design/figma-materials-native-2026-10-08.fig` (386 nodes: rounded rectangles, frames, vectors, one ellipse) still imports. Its schema is the encoder for the new regression scenes. Those scenes are not an external pixel oracle.

## What changed

Browser `importFig` now follows `design-studio/crates/design-kernel/src/fig.rs` for:

- `stackReverseZIndex: true` reverses authored children after assembly. The flag is stored as inert `designSystem.sketchContainers.nodeMetadata`, not as a variable binding.
- `stackPrimaryAlignItems` `SPACE_EVENLY` and `SPACE_AROUND` map to `space-evenly` and `space-around`. `SPACE_EVENLY_CSS`, `GRID`, `BASELINE`, and weighted grow still reject.
- `textAlignVertical` `CENTER` / `BOTTOM` map to schema 20 `verticalAlign` on both importers. `TOP` stays the default.
- `toggledOnOTFeatures` / `toggledOffOTFeatures` become harfbuzz toggles (`liga`, `-dlig`). `fontVariations` become four-character axes. `wght` stays on the weight field.
- A node-level `UNDERLINE` or `STRIKETHROUGH` becomes one run when the text has no styled runs. A run that already exists keeps the run and records the overlap.
- Non-uniform `borderStrokeWeightsIndependent` keeps `strokeWeight` and records `borderStrokeWeightsIndependent(non-uniform)`. Uniform per-side weights still become that single width. The kernel still has one stroke width.
- Effect `blendMode` other than `NORMAL` is recorded as `effectBlendMode=...`. The effect itself is kept. Shadow clipping still does not branch on `showShadowBehindNode`.
- `prototypeInteractions` are stored as `prototypeFlow` JSON in the same inert metadata. They are not a prototype runtime.
- Node kinds that already had a native payload check: slice, sticky, code block (`JAVASCRIPT` / `TYPESCRIPT` / `JSON` / `PYTHON` / `RUST` / `PLAINTEXT`), supported whiteboard shapes, table within the kernel budget, connector magnets and elbow/straight/curved. Unknown names, painted slices, oversized tables, and unsupported whiteboard shapes still reject.
- Geometric stand-ins (`MEDIA`, `HIGHLIGHT`, `WASHI_TAPE`, `STAMP`, `COMPONENT_SET` when that enum exists, and the rest of the native stand-in list) import as their kernel kind and warn that the specialized content is not executed.

Receipts live in `nodeMetadata` so they are not executable `bindings`.

## Parity checklist

| Surface | Imports | Still open |
| --- | --- | --- |
| Frames and groups | `resizeToFit` frames without a stack are groups. Auto-layout and `isStateGroup` stay frames. Sections stay sections. | `SECTION_OVERLAY`, slides, code components, and the rest of the v106 node enum still reject by name. |
| Components and instances | Embedded `SYMBOL` / `INSTANCE`, property defs, and the supported overrides. State-group frames stay frames. | This fixture's schema has no `COMPONENT_SET` member. Variant axes are not an executable component set. External libraries and unbound instances still reject. Variables and shared styles are not resolved. |
| Text | Characters, horizontal align, case `UPPER`/`LOWER`, line height, letter spacing, styled runs, node decoration, vertical align, OpenType toggles, variation axes. | `TITLE`, `SMALL_CAPS`, and `SMALL_CAPS_FORCED` warn. Per-run line height, letter spacing, and non-solid run fills warn. Fonts stay unmatched until a real face is installed. |
| Vectors | Network blobs, corner radius when the decoder accepts it, fill geometry when the winding rule is uniform. | Mixed fill windings and unsupported corner contours still reject or warn. |
| Fills, strokes, effects | Solid, linear, radial, angular, diamond, image fit/tile within the existing limits. Caps, joins, dashes, markers. Drop and inner shadow, foreground/layer blur, background blur, glass, grain. | `REPEAT`, `SYMMETRY`, `NOISE`, and `CUSTOM` effects reject. Per-side stroke geometry is recorded, not drawn. Effect blend is recorded, not drawn. Display P3 and non-default gradient interpolation still reject the file. |
| Auto-layout | Horizontal and vertical, padding, wrap, hug/fixed/implicit, child fill and stretch, min/max, absolute children. `SPACE_BETWEEN`, `SPACE_EVENLY`, `SPACE_AROUND`. Reverse z-index. | `GRID`, baseline, `SPACE_EVENLY_CSS`, child margins, and grow other than 0 or 1 reject. |
| Constraints | `MIN`, `CENTER`, `MAX`, `STRETCH`, `SCALE`, with the parent reference size. | `FIXED_MIN` / `FIXED_MAX` reject. |
| Boolean operations | Union, subtract, intersect, XOR as exclude. | Mixed paint geometry on the boolean result still uses the existing vector path. |
| Masks | Alpha, luminance, and outline. Trailing masks are wrapped so they do not erase earlier siblings. | A non-leading mask inside auto-layout or a boolean is kept in source order and warned. |
| Images | PNG, JPEG, and WebP by hash or blob. Stretch, fit, fill, and the limited tile modes. | Spacing, scale, rotation, and non-start tile alignment still reject. |
| Slices, connectors, whiteboard | Empty slices. Connectors with magnet anchors. Stickies, supported shapes, in-budget tables, and the mapped code languages. | Painted slices reject. Curved connectors become straight and say so. `AUTO` magnets use the center anchor and say so. Unmapped code languages become plain text and say so. |

## Verification

Ran on this tree:

- `cargo test -p futureox-design-kernel fig:: --lib` → 63 passed. That includes reverse z-index, `SPACE_EVENLY` / `SPACE_AROUND`, vertical alignment at schema 20, the Rust code-block language, and the existing stroke, mask, boolean, connector, and text cases.
- One assertion in `gradient_transform_maps_onto_paint_transform` expected the kiwi matrix. The importer already stores the inverse for linear paints, matching the browser path. The assertion now checks that inverse. Import behavior did not change.
- `vitest` `import-fig-layout.test.ts`, `import-fig-text.test.ts`, `import-fig-nodes.test.ts`, and `import-fig-fidelity.test.ts` against a dev WASM build of this source → 64 passed. The pre-existing `fig-card-corners.bin` test failed before any assertion because `testing/verification-interaction-layout-20261030/fig-card-corners.bin` is not in the tree. That failure is not from these edits.
- `tsc --noEmit` in `frontend/design-client` → exit 0.
- `bun run build` (release kernel, `tsc --noEmit`, Vite) → exit 0. The kernel output is local and gitignored.

No GUI, hardware GPU, or G2/G5 run was part of this increment.
