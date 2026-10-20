# Same-document page residency repair

## Proven source cause

`Editor.switchPage` only changes navigation. `Editor.set` already remembers the outgoing page's camera (including pending wheel input) and restores each page's view. No repeated document network load was identified in this path.

`ProgressiveSurface` includes page ID in its raster identity. Its previous identity-change layout effect unconditionally destroyed all display tiles, readiness and displayed state. Thus every A → B → A revisit discarded compositor-resident page pixels. The worker already has a bounded exact cache with page-scoped keys; introducing another document-fetch cache or another renderer per page would not address this display lifetime problem.

## Implementation

- Retain ready inactive-page display tiles in the existing mounted compositor, with inactive flags preventing their painting.
- Maximum three inactive pages and 32 MiB. Inactive bytes are also charged against the existing active display budget; active requests/resize and device-budget recovery retire inactive pages first. No additional worker or GPU device is created.
- On activation reuse the same tile serial/upload; rebase only active raster bookkeeping. No mutation to authored documents, save data or undo history.
- Cache witness is exact immutable document reference plus document ID, session/presentation epoch, backend, grid/checkerboard/pixel preview, raster profile, display capability and HDR policy. Any edit, undo/redo snapshot replacement, font/image/resource replacement, document reopen, backend/option change invalidates inactive pixels conservatively.
- Existing per-page camera cache remains authoritative and unchanged.
- Eviction/unmount/device loss releases cache ownership; compositor ownership performs normal texture retirement. Diagnostics expose inactive page bytes/count/hits.

## Verification limits

Tests exercise production surface hooks with controlled worker lifecycle and existing compositor ownership contracts. They do not constitute actual WebGPU screenshots, real-device frame-time measurements or a visual smoothness guarantee. A complete cache miss, a page exceeding the inactive allowance, or an authored revision change still renders normally.

Files: ProgressiveSurface.tsx; page-residency-cache.ts; page-residency-cache.test.ts; appended progressive-damage.test.tsx regressions. The navigation preview handoff change is documented separately and covered by combined regression tests.
