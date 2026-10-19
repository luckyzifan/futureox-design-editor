# Independent FRB1 native-render transport audit

Date: 2026-10-19 UTC. Checkout: `__DESIGN_REPO__`. Review output: `__REVIEW_ROOT__/review-native-transport`.

## Conclusion

The opt-in transport is acceptable within the CPU/protocol evidence boundary after three corrections: two strict-decoder fixes and a trustworthy negative-control harness. No unresolved blocker was found in the audited transport scope. This is not native-GPU, GUI, Electron IPC, cross-platform, device-loss, or editor-FPS acceptance.

Product edits were coordinated with the parent before writing. The only runtime file changed by this review is `frontend/design-desktop/src/native-render-frame.mjs`; Rust rendering, wire emission, host request scheduling and client pixel decoding were not modified. Two existing desktop test files received three regressions. The negative-control test harness and publication-facing verification notes were corrected separately. No network socket, browser, adapter/device initialization, package installation, or source publication occurred.

## Findings and fixes

### R1 — Exact magic validation, corrected (P2 protocol-contract defect)

Before review, `header.toString('ascii', 0, 4)` cleared bit 7 of each byte. A reply beginning C6 52 42 31 was accepted as FRB1 even though its raw magic was corrupt. All four individual high-bit mutations are now rejected by exact Buffer comparison. This did not demonstrate a pixel or memory exploit; it violated the promised fail-closed byte-level protocol.

### R2 — Strict UTF-8 metadata, corrected (P2 protocol-contract defect)

`Buffer.toString('utf8')` previously converted invalid bytes inside JSON strings to U+FFFD, accepting corrupted metadata. Fatal TextDecoder validation now rejects invalid bytes, overlong encodings, UTF-8 surrogate encodings and truncated codepoints, both contiguous and fragmented. Subsequent valid decoding still succeeds. `ignoreBOM: true` retains the old JSON.parse behavior of rejecting a leading BOM rather than newly discarding it.

Before-fix repro: `independent-boundaries-before.log` shows 11 passes and exactly these 2 failures. `desktop-tests-before.log` shows all original 30 tests passed, demonstrating the test gaps. Original source copies and `source-hashes-before.json` are retained. `decoder-fix.patch` captures the runtime change.

### R3 — Negative-control false success after OOM, corrected (P2 verification defect)

Both the original repository negative-control log and the first independent rerun contain Node heap exhaustion while formatting an intentionally wrong 48 MiB comparison, followed by PASS from the permissive runner. A small-frame mismatch really occurred, but that was not a trustworthy completed negative-control result. The original logs are preserved and explicitly superseded, not erased or reclassified as clean passes.

The replacement runner first requires the unchanged bounded test to pass; only a named normal `ERR_ASSERTION` / `deepStrictEqual` failure, exact exit 1, complete counts and no stderr/signal/tool error can establish corruption detection. Actual exit-37 and timeout controls are rejected. `negative-control-after.log` records normal completion and both controls. No large negative diff or intentional OOM is required.

## Verification performed

| Check | Result | Evidence |
|---|---|---|
| Original repository desktop suite | 30 passed, 0 skipped | desktop-tests-before.log |
| Final repository desktop suite | 33 passed, 0 skipped | desktop-tests-after.log |
| Independent request/response/OS boundary tests | 14 passed, 0 skipped | independent-boundaries-after.log, independent-boundaries.test.mjs |
| Client exact bytes/encoding/dimensions | 2 passed | client-tests.log |
| Full frontend TypeScript | exit 0 | typecheck.log, typecheck-status.log |
| Fresh compilation of current production Rust codec | 5 passed | rust-codec-build.log, rust-codec-tests.log |
| Existing complete-bin Rust codec target | same 5 passed | rust-integrated-tests.log |
| Bounded real corruption + infrastructure controls | passed | negative-control-after.log |
| Historical benchmark sample summaries/arithmetic | passed | historical-benchmark-validation.json |
| Fresh benchmark exact pixels/hash/sample arithmetic | passed | production-benchmark-after.json/.log |
| Changed JS syntax and focused whitespace checks | passed | final-checks.log |

### Boundary coverage

