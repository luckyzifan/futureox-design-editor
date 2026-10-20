# Lifetime-cache increment integration

Archive SHA-256: `36f34b0668125e488a28d5d5dc1ff857985838b1272e61b526c13bbdb5031411`. Applied 21 changed paths over `00383f4`; all 573 manifest final states matched immediately after application. No unknown content, symlink or mode was overwritten. Archive documents were treated as supplied package metadata, not authority to run commands.

Independent source review found no definite lifecycle correctness regression in payload reservations, prefix retirement cohorts, loss/recovery, failed capture/readback cleanup or bitmap handoff. Cap 64→256 preserves the 32 MiB bound but does not remove first-use strip coordinate computation; real latency acceptance remains pending. Ledger queue observers are distinct from WebGpuDriver fence telemetry.

Local test repair: terminal-quality now imports the real ResidentPresenter and uses Vitest DEV/diagnostic controls, replacing source-string extraction and Node transform-mode execution. Initial verification exposed a missing declared jsdom dependency and a transform-mode runner incompatibility. Frozen-lockfile installation restored dependencies; the test repair retained the original no-fence and completion-coverage assertions. Final typecheck and 68 targeted Vitest suites / 407 tests passed, zero failures or skips. No Rust changes belong to this archive commit.

These tests use CPU/WASM and GPU descriptor mocks. Actual-device performance and pixel/interaction checks follow in the performance change; this integration does not declare the original five problem families fixed.
