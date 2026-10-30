# Content-free canvas action diagnostics

This cohort adds shared action lifecycle collection and Canvas route instrumentation. It does not assert complete editor feature coverage or GPU pixel correctness. Command, utility, text/property and frame measurement cohorts have separate owners and tests.

## Contract

`canvasActions(editor)` uses one weakly owned collector per editor, anonymous actionOwner, session, actionId and start/final authored revision. `begin` precedes work; `sample` updates memory only; `finish` records observed/committed/unchanged/cancelled/blocked/rejected/unsupported separately. A commit requires a higher authored revision in the same session. Posthoc `event` excludes committed at the type boundary. A successful return alone is not commit evidence. Exact snapshot software presentation acknowledgements remain the older operation pipeline's responsibility, not action finish. Final authored snapshots can attach existing operation correlation without retaining document data.

Only allowlisted booleans/enums/counts/durations/revisions are emitted. Raw content, names, node IDs, property values, transforms, dimensions, paths, clipboard, assets and error strings are not accepted by the action sanitizer. Geometry arrays exist only during a gesture in process, at most 16 targets, and export equality codes: 0 unobserved, 1 equal, 2 different, 3 unsupported. Different does not inherently mean incorrect: snapping and constraints intentionally change proposals.

The pending map and detail history ring are bounded at 128 (test-configurable 1..512). Overflow retires an old pending action as cancelled/superseded. actionPendingEvicted is cumulative bounded count; actionRingDropped is local diagnostic-history eviction, NOT terminal delivery loss. Both survive the shared terminal sanitizer. The existing terminal collector batches detail at 250 ms with 512-row capacity and its own dropped summary. Default mode emits at most eight immediate records plus latest/count aggregates per event kind per second. Exhaustive per-action history requires detail opt-in; default aggregates are not complete traces. Pointer motion never calls console or the terminal sink. Disabled tracing does not read the clock or allocate geometry snapshots.

## Canvas coverage and limitations

- Admission: busy/not ready/wrong owner, locked/nonselected handle, text-edit route; selection/hit counts/depth/modifiers and pointer grab.
- Main drag lifecycle: move, blue-box resize/scale/rotation, threshold, snap/constraint flags, actual version change, cancellation. Expected/proposed/resolved/committed comparisons for bounded transform/size snapshots only.
- Selection/marquee/pan/zoom/pivot are observed state routes, not document commits.
- Standard frame/shape creation and pencil release follow actual authored commit rather than preview cancellation. Creation geometry matching remains unsupported.
- Pen/vector/width/parameter routes have lifecycle visibility but no full geometry oracle. Crop's asynchronous application remains unsupported/unobserved, not reported as committed.
- Text opening/closing is observed only; text/property input semantics belong to the input cohort.
- Utilities with early returns and stopped-propagation handles belong to utility cohort, not this Canvas wrapper.
- Pointer hit correctness, every modifier/tool combination, imported117 end-to-end behavior, OS clipboard, real GPU pixel correctness and GPU-overlay update timing are not proven by these fixtures.

## Validation

Pure tests prove privacy, hostile runtime values, NaN clock handling, finite capacity, pending overflow, terminal double sanitation, 10,000-sample no-sink behavior, disabled no-clock behavior, stale-session completion and bounded geometry comparisons. Mounted real Canvas + Editor/WASM fixtures prove fresh selection/grab threshold cancellation, drag commit, locked target behavior, frame creation, snapped unchanged blue-box resize, rotation commit. A delayed renderer-boundary fixture verifies the ordinary SVG blue polygon follows authored width/height while old content remains presented; it does not exercise actual GPU presentation.

Existing event-batching, selection-workflow and mounted text suites are run as regression checks but are not owned output files of this cohort. The shared terminal schema is unioned with frame/grid and text/property fields; respective owners validate their semantics.
