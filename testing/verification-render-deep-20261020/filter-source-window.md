# Bounded physical filter source window

This is a default-off API foundation (`VITE_DESIGN_FILTER_SOURCE_WINDOW=1`),
not a renderer reuse optimization or a claim that GPU waits are reduced.
It does not change allocation budgets, tile order, cache admission or renderer
call sites. It supports one continuous physical subrectangle, without wrapping.

`Driver.passFilterWindow(target, uniforms, inputs, window, channels, filter,
availableBytes)` returns false without commands or target-certificate changes
when unsupported or invalid. Accepted calls use the same existing exact prefix
or scalar filter programs and the original 4 MiB scratch admission. The renderer
must continue accounting for the difference in `driver.scratchBytes`.

The private path requires live same-driver textures, physical RGBA32F source
and target, no target/input resource alias, integer bounded physical offsets,
matching logical dimensions, bounded integer world coordinates, mode22/tent
and a valid axis. SharedArrayBuffer-backed uniforms are rejected: validation
must not race another writer. Uniforms, the physical rectangle and the input
array are captured before any uniform-arena rollover. A window proves geometry,
not finite pixels, opaque alpha, valid content or a resource-lifetime lease.

The dedicated exact shader reserves u52 `(physicalX, physicalY, 1, 0)`. Ordinary
mode22 clears unknown u52 without mutating its caller; ordinary all-zero
uniforms avoid an extra clone. Other compositor modes retain their gradient
alpha use of these words. A literal compile-time false disables the physical
addressing branch when the feature is off.

Prefix scan length, exponent quantum, positions and moments use the original
logical `u1.zw`. Only the final texture-load coordinate receives the physical
origin. Both certified and full rational scalar sources first apply their
unchanged logical bounds/zero padding/clamp, then use the same translation.
Opaque/RGB paths therefore share the exact same source window as fallback.

Every texture writer now permanently revokes private image-range and axis
program identities in addition to existing rational/finite/opaque proofs.
Reassigning the public `finitePixels` flag cannot resurrect an old upload
certificate. Fresh validated uploads still create new private certificates.

## CPU validation

Seven targeted suites cover 115 final passing cases: window geometry/no-op
admission, physical alias rejection, shared metadata, caller mutation during
allocation hooks, both axes, RGBA/RGB, physical6556/logical3484 scans and uniform
rollovers; plus existing prefix packing, scan barriers, opaque behavior, image
upload, table lifetime and all writer-revocation paths.

The combined run initially had 114 passes and one existing opaque-dispatch
expectation failure caused by the newly appended optional window argument.
Both assertions were updated to check their established four argument slots;
the opaque suite then passed all 27 cases. No arithmetic/source change was
needed for that test correction.

The independent GPU proof is prepared, but has not been run by this author:

```sh
cd frontend/design-client
VITE_DESIGN_FILTER_SOURCE_WINDOW=1 \
VITE_DESIGN_PREFIX_RGB_RESOLVE=1 \
VITE_DESIGN_OPAQUE_TENT=1 \
VITE_DESIGN_GPU_TIMINGS=0 \
DESIGN_TEST_OUTPUT=/path/to/new-proof-directory \
bun scripts/check-filter-source-window.ts
```

It needs no external 117 document/scene. Its 18 generated fixtures use current
native tent coefficient packets and include 117-sized logical support, a 6556
row physical texture, NaN/Inf outside the window, per-channel prefix decline,
multiple bands, signed subnormals, logical zero/clamp edges, forced scalar,
alpha-only output and in-window NaN. The reference uses a separate tightly
cropped texture with the original scalar mode22 path and no prefix contract.
The candidate uses the actual window API, with two uniform slots to force real
rollovers. Raw f32 bits, prefix counters, opaque hits, rejected no-op calls,
budget and scratch retirement are checked. Add `--prepare-only` to generate
and hash fixtures without starting a browser/GPU.
