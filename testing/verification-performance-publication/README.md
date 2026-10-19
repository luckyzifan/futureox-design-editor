# Exact compositor planning: remove redundant fragment allocations

## What changed

Only `frontend/design-client/src/kernel/gpu/composite-draw-plan.ts` changed in production. The previous occlusion loop used `flatMap` and allocated a singleton array for every non-overlapping fragment/occluder pair. The replacement retains untouched fragments by reference and allocates an output list only at the first actual cut. All intersection arithmetic, comparisons, fragment order, tile identity, clipping and sampling transforms remain unchanged.

This does **not** reduce image precision, raster density, tile coverage, draw order or the number of visible draws. No shaders, render worker, Rust, WASM, navigation timers, cache budgets or cancellation policy changed. Pairwise intersection arithmetic is still quadratic in the resident tile count; this is a bounded allocation/iteration-overhead improvement, not a new spatial index.

The frozen before source is `composite-draw-plan.before.ts`, SHA-256 `c2299336e926a8c83ca3daeb92fde2db5b74a6770c4cf071d5c5ea84eae53f55`. The final production source is SHA-256 `8d9f7ee0a4679e7e53b2c9423b2ea0be1d4c6f4fca2d6896850edc90f02a157c`. No older Git HEAD or unrelated renderer was substituted as the baseline.

## Actual CPU comparison

Four independent Node v24.19.0 Linux/x64 processes ran in before/after/after/before order. Other workers confirmed they had paused heavy testing/builds before the controlled run. Each case warmed up 200 times, then ran seven fixed-iteration batches. The old/new functions ran unwrapped: counters and semantic assertions were outside the timing loop. Inputs, iteration counts and output draw counts were identical. Values below are milliseconds per planning call; each column contains the median of each independent process's seven batches.

| Workload | Draws | Before, two runs | After, two runs |
| --- | ---: | --- | --- |
| Single tile, control | 1 | 0.000108 / 0.000091 | 0.000106 / 0.000109 |
| 1080p Retina-shaped grid, 40 tiles | 40 | 0.140604 / 0.127104 | 0.005840 / 0.005154 |
| 64 disjoint residents | 64 | 0.331637 / 0.335796 | 0.012397 / 0.011458 |
| 4K Retina-shaped grid, 135 tiles | 135 | 1.460752 / 1.566343 | 0.048641 / 0.042998 |
| 256 disjoint residents, stress case | 256 | 5.267267 / 5.701662 | 0.153794 / 0.146772 |
| 117 progressive-history/blend items | 107 | 0.386048 / 0.424091 | 0.046823 / 0.042041 |
| 128 fully opaque overlapping items, control | 1 | 0.015782 / 0.015454 | 0.013437 / 0.011591 |
| 128 transparent overlapping items, control | 128 | 0.010757 / 0.011190 | 0.010383 / 0.009169 |

The single-tile control's aggregate median worsened by about 7.9%, from 0.0000994 to 0.0001073 ms. This sub-microsecond difference is retained rather than omitted. That case does no occlusion work, so it does not support an improvement claim. The 256-item case is a deliberate upper-end planning stress test, not a claim that every viewport retains this many tiles.

Typical disjoint grids measured about 24–33 times faster **in this isolated CPU planning stage**; mixed progressive history measured about nine times faster. These are not whole-app speedups, FPS results, device/GPU benchmarks, end-to-end navigation measurements, or comparisons against Figma/Sketch applications. Resident texture upload/draw and actual GPU pixel presentation were not run. The earlier exploratory after-only run is retained separately and excluded from the comparison.

Raw samples, process medians, source hashes and output witnesses are in `abba-*.json`; `summary.json` contains every case, including the worse control. `.started` files record UTC process start times. `source-hashes.json` also records the unchanged current WASM `e002c8fe2efc46b09fed04bbc21404c5b7bdfb773e12081c41cfc004c824ea1b` used by the existing focused test setup.

## Correctness and anti-vacuity

The new Node suite (`composite-draw-plan-cpu.test.mjs`) passes 4/4:

