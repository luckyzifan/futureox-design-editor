# Exact rational line bound B

The implementation uses the independent opt-in
`VITE_DESIGN_PREFIX_TIGHT_BOUND=1`; default off executes the existing window-bit
gate. The exact bound is calculated once on the CPU from the actual uploaded
coefficient bytes. The GPU-side bound-building helper has been removed; lane 0
only checks the certified integer bit count in u49.w. No scan, filter support,
solve indexing, tail evaluation, coefficient value or RNE changes are made.

## Original algebra

Let `P=24+span`, `M=2^P`, `n=interior`,
`S=C1-C2>=0`, and `I=C1+S`. Every decoded signed sample has magnitude
strictly below M. This n conservatively covers every line length, so the CPU
certificate does not depend on the requested crop. For short lines it may
over-report. At every output position:

```
abs(centerSample) < M
abs(leftSum+rightSum) < 2*n*M
abs(leftDistance+rightDistance) < n*(n+1)*M
```

The distance bound is the sum of `1+...+n` on each side. Each direct tail
distance contributes at most two samples. Therefore

```
B = C0 + 2*n*I + n*(n+1)*S + 2*sum(d=interior+1..reach, Cd)
```

bounds the sum of absolute magnitudes of all original weighted terms divided
by M. Every product, subtraction, centre addition and partial tail accumulation
has magnitude strictly below `M*B`, independently of input signs or
cancellation. Prefix differences are completed before multiplication.

Use the exact gate

```
24 + span + bit_length(B) <= 123
```

Since `B < 2^bit_length(B)`, this implies `M*B < 2^123`. The existing
`span<=40`, `length<=16384` proof separately bounds all unweighted full-line
prefix/moment/absolute-index intermediates below `2^95`. That independent
guard is retained.

## Existing factor shortcut

The factor helper can compute the same interior as

```
(centerSample+sums)*I - (centerSample+3*distances)*D
I=C0+D, S=3D, 0<D<=C0
```

The triangle bound for these recombined partials is `M*(B+2D)`, not `M*B`.
Because the helper proves `D<=C0<=B`, this is at most `3*M*B < 2^125`, still
strictly within signed128. Dividing out a common power of two reduces the
intermediate magnitude. The final numerator is identical to the original
formula, including direct tails, so remains below `2^123`. Keeping the factor
shortcut enabled is safe; the extra two-bit headroom is explicit.

## Building B cannot overflow

The CPU parser accepts ordinary ArrayBuffer-backed Uint8Array views only,
including unaligned subarray offsets. It checks the complete native packet
length, zero reserved header, native accumulator-word count, coefficient word
count 1–4, positive denominator below 2^96, and encoded reach 3–2048.
It checks C0>0, every encoded coefficient<=denominator, C1>=C2, and at most
four direct tails for each derived interior before accumulating B. Thus coefficients/S are below `2^96`,
I below `2^97`, and `n*(n+1)<2^23` with n<=2048. All positive partials used
to construct B, including four tails, sum to less than `2^120`.

These checks protect arithmetic admission; they do not replace the existing
immutable native-tent provenance with a general arbitrary-kernel validator.
Malformed packets produce no certificate. Missing proof, a non-matching
radius/interior class or invalid uniform bits uses the previous window gate;
all existing GPU finite/span/kernel guards and the scalar fallback remain.

The encoded native reach is distinct from the renderer's conservative capture
halo (`ceil(radius)+1`). The actual native r38 packet has interior 37 and
encoded reach 39 (two tails); the r1224 packet has 1223 and 1225. The parser
uses the encoded reach and conservatively allows up to four tails.

## Upload authority and amortization

`certifyPrefixRationalBound(bytes)` returns an opaque frozen object. A private
WeakMap stores its encoded reach and precomputed bounds for interiors reach−1
(integer radius) and reach−2 (fractional radius). No mutable bytes or public
caller-selected bounds are retained. `prefixRationalBoundBits(packet,radius)`
checks the private identity, finite radius 3–2048, encoded ceil(radius), and
floor(radius)−1, then returns a cached number. Repeated H/V/strip lookups perform
no BigInt work or byte parsing.

The driver binds this certificate to the actual immutable uploaded texture and
revokes the association on writes or retirement. The radius lookup chooses
the existing interior definition; it does not generate or replace coefficients.
The GPU accepts only integer boundBits in 1–120 when the feature is enabled.
Value zero retains the old gate. The packet certificate and texture ownership
remain separate from the GPU's per-line sample-span proof.

## Actual native coefficient results

| Radius | Length | n | Exact B | bit_length(B) | Prior span | New span |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 38.25948715209961 | 1108 | 37 | 462154532446520475648 | 69 | 22 | 30 |
| 1224.3035888671875 | 3484 | 1223 | 14819734306164621312 | 64 | 27 | 35 |

The next spans 31 and 36 decline. These are exact native WASM coefficient
calculations, not an estimated floating-radius reconstruction.

## CPU checks

The CPU suite executes the production parser/certificate and compares its
cached bit count to an independent BigInt formula. Real WASM coefficients cover eight radii, lengths
1/2/79/1108/3484/16384, all-positive/all-negative/alternating/random signed
integer samples at the new maximum span, actual prefix differences, every
weighted partial, recombined factor partials, direct tails, and an independent
scalar convolution. Arbitrary bounded integers over-approximate f32 samples.

It also covers malformed headers/reach/coefficients, truncated/extra bytes,
SharedArrayBuffer rejection, unaligned views, opaque/frozen and forged objects,
post-certification input mutations, the worst 96-bit denominator/coefficient
construction, conservative four-tail bounds, and exact 30/35 boundaries.
Result: **14 bound tests plus 10 existing preflight tests passed** (24 total,
2.50 s); TypeScript passed. This CPU validation did not run GPU code or build
the application. The GPU-side predecessor was pixel-correct but slower in the
parent's measurements; those measurements do not establish performance for
this CPU-certified implementation. The direct-scalar GPU corpora must verify
newly admitted spans 23/29/30 vs 31 and 28/34/35 vs 36 before enabling this
candidate in a real Electron measurement.
