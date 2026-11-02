# Figma document model (2026-11-02)

This increment aligns the authored document with Figma file structure: one file, ordered pages, hidden canvases, shared styles, component sets, and file metadata. It does not change raster budgets, tile navigation, or experimental render flags. It does not close 33 ms visible P95, 100 ms refinement, or full G2/G5.

Schema stays 1–20. New facts use fields that already exist (`pages`, `guides`, `designSystem.styles`, `styleRefs`, `componentSet`, `component.variants`). `designSystem.sketchContainers.figDocument` is an inert receipt. Sketch export skips that key and `figRetainedStyles`, so they are not written into `document.json` as Sketch containers.

## What was missing

| Figma file fact | Before | This increment |
| --- | --- | --- |
| Document name and source guid | Native import always used `Imported from Figma` / `imported-fig`. Browser import used the filename. | Name comes from the DOCUMENT node when it fits the 200 UTF-16 limit. The guid and color profile are stored on the receipt. The editor document id stays a local id. |
| Pages | CANVAS records already became ordered pages with a background. | Page guides (`X`/`Y` + offset) become ruler guides and raise schema 11. |
| Hidden canvases (`internalOnly`) | The canvas and every `internalOnly` record were dropped. Masters that lived only on that canvas became unreachable and the import failed, or they disappeared. | An internal canvas is a real page. The page list and the initial page skip it. The last visible page cannot be deleted while a hidden page remains. Other `internalOnly` records, including unknown types on a user page, stay out of the scene. |
| Shared styles | `inheritFillStyleID`, `inheritTextStyleID`, and `inheritEffectStyleID` were ignored. | FILL, TEXT, and EFFECT styles become design-system styles and `styleRefs`. A style with no canvas parent is a library entry, not a layer. |
| Stroke and grid styles | Dropped. | STROKE is stored as a paint style's `strokes` (schema 12) and is not applied to fills. GRID and EXPORT are named in `figRetainedStyles` and a note. |
| Component sets | `COMPONENT_SET` / `isStateGroup` stayed ordinary frames. `VARIANT` property defs rejected the file. | Children named `Key=Value` become one component set with shared axes. `VARIANT` defs are set metadata, not layer properties. A set whose names do not parse stays a frame and is noted. |
| Publish keys and variables | Dropped. | `componentKey` and `boundVariables` are source metadata. Top-level `variables`, `variableCollections`, `variableSets`, and `variableModes` are copied into the receipt up to 256 KiB. They do not execute. |
| Save/open | FD already round-trips the document struct. The imported graph did not contain the facts above. | JSON and FD decode restore name, pages, guides, styles, component sets, and the receipt. |

Still not claimed: Display P3 documents (still rejected), executable variable modes, grid-style layout, applying a stroke style to strokes, or pixel parity with Figma.

## Checks

Ran from this tree:

- `cargo test -p futureox-design-kernel --test fig_interop_contract` — 10 passed, including `figma_document_pages_styles_component_set_and_save_open` (JSON and FD reopen) and the native `figma-materials-native-2026-10-08.fig` / `fig-interop-v106.fig` admissions.
- `cargo test -p futureox-design-kernel --lib fig::` — 59 passed. `gradient_transform_maps_onto_paint_transform` still fails: the October 30 linear-gradient invert does not match the October 19 expected matrix. That failure is older than this change.
- `vitest run src/fig-document.test.ts` with an empty setup file — 2 passed (hidden page, styles, component set, JSON reopen). The shared Vitest setup loads `public/kernel/design_kernel_bg.wasm`, which is not in this tree, and `wasm32-unknown-unknown` / `wasm-bindgen` are not installed here. Browser page-list clicks were not run. `PageList`, page delete, and the editor's initial page all call `userPages` / `canDeletePage`, which the unit test covers.
