# Figma plugin API — 2026-11-02

This increment closes the Mac-audit gaps on the local plugin host: `createNodeFromSvg`, `createImage` / `getImageByHash`, SVG `exportAsync`, local variables, local paint/text/effect styles, `clientStorage`, and main-thread `fetch` for origins declared in `networkAccess`. It does not add a collaboration server or an account backend. It does not change rasterization, tile navigation, sticky canvas tools, GPU budgets, or the blue accent token `#3459d4`. It does not close the 33 ms visible or 100 ms refinement targets, and it is not full G2/G5 acceptance.

Rendering gates G0–G8 are **NOT_APPLICABLE**: no canvas, raster, camera-presentation, or navigation source changed. G9 is **NOT_APPLICABLE**. G10 is this note plus the tests below.

Document edits still go through automation `batch.apply` and `Editor.change`. There is no second document model. `plugin.data.replace` exists only on the plugin session’s automation instance.

## What a .zip or .figma plugin can do now

Load a folder or a zip. Create and edit the shapes, text, and auto-layout fields already marked supported or partial in `docs/FIGMA_PLUGIN_HOST_V1.md`. Import an SVG string through the editor SVG importer. Create an image from PNG, JPEG, GIF, or WebP bytes (256 KiB) and paint with its SHA-1, the same content id a `.fig` archive uses for `images/<hash>`. `getImageByHash` also finds an image paint already stored on a fill or stroke. `exportAsync` returns SVG bytes. Local collections support COLOR, FLOAT, STRING, and BOOLEAN variables, and `setBoundVariable` binds width, height, opacity, characters, visible, fontSize, and itemSpacing. Local paint, text, and effect styles can be created and applied. `figma.clientStorage` stores JSON, `undefined`, and `Uint8Array` up to 5 MB per plugin on this client. Main-thread `fetch` is allowed for manifest `networkAccess` origins: `https`, or `http` only for an explicit localhost origin. Private addresses, metadata hosts, and URL credentials are refused.

`layoutWrap: WRAP` stores the primary axis as FIXED. The layout solver needs a definite main size before it can wrap. A primary `AUTO` without wrap stays hug.

Plugin UI stays sandboxed with `connect-src 'none'`. There is no collaboration server.

## Still blocked

`createImageAsync`, PNG/JPG/PDF `exportAsync`, vector networks, remote variable libraries and aliases, `importStyleByKeyAsync`, `strokeStyleId`, UI-frame network, payments, parameters, codegen, annotations, rich text ranges, reactions, relaunch buttons, positive `setTimeout`, and `setInterval`. Text styles do not store font size or decoration. `loadFontAsync` does not download a font. `documentchange` does not list the changed nodes. A document that carries plugin data cannot be appended into another file.

## Plugins compared

Source was read on 2026-11-02. None of these plugins were executed inside Figma:

- destefanis/design-lint
- figma/plugin-samples (including svg-inserter)
- feathericons/figma-feather
- basiclines/figma-content-buddy
- basiclines/figma-super-tidy
- kawamurakazushi/figma-sort-it
- thomas-lowry/nester
- thomas-lowry/sorter

## What ran

- `frontend/design-client`: `bunx tsc --noEmit` — exit 0.
- `frontend/design-client`: `bunx vitest run src/plugins/plugin-host.test.ts src/plugins/network.test.ts src/PluginHostDialog.test.tsx` — 26 passed, exit 0. That includes SVG import, hug versus wrap sizing, paint and text styles, SHA-1 image lookup from a document paint, SVG export with PNG rejected, a local variable bound to width, declared-domain fetch, and the 5 MB clientStorage quota.
- `frontend/design-desktop`: `node --test test/plugin-ui.test.mjs test/security.test.mjs test/preload.test.mjs` — 30 passed, exit 0. Desktop plugin UI sources were not changed in this increment.

A dev WASM kernel was built locally (`python3 design-studio/scripts/build-web.py --profile dev`) so the editor tests could initialize. It is not part of the commit.

## What did not run

A packaged Electron click-through, hardware GPU, and the third-party plugin zips themselves. The host tests drive QuickJS with fixtures that use the same calls those plugins make. No collaboration server was started.
