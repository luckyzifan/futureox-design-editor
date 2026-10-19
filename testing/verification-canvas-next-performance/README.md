# Canvas event batching and page safety

## Result and scope

The actual mounted React Canvas, Editor, and current Rust WASM process deterministic high-frequency pointer traces. Only `KernelSurface` is replaced at the render-device boundary. These are CPU/event-work measurements in jsdom, not browser FPS, GPU timing, compositor latency, native device, Electron, or pixel-quality verification.

For 250 ms traces at 120 / 240 / 1000 Hz, with deterministic 60 Hz animation-frame delivery:

- Preview calls: 31 / 61 / 251 → 16 / 16 / 16.
- Editor notifications: 33 / 63 / 253 → 18 / 18 / 18.
- CPU elapsed milliseconds, old A1 / A2: 265.01 / 238.85, 458.25 / 333.23, 1552.38 / 943.23.
- CPU elapsed milliseconds, new B1 / B2: 169.71 / 145.96, 135.35 / 110.95, 162.43 / 167.70.
- Full final document hashes match exactly across all four processes and all three rates. A separate nested reflected/skewed transform fixture also matches exactly in all four processes. Every trace verifies undo, redo, and that an old scheduled frame cannot mutate the committed document.

The run order was old, new, new, old. Other workers held heavy CPU jobs, and the Rust build had finished. The recorded ranges expose process-to-process variation; the deterministic work counts are the stronger evidence. Each trace includes DOM event dispatch, React work, and the real WASM editor path. The fixed frame schedule is a test input and must not be reported as observed FPS.

`before/Canvas.tsx` is the exact current source captured at the start of this increment, not older Git HEAD. `abba-inputs.sha256` identifies the old and new Canvas, exact benchmark test, Editor, and WASM. `benchmark-test.tsx` preserves that exact test version; the main test subsequently gained page-UI regressions. `Canvas.candidate.tsx` preserves the benchmarked candidate. Raw A/B logs, JSON metrics, and official Vitest JSON results are retained. Canvas was restored and compared byte-for-byte after the run.

## Production changes

- `Canvas.tsx`: extend latest-sample animation-frame batching to existing-node vector anchors, Bézier handles, width profiles, crop, marquee, and zoom rectangles. Pen construction, freehand, utility tools, shape creation, pan, and pivot remain on their prior paths. No input point is dropped from freehand or pen construction.
- Modifier replay uses the latest queued owner sample, consumes it synchronously, and clears the old queue, including before the first animation frame. The old implementation could replay an earlier applied pointer and later overwrite current modifiers from the queue.
- Queue ownership compares the actual gesture object; lifecycle cleanup cancels scheduled work on cancellation, lost capture, Escape, blur, page/session change, and unmount. Release continues to use its actual coordinates and modifiers.
- Selection-handle geometry is memoized only by its exact existing inputs: selection corners and zoom. No global geometry cache, numerical approximation, sampling change, or renderer quality change was introduced.
- A separate follow-up guards page topology edits in `PageList.tsx` and page deletion in `Layers.tsx` while a Canvas transaction or busy operation is active. Mutable state is checked at the handler boundary, including after pending edits or confirmation. Ordinary page navigation and rename behavior remain unchanged.

## Verification

The focused mounted suite covers vector/handle/width batching, exact fractional release, owner-pointer rejection, modifiers before the first frame, no-motion clicks, returning to the start, cancellation/restart, lost capture, Escape, blur, page/session replacement, unmount, full freehand coalesced samples, path-dependent pen construction, crop/marquee/zoom final geometry, memo invalidation, and nested reflections/skew.

Page UI tests dispatch events against actual mounted PageList and Layers controls. They cover add, duplicate, reorder, busy actions, a gesture starting between row dragstart and drop, and a gesture or busy transition during the delete-confirmation callback. They verify that ordinary actions resume after the gesture and undo restores the document. These are synthetic DOM events, not verified native multitouch delivery.

- Final aggregate results: see `final-tests.log` and `final-tests.vitest.json`.
- TypeScript: `typecheck-final.log` is empty on success. An earlier unrelated, in-flight FontManagementPanel prop error is retained in `typecheck.log` and is not presented as a final failure.
- Existing rename and Shift-snapping contracts: 24/24 passed in `rename-shift-contracts.log`.
- Negative control: replacing only Canvas/PageList/Layers with their frozen old sources in an isolated snapshot causes all seven selected new checks to fail. The production checkout was not changed for that negative control. See `negative-control.log` and its Vitest JSON.

Commands from `frontend/design-client`:

```sh
node node_modules/vitest/vitest.mjs run \
  src/canvas-event-batching.test.tsx src/canvas-*.test.ts \
  src/canvas-selection-cpu.test.tsx src/canvas-selection-workflows.test.tsx \
  src/canvas-minimap-removal.test.tsx src/selection-handles.test.ts \
  src/freehand.test.ts src/image-crop.test.ts src/shape-creation.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

## Independently discovered pre-existing failure

Calling `Editor.addPage()` directly while a vector transaction remains live can pass a document without the new page to the SVG preview. `Renderer.tsx:506` then reads `page.children` from an undefined page. This fails identically on the frozen baseline and candidate, with logs in `add-page-baseline.log` and `add-page-candidate.log`. The real PageList add button reproduced the issue before the guard (`page-ui-before.log`), so the UI entry point was fixed separately after the timing run.

The raw direct-API defect remains an explicit limitation. The opt-in reproducer is retained and skipped by default:

```sh
CANVAS_REPRO_ADD_PAGE=1 node node_modules/vitest/vitest.mjs run \
  src/canvas-event-batching.test.tsx -t 'reproduce direct addPage'
```

Existing-page navigation is covered separately and is not represented as proof that every direct page API is safe. No claim is made that the direct-API reproducer passes. Page UI fixes were tested after the benchmark and do not change its Canvas candidate.
