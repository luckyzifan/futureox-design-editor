# Interop, transfer, MCP, and color notes (2026-11-02)

This increment is an analysis pass plus three small FIG fidelity fixes. It does not change zoom or tile navigation, GPU budgets, or experimental render flags. It does not close 33 ms visible P95, 100 ms refinement, or full G2/G5.

Checked source is the repository tree on this branch.

Ran:

- `cargo test -p futureox-design-kernel layer_blur_alias --lib` → `fig::tests::conversion_tests::layer_blur_alias_maps_like_foreground_blur` passed. The lib-test harness also needs `testing/verification-interaction-layout-20261030/topology-gaussian-leaf.json`, which is not in this tree; a temporary empty file was used only to compile and was not committed. That Gaussian test was not run.
- `vitest` `src/import-fig-fidelity.test.ts` and `src/import-fig-layout.test.ts` against a local dev WASM build of this source (`design-studio/scripts/build-web.py --profile dev`). The new stroke-cap and `showShadowBehindNode` tests passed, including WASM reopen. `import-fig-layout.test.ts` passed (31). One existing fidelity test failed before any assertion: `testing/verification-interaction-layout-20261030/fig-card-corners.bin` is not in the tree. That failure is not from these edits.
- `operation-coverage.test.ts` passed (14). `docs/OPERATION_COVERAGE_V1.json` only gains the optional effect field; the rest of that catalog was already behind the live descriptors (vector geometry, zoom blur, mask enum, stop count) and was not regenerated.

The generated WASM under `frontend/design-client/src/generated/` is gitignored. The `LAYER_BLUR` alias is enforced by the Rust unit test, not by a committed browser binary. The shadow-behind round-trip was checked with the local WASM built from this source, which already had the kernel field.

## Fixes in this increment

1. Browser FIG stroke caps now follow the native kiwi table in `design-studio/crates/design-kernel/src/fig.rs` (`stroke_cap`). `NONE` is butt. `ARROW_*`, filled triangle, diamond, and circle become an end marker and raise schema 8 when a marker is present. Unmapped caps such as `WASHI_TAPE_*` stay butt and emit a warning instead of an invalid `cap` string. Previously `String(strokeCap).toLowerCase()` turned explicit `NONE` into `none`, which `validStroke` and Rust stroke validation both reject.
2. Browser FIG import now keeps kiwi `showShadowBehindNode: true` on the effect. The kernel field already exists (`scene.rs`, serde `showShadowBehindNode`, omitted when false). Document validation accepts a boolean. The MCP effect object accepts the same optional boolean so `node.update` can round-trip it. The renderer still does not branch shadow clipping on the flag; that limitation is unchanged.
3. Native FIG import accepts `LAYER_BLUR` as the same kernel `blur` as `FOREGROUND_BLUR`. Modern `.fig` enums use `FOREGROUND_BLUR`. Older schemas and the REST/plugin name still say `LAYER_BLUR`; the TypeScript importer already mapped that name, and the native reader rejected the file.

## 1. Raster transfer copies

Default interactive tile, web and Electron:

`KernelClient` → render worker → preparation worker or native preparation → `design-kernel` FGSC (`gpu/packet.rs` `encode`) → `postMessage` transfer of the packet buffer (`preparation-worker.ts`) → WebGPU raster (`kernel/gpu/webgpu.ts`) → `gpuTile` / `ImageBitmap` / byte tile → `ProgressiveSurface`.

Copies that are ownership fences, not spare duplicates:

- `copyScenePacket` / `CompiledScenePacket` so one packet is not shared mutable across consumers.
- Prep-worker `postMessage` transfer (move, not clone) when the buffer is the sole owner.
- Exact-tile cache retention of `result.buffer`. The worker then `slice(0)` before `postMessage` (`render-worker.ts`, cache `set` around the `ownsExactTileBytes` gate, then `linearBuffer.slice(0)` and `result.buffer.slice(0)`). A cache hit returns the stored buffer, so transferring it without a copy would detach the cache.
- `transferToImageBitmap` plus `copyExternalImageToTexture` when the presentation device is not the raster device. Same-device `capture()` avoids that ImageBitmap.
- GPU readback row packing for exact / HDR / certification paths.

The `slice(0)` is redundant only when this delivery is not a cache hit and the cache `set` did not retain the buffer (subdivided tiles, bitmap/`gpuTile` payloads, cache disabled). That change sits on the tile delivery path and was left alone so it does not collide with the zoom/tile navigation work.

Electron-only, and not the default canvas:

