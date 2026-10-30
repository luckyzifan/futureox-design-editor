# Offline desktop file backend

This crate is the Rust sidecar used by the Electron design desktop application.
It reuses `futureox-design-kernel` for document validation. It has no HTTP listener,
network client, PostgreSQL/Redis requirement, or server deployment. When main passes
`--workspace-db`, SQLite is the durable source for local document revisions and
their embedded resources. A separate catalog database indexes external portable
files. `.forma` import/export and legacy recovery remain available independently.
Editing/rendering still use the existing editor and Rust/WASM kernel; this crate
owns durable storage, not a second editing implementation.

## Build and run

From the repository root, using the pinned Rust toolchain:

```sh
cargo build --locked --manifest-path design-studio/Cargo.toml \
  -p futureox-design-desktop-backend
cargo test --locked --manifest-path design-studio/Cargo.toml \
  -p futureox-design-desktop-backend
cargo clippy --locked --manifest-path design-studio/Cargo.toml \
  -p futureox-design-desktop-backend --all-targets -- -D warnings

design-studio/target/debug/futureox-design-desktop-backend \
  --recovery-dir /absolute/app-owned/recovery-directory \
  --catalog-db /absolute/app-owned/catalog-v1.sqlite3 \
  --workspace-db /absolute/app-owned/workspace-v1.sqlite3
```

`CARGO_TARGET_DIR` can redirect build outputs. `--offline` is supported when the
existing dependencies are cached. This revision adds backend dependencies on the
workspace-pinned Tokio 1.53.1 (stdio/io-util/time) and sqlx 0.9.0 (SQLite and Tokio
only), plus Windows-only same-file =1.0.6 for stable handle identity. Native font
discovery reuses the already locked workspace `ttf-parser` 0.25.1 and `base64`
0.22.1; no dependency versions were upgraded. Build separately for each target OS/CPU; a
Linux executable is not a Windows or macOS artifact.

## Trust boundary

- Only trusted Electron main owns the child process and its stdio pipes. Do not
  expose this protocol, `child_process`, filesystem access, or path arguments to
  the renderer.
- Main authorizes a path with a native Open/Save dialog and maps it to an opaque
  renderer handle. Main retains the actual path and last acknowledged file hash.
- A renderer cannot choose `--recovery-dir`. Main chooses a dedicated private
  application-data subdirectory. An existing symlink recovery root is refused.
- The main process must serialize document lifecycle operations and coordinate
  recovery writes/discards. One backend blocking worker serializes all file,
  recovery and catalog jobs. Health/cancellation are async control-plane requests.
- Main should enforce single-instance ownership of this recovery directory. No
  cross-process recovery-write lock is provided.
- Native leaf symlinks and non-regular files are refused. Parent paths are
  canonicalized. Linux/macOS no-follow and nonblocking opens and Windows
  open-reparse-point handles protect the final read component. A hostile process
  with permission to rename ancestor directories remains outside this boundary;
  this is not a filesystem sandbox against another process running as the user.

## Protocol version 1

One UTF-8 JSON object per line; CRLF is accepted. One correlated reply per request. File/catalog/recovery jobs execute FIFO; health
and cancellation replies may overtake them. IDs are nonempty strings of at most 128 bytes or JavaScript-safe
integers. EOF drains accepted jobs and joins workers before exit. Diagnostics go to stderr, never stdout.

```json
{"id":"request-1","method":"health","params":{}}
{"id":"request-1","result":{"protocolVersion":1,"documentTransferVersion":1,"documentCapacity":{"memoryBytes":1073741824},"maxDocumentBytes":67108864,"maxFrameBytes":67108864,"maxRecoveries":16}}
```

Errors are `{"id":...,"error":{"code":"...","message":"..."}}`; an unparseable
or oversized request uses `id:null`. Error messages are bounded. Malformed JSON,
unknown methods, invalid params, and oversized frames do not kill the process.
Oversized frames are drained without retaining the whole line in memory.

Commands and result shapes:

