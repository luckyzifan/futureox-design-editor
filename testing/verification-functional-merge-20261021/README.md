# Functional cumulative package integration — 2026-10-21

The reviewed archive `futureox-design-functional-cumulative-clean-d2d-20261021T0116Z.zip` adds 123 paths: 67 modifications and 56 new files, including 53 test files. Its SHA-256 is recorded in [zip-review.json](zip-review.json).

The package was produced against `d2d04650f7850317abd2a780335809c0b0787fca`. Every affected path still matched its package **before** hash at integration into `2e5db09e10011dbe2603046341b72a14b0b43d27`, so the reviewed patch could be applied as a pure increment after `git apply --check`. All 123 resulting **after** hashes and non-executable modes matched. The package installer was not executed. Package prose was treated as source material, not permission to overwrite later work.

All 70 protected paths retained their current bytes. Fifteen already differed from the old package baseline, including the current renderer, progressive display, interaction and diagnostics changes. No kernel rendering files were included in this functional patch. [merge-manifest.json](merge-manifest.json) records the exact affected identities and preserved newer paths.

The increment contains shared editing commands, clipboard handling, shortcut profiles, independent-copy workspace import, bounded FIG archive/DEFLATE/Zstd decoding, and MCP protocol/resource lifetime work. The imported source and tests are maintained in their normal repository locations. This archive contains no Rust changes or dependency lockfile changes.

## Historical evidence and current regression

The `historical-*` files preserve the package author's manifest and qualified results. Its reported full run was 4,146 passing / 5 failing / 0 skipped; those results belong to the earlier package source and are **not** a new run against this merged application. The five historical failures are listed in [historical-known-failures.md](historical-known-failures.md). This review performed archive integrity, baseline reconstruction, patch application and content-identity checks only; it ran no product tests, builds or GPU workloads.

Those five hydration failures are historical, not current open failures: the first current-source client run passed all 23 `render-worker-image-hydration.test.ts` cases. The old CPU/mock GPU fixture lacked `releaseFilterBatch`, leading to fallback and secondary disposal assertions; commit `f2b581700cb6903d34efec219eca59686fe9fd8b` had already added that fixture method. The archived historical file is unchanged. This is worker-route/CPU-mock regression evidence, not actual GPU acceptance; see [the current client summary](client-regression-summary.json).

Current combined-source regression results must be recorded separately before reporting acceptance. Browser/Electron rendering, real Worker lifecycle, physical socket transport, native SQLite, and exact export/edit/undo gates remain distinct. Raw logs and generated artifacts are ignored here; the archive's gzip tree snapshots, machine-specific launch file, installer and old runner scripts are excluded.

## Current local MCP regression

The maintained workspace/MCP/release documents now describe the imported implementation: independent-copy create-only storage, inactive return handles, uncertainty/replay rules, legacy handshake and modern per-request protocol admission, and final-write revocation. The skill and development contract link this record. These documentation follow-ups intentionally update several imported document hashes after the exact merge checkpoint; `merge-manifest.json` describes the application step, not a later release artifact identity.

The local MCP checks ran serially on Node `v24.12.0` against stable MCP source/test/package identities. See [regression-summary.json](regression-summary.json) for commands, scoped SHA-256 file identities and results. No user bridge, user credentials or external service was contacted. The runner removes live bridge environment values and redacts fixture tokens and socket paths from ignored logs.

| Gate | Final result | Boundary |
| --- | --- | --- |
| `npm run check` | Exit 0 | MCP source syntax |
| `npm test` | 96 passed, 0 failed, 0 skipped | Production protocol/adapter, streams, subprocesses and deterministic test backends |
| `npm run test:integration` | 5 passed, 0 failed, 0 skipped | Real temporary Unix sockets and stdio CLI, deterministic bridge fixture |

These are three distinct gates; repeated runs are not additional passing tests. Official-SDK suites, real Electron/Editor/SQLite end-to-end behavior, external clients and other operating systems were not run by this MCP increment.

The first socket attempt failed all five cases because macOS's inherited temporary-directory spelling traversed `/var`, a symbolic link. Listening succeeded; production endpoint validation correctly rejected the symlink ancestor. [initial-attempt-summary.json](initial-attempt-summary.json) preserves that failed attempt and its 96 passing unit tests. The rerun supplies the **same OS temporary directory's canonical real path** as `TMPDIR`; it changes no product security check, test assertion or socket transport. That rerun passed all five integration cases. A local evidence-runner variable-shadowing error initially interrupted the canonical rerun after syntax checking; it was fixed before the recorded final run and was not a product test result.

