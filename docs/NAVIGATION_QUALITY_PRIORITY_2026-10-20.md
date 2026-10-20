# Mixed-quality navigation: source diagnosis and bounded scheduling repair

## Evidence and limits

The user's recording shows extremely coarse enlarged pixels outside a sharper center. A capture boundary cuts through text and steps a card edge. The later still sequence shows those regions become sharp in stages rather than remaining permanently stale. This is consistent with independently sampled density layers, not proof of duplicate alpha composition, wrong camera origin or a second shifted scene.

The composite placement equations preserve the stored capture's source camera: origin is `-sample.x * ratio`, density is `sample.zoom * ratio`, and placement uses current `requestedView`. The shared compositor subtracts opaque covered rectangles and derives UVs from the original uncut placement. This audit found no newly proven geometric/alpha defect. Existing mock no-overlap tests do not establish real-GPU pixel fidelity.

## Two reproducible scheduling defects

1. Filtered navigation accepts any-density viewport coverage as sufficient to suppress the sampled preview. A 1/32-density overview covering the view causes zero new preview jobs at 1x. Nearest magnification then displays 32x texels outside retained detailed regions, until navigation ends and native work eventually fills them. The regression fails on the frozen 0525 source.
2. Native repair's coverage priority also treats a low-density overview as equivalent to sharp coverage. If the center is already sharp from an older key and the edges have only overview pixels, the function returns the original center-first order. The renderer unnecessarily refines visually adequate pixels before the visibly poor edges. Two ordering regressions fail on frozen source; a production surface orchestration regression exercises the corrected ordering.

## Changes

- Suppress a filtered navigation capture only if retained residents cover the requested viewport at the sampling density that the existing bounded navigation sample would produce. The existing 1MP/2048px caps, sample cadence, quiet policy and raster arithmetic remain unchanged. Low-density residents remain visible during refresh.
- Order native work by true holes, then undersampled regions, then already adequately sampled regions. Preserve input order within each tier, all tiles, exact requested densities and existing preparation/filter guards. Filter residents spatially before coverage union to bound planner overhead. Regions outside the visible viewport stay in the last tier.

These are scheduling changes, not interpolation, cross-fades or blurred smoothing. The navigation change can admit more expensive filtered captures than the old any-density suppression; it is deliberately constrained to the already-existing sampled preview lane. The native priority change introduces no new raster jobs.

## Validation

Deterministic transport/planner tests verify coarse-overview refresh, adequate-density reuse, bounded preview cadence and ownership, true-hole priority, coarse-before-sharp priority, unchanged native tile inputs, settled native repair order, and existing fallback/geometry contracts. TypeScript passes. A CPU-only synthetic planner run with 256 requested tiles and 129 residents averaged about 1.19ms across 100 iterations on this executor; this is not GPU/frame-rate evidence or a universal latency bound.

No physical GPU, deployed scene or screenshot-pixel equivalence is claimed. The uploaded log is not the same timeline as the submitted recording; it separately shows significant queue/execution time and cannot prove final sharp coverage because that field was not logged. Queue diagnosis and runtime observability remain necessary; this patch alone does not promise smoothness.
