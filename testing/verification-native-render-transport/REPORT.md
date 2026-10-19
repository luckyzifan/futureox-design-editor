# Native render FRB1: explicit opt-in transport improvement

## Result and scope

Added a backward-compatible, separately opt-in binary reply protocol for the active desktop native-render bridge. The default remains JSON lines; default canvas/backend selection is unchanged. Set `CORE_NATIVE_RENDER_PROTOCOL=frb1` to select FRB1 on an already selected native-render session. Unknown protocol versions fail closed rather than silently downgrading.

This path is currently used by the explicit native-render probe/stats bridge; it is not the default canvas's per-frame pipeline. The measurements below establish CPU transport savings, not a native GPU or overall editor FPS improvement.

The active path is `design-gpu/src/main.rs` → `design-desktop/src/native-render.mjs` → Electron invoke → `native-render-session.ts`. FRB1 writes the existing RGBA vector directly after small versioned metadata. The renderer consumes an explicit typed array instead of running the legacy base64/atob/Uint8Array.from conversion. Electron invoke still clones the bytes. No main/preload rewrite, GPU shader/geometry/color/readback/lifetime change, preparation/FPR1 allocator change, or GPU resource pooling is included.

The wire format, caps, identity, cancellation, ownership and compatibility contract are documented in `PROTOCOL.md`.

## Initial verification

The original measurements and logs below are retained. The later [independent review addendum](REVIEW_ADDENDUM.md) records strict decoder corrections, current-source reruns, and the superseding negative-control result.

- 30 desktop tests passed, zero failures/skips: byte-exact fragmented decode, every small split/UTF-8 split, exact 48 MiB boundary, safe tight backing allocation, excessive fragmentation, unknown protocol/encoding, metadata/dimension corruption, request/session identities, FIFO, errors, budgets, deadlines, backpressure, partial-response cancellation, owner destruction/navigation, and close-after-final-stdout behavior.
- A real Node Worker transfers the decoded buffer and detaches the sender; repeated decode remains independently owned. This is Node transfer evidence, not Electron zero-copy evidence.
- The actual production Rust codec and active Node parser communicate over real OS stdio with synthetic 1px, 96×64, 513×257 and 4K frames. Every RGBA byte, dimensions and stats match legacy.
- The complete same-source `design-render` binary builds successfully. Its real `--backend cpu` execution produces byte-identical legacy/FRB1 rendered pixels across repeated frames, pan, dimensions and reload. Non-timing stats match exactly. Invalid options remain recoverable. Unknown protocol is rejected before adapter/device initialization.
- 5 production codec Rust tests pass inside the complete `design-render` bin test target, including legacy output byte equality, scoped control/error replies, invalid sizes/identity, short writes and broken-pipe propagation. The same five tests also pass in a minimal separately compiled codec target.
- 2 client Vitest tests pass for legacy/binary exact bytes and invalid encoding/dimensions.
- Full frontend TypeScript checking passed on the final run (`typecheck-final.log`, empty with successful exit). The first run exposed concurrent unrelated automation-test type errors, preserved in `typecheck.log`; those were subsequently corrected by their owner.
- The original deliberately corrupted-pixel run did catch a small-frame assertion mismatch, but its runner also accepted an out-of-memory abort. Its reported PASS is superseded by the corrected bounded negative-control run in `review-negative-control.log`; see the independent review addendum.
- Node syntax checks and focused `git diff --check` passed for the original source. `source-manifest.json` records those original source/fixture hashes. They precede the independent review's decoder hardening and are not all the final-code hashes; current hashes and a fresh CPU transport benchmark are in `review-source-manifest.json` and `review-production-benchmark.json`.

## Production CPU transport measurements

Linux, Node v24.19.0. 31 measured pairs per size after three warm-up pairs, alternating JSON/FRB1 order, forced GC before each sample; byte equality is checked outside the timed region. The codec fixture executes production Rust encoding, generates identical synthetic pixels, writes real stdio, and uses the active Node receiver. The result is structured-cloned and decoded by the actual production client pixel decoder.

The first small-frame measurements overlapped the final 1.7 seconds of the complete binary build. The machine was shared with other development tasks, so these are observed timings, not isolated hardware limits. No GPU rendering, actual Electron IPC, browser, or FPS measurement occurred.

