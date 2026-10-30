# Web support: bounded source fix and remaining large-source architecture

Baseline: f03197eddba5da8d6c53d4c9a655c0e007695b16. This is a source candidate, not a tested browser release or a 4 GiB browser implementation.

## Actual browser path

- The browser uses the same App, Editor/domain operations, Rust/WASM admission/layout/codecs, render workers, GPU/CPU handoff, authored model, undo/redo and export paths. It does not require a fabricated `window.coreDesktop` bridge. Electron-only source workspaces remain capability-guarded.
- `build-web.py` builds the real Rust kernel and generated bindings, then publishes the WASM asset. `vite.config.ts` verifies production public WASM identity. Main and worker initialization load the real same-origin `/kernel/design_kernel_bg.wasm`; fonts also use same-origin assets. Browser deployment currently assumes the origin-root asset/API routes, not an arbitrary subdirectory deployment contract.
- FIG/Sketch/PDF import uses a fresh owned module worker. Ordinary FD/JSON and SVG have different paths. The browser persists full admitted documents and up to 50 binary revision snapshots in IndexedDB; existing outbox/remote stores preserve the browser synchronization path.
- The 1 GiB encoded-input cap is business admission only. Decoded/expanded data, pinned document memory, Rust archive protections, image pixels, GPU/device budgets and export bounds remain independent. JSON/FD decoding still includes main-thread work. No unbounded or streaming normal document model is implemented here.
- The native large-document bridge is implemented by the desktop host/Rust backend. Its 4 GiB source indexing and source-preserving streaming export are not implemented in browser WASM/OPFS. The browser must not expose that native command with a fake bridge or market it as existing browser capacity.

## Candidate changes

### Owned selected-file reading

Previously `readDesignFile()` materialized the complete FIG/Sketch/PDF input with `file.arrayBuffer()` on the UI side before creating the worker. Superseding the import could reject adoption only after that read resolved; the 30-second worker deadline and worker termination did not own the pending read.

Now selected File objects are structured-cloned to the fresh worker without a transfer list. The worker rechecks input size before reading and checks actual byte count before decoding. A single existing 30-second worker lifetime now includes that file read. Failure retains read-stage attribution; cancel/timeout terminates the worker, rejects the request once and ignores late stage/success replies. ArrayBuffer callers retain the existing transfer-list route. Generic worker crashes or message-decoding failures remain unknown worker failures, not file-read failures just because a read was pending; explicit empty-message read rejections retain read attribution. Late failures cannot replace cancellation.

This removes an explicit UI-side whole-file ArrayBuffer allocation. It does not promise zero-copy browser internals, cancellable physical disk I/O, lower measured RSS, faster decode, or bounded decompression beyond the unchanged codec policy. Full input and decoded results still exist in worker/application memory. File reading is not streaming decoding, and a slow read can now consume the existing deadline before decode starts.

### History enumeration

Previously `listRevisions()` used `getAll()` to materialize and retain every binary snapshot before mapping to metadata. It now uses a document-scoped descending value cursor and accumulates only revision metadata. Errors reject instead of publishing partial history; connection close remains owned by the existing transaction helper. Revision ordering, retention, save atomicity, restore/CAS semantics, schema version and existing data are unchanged.

A value cursor still clones one full snapshot per step. No storage migration is included, and GC timing/browser internals prevent claiming an exact one-snapshot RSS ceiling. A future metadata index/store is a separate migration/recovery task.

## Required architecture before claiming browser large-source parity

1. Factor streaming source indexing, token/geometry parsing, immutable source descriptors, bounded projection and edit validation into reusable Rust domain code. Native filesystem access becomes a host adapter; TypeScript must not grow a second parser/mutation engine. The ordinary Editor and existing Rust semantics remain the only editable workset model.
2. Use a dedicated browser source worker with a Rust/WASM instance and a bounded request queue. Keep document ID, session epoch, source revision, root key/hash and operation ID on every command and response. Reject stale adoption after close, switch, cancellation, structural reindex or worker restart. Cancellation before commit and cancellation after durable commit must remain distinct.
3. Provide a real browser storage adapter around OPFS and bounded read/write chunks. JS handles browser I/O and ownership, not source semantics. Keep complete source bytes cold in storage and supply bounded slices to Rust; do not represent a 4 GiB source as one WASM allocation, JS string, JSON object or Blob assembled from all chunks. 64-bit source offsets require checked lossless protocol encoding independent of wasm32 pointers.
4. Journal immutable source chunks, sparse indexes, revision head and commit receipts with a documented recovery protocol. Do not assume atomic cross-API OPFS/IndexedDB transactions or filesystem rename semantics. Coordinate concurrent tabs/workers, orphan cleanup, disk-full, interrupted writes and recoverable previous head before advertising durable save. Eviction/quota failure must preserve the current in-memory workset and clearly report that storage did not commit.
5. Detect actual browser/worker/storage capabilities and available quota. Quota estimates are advisory; capability availability does not certify a 4 GiB document. Missing OPFS or storage permission must retain the ordinary editor and produce an explicit unsupported-large-source result, never a fake native implementation or silent fallback to whole-file memory.
6. Project bounded source worksets through the shared Rust admission/Editor/Canvas path. Preserve cold-source attributes, HDR/float precision, topology, undo/redo, dirty-input/close decisions and immutable export snapshots. Export must use a real bounded writable destination path, not concatenate the full source in memory.
7. Validate same-source JSON/Sketch parity with native adapters, inclusive byte boundaries, decompression bombs, stale keys/revisions, cancellation/late messages, quota/disk-full, tab contention, worker crash, reopen/recovery, export byte preservation and current document isolation. Actual browser worker/storage/pixel tests remain separate from source and mocked protocol tests.

## Verification status

Only static source inspection, patch construction, path/hash inventory and whitespace checks are permitted for this candidate. Added tests are not executed. No typecheck, project suite, Rust/WASM build, browser/GUI/GPU test, measured performance/RSS or durable browser persistence evidence is claimed. Experimental flags, render configuration, HDR/export precision, synchronization semantics, existing admission limits and device budgets are unchanged.

Suggested later checks, only in an authorized complete source/runtime environment:

- Frontend typecheck; focused `local-revisions.test.ts`, `local-store-revision-list.test.ts`, `import-file-worker.test.ts`, `import-worker-file-read.test.ts`, `import-input-policy.test.ts`, import diagnostics/capacity and ownership suites.
- Real browser File structured-clone, cancelled pending read, timeout, read failure and late-response isolation for FIG/Sketch/PDF; compatibility export and regular FD/JSON/SVG paths.
- Real IndexedDB existing-version data, 50-revision large-document listing, descending order, transaction failure, reopen, quota failure and restore CAS; compare allocation/retention without asserting an unmeasured RSS guarantee.
- Browser normal-editor edit/undo/redo/save/reopen/synchronization/export and existing HDR/device-loss gates. Desktop ordinary imports also use this shared importer and require regression coverage.
