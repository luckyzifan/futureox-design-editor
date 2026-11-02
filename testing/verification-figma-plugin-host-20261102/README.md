# Figma plugin host — 2026-11-02

This increment adds a local plugin host. It does not change rasterization, tile navigation, sticky canvas tools, GPU budgets, or the blue accent token `#3459d4`. It does not close the 33 ms visible or 100 ms refinement targets, and it is not full G2/G5 acceptance.

## What ran

- `frontend/design-client`: `vitest run src/plugins/plugin-host.test.ts src/PluginHostDialog.test.tsx` — 11 passed. The dialog test clicks Run sample and the editor document gains the sample frame. `tsc --noEmit` passed.
- `frontend/design-desktop`: `node --test test/plugin-ui.test.mjs test/security.test.mjs test/preload.test.mjs test/main.test.mjs` — plugin UI, CSP, preload, and 62 main-process tests passed.

The sample plugin creates a frame and text through `Editor.change`. Undo removes that edit. Unsupported calls such as `figma.createImage` throw `unsupported_api` and do not add a node. QuickJS does not see the host `process` object. A dev WASM kernel was built locally to run the editor tests and is not part of the commit.

## What did not run

Hardware GPU, a packaged Electron click-through, and a corpus of third-party community plugins. Desktop plugin UI was checked as a document response and content-security policy, not as a live iframe click. Coverage is the matrix in `docs/FIGMA_PLUGIN_HOST_V1.md`, not Figma compatibility certification.
