# Figma plugin runtime, 2026-11-02

This increment adds a local Figma plugin host on `main`. It does not change rasterization, tile navigation, or the blue accent. It does not close the 33 ms / 100 ms goals or full G2/G5.

## What was checked

- Rust `plugin_api::tests` on the native kernel: create/resize/fill/selection, clockwise rotation and bounds, reparent with world position, hit-test preferring the child, text gated by `loadFontAsync`, plugin data round-trip, group bounds, and singular-matrix rejection. `cargo test -p futureox-design-kernel --lib plugin_api::tests` passed (5 tests).
- Vitest `src/plugins/plugin-host.test.ts` via `vitest.plugin-host.config.ts` (the default client setup loads a generated wasm file that is not in git): manifest, zip, iframe message limits, clientStorage, document admission of a Rust-shaped patch, the guest `figma` prelude, and a QuickJS sandbox run. 9 tests passed.
- `tsc --noEmit` still reports the existing missing `src/generated/design-kernel` module. The new plugin files are not in that error list. They call `PluginSession` through a dynamic import so they do not add another static missing module.

## Not checked

- A rebuilt wasm package in the running Electron app. `bun run build:kernel` is required before the panel can commit into a live document.
- A real community `.zip` beyond the labeled-frames sample and the sandbox tests.
- Browser GUI of the plugin iframe. The message wrapper and CSP are unit-tested.

Document mutations in this host go through `PluginSession` in the Rust kernel, then one `Editor.change` per flush. The QuickJS guest does not own the scene graph.
