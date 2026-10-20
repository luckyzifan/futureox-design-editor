# Region Shape Builder

## Contract and implemented scope

The new shared Web/Electron `ShapeBuilderDialog` is reached from the tools menu. It displays the kernel's connected regions as cubic SVG paths. Hover highlights a region; clicking or dragging accumulates regions; Alt/Option chooses erase; keyboard Enter/Space toggles a focused region. Apply replaces the selected source shapes in one editor transaction. Cancel changes nothing. The dialog is a preview editor, not yet a direct main-canvas tool.

The same pure-draft operation is registered as typed MCP methods `vector.shapeBuilder.preview` and `vector.shapeBuilder.apply`, and therefore participates in `batch.apply`'s atomic commit/rollback. Preview returns a content fingerprint and connected region IDs. Apply requires both. IDs are valid only for exactly that input geometry; unrelated document mutations do not make an incorrect region apply silently.

Sources are 1–16 same-parent, visible, unlocked, closed leaf shapes. Inputs with visible strokes, masks, inherited locks, clipping ancestors, instances, brush sources, path offsets, effects, or non-solid paints fail explicitly. Outline or bake those sources first. A region is not merely a source membership bitmask: disconnected components with identical membership receive distinct IDs. Hole contours stay with their containing region. Merge unions the chosen regions, retaining unselected regions; erase drops only chosen regions. Selecting one region with Merge also extracts that region as a vector.

Results are ordinary persisted vector networks, with no new document schema fields. They receive fresh IDs. Parent sibling insertion is the earliest selected source position; unselected siblings retain relative order. Each remaining region uses its topmost source's solid paint; a merged region uses the topmost chosen source. Source bindings, live Boolean data, and source-specific metadata are intentionally baked rather than copied to unrelated replacement geometry.

## Geometry and precision

The kernel uses the existing `flo_curves` cubic graph pipeline, including its 0.001-world-unit collision/rounding accuracy. It discovers nonempty source winding memberships, extracts their cubic boundaries, then separates disconnected components using analytic cubic containment. It never converts the authored output to polygon contours. The existing ellipse/conic-to-cubic and smoothed-corner boundary conversions remain those of `curve_boolean::curves`; this feature does not claim exact conic or certified Boolean arithmetic.

Budgets: at most 8192 input segments, 256 connected regions and 10000 output segments. Non-finite/singular transforms, non-positive dimensions, invalid/open paths and extreme output coordinates fail without editing source data. Output IDs and geometry are deterministic for the same input order and data.

## Tests and honest limits

Native CPU tests cover overlap, independently selectable disconnected regions, retained holes, affine transformed cubic geometry, rejected locks/masks/degenerate inputs, stable output, and a 3200% boundary-error fixture against the existing cubic representation. Shared TS tests cover actual WASM regions, atomic undo/redo, FD encode/decode, MCP typed batch rollback, stale preview rejection and parent transforms. These tests require the rebuilt kernel; a stale checked-in WASM cannot validate the new dispatch.

No GPU, live GUI, socket, Electron launch or screenshot validation is claimed. Remaining follow-ons: direct canvas/vector-edit-mode gestures, marquee selection, stroke/open-edge region support, gap detection, baked gradient/image paint remapping, and scaling corpus coverage for near-tangent/self-intersecting paths. Drag selection sweeps the whole line segment between delivered pointer events, including coalesced events. Cubic/line intersections split each segment into intervals; analytic even-odd midpoint tests preserve holes and capture narrow regions even when no pointerenter event is delivered. This is picking only and never rewrites authored geometry. A 250,000 curve-check / 2,048 intersection-cut budget fails the current event explicitly rather than returning partial picks. Pointer capture keeps the gesture coherent across region boundaries.

## Primary references and adjacent vector gaps

- Figma: https://help.figma.com/hc/en-us/articles/31616004109847-Create-custom-shapes-with-the-shape-builder-tool — defines region hover, drag merge, single-region extraction, Alt/Option subtraction, and undo for destructive changes. These distinguish Shape Builder from a whole-object Boolean command.
- Adobe Illustrator: https://helpx.adobe.com/illustrator/using/creating-shapes-shape-builder-tool.html — describes region merge/erase, style choice and rectangular marquee behavior. Our explicit topmost-source style policy is simpler than Illustrator's mouse-down style inheritance; it is documented in UI.

Existing `geometry('divide')` still tessellates source fills at 0.01 world units and returns polygon contours. Its menu label is now explicitly the legacy polygon divide, and it is not used by Shape Builder. Existing stroke outline also uses flattening/expansion; a precision-preserving stroke-to-region boundary is a prerequisite for native stroked-path Shape Builder. Neither limitation is hidden by the new tool.

A single Merge uses the existing curve union's 64-operand cap; previews and erasures can address up to 256 regions. Requests beyond the merge cap fail before any mutation. Geometry execution is currently synchronous and budgeted; a worker-backed cancellable preview is a further responsiveness improvement.

## Verified execution (2026-10-20 UTC)

- Native CPU: 7 tests passed, including disconnected region and hole topology and the 3200% cubic-boundary fixture.
- Real regenerated WASM + React CPU DOM: initial 7 tests passed across `shape-builder.test.ts` and `ShapeBuilderDialog.test.tsx`.
- The test bootstrap checked `FUTUREOX_EXPECT_KERNEL_SHA256=2da305a6864c783685ea6ffcd7d3978ba2df58a206c39653dd20d56689347561`; both generated and public WASM files matched this hash.
- Full shared TypeScript typecheck exited 0.
- Raw logs are under `evidence/next-shape-builder/`. No GPU/GUI/socket testing was run or claimed.

Fast-drag follow-up verification: all 12 Shape Builder WASM/React/picking tests pass, including a single pointer move crossing two 0.2-world-unit regions and a hole-only drag that selects no surrounding fill. Combined with existing authoring, geometry lifecycle, outline compositing and automation core regressions: 7 files / 55 tests pass against the same hash-checked WASM. Final source includes screen-matrix conversion, pointer capture and coalesced pointer samples. Logs: `wasm-dom-sweep-tests.log`, `shape-and-regressions.log`, `typecheck-sweep.log`.
