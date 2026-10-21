# Complete image range scan

The production `certifyExactImageRange` still reads every RGBA word and checks
finite exponents, all four exponent minima/maxima, exact opaque alpha, and
nonnegative RGB. The change removes per-component `Math.min`/`Math.max` calls
and dynamic channel-indexed writes by scanning one RGBA tuple at a time with
scalar extrema. It does not sample pixels or widen the later interpolation
bound.

Unsigned source words greater than `0x80000000` are exactly negative nonzero
values. Both signed zeros remain excluded from exponent extrema; subnormals
retain exponent bucket 1. Empty channels still normalize to `[1,1]`.
Certificates and their arrays remain frozen and privately registered. Shared
arrays, wrong types, empty inputs, incomplete tuples and nonfinite values keep
the original rejection behavior.

## Matched CPU measurements

The benchmark decodes the actual 117 image once with the checked-in WASM,
then passes the same immutable 736×414 buffer (1,218,816 f32 components) to the
saved original production function and current production function. Its pixel
SHA256 is `3f2aa1e9b7921407cdf332f738d105afd994166e209623c5440df40344634c36`.

Each independent Node 24.12.0 process uses 12 warmup calls per variant and
five ABBA rounds, with 20 calls per timed batch. Every batch's certificate
must equal the original, the source pixels must remain unchanged, and source
hashes must match before/after. Times include certificate allocation/freezing
and WeakSet registration, but exclude fixture decoding, hashes and comparisons.

| Run | Original median/call | Updated median/call | Updated/original |
| --- | ---: | ---: | ---: |
| [1](run1.json) | 7.991 ms | 2.661 ms | 0.333 |
| [2](run2.json) | 8.026 ms | 2.673 ms | 0.333 |

This is a reproducible CPU function improvement of about 66.7% on this real
input. It is not a GPU result or an editor latency measurement. Browser/Electron
JIT behavior and integrated upload timing remain separate acceptance checks.
The JSON records contain all sample times, runtime identity, source hashes and
fixture/WASM hashes.

The two records were regenerated after removing one extra blank line at the
end of the saved baseline snapshot. The function body, production source and
benchmark script were unchanged. The current baseline SHA256 is
`2dad06fa0c0ae380211cbc4b74b08d6d32189da43009d2b088a818c7cfebeb09`; production source SHA256 is
`659f35dec7bba1442e7f48b60d966bedbeb76a9e7c2e861a7e64afd41cdfc381`.

From the repository root, provide the actual imported scene/document fixtures:

```sh
DESIGN_117_SCENE=/path/to/117-scene.json \
DESIGN_117_DOCUMENT=/path/to/117-document.json \
DESIGN_RANGE_OUTPUT=/path/to/new-result.json \
node frontend/design-client/scripts/benchmark-image-range.ts
```

`baseline-range.ts.txt` preserves the original production function; the script
uses Node's TypeScript stripping to load it without editing production code.
The result path must not already exist.

## Correctness checks

From `frontend/design-client`:

```sh
node node_modules/vitest/vitest.mjs run src/kernel/gpu/exact-image-x-table.test.ts src/kernel/gpu/image-upload-validation.test.ts src/kernel/gpu/image-table-lifetime.test.ts src/kernel/gpu/image-resolve-step.test.ts --maxWorkers=1
npm run typecheck
```

Result: **4 suites, 69/69 passed**; project and benchmark-script typechecking
passed. New comparisons cover every f32 exponent and sign with four mantissa
edges in every channel, 256 varying-size mixed-sign inputs, nonzero view offsets,
all-zero channels, and NaN/infinity in each channel of the final tuple. Input
words remain unchanged. Existing interpolation bounds, private certificate
ownership, upload validation and table lifetime tests also pass.

No GPU test, application build or application benchmark ran for this change.
