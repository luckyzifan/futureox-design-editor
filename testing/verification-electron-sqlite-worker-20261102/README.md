# Electron SQLite worker — 2026-11-02

Desktop SQLite reads and writes no longer sit on a Tokio blocking thread, and large workspace document JSON is no longer parsed on the Electron main thread.

## What changed

- `workspace.*`, `automation.*`, and `catalog.list` run on one dedicated FIFO thread (`sqlite-io`). That thread drives the existing async SQLx calls. SQLite statements still run on the sqlx connection worker. The ordinary lane is still one turn at a time, and the large-source lane is unchanged.
- A SQLite wait does not take one of the four Tokio blocking slots. File preflight and frame parsing can use those slots while a commit is waiting on the database lock.
- WAL, `synchronous=FULL`, `BEGIN IMMEDIATE`, and one connection per workspace or catalog pool are unchanged.
- Electron keeps payloads under 32 KiB on the caller. At or above 32 KiB, commit framing (`JSON.parse`, admission walk, `JSON.stringify`) and open/restore response splitting run in `workspace-sqlite-worker.mjs`. The main thread forwards the finished bytes. Responses larger than the 64 MiB frame that arrive as `desktopChunk` lines are still assembled on the caller.

This does not change raster, tiles, budgets, or experimental render flags. It does not close the 33 ms visible or 100 ms refinement targets, and it is not full G2/G5 acceptance.

## Measurements

Host: Linux x86_64, debug Rust (`cargo test` profile, unoptimized), Node. One local run, not a production SLA.

### Blocking pool while SQLite waits

`runtime::tests::sqlite_wait_does_not_consume_a_blocking_slot` holds an external `BEGIN IMMEDIATE`, occupies three of the four blocking threads, and starts `workspace.commit` until it reports `running`. A new `spawn_blocking` task is then timed. The external lock is released only after that timing returns.

The probe entered its blocking thread in **0.032 ms**. The test fails if that start takes 150 ms or longer. If the commit itself held the fourth blocking slot for the busy wait, the probe could not start until the lock was released, which is after the 200 ms measurement window.

The same test reads the committed revision back as 2, so the wait still publishes one CAS revision.

### Electron main-thread document framing

`frontend/design-desktop/test/workspace-sqlite-worker.test.mjs`, 987,655-byte document JSON, three iterations. Inline work is parse, `assertDocumentSerialization`, and `JSON.stringify` on the caller. The worker path is the production codec.

| Path | Caller event-loop max gap | Wall time |
| --- | ---: | ---: |
| Inline | 101.508 ms | 101.044 ms |
| Worker | 0.630 ms | 119.193 ms |

The caller stall fell from 101.508 ms to 0.630 ms. Total framing time rose from 101.044 ms to 119.193 ms because the document string is copied to the worker. The benefit is main-thread responsiveness during save and open, not a lower CPU total.

## Checks run

- `cargo test -p futureox-design-desktop-backend --lib` — 102 passed, 11 ignored.
- `cargo test -p futureox-design-desktop-backend --test workspace --test automation --test catalog` — 15 + 13 + 7 passed.
- `node --test test/workspace-sqlite-worker.test.mjs test/sidecar.test.mjs` — passed (sidecar suite plus the three worker tests).
- `node --test test/main.test.mjs` — 62 passed.

Not run: packaged Electron GUI, hardware GPU, physical frame timing, full G2/G5.
