# Canvas and editor operation coverage boundaries

This is a release coverage checklist, not a claim that all operations have passed end-to-end qualification. Shared action lifecycle telemetry now supplements authored mutation, preparation and software-submission records. Only bounded enums, booleans, counts, revisions and durations are emitted. No text, names, node/document IDs, clipboard content, filenames, color values or raw geometry are logged.

## Evidence levels

- Route instrumentation means an entrypoint or common control produces an observation. It does not prove the operation fulfilled the user's intent.
- Authored commit requires a same-session authored revision change. View/selection/clipboard/settings outcomes are not relabeled as document commits.
- Local comparison checks bounded in-process geometry/text and emits only a comparison code. Constraints can legitimately produce a different result.
- Fresh-fixture tests exercise actual Editor/WASM and mounted UI on small new documents. They do not establish imported-document or physical GPU behavior.
- This release has no complete imported117 operation matrix or live Electron/GPU qualification. No family below is certified universally correct.

## Required operation-family checklist

The following families remain individually relevant. The matrix deliberately does not mark an entire family complete just because a shared mutation method is instrumented.

1. Tool activation.
2. Pointer selection / grab.
3. Blue-box group interior/gap.
4. Deep selection.
5. Keyboard selection.
6. Marquee.
7. Move/duplicate/reparent.
8. Resize / scale / rotate.
9. Pivot.
10. Shape parameter and stroke width.
11. Pan (hand / Space / middle).
12. Wheel / keyboard / area zoom.
13. Scrollbars.
14. Frame / section / basic shapes / text / slice.
15. Pen.
16. Pencil / brush / marker / washi tape.
17. Freehand settings / sample stroke.
18. Eraser.
19. Board creation.
20. Vector lasso.
21. Measure.
22. Bend / offset path.
23. Cut path / paint bucket / text-path.
24. Comments / annotate.
25. Eyedropper.
26. Crop image.
27. Text edit enter / draft / style / commit / cancel.
28. Keyboard nudge / vector delete.
29. Standard commands.
30. Copy / cut.
31. Paste variants / assets / properties.
32. Context menu.
33. Layers select / reorder / rename / lock / hide.
34. Pages.
35. Layout handles.
36. Smart selection handles.
37. Ruler guides.
38. Properties panel.
39. New blank document.
40. Import open / append / image drop.
41. Export menu / panel / copy asset.
42. Save / SaveAs / SaveCopy / recover / open.
43. Settings / preference reset.

## Verified examples in this release

Mounted fresh-canvas fixtures cover selection/grab threshold cancellation, drag commit, explicitly locked targets, frame creation, unchanged snapped blue-box resize and rotation. A delayed renderer-boundary fixture checks the authored SVG selection outline while old content remains presented, not actual GPU overlay timing.

Utility fixtures cover eligible-line erasing and undo, filled/locked rejection, board creation/cancellation, measure observation, lasso, bend, guides, layout handles, scrollbars and smart-selection spacing. Text/property fixtures cover deferred W/H commit, invalid/range/Escape cases, ratio lock, mixed width updates, opacity separation, native color authoring/undo and rich-text IME commit/cancel. Image-import fixtures cover source-relative placement, model defaults, stale session/page guards and undo. Selection/layout CPU suites cover handles, hierarchy, scale, auto-layout and grid contracts.

## Explicit remaining gaps

- No-hit deep selection and empty keyboard navigation can return before shared selection tracing. Freehand settings and wheel/keyboard zoom do not have a complete action-lifecycle matrix. These are observability gaps, not inferred functional defects.

- Direct Layers/PageList/context-menu selection routes and direct Inspector select/checkbox/button controls must not inherit a dedicated intent/field correctness claim solely from generic Editor mutations.
- Crop async completion, creation geometry, pen/vector/width/parameter semantics, all modifier/lock/inherited-lock combinations and every utility subtype are not exhaustively verified.
- Standalone TextInput mounted semantics and per-field/mixed-expression expected-value proof remain incomplete. Native color changes are still immediate writes, without an app-owned preview/cancel rollback or guaranteed single-undo picker transaction. No full Figma alignment is claimed.
- Shared numeric controls instrument many property routes, but no complete field-by-field test matrix covers fills/effects/strokes, gradients, image settings, typography dropdowns, components, prototypes, exports and review contracts.
- OS clipboard, physical display FPS, new-content FPS, GPU completion, rasterized selection outlines and visual grid fidelity require independent runtime evidence. Non-resident fallback surfaces do not contribute to resident software-submit rate.
- Normal diagnostics aggregate records; detail mode is bounded and can evict history. Eviction counters identify loss. No unbounded complete interaction history is promised.

Every missing route and semantic oracle remains follow-up work; this package must not be described as “all operations verified.”
