# Independent supplemental review: performance and local canvas workflows

Date: 2026-10-19 UTC. This is a separate, later review. The earlier `testing/verification-performance-review/` publication remains unchanged and its results must not be reinterpreted as testing these later features.

## Result and scope

No remaining blocking correctness finding was identified in the frozen sources listed in `source-runtime-manifest.json`. This conclusion is bounded by the checks below. It does not assert complete Figma/Sketch parity, browser/Electron GUI correctness, OS keyboard behavior, GPU output, or an end-to-end frame-rate improvement.

Reviewed changes: complete minimap removal; lazy fragment-array allocation in the compositor draw planner; profile-aware dimension nudges, Select All, order bindings and remove-auto-layout; Sketch-like held-X/Option/Shift marquee and Escape parent navigation; center-selection; bounded paste-over-selection and its native keyboard/menu/preload route. The final paste-over contract retains targets, restricts Figma-like operation to one top-level selected target, and uses explicitly documented parent-local top-left placement for Sketch-like per-target copies. Raw root-level masks must first be grouped. Existing destination-parent clipping/masking is inherited as normal sibling insertion.

525 production/tool source and generated-WASM hashes matched before and after the independent test runs. The generated WASM was `e002c8fe2efc46b09fed04bbc21404c5b7bdfb773e12081c41cfc004c824ea1b`; the public copy matches. Additional final test and stylesheet hashes are recorded separately. No production source was edited or temporarily swapped by this reviewer.

## Independently executed final checks

| Run | Result | Evidence |
|---|---:|---|
| Client workflow suites | 155/155, 10 files | `frontend-focus-final.json` |
| Renderer ownership/cache/presentation and pointer suites | 60/60, 10 files | `renderer-focus-final.json` |
| Supplemental mounted Canvas, old/new Inspector, actual mask pixels, derived-layout rejection and clone semantics | 13/13, 4 files | `independent-final.json` |
| Native keyboard/main/preload chain | 66/66 | `native-focus-final.log` |
| Compositor Node suite | 4/4, including 1,500 generated scene comparisons and CPU sampled pixels | `composite-final.log` |
| Direct subtraction differential | 66,625 comparisons | `subtraction-final.json` |
| Existing Figma marquee differential | 12,000 comparisons across 3,000 scenes; 11,486 nonempty | `figma-marquee-final.json` |

These are executions, not an additive claim of unique coverage. Many tests also appear in the implementers' reports. Generated comparisons are not extra unit tests. The final focused client command initially named a non-existent plural pointer-intent path; the matched 10 files are reported honestly. The actual `canvas-pointer-intent.test.ts` was then included in the separate 60-test run.

Mounted React/jsdom tests use the real Canvas, children, event handlers, Editor and WASM. Only the rendering-device surface boundary is replaced. Native tests execute actual modules while substituting Electron/OS boundaries. The mask and font witnesses use actual CPU/WASM calls; none requires a GPU, browser, socket, remote fetch or a Rust build.

## Findings resolved before this publication

1. **Raw mask roots could change unrelated siblings.** A real nested-frame CPU render showed an existing red sibling changing from `[255,0,0,255]` to transparent after insertion of a raw mask. The original snapshot/node identity alone did not detect this rendering change. The planner now rejects raw root-level masks with a group-first error. Four independent tests verify rejection leaves the entire original document and visible sibling pixels unchanged, and grouped masks retain real internal clipping at both page and nested-frame destinations. The historical failing witness is preserved in `resolved-mask-regression.json` and explicitly labeled resolved.
2. **Preflight and rejected commit could leave the shared font environment changed.** Planning restores destination fonts in `finally`; command publication restores the currently retained document's fonts in `finally`. The independent natural failure test constructs a valid depth-64 target, plans an instance with no materialized children, then reaches real derived layout where a child exceeds the depth limit. It proves the un-restored environment changes nonempty glyph output, and verifies the real command restores output, exact document, original snapshot, selection and history after rejection. Owner tests additionally cover embedded-font success and undo/redo.
3. **Assigning a partially shared candidate could mutate an old animation branch during normalization.** Publication now detaches the complete bounded candidate with `cloneValue` before assignment. The real owner test checks old clip-track identity, full old snapshot, unaffected node sharing and undo/redo; it passed again in the independent 155-test run. An independent check confirms the clone preserves signed zero and `Float32Array` values/ownership. This full clone is an explicit clipboard-operation cost, not a frame-loop optimization.
4. **Center-selection treated an empty/hidden selection as a zero box.** The command now uses actual current-page scene entries and returns when no eligible entries exist. The final actual Canvas suite verifies empty, hidden, stale and other-page no-op behavior, while visible locked selections can center without changing zoom.
5. **Momentary-X state needed profile-change cleanup.** The final Canvas subscribes to profile changes and clears momentary state along with keyup, blur, visibility and session changes. The actual mounted suite covers those boundaries.

