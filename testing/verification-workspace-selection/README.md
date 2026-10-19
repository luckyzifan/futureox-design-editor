# Local workspace directory selection verification

## Implemented behavior

- Every ordinary desktop startup asks which local workspace to open. The native chooser offers the last selected directory when available, a new directory, the original default workspace, or Quit. Cancelling the folder picker returns to this chooser; it never silently selects an empty default.
- A chosen directory contains `.futureox-workspace/workspace-v1.sqlite3`, `catalog-v1.sqlite3`, `recovery-v1/`, and an ownership marker. It need not be a Git repository. The original default database remains at its legacy profile location; selecting other roots does not move or delete it.
- The renderer receives only a display name and an expiring opaque selection ID. It cannot supply a filesystem path. Native root status/select/default/activate methods are fixed, frozen preload capabilities.
- Selection initializes and probes a candidate, but does not change the active process or remembered root. Activation uses the existing renderer dirty-save/recovery close handshake, followed by Sketch close approval. Only then does native code revalidate/reprobe, atomically write the preference, schedule relaunch, and finish draining the old process.
- Cancellation, stale capability, failed database admission, changed directory identity, or synchronous relaunch failure leaves the old process usable. A synchronous relaunch failure restores the old remembered root and returns `accepted: false`, allowing the renderer close fence to resume editing.
- Storage-root changes never happen in a live backend. Existing file capabilities, tabs, callbacks, preparation, render, and automation sessions therefore cannot be redirected into a different database.
- Current primary-owned peer windows and in-flight peer launches prevent switching. Peer windows cannot change roots or spawn untracked descendants. Peer launches are fenced throughout dirty-close finalization. Peers left alive after an earlier primary process exited remain independent and bound to their old root; this is not a machine-wide peer enumeration mechanism.

## Tests actually executed

1. `native-regression.log`: 129/129 tests passed, no skips. Real filesystem fixtures plus mocked Electron and selected process boundaries. Covers main/preload, directory selection/cancellation/permissions/identity, symlink/hardlink rejection, original-default restoration, staged versus committed selection, stale and forged capabilities, untrusted sender frames, late SQLite failure, repeated close approvals, relaunch rollback, peer-launch exclusion, existing security, directory grants, window-state, legacy migration, sidecar lifecycle, in-memory automation, and keyboard regressions.
2. `native-boundary-final.log`: focused 77/77 tests passed, no skips. Included in the broader run above, not additive coverage.
3. `sqlite-runtime-final-v2.log`: 2/2 real Rust sidecar/SQLite tests passed, no skips. Stdio only. Two selected directory workspaces preserve multiple canvas documents, two pages per document, exact extension fields, and revision history across actual backend stop/reopen. The same document ID in a second root remains isolated. Original default SQLite bytes stay unchanged while other roots are used, and original documents remain readable. A future-schema target is rejected while the remembered selection and original document remain usable.
4. JavaScript syntax checks passed for main.mjs, preload.cjs, and workspace-roots.mjs. `git diff --check` passed for the edited tracked native/type files.

Runtime binary: `/workspace/shared/design-phase2/cargo-target/debug/futureox-design-desktop-backend`.
SHA-256: `3f1e93319cb0e4022071592c04ef70783f1a489547b7726ca9833e5b0a5fd624`.

Latest retained real SQLite fixtures:
- `sqlite-roots-s1Henj/`: successful root isolation/restart/default-preservation scenario and evidence.json.
- `sqlite-roots-N455zV/`: future-schema rejection and evidence.json.

Earlier runtime fixture directories and logs are retained as well. The initial runtime assertion expected the underlying `WORKSPACE_FUTURE_SCHEMA` reason to be the public error code. The actual backend deliberately wraps it as `WORKSPACE_UNAVAILABLE` with that reason in its message. The test was corrected to assert this existing contract; no backend code was changed to satisfy it. The initial failing output remains in `sqlite-runtime-initial-negative.log` and `sqlite-runtime.log`.

## Explicit limits

No real Electron window, native chooser interaction, packaged app restart, GPU, browser, or OS automation socket was launched. The native dialog/close/relaunch evidence is mocked Electron boundary evidence, not GUI acceptance. Real process and SQLite persistence evidence is separate. A successful `app.relaunch()` call schedules a launch; it cannot prove the subsequent OS launch or renderer succeeds. The native startup chooser and backend-admission error path remain available on the next launch. Adversarial concurrent filesystem replacements between OS path operations are not claimed to be impossible; identity, symlink, file-kind, and admission checks run before and after staging/probing and again at commit.

These changes do not change the Rust workspace schema or storage protocol, migrate the original profile to a selected directory, copy existing documents between workspaces, or upload/publish any data.
