# Editor CPU performance increment

Baseline: the frozen source snapshot delivered as `a9fb36a1`. Its six relevant source files were checked against the phase start manifest before comparisons. The checkout's older Git HEAD was not used as the baseline. `source-hashes.json` identifies the exact old/new production files and new tests.

## Verified result

The controlled benchmark measures mounting the actual Inspector after a real Editor/WASM document has already been constructed and selected. It does not measure initial document opening, browser startup, GPU rendering, HD refinement, or FPS.

- 3,000 selected nodes plus two transformed ancestors: parent traversals fell from 36,002 to 3. Old mounts took 24,716.92 / 25,977.24 ms; new mounts took 97.24 / 98.86 ms.
- 300 selected nodes plus two ancestors: parent traversals fell from 3,602 to 3. Old mounts took 232.13 / 328.90 ms; new mounts took 95.66 / 65.65 ms.
- X, Y, W, H, rotation and opacity displays were exactly identical in all four comparison processes, including mixed-value fields.

ABBA order was old, new, new, old. Each process mounted the 300-selection fixture before its 3,000-selection fixture. Other workers paused heavy CPU work for this timing window. Traversal counters do not retain returned Maps. An earlier retaining-spy OOM was a test-harness issue and is excluded entirely.

Production Canvas handler tests use actual Editor/WASM and deterministic React-hook/host boundaries. Their deterministic work counts, rather than concurrent-run timings, establish:

- Resize/release, 300 / 3,000 selected nodes: total parent scans 303 / 3,003 → 3 / 3.
- Initial Alt-copy, 16 roots: total parent scans 85 → 38. Of the 38, 32 remain in unchanged copyGraph/duplicateGraph work.
- Alt-off and cached second Alt-on: total scans 51 → 4 each; no implicit parent-map rebuild remains in the Canvas matrix refresh.
- Smart snapping with selected descendants and page rulers: linear selection-array membership probes 1,212 → 0, preserving exact candidate order.
- Final 32-node reparent: explicit parent scans 68 → 36. The remaining 32 previewLayoutOrder scans and 33 implicit reparenting world-matrix scans are unchanged.

## Changes

- `property-units.ts`: explicit render/operation-scoped reader shares one parent index and per-node units. The default function remains uncached for mutable callers.
- `selection-properties.ts`: dimensionless fields avoid unit work; resize can reuse units without changing numerical operations.
- `MultiSelectionInspector.tsx`: each displayed metric is computed once; one reader serves the current render and a fresh reader serves each edit operation.
- `MultiStylePanel.tsx`: shared units and Set membership for style slots; handlers create their own current-snapshot readers.
- `Canvas.tsx`: reuse the already available/current parent map for bulk resize and Alt-copy; use Sets for membership while preserving traversal/tie order.
- `engine.ts`: one argument addition passes the existing current parent map to the final move's containing-frame lookup.

No pixel precision, quality, tile sampling, shader, socket or automation behavior was changed. The prior TextStylePanel camera-independent snapshot and DesktopSession status deduplication remain intact.

## Verification and anti-vacuity

13 focused files / 102 tests passed, TypeScript passed, and the existing Shift-move Node contract suite passed 14/14 with the repository runner’s TypeScript loader. Coverage includes nested rotations/reflections/skew, locked selection, mixed numeric expressions, scaled text/stroke units, IME/text behavior, current-state edit commits, preview cancellation, reparenting, release coordinates, stale queued movement after release/history, Alt toggling, undo and redo.

The frozen old Inspector fails both traversal limits. The frozen old Canvas/engine fails five work-count checks; the preceding geometry/history equivalence assertions still pass. The separate locked/cancel semantic test passes on both. These failures are expected negative controls, not release failures. A reviewer independently checked 1,200 generated nested-transform documents / 17,463 unit records with Object.is equality; that review's full evidence is maintained separately.

Focused command, from `frontend/design-client`:

```sh
node node_modules/vitest/vitest.mjs run \
  src/canvas-selection-cpu.test.tsx src/property-units-context.test.ts \
  src/multiselection-cpu-runtime.test.tsx src/property-units.test.tsx \
  src/selection-properties.test.ts src/interaction-ui-runtime.test.tsx \
  src/workspace-ui.test.tsx src/canvas-drop.test.ts src/native-duplication.test.ts \
  src/smart-selection.test.ts src/selection-scale.test.ts \
  src/selection-hierarchy.test.ts src/editor-lifecycle.test.tsx
node node_modules/typescript/bin/tsc --noEmit
# From the repository root, using the existing contract runner’s required flags:
node --experimental-transform-types --import ./testing/lib/register-typescript.mjs \
  --test frontend/design-client/src/shift-move-snapping.test.mjs
```

The comparison used the existing WASM SHA-256 `3dff5703c0b197cf26be5a94f3a5bf544c876d1950ac4118784e1c5f3abdbe21` and font SHA-256 `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`, Node v24.19.0. This worker did not rebuild WASM. Full-suite verification against the final integrated build belongs to the parent/reviewer and is not claimed by these focused results.

`summary.json` contains all measured values and work counts. Published logs replace machine-specific absolute paths. `reproduce-inspector.sh` accepts a local directory containing the six exact frozen baseline files and verifies their hashes before a bounded ABBA rerun. It never downloads dependencies or rebuilds WASM; it temporarily replaces only those six files, then restores their current bytes on exit. Run it only in an otherwise idle checkout, with no concurrent source edits/tests.

Reproducer validation: shell syntax passed and a non-baseline source directory was rejected before any source replacement. The recorded controlled ABBA run used the same bounded swap/restore workflow; the published reproducer adds official Vitest JSON checks. Two exploratory direct-Node invocations without the complete required TypeScript loader failed before tests ran; the correctly configured command above passes all 14 contracts.


## 后续整合边界

本专项记录的源码哈希对应性能修改完成时的快照。之后按请求移除了缩略导航，Canvas/engine 等文件会继续有整合差异；本目录保留专项当时的来源与结果，不冒充后续组合版本已在此处重跑。组合版本的当前源码和测试结果以 testing/verification-performance-final 为准。
