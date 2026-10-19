# Large-document preparation ownership verification

Base checkout: `71d3215`. This increment changes prepared-cache ownership only; no shaders, sampling, curves, fonts, effect algorithms, precision limits, or viewport admission policies change.

## Implementation

`design-studio/crates/design-kernel/src/gpu.rs`: when a retained geometry map is incomplete after a translation, move its Arc into the compiler instead of cloning the Arc and immediately triggering a full HashMap copy in `Arc::make_mut`. Complete read-only hits still share the map. A real live reader still causes copy-on-write. Failed preparation leaves the cache incomplete and forces a correct retry against the original wider guard.

## Executed checks

- Full native CPU kernel package: **1,172 passed, 0 failed, 0 ignored** (453 library tests plus integration tests). `kernel-suite.log` contains all groups.
- Three new actual-engine regressions each load 3,500 nodes: retained map allocation across fractional translations with exact packet equality to a fresh engine (analytic and figmaSubpixel); preservation of a live shared reader; two real composed-transform precision failures followed by recovery and fresh packet equality.
- Negative control: before the ownership fix, the 3,500-node regression passed fresh packet equality then failed the map-allocation assertion: the 3,499 unchanged records were copied. See `negative-control.log`. That first control fixture used rounded/stroked nodes. Final correctness fixtures use stroked rectangles with the same ownership assertion.
- `git diff --check` passed for the changed production file.

## Paired measurements

Actual native transform plus exact regional scene compilation; no GPU rendering or presentation timing. Both binaries use Cargo `desktop-dev` (optimized at level 1), the same source fixture and final request sequence. Each run warms five batches then measures 31 batches of four iterations. The final clean series runs baseline, fixed, fixed, baseline; pooled values below contain 62 batch-average samples per variant and scene size. Shared cloud-host variation remains; these are not FPS or release-build claims.

| Nodes | Baseline median | Fixed median | Median reduction | Baseline p95 | Fixed p95 |
|---:|---:|---:|---:|---:|---:|
| 3,500 | 32.50 ms | 26.08 ms | 19.8% | 54.48 ms | 31.42 ms |
| 10,000 | 56.64 ms | 45.62 ms | 19.5% | 68.44 ms | 56.20 ms |

Every clean run has identical fixture SHA-256, complete compiled-packet SHA-256, packet size, and compiler/cache counters. Prepared-node counts are 3,500 and 10,000 respectively. Each benchmark binary also independently asserts its complete packet equals a freshly loaded engine. See `comparison.json` and `*-clean-*.json` for all samples and hashes.

Earlier `before.json`, `after.json`, and `*-repeat-*.json` runs overlapped compilation and are retained for transparency, excluded from the headline measurements. An initial all-rounded 10,000-node fixture exceeded the existing scene-path budget; `initial-curved-fixture-build.log` records that error. The final timed fixture uses stroked rectangles for both binaries; no budget or quality settings were relaxed.

## Reproduction

```sh
source /workspace/shared/design-phase2/rust-env.sh
cd /tmp
cargo test --offline --manifest-path /workspace/shared/design-latest-20261019T1209/design-studio/Cargo.toml -p futureox-design-kernel --profile desktop-dev
cargo run --offline --manifest-path /workspace/shared/design-latest-20261019T1209/design-studio/Cargo.toml -p futureox-design-kernel --profile desktop-dev --example benchmark_prepare_reuse
```

The before/after native binaries were preserved outside the checkout under `/workspace/shared/design-latest-native-baseline/`; SHA-256 identities are recorded alongside the logs. Rebuild WASM and desktop preparation binaries to ship the change. The parent performed those rebuilds after the production source was frozen. Actual browser/Electron GPU frames and end-to-end interaction latency remain unverified in this environment.
