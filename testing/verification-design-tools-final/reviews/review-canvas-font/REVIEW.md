# Independent Canvas/font review and narrow corrections

## Outcome

Two new functional gaps were independently reproduced and fixed after parent approval. The final scoped acceptance passes **99 Vitest tests in 8 suites**, with **1 known pre-existing opt-in reproducer skipped**, plus **16 Node ownership tests**. TypeScript passes without diagnostics. The complete captured source/runtime set did not change during that acceptance run. Do not sum these totals with earlier or independent runs because they overlap.

## Exact comparison boundary

- Delivered cumulative ZIP: `futureox-desgin-ai-workspace-cumulative-20261019.zip`
- ZIP SHA-256: `c11eb9c4f1ea87c2ae5cf4508e5fe054e0ed328779309083fc43b150c2bca686`
- Git base: `71d32153e6f55b3723c99708b4c4c49ac7342e67`
- The delivered ZIP is the comparison baseline. For paths absent from the cumulative payload, the unchanged Git-base file supplies the baseline; genuinely new files are labeled separately in `source-hashes-start.json`.
- Final scoped runtime SHA-256: `7763b301d43cbaa14d8bd2916594739a9e04b1fbf765bdb71f48dd7bf7b61c0a`
- `acceptance-inputs.json` and `acceptance-outputs.json` bind the final checks; they are identical. A later rebuilt runtime still needs the root task's final aggregate.

## Findings and corrections

### CF-1, P2: queued hover discards first direct-handle drag frame (introduced, fixed)

A hover move schedules an animation-frame callback whose captured owner is `null`. Vertex, Bézier and width handles stop pointerdown propagation, bypassing the host's queue cancellation. A drag move then replaces the queued sample but reuses the hover callback; that callback rejects the new owner and discards the first drag frame. A modifier-only transition can also replay that obsolete hover as drag input.

Three independent mounted DOM tests failed on the original candidate with zero preview calls instead of one. The exact delivered ZIP Canvas passed all three same tests, confirming this is introduced by extending batching to these handles. The fix cancels the queue at admitted `start()` and `startWidth()` boundaries. Shared `start()` also covers direct resize, rotation, pivot and parameter handlers. Rejected/foreign starts do not retire an existing owner's frame.

Locations: `Canvas.tsx:1055–1057`, `Canvas.tsx:1794–1798`. Regression coverage includes all three direct handles, stale-hover modifier-only input, foreign pointercancel, exact release, undo/redo and all existing cancellation/lifecycle cases.

### CF-2, P2: skipped source fonts consume the 32-resource cap (fixed)

Original-font discovery enumerated every node before lock/shared-style/inheritance policy was applied at mutation time. A document with 34 locked distinct source fonts and one editable source aborted on the 33rd byte read; the eligible target remained unmatched. This is a new cap/policy interaction; unfiltered discovery itself existed in the delivered baseline, which had no bounded-resource loop and did not have the new protected-target policy.

`unmatchedEditableSourceFonts()` now derives identities from the exact document `fontTargets()` policy, including field-level existing component overrides. Locked ancestors, linked shared styles, inherited-only instance fields, and already assigned fields are filtered before native reads. The existing unique-resource cap and atomic kernel admission remain unchanged. The reproduction now reads exactly one resource and updates the editable target.

Locations: `font-management.ts:62–75`, `SystemFontPicker.tsx:105`. Additional checks prove run-only component overrides do not pull inherited style identities, 35 aliases sharing one byte identity do not exhaust the cap, and adding a 33rd document resource is rejected without changing document/history. Explicit selected-locked editing remains allowed and tested.

### CF-3: stale ownership source contract (fixed without weakening the fence)

The Node contract still required the old direct `editor.change('导入文档字体')` call. Font batching uses `applySelectionFont`, so the old syntactic assertion failed despite the retained final ownership fence. The revised contract requires the final fence to follow the awaited digest, precede the exact helper invocation, and have no intervening await.

Three real DOM file-input tests cover delayed read cancellation on selection change and same-ID reopen, plus a precisely scheduled reopen between the digest helper's final check and the caller continuation. An isolated negative control removes only the final `request.assertCurrent()`; the behavioral test then fails because the stale import inserts a font into the reopened document. The production file was never modified for that negative control.

## Preserved semantics reviewed

- Pen construction/freehand remain on sample-preserving paths; coalesced point-count and path-dependent pen tests pass.
- Release uses actual coordinates and modifiers; vector, handle and width no-motion, fractional, return-to-start, undo/redo and canceled-frame checks pass.
- Pointercancel, lost capture, Escape, blur, page/document replacement and unmount retire queued work.
- Whole-document font editing preserves inherited component fields and edits authored masters/existing overrides. Locks protect authored mutations; normal master inheritance continues rather than creating lock-induced local typography overrides.
- Matching replacement preserves unrelated run attributes, precision, fallback order and shared definitions. Explicit detach and fallback replacement are opt-in. Invalid drafts, active IME, stale same-ID input and malformed bytes remain guarded.
- Native/catalog boundaries alone are doubled in UI checks. Fonts are genuine bundled subset bytes, and Editor/WASM/admission/history/binary persistence paths are real.

## Performance evidence after correction

The original benchmark candidate Canvas hash was `84d00200fe8988f129675ec77866d975ce595b7f2e745df634e4cf830e53bbd3`. The corrected Canvas hash is `f04c992f19561fc13973be193a6571a287a4139d6c92f5aa8eb25583e23045e3`. Historical frozen reports are unchanged and their A/B timing percentages remain claims only about the original candidate.

A cheap rerun of the same final traces against corrected source yielded 16 previews and 18 notifications at each of 120/240/1000 Hz. All three final document hashes exactly match the original `e3fd79d…e104d`, and nested reflected/skewed geometry matches `dff93a6…b83b`. The full hashes are in `acceptance-canvas-metrics.jsonl`. New elapsed timings were observed during other build activity and are not presented as a fresh speedup or frame-rate claim. The deterministic 60 Hz frame schedule is a test input.

## Evidence index

- `acceptance-tests.log`, `acceptance-tests.json`: final 99 passed, 1 known skip
- `acceptance-typecheck.log`: empty, exit 0
- `acceptance-ownership.log`: final 16 Node tests passed
- `independent-tests.log/json`: preserved four pre-fix failures and four passes
- `baseline-tests.log/json`: exact delivered Canvas passes all three hover regressions
- `independent-tests-fixed.log/json`: all eight independent regressions pass
- `import-ownership-tests.log`: preserved obsolete-contract failure
- `file-ownership-behavior.log/json`: three real file-input lifetime cases pass
- `ownership-negative-control.log/json`: deliberate final-fence omission fails by mutating the reopened document
- `source-hashes-start.json`, `acceptance-inputs.json`, `acceptance-outputs.json`: comparison and final input identities
- `pre-fix/`: reconstructed exact initial reviewed sources, verified against initial recorded hashes where available
- `review-fixes.patch`: only the narrow changes made by this review
- `review-summary.json`: machine-readable outcome and scope

## Remaining limitations

The known direct `Editor.addPage()`-during-live-transaction defect remains an explicit skipped opt-in reproducer. Public PageList/Layers topology controls are guarded; this report does not claim the raw direct API is fixed. No GPU, browser, Electron, native pointer delivery, visual-quality or socket-server stage was launched. This scoped acceptance does not replace final full-tree/source-package acceptance, especially after the root task's WASM rebuild.
