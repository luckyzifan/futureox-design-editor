# Sequential display: gradient and stroke coverage review

2026-10-21. Read-only source and saved-scene assessment; no product code was
changed and no CPU/GPU test, build or new interaction run was performed for
this review. The candidate remains default-off. This is a possible coverage
extension, not evidence of reduced latency or blur-free zoom.

## Relevance to the current 117 target

The saved `zoom-100-capture-scene.json` has one linear fill and 41 solid strokes
(8 inside, 33 center) on compiled nodes whose bounds intersect the output ROI.
It also has five effect-bearing nodes: two background blurs, two foreground
blurs and one shadow. Those effects still require fallback under the proposed
narrow scope; supporting gradients/strokes alone would not admit this whole
100% frame.

The saved `zoom-3200-capture-scene.json` has one image fill, three solid fills,
one foreground-blur node and no gradient or stroke in the output ROI. Extending
gradient/stroke admission therefore does not directly address the current
first-3200% latency. Work on the existing queue/coalescing path has priority.

## Smallest plausible implementation

`src/kernel/gpu/sequential-display-plan.ts` currently rejects all strokes
(`strokes`, code 9) and all gradient fills (`paint`, code 11). The relevant
renderer method is `drawSequentialNodes` in
`src/kernel/gpu/renderer.ts`; it currently draws fills, then children, then the
isolated node merge. Every original group boundary and normal-opacity operation
must remain in that order. Do not flatten groups.

For solid strokes, the existing `drawBundle` sequence can be retained within
each existing phase: render the original stroke `PathMesh` through
`sequentialMask(path, region)`; for inside/outside alignment, combine it with
the original fill coverage through the existing `combine`; then call
`paintOver` in stroke array order after children. Validate every consumed
nonempty fill/stroke path with the existing four-sample area-program predicate.
An inside/outside stroke consumes fill coverage even when there are no visible
fills. Preserve an empty fill as zero coverage. Require normal stroke paint
blend and the existing bounded finite solid-color/opacity rules. Image strokes
would need additional actual-upload proof and should remain rejected.

For managed gradient fills, `paint` already supplies `gradientGrid` to the
existing `linearGradient` operation, whose stop interpolation uses the same
rounded arithmetic as the original four-plane renderer. This path does not
use the byte-tier `figmaGradientLookup`/`figmaGradientField`; admitting that
separate byte pipeline is outside this proposal. Keep four original phases,
all authored colors, stop order, normal paint blend and node opacity.

## Coordinate and arithmetic requirements

- `imageGrids` indexes a paint object and sample, without a band key. The
  current sequential image path clones its paint and removes the temporary
  entry for each band/phase. Gradients need equivalent scope isolation, or an
  explicit region-aware key; otherwise later bands reuse the first field.
- The managed `linearGradient` shader addresses its field relative to the
  output origin. A cropped gradient field must physically cover precisely
  that band/node region, in global device coordinates. Retaining the original
  `previewSource.rect` with a cropped upload layout is invalid: the WASM output
  length would describe the original rectangle. Do not crop or rewrite the
  original coverage-program bounds.
- `gradient_sampling_grid` constructs `GradientCoordinates` using its supplied
  rectangle. `FixedGradient::new` enables the linear fixed-coordinate path only
  when the rectangle endpoints stay within +/-32768. Blindly replacing the
  original node rectangle with a band can switch fixed/general coordinate
  arithmetic and break raw parity. A small TypeScript-only first extension
  could conservatively admit linear gradients only when the original bounds
  and every cropped bound retain the same eligibility, with positive size,
  finite invertible transforms and validated stops/colors. Restricting original
  endpoints to that range is sufficient for the fixed-path eligibility part.
  A general solution should expose separate original/reference bounds and
  output bounds in the existing Rust parameter-field API, while preserving
  `GradientCoordinates` and its sample expressions exactly.
- The inverse coefficients in `Transform::inverse_composed` do not depend on
  bounds; its fallback uses bounds for precision admission. Keep the original
  source admission, rather than accepting a field solely because a small band
  passes a less demanding bound check.

## Allocation and acceptance limits

A maximum-size band has 524288 pixels: one RGBA32F gradient field costs 8 MiB.
Four distinct sample fields can occupy the existing 32 MiB material-field
cache, whose current-frame entries stay pinned; further fields use transient
coordinate storage and may require real completion fences. Removing an
`imageGrids` alias does not release that backing cache/storage. Strokes also add
coverage and, for alignment, a combined mask. Preserve the real common ledger,
depth guard and ordinary fallback; the existing `maxDepth + 4` preparation
estimate alone is not a proof that these additional allocations fit. Never
expand unrelated cache budgets to make an oracle pass.

Before any enabling decision, extend the existing independent raw-GPU oracle:
original four-plane rendering versus actual sequential `render(false, true)`
finish targets, compared as raw RGBA32F words. Cover three bands, negative ROI,
fractional/mirrored transforms, multiple translucent fills/strokes, children
under strokes, group opacity, inside/outside/center alignment and holes.
Gradient cases need all admitted kinds, zero/duplicate/adjacent and 32-stop
limits, signed/HDR colors, and the +/-32768 fixed-path boundary. Retain
cancellation/recovery and unsupported-effect/clip/backdrop rejection checks.
The existing proof readback remains instrumentation, not a product-path
readback or latency claim. Exports, edit/history routing and defaults remain
unchanged.