| Method | Params | Result |
| --- | --- | --- |
| `health` | `{}` | version and limits above |
| `open` | `{path, directoryId?}` | `{document, hash, path}` |
| `stat` | `{path, directoryId?}` | `{hash: string \| null, path}` |
| `save` | `{path, document, expectedHash: string \| null, directoryId?}` | `{hash, path, warning?}` |
| `recovery.write` | `{recoveryId, document, sourcePath?, sourceHash?}` | recovery summary |
| `recovery.list` | `{}` | `{entries: [summary], issues: [{recoveryId, message}]}` |
| `recovery.read` | `{recoveryId}` | `{document, ...summary}` |
| `recovery.remove` | `{recoveryId}` | `{removed: boolean}` |

`document` is a JSON object, not a JSON-encoded string. Recovery summary fields are
`recoveryId`, `documentId`, `name`, `updatedAt` (Unix milliseconds), `hash`,
`sourcePath` (nullable), `sourceHash` (nullable), and optional `warning`.
Recovery IDs are 1–80 ASCII letters, digits, underscores, or hyphens. Main should
generate a new unpredictable ID per editing session. Source paths are metadata
only: reading/restoring a snapshot never opens or writes that path.

## SQLite document workspace

`--workspace-db` is optional for legacy file-only consumers. `Backend::new` does
not implicitly enable it. Main chooses a canonical private application-data
path; authored content cannot select or change it. Catalog and workspace must be
different databases. `health` adds `workspaceVersion`, `workspaceAvailable` and
`workspaceError`. Workspace startup failure is explicit and retains the original
database; the backend does not create an empty replacement or disable portable
file/recovery operations.

| Method | Params | Result |
| --- | --- | --- |
| `workspace.list` | `{includeDeleted?: boolean}` | `{documents: [summary]}` |
| `workspace.open` | `{id, revision?: number}` | `{...summary, document}`; omitted revision selects head |
| `workspace.commit` | `{document, expectedRevision: number \| null, mutationId}` | `summary` |
| `workspace.trash` | `{id, expectedRevision, mutationId, deleted?: boolean}` | `summary`; default deleted is true; false undeletes |
| `workspace.revisions` | `{id, beforeRevision?: number}` | `{revisions: [summary], hasMore, nextBeforeRevision}` |
| `workspace.restore` | `{id, revision, expectedRevision, mutationId}` | `{...summary, document}`; copies an old snapshot into a new live revision |

A summary is `{id, name, revision, hash, updatedAt, deleted}`. Revision numbers are
positive JavaScript-safe integers; `updatedAt` is Unix milliseconds. `id` is a
document UUID. `mutationId` is 1–128 ASCII letters, digits, hyphens or underscores.
Main should generate a UUID for each distinct mutation, retain it until the
outcome is known, and reuse it only for the identical request. Exact retries return
the original committed revision even if the document has advanced. Reusing the
same mutation ID with different content, operation or expected revision returns
`WORKSPACE_MUTATION_CONFLICT`. Receipts are committed atomically with the snapshot.

`expectedRevision` is mandatory: explicit `null` only creates a document whose ID
does not exist; a number requires that exact durable head. A mismatch returns
`WORKSPACE_CONFLICT`. Updating a trashed document returns `WORKSPACE_DELETED` until
it is explicitly restored. Trash and history restore create monotonically newer
revisions; they never delete snapshots or rewind the head. IDs that do not exist
cannot be implicitly created by those operations. Restore does not touch a `.forma`
source or any path contained in authored JSON. After any successful acknowledgment,
the editor must mark only the submitted generation durable; newer live edits stay
dirty. A failed or disconnected write must not be displayed as successfully saved.

### Transaction, preservation and resource contract

- SQLite schema 2 has `documents` heads, immutable application-owned `revisions`,
  mutation receipts, content-addressed `assets` and `revision_assets` references.
  Creation/migration is transactional. Existing schema 1 snapshot BLOBs retain
  their original bytes and use legacy encoding 1; only new revisions use encoding
  2. Read-only integrity
  and version preflight occurs before changing journal mode. Corrupt, unversioned
  nonempty, unsupported future schema and missing-revision databases are retained
  and rejected, never silently reset.
