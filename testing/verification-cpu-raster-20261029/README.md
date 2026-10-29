# CPU raster: exact semantics and shared work (2026-10-29)

This increment addresses finite-coordinate interpolation overflow, unchecked clipping, unbounded scanline work, and repeated four-phase geometry preparation in the Rust CPU renderer. It also gives the GPU interval producer the same checked scanner. Existing sampling positions, f64 crossing operation order, curve flattening tolerances, f32 color/effect arithmetic, HDR/export and compositing order within each phase remain authoritative.

## Frozen acceptance and scope

- Precision: bit equality with the frozen old scanner and full renderer on admitted geometry. Independent integer point-in-polygon and analytic non-rectangle answers supplement compatibility tests. Unsupported interpolation must return an error rather than emit incorrect pixels.
- Work: one geometry preparation for all four phases, including strokes; retained scratch within one painter; local active-edge order repair with a bounded fallback to full sorting. Four distinct sample ordinates still require four sets of crossings.
- Storage: one byte per pixel stores all four binary phase bits, replacing four f32 arrays (16 bytes/pixel). Analytic masks and post-paint/effect/color surfaces retain their floating-point representation. The existing aggregate compositor budget is unchanged; compact storage is charged once and is owned for the full consumer lifetime.
- Performance criterion, fixed before measurement: at least 5% lower median isolated raster time than four independent current fallible calls on each frozen benchmark fixture. Also retain P95, maximum, digest and failures. This is not an end-to-end G2/G4/G5 or real-file latency acceptance.
- Test environment: native aarch64 macOS, standard Rust f64/f32; native release benchmarks, portable non-SIMD WASM desktop-dev smoke. No hardware GPU or GUI acceptance is claimed.
- Boundaries: 8,000,000 conservative edge visits per scanner, also bounding scanline row count; cooperative cancellation in preparation, every scanline (including empty output), crossing/order repair, mask initialization and writing. Invalid limits, nonfinite points and unsafe interpolation propagate errors. The legacy infallible convenience APIs wrap the fallible implementations and panic on invalid input; production renderer uses only fallible workspace APIs.

## Implementation

- `raster.rs`: shared point/bounds validation and checked clip; fallible CPU APIs; compact `SampleMasks`; zero-cost typed coverage views for painters. Finite open/non-fillable contours do not expand fill bounds. Nonfinite points are rejected consistently, including in open contours.
- `raster_scan.rs`: one scanner implementation per sampling scheme shared by CPU masks and GPU interval output. Edge dx/dy are calculated and checked once. Active ordering carries a stable activation ordinal so coincident crossings retain the old tie order. x values are recomputed, never advanced by repeated slope additions. More than 4*A local moves causes an O(A log A) fallback. After the same work admission, edges sharing one vertical supporting line are certified to have zero horizontal coverage, so no empty scanlines are traversed.
- `area_program.rs`: reuses the shared guards/scanner and removes its duplicate edge-preflight traversal and output-dependent cancellation checks.
- `renderer.rs`: one compact bundle per fill or stroke; all phases reuse one scratch arena. Stroke order within each phase is preserved. Coverage traits introduce no dynamic dispatch.
- `math.rs`: checked rectangle endpoints/intersection, i64 subtraction for disjoint rectangles, explicit invalid-rectangle failure instead of release wrapping.
- Benchmarks: repair RenderOptions fields; 100 measured samples, named nearest-rank P95 and separate max. `sample_edges` alternates independent/shared/tiny-skia order and includes low-active ellipses, high-active stars and zero-output retracing.

## Open-source reference

