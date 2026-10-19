# Native preparation transport: investigation, rejected allocator candidate, and regression coverage

## Shipping decision

**No production allocator change is shipped.** `frontend/design-desktop/src/preparation-frame.mjs` is restored byte-for-byte to the frozen starting source, SHA-256 `bbcf500336178f981d31f141878d78f9ef4da0cca0bcea4453089d549d25fc58`.

The candidate avoided redundant zero-filling before the final payload copy, using exactly sized unpooled storage for responses <=16 MiB. It passed correctness checks and improved small/medium-frame median decode time, but the median benefit was less than 1 ms and the measurements did not establish improved tail latency or end-to-end smoothness. Given the priority on consistent interaction latency, that evidence is insufficient to justify changing production allocation. This is a conservative rejection of an uncertain performance tradeoff, not a demonstrated correctness failure or proven allocator-caused tail regression.

The retained deliverables are implementation-independent correctness tests and diagnostic evidence. There is no wire-format, Electron IPC, ownership, method, ordering, cancellation, budget, shader, geometry, sampling, color, or rendering-effect change in this increment.

## Rejected candidate measurements

`candidate-frame-allocation.mjs` is explicitly marked **NOT SHIPPED** and is imported only by the diagnostic benchmark. `frame-baseline.mjs` matches production and the starting manifest. The benchmark alternates before/after and after/before pairs, with five warm-up pairs and 31 recorded pairs per payload size, reused 64-KiB chunks, and forced GC before every sample. Payload checks and transfer detachment are outside the timed decode region. The environment was shared Linux / Node 24.19.0.

The final candidate run (`compare-final-bounded.json`), which is not a result for shipped production code:

| Payload | Baseline median | Candidate median | Baseline p95 | Candidate p95 |
|---|---:|---:|---:|---:|
| 4 MiB | 0.662 ms | 0.514 ms | 0.904 ms | 0.782 ms |
| 16 MiB | 2.813 ms | 1.972 ms | 6.743 ms | 8.824 ms |
| 64 MiB, same allocator in both | 32.113 ms | 31.045 ms | 38.519 ms | 35.392 ms |
| 128 MiB, same allocator in both | 57.908 ms | 61.847 ms | 66.560 ms | 67.301 ms |

Three preceding all-size candidate runs also improved the 4/16-MiB medians; paired bootstrap intervals for median differences excluded zero at those sizes. Results at 64/128 MiB changed direction and every paired interval included zero, so the final candidate retained the original allocator above 16 MiB. No large-frame gain is established.

### Tail evidence and confound

Across the four runs, 16-MiB p95 baseline→candidate was:

- 6.740→3.064 ms; maxima 11.504→9.353 ms
- 3.072→2.165 ms; maxima 6.696→10.067 ms
- 6.738→7.162 ms; maxima 10.133→13.876 ms
- 6.743→8.824 ms; maxima 6.946→9.636 ms

Each p95 is the second-largest of just 31 samples. Across 124 samples per variant, >=8-ms samples occurred 2 times for baseline and 5 times for candidate; >=6-ms samples occurred 11 and 8 times respectively. This mixed pattern does not establish a repeatable allocator-specific tail regression, and does not establish tail safety either.

Every >=4-ms sample for either variant occurred second in its pair: baseline on even recorded iterations, candidate on odd recorded iterations. That strong pair-order association indicates GC/allocation/order effects in this harness. It limits attribution to the allocator itself. The measurements cannot support an end-to-end smoothness claim, so the production change was deferred rather than optimizing only for median timing.

These are decoder-only CPU measurements, not FPS, browser/Electron performance, or cross-platform results. Raw samples and `paired-uncertainty.json` remain available; they describe the rejected candidate.

## Retained regression coverage

The additional tests do not assume an allocation implementation:

- Every byte of fragmented u8/f32 payloads, including one-byte UTF-8 metadata splits and empty values, is preserved exactly.
- Incomplete or malformed frames, bad IDs/encodings, and misaligned floats do not return successful binary replies.
- A real Node worker transfers replies with ordinary typed-array identity, byte offset zero, exact backing length, and sender detachment; every received byte is checked.
- Exact 128-MiB protocol-limit payloads and neighboring 16-MiB-sized payloads expose no padding or unrelated backing bytes.
- Repeated decode after transfer produces independently owned storage.

`negative-control.mjs` copies the current production decoder into an isolated temporary fixture and deliberately corrupts its last copied payload byte. The byte-preservation test must fail. It does not substitute an allocation policy or modify the real production source.

Final baseline verification after restoration:

- **21 desktop preparation/package/codec tests passed**, including 18 frame tests, with zero failures or skips (`preparation-contract-tests.log`, `frame-tests.log`).
- **6 client transport Vitest tests passed**, including ordering, cancellation, IDs, errors, and cleanup (`client-transport-tests.log`). These use mocks and real local message ports rather than Electron.
- **3 actual Node-worker/Rust-stdio/WASM runtime tests passed**, covering exact geometry/metadata except the existing platform-sized fingerprint exception, exact CPU pixels and float payloads, fork/isolation, errors, closure, and missing executable (`native-runtime-tests.log`). The existing pre-increment binaries are recorded in `source-manifest.json`; this is not validation of the separate ongoing Rust implementation changes.
- The isolated corrupted-last-byte negative control failed as required against the restored production decoder (`negative-control.log`).
- `node --check` and focused `git diff --check` passed.

Historical candidate correctness runs remain in `candidate-*-tests.log` and `candidate-negative-control.log`, clearly distinct from these final baseline reruns.

## Other inspected costs and deliberate non-changes

An observational run using five real Rust child sessions found median startup of 99.1 ms. A 3,500-node fixture (589,904 UTF-8 JSON bytes) took 23.6 ms for the serialization roundtrip, 40.7 ms to load, and 9.5 ms for the existing interaction snapshot fork. At 10,000 nodes (1,699,519 bytes), medians were 48.4 / 128.4 / 29.9 ms. Full packet hashes and samples are in `profile-before.json`. These measurements exclude Electron invoke and browser behavior.

The current renderer already suppresses repeated loads for identical immutable snapshots, applies patches to changed snapshots, and runs native JSON work in a Node worker. Object/string cloning and serialization remain plausible larger costs, but changing the protocol or caching would require separate ordering, cancellation, ownership, and Electron validation. No such rewrite is included.

The response parser retains incoming chunks until completion and then creates an independently owned output. This investigation does not remove simultaneous residency or make Electron invoke zero-copy. Streaming directly into a preallocated output was not adopted because it would allocate up to the announced limit for incomplete responses earlier than the current validation point.

## Reproduction

Run from the checkout root:

```sh
node --test frontend/design-desktop/test/preparation*.test.mjs
node testing/verification-next-native-transport/negative-control.mjs
# Explicitly benchmarks the NOT SHIPPED candidate:
node --expose-gc testing/verification-next-native-transport/benchmark-frame-allocation.mjs
DESIGN_PREPARE_BINARY=/path/to/same-source/design-prepare node --test frontend/design-desktop/test/runtime/preparation-runtime.test.mjs
(cd frontend/design-client && node node_modules/vitest/vitest.mjs run src/kernel/native-preparation.test.ts src/kernel/preparation-channel.test.ts)
```

GPU, browser, real Electron IPC/window behavior, sockets, and operating-system-specific packaging were not run by this increment.
