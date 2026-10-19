# Font management and batch typography verification

## Product scope

- `FontManagementPanel` supplies document-font search and explicit apply versus matching-reference replacement. It is mounted in single-text font management and in mixed/multiple selections containing text. It can also be mounted with only an `editor` prop by the parent application.
- Native font metadata search matches family, style and PostScript-name tokens. Forty rows are rendered per page, with navigation beyond the previous first-100 cutoff. Search and navigation never request font bytes or create eager font previews.
- Apply unifies the selected text layers' font and clears only their run font overrides. Replacement changes only matching base/run references; fallback replacement is opt-in. Text, sizes, weights, colors, other run attributes and floating-point precision remain intact.
- Explicit property selections can edit locked text. Whole-document operations skip locked subtrees and shared text styles by default. Shared-style detachment is explicit and leaves the shared definition unchanged. Document replacement edits authored master fields and existing component overrides, never all inherited materialized copies.
- Original-source matching and font-file import use the same guarded policy. Source matching coalesces identical resource identities and retains at most the document schema's 32 unique font resources plus one transient face being identified. Over-limit work fails before document mutation.
- Valid pending input is committed before the operation. Invalid input, active IME and stale same-ID sessions block the operation without clearing recoverable input. Existing OpenType/fallback/axis drafts now participate in this boundary.
- Native read/import requests are cancelled by lifecycle/selection changes, including reopening the same document ID. Request subscriptions are released on completion.

## Actual verification

Final result: 56 tests passed across seven suites; TypeScript completed without diagnostics.

Final authoritative run: `final-results-v3.json`, `final-tests-v3.log`, `final-typecheck-v3.log`.

Command from `frontend/design-client`:

    ./node_modules/.bin/vitest run src/font-management.test.ts src/FontManagementPanel.test.tsx src/SystemFontPicker.test.ts src/TextStylePanel.test.tsx src/font-matching.test.ts src/multiselection-cpu-runtime.test.tsx src/components.test.ts --maxWorkers=1 --reporter=verbose --reporter=json --outputFile=../../testing/verification-font-batch/final-results-v3.json
    ./node_modules/.bin/tsc --noEmit

The focused tests use real React DOM events through jsdom, the actual Editor and current compiled WASM, genuine locally derived bundled font bytes, kernel font admission/shaping, kernel binary encoding/decoding, and actual temporary-file write/read reopening. No editor or shaping stand-in is used. Only the native IPC/catalog boundary is doubled in the UI tests; the catalog paging labels are synthetic test metadata, and selected/read resources contain actual font bytes.

Coverage includes exact document/byte undo and redo, one-entry edits, file reopen, imported byte identity, TTC returned-index safety, invalid font atomic rejection, explicit CJK fallback glyph IDs, existing component overrides, later-master propagation, linked styles, ancestor locks, invalid drafts, composition, same-ID reopen, and no font indexing during 120 camera changes.

The 1000-text deterministic checks assert:

- one Editor change for apply/replacement;
- 1000 target-pass node visits and 3000 run visits for replacement (document lock resolution is a separate single linear tree pass);
- 2000 matching references changed;
- 26 rendered DOM elements in the management panel, independent of selected-text count;
- exact undo to the prior document.

Wall-clock observations are in `final-metrics-v3.jsonl`. These are controlled CPU fixture measurements, not an A/B speedup claim or a frame-rate budget. They do not establish browser rendering, native dialog behavior, visual fidelity, or GPU performance.

## Regression found and fixed

`initial-helper-failure.log`, `font-tests-initial.log`, `component-investigation.log`, and `shared-helper-before-fix.log` preserve the initial failures. The actual failure was a nested Immer draft array leaking through a newly spread text-style object; component override capture then failed structuredClone. Font mutation helpers now update authored fields in place. The shared `applyWholeTextStyle` retains absent-default filling and all prior run semantics while avoiding that proxy leak.

The legacy fallback test was strengthened to start with a real existing fallback, then require invalid input to leave the entire document identical. The old behavior silently cleared the fallback list on invalid blur; that data-loss behavior is intentionally removed.

## Fixtures and limitations

`fixtures/provenance.json` records SHA-256 hashes and exact glyph subsets derived locally with fontTools from the already packaged Noto Sans SC font. `fixtures/OFL.txt` contains the packaged license. No font was fetched or installed.

The shaping policy is unchanged: explicit configured fallbacks and the built-in font handle uncovered glyphs. The tests prove the explicit CJK fallback path; this change does not claim universal glyph coverage or add eager per-font missing-glyph scans.

Whole-document replacement intentionally preserves shared text styles unless the user explicitly requests local overrides. It does not rewrite shared-style definitions or introduce a new font schema.

Existing nearby batch features were inventoried but not expanded: fills/strokes/effects already have multi-selection panels; rename is currently single-selection only; per-layer export supports multiple presets but has no multi-layer export queue in that panel.

All pre-existing verification directories and reports were left unchanged.
