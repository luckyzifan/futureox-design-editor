# Import identity and local operation boundaries

This is a local-first contract. It does not add a backend, account system,
network collaboration, remote apply endpoint, or authenticated administrator.

## Import is not retry

| Entry point | Identity and effect | Repeated invocation |
| --- | --- | --- |
| UI file open/import | A new local document ID; the parsed graph is retained | Another independent document, even with the same filename or bytes |
| UI append | Current document ID retained; imported graph references remapped | Another independently editable set of groups |
| MCP `document.import` | FD/native JSON append, never document replacement | Another append unless part of an exact receipted retry |
| MCP `sketch.import` / `svg.import` | Append through the existing codecs and importer | Another independent append |
| `batch.apply` with `mutationId` | Existing document/session/revision fences and a bounded session-local receipt | Exact same request and original fences return the earlier receipt; changed arguments conflict |

The UI adoption helper is `frontend/design-client/src/import-identity.ts`.
It allocates a new document identity without rewriting authored content.
Native node identifiers are scoped to their document. The FIG parser creates
fresh native node IDs; append remaps imported identities and references.
Filename, original identity, and content hash are not overwrite or deduplication
keys. There is no automatic "update the earlier import" behavior.

Keep existing MCP clients stable: `document.import` remains append-only.
Unsupported `mode: "replace"` / `"new-copy"` and foreign formats reject rather
than silently switching or dropping content. A future whole-document lifecycle
operation must be separately advertised and honor native switching/dirty-state
protection.

A receipt is not rollback or redo. Replaying a successful import receipt after
undo returns that original success without restoring the imported objects.
A new intentional import uses a new mutation ID and newly observed fences.
Receipts do not survive process/API-session replacement.