- `design-render` still carries RGBA8 as JSON base64 (`native-render-bridge.ts`, `native-render-main.ts`) even though the crate can speak FRB1 (`serve_protocol.rs`). Replacing base64 is a real copy win, scoped to the opt-in native backend.
- `design-desktop-backend` document transport is JSON chunk assembly, not pixels.

## 2. FIG versus the community kiwi format

Two importers, no FIG exporter:

| Path | Entry |
| --- | --- |
| Browser / Electron worker | `frontend/design-client/src/import-fig.ts` `importFig` |
| Desktop native | `design-studio/crates/design-kernel/src/fig.rs` `import_fig_native` |

The wire is zip → `canvas.fig` (`fig-kiwi` + embedded schema + zlib/zstd) → `NODE_CHANGES`. Unknown node types are rejected by name.

Still open, in priority order:

| Gap | Current behavior | Notes |
| --- | --- | --- |
| `stackReverseZIndex: true` | TS import throws (`import-fig.ts` `importLayout`, neutral is `false`). Rust reverses children. | Highest remaining browser/native split that already has a Rust test. |
| `stackMode: GRID`, counter-align `BASELINE`, `SPACE_EVENLY`, weighted grow | Both reject rather than guess. | Correct until a real layout model exists. |
| `boundVariables`, shared fill/text/effect styles | Not resolved. TS warns. Paints stay inline on the node. | Needs a variable/style model, not a one-field map. |
| `prototypeInteractions` | Rust stores `bindings.prototypeFlow` and reports them non-executable. TS only warns. | No prototype runtime from FIG. |
| `toggledOnOTFeatures` / `fontVariations` | Rust maps them onto text style. TS does not. | TS text path already has a run importer; variations are the next field set. |
| `interpolationColorSpace` other than `DEFAULT`, document profile other than `LEGACY`/`SRGB` | Reject the file. | Avoids treating Display P3 FIG bytes as sRGB. |
| Whiteboard, slice, embed, and `COMPONENT_SET` | Rust maps many of these. TS `importFig` node table is narrower and rejects unknown `type`. `SECTION` is already mapped to `section`. | Add kinds only with the same payload checks Rust uses. |
| Effect blend other than `NORMAL` | Rust records `effectBlendMode` as untranslated. TS keeps the effect and drops the blend. | Kernel `Effect` has no blend slot. |
| `showShadowBehindNode` rendering | Stored. Shadow clip does not branch on it (`scene.rs`). | Import fidelity only. |
| Per-side stroke weights that differ | TS rejects. Rust reports and still imports a uniform width. | TS is stricter on purpose. |

## 3. Sketch import and export

One Rust codec: `design-studio/crates/design-kernel/src/interop.rs`, reached from the app as WASM `import_sketch_json` / `export_sketch_json`. Lossy notes are written to `userInfo` and read back as `sketchExportLossy` (`note_lossy`).

Import keeps several source values in bindings when the editor cannot execute them: legacy noise paints, pattern tile scale, non-bitmap color controls, unknown blur types, inferred group layout, partial layout grids, per-point corner radii (`sketchPointCornerRadii`, restored on export), paragraph tightening, foreign symbol links.

Export downgrades that are explicit, not silent:

- Glass becomes a Gaussian blur; refraction is noted `effect-glass->gaussian(refraction-lost)` (`interop.rs` around the blur match).
- `texture` and `gradient-blur` are omitted with `effect-*-omitted`.
- Multiple blurs collapse to the first.
- Non-solid stroke paints, shear / non-uniform scale, vector brush, and repeat fail the export.
- Layout grid color, a second axis, and baselines stay partial.
- Constraint center becomes a scale mask plus a lossy note.

Official 74-feature-group round-trip remains the scoped Sketch claim from 2026-10-31. It is not portable pixel parity with Sketch’s renderer. No additional Sketch code change in this increment: the remaining gaps need a representation (glass refraction, texture paint, grid color), not a dropped field that already has a kernel slot.

## 4. MCP

Registry: `createEditorDesignAutomation` (`frontend/design-client/src/automation/index.ts`) → desktop bridge (`automation/bridge.ts`) → `frontend/design-mcp/src/operation-backend.mjs` (`design_*` tools). The server does not own a second document model.

`docs/OPERATION_COVERAGE_V1.json` at full simulated grants: 128 shared, 8 mounted-renderer-only on top of those (mounted 136), 11 native host, 147 advertised. Web Vite does not mount `desktop.automation`, so preview/raster artifact tools and workspace/settings tools are absent until Electron attaches them (`App.tsx`).

Deliberately absent (`UNIMPLEMENTED_SEMANTIC_METHODS`): `fig.import`, `pdf.import`, `pdf.export`, `document.newCopy`, collaboration/auth tools, `vector.patchVertex`, `command.execute`. FIG enters through `workspace.importCopy` with `format: 'fig'`, not `document.import`.