Reproduce these MCP-only checks from the repository root:

```sh
python3 testing/verification-functional-merge-20261021/run-regression.py --canonical-temp
```

This command does not run the complete client, Rust, build or GPU regression. Those require separate current-source records.

## Current local desktop regression

[desktop-regression-summary.json](desktop-regression-summary.json) records a separate serial desktop run, using the existing release sidecar and native preparation binaries plus generated WASM. Their exact bytes were hashed before and after; no native/application rebuild was performed. Desktop inputs, actual source-directory entries and all 123 package target paths were stable for the final run. Unrelated in-progress kernel-renderer edits are outside this scoped identity.

| Gate | Final result | Boundary |
| --- | --- | --- |
| `npm test` in `frontend/design-desktop` | 297 passed, 0 failed, 0 skipped | All desktop Node test files, including mocks, real owned sockets/subprocesses, asset/staging fixtures and native SQLite tests |
| `npm run test:preparation` | 3 passed, 0 failed, 0 skipped | Actual native preparation host versus existing WASM packets, authored transform edits and CPU pixels; queued work, owned child retirement and missing-executable failure |
| Targeted package-staging tests | 3 passed, 0 failed, 0 skipped | A subset of the desktop total, not additive; real package script with the external Electron packager stubbed |

The SQLite test explicitly exercised MCP NDJSON in memory → production native workspace host → real Sidecar stdio → temporary SQLite, including close/reopen durability. Native confirmation callbacks were test doubles. Other desktop tests use mocked Electron IPC/windows and deterministic backends; they do not establish actual native dialogs or GUI behavior. The existing production-assets test performs a tiny temporary Vite fixture build; no application release build, Electron package, GUI or GPU was launched. The preparation binary/WASM comparison establishes its tested equality; existing binaries are not described as freshly rebuilt.

The initial desktop run was 295 passed / 1 failed / 0 skipped; [desktop-initial-attempt-summary.json](desktop-initial-attempt-summary.json) preserves it. The failing retired-pet packaging assertion found an untracked empty `src/pet/renderer/assets` directory that a plain recursive source copy would stage. The fix adds a shared source-copy filter excluding only the three already-retired paths (`pet/renderer`, `pet/controller.mjs`, `pet/preload.cjs`). It retains the current host/policy and unrelated resources and deletes no working-tree content. The original ENOENT assertions remain; a new reused-tree test verifies rejected retired files, exact retained bytes and preserved original user files. The actual package-script fixture uses the same helper. [desktop-package-targeted-summary.json](desktop-package-targeted-summary.json) records that targeted check; the full final desktop rerun above is green.

Reproduce the desktop gates without building or launching the app:

```sh
python3 testing/verification-functional-merge-20261021/run-desktop-regression.py --label final
```

Missing actual native inputs are recorded as blocked/skipped rather than replaced. These results do not cover every `test/runtime/` suite, the client full suite, Rust tests, other operating systems or Electron/GPU acceptance.

## Current local Rust workspace regression

The checked toolchain was Cargo/rustc `1.96.1`. From `design-studio`, `cargo test --workspace --locked --offline` finished with exit 0 in 677.383 seconds. [rust-regression-summary.json](rust-regression-summary.json) records source/toolchain/lock/vendor/fixture identities before and after, full test-group counts and ignored names. Those inputs stayed byte-identical; unrelated TypeScript renderer work is excluded from this scoped identity. No Rust implementation or assertions were changed.

Cargo reported **1,401 passed, 0 failed, 36 ignored**. One of those nominal passes, `actual_mcp_sample_noto_roundtrip`, returned early because its private `SKETCH_FONT_SAMPLE_FD` was unavailable. Its fixture assertions did not execute and it is **not** counted as accepted sample coverage: the evidence records **1,400 executed passes plus 1 unexercised sample**. The 36 ignored cases comprise 28 hardware GPU tests, 7 explicit large CPU regressions/benchmarks and 1 macOS collection-font acceptance test; none count as passing results. The existing dead-code warning for `over_rgba8_blend` was retained in the ignored raw log.

This run exercised real CPU/kernel/model/export behavior, owned native subprocesses, temporary SQLite and server input validation using workspace defaults. It ran offline and supplied no external service or PostgreSQL database. The `hardware-tests` feature was not enabled, no GPU adapter was acquired, and the ignored GPU suites establish no rendering or frame-rate acceptance. Large default CPU regressions, including adjacent export slices and texture fallback, completed without weakening assertions; total test time is not an import/render-performance benchmark.

Reproduce this workspace gate without launching the app:

```sh
python3 testing/verification-functional-merge-20261021/run-rust-regression.py
```

