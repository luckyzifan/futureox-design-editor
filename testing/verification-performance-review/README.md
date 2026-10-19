# Independent performance/equivalence review

## Conclusion and scope

No blocking correctness issue was found in the frozen source reviewed here. The review used the exact starting working-source manifest for the previously delivered increment, not Git HEAD. Product/test hashes remained unchanged during the independent focused run. The reviewed and executed hashes are in `tested-source-manifest.json` and `transport-tested-source-manifest.json`.

The retained changes reduce repeated parent/topology searches, selected-ID membership probes, root-bound membership scans, and Rust cache invalidation bookkeeping. They do not change shader/sampling/effect/color mathematics, render density, or output precision. The native transport allocator experiment was **not shipped**: its small median decode improvement did not establish better tail latency or application smoothness. The final decoder matches its starting SHA-256 exactly.

This is a scoped source/correctness review, not a claim that every application path was tested or that the whole application became faster. Final release packaging and the broader aggregate suite are separate checks.

## Independently executed checks

| Check | Result | Evidence |
|---|---:|---|
| Focused Vitest, new WASM | 94 passed, 0 failed/pending, 13 files | `focused-vitest.json`, `focused-vitest.log` |
| Desktop preparation/frame/package/codec | 21 passed, 0 failed/skipped | `transport-tests.log` |
| Actual native preparation + new WASM | 3 passed, 0 failed/skipped | `native-new-artifacts.log` |
| Bounds differential | 2,500 fixtures, 26,247 entries, exact values | `bounds-differential.json` |
| Unit differential | 1,200 fixtures, 17,463 node records, exact values | `units-differential.json` |
| Corrupted transport byte | Expected failure detected | `transport-negative-control.log` |

These are execution counts, not additive unique coverage. They overlap other suite runs and must not be added to those totals as new independent tests. The generated differential fixtures are synthetic, nonempty scenes, not user documents.

The focused run covers scoped units, nested scale/skew/reflection, mixed property expressions, resize release/cancel, Alt duplication and toggling, smart-snap ordering, final reparenting, undo/redo, coalescing/stale selection behavior, bounds, and client transport.

The native executable SHA-256 is `e96ceab70be44597aa85200f7352c4b2131efdadf5cfc9a7d47af90eafd75ba5`; the new WASM SHA-256 is `e002c8fe2efc46b09fed04bbc21404c5b7bdfb773e12081c41cfc004c824ea1b`. Both were checked against the rebuilt artifacts. Native/WASM comparison includes actual CPU pixel/float output and the existing packet-fingerprint platform exception documented by that runtime test.

## Equivalence and anti-vacuity

- Root grouping preserves the original padding arithmetic, union implementation, entry ordering, duplicate memberships, and empty/hidden root behavior. The independent script compares every bound scalar with `Object.is` and Map key order against the frozen original expression. Dropping effect/stroke padding makes 2,172 fixtures disagree.
- Unit scopes match the frozen original implementation with `Object.is` across nested transforms and perform one parent-map scan per reader. Fresh scopes and the uncached default API observe edits. Deliberately reusing the stale reader after a transform change disagrees in all 1,200 controls.
- Reviewed frozen-old Canvas/engine control logs show five intended work-count failures after geometry/history assertions pass. The final tests preserve residual work rather than hiding it: initial duplication still performs its existing copy-related scans, and final placement still performs per-root layout scans.
- A vacuous post-release assertion comparing the document to itself was flagged during review. The final test captures the post-redo snapshot before flushing queued work and compares against that captured snapshot.
- The transport control corrupts a real copied payload byte in an isolated module and requires the actual byte-equality assertion to fail. Actual `worker_threads` transfer/detachment tests remain in the final suite.

Rust source review checked dirty ancestors/descendants, `Arc::make_mut` reader isolation, byte/count accounting, duplicate replacement, exact FIFO deletion, bounded storage, and order-counter rollover. Owner test logs for those invariants and exact packet comparisons were inspected; this reviewer did not build Rust. Rust timing is observational, with contaminated runs excluded and compile-only/cold-path tradeoffs disclosed in its separate report. Reduced invalidation time must not be described as an equivalent frame-rate gain.

## Runtime limits

React panel checks use jsdom. Canvas checks execute production handlers with hook/host boundary doubles and real Editor/WASM. Interaction-renderer scheduling checks use a mocked kernel transport; their synthetic 60/90/120/144 Hz input schedules do not measure actual display refresh or FPS. Bounds and native checks include real CPU/WASM rendering. No real GPU, browser window, Electron window/IPC, OS socket, Windows/macOS packaging, or hardware presentation was exercised by this review.

## Reproduce

Use the checkout's existing dependencies and same-source rebuilt native/WASM artifacts. From the repository root:

```sh
node testing/verification-performance-review/bounds-differential.cjs
node testing/verification-performance-review/units-differential.cjs
node --test frontend/design-desktop/test/preparation*.test.mjs
node testing/verification-next-native-transport/negative-control.mjs
DESIGN_PREPARE_BINARY=/path/to/same-source/design-prepare node --test frontend/design-desktop/test/runtime/preparation-runtime.test.mjs
```

The standalone differential scripts use Node's TypeScript stripping API (verified with Node 24.19.0), execute the current production functions, and carry only their exact frozen reference sources in `fixtures/`.

From `frontend/design-client`:

```sh
node node_modules/vitest/vitest.mjs run src/property-units-context.test.ts src/property-units.test.tsx src/selection-properties.test.ts src/selection-scale.test.ts src/workspace-ui.test.tsx src/multiselection-cpu-runtime.test.tsx src/canvas-selection-cpu.test.tsx src/interaction-ui-runtime.test.tsx src/canvas-drop.test.ts src/kernel/interaction-renderer.test.ts src/kernel/interaction-scene-bounds.test.ts src/kernel/native-preparation.test.ts src/kernel/preparation-channel.test.ts --maxWorkers=1
```
