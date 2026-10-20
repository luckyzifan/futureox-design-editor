# Long-row prefix scan candidate

Final disposition: the candidate was parked after full Electron comparison
failed interaction acceptance. See the
[local rendering report](../verification-render-local-20261020/README.md).

This candidate follows the 23c96df release baseline. At this record's creation
only the targeted CPU checks below have run; actual GPU correctness and
Electron latency are separate parent-run gates. No text-layout version-two
changes, dynamic-uniform flag or kernel-cache flag are part of this change.

## Implementation

Rows below 512 samples keep the original `prefixScan` dispatch and solve.
Long rows use four compute stages, followed by the existing channel resolve:

1. The original `prefixScan` performs its unchanged complete-line exponent,
   finite-value, coefficient and signed-128 admission, then returns.
2. Each `(line, 256-sample chunk)` scans independently using that line's common
   exponent quantum. Moments retain the original whole-line sample index.
3. One 64-lane workgroup per line computes exclusive chunk carries. Padded
   chunks are zero. A storage barrier precedes overwriting chunk totals with
   carries, in addition to the workgroup-memory scan barriers.
4. The original solve formulas read full prefixes by adding the relevant carry.
   Prefix index `k > 0` belongs to chunk `(k - 1) / 256`; index zero stays zero.
   Adjacent local prefix differences recover individual samples without carry
   loads, with a separate first-sample-of-chunk case.

Source sampling, rational kernel construction, support/gutters, admission
thresholds, nearest-even rounding and per-pixel exact fallback are unchanged.
`prefix-int128.wgsl` is unchanged.

The three buffer sizes and readback allocation still sum to exactly 4 MiB:

| Region | Bytes |
|---|---:|
| Prefix pairs | 3,275,776 |
| Results | 901,120 |
| Metadata | 16,384 |
| Readback | 1,024 |

Metadata contains the existing 16-byte counter header, one 16-byte header per
line, and two 16-byte vectors per chunk per line. Band planning now includes
that exact extra bound rather than enlarging the scratch allocation.

At length 3,484, 14 chunks fit with 29 lines per band, consuming 13,472 metadata
bytes. The aligned stream strip remains 58 lines. The chunk scan dispatch has
406 independent workgroups instead of 29 workgroups each iterating 14 chunks.
This is a concurrency description, not a measured speedup. Long rows now encode
four compute passes per band instead of two; carry lookup adds integer work and
small storage reads. The tradeoff requires actual GPU measurement.

At other lengths the metadata bound can reduce the band. For example length
513 has three chunks and admits 146 lines rather than the former 199. Prefix,
result and metadata indexes all use the same resulting `count`.

## Executed CPU checks

From `frontend/design-client`:

```sh
node node_modules/vitest/vitest.mjs run \
  src/kernel/gpu/texture-prefix-scan.test.ts \
  src/kernel/gpu/prefix-band.test.ts --maxWorkers=1
```

Final result: two files, 28 tests passed, zero failures/skips, 1.54 seconds.
An earlier run also passed all 28 before the explicit storage barrier was
added; these overlapping runs are not additive.

The scan checks execute the production serial and independent-chunk WGSL
statements with CPU generators representing barriers. They execute the
production chunk-carry scan and prefix/sample lookup bodies too. Independent
scalar BigInt sums/moments provide the expected bits. Coverage includes reverse
chunk ordering, different lane schedules, 512/513/767/768/769/1024/3484/16384
lengths, padded chunks, every prefix and recovered sample, signed cancellation,
large modular values, nonzero line/base offsets and exact chunk boundaries.

The budget checks cover every admitted length through 16,384 and the unchanged
4 MiB allocation. Short-row layouts and constrained two-line bands are covered.
`git diff --check` passed for the five changed source/test files.

No GPU command, application run, typecheck or full build was launched by this
subtask. CPU scheduling is not GPU memory-order or shader-compilation evidence.

## Frozen source identity

Paths are relative to `frontend/design-client`.

```text
6603763a9d7429e9b7f185f6d604488056152a56a201ea3cab87750dd9b6c423  src/kernel/gpu/texture-prefix.wgsl
0e5ec8d90607a16e4f305c3a22a5802f2aaeb627e7ad6641e37b5217974fb39f  src/kernel/gpu/texture-prefix.ts
ad68af03966f919d3f48836931f5b95db98180058331c765e01d3b48cc588da9  src/kernel/gpu/prefix-band.ts
168626aa8c7d10178f25b53ea7ac9946f7c983f1c1b943a90f195ba344381d9e  src/kernel/gpu/texture-prefix-scan.test.ts
08fcef75ae2f432ddd16bd818d63b279102dda989900ea2599288af57e0d73f5  src/kernel/gpu/prefix-band.test.ts
```

## Earlier evidence is separate

The [old scan record](../verification-prefix-scan-20261020/README.md) documented
the Blelloch conversion and proposed independent chunks without implementing
them. Its CPU-only statement describes that subtask's checks. Separate saved
[Metal math results](../verification-lifetime-cache-20261020/gpu-math-candidate3/results.json)
and [Metal texture results](../verification-lifetime-cache-20261020/gpu-textures-candidate3/results.json)
record the prior implementation's actual GPU checks, including length 3,484 and
radius 1224.3035888671875. They do not validate this new chunk pipeline.

The parent owns fresh GPU/Electron measurements. Concurrent user applications,
including StorageManagement/Figma activity, remain a performance-comparison
limitation; no user process was stopped by this subtask.
