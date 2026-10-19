# Interaction panel subscription verification

## Result and scope

Two unnecessary-work paths were removed without editing App, API/automation, keyboard profiles, Canvas, render mathematics, pixels, GPU/browser policy, or socket policy:

1. `frontend/design-client/src/TextStylePanel.tsx` now subscribes to the existing `Editor.panelSnapshot`, matching its Inspector parent. The former full-state subscription rerendered the text controls on every camera-only commit and recomputed `propertyUnits` → the full-document `allParents` map.
2. `frontend/design-client/src/desktop-session.ts` publishes `DesktopStatus` only when one of its scalar fields changes. Previously every preview document called App's `setDesktopStatus` with an equivalent fresh object, forcing the App/panel tree to render despite the existing panel cadence. Document generations, recovery scheduling, dirty detection, tab publication, and all actual status transitions remain on their original paths.

The added runtime regression file is `frontend/design-client/src/interaction-ui-runtime.test.tsx`.

## Runtime evidence

The harness mounts actual React Layers and Inspector components beneath the two App-equivalent state sources: `useSyncExternalStore(editor.subscribe, editor.panelSnapshot)` and `DesktopSession` → React status state. It uses a real Editor and the rebuilt WASM. A 256-node document has one selected text node. The Canvas and native IPC are outside this harness.

| Operation count | Before | After |
| --- | ---: | ---: |
| 120 camera commits: propertyUnits calls | 120 | 0 |
| 120 camera commits: allParents calls | 120 | 0 |
| 120 camera commits: shell renders/status publications | 0 / 0 | 0 / 0 |
| 36 Editor.preview samples: propertyUnits calls | 180 | 5 |
| 36 Editor.preview samples: allParents calls, including Editor work | 396 | 81 |
| 36 Editor.preview samples: shell renders/status publications | 36 / 36 | 1 / 1 |

Representative final measured harness totals: camera approximately 245 ms before / 3.08 ms after; drag approximately 619 ms before / 106 ms after. These are single-run React/jsdom/Editor/WASM CPU-harness observations, not native frame times, production latency guarantees, or browser/GPU/pixel proof. Operation counts are the deterministic regression criteria. The required Editor parent-map work was not removed.

Canonical measurements: `before-release-verified.ndjson` and `after-release-verified.ndjson`.

### Clock and initial-mount controls

Both before and after run the same final test source and input sequence. The drag test fixes the logical `performance.now` clock before the initial React mount, then advances it by 1 ms per preview sample. The actual mount fully runs; counters are reset only after it completes. This avoids slow jsdom mount time accidentally consuming the existing 80 ms panel interval. No legitimate mount state update is suppressed. Wall duration is measured independently with the original bound clock function, including real Editor/WASM and React computation.

A separate runtime test verifies live publication rather than merely trusting the throttle:

- At 20 ms, a preview retains the previous displayed coordinate.
- At 81 ms, another preview publishes coordinate 300 while the transaction remains active.
- At 100 ms, the newer coordinate 400 remains subject to the interval.
- Committing immediately publishes the final coordinate 400 without waiting for another interval.

Other assertions verify immediate final commit, undo, redo, cancel, selection changes, live text properties, actual textarea input/composition DOM events, camera retention of the same text field/draft, IME save veto, blur commit, subsequent saved bytes, and undo. Save dirty/busy/error/cancel/clean transitions are checked in the actual React DOM. Runtime tests print console errors normally and fail if any occur; no errors are swallowed.

## Baseline isolation and source identity

Base commit: `71d32153e6f55b3723c99708b4c4c49ac7342e67`.

The final baseline is a separate temporary copy of the current frontend source and final runtime test. Only TextStylePanel and DesktopSession were replaced with their unchanged base-commit versions. The baseline uses the same current public assets/WASM. Frozen working sources were not reverted or changed for the baseline run. Its two optimization regression assertions intentionally fail before the fix: 120 property calculations rather than 0; 37 total status publications including commit rather than 1. `before-release-verified.log` records that expected failing baseline.

Current WASM: 39,280,365 bytes; SHA-256 `3dff5703c0b197cf26be5a94f3a5bf544c876d1950ac4118784e1c5f3abdbe21`.

`source.sha256` pins the two modified production files, runtime test, and WASM; all four were rechecked after baseline verification.

## Final verification

- 112 / 112 tests passed across five focused suites, including all six new runtime tests. See `final-focused.log`.
- TypeScript `tsc --noEmit` passed, exit 0. See `typecheck-final.log` (empty on success).
- `git diff --check` passed for the two production changes.
- Aggregate repository verification and native application rendering/performance remain separate checks; this report makes no claim for them.

Focused command, from `frontend/design-client`:

```sh
INTERACTION_UI_METRICS=../../testing/verification-latest-interaction-ui/after-release-verified.ndjson \
  ./node_modules/.bin/vitest run \
  src/interaction-ui-runtime.test.tsx src/desktop-session.test.ts \
  src/TextStylePanel.test.tsx src/property-units.test.tsx \
  src/editor-lifecycle.test.tsx --reporter=verbose
./node_modules/.bin/tsc --noEmit
```

Exploratory logs are retained for auditability; the canonical final files above supersede earlier harness attempts.
