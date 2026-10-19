# Canvas exact-snapshot scene reuse

## Result

Implemented and verified a bounded Canvas-local optimization against the exact delivered source. It removes duplicate scene/index work for an unchanged displayed snapshot while newer Editor previews are published, and avoids a second scene traversal when the refine overview describes the current snapshot. Geometry, numerical precision, spatial cell policy, paint ordering, pointer batching, release/modifier handling and renderer behavior are unchanged.

On six mounted production Canvas + real Editor/WASM CPU traces (3,000/10,000 nodes; sparse/dense/16-level nested), 50 preview publications produced:

- Scene builds: **100 → 50**
- SpatialIndex builds: **100 → 50**
- Old displayed-snapshot rebuilds: **50 → 0**
- New current-snapshot builds: **50 → 50**, deliberately preserved
- Cell-reference insertions: **50% fewer** in these fixtures
- Exact final document hashes and complete SceneEntry hashes in every baseline/candidate run

The fixture keeps an old displayed frame while one unsupported vector-preview blend requires normal renderer refinement. This is a real Canvas production branch, not a claim that every edit has two scene traversals. Unchanged camera/hover/selection already avoided scene rebuilding in the delivered source; zero work on those controls is preserved, not newly claimed as a saving. A settled current/refine snapshot now eliminates one duplicate traversal; the global scene() function is not cached.

## CPU-path timing, with limits

ABBA order was baseline, candidate, candidate, baseline. Other tasks in this work session paused heavy commands during the run. This is **coordinated among our tasks, not guaranteed exclusive-host timing**. Values below are the mean of two totals for 50 mounted Canvas/Editor.preview updates, measured with performance.now. They are CPU-path elapsed time, not process CPU accounting, browser/GPU FPS, input-to-display latency or a general whole-application speedup.

| Fixture | Delivered mean ms | Candidate mean ms | Lower mean |
|---|---:|---:|---:|
| Sparse 3k | 1569.62 | 1323.41 | 15.69% |
| Sparse 10k | 5323.45 | 4600.67 | 13.58% |
| Dense 3k | 1404.60 | 1256.54 | 10.54% |
| Dense 10k | 6602.88 | 5856.59 | 11.30% |
| Nested 3k + 16 groups | 1748.23 | 1513.73 | 13.41% |
| Nested 10k + 16 groups | 7440.43 | 6359.64 | 14.53% |

All raw results are retained. Dense 3k candidate-b was 1308.49 ms, slightly slower than baseline-b at 1296.44 ms; this sample was not removed. Two repetitions per variant are descriptive, not a statistical confidence claim. The deterministic work counts and exact-output checks are the primary evidence.

## Scope and safety

Product changes:

1. frontend/design-client/src/canvas-scene-snapshots.ts: Canvas-only owner-bounded current/displayed scene reuse; lazy index and root overview; scalar-only refine record.
2. frontend/design-client/src/Canvas.tsx: integrate only the three derivation sites. Pointer/gesture code is untouched relative to the delivered source.
3. frontend/design-client/src/kernel/picking.ts: read-only opaque geometry-resource epoch. It advances after successful initialization, document-font changes, PDF font loading and PDF document installation. Failed resource installation is atomic and preserves the old epoch.
4. frontend/design-client/src/CanvasScrollbars.tsx and ruler-guides.ts: readonly array input annotations only.

Published Editor documents are immutable by contract, not runtime freezing. Copy-on-write edit/preview/component/history publication was reviewed; the new store must not be used with mutable drafts or arbitrary mutable documents. Keys include exact document identity, nodes/pages/fonts guards, page ID and resource epoch. Editor/session/page/readiness transitions clear the owner slots. New previews cannot alias through unchanged state.version.

At most two full scene/index snapshots are retained, matching the delivered current/displayed ownership. Refine-only documents retain a four-number Bounds and key; their temporary SceneEntry array is released. No WeakMap/history cache, LRU, growing epoch chain, new full refine snapshot, admission rejection or geometric simplification is introduced. This is a bound on cache ownership, not a claim of an absolute process-memory cap. A failed scene/index build never publishes a partial usable result.

