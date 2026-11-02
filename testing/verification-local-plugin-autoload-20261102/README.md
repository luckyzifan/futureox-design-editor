# Local plugin auto-load — 2026-11-02

Electron scans `<userData>/plugins` once during startup. Each real child directory with a valid `manifest.json` is enabled for the session. Choosing it from the Plugins menu or the plugin host runs the existing worker and `Editor.change` path. The scan reads the manifest and the declared `main` / `ui` files. It does not execute plugin code and does not change the open document.

Hidden directories, directory symlinks, FigJam-only manifests, duplicate ids after the first folder name, and files that resolve outside the plugin folder are not enabled. The renderer receives manifest text and a session grant. It does not receive a filesystem path.

This does not change sticky notes, the blue accent, rasterization, tile navigation, compositing, or GPU budgets. 33/100ms and full G2/G5 remain open. No Electron GUI pass was run.

## Checked

These passed in this run:

- `node --test frontend/design-desktop/test/plugin-host.test.mjs frontend/design-desktop/test/native-locale-repair.test.mjs frontend/design-desktop/test/preload.test.mjs` (30 tests).
- `node --test --test-name-pattern "startup enables declared plugins|actual main locale switching retains menu" frontend/design-desktop/test/main.test.mjs` (4 tests). The startup case enables one declared plugin, skips a FigJam manifest and a directory symlink, keeps the authored name `Save` in both locales, and rejects a path that leaves the folder.
- Vitest in `frontend/design-client` for `src/plugins/plugin-panel.test.tsx` (4 tests), with the kernel setup file disabled. Those tests do not load the design kernel. The normal `vitest.config.ts` setup still requires the generated kernel, which this checkout does not contain.

## Not run

`frontend/design-client` `tsc --noEmit` still fails in this checkout because `src/generated/design-kernel` is absent. None of those errors are in the plugin, desktop bridge, or `App.tsx` lines changed here. `src/plugins/plugin-host.test.ts` was not executed; it needs that kernel. Its new documentation assertion matches `docs/FIGMA_PLUGIN_HOST.md`.