- A single SQLx connection and `BEGIN IMMEDIATE` serialize durable writes. WAL,
  `synchronous=FULL`, foreign keys, a 2-second SQLite busy timeout and bounded
  connection acquisition are explicit. The existing bounded Rust worker queue
  remains the IPC admission boundary. An acknowledged transaction includes the
  head, validated snapshot and retry receipt; a statement failure rolls all back.
- Public snapshots retain their full validated JSON value and SHA-256. Internally,
  encoding 2 separates sufficiently large font/image strings into `assets`, with
  a versioned envelope holding explicit resource paths. Strings smaller than their
  path length plus 512 bytes stay inline to avoid reference overhead. The hash
  covers the reconstructed public document, never the private envelope. Embedded
  image/font strings and compatible unknown fields are preserved without a media
  codec or floating-point narrowing. JSON formatting/key order is canonicalized as
  with `.forma`; this does not promise identical original file bytes or universal
  future-schema support. Reads verify hash, document identity and kernel validity;
  a damaged snapshot is not overwritten by a later commit. Asset lookup verifies
  kind, byte length and SHA-256; references must target distinct schema-known
  placeholders and match the revision's foreign-key reference index. Expansion is
  bounded before materializing repeated strings. Unknown fields and arbitrary
  user text never become references, even when they look like a reference token.
- Documents use trusted resource-aware admission; individual IPC frames remain 64 MiB with bounded multipart transport. The SQLite
  main database uses SQLite/filesystem capacity rather than a 4 GiB product quota, and at most 10,000 indexed documents, including
  trash. These limits are not total RSS or WAL-size limits. History is paginated
  in pages of 1,000. Large identical font/image strings are stored once across
  documents and new revisions. Small values and old schema 1 snapshots remain
  inline. Resource insertion/reuse validation, revision references, head and
  mutation receipt commit in the same transaction; failed writes leave no orphan
  assets. No automatic history pruning, asset transcoding, unprompted trash purge
  or lossy storage fallback occurs. Incremental document patches and avoiding the
  full JSON IPC transfer remain separate work.
- Live edits, selection, camera and interactive undo remain in the editor and
  Rust/WASM. SQLite holds acknowledged durable versions; no second renderer or
  semantic editing implementation is introduced in the sidecar.
- Existing `.forma` and recovery snapshots can be admitted and committed through
  the same API. The backend does not automatically scan, delete or claim migration
  of old files/IndexedDB. The application must retain originals until a verified
  workspace commit completes. `.forma` export is a portable document backup;
  complete workspace backup must use a consistent SQLite snapshot or an orderly
  closed/checkpointed database, never copy only the main file during active WAL
  writes. A native whole-workspace backup UI is not supplied by this crate.

### Focused validation

`tests/workspace.rs` uses isolated temporary real SQLite files, not a mock. It
covers restart and original-receipt retry, concurrent writers/CAS, different-content
mutation reuse, injected SQL rollback, trash/undelete/history restore, future and
corrupt database preservation, damaged snapshot refusal, embedded resource/float
preservation, required IPC baselines, optional-store compatibility, file/journal
symlink refusal, and actual stdio process restart/EOF persistence. These are
backend tests; they do not establish renderer UI or native macOS usability.

`tests/workspace_assets.rs` additionally verifies real SQLite deduplication across
versions, image fills/strokes/instance overrides/animation poses/paint styles,
unchanged unknown text, asset corruption/missing data, rollback without orphan
assets, schema 1 upgrade without rewriting historical BLOBs, and portable `.forma`
reconstruction with the original document hash. The opt-in
`cjk_font_multiple_revision_size_and_time_benchmark` uses the bundled full Noto
Sans SC font and twelve revisions; run it in release mode with
`-- --ignored --nocapture`. Its timing includes the full snapshot/validation
contract and must not be reported as UI frame time.

## Native macOS fonts

`fonts.list {}` returns `{fonts, truncated, skippedCollections, skippedInvalid,
skippedTooLarge, unavailableDirectories}`. Each font is
`{id, family, style, postscript, index, sourceIndex}`; both index fields identify
the face in the source file. `fonts.read {id}` returns
`{font, data, index: 0, sourceIndex, extracted}`. The returned base64 `data` is
always a standalone face that the existing kernel can load at index zero.
`id` is an opaque access handle, not a path or
the content hash. The editor may calculate a content SHA-256 after decoding the
bytes when assigning its embedded resource ID. The renderer cannot specify a root
directory or file path through either method.

