# Rational prefix window admission

Only the rational weighted bound changes. The finite/span/line-length/kernel
gates, full input line, exact coefficients, prefix construction, output window,
rounding guards and scalar fallback are unchanged. No samples are removed.

Let `N` be the full input length, `R` the actual encoded kernel reach, and
`L = min(N, 2R + 1)`. Let `P = 24 + span` and `M = 2^P`. Each signed decoded
sample has magnitude strictly less than `M`.

## Full-line arithmetic remains independent

The existing `span <= 40` and `N <= 16384` imply `P <= 64`. Before any rational
coefficient multiplication:

- Every prefix sum has magnitude less than `2^78`.
- Every prefix moment has magnitude less than `2^91`.
- An absolute-index product such as `x * leftSum` has magnitude less than
  `2^92`.
- Even a loose triangle bound for moment subtraction and both distance terms
  remains below `2^95`.

Thus these full-line intermediates fit signed128 independently of the weighted
admission. The tighter window must not replace the full-line scan or these
existing length/span guards.

## Only completed window differences receive coefficients

`prefixRational` first subtracts prefixes. The resulting `sums` contains at
most `L` samples. Every contributing distance is less than `L`: it is bounded
by both the kernel reach and the input-line extent. Therefore

```
abs(sums) < L M
abs(distances) < L^2 M
```

The immutable native integrated-tent coefficients are nonnegative and
nonincreasing: `0 <= Cd <= C0`. With `S = C1 - C2`, the linear intercept
`I = C1 + S <= 2 C0`. Consequently the sum of absolute magnitudes of the
centre, intercept and all direct tail products is bounded by `3 L M C0`.
This includes the full encoded reach, not just the linear interior. Current
rational kernels have one or two direct tail distances.

Let `b = floor(log2(L)) + 1`, `h0 = high(C0)` and `hs = high(S)`. Retaining
the existing expression

```
W = max(h0 + b + 3, hs + 2b + 4)
P + W + 3 <= 123
```

covers both bounds conservatively:

```
3 L M C0 < 2^(P + h0 + b + 3)
L^2 M S < 2^(P + hs + 2b + 1)
```

Their sum is less than `2^(P + W + 1)`, at most `2^121` under admission.
All weighted products and signed partial accumulations therefore remain well
inside signed128, including cancellation. No assumption of nonnegative image
samples or a positive lower bound is used. The existing rational-rounding
shift guards remain authoritative after accumulation.

This proof relies on the existing immutable native tent-kernel provenance:
the encoded reach is at most 2048, coefficients satisfy the tent identities,
and the fractional radius is at least 3 when that path is selected. Arbitrary
caller-created coefficient packets are not newly certified.

## Native coefficient boundary checks

| Radius | Input length | Full reach | Window length | Old/new weighted bits | Old/new maximum span |
| --- | ---: | ---: | ---: | ---: | ---: |
| 38.25948715209961 | 1108 | 39 | 79 | 82 / 74 | 14 / 22 |
| 1224.3035888671875 | 3484 | 1225 | 2451 | 69 / 69 | 27 / 27 |

`texture-prefix-window.test.ts` uses actual WASM coefficient packets for eight
radii and five input lengths, including one-pixel lines, cropped edges and the
16384 limit. At the maximum admitted span it checks all-positive, all-negative,
alternating and deterministic random signed integer samples. Every explicit
unweighted and weighted intermediate is checked against signed128 and each
output numerator is compared with an independent direct coefficient sum.
These arbitrary integers over-approximate the actual finite-f32 sample domain.

CPU verification does not establish GPU execution or latency. Real GPU
comparison against the original scalar rational filter and the full Electron
motion run remain the next acceptance steps.
