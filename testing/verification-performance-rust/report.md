# Rust preparation invalidation: scope and evidence

## Change

Production changes are limited to `design-studio/crates/design-kernel/src/gpu.rs`. The previously delivered partial-prepare ownership/COW fix remains intact. No GPU shader, sampling, filter, precision, effect, geometry, or color math was changed.

- Camera geometry invalidation removes exact dirty IDs instead of scanning the whole retained map. Existing dirty-set construction still includes affected ancestors and descendants. `Arc::make_mut` retains snapshot-reader isolation.
- Program invalidation removes only affected node buckets and their exact indexed FIFO entries. A BTreeMap indexes FIFO order, so deletion is O(log n) per removed program and leaves no tombstones.
- Live byte/count accounting is maintained incrementally. Cache statistics no longer scan all nodes for the entry count.
- Duplicate-key replacement retires the old entry and FIFO record before admission. At u64 sequence exhaustion, live records are reindexed in the same FIFO order without discarding programs.
- Existing 32 MiB program-cache allowance and camera residency limits are unchanged. FIFO records have exactly one entry per live program, including after 5,000 invalidate/reinsert cycles.

## Source and binary provenance

The baseline production gpu.rs captured before editing matches the phase start manifest SHA256 `04c7a93a7b0106af7e1855e35bb8ff872041d367221beb8263a4eb96da5ec453`. All other kernel source files matched that manifest during both A/B builds. `source-runtime-manifest.json` records source and immutable old/new binary hashes. Baseline binaries and raw timing samples are retained outside this published evidence directory.

The new benchmark source is `design-studio/crates/design-kernel/examples/benchmark_prepare_invalidation.rs`. Both old and new binaries used the identical benchmark source and the established Rust 1.96.0 desktop-dev profile. They were built sequentially with --locked --offline, shared target directory, and two build jobs. No GPU or browser was used.

## Timing interpretation

The optimization removes whole-cache invalidation work. It does not establish a general frame-rate, first-load, or camera-throughput improvement.

A later scheduling reconciliation found unrelated work during two timing runs. All raw runs are preserved:

- Exclude `new-1.json`: pre-existing Vitest work overlapped its early stages.
- Exclude `old-2.json`: packaging checker subprocesses ran 13:51:11–13:51:19.721 UTC.
- Retain `old-1.json` → `new-2.json` as one verified quiet sequential pair (31 steady-state batch samples per phase per variant, four operations per sample).
- `new-3.json` is a separate quiet new-code replication, not a second balanced old/new pair.
- `comparison.json` is explicitly marked superseded. Use `comparison-clean.json`.

Clean-pair p50 milliseconds:

| Nodes | Phase | Old | New | New replication |
|---:|---|---:|---:|---:|
| 3,000 | Transform/cache invalidation | 1.8365 | 0.1508 | 0.1985 |
| 3,000 | Compilation after transform | 17.6477 | 18.8356 | 21.7507 |
| 3,000 | Transform + compilation | 19.4382 | 18.9844 | 21.9655 |
| 3,000 | First compilation | 59.6774 | 50.2882 | 50.1921 |
| 3,000 | Rapid camera cycle | 21.9835 | 23.7201 | 22.1623 |
| 10,000 | Transform/cache invalidation | 6.5327 | 0.9880 | 0.6426 |
| 10,000 | Compilation after transform | 43.3417 | 45.1562 | 43.2176 |
| 10,000 | Transform + compilation | 50.2336 | 46.4108 | 43.9264 |
| 10,000 | First compilation | 138.5129 | 154.7258 | 132.4426 |
| 10,000 | Rapid camera cycle | 283.0093 | 279.2574 | 269.1154 |

The clean pair observes ~91.8% / 84.9% lower transform invalidation time at 3,000 / 10,000 nodes. The isolated cache-only invalidation/reinsertion microbenchmark (31 batches of 32 measured operations after warmup) observes 0.321930 → 0.000336 ms at 3,000 and 1.213768 → 0.000354 ms at 10,000. This is bookkeeping only, not frame rendering.

Tradeoffs are disclosed: the clean pair's compilation-only p50 is 6.7% / 4.2% higher; the 10,000-node first compile is 11.7% higher in that pair but 4.4% below old in the replication. The unchanged document-load control also varies materially. Therefore these end-to-end timings are observational and do not support a broad startup/camera/FPS claim. The 3,000-node total is effectively variable/flat across runs; 10,000-node total is lower in both new observations.

## Exact-output and regression evidence

- Every timing run independently compares the complete serialized GPU packet to a fresh engine after translation and after each of four exact camera views. Setup, hashing, and equality checks are outside timing windows.
- Full packet bytes and SHA256 match old/new at both node counts:
  - 3,000: `846ce748686ab6a85cb86cccd7f3121241e7fb0a83be3e527b4d8e21ccb7b641`
  - 10,000: `5e2ea991b2359a7d28b8a389a54c953f38ef00670f1bb862df34449b82f6914c`