The active-edge ordering and bounded scanline-output organization are independently implemented with reference to [tiny-skia 0.12.0 scan/path.rs](https://github.com/linebender/tiny-skia/blob/v0.12.0/src/scan/path.rs) and [AlphaRuns](https://github.com/linebender/tiny-skia/blob/v0.12.0/src/alpha_runs.rs). No upstream scanner code is copied. tiny-skia 0.12.0 is pinned as a dev dependency under its BSD-3-Clause license. Its fixed-point edges and coverage policy are not substituted into the existing float/HDR renderer.

The oracle compares exact binary classification at the four sample points. Near-edge tiny-skia rounding is excluded using an exact cross-product margin; the integer oracle and frozen old scanner cover those cases separately. The benchmark reports every tiny-skia sample mismatch. A nonzero mismatch prohibits treating its timing as an equivalent-quality ranking. Vello CPU, sparse span/RLE storage, SIMD, new AA and curve-tolerance changes are not part of this increment.

## Reproduction and evidence

Run from `design-studio` unless otherwise specified:

```
cargo test -p futureox-design-kernel --lib --test raster_safety --test raster_oracle --test sample_edges --test kernel --test pixels --test coherence --test color --test texture_renderer --test texture_replay --test compositing_memory --test export_regions --offline -j 2
cargo bench -p futureox-design-kernel --bench sample_edges --bench raster --no-run --offline -j 2
cargo bench -p futureox-design-kernel --bench sample_edges --offline -j 2
cargo bench -p futureox-design-kernel --bench raster --offline -j 2
```

From the repository root:

```
python3 testing/verification-cpu-raster-20261029/run-parity.py
CARGO_BUILD_JOBS=2 python3 design-studio/scripts/build-web.py --profile desktop-dev
node testing/verification-cpu-raster-20261029/wasm-smoke.mjs
```

`before/` and `baseline.json` freeze pre-increment source, including the user's existing renderer edits. The paired harness builds a separately named baseline crate from that source and compares full Engine outputs: 30 RGBA cases and 15 managed/HDR f32-bit cases, across analytic/figma/figmaSubpixel, clips, opacity, masks, gradient paints, multiple stroke alignments, shadows and foreground/background blur. `renderer-parity.log` records each result and digest.

`final-tests.log`, `raster-tests.log`, `bench-build.log`, `wasm-build.log` and `wasm-smoke.log` record scoped verification. Historical compile/probe setup errors were repaired before the final results; early logs are not acceptance evidence. Final source/lock/artifact hashes and benchmark measurements are recorded with the completion results below.

## Rollback

Restore only the files listed in `baseline.json` from their corresponding `before/` files after checking that no later edits would be overwritten. Remove the newly added `raster_scan.rs`, raster safety/oracle tests and tiny-skia dev dependency when rolling the whole increment back. Regenerate Cargo.lock after restoring the manifest; do not reintroduce unrelated dependencies removed by pre-existing work. Restore skill notes from `before-guidance/` only after checking their `guidance-baseline.json` provenance and later edits. Preserve unrelated pre-existing work. Rebuild affected native/WASM artifacts. This is a source increment, not a packaged release or full-app acceptance.

## Completion results

The first measured candidate passed the 5% target for both ellipses and the star, but failed it for vertical retracing (1.34% median improvement). This result is retained in `sample-bench-before-degenerate.log`. The subsequent exact vertical-support shortcut keeps the same admission and adds an independent cancellation-count regression; no threshold was changed.

Expanded regression at the pre-shortcut candidate: **880 passed, 10 explicitly ignored, zero failures**, including the 764 passing library tests. The final shortcut has an additional admitted-degenerate-path regression and reruns the scanner/oracle/budget/cancellation checks. Full renderer pairing passed all 30 RGBA and 15 HDR f32-bit comparisons. Fresh WASM execution covers all three profiles, with finite extended-range HDR checks.

The benchmark compares four independent calls with a shared workspace reused within the loop; its warm arena can also be reused across nodes within one real Painter, but is not retained across whole render invocations. It is not a cold-frame or whole-app speed measurement.

Final release measurements (100 samples after warm-up, alternating order):

| Fixture | Edges | Four independent median ms | Shared median ms | Reduction | Median gate |
| --- | ---: | ---: | ---: | ---: | --- |
| ellipse | 1000 | 0.455917 | 0.216333 | 52.55% | PASS |
| ellipse | 10000 | 1.242812 | 0.424604 | 65.84% | PASS |
| star | 1000 | 10.320459 | 9.597354 | 7.01% | PASS |
| retraced | 256 | 0.014437 | 0.002833 | 80.38% | PASS |


All new/independent four-phase masks have identical hashes. Coverage payload is exactly 1/16 of the former dense four-f32 representation. The star's observed P95 is **23.012 ms shared versus 19.932 ms independent**, so this run does not establish improved tail latency. Outliers and the failed earlier degenerate-path candidate are retained, not filtered out.

The three non-degenerate tiny-skia comparisons differ at 108, 60 and 14,621 binary sample positions respectively. Its timings remain diagnostic; this is not a claim of matching its edge precision or beating open-source renderers. The independent rational and safely separated tiny-skia oracle cases pass.

Final targeted checks: **9 integration tests plus 6 scanner/AreaProgram unit tests passed**, including the new zero-area shortcut, cancellation on non-collinear retraces, original budget rejection and frozen scanner parity. Final paired full renderer and rebuilt WASM checks passed again after the shortcut. Both release benchmark executables exited 0; the complete renderer benchmark ran all three node counts. See `benchmark-runs.json`, `benchmark-summary.json`, `raster-bench.log`, `raster-tests-final.log`, `scanner-unit-final.log`, `renderer-parity.log` and `wasm-smoke.log`.

`source-before-bench.json` and `source-after-bench.json` match exactly. `artifacts.json` binds the final outputs and `environment.json` records the local toolchain. No background build or test was running during either final benchmark; normal desktop applications remained running (process inventory retained). GUI, physical GPU readback, real-file workload matrices and whole-editor 33/100 ms targets are NOT_RUN for this increment.
