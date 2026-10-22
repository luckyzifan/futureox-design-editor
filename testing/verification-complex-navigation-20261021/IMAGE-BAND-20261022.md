# Exact image band composition candidate — 2026-10-22

This is an allocation/lifetime candidate under the existing strict
`VITE_DESIGN_EXACT_CLAMP_PREFIX=1` painter gate. It adds no shader and leaves
the default route unchanged. Actual GPU and whole-editor acceptance are
separate from the focused tests below; those results must be recorded before
calling the remaining 117/FIG latency or sharpness problems resolved.

## Observed allocation problem

The real 117 phase-4 256 MiB diagnostic still rejected an allocation after
the earlier constant-target repair. At the rejection, four live
2428×1248 RGBA32F textures each occupied 48,482,304 bytes: the original parent
was still shared by four samples, and three independent image samples had
already completed. A new mode-2 paint plane needed another 48,482,304 bytes
with 227,925,060 working bytes and no free pool. Nine admission waits consumed
about 6.959 seconds. Queue completion could not free these still-readable
planes. These measurements describe the failed old allocation path, not
candidate latency.

The first actual 256 MiB band run subsequently passed this image allocation
point, but **the render still failed** before the background capture. Its
mode-26 allocation needed 48,269,088 bytes; the final failure diagnostic
reported 251,011,396 working bytes against 268,435,456 budget bytes. It still
held four live parent planes, reusable band
storage and a no-longer-pinned image asset. Neither capture entry point had
requested an asynchronous admission before `run(26)`. This run is retained as
`deep-117-phase4-band-256-v1/gpu-result.json`; it does not establish completed
output or latency acceptance.

## Restricted replacement

`GpuRenderer.streamImageLeaf` preserves the original mode-2 stored-paint
result followed by the original mode-3 source-over operation. Each paint uses
the full native image-coordinate field, matrix, size, mask and correlated
sample index. The field origin remains in uniform lane 51; changing the
physical band does not recompile or rebase its sampling coordinates.

The candidate admits only a managed exact coherent painter request with:

- One full-domain image paint, normal blending and unit paint/node opacity.
- A native integer `opaqueRect` covering the entire four-sample fill domain.
- A private standalone upload proving opaque alpha, finite nonnegative RGB
  below 2 per channel, and an exact integer source/target lattice.
- Matching complete target domains, no clip, mask, effects, strokes, atlas,
  mip substitution, display arithmetic, material substitution or display filters.

A normal unit-opacity isolation container may be omitted only when it has
one actual visible compiled image child, no authored paint/effect/clip/mask
operation, and matching native child-input and child-suffix domains. Missing
compiled children and finite zero-opacity children already draw no pixels.
The same finite-image certificate that proves the existing transparent
source-over identity is required before this isolation is omitted.

The independent finite-image host option may coexist with this candidate.
That option selects its alternate arithmetic only for mode 51; this band
lane executes mode 2 and mode 3 throughout. It does not claim to use a new
f32 image algorithm.

## Sampling and ownership

Bands proceed from top to bottom. A band stores 64 output rows plus the next
positive sampling-neighbour row when it exists. It writes only the first 64
rows through a full-target-origin, target-local scissor. Original bottom and
right edges retain their original outside-zero bounds.

The image paint is finite under the private upload and native-address
certificate. The old destination may contain HDR, infinity, NaN or signed
zero. Its positive zero-weight neighbours remain observable in the existing
sampler, so the last uniquely owned destination is saved with a raw texture
copy of all 64+1 rows before any write. Its bits are neither sampled nor
recomputed during that copy. The original mode-3 sampler then reads this
saved destination, including those neighbours.

Earlier phases receive independent full output textures. Only the last
remaining explicit alias may reuse the old full target. An absent alias
counter does not certify uniqueness. Coverage, coordinate, image, constant,
interaction, nested-prefix and filter-cache ownership all reject that reuse.
No pass samples its own attachment. The image remains pinned through every
actual admission/checkpoint; the original full coordinate field is reacquired
after each possible checkpoint, before its next use.

An encoding or cancellation error propagates to the existing frame abort.
It does not attempt scalar fallback on a partially encoded frame or advance
any completion epoch. Local save/paint allocations and source pins unwind;
already completed earlier sample outputs remain owned by the aborting frame.

## Focused verification before actual GPU validation

The following command passed **6 suites, 128 tests**, including **28 new band
tests**. These use instrumented drivers and establish branch selection,
uniform/scissor domains, raw-copy inputs, bounded allocation accounting and
ownership/cancellation behavior. They do not establish actual GPU arithmetic
parity or whole-editor latency.