Not missing as bugs: Figma MCP aliases (`createFrame`, `executeJavaScript`, and the rest of `docs/DESIGN_AUTOMATION_PARITY.zh-CN.md`). The guide forbids inventing those names.

Client footgun, left as-is because tests lock it: `clipboard.export` is `mutates: false`, so MCP `readOnlyHint` is true, but the tool still requires `documentId` / `session` / `expectedRevision` (`operation-backend.mjs`). The description states the fence. Clients that skip fences solely because of `readOnlyHint` get `invalid_params`.

`node.update` transform text in `node-input-descriptors.ts` is the 6-tuple `[a,b,c,d,tx,ty]`. Granular patches use `{a,b,c,d,x,y}`. Those are different operations, not a drifted unit.

## 5. Web versus Electron

Shared: `design-client` UI, worker FIG/Sketch import (`import-file-worker.ts`), Sketch export in the same worker, kernel color and document schema.

Electron only: `window.coreDesktop` (fonts list/read, native preparation, native render probe, large-document and Sketch session bridges), automation socket, workspace SQLite grants, higher GPU working-set fraction (`kernel/gpu/adaptive-budget.ts`). The FIG and Sketch codecs themselves are not a separate Electron implementation; native FIG is an additional desktop entry to the same Rust reader.

## 6. Fonts and color

Working pixels are premultiplied extended-range linear sRGB, D65 (`design-kernel/src/color.rs`). Display and preview canvases request `colorSpace: 'srgb'` (`kernel/gpu/webgpu.ts`, `resident-presenter.ts`, `preview-tiles.ts`). PNG encode defaults `colorOutput` to `{ space: 'srgb', toneMap: 'clip' }` when the caller omits it (`render-worker.ts`). JPEG/WebP/PDF reject a non-sRGB `colorOutput` (`export.tsx`). A Display P3 document therefore composites in linear sRGB and, unless the caller passes a P3 `colorOutput`, encodes the file as sRGB. That is portable and lossy for wide-gamut authoring. Changing the PNG default was not done here: it would change bytes for every managed document whose callers currently rely on the sRGB default.

No COLR/CPAL font table is read in `design-kernel/src/font.rs` (outline / SVG paths). Variable axes and OpenType features exist on the text model; FIG text variations are still a Rust-only import. SVG export writes font names, not embedded files, unless the explicit artifact font mode is used.

`kernel/profile-render.ts` opens a 2D context without `colorSpace: 'srgb'`. That file is a dev profile fixture, not the product export path.

## 7. Drag, hit testing, layer order

`Editor.hit` walks the spatial index in reverse paint order, skips locked nodes and groups, and uses `kernelHitWorld` (`engine.ts`). Hidden nodes are omitted when the scene is built (`geometry.ts`). Layer-panel drop uses painter order versus storage (`layer-drop.ts`) and is covered by `layer-drop.test.ts`. Canvas drop tests frames front-first (`canvas-drop.ts`).

No sibling-index inversion showed up against those tests. Two Figma differences are contracts, not one-line bugs:

- Group and text masks use a bounds/contour proxy (`engine.ts` `blocks`, `legacyShape`). Frame-like shapes use `kernelFillWorld`. `mask-picking.test.ts` records the proxy.
- Groups are never the direct hit target (`n.kind === 'group'`).

## Backlog (not done)

- Skip the exact-tile `slice(0)` only when the cache does not retain that buffer. Do not transfer a cache-hit buffer.
- Replace opt-in `design-render` JSON base64 with FRB1 or a binary IPC payload.
- Port `stackReverseZIndex` child reversal to `importFig`, with the existing Rust test as the oracle.
- Map FIG `fontVariations` / OpenType features on the TypeScript text path.
- Store FIG prototype interactions in the same binding Rust already writes, still non-executable.
- Teach shadow rendering to honor `showShadowBehindNode` before describing the flag as visible behavior.
- Optional PNG default: when `colorManagement.documentSpace` is `display-p3` and the caller omitted `colorOutput`, encode PNG as Display P3. Keep JPEG/WebP/PDF on sRGB.
- Sketch: a real glass/texture/gradient-blur representation, or keep the current lossy notes.
- MCP: either document `clipboard.export` `readOnlyHint` next to the fence in the client guide, or introduce a non-mutating fenced annotation. Do not flip `readOnlyHint` without updating `clipboard-mcp.test.ts` and `design-mcp/test/clipboard-artifacts.test.mjs`, which require `true`.
