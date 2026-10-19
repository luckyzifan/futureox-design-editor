# Independent settings/workspace safety review

Reviewed the in-progress checkout `<repo>`. Exact production snapshot hashes are in `reviewed-snapshot-sha256.txt`. Production files were reviewed, not edited by this reviewer.

## Findings fixed by owners during review

1. **Native close while Settings is open trapped dirty-close confirmation.** Settings owns a body portal, makes the application root inert, and retains focus. The original App native-close callback left Settings mounted before creating the dirty-close prompt inside that root. Root fixed the callback by synchronously dismissing Settings before asking DesktopSession to close. Independent actual-callback/real-React/jsdom test passes; removing only the cleanup reproduces an inert, inaccessible prompt.
2. **Peer launch during asynchronous workspace finalization.** A launch could interleave after the switch's peer check while the saved pointer was being persisted. Native owner retained closePending and added closeFinalizing, guarded live-new-window throughout this transaction, tracked pending launches, and disallowed peer descendants. Independent real-handler/mock-OS test holds persist pending: production rejects BUSY, while a negative control removing only the launch fences admits a peer and relaunch concurrently.
3. **Settings instructed users to close peers but never rechecked status.** WorkspaceRootControls originally read status only on mount. Root added an explicit refresh button, checking state and stale/unmount guards. DOM tests verify peer close followed by refresh re-enables the choice, a read failure can be retried, and old/post-unmount results cannot affect controls.
4. **Preference scope text overstated cross-window retention.** Native peers have separate temporary Electron profiles, while preferences use renderer localStorage. Owner changed wording to the current app profile and added the separate-window limitation. The main app profile survives workspace restarts; shared native preference storage is not implemented by this change.

## Independent verification

- `settings-close-boundary.test.ts`: 6 passed. Real React/jsdom Settings portal and WorkspaceRootControls, actual App native-close callback extracted at test time, focused fakes only for DesktopSession/IPC. Includes one deliberately mutated negative control.
- `native-switch-boundary.test.mjs`: 3 passed. Actual registered main-process handlers, owner harness OS/Electron/process boundaries mocked, an independently held persistence boundary and deliberate negative control. Relaunch exception restores the saved selection, keeps the window open and permits a fresh selection.
- Current owner native suites independently rerun: workspace-roots, main and preload, 77 passed.
- Current owner frontend suites independently rerun: SettingsDialog, settings-preference, workspace-root-controls, editor-lifecycle, shortcut-dom, 70 passed.
- Output logs are stored beside this report. No new blocker remained in the reviewed snapshot.

## Reviewed safeguards

Native directory selection is authoritative; renderer receives labels and opaque expiring one-use selection IDs. Activation revalidates directory identity and performs a fresh candidate backend probe after dirty-close approval. The old live backend is never swapped in-place. Cancelled/failed close retains the current editor; failed relaunch restores the selection pointer when persistence remains available. Root/default/database/recovery paths are screened for unsupported file/symlink/hardlink states and write access, including permission failure tests. Settings/reset changes target explicit UI preference fields, with validated input, session-only fallback on failed storage, document/history preservation and current app-profile scope.

## Limits

CPU/Node/jsdom and mocked native lifecycle only. No Electron OS window, actual OS process restart, browser, GPU, native directory picker, real socket or user-profile operation was run. These tests do not establish GUI/pixel/OS restart success or whole-repository compilation. Pending native callbacks are tested via controlled fakes rather than external scheduling.

The native peer gate counts children owned by the current host and pending child launches. A detached peer surviving an earlier main-host exit is not rediscovered by a later process; it remains bound to its original database, and the restart path does not migrate or terminate it. This is a documented scope limit, not a machine-global window lease guarantee.