```sh
node node_modules/vitest/vitest.mjs run \
  src/kernel/gpu/image-band-composition.test.ts \
  src/kernel/gpu/paint-merge-admission.test.ts \
  src/kernel/gpu/compact-solid-target.test.ts \
  src/kernel/gpu/painter-stage.test.ts \
  src/kernel/gpu/stream-image-fields.test.ts \
  src/kernel/gpu/gpu-resource-boundary.test.ts
```

Run from `frontend/design-client`. The new tests include partial-tail rows,
all four original phases, a four-alias destination model below five full
planes, nonfinite/signed-zero old-destination copy words, field reacquisition,
image pins, unsupported source ranges/domains, and injected admission,
copy and paint failures. `git diff --check` also passed.

The frozen source cohort for this pre-GPU result is:

| Source | SHA-256 |
| --- | --- |
| `renderer.ts` | `e3e443b00485f4046b6f92e8991e0bfb0b32f2806afba550c2d06381c918d3b9` |
| `image-band-composition.test.ts` | `6de693d95201b2cd63988ccd9ae83709aa48f9c5350db7e23d54aeef2abde119` |

Independent actual-device comparisons must require a real stream hit and
compare raw output against the explicitly disabled method on the same source
cohort. A larger reference budget is only an oracle admission aid, never a
256 MiB product acceptance result. Retain rejected or failed runs separately.

## Capture admission follow-up

Both actual mode-26 capture sites now request headroom for the capture's
physical size before encoding its four-source read, then recheck cancellation
after the awaited boundary. An exact-size reusable pool allocation skips this
wait. The replay branch never allocates that capture and does not request its
headroom. Color-surface admission charges the actual RGBA32F or RGBA8 format.
The capture equation, original fractional rectangle, source order and filter
arithmetic remain unchanged.

Six new `backdrop-capture-admission.test.ts` tests cover an actual pressure
model that requires both covered pool disposal and last-resort used-image
eviction, cancellation and rejected completion, exact-size pool reuse,
generic capture versus replay, and format-specific byte accounting. The final
focused run of that suite plus `backdrop-filter-renderer`, `painter-stage`,
`reclaim-maintenance` and `image-band-composition` passed **5 suites, 112 tests**.
This count overlaps the earlier focused command and must not be added to it.
The follow-up renderer SHA-256 is
`300925f2e02162e2993661b2cf5d973e1faa5ec1efccf387bad3e622d6ac1081`.
The follow-up required the separate actual GPU completion check below.

The subsequent actual Metal-device run
`deep-117-phase4-band-256-v2/gpu-result.json` completed the first 64×64 native
hotspot at the unchanged 268,435,456-byte ceiling. It recorded one actual
image stream hit, one successful attempt without scalar retry, a
267,702,164-byte peak and finite raw RGBA32F output for all 4096 output pixels.
Only **733,292 bytes** remained below that ceiling; this is not evidence of
comfortable headroom for all scenes.

The cold operation, including pipeline setup and raw readback, took 2744 ms.
Its measured graph time was 1436.1 ms and finish time 1045.3 ms; these include
overlapping/nested diagnostic spans and must not be summed into additional
work. The raw output SHA-256 was
`894dc6af14b7b75beef695a1e5aaf104c74f8c57610612a30d393fbfa02f3aa9`,
from native scene
`e214874eb5a02a810441128ec34044bba7e116081a2ba01a09c6bcecd3f6b941`.
This establishes completion of that one hotspot only. The independent raw
references below assess its numerical output. Further 117/FIG requests and
actual complex motion remain separate requirements; no blur-free or
low-latency whole-editor acceptance follows from this result.

The subsequent independent raw comparisons succeeded: the banded 256 MiB
result, the same-cohort phase-4 whole allocation route with this production
method explicitly disabled, and the current-WASM phase-3 whole-scene reference
matched **all 16,384 f32 words with zero differences per comparison**. The
phase-3 reference disabled native capture-read narrowing and reproduced the
older native-scene hash beginning `91b7d963`. The two reference routes used
an explicit 1024 MiB diagnostic budget so they could execute the original
allocation strategy; this does not raise the product budget.

| Sequential single-hotspot run | Cold time including raw readback | Peak bytes | Measured completion waits |
| --- | ---: | ---: | ---: |
| Phase-4 band, 256 MiB | 2744.0 ms | 267,702,164 | 1855.6 ms |
| Phase-4 whole, 1024 MiB reference | 3089.4 ms | 509,924,740 | 2153.2 ms |
| Phase-3 whole, 1024 MiB reference | 2696.7 ms | 835,199,620 | 1768.9 ms |

These single ordered runs establish exact output for this hotspot and lower
peak allocation with completion under 256 MiB. They do **not** establish a
consistent latency improvement: the phase-3 reference was slightly faster in
this sequence. Present-only timing, further requests and actual complex
117/FIG motion still require their own measurements.
