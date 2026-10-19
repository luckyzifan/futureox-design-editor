# Variables integration independent review

Reviewed the current worktree at `<repo>`. No owner production files or immutable delivered baseline were edited by the reviewer. Independent tests live only in this directory.

## Final result

No unresolved blocking issue remained in the reviewed paths after the owner addressed the reproduced findings and added explicit protection for unsafe compound operations. This is a targeted CPU/DOM integrity review, not whole-repository or browser/GPU acceptance.

- **13/13 independent adversarial regressions passed**, including actual automation batch requests.
- **164/164 product-targeted tests passed**, with zero pending: VariablesPanel 16; variable-editing 33; variable-modes 36; variable-persistence 1; automation/design-system 45; components 17; component-override-fields 4; design-copy 12.
- Full frontend TypeScript `tsc --noEmit` passed after all fixes.
- Six relevant production file hashes match before/after the final test run. Exact files and hashes are in `final-sources-before.sha256`, `final-sources-after.sha256`, and `review-evidence.json`.

## Reproduced findings and final disposition

1. **Same-ID reopen retained the prior input session.** Fresh edits were refused after `editor.load()` of the same document ID. VariablesPanel now keys by document ID plus session generation. Clean reload permits new edits; invalid drafts still veto replacement and remain recoverable.
2. **Equivalent numeric spellings stayed permanently pending.** Editing 10 to `1e1` correctly produced an Editor no-op but was treated as input failure. Valid numeric drafts now canonicalize before comparison, clear pending state, add no history/revision, and allow Close.
3. **Binding silently skipped explicitly selected locked layers.** Binding now uses `updateProperties`, matching existing explicit property-panel/automation policy. Mixed locked/unlocked selection binds atomically.
4. **Cross-collection prototype metadata could break playback or permit deleting an effective mode.** The effective playback target and mode can differ from the raw metadata fields' collection. Shared UI/automation helpers now protect both, preserving raw metadata while pinning the appropriate effective mode. Playback, delete-block, and undo/redo checks pass.
5. **Mode rename authored unintended generated-child overrides, freezing later template inheritance.** An authored-only remap attempt could not pass stale materialized-mode validation. The final fix remaps references and narrowly suppresses override capture only for a proved mode-key migration with no preexisting/new authored override. Both direct helper and actual API routes preserve exact inherited/explicit override maps. After rename, changing the source mode changes inherited width from 80 to 10 while an explicit override remains 80. Undo/redo, binary reopen followed by another source edit, and intentional generated-child edits also pass.
6. **Compound rename batches could silently freeze inheritance.** Actual `batch.apply` regressions now prove that two-collection and two-mode bijective renames preserve future inheritance. A rename combined with a variable-value change, or an existing-name swap through a temporary name, **explicitly rejects atomically when safe inherited-mode migration cannot be proved**. Document identity, revision, and undo history remain unchanged. The error asks callers to separate operations. Product tests also verify that separate rename then value edits succeed without freezing inheritance.

## Other reviewed coverage

Explicit edited-column alias materialization; cross-collection context; default/active mode separation; node and instance-override references; alias, condition, action, and transition references; safe collection/mode/variable deletion; stale live deletion checks; invalid/IME drafts across Close, tabs, filter, pagination, and document boundaries; empty collections and imported empty-name copy source modes; typed literals and precision; disk binary reopen; product localSave/localOpen/SaveCoordinator using a documented IndexedDB boundary double; bounded rows/columns, search, and camera updates without variable reindexing.

## Verification boundaries

- Actual Editor/WASM admission, layout, history, prototype playback, and binary encoding run in these tests.
- jsdom does not prove real browser layout, pixel output, focus rendering, or accessibility-tree behavior.
- IndexedDB is doubled in the product persistence test; real browser crash durability is unverified.
- Browser, socket, and GPU routes were not attempted because prior restrictions were explicit. No alternate route bypassed them.
- The safe compound-operation rejection is a real product limitation, not full support for every batch composition.
- This is not an aggregate whole-repository run; the parent owns broader integration acceptance.

## Reproduce

From `frontend/design-client`:

```
node node_modules/vitest/vitest.mjs run --config <batch>/variable-review/vitest.config.mjs
node node_modules/vitest/vitest.mjs run src/VariablesPanel.test.tsx src/variable-editing.test.ts src/variable-persistence.test.ts src/variable-modes.test.ts src/automation/design-system.test.ts src/components.test.ts src/component-override-fields.test.ts src/design-copy.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

Final evidence: `independent-final-stable-results.json`, `product-final-stable-results.json`, `typecheck-final-stable.log`, and `review-evidence.json`. Earlier failure→pass reports remain preserved, including the same-ID/numeric/prototype failures, stale generated-mode rejection, and compound batch inherited-override failure.
