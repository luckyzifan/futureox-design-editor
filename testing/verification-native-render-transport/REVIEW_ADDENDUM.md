# Independent native-render transport review, 2026-10-19

## Corrections and evidence status

Independent review reproduced and fixed two FRB1 decoder validation gaps. ASCII string decoding had masked high bits in the four magic bytes; malformed UTF-8 metadata had been silently replaced with U+FFFD. The receiver now compares the raw magic bytes exactly and uses fatal UTF-8 decoding. Valid frames, byte ownership, FIFO, and the default JSON/backend selection are unchanged.

The original parser SHA-256 was `bcc8a75c0199803ac5ff0605d67ae9a99e485bd7e822cbeeefdc5febe5f50ccf`. The corrected parser SHA-256 is `ac7a164469584deb9871a1d3083aac803cda32189be213ea9fa343ad1436ff72`. Original `production-benchmark.json`, `production-repeat-512.json`, their raw logs, and `source-manifest.json` are historical pre-correction evidence and remain intact. `review-source-manifest.json` records reviewed source and tested executable identities.

The original `negative-control.log` contains a real small-frame assertion mismatch followed by a Node heap-exhaustion abort; the old runner nevertheless printed PASS. That PASS is superseded. The corrected runner selects only the bounded 96-byte production comparison, first verifies the unmodified test passes, and then requires the named `ERR_ASSERTION` / `deepStrictEqual` failure, exit 1, no signal/error/stderr, and normal complete test totals. Real infrastructure-exit and timeout controls must be rejected. The verified replacement run is `review-negative-control.log`.

## Current verification

- 33 desktop tests passed, zero failures or skips, including three added strict-decoding/cancellation regressions.
- 14 independent boundary tests passed: exact/over 64 MiB requests, exact 96 MiB aggregate request budget in both protocols, 64 KiB metadata boundary, safe request-ID exhaustion, actual Rust malformed/replayed/session-changing requests, and real OS-child rejection/reaping after malformed responses.
- 2 client byte/encoding tests and full frontend TypeScript checking passed.
- 5 production Rust codec tests passed both in a freshly compiled isolated target and the existing complete-bin test target. These are the same five tests, not ten different tests.
- Actual CPU legacy/FRB1 pixels and stable stats matched through repeated frames, pan, dimensions and reload; actual Rust codec/Node stdio matched through synthetic 4K frames. The renderer executable tested here was SHA-256 `9c60f1fe772b50e9a3097dfb29f7f5a6771a664a35114f81b8d146b575320bc0`. A later parent aggregate rebuild includes unrelated kernel changes; its final-binary parity result must be tracked separately and is not claimed by this review.

## Post-correction CPU fixture measurement

`review-production-benchmark.json` and `.log` are a fresh 31-pair run per size, after three warmups, with alternating order, forced GC, and every byte checked outside timing. Their six production-code/fixture hashes match the reviewed transport implementation. The complete path is synthetic-pixel production Rust codec → OS stdio → active Node receiver → structuredClone → production pixel decoder. Shared-host concurrent Cargo builds occurred during this measurement; timings are observations, not isolated hardware limits or a universal tail-latency guarantee.

| Size | JSON total median / p95 (ms) | FRB1 total median / p95 (ms) |
|---|---:|---:|
| 96×64 | 2.558 / 2.898 | 0.390 / 0.478 |
| 512×512 | 86.468 / 122.255 | 2.746 / 5.610 |
| 1920×1080 | 825.837 / 1052.847 | 21.836 / 33.424 |
| 3840×2160 | 3603.275 / 4110.226 | 97.404 / 151.580 |

No GPU, browser, actual Electron IPC/context bridge, Windows/macOS packaging, or network socket was exercised. This remains an opt-in CPU transport improvement for the native probe/stats bridge. Pixels are explicitly copied to a tight owned array and Electron invoke still clones; there is no zero-copy, GPU-readback saving, FPS, or default-canvas improvement claim.