- A 64-disjoint-tile scenario keeps all 64 exact draws and reduces measured `Array.prototype.flatMap` invocations from 2,016 to zero. This instrumentation is confined to that synchronous work-count test.
- Exact `assert.deepStrictEqual` comparisons preserve array shape/order, tile object identity, clip/placement fields and the scissor/quad/UV results at DPR 0.75, 1, 1.25, 2 and 3. Direct numeric comparisons retain NaN and distinguish signed zero; JSON serialization is not used as the equality oracle.
- 1,500 seeded generated scenes exercise active/inactive tiles, opaque/blended layers, multiple densities, explicit and camera-derived placement, clipping and gutters. Input objects and payloads must remain unchanged.
- Boundary cases include touching/half-open rectangles, fractional shared edges, zero area, signed zero, and the prior behavior for NaN/infinite input. This change does not silently introduce a different validation policy.
- An independent deterministic CPU color/texel-ramp sampler produces exactly identical bytes through mixed progressive and blended layers. Reversing draw order, dropping background content or shrinking clip ownership each demonstrably changes its bytes. This is a synthetic software pixel/ownership witness, **not** a GPU screenshot comparison or an actual WASM image render. Exact equality of the real production draw/UV inputs is the backend-independent precision proof.

The frozen before source fails exactly the new work-count assertion (2,016 versus zero), while the other three semantic tests pass. Both the initial pre-edit failure and the explicit frozen-baseline rerun are retained. This is an expected negative control, not a release failure.

Existing focused Vitest suites pass 66/66 across 17 files. The initial 49 tests cover: compositor plan, presentation quality, render mailbox, tile scheduler, presentation ownership, coverage priority/retention, exact tile cache and tile preview. The remaining 17 consumer tests cover progressive quality, page translation, retained-frame commit, resident frame/geometry/pose/program/uniform contracts. Together these cover cancellation, superseded queued cameras, FIFO still-current jobs, failure recovery, publication ownership and resident retention alongside the existing geometry cases. Resident tests exercise CPU plans and contract/driver doubles, not an actual GPU. TypeScript passes. These focused results do not claim the full repository suite; final integrated verification belongs to the parent task.

## Reproduction

From the repository root, with the existing dependencies installed:

```sh
node --experimental-transform-types --import ./testing/lib/register-typescript.mjs \
  --test frontend/design-client/src/kernel/gpu/composite-draw-plan-cpu.test.mjs

# Expected exit 1: exactly the work-count test fails; three semantic tests pass.
DESIGN_COMPOSITE_BASELINE=1 node --experimental-transform-types \
  --import ./testing/lib/register-typescript.mjs --test --test-reporter=tap \
  frontend/design-client/src/kernel/gpu/composite-draw-plan-cpu.test.mjs

# Run only in an otherwise idle executor; no production files are swapped.
node --experimental-transform-types testing/verification-performance-publication/benchmark-draw-plan.mjs before
node --experimental-transform-types testing/verification-performance-publication/benchmark-draw-plan.mjs after
node --experimental-transform-types testing/verification-performance-publication/benchmark-draw-plan.mjs after
node --experimental-transform-types testing/verification-performance-publication/benchmark-draw-plan.mjs before

cd frontend/design-client
node node_modules/vitest/vitest.mjs run \
  src/kernel/gpu/composite-draw-plan.test.ts src/kernel/gpu/presentation-quality.test.ts \
  src/kernel/render-mailbox.test.ts src/kernel/tile-scheduler.test.ts \
  src/kernel/presentation-ownership.test.ts src/kernel/coverage-priority.test.ts \
  src/kernel/coverage-retention.test.ts src/kernel/exact-tile-cache.test.ts \
  src/kernel/tile-preview.test.ts
node node_modules/vitest/vitest.mjs run \
  src/kernel/progressive-quality.test.ts src/kernel/page-translation.test.ts \
  src/kernel/gpu/retained-commit.test.ts src/kernel/gpu/resident-frame.test.ts \
  src/kernel/gpu/resident-geometry.test.ts src/kernel/gpu/resident-pose-frame.test.ts \
  src/kernel/gpu/resident-programs.test.ts src/kernel/gpu/resident-uniforms.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

No dependency install, browser, GPU, socket, remote fetch or Rust/WASM build is needed for this change.

## Relation to published rendering methods

The relevant public principle is removing avoidable CPU/submission work while keeping rendering semantics explicit. Figma describes explicit draw arguments, resource reuse and batched uploads in its [2025 WebGPU engineering article](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/). Sketch describes identifying redundant offscreen work in its [2021 rendering article](https://www.sketch.com/blog/tech-talk-how-we-made-the-mac-app-faster-with-improved-rendering/) and incremental scene-graph updates in its [2023 canvas article](https://www.sketch.com/blog/canvas-tech/).

This patch implements a smaller repository-specific CPU allocation optimization. Those articles do not establish that Figma or Sketch uses this exact subtraction algorithm, and the benchmark does not establish parity with either application.
