# Native large-preview regional entry candidate, 2026-10-22

This independent, default-off scheduling candidate enters the existing regional
preview assembly before compiling/encoding a large whole viewport. It preserves
the original physical DPR, binary64 camera, sampling/effect policy and native
dependency-aware halo. It adds no serialized authorization field and changes
neither the working-budget policy nor the global surface/coordinate guards.

The motivation is a recorded failed whole request, not a claimed speedup. In
the Deep5 117 trace, one early 1710×1776 whole request at physical zoom
35.628546359224416 underwent a prefix-budget retry and preview recovery before
starting regional compilation. Its 6155.2 ms queue-completion recovery wait ran
from about trace +1347.7 to +7502.9 ms. The request finally became stale and was
cancelled. This was an old sampled-camera request inside the motion interval,
not a measured input-to-sharp-frame latency or exclusive shader duration.

## Independent gates and size boundary

All three launch flags must be the exact string `1`:

- `VITE_DESIGN_NATIVE_PREVIEW_TILES`.
- `VITE_DESIGN_NATIVE_NAVIGATION`.
- `VITE_DESIGN_EXACT_CLAMP_PREFIX`.

The actual worker request must pass the pinned `usesDesktopDisplay` host policy,
use WebGPU, `renderIntent: preview`, `livePreview: true` and
`previewTileFallback: true`. Readback, PNG/export, pixel/software preview,
interaction ownership, explicit tile lists and capture-viewport requests do not
gain this route. Document or request scene fields cannot replace the launch
flags or pinned desktop policy.

The selected physical viewport must contain **more than 1,048,576 pixels**,
matching the existing ordinary temporary-preview pixel cap. At that exact cap
and below, the old whole-frame route remains. Dimensions must be positive safe
integers no larger than 8192, and total pixels must stay at or below the
existing regional assembler's **4,100,000-pixel** bound. Unsupported larger or
malformed domains retain their prior route; the candidate does not enlarge an
admission limit. These limits concern physical pixels, not UI zoom percentage.

## Existing execution and ownership

The worker reuses `renderTiledPreview` and `renderBitmapPreviewTiles`, beginning
with 256-pixel regions. Native compilation still computes each region's full
filter dependencies. Existing budget recovery may subdivide to its unchanged
minimum, and an unrenderable minimum region remains an error. No lower density,
altered radius, dropped neighbour or replacement pixel is introduced.

Regions assemble privately using the original integer screen offsets. Only a
complete bitmap is published; failed/cancelled partial assemblies are discarded
and leaf bitmaps are closed. The old displayed frame survives the existing
preview-recovery path. The surface's running/latest mailbox, camera cache
identity and presenter ownership are unchanged by this worker-entry policy.
Their separate running-lease/handoff candidate requires its own validation.

## CPU control-flow verification

```sh
node node_modules/vitest/vitest.mjs run src/kernel/native-preview-tiles-policy.test.ts src/kernel/render-worker-image-hydration.test.ts src/kernel/preview-tiles.test.ts
```

From `frontend/design-client`, **77 tests passed** across these three suites.
The pure policy controls cover strict flags, all request/host exclusions and
both size boundaries. New real-worker/portable-WASM controls spy on the actual
`VectorEngine.compile_gpu_packet`: the admitted large case performs only
regional compiles no larger than 256 pixels per axis, with no preceding whole
compile; small, flag-off and fallback-off controls perform one original whole
compile. The cancellation control starts one regional compile, closes its late
leaf once, and neither publishes a partial bitmap nor compiles the next region.
GPU raster/presentation remain controlled doubles in these CPU tests.

The initial run had four failed fixture assertions: the existing whole route
reports `whole-scene`, and an initially placed render gate let request
cancellation occur before a leaf was produced. The assertions were corrected
and the test gate moved after decode/upload preparation to exercise late-leaf
cleanup. No product algorithm was changed to satisfy those failed assertions.

Frozen source SHA-256 values:

| Source | SHA-256 |
| --- | --- |
| `render-worker.ts` | `a165ef3ecbc730e351246668285b34e5ef4889a1482e02d015ba4f6f3132d387` |
| `native-preview-tiles-policy.ts` | `a8f42e786d727be8a66648780ce90716ed112afbb951a660faa9c114808e5d32` |
| `native-preview-tiles-policy.test.ts` | `8bfb8d3997a3ef8aa94a0c7dab517f8b280b44fd5a147b7a10f8a2bb99cd7677` |
| `render-worker-image-hydration.test.ts` | `d9f8682e8b244eabe6911319693d1e734c4d49cf6c46d2824f3cb865f98eaa5d` |

Diff checks passed. No new GPU, build or latency result is credited to this
checkpoint. Low- and high-zoom actual-device controls must verify the same DPR,
camera, quality, atomic publication and bounds before any benefit or default-on
promotion is claimed. Larger work may still be slow or cancelled; fewer escaped
budget errors do not establish sharp navigation or cache reuse.