Figma's official documentation supports the independent-copy behavior:
[local copies](https://help.figma.com/hc/en-us/articles/8403626871063-Save-a-local-copy-of-files)
explicitly become new unlinked files when reimported;
[Sketch imports](https://help.figma.com/hc/en-us/articles/360040514273-Import-Sketch-files)
convert into Figma Design files without following later Sketch changes.
This comparison is not a claim of third-party format or pixel equivalence.
Figma's local-export comment/history limitations do not authorize deleting
Futureox native authored reviews or local saved history.

## Source is provenance, not authority

The UI/audit source `user` maps to native `EditScope.source = "user"`;
`automation` maps to native `"ai"`. The trusted `Editor.change` route passes this
classification through `Editor.push` to both op-batch and document-replacement
history commits. It does not enable `ignoreUndoRedo` or `writeInReadonly`.
Gestures remain user-authored.

An undo/redo audit event describes who initiated that action. It does not rewrite
the original edit's provenance. No-op/rejected edits do not publish a new source
or history entry. Native `last_edit_scope_json` reports the last committed edit,
not the caller of a later undo/redo.

Local display names or a future "administrator" badge must not grant access.
The current exact-document/session operation policy and native grants remain
the authority. Request-supplied `actorId`, `role`, `source`, or `permissions`
are rejected. Files and optional FD metadata cannot grant access.

The current commit event is an observation seam, not a replay protocol:
no authenticated actors, causal ordering, conflict merging, selective
multi-user undo, durable collaboration event log, or remote transport is
implemented. A future actor/auth provider must remain non-authoritative until
an actual verified authentication mechanism is supplied. Do not advertise
placeholder collaboration or authentication tools.

## Generated coverage, not a marketing count

[OPERATION_COVERAGE_V1.json](OPERATION_COVERAGE_V1.json) is generated from:

- The actual shared operation registry.
- Actual descriptors registered by the mounted editor bridge in an in-memory
  test transport. This does not start a socket, GUI, or CPU preview.
- The native workspace/settings descriptor catalog.
- The real MCP `OperationBackend` grant filtering and tool-name conversion.
- Every current `CanvasAction` category, with authored-operation, partial, or
  UI-only classifications. Type checking requires new categories to be classified.
- The current `NODE_FIELDS`, without a hand-maintained numeric field total.

The generated full catalog uses simulated complete local grants only to describe
available implementations. It does not enable those grants or promise their
presence in a real session. Always discover the actual authorized `tools/list`.
Neither a category mapping nor a method descriptor proves all UI subcommands,
pointer behavior, GPU pixels, native platform integration, or external MCP-client
acceptance.

Reproduce from `frontend/design-client`, using the expected WASM hash for the
source increment being verified:

```sh
FUTUREOX_COVERAGE_MANIFEST="$PWD/../../docs/OPERATION_COVERAGE_V1.json" \
  node_modules/.bin/vitest run src/automation/operation-coverage.test.ts
```

Known deliberate gaps remain visible: FIG/PDF MCP import, PDF MCP export,
automatic whole-document activation after import, stable
vertex-level patches, arbitrary commands, remote collaboration, and auth.
Tests require these names to remain absent and reject as `unsupported_method`.
When one is genuinely implemented, update its classification and tests together;
never hide a gap behind an empty successful tool.

## Verification boundary

Targeted tests exercise the actual Rust/WASM editor, native codecs, native
history scope, and in-memory MCP NDJSON transport. Repeated FIG tests reuse the
schema of the repository's existing small FIG fixture; repeated Sketch tests
use generated native archives. No large private assets are duplicated.

The real-117 Sketch repeat test remains separately gated by `SKETCH_FIXTURE`.
An absent fixture is a skip, not acceptance evidence. Browser file-picker UI,
real Web Workers, Electron/native dialogs, physical persistence, sockets,
GPU presentation, and an external MCP client require their own acceptance.


## Saved native import copies through MCP

`workspace.importCopy` (`design_workspace_importCopy`) requires a separate native
workspace write grant, that grant's `rootHandle`, current `documentId`, `session`,
`expectedRevision`, and `mutationId`. Use `format: "native-json"` with `content`,
or `format: "fd"` / `format: "sketch"` / `format: "fig"` with canonical `base64`, never both. PDF, arbitrary paths,
URLs, source-selected destination IDs and caller authority fields are rejected.
The frame and expanded native payload remain bounded at 32 MiB with a 128 KiB
reserve. Metadata/extension payloads remain inert and cannot grant permissions.

This is storage creation, not active-document replacement or append. Native
checksum/structure/size and authoritative model admission run without editing
preparation or layout. Saved does not mean opened or derived-layout-ready; the
shared font environment and geometry epoch are never changed. Normal editing
preparation remains part of a subsequent native-confirmed open. It assigns
one host-owned UUID and saves once using the existing create-only workspace CAS
(`expectedRevision: null`). Internal node/component/resource IDs stay scoped to
the new document. Current content, selection/page, dirty state, revision and
undo/redo remain unchanged. Dirty saved or unsaved authored edits are allowed;
pending UI inputs, active gestures, busy state and stale fences reject. No save,
discard, tab activation or native open confirmation is performed by this command.
The returned opaque `documentHandle` is usable only while its original grant is
live; `workspace.open` remains separately native-confirmed and revokes the old
session after a successful switch.

Identical concurrent retries with the same arguments and fences share the
reserved promise, UUID and snapshot; changed arguments with the same mutation ID
conflict. A distinct mutation creates a distinct copy, not content deduplication.
A successful response includes `activated: false` and
`completion: {status: "committed", retry: "do-not-retry", verifiedReadback: true}`.
The existing SQLite snapshot readback verifies document identity, revision,
metadata hash and the full submitted value tree before a handle is returned.
This is native storage readback, not an editor activation or a rendering check.

The host receipt is bounded and grant-local, not a durable cross-process replay
API. The SQLite mutation receipt is durable. Loss of a response does not prove
rollback: cancellation/revocation after commit leaves the saved copy intact and
returns no newly usable grant handle. An unknown storage outcome reserves that
mutation and blocks further writes in the grant. A valid commit acknowledgement
followed by failed/mismatched readback remains committed-but-unverified, not a
second create opportunity. Neither case is automatically retried with a new UUID
or mutation ID. After reconnecting, inspect the workspace using fresh native
approval and reconcile before deciding on a new import. A prior host receipt
cannot be replayed across revoked grants.

`document.import` retains its existing append/remap, optional-metadata rejection
and one-undo semantics. This command does not claim a new FIG/PDF decoder, cloud
collaboration, external Figma MCP parity, rendered fidelity, or automatic opening.

Sketch copies use the existing shared WASM ZIP codec, replace its format-local document ID with the host UUID before admission, and preserve the complete admitted graph/resources and sketchContainers without append remapping. Results and exact retry receipts include sourceFormat: "sketch", fidelity: "compatibility", lossless: false and validated compatibility, codec and font warnings (maximum 256 notices, 16,384 characters per message and 64 KiB total). Warnings are never silently truncated. Native archive-preserving Sketch editing remains separate; this is not lossless or pixel-fidelity import. No font registration, layout or geometry epoch change occurs.


### FIG compatibility candidate (not released)

The isolated candidate exposes `fig` in the workspace format enum. Targeted
parser, protocol and real SQLite validation has passed on the supplied user FIG.
Actual browser Worker execution remains a separate unrun acceptance gate; this
is not a released capability or full-fidelity claim.
FIG uses the existing cancellable file worker with canonical base64 bytes and a
fixed internal display name; no path, URL, remote fetch or filename is accepted.
The host UUID replaces format-local identity before synchronous model admission.
After the worker await, document/session/revision, cancellation/deadline,
pending input, active gesture and busy guards are checked again; the host also
rechecks the workspace grant/root and live editor immediately before create-only
CAS. No editing preparation, fonts, layout, epochs or activation is performed.

The result and exact retry receipt carry `sourceFormat: "fig"`,
`fidelity: "compatibility"`, `lossless: false`, a leading `FIG_COMPATIBILITY`
warning and parser notices as `FIG_CODEC_NOTICE`. The parser report is bounded
to 128 messages including its explicit truncation notice, 1024 UTF-8 bytes per
message and 32 KiB total message bytes. The host permits at most 129 warnings
including compatibility, each at most 1024 UTF-8 bytes, and 40 KiB serialized
warning bytes. Optional positive safe-integer `droppedOccurrences` is required
exactly when the single explicit truncation notice is present; omissions are
not silent. The full prepared envelope retains the 32 MiB minus 128 KiB limit.
Native/Sketch warning semantics, exact retries, storage CAS/readback and unknown
outcome handling are unchanged. No FIG fidelity, GUI, real-worker or
external-client acceptance follows from the targeted tests. Parser/NDJSON/SQLite
checks use a Worker protocol substitute, not a browser Worker.

The candidate checks every outer ZIP entry and each of the two inner fig-kiwi
compressed segments against a 200:1 expansion limit, with an output of at most
4 KiB exempted. Inner schema/data hard limits remain 4 MiB/64 MiB. Zstd declared
size is checked before constructing its decoder, and actual output is checked
independently. Exact DEFLATE consumption uses fail-closed runtime checks against
the pinned fflate 0.8.3 streaming state, since its public final flag does not prove
consumption. Dependency upgrades require renewed endpoint/alignment/chunk-boundary
regression testing; a changed or unprovable state must reject, not silently pass.
