# Electron SQLite read/write audit (2026-11-02)

The desktop workspace database stays in the Rust sidecar: one SQLx connection, WAL, `synchronous=FULL`, and `BEGIN IMMEDIATE`. This pass did not add a second store, a collaboration server, or a JavaScript SQLite engine.

## What was compared

Same shape of transaction the workspace uses: `BEGIN IMMEDIATE`, read the previous snapshot, update the head with a compare-and-swap, insert the new blob, `COMMIT`. Journal mode WAL and `synchronous=FULL`. Linux x86_64, Node 22.23.4. These timings are the engine only. They do not include document validation or the stdio protocol.

| Engine | 8 KiB update p50 | 1 MiB update p50 | 4 MiB update p50 | Durable host file |
| --- | ---: | ---: | ---: | --- |
| `node:sqlite` | 0.14 ms | 3.5 ms | 16.2 ms | yes |
| better-sqlite3 13.0.3, same thread | 0.15 ms | 2.5 ms | 14.3 ms | yes |
| better-sqlite3 in `worker_threads` | 0.22 ms | 4.4 ms | 17.5 ms | yes |
| sql.js 1.15.2 in memory | 0.28 ms | 2.3 ms | not measured | no |
| sql.js `export()` of the whole database | 0.46 ms | 11.7 ms | not measured | rewrite, not WAL |
| `@sqlite.org/sqlite-wasm` 3.54.1 | 0.10 ms | 1.6 ms | not measured | no |

`node:sqlite` stands in for the synchronous native class that better-sqlite3 also uses. On a 4 MiB blob the worker was slower than the same thread because the caller still waits and the payload is copied. sql.js does not create a host WAL file; persisting it means exporting the entire database. sqlite-wasm's Node build has no OPFS, so the database stayed transient and `synchronous=FULL` did not fsync a host file. That is faster because it is not the workspace durability contract.

`PRAGMA wal_autocheckpoint=0` lowered the raw 4 MiB `node:sqlite` update from 16.2 ms to 11.4 ms. A 32 MiB page cache did not. The checkpoint is left at 1000 pages. Turning it off would let the WAL grow for the life of the sidecar, and the structured-document cost below is not the checkpoint.

On the Electron main thread, a 4 MiB document object cost about 2.5 ms to parse, 5.1 ms to walk for the byte budget, and 10.2 ms to stringify. SQLite itself already runs in the sidecar process, so moving SQLite into the Electron process would not remove that hitch. This pass does not change that JSON path.

## Sidecar result

Both binaries were release builds with `CARGO_PROFILE_RELEASE_LTO=off` and `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16` (about 19.9 MB each). That is not the packaged ThinLTO profile. The candidate skips a second JSON decode of the previous head when this process already validated that revision, the encoded snapshot is between 32 KiB and 1 MiB, and the revision has no extracted font or image rows. The snapshot bytes are still read and hashed. A mismatch, a changed name, hash, deleted flag, or encoding, or any extracted asset, uses the original decode. WAL, `synchronous=FULL`, and the single connection are unchanged.

Warm `workspace.commit` over stdio, after create and warmup, idle back-to-back run:

| Workload | Baseline p50 (min–max) | Candidate p50 (min–max) |
| --- | --- | --- |
| 16 KiB padding | 0.73 ms (0.63–1.38) | 0.76 ms (0.67–1.66) |
| 256 KiB padding | 5.69 ms (4.65–7.33) | 4.40 ms (3.84–5.12) |
| 1 MiB padding | 18.1 ms (15.8–29.0) | 18.5 ms (18.0–25.2) |
| 4 MiB padding | 73.5 ms (61.9–82.2) | 67.1 ms (59.8–76.9) |
| 2000 rectangles | 23.2 ms (21.9–24.8) | 18.3 ms (17.9–23.7) |

A longer 2000-rectangle sample on the same binaries, 20 warm commits after 4 warmup commits: baseline p50 24.6 ms (p95 34.3, min 22.9) and candidate p50 18.2 ms (p95 24.2, min 16.6). Opens of that document stayed about 13.5 ms and 14.0 ms. The 16 KiB and 4 MiB rows stay on the original check and moved within the overlap of those short runs. The 1 MiB padding document is outside the 1 MiB snapshot window once the envelope is counted, so it also stays on the original check.

Repeating the 2000-rectangle pair on an earlier build of the same profile, before the upper size cap, was 23.8 ms to 18.1 ms with no overlap of the six-sample ranges. The cap does not apply to that 361 KiB document.

## Correctness

Release tests, same profile flags: workspace lifetime 4 passed, `tests/workspace.rs` 15 passed, `tests/workspace_assets.rs` 7 passed and 1 ignored size benchmark. A warm proof does not hide a replaced snapshot, a tampered name, a deleted flag, or a corrupted extracted asset. Historical `workspace.open` of an older revision does not replace the head proof. A restarted process validates the stored head once.

## Not claimed

This is not a 33 ms visible or 100 ms refinement result, and it is not full G2/G5. It does not change raster, tiles, budgets, or editor undo. SQLite close and reopen is not a power-loss proof. No collaboration server was added.