- Responses: every split in a small exact RGBA frame including UTF-8, one-byte fragmentation, incomplete/trailing bytes, raw magic/version, 64 KiB metadata exact/over, 48 MiB RGBA exact/over, fragment-count cap, dimensions, type, explicit encoding, tight independently owned backing allocation and real Worker transfer/detachment.
- Requests: JSON and FRB1 exact 64 MiB body accepted, one byte over rejected; exact 96 MiB aggregate accepted, next request rejected; eight-request maximum; last safe JS ID accepted once; no additional write on sequence exhaustion. Byte accounting is zero after stop.
- Real Rust OS stdin: missing, zero, negative, fractional, unsafe IDs; empty, overlong, non-ASCII and invalid-character sessions; replay/decreasing/session-switch; truncated, malformed-JSON, invalid-UTF-8 and oversized commands; exact 64 MiB acceptance. Request-scoped errors retain correlation and allow a later command.
- Ordering/lifetime: single-in-flight FIFO, application errors versus fatal transport errors, backpressure, deadlines, partial input cancellation, final stdout before close, owner full navigation/destruction, reload and SIGKILL fallback. New malformed-frame tests verify both mock ownership cleanup and real OS child SIGTERM/reaping with active and queued requests rejected.
- Real rendering: two nonempty geometric shapes, repeated frames, pan, changed dimensions and reload have exact legacy/FRB1 CPU bytes and identical non-timing stats. A separate production Rust codec fixture covers 1 px, 96×64, 513×257 and 4K synthetic RGBA.

The tested renderer hash is `9c60f1fe772b50e9a3097dfb29f7f5a6771a664a35114f81b8d146b575320bc0`, matching the original transport manifest at audit start. The parent is separately rebuilding the complete binary after unrelated kernel interop edits; this report does not claim the subsequent binary was tested here. The parent's final aggregate must retain its exact executable hash and repeat CPU parity. Source hashes are snapshots, not a claim that every dependency of a later binary is unchanged.

## Compatibility and performance interpretation

Source comparison with saved baselines verifies JSON is still the constructor and CLI default. Only `CORE_NATIVE_RENDER_PROTOCOL=frb1` causes the host to pass `--serve-protocol frb1`. Unknown explicit selections fail; no silent fallback exists. Backend preference and the default canvas selection are unchanged. The old TS Electron helpers stay JSON clients. The extracted client helper preserves legacy atob conversion and accepts explicit owned rgba8 only, with dimension checks.

No zero-copy claim was found in the reviewed report/protocol. The Rust codec avoids base64 for raw bytes but the Node receiver retains input chunks and makes a pixel copy, then Electron invoke uses structured cloning. Worker detachment establishes allocation ownership only. The benchmark's structuredClone is not an Electron IPC measurement. Rust sink microbenchmarks exclude actual raw byte transfer and are disclosed as such.

Post-fix observed full CPU fixture timings:

| Size | JSON median / p95 (ms) | FRB1 median / p95 (ms) |
|---|---:|---:|
| 96×64 | 2.558 / 2.898 | 0.390 / 0.478 |
| 512×512 | 86.468 / 122.255 | 2.746 / 5.610 |
| 1920×1080 | 825.837 / 1052.847 | 21.836 / 33.424 |
| 3840×2160 | 3603.275 / 4110.226 | 97.404 / 151.580 |

31 pairs/size, three warmups, alternating order, forced GC, exact equality after timing. Shared-host concurrent Cargo builds occurred; these are CPU observations, not isolated-hardware limits. Fresh benchmark production hashes all match. Original raw benchmarks and their source identities remain historical evidence and are not relabeled as measurements of the corrected decoder. GPU/native readback savings, default-editor FPS, browser smoothness, actual Electron bridge behavior, platform packaging and device loss remain unrun.

## Reproduction

From the checkout, with the retained exact renderer/fixture binaries:

```sh
DESIGN_RENDER_BINARY=__BUILD_ROOT__/cargo-target/debug/design-render \
DESIGN_RENDER_CODEC_FIXTURE="$PWD/testing/verification-native-render-transport/rust-codec-fixture" \
node --test frontend/design-desktop/test/native-render*.test.mjs frontend/design-desktop/test/runtime/native-render*.test.mjs
node --test --test-concurrency=1 __REVIEW_ROOT__/review-native-transport/independent-boundaries.test.mjs
(cd frontend/design-client && node node_modules/vitest/vitest.mjs run src/kernel/native-render-session.test.ts && node node_modules/typescript/bin/tsc --noEmit)
node testing/verification-native-render-transport/negative-control.mjs
OUTFILE=__REVIEW_ROOT__/review-native-transport/production-benchmark-after.json node --expose-gc testing/verification-native-render-transport/benchmark-production.mjs
```

Check executable identity before interpreting a rerun: the shared target path may now contain the parent's newer build. Build/test logs, original source copies, hashes and patched-source evidence are retained here. Publication-facing corrections are in `testing/verification-native-render-transport/REVIEW_ADDENDUM.md` and linked from the corrected original report.
