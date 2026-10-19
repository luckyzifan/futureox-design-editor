# Lifecycle harness repair verification

This is a test-only repair for the deterministic component-handler harness. Browser production code is unchanged. The original test did not provide a document event target when it executed Canvas keyboard effects.

## Change

Only `frontend/design-client/src/editor-lifecycle.test.tsx` changed. The modal keyboard test now installs stable tracked window/document event targets before Canvas effects, mutates `activeElement` for Tab navigation, and unmounts before restoring globals. All original Delete, shortcut, modal Escape, Space, and Tab assertions remain. Added assertions require listener registration, exact callback removal, and empty listener registries after unmount.

- Preimage SHA-256: `0d3f652766b01c5baceaf9fc53b9e170be8c5ab4a4b6c0c3c64dd75c36e7a181`
- Final test SHA-256: `f4a4c5811b9933203e6f8203bd841b9d2ee6f20c608d2f2e93dac905225412db`
- No product files were deleted; no production or renderer code was modified.

## Results

- Lifecycle plus actual React/jsdom Canvas/WASM suites: 61/61 passed (`lifecycle-focused.log`).
- All nine affected suites: 162/162 passed (`lifecycle-affected-final.log`). This includes the 29 actual Canvas selection tests.
- TypeScript passed (`lifecycle-typecheck.log`); whitespace check passed.
- Independent review retained every original assertion and separately passed all 32 lifecycle tests.
- Cleanup negative witness: deliberately omitting Canvas unmount fails on missing keyboard-listener callback removal (`lifecycle-no-cleanup-negative.log`). Its Vite config changes only the test module in memory; canonical tests and production code are never changed.

The negative run intentionally filters to the one affected test; its 31 unselected tests are not skipped in the normal 162-test run. These handler/DOM tests do not establish browser-native, Electron, GPU, or pixel fidelity behavior.

## Reproduce

From `frontend/design-client`, run the local Vitest executable against `src/editor-lifecycle.test.tsx` and `src/canvas-selection-workflows.test.tsx` with `--maxWorkers=1`.

For the expected-failure witness, use `--config ../../testing/verification-lifecycle-harness/lifecycle-no-cleanup.vitest.config.mjs -t 'dialog button Delete' --maxWorkers=1`. Exit status 1 is expected only for this negative witness.

Logs in this folder replace private executor/dependency paths with neutral labels; the original raw logs are retained separately. `publication.sha256` recursively covers this folder except the manifest itself, with folder-relative paths. Verify it from this folder with `sha256sum -c publication.sha256`.
