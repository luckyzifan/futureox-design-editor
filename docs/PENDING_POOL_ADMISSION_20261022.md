# Pending-pool allocation admission, independent follow-on

This change is separate from image-table retirement. The 15:41Z log is a different 39.2-second run with linear/colorManaged/coherent disabled, no image-table-scratch finish fence, and three surface-budget failures. It is not an extension of the earlier 15:28Z recording.

## Evidence and failure boundary

- req209: `pathCoverage`, 1666×753, 5,017,992 bytes. Working bytes were 1,071,617,564 against the unchanged 1,073,741,824-byte budget. The free pool held 33 textures/840,527,372 bytes, also marked used by the current command stream.
- req211: `passOutput`, mode2 paint/material-plus-coverage, 2253×1452, 52,341,696 bytes.
- req212: `passOutput`, mode22 rational tent, 2125×1368, 46,512,000 bytes.
- The existing post-error admission fences completed, but the original allocation error still propagated. A free/used intersection is ordered reusable storage, not permission to destroy an encoded or submitted reference before completion.

## Changed boundary

Async rendering call sites can request admission on an actual mask-cache miss, a prepared paint output, or a known filter allocation. The check uses the allocation's real pool key, format and dimensions. Binary/scalar coverage stays four bytes per pixel; managed color remains sixteen. Already matching pool slots do not require fresh allocation and are preserved during a pressure checkpoint. Cache hits, fitting allocations and pool hits do not gain a GPU wait or an unconditional JavaScript await.

If the fresh storage exceeds the existing budget, `admitSurface` pins the specific incoming source/field/kernel and reusable output slots, holds extra live surface references where applicable, then calls the real `reclaimScratch(required)` checkpoint. The original operation executes once after completion/current-request validation. Paint captures its actual prepared inputs, rather than recomputing an uncached coordinate field after the wait. Its allocation gate remains authoritative. No budget increase, request replay, changed coefficients, resolution reduction, or device-limit relaxation is introduced.

Pins cover free-pool disposal, ordinary-image and whole-atlas eviction, coordinate and retired-upload disposal, and retired-image ownership predicates. Extra live references prevent an optional static/display/constant owner retiring an incoming plane into the output pool before the continuation encodes its read. Existing material/coverage current-frame cache and kernel-epoch protections remain in effect. On rejection/cancellation the continuation does not encode; its pins/references unwind exactly once. A genuinely excessive live allocation can still fail.

## Diagnostics and limits

This path uses the existing bounded admission diagnostic with exact `admissionRequiredBytes`, working/budget bytes, pool counts/bytes, and retired-kind bits. The first-patch submission/fence trace supplies the request/owner and submitted range. The failure snapshot now includes admission pins in its existing pinned count. No document data, image URI, arbitrary stack, or per-pixel event is added.

The same-size compact-expansion fallback conservatively reserves three color planes; mixed compact/scalar cases may wait more conservatively than the direct mask/paint/tent cases. Existing synchronous replay/strip helpers and lazy image/coordinate/kernel upload gates are not all converted to async admission. This is not a claim that every possible allocation failure is eliminated. It does not reduce the arithmetic cost of previously submitted GPU work. Browser/device execution, actual display latency, image fidelity and representative large-scene performance remain acceptance requirements.

## Verification

`testing/verification-pool-admission-20261022/baseline-red.log` reproduces all three identified allocation failures using production renderer methods and controlled delayed GPU completion; `candidate-first.log` passes the same three calls. `ownership-final.log` passes 17 dedicated cases, including production `drawNode`, atlas eviction, static-cache ownership release, material fields, cancellation/rejection, real-format pool hits, and identical filter uniforms/kernel upload data. `targeted-final.log` passes 214 tests in 12 suites. These are resource-lifecycle and command-input tests, not real GPU timings or pixel comparisons.

The expanded existing paint-merge suite exposed five fixture failures on both the frozen pre-change renderer and the candidate (`baseline-existing-suite.log`). The fixture supplies its own compact coordinate grid but omitted the large-field preparation seam. It now explicitly supplies that seam; its allocation/merge assertions were not removed. The corrected suite passes. Full TypeScript and desktop packaging checks are coordinated separately; do not infer them from Vitest.
