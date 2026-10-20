# Shared selection commands: local v1 convergence plan

Status: the integrated stage-one implementation shares pure planning mechanics, but deliberately retains existing UI/MCP behavior differences. The following convergence is approved for an independent candidate; it is NOT established by stage-one tests or currently advertised as completed. No new endpoints, compatibility selectors, backend, authentication or collaboration merge are introduced. The abandoned versioned-endpoint draft is superseded by this document.

## Existing implementation boundary

UI commands and automation draft handlers share affine, arrangement and child-list mechanics. UI still commits as user; automation retains schema/permission checks, isolated staging, document/session/revision fences and one authoritative Editor/Rust commit. Private committed-edit receipts preserve exact accepted owner/snapshot/history facts across synchronous supersession. Receipts grant no mutation or replay authority.

Stage one retains four observed differences: curve geometry versus nominal-box alignment; curve group dimensions/origin; section ungroup support; selection-frame fill/clipping/blend defaults. These are expected-difference regression cases, not passing behavioral-parity tests. Source extraction alone does not resolve them.

## Approved next implementation, not a completed capability

Use the existing node.align, node.distribute, node.group and node.ungroup methods and corresponding UI routes with one shared Core selection command. Do not invent Figma aliases, new versioned endpoints or historical compatibility routing for an unreleased local v1 application.

- Share admission and exact geometry measurement. Preserve explicit missing/locked/instance/auto-layout restrictions; reject mixed invalid targets atomically instead of silently editing a subset. Keep all protocol scopes, batch wrapper/leaf authorization, budgets, fences, source provenance and receipt handling.
- Single selection aligns in parent-local coordinates; multiple same-page selections use world geometry. Curves use native geometry bounds, not authored rectangles. Hidden-node treatment, stroke/effect exclusion and ambiguous distribution behavior are explicit Core conventions, not certified Figma algorithms.
- Selection wrapping uses shared parent-local geometry, preserves child world transforms and selected sibling order, and uses transparent, unclipped, pass-through defaults for both group and selection-frame. Empty node.create frame remains a different intent with its existing factory defaults.
- Unwrap ordinary group/frame/section/boolean containers one level, retaining child transforms and authored styles. Components/instances remain protected. Direct mask scope is released without disturbing nested mask scopes. Container effects/clipping removal is not promised to preserve pixels.
- Auto-layout topology, ambiguous overlapping/contained distribution, or geometry whose freshness cannot be established after earlier batch edits may initially reject explicitly on both routes. Document these as pending; never report unsupported behavior as successful editing.
- Geometry preparation must not unconditionally perform whole-document layout for every simple command or reuse mutable candidate nodes as immutable geometry-cache keys. Derived geometry requires verified resolution or explicit refusal, with separate correctness/performance evidence.

Acceptance requires the original four differential fixtures to produce truly equal geometry/topology/defaults, plus matching undo/redo, complete rollback on invalid input, permissions/fences, mask/instance/layout rules, batch geometry freshness and receipt supersession. Runtime source identity and matching WASM must be verified. GUI/GPU/socket/external-client acceptance remains separate.

## Official comparison boundary

Figma documents parent/sibling alignment and equal edge spacing with fixed outer objects, but does not publish the complete curve/stroke/rotated/overlapping selection algorithm. Its grouping API preserves absolute positions and disallows reparenting instance children. Ungroup moves children out and removes the container; components and instances cannot be directly ungrouped. Its boolean tutorial explicitly permits ungrouping boolean groups back into the original objects. Empty frame factory defaults are not evidence for selection-frame defaults.

- https://help.figma.com/hc/en-us/articles/360039956914-Adjust-alignment-rotation-position-and-dimensions
- https://developers.figma.com/docs/plugins/api/properties/figma-group/
- https://developers.figma.com/docs/plugins/api/properties/figma-ungroup/
- https://help.figma.com/hc/en-us/articles/31130266267287-FD4B-Combine-shapes-using-boolean-operations
- https://developers.figma.com/docs/plugins/api/properties/figma-createframe/

Checked 2026-10-20. Shared commands provide an extension seam for future verified actor/base-revision/operation identity handling, not a working CRDT, durable collaboration log, authenticated author or selective collaborative undo implementation. Local profile/admin labels do not grant authority.
