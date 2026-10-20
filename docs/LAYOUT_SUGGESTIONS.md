# Deterministic suggested auto layout

## Behavior and primary references

- Figma's [Toggle on auto layout in designs](https://help.figma.com/hc/en-us/articles/5731482952599-Toggle-on-auto-layout-in-designs) describes suggestions as inferring responsive layout structure and cautions that inferred direction can differ from intent.
- Figma's [Guide to auto layout](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout-in-Figma) distinguishes horizontal, vertical and grid layout.
- MDN's [Grid auto-placement](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Grid_layout/Auto-placement) explains placement/order behavior. We do not apply dense backfilling or silently repack sparse geometry.

These sources informed the interaction and ambiguity policy; this implementation is deterministic local geometry analysis, not Figma's algorithm or a model-backed service.

## Shared Web/Electron and MCP surface

The shared `LayoutPanel` offers **建议自动布局…** for a single selected existing container. Preview shows candidate mode, confidence, measured gap/alignment, warnings, explicit apply, and cancel. Neither opening nor canceling changes the document, selection or undo history. The same `Editor` methods are consumed by both Web and Electron.

`layout.suggest { frameId }` is a read-only MCP operation registered in the shared automation registry. `layout.applySuggestion { frameId, fingerprint, suggestionId }` uses the normal required document/session/revision fence and native atomic edit boundary. The caller cannot supply trusted layout patches; apply recomputes the candidate and rejects stale fingerprints or unavailable IDs. In the UI, preview revision is also checked against the current editor revision. Arbitrary edits to the returned changes do not authorize those patches.

Applied layouts are ordinary native `layout` fields and child order. No new FD schema or special inference state is persisted. Existing binary FD encoding/decoding and native undo/redo apply unchanged.

## Inference and exceptions

- Measures row/column order, nonnegative uniform gaps, padding, and cross-axis start/center/end alignment.
- Detects complete, regular grids; offers grid and wrapped-row alternatives instead of pretending geometry uniquely determines future resize behavior.
- Recursively analyzes existing nested containers in one proposal and applies all selected frame changes atomically.
- Preserves hidden/absolute children's original order slots and properties. A locked flow child causes the containing frame conversion to be declined. Locked, hidden and component subtrees (including ancestors of the target) are not edited.
- Retains sizing/min/max, constraints, text/fonts, child dimensions and transforms. Unsupported responsive, rotated/sheared, spanning, overlapping, irregular or sparse arrangements are declined with reasons. Existing active auto layouts are left intact.
- Confidence is a deterministic geometry-fit indicator, not a calibrated probability of the user's semantic intent. The grid/wrap ambiguity is explicit even at exact geometric fit.

Scope is intentionally finite: it does not invent wrapper groups around arbitrary sibling selections or synthesize new semantic nesting. Select an existing frame/group first. Existing nested frame analysis is supported. Preview is a structured property/order plan, not a pixel render or a proof of displayed GPU equivalence.

## Cost and validation

A hard subtree limit of 1,000 nodes is enforced before expanding child work. Candidate sibling sorting is O(n log n); the ancestor safety map costs O(D) over document edges. Fingerprint input is capped at 8 MiB UTF-8; the output is a compact 64-character SHA-256 fingerprint and does not echo subtree text or embedded assets. There is no pairwise geometric scan or recursive search over grouping combinations.

The CPU test suite `src/layout-suggestions.test.ts` uses the real Editor/native WASM history and binary FD codec. It covers rows/columns, grid-vs-wrap alternatives, nested text/constraints, reverse order, hidden/absolute slots, locks, invalid geometry, stale/forged proposals, irregular/sparse rejection, MCP guarded apply, and bounded 100/1,000-node timings. No GPU, GUI or socket is required. Test results and exact timings are recorded separately in the evidence directory when a compatible WASM artifact is available.
