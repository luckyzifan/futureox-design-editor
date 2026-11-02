# Figma plugin runtime — 2026-11-02

This increment extends the local Figma plugin host so a typical community plugin can load and talk to the open document. It does not change rasterization, tile navigation, sticky canvas tools, GPU budgets, or the blue accent token `#3459d4`. It does not close the 33 ms visible or 100 ms refinement targets, and it is not full G2/G5 acceptance.

Rendering gates G0–G8 are **NOT_APPLICABLE**: no canvas, raster, camera-presentation, or navigation source changed. G9 is **NOT_APPLICABLE**. G10 is this note plus the tests below.

The host was cherry-picked from the unmerged plugin-host commit onto current `main` (`dbb750b`, parent `123c099`), then extended. Document edits still go through automation `batch.apply` and `Editor.change`. There is no second document model and no MCP Figma alias. `plugin.data.replace` exists only on the plugin session’s automation instance.

## What a .zip or .figma plugin can do

Load a folder or a zip (`.figma` is a zip). The manifest may declare network domains and permissions; those are not granted and `fetch` throws. A menu lists commands and sets `figma.command`.

A plugin can read and set the selection, create the shapes in `docs/FIGMA_PLUGIN_HOST_V1.md`, change the supported geometry, paint, text, and auto-layout fields, call `showUI`, exchange `{ pluginMessage, pluginId }` with a sandboxed iframe, use `figma.clientStorage`, write plugin data, and `closePlugin`. One flush is one undo step.

Plugin UI on the desktop app stays a `design-app://plugin/<id>` frame (`sandbox="allow-scripts"`, `connect-src 'none'`). The web app uses a srcdoc iframe with the same sandbox and a meta content-security policy. The parent page CSP can still block inline scripts in srcdoc; the desktop frame does not inherit it.

`figma.clientStorage` is client-local JSON (100 keys, 256 KiB) and is not part of undo. Node, page, and document plugin data is the inert FD extension `design.futureox/plugin-data`, undone with the flush that wrote it. A document that carries the extension cannot be appended into another file.

## Still blocked

Images, SVG import, vector networks, `exportAsync`, variables, team libraries, payments, parameters, codegen, annotations, shared styles, rich text ranges, reactions, relaunch buttons, network fetch, positive `setTimeout`, and `setInterval`. `loadFontAsync` does not download a font. `figma.currentUser` is null. Viewport center is the camera origin, not the visual center, and `scrollAndZoomIntoView` does not change zoom. This is not Figma and not a plugin catalog.

## What ran

- `frontend/design-client`: `bunx tsc --noEmit` — exit 0.
- `frontend/design-client`: `bunx vitest run src/plugins/plugin-host.test.ts src/PluginHostDialog.test.tsx` — 17 passed, exit 0. The dialog test runs the sample and checks that the UI sample’s iframe is `sandbox="allow-scripts"` and its srcdoc contains `pluginMessage` and `connect-src 'none'`.
- `frontend/design-desktop`: `node --test test/plugin-ui.test.mjs test/security.test.mjs test/preload.test.mjs` — 30 passed, exit 0.

A dev WASM kernel was built locally (`python3 design-studio/scripts/build-web.py --profile dev`) so the editor tests could initialize. It is not part of the commit.

## What did not run

`frontend/design-desktop/test/main.test.mjs`, a packaged Electron click-through, hardware GPU, and a corpus of third-party community plugins. No third-party plugin zip was executed; the tests build a zip with `fflate` and run that script in QuickJS.
