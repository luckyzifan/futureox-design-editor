# Editable vector brushes: bounded first slice

## Implemented contract

`Node.vectorBrush` embeds an editable source `Network`; `Node.network` is the editable guide. It is ordinary authored JSON, covered by existing document history, copies, native save/reopen and MCP `patchNode` whole-property replacement. Shared Inspector controls are used by both Web and Electron. Source selection takes a snapshot; changing the original source node does not silently change existing brushes. Embedded source JSON can be edited or replaced. Explicit bake replaces the guide with the derived outline and removes the brush, in one undoable edit.

- Scatter retains every source Bezier control point, applying only an affine transform to each copy. Seed is a uint32 LCG state (including zero); spacing is guide-local distance. Random rotation, size and normal displacement are sampled in a fixed order per placement. Orientation may follow the path or the page-local axes. Width refers to source control-box height, not its tight visible bounds.
- Stretch is an exact affine operation for straight forward-only polyline guides. Corners, cusps, closed and curved Stretch guides are rejected with a useful error. No approximate curved warp is silently substituted.
- Source is one closed, unbranched filled contour; nonzero fill rules are required for both source and guide. Multicolor/group sources, holes and arbitrary compound sources are unsupported. Copies share the target node's fills/strokes/effects. Overlapping stamps are one compound nonzero-filled shape, not individually alpha-composited layers.
- Scatter permits one open or closed guide, including cubic Beziers. Closed guides omit a duplicate endpoint. Their stamp count must agree at both ends of the certified length interval; otherwise the interval is refined within the work budget. An unresolved count is rejected explicitly (change spacing), never silently rounded or omitted. Sharp joins select the outgoing segment; the final open endpoint uses the incoming segment. At a zero-derivative endpoint, the first available higher-order chord determines the tangent. A true cusp has no unique tangent and this deterministic convention is not a smoothness guarantee.

## Precision and resource contract

Source curves are never flattened. Cubic guide arc length is bracketed by the chord lower bound and control-polygon upper bound, subdividing via de Casteljau. The sum of bracket widths across the guide is at most 0.00001 local units. Inverse length uses further bounded subdivision and exact source-cubic evaluation, with a conservative position-distance error budget of twice that tolerance, apart from floating-point roundoff. This is a local arclength/position contract, not a universal device-pixel or angular error guarantee under arbitrary transforms. At 3200% zoom, the positional budget corresponds to 0.00064 pixels for unit-scale authored transforms. The analytic tangent is evaluated at the chosen curve parameter; near cusps angular sensitivity is explicitly not bounded.

Input is limited to 4096 vertices/edges per network, 4096 stamps, 100000 output commands, and 1000000 arc-subdivision work units. Precision exhaustion and output overflow reject the operation rather than coarsen geometry or truncate copies. Nonfinite values, invalid seeds, degenerate guides, zero-extent sources and incompatible geometry are rejected.

The single derived `Node.paths()` result feeds CPU render, compiled geometry, bounds, geometric picking, SVG and vector-PDF export. Native GPU execution and real browser/Electron platform execution have not been demonstrated by the CPU/unit tests. Sketch export rejects unbaked brushes instead of exporting only the guide; preserve FD or explicitly bake first and review the existing Sketch compatibility warnings. HTML export emits a special-geometry warning. No claim of exact curved Stretch or Figma/Illustrator format interoperability is made.

## Primary semantic references

- Adobe's brush taxonomy: https://helpx.adobe.com/illustrator/desktop/paint-and-fill/apply-and-edit-strokes/about-brushes.html
- Adobe scatter controls: https://www.adobe.com/learn/illustrator/web/add-texture-scatter-brush
- SVG distance along a path: https://www.w3.org/TR/SVG/latest/paths.html

These establish the intended distinction between stretching source art and distributing copies. They do not establish this implementation's fidelity; that is covered by its explicit limitations and tests.