The runner records the unprovided private sample separately. Providing an actual authorized FD through `SKETCH_FONT_SAMPLE_FD` can exercise that specific test; no replacement sample or database was fabricated for this run. Rust results do not replace current client Vitest/Node, actual Electron/GPU, external-client or cross-platform acceptance.

## Current client regression: initial failures and corrected environment

[client-regression-summary.json](client-regression-summary.json) retains the client attempts separately. The initial full Vitest report was **4,544 passed / 15 failed / 12 skipped**, not a passing gate. Fourteen failures arose from missing explicitly required `fonttools==4.61.1`; one source-contract regex still expected owner invalidation immediately after `documentGeneration++`, omitting the intervening decoded-image-owner initialization. The regex was updated to match that actual initialization order; this assertion repair changed no product behavior. The required font dependency was explicitly installed into an isolated temporary virtual environment using `testing/font-fixtures-requirements.txt`, without modifying system Python or suppressing tests.

The full second Vitest attempt completed with **4,602 passed / 0 failed / 1 skipped**, all 616 Vitest-reported suites passing, exit 0 in 82.153 seconds. It used absolute Node `v24.12.0`, the pinned font dependency, canonical temporary paths, both actual user fixtures (117 Sketch and FIG), and the existing release native backend. All eleven previously optional native/corpus cases actually ran and passed; their names are listed in the compact summary. The full run's one skip was the separately opt-in historical `CANVAS_REPRO_ADD_PAGE` live-vertex/add-page reproducer. A subsequent `CANVAS_REPRO_ADD_PAGE=1` run selected that case and actually passed it: **1 passed, 0 failed, 37 other cases filtered by `-t`**. Together these cover all **4,603 unique cases** at this CPU checkpoint. The 37 filtered cases are not extra executions or new acceptance gaps; the original full-run skip remains accurately recorded. The 1,223-file full-run source identity stayed stable before/after: `dde3e8a3e26c47b22d8f979e24101ebe69ad4d05815a42ac3f0d738e2f3176b1`. The 23 hydration cases passed again. Initial and final totals describe their own source/configuration snapshots and are not added together.

The frontend Node contracts completed separately: the existing `testing/verify-local.mjs --suites frontend-contracts` harness ran 31 test files and **320 tests passed, 0 failed, 0 skipped** on Node `v24.12.0`. Two earlier launch attempts remain in the record: one rejected the experimental transform option before tests started; another selected Node `v26.0.0` through launch/cwd resolution and reported 113 passes / 13 failures from removed TypeScript transform mode and strip-only loader errors. The corrected run uses an absolute Node 24 executable and the existing TypeScript hook. Runtime selection was repaired without changing product assertions for those failures.

These Node tests cover CPU logic, mocked callbacks/DOM and source contracts; they do not launch Electron, exercise a real GPU or prove native-dialog behavior. Vitest, Node, native SQLite, actual Worker and Electron/GPU results remain separate gates and repeated/subset passes are not added to an aggregate total.

The full Vitest run includes real Editor/WASM, actual input corpora and native SQLite routes alongside pure logic and mocked DOM/GPU/Worker-protocol fixtures. It does not establish actual browser Worker startup/timeout/termination, Electron presentation or a physical GPU frame rate. Generated root `evidence/phase/` PNG output belongs to test artifacts; runtime images are not part of this source increment. Useful counts and report/source hashes are retained here while full raw JSON/logs remain ignored.

This full CPU checkpoint precedes later prototype renderer and narrow-pool changes. Their new targeted regression and real runtime results require separate records; the earlier source hash must not be presented as a full-suite check of those later edits. These functional results do not establish blur-free zoom or accepted Electron/GPU presentation.

## Additional named gates and fixed prerequisites

[additional-regression-summary.json](additional-regression-summary.json) preserves the initial six-gate attempt, corrected reruns and scoped source/native-binary hashes. These are named gates, not an added repository-wide total:

| Gate | Accepted result | Boundary |
| --- | --- | --- |
| Runner contracts | 30 passed, 0 failed, 0 skipped | Owned subprocess/timeout controls, fixture policy, shell contract fixtures and CI source checks |
| Python tools | 15 passed | Actual CPU reference-reporting/unit behavior with Pillow; no GPU or replaced references |
| Automation storage | 1 passed | Actual temporary SQLite and sidecar with mocked Electron IPC; overlaps the desktop Node gate |
| Bun policy scripts | 31 passed, 0 failed | CPU budget/scheduling policies; GPU names do not imply hardware execution |
| MCP example | 1 passed | Actual Editor/WASM through in-memory protocol, synthetic example output; no Electron/GPU |
| Native sidecar | 8 passed, 0 failed, 0 skipped | Actual owned Rust process, portable files and temporary SQLite/reopening; selected runtime files only |
| Additional MCP clipboard artifacts | 12 passed, 0 failed, 0 skipped | Exact artifact/resource framing and rejection cases; a separate test file outside `npm test`'s 96-case selection |

