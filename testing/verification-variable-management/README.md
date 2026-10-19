# Variable management UI verification

Date: 2026-10-19. This increment changes the variables UI, authored-edit helpers, shared automation mode references and a strictly bounded component override-capture rule; no evaluator, rendering algorithm, Rust source or WASM binary was changed by this work.

## Delivered behavior

- Dedicated local variable manager with collection selection/rename, type/name search, slash-path groups, 40-row pages and three visible mode columns.
- Collection and mode management includes renaming, copying a mode, selecting the default and active modes, and safe deletion with an explicit review. The final mode, default/active modes and referenced resources cannot be silently deleted.
- Reference checks cover aliases in every mode, node bindings, component instance override bindings/modes, prototype conditions/actions/transition variable fields, and prototype collection metadata.
- Mode rename updates variables, document active/default choices, inherited node modes, instance overrides and correctly scoped prototype mode references together in one Editor transaction.
- Numeric/color/string fields use the existing pending-draft lifecycle. Enter or blur commits one validated edit. Invalid and IME drafts veto tab/collection/page changes, Close and document replacement. Escape cancels the input without dismissing its dialog.
- Real shared Editor undo/redo is used. Same-ID reopen remounts input ownership for the new editor session.
- An inactive alias column now materializes its own mode, rather than accidentally copying the document-active mode. Other collections retain their active/default resolution context.
- Searchable alias and binding lists bound visible choices. Selected values remain visible. Camera-only changes do not rebuild variable indexes.

## Final executed checks

- TypeScript: `node node_modules/typescript/bin/tsc --noEmit` — exit 0 (`typecheck.log`).
- Eleven Vitest suites: **198 passed, 0 failed** (`results.json`, `tests.log`). These include **56 new cases** in `variable-editing.test.ts`, `VariablesPanel.test.tsx` , `variable-persistence.test.ts` and the added automation design-system regressions.
- Existing import ownership contracts: **16 passed, 0 failed** (`import-ownership.log`).
- Independent integrity review exposed same-ID input ownership, equivalent numeric draft no-ops, locked-selection binding and mixed prototype target/mode issues; all were fixed and have real DOM/WASM/API regressions. A later inheritance regression proved that mode-key migrations must not create new generated-child overrides. Exact bijective migrations now preserve inheritance, including multi-rename API batches; ambiguous combinations reject atomically. The reviewer independently verifies 13 edge cases and retains failure-to-pass evidence separately.

Final Vitest command, from `frontend/design-client`:

```
node node_modules/vitest/vitest.mjs run \
  src/variable-editing.test.ts src/VariablesPanel.test.tsx src/variable-persistence.test.ts \
  src/variable-modes.test.ts src/automation/design-system.test.ts src/engine-history.test.ts \
  src/editor-lifecycle.test.tsx src/local-store.test.ts src/local-revisions.test.ts \
  src/components.test.ts src/component-override-fields.test.ts \
  --silent=false --reporter=verbose --reporter=json \
  --outputFile.json=../../testing/verification-variable-management/results.json
```

The actual WASM is initialized by the repository's normal `test-setup.ts`. New UI tests mount React with `react-dom/client` in jsdom and dispatch DOM input/change/keyboard/composition events. They do not mock Editor, evaluation, history, or binary encoding. Invalid edits are checked against exact document identity and undo state.

Persistence checks include:

1. Real kernel binary bytes written to a temporary disk file, read back, decoded, and reopened through a new Editor; entire document equality and exact fractional widths/colors are asserted.
2. Actual `localSave`, `localOpen` and `SaveCoordinator` paths, with only the IndexedDB storage boundary doubled, asserting binary format, revision increments, exact documents, re-evaluated values, and persistence of undo as a new revision.

The 1,000-variable / 7-mode UI scenario asserts at most 40 visible rows and 3 visible mode columns, successful paging/search/filtering, and **zero variable reindex calls across 120 camera updates**. Timing in `VARIABLE_UI_METRIC` is informational CPU/jsdom elapsed time, not a browser FPS or rendering benchmark.

## Intentional safe limitation for API batches

When a mode rename would change an inherited generated child, the capture rule proves the complete design system equals an exact bijective mode-name migration before suppressing override creation. One or several fresh-name renames can be one atomic batch. If that same batch also changes variable values/other design-system metadata, or swaps/reorders existing mode names, the unproven migration rejects atomically with “变量模式重命名与其他设计系统修改无法安全合并；请分开操作以保留实例继承”. Document identity, revision and undo remain unchanged. Perform the rename and other edit as separate calls; those paths are tested through the actual automation API. Existing explicit instance overrides remain explicit. Intentional generated-child mode edits still create ordinary overrides.

## Explicitly unverified

- No browser, listening socket, Electron launch, GPU execution, screenshot or pixel/visual acceptance was performed. Those routes were previously blocked and were not retried or bypassed.
- Browser IndexedDB durability is not proven by the storage double. The real binary disk round trips verify the persisted payload and admission separately.
- `scripts/check-design-system-ui.ts` was updated only to press Enter after deferred input edits. Its existing functional/pixel assertions remain in place, but that browser/Electron script is **UNRUN** for this increment.
- Existing `editor-lifecycle.test.tsx` logs two expected missing-IndexedDB startup-preview warnings in its isolated hook harness; the final suite succeeds. New DOM tests explicitly require an empty console-error list.
- Earlier `new-tests.*` evidence captures the 35-case intermediate run; `results.json` and `tests.log` are the final aggregate, including all 56 new cases.

Baseline: cumulative archive SHA-256 `e7fea613c2aafbcd277dc6648bd8b425d65f18683c6ad8089577aabad4858d51`, Git base `71d32153e6f55b3723c99708b4c4c49ac7342e67`. See `source-sha256.json` for this increment's exact reviewed files and WASM identity.
