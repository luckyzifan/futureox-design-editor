# Resource-aware document admission and desktop transport

The editable document does not have a fixed 32 MiB product quota. It still needs
finite resources. Desktop main samples available memory, physical memory and a
reported process/cgroup constraint once at startup, reserves half of that budget,
and pins the result across preload, codec/preparation workers, the Rust sidecar
and WASM. The wasm32 address space is an independent architectural ceiling, not
evidence that the machine has that much free memory. Unknown runtimes use a
conservative fallback and must not describe it as detected availability.

`CORE_DOCUMENT_MEMORY_BYTES` is trusted launch policy, not authored metadata or
an MCP/renderer operation. The host forwards its exact admitted value to owned
children so changing free RAM cannot change limits halfway through an edit/save.
A serialized-document allowance of one sixteenth of this working budget leaves
headroom for simultaneous JSON, native model, staging and history representations.
This factor is a heuristic, not a measured RSS guarantee or protection against
all concurrent system memory pressure. The user can still encounter a clear,
non-mutating resource refusal on a constrained machine.

## Private desktop wire protocol

Existing 64 MiB sidecar and 68 MiB preparation per-frame boundaries remain. A
larger admitted message is split into ordered envelopes containing at most 1 MiB
raw bytes encoded as canonical base64. Version, bounded transfer identity, exact
total and exact offset must agree on every chunk. One complete message is staged
at a time. Declared totals are checked against the trusted transfer allowance
before any payload growth; memory grows only for arriving admitted bytes. Empty,
replayed, reordered, interleaved, oversized and truncated transfers fail closed.
No mutation is dispatched until the complete request has passed normal parsing.

The full transfer allowance is twice the admitted document size plus a small
framing reserve, because preparation may carry escaped document JSON inside
another JSON string. Pending request count remains eight. Aggregate queued/running
wire reservations include expected large response sizes; they are not eight
independent document-sized allocations. Incoming parser/channel staging can own
two further complete transfer-sized payloads, plus the independently bounded
admitted queue. Response assembly, JSON objects and native models add memory
beyond those wire-byte accounting figures. Stdout writing observes backpressure.
The host preflights exact plain-JSON byte sizes before serializing sidecar requests
or cloning preparation arguments. One shared preparation ledger covers all codec
and preparation workers; the per-session count cap of 32 remains independent.
Closing a preparation worker rejects callers but retains its reservations until
the worker actually exits. Reply and send-failure paths release each lease once.

Existing timeouts retire the owned process and clear partial host assemblies.
EOF or malformed partial transfer never publishes that request. Queued
cancellation can prevent execution; a running atomic write can already have
committed. A missing reply therefore remains an uncertain outcome, not rollback.
There are no automatic write retries. Exact workspace mutation identities retain
their durable retry-receipt semantics.

These envelopes are private desktop transport only. MCP request/response frame
limits, external archive expansion checks, clipboard, raster/GPU packet and
optional opaque metadata budgets remain separate boundaries.

## Persistence

Native FD open/save, recovery and workspace reconstruction use the same pinned
resource admission. File replacement still writes and syncs a same-directory
temporary, checks the previous hash again and atomically replaces or creates the
target. Hash comparisons stream bounded chunks instead of materializing another
complete file. A post-commit directory-sync warning is not a failed save.

Workspace schema 6 removes the old 32 MiB asset-column constraint by copying the
asset/reference tables inside `BEGIN IMMEDIATE`, preserving bytes, hashes,
references, revisions and durable receipts. Declared asset lengths must equal the
stored BLOB length. Failed migration leaves the prior database transaction intact.
Snapshot/resource reads bind the current admitted limit before materializing a
BLOB; a larger stored document on a smaller machine is not silently truncated.
The artificial 4 GiB database page quota is removed. SQLite representability,
filesystem capacity/errors, WAL, `synchronous=FULL`, CAS and atomic transactions
remain authoritative. This is not power-loss, filesystem-failure or whole-app
commercial acceptance evidence; see the exact test record for exercised gates.

## Deployment and rollback precautions

This change is a database migration, not only an executable replacement. Before
applying it to a real profile, close every app instance and owned sidecar, then
make a verified SQLite-consistent backup of the workspace and its recovery data.
Use SQLite's backup API/tool on a quiescent database, or retain the entire closed
profile together with any `-wal` and `-shm` companions. Copying only an active
`.sqlite3` file is not a consistent backup. Keep the original backup immutable and
verify a separate copy can reopen before proceeding. Do not delete journals or
manually lower `user_version`.

Migration errors roll back the enclosing transaction; preserve the failed source
and its diagnostic, and reopen only after the actual fault (for example disk
capacity or corrupt stored asset metadata) is understood. The application must
not silently repair authored bytes, delete the workspace or retry a destructive
schema conversion. Successful reopening at schema 6 is idempotent.

Rolling back the code alone does not make schema 6 or newly created documents
above the prior 32 MiB limit readable by an older app. Before any rollback, close
the new app and preserve a second consistent backup containing all post-upgrade
edits, revisions and receipts. Restore a pre-upgrade backup only into a separate
profile/location for the old app; never overwrite the current database. That
older backup will not contain subsequent edits. Keep the current schema-6 data
available to a compatible build, and export/verify any newer documents with that
build before considering a supported transfer. There is no automatic destructive
database downgrade or promise that large new documents fit an older version.
