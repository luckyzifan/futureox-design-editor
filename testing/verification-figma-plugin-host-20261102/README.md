# Figma plugin host — 2026-11-02

The desktop editor can run a documented Figma Plugin API subset against the open design document. Plugin code runs in a worker. Each turn commits through the existing `Editor.change` path. The plugin UI is a separate sandboxed BrowserWindow. This change does not alter sticky-note tools, the blue accent, rasterization, tile navigation, or compositing.

## Checked

These passed in this run:

- `frontend/design-client`: `bunx tsc --noEmit` and `bunx vitest run src/plugins/plugin-host.test.ts` (6 tests). The dev WASM kernel was built locally for the editor tests and is not part of this change.
- `frontend/design-desktop`: `node --test test/plugin-host.test.mjs test/preload.test.mjs test/native-locale-repair.test.mjs`
- Desktop main harness load after teaching it to resolve `design-ai.mjs`, `plugin-package.mjs`, and `plugin-ui.mjs`: `node --test --test-name-pattern "desktop zoom shortcuts|actual main locale switching retains menu" test/main.test.mjs`

## Not claimed

No Electron GUI pass, no community plugin catalog, and no rendering acceptance. 33/100ms and full G2/G5 remain open. Unsupported Plugin APIs throw; they are listed in `docs/FIGMA_PLUGIN_HOST.md`.