The supplemental Canvas test initially surfaced a React `act` warning after the new profile subscription. The test now wraps its external preference writes in `act`, without removing the strict no-console-error assertion. All 13 supplemental tests pass afterward.

## Equivalence details and non-vacuous controls

- The draw-planner change keeps the old subtraction arithmetic, order, UV/scissor metadata, signed-zero/nonfinite edge behavior and object ownership. It allocates a fragment list only when a cut occurs. Prefix/suffix mutations are detected 27,828 and 29,790 times respectively. The old planner passes three semantic tests and fails the new work-count assertion (`flatMap` count 2,016 rather than 0); see `composite-baseline-negative.log`. Complexity remains pairwise; these checks do not establish GPU speed or broad FPS gains.
- Figma marquee behavior is compared against the exact pre-expansion Canvas expression plus existing `Editor.select` deduplication. Removing ancestor eligibility fails 7,602 generated comparisons. This differential does not substitute for the mounted Sketch-specific tests.
- Parent+child Inspector edits are not assumed to be excluded. Four mounted old/current component comparisons exercise frame/group and both selection orders, width/height/position/stroke edits, and undo/redo. Both versions intentionally read units from the immutable pre-edit `editor.state.doc` while mutations go into a separate draft; the scoped reader therefore preserves the original snapshot basis within each multi-node mutation.
- `clipboard-negative-controls.mjs` creates isolated temporary source copies only. Removing the mask guard gives two intended assertion failures with the grouped positives still passing. Removing command font restoration gives the intended real glyph-comparison failure while the clone test passes. It validates failure counts and messages, and never swaps production files.
- Minimap absence was reviewed beyond CSS hiding: import/mount/state/control/style references are removed. The final 155-test run includes the three production-Canvas absence tests. The removal owner's old-mounted and CSS-hidden controls were also inspected; their working context double reached the intended draw/absence assertions.

## Performance interpretation and remaining limits

The compositor owner's paired CPU measurements support lower draw-plan allocation/CPU work in the stated multi-tile fixtures; they do not prove actual display smoothness or a GPU improvement. Its single-tile case had a small sub-microsecond regression. Prior Rust timings remain observational, including compile-only regressions; this supplemental review does not turn them into broader speed claims. The earlier transport allocator experiment was correctly deferred because median gains did not establish better tails; shipping transport production remains the frozen baseline.

Tap-X persistent mode, full native Sketch anchor parity, arbitrary keyboard layouts and other explicitly documented workflow gaps remain outside these bounded additions. See `docs/LOCAL_CANVAS_WORKFLOW_COMPARISON.zh-CN.md` and `frontend/design-client/SHORTCUT_PROFILES.md`. Real browser/Electron, OS input, system clipboard and GPU verification remain necessary in an authorized runtime.

## Reproduce with installed dependencies

From the repository root:

```sh
node frontend/design-client/node_modules/vitest/vitest.mjs run \
  --config testing/verification-performance-review2/vitest.config.mjs
node testing/verification-performance-review2/subtraction-differential.mjs
node testing/verification-performance-review2/figma-marquee-differential.cjs
node testing/verification-performance-review2/clipboard-negative-controls.mjs
node --test frontend/design-client/src/kernel/gpu/composite-draw-plan-cpu.test.mjs
DESIGN_COMPOSITE_BASELINE=1 node --test \
  frontend/design-client/src/kernel/gpu/composite-draw-plan-cpu.test.mjs
# The preceding baseline command must fail only its work-count assertion.
node --test frontend/design-desktop/test/keyboard-shortcuts.test.mjs \
  frontend/design-desktop/test/main.test.mjs frontend/design-desktop/test/preload.test.mjs
```

From `frontend/design-client`:

```sh
node node_modules/vitest/vitest.mjs run --maxWorkers=1 \
  src/canvas-selection-workflows.test.tsx src/canvas-selection-cpu.test.tsx \
  src/canvas-minimap-removal.test.tsx src/canvas-workflow-shortcuts.test.ts \
  src/paste-over-selection.test.ts src/shortcut-profiles.test.ts \
  src/shortcut-dom.test.tsx src/selection-hierarchy.test.ts \
  src/selection-properties.test.ts src/smart-paste.test.ts
node node_modules/vitest/vitest.mjs run --maxWorkers=1 \
  src/canvas-pointer-intent.test.ts src/kernel/gpu/composite-draw-plan.test.ts \
  src/kernel/gpu/presentation-quality.test.ts src/kernel/render-mailbox.test.ts \
  src/kernel/tile-scheduler.test.ts src/kernel/presentation-ownership.test.ts \
  src/kernel/coverage-priority.test.ts src/kernel/coverage-retention.test.ts \
  src/kernel/exact-tile-cache.test.ts src/kernel/tile-preview.test.ts
```

`baseline-provenance.json` identifies exact prior-delivery component/shortcut preimages and the later pre-selection Canvas snapshot. Fixture component changes are import-path relocations only. The folder-local `publication.sha256` covers every payload file except itself.
