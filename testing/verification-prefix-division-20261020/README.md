# Exact quotient certification for prefix filters

The only production change is in `prefix-int128.wgsl`. It replaces the common execution of 24 bit-at-a-time division steps with a floating quotient proposal followed by an exact integer certificate. The original 24-step loops remain the fallback in both `prefix_round_ratio` and `prefix_round_wide`. Their sign, exponent, subnormal handling and nearest-even rounding are unchanged.

## Mathematical acceptance boundary

Let `N` be the unsigned magnitude after the original normalization shift and `D` the positive normalized divisor. The candidate is considered only when `N < 2^126` and `1 <= D < 2^103`.

The four integer limbs are converted to f32 and weighted by powers of two. A finite f32 division proposes a quotient; it is never used as a rounded pixel. The candidate quotient is restricted to `0 <= q < 2^24`. Estimates outside `[0, 2^24]`, including NaN, infinities and negative values, reject; the upper endpoint is conservatively clamped to `2^24 - 1`.

The exact product satisfies `D*q < 2^127`, so the existing 128-bit multiply cannot wrap. Up to eight exact corrections preserve `P = D*q`, adjusting `P` by `D` and `q` by one within the same range. An accepted result must establish:

```text
P <= N
R = N - P
0 <= R < D
```

These inequalities prove `q = floor(N/D)` and the exact remainder, independently of any accuracy assumption about f32 conversion, division or compiler reassociation. Subtraction is exact because `P <= N < 2^126`. The accepted quotient/remainder then enter the unchanged nearest-even logic. An unsuccessful estimate leaves the original dividend/divisor untouched and executes the old long division.

The wide helper's existing normalization guard already implies the multiplier bounds. The ratio helper additionally checks them; an input outside the conservative fast domain retains the previous path. No unsupported line is newly admitted.

Within the wrapper's admitted domain, every weighted limb and their sum remain finite: the largest numerator can round upward to `2^126`, and the largest divisor to `2^103`, both below f32 overflow. A nonzero integer divisor is at least one. The quotient proposal is also finite, and any proposal beyond the 24-bit range rejects. For a nonzero numerator, even the smallest ratio is above `2^-103`, so the estimate does not rely on f32 subnormal preservation.

## Focused CPU checks

```sh
cd frontend/design-client
node node_modules/vitest/vitest.mjs run src/kernel/gpu/prefix-int128-division.test.ts --maxWorkers=1
npm run typecheck
```

Final run: one file, five tests passed, zero failures/skips, 1.07 s. TypeScript passed. An earlier smaller vector run also passed; these runs overlap and are not additive.

The test executes the production correction and rounding control flow, supplying the unchanged multiword primitives as exact BigInt operations. Expectations are generated independently with BigInt division/remainder and rational nearest-even rounding:

- 6,771 wide cases cover 1–96-bit denominators, exact and half-ULP remainders, odd/even ties, signed zero, cancellation residuals, normal/subnormal boundaries, overflow, and the public rejection guards.
- 2,304 ratio cases compare the candidate with independent rational rounding and the retained long-division path.
- 876 quotient cases include deliberately biased estimates at and beyond the eight-correction boundary, maximum accepted numerator/divisor widths, quotient saturation, zero divisors, NaN/infinities and negative estimates. Every accepted result is additionally checked for exact recomposition and remainder bounds.

CPU execution does not establish native WGSL compilation, real device behavior or performance. The floating proposal can differ on a GPU; the exact certificate makes that a hit-rate question, while the real-device oracle is still required.

## Real GPU proof entry points

The existing `scripts/check-exact-prefix-math.ts` is extended to keep its independent Python integer/Fraction vectors and add 8,523 rows from the new independent BigInt oracle:

- Operation 6 runs actual `prefix_round_wide`, checking raw f32 bits and acceptance.
- Operations 7 and 8 run actual `prefix_try_quotient` with deliberate estimate errors, separately checking quotient/acceptance and all four remainder limbs.
- The generated extra vectors are saved as `wide-division-vectors.json` by the normal proof harness, alongside immutable input hashes and device output.

```sh
bun scripts/check-exact-prefix-math.ts
bun scripts/check-exact-prefix-textures.ts
```

These GPU commands were not run by this agent, to avoid contaminating the parent's serial Electron/GPU performance window. The parent runs both the math oracle and texture probes, including its separately added multi-chunk texture cases. Passing integer tests alone is not permission to claim identical GPU pixels or lower latency.

## Frozen source identity

| File | SHA-256 |
| --- | --- |
| `src/kernel/gpu/prefix-int128.wgsl` | `d9ba033147d3d05b22cefded3b710e1d91550e8a7ad1aec57749c9e7272f29aa` |
| `src/kernel/gpu/prefix-int128-division.test.ts` | `73c43f160e566bba6701ec458b88a4bb82e3eb7b59f7bad5134b8c61eefce489` |
| `scripts/exact-prefix-division-vectors.ts` | `570a8cd4d75166780c040924e403df16d034a6c560dd2baeda8466a64d4ddbf9` |
| `scripts/check-exact-prefix-math.ts` | `843f479af10546047d831483574ef11b590e1556bcb4a6e3eab05094e2688882` |

Paths in the table are relative to `frontend/design-client`.
