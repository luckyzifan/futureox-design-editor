# Local canvas workflow increment — 2026-10-19

## Delivered behavior

- Sketch-like 1/10-unit keyboard dimension changes through the existing Inspector resize contract.
- Profile-aware eligible Select All; Figma page scope is retained local behavior, not a claim of complete Figma nested-selection parity.
- Figma remove-auto-layout and Windows front/back modifier correction.
- Center Selection preserves pending effective zoom, uses current-page visible scene bounds, and is bound to Sketch-like desktop Mod+3 only. Browser tab keys stay unclaimed; both hosts have menu access. Locked visible selections can be centered.
- A distinct Paste Over Selection command, not an alias of Paste in Place. Originals stay; Figma-like supports a single target; Sketch-like makes independent copies for each target. Native route/menu/preload wiring is independently owned and recorded in `../verification-native-paste-over/REPORT.md`.

The exact official comparison, references, interpretation of parent-local Inspector x/y, and remaining gaps are in `docs/LOCAL_CANVAS_WORKFLOW_COMPARISON.zh-CN.md`. Sketch's geometry anchor remains an explicit local adaptation. No real Figma/Sketch native geometry run, OS keyboard run, browser/Electron GUI run, or GPU result is claimed.

## Safety and graph contract

All target plans and graph/dependency/prototype/animation validation occur before a single Editor change. Whole-candidate detachment protects every pre-edit branch from downstream normalizer mutation. Existing history, source node identity, animation clips/tracks, undo/redo and JSON reopening are covered. Asynchronous clipboard reads cannot apply after document/session/revision/page/selection/interaction/focus changes; active user transactions are not adopted, committed or cancelled.

Preflight temporarily changes the shared WASM font environment, then restores the destination in `finally`. Bounds are measured under merged fonts. Publication also restores the current document environment on failure or success. Real non-empty glyph/font/metric tests cover rejected foreign-font packets and successful embedded-font paste/undo/redo.

Bounds: 64 selected targets, 32 MiB expanded clipboard payload, 20000 final nodes, existing structural depth/resource rules. Root-level standalone masks are rejected with grouping guidance to prevent changing unrelated sibling clipping. Grouped masks are supported; existing destination-parent clipping is inherited. This rejection is explicit rather than partial application. Figma multi-target, tap-X persistent mode, arbitrary shortcut remapping and other matrix gaps remain unsupported.

## Results

- First workflow checkpoint: 6 suites, 89/89, preserved in `../verification-canvas-workflows/`.
- Final combined affected client run: 11 suites, 169/169, zero failed/skipped, `affected-results.json` and `affected-tests.log`.
- Paste-specific tests: 28/28, `results.json` / `test.log`.
- Final test-assertion-order rerun: the workflow and paste suites, `final-focused-results.json`; this only strengthens the negative control so resize fails on actual geometry before handler-return assertions.
- TypeScript: `final-typecheck.log`, exit 0.
- Independent selection increment: 29 actual mounted React/jsdom Canvas + real WASM tests (overlapping the combined client run), `../verification-canvas-selection-workflows/REPORT.md`.
- Native boundary is a separate run: 66 focused tests, included in 157 desktop-contract tests; do not add the native counts together.
- Old-code negative control: the exact prior-delivery command/profile/dispatch files were inserted into an isolated source copy. Nine behavior witnesses fail: six platform/host cases stay width 30 instead of 31, scoped Select All chooses wrong IDs, and both paste-over profiles create no expected copies. Collection and setup succeed; none is a source-text check. See `old-code-negative-results.json` and `old-code-negative.log`.

Early test development corrected two fixture expectations: re-export creates a new clipboard carrier identity (source document immutability is now asserted), and component metadata requires variants/properties rather than a description field. Review caught and fixed font-environment restoration, external Immer branch mutation, hidden/empty center-selection and standalone mask scope before this final freeze.

## Reproduce

From `frontend/design-client`:

```sh
./node_modules/.bin/vitest run src/paste-over-selection.test.ts src/canvas-workflow-shortcuts.test.ts src/canvas-selection-workflows.test.tsx src/shortcut-profiles.test.ts src/shortcut-dom.test.tsx src/selection-hierarchy.test.ts src/selection-properties.test.ts src/smart-paste.test.ts src/clipboard-semantics.test.ts src/clipboard-internal-review.test.ts src/canvas-context-menu.test.ts
./node_modules/.bin/tsc --noEmit
```

From repository root, run `node testing/verification-paste-over-selection/verify-negative.mjs`. It creates a temporary isolated copy, applies only the three retained preimages, and requires the nine behavior failures. It never replaces current sources. Temporary evidence is retained and its path printed.

`source-freeze.sha256` records exact current client files. `before.sha256` records retained preimages sourced from reviewer2's verified prior-delivery snapshot (`a9fb36a1ae40b3b30aa68a0aa5a7f2d3440c600697ab1ddae43ef0380c12c051` archive identity). Checkout HEAD is `71d32153e6f55b3723c99708b4c4c49ac7342e67`; the increment is in the working tree. No Git commit, remote write or archive upload was performed here.
