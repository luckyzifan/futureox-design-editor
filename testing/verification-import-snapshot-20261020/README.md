# Prepared import snapshot reuse

This increment follows the real Electron FIG profile in `../verification-real-electron-flames-20261020/`. That profile attributed about 549 ms inclusive samples to the first recovery capture/encode and about 1.03 s inclusive samples to native render serialization. These categories overlap other stacks; they are not additive estimates of an achieved speedup.

The implementation reuses the exact post-layout, native-validated JSON for:

1. DesktopSession's first current-generation save/recovery, without treating an import as durably saved before its commit acknowledgement.
2. KernelClient's full document submission and requested full-document fallback while the certifying Editor still owns the exact document, revision and session.

Edits, reentrant adoption, unknown storage codecs and expired ownership retain their ordinary serialization paths. Editor changes/disposal release retained render bytes. Admission, layout, derived validation, mutation acknowledgements and undo transactions are unchanged. No asynchronous preparation Worker is enabled.

## Recorded checks

- `vitest.txt`: 12 files, 152 passing tests, zero failures/skips; one concurrent worker, 10.30 s.
- `contracts.txt`: 5 passing Node admission contract tests.
- `typecheck.txt`: `tsc --noEmit` passed.
- `initial-run.txt`: initial overlapping 114-test run had one reused-token error-message failure. `ensurePreparedDocument` was corrected to reject consumed private tokens explicitly before shape validation; the final run above includes the corrected behavior.

New regression cases use the actual Editor and portable WASM preparation, with desktop storage/transport and render Worker boundaries doubled. They verify exact transmitted strings and encoder invocation counts, pending-save dirtiness, later edits, same-root revision changes, reentrant and nested-session adoption, forged/unadopted values, undo/redo, and disposal. Existing native codec tests also compare actual persistent Node worker output with certified bytes.

These are focused correctness and repeated-work checks, not a physical Electron/GPU latency result. The shared working tree was also receiving independent geometry/renderer changes; final integrated source/build identity and GUI performance are recorded by the parent verification run.

## Reproduce

From `frontend/design-client`:

```sh
node node_modules/vitest/vitest.mjs run \
  src/kernel/prepared-document-serialization.test.ts \
  src/kernel/native-preparation.test.ts \
  src/document-import-snapshot.test.ts \
  src/document-baseline-certificate.test.ts \
  src/document-adoption-reentrancy.test.ts \
  src/prepared-document.test.ts \
  src/desktop-session.test.ts \
  src/document-switch-ownership.test.ts \
  src/document-lifecycle-diagnostics.test.ts \
  src/document-admission.test.ts \
  src/fd-extensions.test.ts \
  src/workspace-session.test.ts \
  --maxWorkers=1
npm run typecheck
```

From the repository root:

```sh
node --experimental-transform-types --import ./testing/lib/register-typescript.mjs \
  --test frontend/design-client/src/model-mask-admission.test.mjs
```
