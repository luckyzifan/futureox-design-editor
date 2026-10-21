# Exact rational interior factoring

The factored path defaults on after the actual-device verification recorded in
[the 2026-10-21 record](../verification-render-low-latency-20261021/README.md).
Set `VITE_DESIGN_PREFIX_FACTOR=0` to inject `PREFIX_FACTOR=false`.
No scan, result layout, output region, tail coefficient or rounding changes are
part of this candidate. A failed coefficient identity keeps the prior formula.

## Exact identity from uploaded coefficients

The existing interior numerator is

```
pixel*C0 + sums*I - distances*S
I = C1 + S
S = C1 - C2
```

The helper verifies the actual integer coefficient words satisfy:

```
D = I - C0 > 0
D is a power of two
D <= C0
S = 3D
```

The expression is then exactly

```
(pixel + sums)*I - (pixel + 3*distances)*D
```

Let `t = trailingZeros(D)` and `g = min(trailingZeros(I), t)`. The helper
extracts `K = I >> g` and verifies that reconstructing `K << g` reproduces all
128 bits of `I`, with `K` a nonzero u32. Accepted coefficients use

```
((pixel + sums)*K - ((pixel + 3*distances) << (t-g))) << g
```

This uses one 128×u32 product and exact shifts. `3*distances` is formed by two
integer additions. All operations preserve the original rational numerator;
the direct tail products and `prefix_round_wide` are unchanged. No rounded
floating radius participates in this proof.

For the actual native 117 coefficient packets:

| Radius | K | g | t |
| --- | ---: | ---: | ---: |
| 38.25948715209961 | 30,088,485 | 37 | 55 |
| 1224.3035888671875 | 30,088,485 | 27 | 40 |

Other native radii can legitimately miss this specialization. For example,
`38 + 2^-26` has a native denominator within the existing 96-bit limit, but
its remaining intercept factor is wider than u32 and keeps the original path.

## Signed intermediate bounds

Use the preceding [window-bound proof](prefix-window-bound.md):
`L = min(N, 2R+1)`, `M = 2^(24+span)`,
`abs(pixel+sums) < LM`, and `abs(distances) < L²M`.
The coefficient identities plus the explicit `D<=C0` check imply `I<=2C0`.
Therefore

```
abs((pixel+sums)*I) < 2 L M C0
abs((pixel+3*distances)*D) < M C0 + L² M S
```

Their sum is bounded by `3 L M C0 + L² M S`, exactly the conservative bound
already covered by the current weighted admission. It is below `2^121` for
admitted lines. The smaller, pre-shift terms are integer divisions of these
same terms by `2^g`; they cannot increase in magnitude. The unweighted
`pixel + 3*distances` also remains within the independently proven signed128
line bound. Negative inputs, arbitrary cancellation and signed output remain
covered. The final shift and every meaningful interpreted intermediate fit
signed128; modular limb arithmetic cannot change the result.

## Cost and verification scope

The helper adds **no coefficient texture or prefix-buffer reads**: the original
function already loaded C0, S, I and the centre sample. It does add per-pixel
integer identity checks and factor extraction. These costs may offset some
multiply savings and require real GPU measurement. Moving the common proof
to a workgroup or a kernel certificate is a separate future change.

The CPU suite executes the actual WGSL helper control flow with exact BigInt
limb primitives, compares the admitted numerator with the original independent
three-product expression, and checks signed128 bounds. It covers actual WASM
coefficients for nine radii, lengths 1/79/1108/3484/16384, maximum admitted
exponent spans, all-sign extremes, cancellation and deterministic random
values. Invalid coefficient relations, high power-of-two limits and the
too-wide multiplier retain fallback. CPU tests do not certify GPU execution
or latency; those remain the parent's serial validation step.
