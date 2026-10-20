# Exact texture-prefix scan optimization

This increment changes only the 256-lane shared-memory scan in `frontend/design-client/src/kernel/gpu/texture-prefix.wgsl`, plus its dedicated regression suite. It does not change source sampling, blur support, rational coefficients, line admission, channel order, nearest-even rounding, or scalar fallback.

## Implemented and frozen

The previous Hillis–Steele scan performed 2,048 signed-128 additions per sum stream per 256-lane chunk. The new Blelloch upsweep/down­sweep plus inclusive conversion performs 255 + 255 + 256 = 766. Sum and moment together change from 4,096 to 1,532 additions. The existing per-chunk carry is unchanged. Each level accesses disjoint pairs; a workgroup barrier separates levels. Root reset adds one barrier: 18 before the existing final carry stage, versus 17 previously.

The moment value is computed once per lane and reused during inclusive conversion. No float arithmetic is introduced; the existing signed-128 helper operations remain unchanged.

Frozen SHA-256:

| File | SHA-256 |
| --- | --- |
| `frontend/design-client/src/kernel/gpu/texture-prefix.wgsl` | `12a33c531fb9cfcb0eb1b7aa3daa3c7760c077142129ae844e7c1f50d9a61d59` |
| `frontend/design-client/src/kernel/gpu/texture-prefix-scan.test.ts` | `4ed2b96afa04419b3c9038b219f41888ed3266f779c68d1d3bc60442c0a5727d` |

## Focused validation

Host Node was `v24.12.0`, Vitest `5.0.1`.

```sh
cd frontend/design-client
node node_modules/vitest/vitest.mjs run src/kernel/gpu/texture-prefix-scan.test.ts --maxWorkers=1
npm run typecheck
```

Final run: 15 tests passed in one file, no failures/skips, 0.885 s. TypeScript `tsc --noEmit` passed. The test extracts and executes the production WGSL scan statements with generators standing in for workgroup barriers; only scalar WGSL syntax and integer division are translated. A separate scalar BigInt prefix computes the expected sums and moments modulo 2^128. Cases cover forward/reverse/permuted lane scheduling, signed cancellation, large values, padding, cross-chunk carries, and lengths up to 16,384, including the actual 3,484-axis case. The instrumented production block also establishes the addition count.

The initial run passed 12 cases and failed three scheduling cases because Vitest expanded each array row into arguments, making `order` a number. The parameter rows were changed to objects; no production shader correction was needed. The final 15 cases overlap that initial run and are not additive.

This is a CPU scheduling/integer-equivalence test, not GPU execution. It does not compile WGSL through a real device or prove GPU pixels, timestamps, cancellation, memory lifetime, or user-visible speed. The parent integrated build/device run must verify successful prefix pipeline compilation, accepted/declined lines, exact floating output versus the previous implementation, and 117 latency. Shader arithmetic reduction alone cannot establish a proportional speedup.

## Why substantial GPU work remains

The latest real-device log analysis reported 18,064 accepted lines and 62,934,976 accepted pixels for a typical high-zoom tile. Their ratio is exactly 3,484 input samples per line; `18,064 / 4 - 3,484 = 1,032` output samples. The extra four pixels relative to the simplified 3,480/1,028 explanation are part of the actual region/gutter contract and must not be removed.

At input length 3,484, the 4 MiB scratch layout permits 29 lines per band. The current 64-row/column strips require 848 channel bands per tile: 1,696 compute passes plus 848 resolve passes, before source composition and other work. Each scan workgroup owns a line and serially processes 14 chunks of 256 samples. `prefixSolve` still evaluates about 18.64 million channel outputs per tile, including 128-bit rational arithmetic and a 24-step nearest-even division. The reported nine declined lines across twenty tiles are too few to explain the overall cost.

