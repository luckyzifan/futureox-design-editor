# Remove the small canvas overview

The 168×104 bottom-right minimap is removed at its source, including its component mount, overview-bounds aggregation, outside-viewport scan, drawing effect, pointer handlers, obsolete Editor state key, view-menu checkbox, CSS rule, and event-exclusion/comment references. The main viewport, startup preview, CanvasEditPreview, scrollbars, and Sketch/prototype previews are unchanged by this removal.

## Verification boundary

- `focused.json` / `focused.log`: 9 files, 114 passing tests. The three new tests mount production Canvas and its real children in React/jsdom, with real Editor/WASM. Only KernelSurface's rendering-device boundary is replaced. Pointer selection, hand-pan final release, anchored wheel zoom, zoom buttons, scrollbar navigation, document/history preservation, repeated updates, and legacy `minimap: true` are checked.
- Zero overview DOM/canvas and zero 2D context requests are asserted. This does **not** mean the real main renderer allocates no canvas, and is not a GPU, screenshot, pixel-quality, or performance measurement.
- `negative-controls.json`: two real old-component restoration mutations run only in an isolated source snapshot. The old component receives a working drawing-context double. Its immediate mount and its CSS-hidden mount after navigation each fail the exact no-context-call assertion; setup failures or arbitrary nonzero exits do not qualify. These are two expected failures, not additional passing tests.
- Existing navigation browser-check scripts were updated for the feature removal, but were not executed. No browser, GPU, socket, or Rust build was attempted.
- Existing editor-lifecycle tests print handled IndexedDB-unavailable startup-preview warnings in their Node-only harness. Their 32 tests pass; the new real-DOM tests also assert no console errors.

## Reproduce

From `frontend/design-client`:

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run src/canvas-minimap-removal.test.tsx src/canvas-selection-cpu.test.tsx src/canvas-camera.test.ts src/canvas-scrollbars.test.ts src/startup-preview-lifecycle.test.tsx src/startup-preview.test.ts src/editor-lifecycle.test.tsx src/kernel/navigation-zoom.test.ts src/kernel/use-navigation-zoom.test.ts
python3 ../../testing/verification-performance-minimap/check-negative-controls.py
```

`final-source-manifest.json` records exact edited source and current WASM hashes, plus the deleted component's previous hash. `publication.sha256` is folder-local and verifies the evidence files with `sha256sum -c publication.sha256` from this directory.
