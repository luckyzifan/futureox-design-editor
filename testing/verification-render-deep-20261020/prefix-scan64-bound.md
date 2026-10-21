# GPU-proved signed64 scan-add candidate

Status: the bounded scan-add path defaults on after the actual-device checks in
[the 2026-10-21 record](../verification-render-low-latency-20261021/README.md).
The initial author's CPU checks below are historical; the linked record contains
the independent GPU and integrated application gates. It does not establish
an isolated whole-app speedup attributable only to this arithmetic change.

## Scope

The implementation changes only `texture-prefix.wgsl`, `prefix-module.ts`, and the diagnostic return in `texture-prefix.ts`, under `frontend/design-client/src/kernel/gpu/`.

- `VITE_DESIGN_PREFIX_SCAN64=0` disables the otherwise enabled compile-time constant. The constant is included inside the arithmetic helper as well as admission, so disabled builds can eliminate the candidate branch without relying on workgroup-memory constant propagation.
- Existing complete-row finite/exponent span and weighted-window admission remain authoritative and unchanged.
- One per-workgroup `scanNarrow` flag is set only when prior admission succeeds and `24 + span + 2 * bit_length(length) <= 63`.
- Eight scan addition call sites use a new helper. For narrow rows it adds the low two u32 words, propagates the low-word carry, and sign-extends bit63 into both upper words. Other rows call the original signed128 helper.
- Original sample decoding, sample-times-position multiplication, 128-bit workgroup arrays, `PrefixPair` storage, 4 MiB scratch, band allocation, scan barriers, prefix solver, rational weights and final rounding remain unchanged. This is arithmetic narrowing only, not packed storage.
- `prefixMetadata.unused` counts accepted narrow line/channel instances. The already-existing 16-byte counter reset/readback is sufficient; `readCounters()` exposes `narrowLines`. The count is not unique source rows and can repeat across channels/bands/repeated passes.

## Proof, including mixed signs

For a finite nonzero binary32 source bit pattern, `prefix_sample(bits, minimum)` is an exact signed integer at quantum `minimum - 150`. Let `P = 24 + span`, `L = length`, and `b = bit_length(L) = floor(log2(L)) + 1`. The decoded integer has absolute value strictly below `2^P`; zeros, including negative zero, have value zero. Subnormals are normalized to exponent bucket 1 by the existing min/max scan and obey the same strict mantissa bound.

For any subset of the admitted row:

- Absolute sum is at most the sum of absolute values, strictly below `L * 2^P < 2^(P+b)`.
- Absolute position moment is strictly below `(L*(L-1)/2) * 2^P < 2^(P+2b-1)`. The empty/single-zero-position case is zero directly.

With `P + 2b <= 63`, both are strictly within signed64 (in fact the displayed bounds leave at least one spare magnitude bit). No assumption of positive samples, cancellation, or a CPU image certificate is used.

Every Blelloch up-sweep node is a disjoint interval subset. Every down-sweep prefix and the left interval added to it are disjoint. Inclusive conversion adds the original lane value to its exclusive prefix, also disjoint. The previous-chunk carry and the current local prefix cover disjoint source indexes. Thus the bound applies to every intermediate, not merely the completed row. Global moment indexes remain `chunk + lane` as in the original implementation. Padded lanes have exact zero and preserve the completed total at lane255 of a partial final chunk.

Under that bound, addition modulo 2^64 followed by sign extension is exactly the same four-word signed128 value as the original addition. The high-word carry may be discarded because signed64 overflow has been ruled out. Stored prefixes, solver inputs and final pixel bits therefore remain identical. Out-of-bound rows still use original signed128 additions and retain the original prefix admission; the new gate does not route them to scalar filtering.

At the relevant lengths the narrow thresholds are: L3484 => span <=15; L1108 => span <=17; L16384 => span <=9. Actual hit rates must be observed; bounds on the original decoded image do not establish bounds for the filtered source texture.

## CPU test

`frontend/design-client/src/kernel/gpu/prefix-scan64.test.mjs` extracts the candidate WGSL narrow-add body and the repository original 128-bit add body. Its small JS translation performs u32 wrap at WGSL scalar arithmetic statements. It models the existing 256-lane Blelloch schedule and checks every helper result plus every stored sum/moment against an independent sequential BigInt reference.

Run from the repository root:

```sh
node --test frontend/design-client/src/kernel/gpu/prefix-scan64.test.mjs
```

Coverage includes gate equality/one-above, powers of two, original-reason and flag-off gates, signed carries and sign extension, all-positive/all-negative/mixed values, subnormal/zero/-zero, lengths 1/2/255/256/257/511/512/513/1108/3484/16384, partial final chunks, one-above-threshold and span40 wide rows, and a source contract that solver/storage remain unchanged.

The CPU test is not GPU evidence. Subsequent actual Metal tests must compare flag-off/on raw bits for both prefix-accepted and prefix-declined channels, force narrowLines>0 and wide accepted lines>0, and cover the ordinary RGBA and opaque RGB variants. Real 117 measurements must report narrowLines alongside acceptedLines and matched build/source hashes.

## Expected cost and limits

This removes two limb additions/carry steps from scan additions for admitted narrow rows. It does not reduce workgroup/storage traffic, sample decoding, per-sample moment multiplication, number of scans/solves/resolves, dispatch count, or band count. Runtime branch overhead/sign-extension registers could offset the reduced arithmetic, and the GPU compiler may lower these differently. There is no speedup claim. Keep the flag off unless actual-device correctness and matched application measurements justify enabling it.

## Validation record

- `node --test frontend/design-client/src/kernel/gpu/prefix-scan64.test.mjs`: **6/6 passed**. The first run was 4 passed/2 failed because the new CPU schedule harness used JavaScript floating `/2` for WGSL unsigned integer division in its down-sweep loop. The harness was corrected to `Math.floor(stride/2)` and rerun; this was not a production shader change.
- From `frontend/design-client`: `node node_modules/vitest/vitest.mjs run src/kernel/gpu/prefix-rgb-resolve.test.ts src/kernel/gpu/prefix-band.test.ts src/kernel/gpu/prefix-mul-zero.test.ts src/kernel/gpu/texture-prefix-linear.test.ts src/kernel/gpu/texture-prefix-window.test.ts src/kernel/gpu/prefix-preflight.test.ts src/kernel/gpu/opaque-filter.test.ts --maxWorkers=1`: **7 suites, 73/73 passed**.
- The existing barrier-scheduled production-WGSL scan test needed its injected helper argument renamed from `prefix_add` to `prefix_scan_add`. `node node_modules/vitest/vitest.mjs run src/kernel/gpu/texture-prefix-scan.test.ts --maxWorkers=1`: **15/15 passed** after that binding update. Its original wide values and reordered lane schedules remain intact.
- `npm run typecheck` was attempted during concurrent source integration. It reported only missing `wholeFilterAxes` return-type fields in `render-worker.ts` at lines 1771/1893 from the separate whole-plane candidate. A combined typecheck is required after that integration; this record does not claim typecheck success.
- Real GPU, shader compilation and application gates have not been run by this change's author for the scan64 candidate. The GPU acceptance run must include an independent scalar reference; comparing two prefix variants that both enable scan64 does not independently validate its arithmetic.
