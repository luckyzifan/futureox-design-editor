# Non-destructive repeated transforms (schema 15)

A node may author a `repeat` object. The node and its subtree are the editable
source. No generated appearances are persisted in JSON or FD; changes, source
removal, undo and redo use the ordinary atomic Editor transaction. The shared
Web/Electron inspector exposes count, translation, rotation, scale and pivot.
MCP `node.create`/`node.update` use the same optional node field and guards.

```json
{"count":3,"translation":{"x":20,"y":0},"rotation":0,"scale":{"x":1,"y":1},"pivot":{"x":10,"y":10}}
```

- `count` includes the source and is an integer from 1 through 256.
- Translation and pivot are in the source's **parent coordinate system**.
- Rotation is radians in the persisted/API contract; the inspector displays degrees.
- Positive rotation is clockwise in the usual y-down canvas.
- Each scale is positive, from 0.01 through 100. Reflections are not accepted.
- The inspector initializes pivot to the source's transformed local origin.
- Appearance `i` has parent transform `step^i × source.transform`, where
  `step = T(translation) × T(pivot) × R(rotation) × S(scale) × T(-pivot)`.
  Thus the rightmost operation happens first. This follows the SVG affine matrix
  convention: https://www.w3.org/TR/SVG/coords.html .

The native Engine resolves a disposable scene after components and layout. CPU
rendering, GPU scene compilation and native vector PDF consume that same scene.
The source snapshot remains separate. Source edits conservatively invalidate the
whole derived scene, including paint/translation changes. Animation samples the
source before regenerating appearances. The TypeScript disposable scene uses the
same matrix order and deterministic collision-checked identifiers for SVG,
export framing and hit testing. Clicking an appearance selects the authored
source, not a saved duplicate. Export isolation includes all appearances of a
selected source. Tests include cross-language identifier and matrix fixtures.

## Bounds and failure behavior

Preflight counts nested appearances before allocating them. A document with a
repeat may expand to at most 16,384 nodes and a conservative 16 MiB serialized-node
budget (512 bytes overhead per appearance). Every accumulated local matrix must
be finite, invertible at the ordinary authored transform threshold, and bounded
by 1e9 per coefficient. These limits can reject high-count scale progressions
well before count 256. Rejected Editor edits do not commit or create undo entries.

The TypeScript reusable scene cache retains at most two expansions, so retained undo history does not multiply that cache without bound.

The scene expansion is atomic; an error does not partly replace the document.
Cycles, missing nodes, duplicate/colliding derived IDs and excessive nested counts
fail closed. Removing the repeat leaves the source. Removing the source removes
all its derived appearances.

Repeat-owning masks and slices, and repeats inside boolean operands, are currently
rejected. A repeated boolean root and a repeated group containing an ordinary
mask subtree are supported. Shape Builder rejects live repeats until explicit
conversion is implemented. There is currently no bake command; removing a repeat
is not presented as baking.

## Verification

`cargo test --manifest-path design-studio/crates/design-kernel/Cargo.toml repeat:: --lib --no-default-features`

`vitest run src/repeat-transforms.test.ts` (requires the newly built real WASM)

Native tests compare actual CPU raster bytes against an explicitly expanded
reference, test source-edit invalidation, FD roundtrip, pivot/nested composition,
and negative/nonfinite/precision/exponential admission failures. Frontend tests
exercise real Editor picking, source edits, undo/redo/cancel/removal, FD reopening
and guarded MCP mutation. The bounded expansion benchmark prints actual authored
and expanded node counts and elapsed CPU time; it makes no GPU FPS claim.

## Format scope and remaining work

Sketch export explicitly rejects a document containing a live repeat before
creating output. It cannot faithfully encode this authored feature, and emitting
just the source would silently lose appearances. The error points to native
FD/JSON for editable storage, or PNG/SVG/PDF for visual output. No bake command is
currently offered. A future explicit bake must freeze resolved geometry, preserve
component/layout relationships safely and commit as one undo transaction; this
implementation does not claim that work or full Sketch feature fidelity complete.

Repeat translation, pivot and scale objects reject unknown nested JSON keys in
both TypeScript and native admission. This strictness is scoped to repeats; the
shared Point model elsewhere is unchanged.

The existing approximate semantic HTML export emits a dedicated
`REPEAT_TRANSFORMS_NOT_EXPORTED` warning identifying the source node. Its HTML
contains only that source; it is not claimed as a repeat-faithful visual format.