The initial runner gate had four failures because its temporary fixture expected `/var` while the shell used the physical `/private/var` cwd. The native storage fixture similarly passed a noncanonical parent that production admission correctly refused. Both fixtures now resolve only their own newly created directory with `realpath`; strict application path validation and all original assertions remain. The native test also positively checks actual workspace availability before storage assertions. The rerun retained the inherited macOS temporary spelling, so these fixture fixes were exercised rather than hidden by an environment-only normalization.

Python initially ran six tests and reported two module-import errors because Pillow was missing. `testing/python-tools-requirements.txt` now separately pins `Pillow==12.0.0` for CPU test tools; CI explicitly provisions it before the portable profile selects those tests, with positive and missing-prerequisite regression checks. Installation occurred only in the existing temporary virtual environment. Python `3.14.4` actually imported that Pillow build and all fifteen Python tool tests passed; no system or production dependency changed.

The second runner attempt exposed a different cold-start race: its 500 ms timeout killed the Node negative-control child before it installed its SIGTERM handler. Its bounded startup window is now 2,000 ms; the 100 ms kill grace, ready/ignored-signal assertions, required forced SIGKILL and five-second total retirement bound are unchanged. The final three-gate rerun passed with stable scoped source/native inputs in 3.939 seconds. The initial failures and this intermediate failure remain in ignored raw evidence and the compact summary. Already-passing independent gates were not rerun or counted again.

## Final combined CPU checkpoint

[final-cpu-summary.json](final-cpu-summary.json) records a later serial run after the optional 256–4096 MiB host budget chain, preview-policy forwarding, source pins and pool changes. It used absolute Node `v24.12.0`, Python `3.14.4` in the temporary environment, Pillow `12.0.0`, fonttools `4.61.1`, canonical temporary paths, both actual user fixtures and existing release native binaries. All eleven optional native/corpus cases and `CANVAS_REPRO_ADD_PAGE=1` were enabled together in the full run.

| Gate | Result |
| --- | --- |
| Full client Vitest | 4,646 passed, 0 failed, 0 skipped/todo; 617 suites passed |
| Full desktop Node | 304 passed, 0 failed, 0 skipped |
| Actual native preparation versus WASM | 3 passed, 0 failed, 0 skipped |
| Frontend Node contracts | 321 passed, 0 failed, 0 skipped |
| MCP syntax | Exit 0 |
| MCP default unit selection | 96 passed, 0 failed, 0 skipped |
| Additional MCP clipboard artifacts | 12 passed, 0 failed, 0 skipped |
| MCP real local socket/CLI fixture | 5 passed, 0 failed, 0 skipped |

All gates ran sequentially; the full Vitest used one worker and took 528.616 seconds. That correctness-run duration is not a rendering benchmark. Counts remain per-gate and are not summed. The corpus, actual SQLite/native and mocked DOM/GPU/Worker-protocol boundaries described above still apply. Neither this run nor the 4 GiB admission option proves blur-free zoom, white-block elimination, total application memory limits or physical GPU frame rate.

All 1,388 captured client/desktop/MCP source, script, test and package/config inputs stayed byte-identical: `b8a528b1dd1c1a05aa73a3874fc5ee030d4ada51dde908281fd753031c709697`. Existing WASM/native binary hashes and the original 117/FIG fixture hashes also matched before/after. The 923-input Rust aggregate still exactly matches the earlier workspace run (`a5bcf53f547665f2dea5effb3b960d9b417949cedb3b80157fa50e21bd1ae31f`), so the eleven-minute Rust test was not needlessly rerun. Its original 36 ignored tests and one unexercised private font sample remain explicitly qualified; this does not convert them into passes.

`run-final-cpu-regression.py` accepts actual absolute paths through `FINAL_CPU_NODE`, `FINAL_CPU_PYTHON`, `FINAL_CPU_SKETCH` and `FINAL_CPU_FIG`; it never searches private folders, installs dependencies or builds missing runtimes. Supply the tested Node 24.12 and the prepared Python environment, then choose a fresh `--label` to preserve earlier outputs. Later product changes must receive their own source identity and appropriate checks; actual 117/FIG fast-zoom presentation is a separate on-device gate.