Most observed queue waiting occurs at maintenance admission checkpoints, not at final prefix scratch readback. A checkpoint's wall time includes previously submitted GPU work; removing that host wait does not remove the computation and may simply move the wait to a later fence. Fewer fences can improve scheduling and resource reuse, but they cannot by themselves establish a lower total GPU workload.

## Proposed follow-up: parallel chunks, not implemented

The present 29-line band launches only 29 scan workgroups, each with a serial 14-chunk loop. A GPU-only multi-dispatch design could:

1. Compute each complete line's admission and common exponent quantum.
2. Scan each `(line, chunk)` independently, increasing the typical scan dispatch to 29 × 14 = 406 workgroups.
3. Scan the small array of chunk totals.
4. Add the chunk carry in `prefixPairAt`, or apply it in a separate parallel pass.

Every chunk must use the same whole-line minimum exponent. Independent per-chunk quantization cannot be added without conversion. Global moments must retain the original source index. Signed-128 addition preserves the same prefix bits; dispatch boundaries provide GPU ordering without a CPU fence.

For the actual input, chunk sums/moments and line metadata require `29 × (16 + 14 × 32) + 16 = 13,472` bytes, within the existing 16 KiB metadata allocation. Other lengths need an explicit additional metadata bound in band planning; the present formula cannot be reused blindly. Reads crossing chunk boundaries, partial last chunks, zero/declined lines, cancellation and reuse of shared scratch all need tests. On-demand carry lookup adds storage reads and 128-bit additions to the solve path; a separate carry-application pass adds bandwidth and dispatches. Real timestamps are needed to choose between them.

## Proposed follow-up: align strips with bands, not implemented

For this exact geometry:

| Strip size | Horizontal strips | Vertical strips | Channel bands | Compute passes | Resolve passes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 64 | 55 | 17 | 848 | 1,696 | 848 |
| 58 | 61 | 18 | 628 | 1,256 | 628 |

Using 58 rows fills two 29-line bands instead of repeatedly encoding 29 + 29 + 6. It reduces prefix pass counts by 25.94% and lowers temporary strip memory. It adds six horizontal source strips and one vertical output strip, so source drawing/copy overhead rises. The number of source pixels and prefix arithmetic operations is unchanged; the pass-count reduction is not a measured speedup.

The filtered-axis input length remains unchanged: horizontal filtering still sees the entire source width and vertical filtering still sees the entire horizontal-result height. Thus the source support, line admission quantum and rational weights need not change. Actual image/mask sampling at different strip boundaries still requires pixel comparison. A future implementation should choose the largest multiple of the admitted band size not exceeding 64, independently per axis, rather than hardcoding 58 for every radius/extent. The renderer must obtain this plan from the same scratch/capability policy used by `TexturePrefix`.

## Proposed follow-up: bounded cross-tile horizontal reuse

A 1,032 × 64 RGBA32F horizontal strip is approximately 1.008 MiB. Vertically neighboring tiles stepping by approximately 1,024 pixels share roughly 2,460 of their 3,484 support rows: about 39 strips, or 39 MiB. A bounded 48 MiB cache could retain successful, exact horizontal results for a matching output column. A later vertical tile could copy those strips and compute only newly entering rows, avoiding both source four-sample composition and horizontal prefix filtering in the overlap.

Reuse needs document/resource generation, the exact root paint/path/effect witness, original f64 radius and kernel bytes, color domain, sampling lattice, and absolute output region. Node ID or a hash alone is insufficient. Current `n.rect` is cropped for the tile, so sharing it without a support proof is unsafe. Initially admit only results from a successfully completed frame; an abandoned encoder cannot certify produced pixels. Account every retained byte within the existing budget and keep device-loss/cancellation/epoch retirement rules.

This cache benefits vertically adjacent work in the same output column. An interleaved tile order can erase the benefit; request scheduling and cache locality need joint evaluation. It does not speed the first tile, and broader cross-column reuse requires an explicit batch/strip design rather than an unbounded whole-viewport RGBA surface.