The native service scans `/System/Library/Fonts`, `/Library/Fonts`, and the current
user's `Library/Fonts` on macOS. Discovery is read-only and does not install fonts.
Limits are 4,096 directory entries, 1,024 faces, 1 GiB total source bytes read,
depth 4, 128 MiB per source collection, 64 faces per collection, 256 tables per
face, and 20 MiB per standalone/imported font. Symlink files/directories are skipped. Partial enumeration and
unavailable roots are explicitly reported. Metadata comes from `ttf-parser` name
tables; the family/style are not inferred solely from filenames.

Individual TTF/OTF files retain their original bytes (`extracted:false`). For
unsigned TTC/OTC collections, every supported face has its own opaque handle;
selection does not silently select face zero. The backend extracts the chosen
face to a standalone sfnt (`extracted:true`) by copying each complete table,
rebuilding aligned directory offsets and checksums, and updating the required
`head.checkSumAdjustment`. All other table bytes, including glyphs, metrics,
shaping tables and variable-font tables, are unchanged. This follows the
[OpenType file and checksum specification](https://learn.microsoft.com/en-us/typography/opentype/spec/otff).
The existing portable font model and renderer need no collection-index extension.

Signed TTC/OTC files or faces containing DSIG are explicitly refused because
container conversion invalidates their signatures. Malformed offsets, unsupported
versions, oversized faces and missing/duplicate required tables are rejected.
`skippedCollections` reports collections with unsupported version/signature/header
conditions; `skippedInvalid` and `skippedTooLarge` include rejected individual faces.
Other operating systems return `FONT_PLATFORM_UNSUPPORTED`; manually imported
portable fonts continue to work.

`fonts.read` requires a handle from the current catalog and rechecks the canonical
path and SHA-256 before returning bytes. A font replaced since enumeration returns
`FONT_CHANGED`; an unknown handle returns `FONT_NOT_FOUND`. Font bytes are not
reencoded, subsetted or reshaped by the native service. Container extraction is the
explicit exception to whole-file byte identity, while table data is preserved as
described above. The bundled Noto font is copied into isolated fixture directories.
A generated valid two-face TTC shares tables but has distinct names and horizontal
metrics, so tests detect accidentally selecting face zero. Tests compare all table
bytes (except the checksum field), glyph metrics/bounds and valid sfnt checksums,
and load both outputs in the existing design kernel. Other cases cover changed
source hash, invalid offsets/signatures, symlinks and resource budgets. The opt-in
`mac_collection_face_loads_and_shapes_in_existing_kernel` test reads installed
Hiragino Sans GB faces and shapes Chinese/Latin text through the actual kernel;
run it with `-- --ignored --nocapture`. Tests never modify system font directories.

`expectedHash` is required, not optional. `null` means the destination must not
exist. For an existing file, use its most recently acknowledged SHA-256 hash.
For Save As, obtain an overwrite-approved native dialog result before `stat`, then
use that baseline for `save`; do not turn a conflict into an automatic overwrite.
`stat` hashes existing bytes without validating their JSON so an explicitly
approved Save As can replace an invalid old file.

The hash returned by Open is over the exact loaded file bytes. A successful Save
returns the hash of the new serialized bytes. Main must update its baseline only
on success and only mark the exact submitted editor snapshot as saved. A later
edit remains dirty even if an earlier save finishes successfully.

## Document compatibility and limits

- Existing JSON `.forma` files with schema versions 1–6 are accepted. There is no
  implicit schema downgrade/upgrade; node-local variable modes require schema 6.
- The authored JSON value is preserved while a separate typed kernel document is
  validated. Direct backend round-trips retain compatible unknown JSON fields.
  Formatting/key order are normalized; this is semantic JSON preservation, not
  byte-identical preservation or a guarantee about arbitrary future schemas.
- UUID syntax for document/node/page IDs and unique page IDs is also checked to
  match the desktop editor. Frontend validation/migration still applies; kernel
  validation is not a claim that every frontend authoring constraint is identical.
  The renderer can normalize data when editing, so it must not advertise universal
  unknown-field round-trip preservation based only on the backend behavior.
- Native FD files and serialized documents use the pinned startup memory allowance. This keeps
  compatibility with larger embedded-font documents. RPC frames are limited to
  64 MiB, including JSON framing. The kernel's node/page/resource limits also apply.
- Recovery envelopes may use 64 KiB beyond the document limit for metadata. Up to
  16 snapshots are retained, each subject to the pinned resource allowance, with no automatic eviction.
  At capacity, an explicit restore/discard is required before a new session can
  be snapshotted. Rewriting an existing valid session remains allowed.

## Save guarantees and explicit limitations

Before writing, the backend validates the document and the expected hash. It
creates a unique same-directory temporary file with exclusive creation, writes
and syncs it, preserves existing basic file permissions, checks the expected hash
again, and atomically renames it over an existing target. A new target is created
with an atomic hard link from the fully written temporary file, which refuses a
racing create. It never deletes the original as a rename fallback. Filesystems
without the needed rename/hard-link support fail safely rather than using a
partially written destination. Basic modes/readonly attributes are preserved;
full ACL/xattr/ownership preservation is not claimed.

Failures before replacement retain the original. A failed temporary-file create
does not remove someone else's colliding file. Ordinary cleanup removes only the
temporary path created by that operation. Crashes can leave a `.forma-write-*.tmp`
file; those are not automatically restored or deleted on startup.

On Unix the containing directory is synced after commit. A postcommit directory
sync failure returns success with the new hash and a visible `warning`, because
the replacement has already happened. Treating that result as a failed save
would leave main using a stale hash. Windows has no equivalent directory flush
in the std-only implementation; crash durability there needs target-OS testing.

Hash checks detect external changes observed before commit, including changes
during temporary writing. The final check and rename are not an OS-wide atomic
compare-and-swap: an unrelated writer can race that narrow interval. Multiple
sidecars are not a distributed editing system. Do not claim external-edit
conflicts are impossible or promise power-loss guarantees for every filesystem.

## Recovery behavior

Snapshots use the same bounded, synced atomic persistence. Lists show valid
snapshots and separately report corrupt snapshots; corruption is not disguised
as an empty list. Recovery documents and stored hashes/metadata are revalidated
before returning them. A corrupt existing snapshot is never silently overwritten.

Restore means returning the selected snapshot to the editor as an unsaved copy.
It never replaces the original file. The user chooses a Save As destination.
Reading a snapshot and saving an original do not delete the recovery snapshot.
Main calls `recovery.remove` only after successful save or explicit discard, and
must ensure a delayed cleanup cannot delete a newer session's unsaved work.

## Verification scope

Native tests cover schema/metadata compatibility, schema-6 local modes, Unicode
paths, 17 MiB documents, over-limit files/documents, malformed data, repeated saves,
stale hashes, create collisions, symlink/readonly rejection on Unix, isolated
recovery restart/tampering/capacity, protocol errors, and actual child-process
stdio. Deterministic fault injection checks precommit failure preservation,
mid-write external modification, and postcommit directory-sync warning behavior.

Linux native tests do not constitute macOS/Windows execution, real disk-full or
power-loss testing, target filesystem/antivirus acceptance, Electron GUI testing,
installer signing, or native IME/GPU acceptance. Those remain release gates.


## Tokio admission and lifecycle contract

- There is one parsing job at a time, one executing blocking job, and an explicit
  FIFO. Admission allows at most eight queued/running jobs and a resource-aware aggregate
  admitted request wire bytes. `BUSY` means no operation started. It is not a
  request to blindly retry a write.
- Input staging separately allows one channel frame and one parser/reader frame,
  each at most the resource-aware complete-transfer allowance. One response uses bounded 1 MiB chunks when it exceeds a fixed frame. These are
  wire-byte bounds, not a claim of a 64 MiB total RSS cap: parsed JSON, kernel
  validation, file buffers and SQLite require additional bounded working memory.
- Main configures two Tokio scheduler threads and at most three Tokio blocking
  threads. The actual work semaphore permit moves into the blocking closure;
  cancellation of its waiter cannot release capacity while work still runs.
  SQLx uses one SQLite connection with a two-second busy timeout. SQLite has its
  own single-connection worker, with calls submitted serially by the bounded job.
- `cancel {requestId}` returns `{requestId,cancelled,running}`. A queued target is
  removed and receives `CANCELLED`; the cancellation acknowledgement has
  `cancelled:true,running:false`. A running atomic save is not aborted; its ack has
  `cancelled:false,running:true`, and its original result remains authoritative.
  Running scans receive a cooperative cancellation flag, checked during traversal
  and before database commit. The original scan result decides whether it was
  cancelled or already committed. Unknown/completed IDs return both flags false.
- `health {}` bypasses queued filesystem work and also returns `catalogVersion:1`,
  `maxPendingRequests:8`, and `maxPendingBytes:67108864`. Large input already being
  parsed and stdout backpressure can still delay control responses; this is not
  a real-time latency guarantee.
- EOF drains already accepted jobs. Transport failure drops unstarted jobs,
  signals scans, cooperatively stops the reader, joins its current parser and
  joins any running mutation. It never reports a committed save as rolled back.
  Process termination/crash is not graceful cancellation. Tokio's OS stdin helper
  itself cannot cancel a blocked read, so after processing jobs have joined the
  top-level runtime has a one-second shutdown timeout for that helper.
- Output honors async write/flush backpressure. There is no automatic retry of
  save, recovery mutation, catalog transaction, or any other write.

## SQLite metadata and native directory grants

The CLI accepts `--catalog-db` after `--recovery-dir`. For legacy main-process
invocations it defaults to `catalog-v1.sqlite3` in the recovery directory's parent.
Only main chooses either app-owned path. Newly created SQLite files use mode 0600
on Unix. Database inputs over 32 MiB are refused; supported databases have a
32 MiB page limit. There is no cloud tenant/RBAC model in this single-user catalog;
OS permissions, Electron sandbox and native grant checks still apply.

| Method | Params | Result |
| --- | --- | --- |
| `catalog.list` | `{}` | `{projects,directories,files,requiresReselection:true}` |
| `catalog.register` | `{path,name?}` | `{project,directory}` |
| `catalog.scan` | `{directoryId,path}` | `{directoryId,files,truncated}` |
| `cancel` | `{requestId}` | `{requestId,cancelled,running}` |

A project is `{id,name,updatedAt}`. A directory is
`{id,projectId,path,updatedAt}`. An indexed file is
`{id,directoryId,relativePath,size,modifiedAt,indexedAt,lastOpenedAt}`. Timestamps are
Unix milliseconds. `lastOpenedAt` is zero until an indexed file is opened/saved;
rescan preserves it. IDs are stable hashes of registered paths (not capabilities
or secrets). These trusted-main responses contain native paths; main must strip
paths and replace authority with opaque session handles before renderer IPC.

There are at most 32 directory/project registrations, one project per selected
root, and 512 indexed files per root. Project names are 1–256 bytes, root paths at
most 32 KiB and 64 ancestor components, indexed filenames at most 1024 bytes. Scans are nonrecursive,
metadata-only, visit at most 2048 entries, and skip symlinks/nonregular files.
`truncated:true` explicitly means a partial snapshot, not a complete directory
listing. Missing/renamed files disappear on the next scan; renamed files acquire
new path-based IDs. Renamed/missing roots remain visible metadata and require
native reselection. Repeated registration of the same path keeps IDs and can
update its display name. Reopened processes never restore access from rows.

Registration captures every ancestor's identity in memory. Scan and optional
`directoryId` on open/stat/save revalidate the selected root and its ancestors.
Catalog-origin file paths must be direct children. Reads recheck before exposing
content; saves recheck after validation and immediately before replacement, then
again after commit. Stale grants fail with `STALE_DIRECTORY`. A changed grant or
failed recent-metadata update after commit yields success with a warning rather
than a false rollback. Ordinary native file-dialog operations remain compatible.
This is detection-based defense, not race-free OS-wide directory-handle-relative
I/O against a hostile same-user process that swaps and restores ancestors. The
existing no-follow leaf protections and OS sandbox remain required. Windows and
macOS identity/durability branches require actual target-host verification.

Schema 1 uses `PRAGMA user_version`, a transactional initial migration, foreign
keys and a directory index. Startup runs `quick_check`, rejects future versions
and nonempty unversioned databases, and verifies required columns. It never
silently recreates, deletes or downgrades a corrupt/unsupported database. A scan
replaces its bounded metadata snapshot in one transaction; precommit failure or
cancellation rolls back. Portable document and recovery durability semantics are
independent of the metadata database.

## Current patch verification status

The added `catalog` and `runtime_lifecycle` integration binaries and runtime unit
cases cover migrations/reopen/reselection, corruption/future-version preservation,
SQL-trigger-injected rollback, scan limits, symlink/ancestor replacement, real
stdio EOF/cancel contracts, running-work permit retention, and deterministic
queue byte/count admission with health/cancel/EOF. Existing actual-stdio checks
now correlate replies by ID while preserving FIFO mutation/open assertions.

At implementation handoff these are source additions, not executed results.
Only the central validator may run the exact package/test selection above, after
source/dependency review and cohort approval. No GPU, simulated GPU, browser or
Electron GUI is invoked by these backend tests. Linux-only results cannot stand
in for native macOS/Windows or GUI acceptance.

### Degraded catalog startup

A corrupt, unsupported/future, oversized, inaccessible or otherwise unusable
metadata database disables only catalog operations. Main does not delete/reset
that database or exit the sidecar. Portable native-file-dialog open/stat/save and
recovery operations remain available, with their normal validation and durability
rules. Requests requiring a catalog directory grant fail closed.

`health` additionally returns `catalogAvailable`, `catalogError`, and
`fileRecoveryAvailable:true`. A ready catalog has `catalogAvailable:true` and
`catalogError:null`. In degraded mode `catalogAvailable:false` and `catalogError`
is an error object with code `CATALOG_UNAVAILABLE` and a fixed message containing
only an allowlisted reason code. Native paths, SQL text and raw SQLite/OS
exception messages are not included in that startup status. Catalog methods
return the same catalog-specific error; they never return a successful empty
catalog. `catalogVersion:1` is the supported protocol/schema capability, not
proof that this process has an available catalog. The state is fixed for the
process lifetime: after separately resolving the metadata problem, restart and
reselect directories. No destructive reset or automatic write retry is offered.

Actual stdio regressions cover malformed bytes, a valid future-schema database,
and an unusable catalog path, asserting both preserved input and successful
independent file save/open plus recovery write/read. These tests are added for
central execution; implementation alone does not establish a passing result.

The SQLite page budget is installed in SQLx's `after_connect` hook and its
returned effective value is checked on every connection, including replacements
for expired/closed connections. SQLite stores this setting in each pager and
initializes a new pager from its compile-time default; applying it once through
a pool is insufficient. If the existing database size prevents the requested
bound, that connection is refused without truncating data. The deterministic
`recycled_pool_connection_reinstalls_verified_page_budget` unit test closes the
active pool connection and checks the replacement, without a 30-minute wait.
See [SQLite maximum-page semantics](https://www.sqlite.org/pragma.html#pragma_max_page_count)
and [SQLite pager implementation](https://github.com/sqlite/sqlite/blob/master/src/pager.c).

Directory identity comparison paths and registration IDs use the same filesystem
canonicalization. In particular, Windows ordinary drive/UNC spelling and Rust's
verbatim canonical spelling must identify the same selected directory. This does
not remove prefix text as a substitute for filesystem checks: native identity
handles, per-ancestor checks and reparse rejection remain. The Windows-gated
`windows_plain_and_verbatim_directory_paths_share_grants_and_ids` regression must
be run on an actual Windows host; adding it is not Windows acceptance evidence.

## Resource-aware capacity update

The [maintained capacity contract](../../../docs/DOCUMENT_CAPACITY_V1.md) supersedes historical 32 MiB document and 4 GiB workspace quotas. Its explicit staging/queue accounting is separate from per-frame limits and is not a total RSS guarantee. Workspace schema 6 atomically migrates asset/reference tables without discarding durable history or retry receipts.
