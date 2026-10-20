# Published-snapshot parent-map reuse

This change addresses repeated full-document topology scans found while reviewing the FIG CPU profile. It does not establish a measured FIG import speedup or real GPU/gesture acceptance.

- `allParents(document)` remains uncached, so multiple in-place mutations of the same edit draft see fresh topology.
- `Editor.parentMap(document)` reuses the existing picking context for published snapshots. The context checks node/page map identities and the current editor version; a retained document root with a new version cannot reuse stale parents or picking matrices. Read-only return types prevent ordinary callers from mutating the shared map.
- Canvas input/feedback, menu/lock queries, alignment availability, Inspector/LayoutPanel and Layers queries reuse the map. Explicit older panel/display snapshots use their own document context.
- Layers' ArrowLeft handler previously called `allParents` inside `rows.find`, rescanning the entire document once for every tested row. It now resolves the parent once before searching rows.
- Existing call-scoped maps are passed through marquee and hierarchy helpers rather than being rebuilt by nested helpers.

## Verification

Commands run from `frontend/design-client`:

```sh
npm run typecheck
npm test -- --maxWorkers=1 src/parent-map-reuse.test.tsx src/selection-hierarchy.test.ts src/layer-drop.test.ts src/property-units-context.test.ts src/canvas-context-menu.test.ts src/interaction-repair.test.ts
npm test -- --maxWorkers=1 src/canvas-selection-cpu.test.tsx src/workspace-ui.test.tsx src/canvas-drop.test.ts src/property-units.test.tsx
```

Typecheck passed. The first batch passed 44 tests in six files; the second passed 25 tests in four different files: 69 tests total, no skips or failures. Node emitted its existing experimental localStorage availability warning.

The new `parent-map-reuse.test.tsx` covers:

1. Twenty repetitions of toolbar/menu/drop/feedback/unit queries plus camera changes perform one topology scan, preserve the published document and add no undo entry.
2. Real Editor reparent, undo and redo return correct parents and preserve world transforms; an older published snapshot remains isolated.
3. Retaining the document root while replacing nodes/pages, or publishing a new editor version after in-place hierarchy changes, invalidates the context.
4. Direct draft queries remain fresh after successive in-place reparenting.
5. The production Layers ArrowLeft handler over 2,000 root rows performs one topology scan, even when there is no parent row to find.

The Layers and Canvas handler tests control React hooks/host boundaries. They do not measure browser layout, physical interaction latency, GPU rendering or Figma equivalence. No GUI test or release build was run by this subtask. `scene()`/`kernelBounds` results were deliberately not globally cached, since geometry readiness and native font/bounds state require their own validity contract.