Scene consumers were reviewed and exercised with deep-frozen arrays, matrices, bounds and ancestors. Query/filter results allocate before reverse/sort. The Canvas entries array is readonly at its interface. Geometry.ts remains byte-identical to the delivered base (SHA-256 7d63dbbac86e790fcbbd3dcab2d8b61fe4a968cec8361b4a7bc951b4f12c4f58).

The existing picking engine has a global font environment. Epoch invalidation prevents reuse across a font switch but does not choose a document's fonts for old displayed snapshots. That pre-existing global-font behavior is unchanged and is not claimed fixed. Tests compare fresh scene() under the same active environment and explicitly restore font environments where required.

## Verification

- Final TypeScript no-emit check: passed.
- Focused regression run: **121 passed, 1 explicit pre-existing skip**, 0 failures across 5 files:
  - canvas-scene-snapshots.test.ts: 20 passed
  - canvas-event-batching.test.tsx: 34 passed, 1 existing skipped reproduction
  - canvas-selection-cpu.test.tsx: 6 passed
  - canvas-selection-workflows.test.tsx: 29 passed
  - editor-lifecycle.test.tsx: 32 passed
- New mounted Canvas CPU suite: **9/9 passed** separately against the exact delivered Canvas and the candidate.
- ABBA: **four 9/9 runs**, with all recorded product/test inputs unchanged between start and end.
- Exact equality covers schema 2–14; all SceneEntry fields including Object.is numeric checks; ordered rectangular and point-hit queries; nested transforms; inherited locks; component/layout/override publications; preview/cancel/commit; undo/redo; page changes; same-ID reopen; readiness and owner changes; real font switching/default restoration; rejected font loads; PDF resource installation; deep-frozen old snapshots; and local shape preview/release with exact 55.125 × 44.375 dimensions.
- Mounted history/page/reopen checkpoints and shape release results match in every baseline/candidate run.
- The prior event-batching tests retain exact release samples, modifiers, hover, cancellation, freehand and queue behavior.

The existing skip is “reproduce direct addPage during a live vertex transaction”; it is not counted as a pass. Early test-development errors (invalid synthetic page ID, and initially expecting refinement while the supported live-preview path intentionally suppresses it) were corrected in fixtures. The preserved failed controls log is not a passing result.

No browser, GPU, sockets, dependency installation, repository fetch, product-asset rebuild or native backend modification was performed. The existing portable WASM SHA-256 is 2c50f87de40b6e2ecc456eb053706d4e2c3c058da82aafffd1b191eddd8b039a. Font tests use the shipped deterministic font-fixture helper and baseline Noto font, with its declared external temporary cache; there are no new undeclared generated inputs.

## Baseline and reproducibility

Delivered ZIP: futureox-desgin-design-tools-performance-cumulative-20261019.zip

- ZIP SHA-256: 02241e7467435d4e47a79041d0fccfea234c52d1b3a3b0e46eaa8f781ff1bafb
- Git base: 71d32153e6f55b3723c99708b4c4c49ac7342e67
- Baseline Canvas SHA-256: f04c992f19561fc13973be193a6571a287a4139d6c92f5aa8eb25583e23045e3

The exact original Canvas source is kept in the new verification folder. The baseline loader checks its hash and loads it at the original module location, preserving production relative imports without rewriting its code. Other relevant sources are unchanged except the listed candidate edits.

From frontend/design-client:

    node node_modules/typescript/bin/tsc --noEmit
    node node_modules/vitest/vitest.mjs run src/canvas-scene-snapshots.test.ts --maxWorkers=1
    node node_modules/vitest/vitest.mjs run --config vitest.scene-reuse.config.ts
    CANVAS_SCENE_BASELINE=1 node node_modules/vitest/vitest.mjs run --config vitest.scene-reuse.config.ts

From the repository root, choose a fresh output directory:

    python3 testing/verification-canvas-scene-reuse-20261019/run-abba.py /absolute/path/to/new-results

Evidence: abba/manifest.json, abba/summary.json and each full log/JSON/JSONL; regression-tests.json; baseline/candidate-correctness.json; correctness-comparison.json; final-typecheck.log; final-source-hashes.json; changes-from-delivered.patch. All evidence is additive under testing/verification-canvas-scene-reuse-20261019 and the separate scene-reuse work directory. Prior ZIPs and verification folders were not changed.