| Dimensions | JSON total median / p95 | FRB1 total median / p95 | JSON stdio+encode+parse median | FRB1 stdio+encode+parse median |
|---|---:|---:|---:|---:|
| 96×64 | 2.941 / 4.072 ms | 0.494 / 1.092 ms | 0.588 ms | 0.462 ms |
| 512×512 | 95.544 / 113.822 ms | 3.570 / 14.158 ms | 9.226 ms | 2.975 ms |
| 1920×1080 | 752.397 / 881.463 ms | 22.583 / 32.488 ms | 69.894 ms | 16.462 ms |
| 3840×2160 | 3242.798 / 4278.716 ms | 99.153 / 120.468 ms | 295.968 ms | 55.304 ms |

Much of the old-path cost comes from the existing `Uint8Array.from(atob(...), callback)` conversion; the benchmark intentionally retains that real behavior. These large numbers are not GPU render times. At 4K, the raw pixel payload is 33,177,600 bytes instead of 44,236,800 base64 characters, before small metadata: 25% less pixel-wire data.

Not every substage's initial p95 improved: at 512×512, stdio+encode+parse p95 was 12.801 ms JSON versus 13.832 ms FRB1, although total p95 improved substantially. A separate 101-pair 512×512 repetition with no concurrent job started by this worker showed total median/p95 91.401/109.523 → 3.196/6.503 ms; stdio+encode+parse p95 14.268 → 5.399 ms. This supports the overall CPU transport gain but does not establish a universal tail-latency guarantee.

`production-benchmark.json` and `production-repeat-512.json` contain raw samples, stage timings, methodology and exact production-source hashes. The earlier `candidate-benchmark.json` is separately labeled synthetic JavaScript-only candidate evidence; it is not the shipping-path benchmark.

## Rust encode isolation

`rust-encode-repeat.json` contains 101 measured samples per size after five warm-ups, alternating order, for the actual Rust codec writing to a sink. Pixel construction/cloning is outside that timing. At 4K, median/p95 encoding was 119.429/156.653 ms for JSON versus 0.008933/0.011668 ms for FRB1 metadata and sink writes. The raw payload is not copied into a sink, so these numbers intentionally exclude pipe I/O, raw-byte transfer, rendering, and downstream decode. They are not an end-to-end latency claim; the real-stdio measurements above include byte transfer.

`rust-encode-benchmark.json` preserves the initial encode-only run, which overlapped scoped tests; the sequential repetition is the reported result.

## Limits and deferred ideas

Native GPU execution, GPU readback, actual Electron invoke/context-bridge behavior, GUI/browser behavior, device loss, Windows/macOS and OS packaging were not run. The same GPU readback remains in the production code; FRB1 starts after it. An older renderer binary lacking `--serve-protocol` fails safely when explicitly selected; rebuild the native binary with the source before using FRB1.

GPU staging/upload resource pools and persistent curve residency remain unimplemented/unverified ideas. They require actual device/fence/cancellation/lifetime/memory-ledger tests and GPU measurements. No benefit from them is claimed.

## Reproduction

Run from the checkout root with the existing authorized Rust toolchain environment:

```sh
# Build and test complete binary; no GPU invocation.
cargo test --locked --manifest-path design-studio/Cargo.toml -p futureox-design-gpu --bin design-render serve_protocol::tests
cargo build --locked --manifest-path design-studio/Cargo.toml -p futureox-design-gpu --bin design-render

# Optional minimal fixture build, using already compiled local serde/base64 dependencies.
bash testing/verification-native-render-transport/build-codec-fixture.sh
DESIGN_RENDER_BINARY=/path/to/same-source/design-render \
DESIGN_RENDER_CODEC_FIXTURE="$PWD/testing/verification-native-render-transport/rust-codec-fixture" \
node --test frontend/design-desktop/test/native-render*.test.mjs frontend/design-desktop/test/runtime/native-render*.test.mjs
(cd frontend/design-client && node node_modules/vitest/vitest.mjs run src/kernel/native-render-session.test.ts && node node_modules/typescript/bin/tsc --noEmit)
node testing/verification-native-render-transport/negative-control.mjs
node --expose-gc testing/verification-native-render-transport/benchmark-production.mjs
SIZE=512x512 SAMPLES=101 OUTFILE=production-repeat-512.json node --expose-gc testing/verification-native-render-transport/benchmark-production.mjs
```

Initial offline complete compilation was blocked by uncached `arrayvec`; the ordinary official-registry dependency fetch subsequently succeeded through standard tooling. No proxy, permission bypass, GPU fallback, or alternative denied execution route was used. The initial offline error is transcribed from the observed tool output in `initial-offline-build.log`; the subsequent complete build/test logs are retained.
