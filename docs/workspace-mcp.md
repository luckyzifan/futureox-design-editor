# Scoped workspace and preference MCP tools

The existing current-document grant is unchanged. In the AI / MCP dialog, **Workspace and document library** and **Application preferences** both default to **No access**. Selecting a value does not enable anything: the user must click an enable button and approve a native dialog naming the current design, root and independent scopes. Grants are ephemeral and are revoked by document/session changes, disable, window close or restart. No grant is persisted in SQLite or localStorage.

An independently granted workspace writer may save while the document grant remains read-only; it cannot invoke document mutation methods. Only granted operations are advertised by real MCP `tools/list` (names have the `design_` prefix and dots become underscores).

| Operation | Scope | Main arguments |
|---|---|---|
| workspace.root.status | workspace read | none; returns root and current-document handles |
| workspace.list | workspace read | rootHandle; optional limit 1–100, cursor, includeDeleted |
| workspace.revisions | workspace read | rootHandle, documentHandle; optional beforeRevision |
| workspace.open | workspace write | rootHandle, documentHandle, mutationId |
| workspace.importCopy | workspace write | rootHandle, format (`native-json`, `fd`, `sketch`, `fig`), mutationId; exactly one of content or base64 |
| workspace.save | workspace write | rootHandle, expectedStorageRevision (positive integer or null for a new design), mutationId |
| workspace.restore | workspace write | rootHandle, revisionHandle, expectedStorageRevision, mutationId |
| workspace.root.select | workspace write | rootHandle, mutationId; optional useDefault |
| workspace.root.activate | workspace write | rootHandle, selectionHandle, mutationId |
| settings.get | settings read | none; returns rootHandle and settingsRevision |
| settings.update | settings write | rootHandle, expectedSettingsRevision, mutationId, patch |

Every mutating MCP call also requires the existing outer documentId, session and expectedRevision fields from a current read. These are editor guards; expectedStorageRevision and settingsRevision are separate CAS domains.

Workspace, document, revision, selection and list-cursor handles are opaque, bounded and owned by one grant and one native workspace identity. Paths, shell commands, arbitrary filesystem access, credentials and security settings are not supported. List pagination rejects a cursor after document revisions change. Metadata responses never contain complete document JSON.

Open, history restore, directory preparation and activation require native action confirmation. Open/restore/activation reject dirty documents, pending input, active gestures and busy operations. Save never commits a text/property draft. Navigation uses guarded DesktopSession adoption, rather than a discard prompt. A successful navigation invalidates the old grant and may disconnect before a reply; obtain a fresh grant, list/read the durable state and reconcile before continuing.

Mutation IDs contain exactly 1–128 ASCII letters, digits, hyphens or underscores, matching the SQLite v5 contract. Invalid identities are rejected before reserving a write. A definitive backend INVALID_REQUEST/conflict clears DesktopSession’s pending write; timeouts, transport failures and invalid acknowledgements retain it for reconciliation.

History returns at most 100 revisions per page even though the v5 backend may return 1000. When hasMore is true, pass nextBeforeRevision as the exclusive beforeRevision boundary; it is the last revision actually returned, so no stored rows are skipped.

Saves use immutable snapshots, the caller's exact SQLite expected revision and mutation ID. Older successful saves never mark newer canvas edits as saved. History is parsed before a durable restore; restore does not silently replace the caller's CAS with a newer revision. Concurrent edits or cancellation after a durable write preserve the current editor. Durable state may have changed even when the connection or response is lost.

The native host reserves a bounded mutation receipt before asynchronous work. Identical in-flight and completed retries share that receipt; reusing a mutation ID with different arguments fails. Uncertain failures are retained rather than blindly retried. SQLite additionally owns durable commit/restore idempotence. This is not an exactly-once transaction spanning Editor, native transport and SQLite. Receipt stores are limited to 128 mutations per grant; reconnect/reapprove before further writes when full.

## Independent-copy import

`workspace.importCopy` saves a new document in the granted workspace. Use `content` for native JSON or canonical `base64` for FD/Sketch/FIG; paths, URLs and PDF are unsupported. The source and serialized parameters are bounded by 32 MiB minus 128 KiB of framing reserve, and expanded prepared output has the same bound. The host reserves the new document UUID; the caller cannot choose a destination ID or overwrite an existing design. The existing backend admits the document and commits it with create-only storage CAS (`expectedRevision: null`), then verifies revision 1 by reading back its complete value tree and canonical storage hash.

The result contains bounded metadata, a grant-bound document handle, `activated: false` and a completion record. It does not load the copy, save/discard the active draft, change selection/page or add an editor undo entry. Unsaved authored edits may remain; busy operations, pending field/text input, active gestures, changed editor revisions, root changes and revocation reject admission. Opening the returned handle is a separate `workspace.open` operation with its existing clean-editor guards and native confirmation. Ordinary `document.import` still appends to the active document.

Sketch and FIG results explicitly report `fidelity: "compatibility"`, `lossless: false` and bounded warnings. FIG decoding uses the existing import worker; parser/worker-protocol substitutes do not establish actual browser Worker startup, timeout, cancellation or termination behavior. Native JSON/FD retention and external-format fidelity remain separate contracts.

Keep the same `mutationId`, arguments and original outer fences for an exact retry within the same live grant. It returns the reserved operation's original result or error; it does not attempt a second import. `IMPORT_COPY_OUTCOME_UNKNOWN` means storage may already have committed. `IMPORT_COPY_COMMITTED_UNVERIFIED` means storage acknowledged the copy but exact readback was not verified. `IMPORT_COPY_COMMITTED_ACCESS_ENDED` means it committed before access ended. These errors never authorize importing again with a new ID. An unresolved storage outcome/readback failure blocks new mutating workspace/settings operations in that grant; exact receipt replay and reads remain available. Ordinary editor editing is unaffected. Reconcile saved state, obtaining fresh native approval when needed; cancellation or disconnection cannot roll back a committed copy.

Preferences remain application-profile preferences; binding the grant to a root controls access lifetime and does not create separate preference storage for each workspace. Preference patches allow only six canvas booleans (snap, snapPixels, pixelGrid, rulers, checkerboard, grid), scrollWheelZoom and shortcutProfile (figma-like/sketch-like). The revision tracks live menu/store/keyboard changes. Entire patches are validated before application, and existing preference stores remain authoritative. Persistence is reported by group and as available/session-only; the result explicitly reports atomicDurability=false because separate localStorage keys are not a transaction.

## Verification boundary

Production native parsing/grant isolation is tested with in-memory byte streams. Real MCP JSON-RPC tools/list and tools/call go through the production workspace host and production stdio Sidecar into a temporary SQLite database; database reopening checks durability. Actual Editor/WASM + DesktopSession and preference-store tests cover dirty input, stale callbacks, CAS, uncertainty and metadata-only output. GUI dialogs, real socket binding and GPU execution are not part of these non-GUI tests.

The [2026-10-21 functional merge record](../testing/verification-functional-merge-20261021/README.md) distinguishes imported historical results from current combined-source runs. A fixture-backed socket or official-SDK stdio test validates its transport boundary; it does not establish a real Electron grant/dialog → Editor → SQLite end-to-end interaction.
