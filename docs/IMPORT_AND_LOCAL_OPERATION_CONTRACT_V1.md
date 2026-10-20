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
whole-document new-copy lifecycle, semantic selection scaling, stable
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