- The new duplicate-key accounting test executes and fails on the preserved old production implementation: old bytes 1096 versus expected 556, exit 101. It passes on the new implementation. This is a cache-invariant regression demonstration, not a claim that a previously reported user-visible defect was reproduced.
- Six new cache correctness tests pass: replacement accounting/FIFO count, dirty-only node removal with live readers, 5,000-cycle bounded storage, eviction/reinsertion order, oversized-program admission, and u64 serial rollover.
- All four existing incremental preparation tests pass: large-map exact-packet equivalence, live COW readers, repeated failed rebuild recovery, and parent/child translation behavior with immutable unaffected geometry.
- A new integration test compares complete packets and actual CPU RGBA bytes against fresh engines for 24 parent/child translation states across managed/unmanaged color and analytic/figmaSubpixel profiles, with clipped rounded geometry, strokes, and shadow. Its final execution is recorded with the complete suite below.

## Final integration

Final source was rebuilt and verified:

- Kernel: 1,185 passed, 0 failed, 1 ignored cache microbenchmark. The ignored benchmark was separately run on preserved old/new binaries.
- Backend: 83 passed, 0 failed, 1 existing explicitly ignored full-CJK-font size/time benchmark. That unrelated benchmark was not run.
- The new 24-state complete-packet/CPU-RGBA integration oracle passed.
- Native preparation and portable WASM use the established desktop-dev profile; backend uses the established dev profile. All builds used the same final kernel source. WASM has no experimental SIMD or wasm-opt pass.
- Native preparation SHA256: e96ceab70be44597aa85200f7352c4b2131efdadf5cfc9a7d47af90eafd75ba5.
- Generated/public WASM SHA256: e002c8fe2efc46b09fed04bbc21404c5b7bdfb773e12081c41cfc004c824ea1b (39,289,919 bytes; both copies equal).
- Backend SHA256: 3f1e93319cb0e4022071592c04ef70783f1a489547b7726ca9833e5b0a5fd624.

No GPU execution or GPU pixel capture is claimed.


## Reproduction commands

Use Rust/Cargo 1.96.0 and a populated offline dependency cache. Set REPO to the repository path and CARGO_TARGET_DIR to a writable build directory. Execute Cargo outside the checkout to avoid the repository registry override; every command uses an explicit manifest. Set CARGO_BUILD_JOBS=2 and CARGO_NET_OFFLINE=true. These commands do not launch a browser, GPU, or listening socket.

```sh
export REPO=/path/to/design
export CARGO_TARGET_DIR=/path/to/design-target
export CARGO_BUILD_JOBS=2 CARGO_NET_OFFLINE=true
cd /path/outside/repository
cargo build --locked --offline --manifest-path "$REPO/design-studio/Cargo.toml" -p futureox-design-kernel --profile desktop-dev --example benchmark_prepare_invalidation
"$CARGO_TARGET_DIR/desktop-dev/examples/benchmark_prepare_invalidation" > preparation-results.json
cargo test --locked --offline --manifest-path "$REPO/design-studio/Cargo.toml" -p futureox-design-kernel --profile desktop-dev --lib gpu::program_cache_invalidation_tests::benchmark_single_node_cache_invalidation -- --exact --ignored --nocapture
cargo test --locked --offline --manifest-path "$REPO/design-studio/Cargo.toml" -p futureox-design-kernel --profile desktop-dev -- --test-threads=2
cargo build --locked --offline --manifest-path "$REPO/design-studio/Cargo.toml" -p futureox-design-kernel --profile desktop-dev --bin design-prepare
python3 "$REPO/design-studio/scripts/build-web.py" --profile desktop-dev
cargo build --locked --offline --manifest-path "$REPO/design-studio/Cargo.toml" -p futureox-design-desktop-backend
cargo test --locked --offline --manifest-path "$REPO/design-studio/Cargo.toml" -p futureox-design-desktop-backend -- --test-threads=2
```

WASM additionally requires the installed wasm32-unknown-unknown target and wasm-bindgen 0.2.128. The build-web script receives offline policy through CARGO_NET_OFFLINE=true; it invokes locked Cargo without network access. It writes the generated and public WASM assets atomically.

For old/new timings, build the identical benchmark example in separate baseline/final source snapshots, preserve both binaries, and run sequentially while all other tests/builds are stopped. The baseline production gpu.rs SHA must match source-runtime-manifest.json. Timings include scene destruction but exclude fixture construction, input serialization, full packet serialization/hashing, and fresh-engine equality oracles. They do not measure GPU or presentation time.

For the negative control, apply negative-control.patch only to an isolated baseline snapshot matching the baseline GPU source hash. It appends the minimal regression test without changing production code. Run the exact test below: expected old result is one executed test failing with byte accounting 1096 versus 556 (exit101). The same test in final source passes.

```sh
cargo test --locked --offline --manifest-path "$REPO/design-studio/Cargo.toml" -p futureox-design-kernel --profile desktop-dev --lib gpu::program_cache_invalidation_tests::replacement_accounts_only_one_live_program_and_fifo_record -- --exact --nocapture
```

Verify the published evidence files from this directory with `sha256sum -c publication.sha256`.
