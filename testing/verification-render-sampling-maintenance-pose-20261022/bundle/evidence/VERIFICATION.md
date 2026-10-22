# Frozen combined verification

Baseline: 1cdebec0a3bcde6633c71661511e532ab0b54aea. Final 19 paths match the validation owner's independently replayed combined source, byte-for-byte. The composition is recorded in combined-composition.json. Shared diagnostic additions were merged rather than overwriting one another.

## Final results

- Renderer: 248 tests, 13 files, combined-renderer-v3-final.log. Includes 18 sampling tests; do not add them again.
- Pose/Editor: 61 tests, 3 files, combined-pose-v3.log. Includes same-epoch document identity rejection.
- Node: 17 tests, 3 pose plus 14 maintenance, combined-node-v3.log.
- Total: 326 distinct named tests.
- Telemetry: 2 assertions, combined-telemetry-final.log; 21 valid scalars retained and 4 invalid/private values rejected. These are not 25 separate tests.
- Scoped strict production TypeScript and transitive dependencies passed; combined-typecheck-v3.log is empty on success.
- Packaging safety: 12 checks in guard-tests.json, plus forward/reverse exact restoration in patch-check.json.

## Reproduction

Use the project's existing installed dependencies and generated kernel, with the exact matching source baseline plus this increment. No dependencies or generated binaries are bundled. The tested kernel SHA256 is d0062466914e7e79f58375153a110077dd54374060918b04f9e370ae163c609c.

The three original test configurations are in configs/. Copy them temporarily into frontend/design-client without overwriting local files, and run from that directory:

1. ./node_modules/.bin/tsc -p tsconfig.combined-check.json
2. FUTUREOX_EXPECT_KERNEL_SHA256=d0062466914e7e79f58375153a110077dd54374060918b04f9e370ae163c609c ./node_modules/.bin/vitest run --config vitest.pose-combined.config.mts
3. node --experimental-strip-types --test src/kernel/pose-feedback.test.mjs src/kernel/gpu/maintenance-residency.test.mjs
4. FUTUREOX_EXPECT_KERNEL_SHA256=d0062466914e7e79f58375153a110077dd54374060918b04f9e370ae163c609c ./node_modules/.bin/vitest run --config vitest.combined.config.mts

The original telemetry harness was invoked from its validation workspace. The bundled portable harness uses the same two assertions and was independently rerun successfully:

node /absolute/path/to/bundle/evidence/verify-combined-telemetry.mjs /absolute/path/to/Core

Guard tests operate on a temporary Git fixture, substitute only that fixture's HEAD in a test-only manifest, and never apply to the user checkout:

PYTHONDONTWRITEBYTECODE=1 python3 /absolute/path/to/bundle/evidence/test_apply_increment.py /absolute/path/to/bundle

## Provenance and limits

The preserved WASM was built from ee97b40. Its design-studio tree 2a29bd31444023a8d661f757c38fb67d7c9f17e0 is identical at 1cde; no Rust source changed or new Rust build ran for this verification. Debug dependencies/kernel opt1 provides correctness evidence, not release timing.

Sampling and some Editor/history operations use the actual matching WASM. GPU resources, Worker presentation and maintenance completion are fake-driver or mock fixtures. Real native/WASM document operations do not establish GPU presentation parity.

Maintenance tests read both production constants from the tested renderer: 50,331,648 bytes (48 MiB) and 64 resources. Obsolete harness results that injected 32 MiB/256 are not acceptance evidence. Legacy pressure fixtures were migrated under a separately hashed test-only patch; mandatory wait, destruction and failure invariants remain exercised. Fixtures include default 1 GiB and explicit 256 MiB. This is not a production-budget change.

No production/full application build, hardware GPU pixels, Electron GUI, physical same-frame latency, FPS, release performance or complete 117 interaction replay was accepted. Ordinary Editor fallback DOM/frame coherence remains outside the repair. A submitted/presented acknowledgement is not proof of physical scanout. There is no claim that all sample failures, white blocks or high-zoom waits are eliminated.
