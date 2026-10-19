# Optional startup module boundaries

## Result and scope

A bounded UI split removes **22,211 bytes of initial JavaScript** and **9,340 gzip bytes** relative to the metadata-only stage. The AI / MCP button remains available immediately; the dialog and UI ZIP compression code load only after opening it. Desktop bridge/registry registration remains synchronous and unchanged.

This is a production artifact/module-placement result, not measured browser startup, input latency, milliseconds or FPS. No browser, socket, GPU or kernel rebuild was run.

## Implemented changes

1. The original `ExportTarget`, `sliceExportTarget`, and `pdfVectorIssues` source moves byte-for-byte to `src/export-metadata.ts`. `export.tsx` imports/re-exports the same synchronous function objects. `ExportPanel`, `NodeExportPanel`, and `clipboard-export` use the light module. All remaining export function bodies, including the React SVG serializer, are unchanged byte-for-byte; existing dynamic export calls and ownership/session/abort guards are unchanged.
2. `AutomationPanelLauncher.tsx` holds only the always-visible AI / MCP button and its loading/error lifecycle. The heavy `AutomationDialog` and public code-export helpers remain in `AutomationPanel.tsx`; its `AutomationPanel` compatibility export is preserved. App's only change in this stage is the import path. The dialog's complete body, including workspace/settings scopes and history behavior, is unchanged.
3. Opening shows an immediate modal loading state with Close/Escape and trapped focus. Close/unmount/retry retire stale load ownership; late success/failure cannot reopen or replace the current UI. The real dialog auto-focuses on arrival. Close returns focus to the launcher; explicit retry keeps focus inside the loading modal. No loading/opening action enables MCP or changes scopes.

The frozen original full `export.tsx` is `export.before.tsx`, SHA-256 `0d3804590084e0b43e486a23ed1876455e1f1788ff8624f3cfbb75559a4f83de`. Original App and AutomationPanel snapshots are also retained. No earlier startup-import evidence or publication archive was modified.

## Actual final emitted sizes

Three isolated Vite 8.3.0 builds used identical other source inputs:

| Stage | Initial JS bytes | Initial gzip bytes |
|---|---:|---:|
| Before both changes | 1,542,234 | 477,516 |
| Metadata extraction only | 1,542,234 | 477,398 |
| Metadata + optional UI split | 1,520,023 | 468,058 |

Metadata extraction alone saves zero raw initial bytes. Its 118-byte gzip change is ordering/compression noise, not meaningful startup evidence. It is an enabling boundary for a later export split.

The UI-only split saves 22,211 raw / 9,340 gzip initial bytes. It moves `AutomationPanel.tsx` and the browser `fflate` module out of the initial static closure, adding the light launcher. The lazy AutomationPanel chunk is 23,250 bytes (10,304 gzip). The total main-entry graph including dynamic chunks grows by 1,044 raw / 963 gzip bytes due to the new wrapper and chunk boundaries. Worker assets are excluded from these main-entry graph totals and are unchanged.

`automation/bridge`, `automation/export`, `automation/app-export` and React server rendering still remain in the initial graph. This work does not claim SSR eviction or removal of the larger export/registry startup cost. The small UI split has an actual measured initial-byte benefit; preserving immediate MCP registration is the deliberate limit.

All byte/gzip totals above read the final emitted files after Vite finishes. Vite can change code after the generateBundle hook. Initial hook-stage graphs/summaries are preserved under `*.generatebundle*.json`, and the original build logs contain those hook-stage totals. The corrected canonical summaries are `build-summary.json` and `launcher-build-summary.json`; `emitted-size-accounting.log` records the reconciliation. gzip values use gzipSync on each actual emitted file and are not network transfer measurements.

## Verification executed

- **120/120 Vitest tests across 10 files pass**, recorded in `final-tests.json` and `final-tests.log`.
- The 25 metadata equivalence tests compile and execute the actual frozen full export module against the same live imports. They compare complete SVG strings, bounds, ordered issues, floats and errors exactly, with no canonicalization or tolerance. Cases cover 19 renderer fixtures, page/selection targets, curves, masks, effects, blends, nested content, outlined Unicode text, escaped titles, fractional slices, and rotated/reflected/skewed/singular slices. They verify synchronous public function identity, byte-identical extracted code, unchanged remaining serializer code, and mutation controls for dimensions, issues and full SVG text.
- Eight new actual React/jsdom tests control import latency and cover no load while closed; immediate loading feedback; pending Tab/Escape; close-before-success; late failure; close/reopen races; unmount; explicit retry; focus trapping/restoration; history navigation; scope reset; no automatic enable calls; and unchanged dialog/registration source. Eleven existing actual-dialog tests pass, including real FD/SVG/Sketch output, HTML isolation, native permission scopes and audit settings.
- Existing bridge tests verify immediate registration, permission/revision/session fencing, cancellation and preview ownership. Workspace/settings adapter tests and 32 App/editor lifecycle tests pass. The existing App lifecycle harness logs two caught missing-indexedDB preview-read messages; these are retained and do not fail the tests or establish real browser storage verification.
- **28/28 Node export-ownership tests pass**, including pending-input/IME commits and vetoes, duplicates, cancellation during loading/rendering, session/page/selection ABA, stale completion suppression, and owned URL adoption/revocation.
- **TypeScript --noEmit passes** after the final changes.
- Three isolated Vite production builds pass, under `/workspace/shared/design-optional-startup-20261019`. Metadata stage changes five product sources; UI stage changes three more. Unrelated concurrent importer/font/automation implementation changes are excluded from the measured pair. Shared dist/public resources and WASM/font files were not modified.

Initial test-only harness failures are retained: an invalid effect enum was corrected; Vitest wraps a rejected mock module's error text, so the error assertion now checks the real visible failure banner; loader mock typing was tightened. A retry-focus edge discovered during coverage was fixed by focusing the retained Close control before removing the Retry button. Final runs above include those fixes.

## Reproduce

From the repository root, with dependencies already installed:

```sh
./frontend/design-client/node_modules/.bin/vitest run --root frontend/design-client src/AutomationPanelLauncher.test.tsx src/AutomationPanel.test.tsx src/export-metadata.test.ts src/export-native.test.ts src/export-regions.test.ts src/layer-export.test.ts src/automation/bridge.test.ts src/automation/workspace-bridge.test.ts src/automation/settings-adapter.test.ts src/editor-lifecycle.test.tsx --maxWorkers=2
node --test frontend/design-client/src/export-ownership.test.mjs
./frontend/design-client/node_modules/.bin/tsc --noEmit --project frontend/design-client/tsconfig.json
python3 testing/verification-optional-startup/prepare-build-snapshot.py /tmp/design-optional-startup-new
node testing/verification-optional-startup/compare-builds.mjs /tmp/design-optional-startup-new
node testing/verification-optional-startup/compare-launcher.mjs /tmp/design-optional-startup-new
```

The preparer requires a new directory and refuses unrelated serializer changes. It reconstructs only the narrow metadata/UI boundaries from the current source. Later unrelated source changes can affect absolute sizes, but each stage still changes only its listed files. Comparators read final emitted bytes directly and write reports beside themselves; use a copied evidence directory for a new retained run rather than overwriting this evidence. Preparation was separately exercised successfully in `/workspace/shared/design-optional-startup-repro-check`.
