# Shared duplication command, local v1

Implementation candidate. Read the accompanying verification record for executed gates; source preparation alone is not a pass.

## Official basis and local choices

[Figma's copy/paste documentation](https://help.figma.com/hc/en-us/articles/4409078832791-Copy-and-paste-objects#duplicate) describes ordinary duplication over the source, top-level frame duplication to its right, and repeating a drag distance or rotation. It does not specify a 24-unit gap, full affine repetition, multi-selection correspondence, or hidden/layout edge cases. Core's exact rules below are local, explicit conventions, not Figma certification.

## One command, not UI-through-MCP

UI `Editor.duplicate` and the existing `node.duplicate` registry operation use `commands/duplication-command.ts`, then the existing `duplicateGraph` primitive. Both commit through the same Editor/native history boundary. UI is not rendered or driven through MCP.

1. No offset properties: ordinary roots duplicate in place. If every root is a top-level frame on one page, translate the selection's world authored-box union width plus 24 to the right. Mixed selections use ordinary placement. Native auto-layout remains authoritative for flow children.
2. A current trusted repeat seed takes priority over default placement. Only the last successful duplicate plus a provable translation/rotation-only authored root edit chain is eligible. Unchanged matrices keep exact authored transforms. Scale, reflection, skew, property/topology/behavior edits, Undo/Redo, page navigation, and load/new-document invalidate the seed. A same-ID reopen is a new session.
3. Any explicit `offsetX` or `offsetY` chooses the existing world-offset intent. The unspecified axis remains 24. Explicit zero is not omission. This intent does not consume implicit repeat; its actual successful copy may seed a subsequent default command.
4. Optional `parentId`/`index` keep their existing explicit reparent contract and native admission. Only newly reparented copy roots clear old constraint reference dimensions, preserving their world geometry across native layout; original nodes and general `node.move` are unchanged. Explicit relocation is distinct from the default same-page placement. Publication switches/selects the resulting owner page only through existing guarded context publication. The actual receipt remains associated with the committed document/session/revision, not the later active page.
5. Every accepted copy selects the new roots. `ids` and `idMap` remain the operation result. Existing reference remapping, native linked-instance duplication, animation wrapper behavior, prototype/connector references and local resource references are preserved. Generated animation wrappers can be roots without being a source-node `idMap` entry.

Intentional changes from the unreleased implementation: MCP's no-offset `(24,24)` default is replaced by the shared intent; MCP now selects copies and shares Editor-owned repeat state. Explicit axis values and their missing-axis default are unchanged. No compatibility endpoint or version-routing framework is added.

## Ownership and publication

The UI settles pending/property input before capturing an immutable source, selection, session and revision. It rechecks that owner inside `Editor.change`, publishes selection in the actual commit, and seeds repeat only from the Editor's private actual-result receipt. Pointer `commit()` now returns that same successful receipt handle; no-op/rejection still returns undefined. Canvas cannot seed a newer owner merely because old IDs exist there.

Automation copies the same Editor repeat facts into a synchronous stage context. There is no independent automation repeat memory and no accepted JSON repeat token. Staged changes do not publish repeat facts until an actual commit and successful owner-fenced context publication. Copied/JSON/foreign result objects do not resolve through the private receipt map. Superseded commits retain the existing explicit committed/do-not-retry reporting and never apply old selection or repeat facts to a new owner. Exact retry replays a prior result without executing or reseeding.

## Admission and honest limitations

- Shared explicit selections are validated atomically: missing nodes, mixed pages, locked roots/ancestors and instance-internal topology reject rather than silently copying an editable subset. Complete instances and native main-component duplication remain supported. Locked descendants copied inside a valid whole subtree retain their authored lock.
- Authored locks are a Core structural-edit policy, not authentication. MCP method/document/session grants remain separate. Canvas hit testing and [Figma's ability to select/edit locked layers in its Layers panel](https://help.figma.com/hc/en-us/articles/360041596573-Lock-and-unlock-layers) are not equated with security permissions.
- A multi-operation batch cannot consume implicit repeat. Later batch operations whose selected graph/ancestors depend on layout, constraints, components, text or other derived state reject with an explicit unsupported error and no partial mutation. Separate normalized commits remain available; the command does not repeatedly lay out the whole document.
- Native auto-layout can determine final flow placement despite a world-offset intent. This increment does not claim drag snapping, general affine-repeat inference, clipboard paste variants, external Figma control, collaboration transport, or authentication.

## Required gates

Retain baseline negative controls for ordinary/frame default placement, selected-copy publication and same-ID repeat isolation. Verify exact UI/MCP authored geometry/topology, one undo/redo, reflected parents and unchanged repeated matrices; translation/rotation shared across UI/MCP; explicit full/partial/zero offsets; pending input; locked/missing/instance errors; derived and implicit-repeat atomic refusal; pointer actual/copied/JSON/foreign receipts; cross-page publication; superseded commit and exact retry. Exercise the actual NDJSON server and matching WASM, plus existing native duplication/component/animation and receipt tests. Browser/Electron gestures remain a separate on-device gate.
