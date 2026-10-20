# Settings/navigation locale verification

Run from an integrated source checkout with the approved page-memory preference cohort present:

```sh
bash testing/verification-settings-locale/verify.sh /absolute/evidence-directory EXPECTED_KERNEL_SHA256
```

This runs full frontend typecheck, 13 focused/adjacent suites (187 tests at this slice), source-inventory byte comparison and a Vite production build using existing dependencies and verified existing WASM. No install, listener, network service, backend, authentication or remote access is started.

The 554 fixture kernel SHA-256 is `3478e1b381207c98133218879f25f428bfadbefdb9bd42d5b35efb5cb143b161`. Check the integrated kernel identity rather than blindly accepting this value after unrelated changes. Regenerate `docs/I18N_REMAINING_STRINGS_V1.json` with `node scripts/generate-i18n-inventory.mjs` from `frontend/design-client` when combining approved source changes, then review the new candidate totals before running this gate.

A symlink overlay must materialize `index.html` and source/module text before building, or Vite can resolve the entry outside its root. Runtime assets may be shared during verification; this gate is not a self-contained distribution package check. The Vite command is the production frontend bundler, not the package's Bun wrapper, Rust rebuild or Electron packaging command.

The new mounted tests use real React/jsdom, actual Editor/WASM and a declared desktop IPC double. They exercise both platform explanation branches and both locales, persisted reload, close/reopen, repeated changes, pending drafts, invalid nudge input, exact editor snapshot/camera/document/page/selection retention, undo/redo, actual DesktopSession dirty flags, unchanged save-call counts, diagnostics, memory tiers and view-menu operations. They do not establish physical storage, live browser/Electron layout, native menu, screen-reader output, GPU or real-device acceptance.
