# Frozen 09e6 verification

Baseline: 09e6bce9917eef8104957eb67f23583e3a2f52e4. Five fixed component patches produce 18 changed paths. manifest.json and combined-composition.json record exact baseline and result hashes. The approved original source-manifest SHA-256 is ada3e2aaa0f81e2292ea74421fdb2a06c849fc99297b54e7e45ec8556c26e5be.

## Results and evidence

- Renderer: 284 tests across 18 files, final-renderer.log.
- Pose/Editor: 71 tests across 3 files, final-pose.log.
- Mounted Canvas: 14 tests across 2 files, final-mounted.log.
- Node: 82 tests across 9 files, final-node.log.
- Total: 451 distinct named tests, zero failures. Prior 248 renderer results, author-specific counts and historical 117 coordinate parity cases are not added again.
- Scoped strict production TypeScript and transitive dependencies: exit 0, final-typecheck.exit. The corresponding log is empty on success. This is not a full application build.
- Five component patches independently replayed from exact baseline bytes to all 18 final files: composition-replay-check.json.
- Combined patch forward/reverse exact restoration: patch-check.json.
- Twelve final-payload check/apply/rollback guards: guard-tests.json. Guards use a temporary real Git fixture and substitute only its HEAD in a test-only manifest; no user checkout is modified.

Test output is synthetic automated-test evidence, not user reproduction logs. Only the absolute validation workspace prefix in three test headers was replaced with <Core>/. Original and bundled SHA-256 values are both in evidence-provenance.json. The manifest evidence hashes refer to the bundled bytes. Source and component patch bytes were not altered for publication.

## Reproduce tests

Use a checkout at the exact baseline with this increment applied, the project's existing matching dependencies and generated kernel. No dependencies or generated binaries are bundled. Runtime versions and Rust tree identities are in runtime-identity.json. The tested kernel SHA-256 is d0062466914e7e79f58375153a110077dd54374060918b04f9e370ae163c609c. It is a preserved source-equivalent dev opt1 WASM, not a fresh Rust build or release-performance artifact.

Set FUTUREOX_EXPECT_KERNEL_SHA256 to that value. If the system temporary directory is full, set TMPDIR to an existing writable directory with adequate free space on your own machine. Do not use a path copied from another environment.

The four exact test configurations are in configs/. Copy them temporarily into frontend/design-client without overwriting existing local files. From frontend/design-client:

1. node node_modules/vitest/vitest.mjs run --config vitest.repair2-all-renderer.config.mts
2. node node_modules/vitest/vitest.mjs run --config vitest.pose-combined.config.mts
3. node node_modules/vitest/vitest.mjs run --config vitest.fallback-regression.config.mts
4. node node_modules/typescript/bin/tsc --project tsconfig.combined-check.json

From the Core root, run the following single command:

node --import ./testing/lib/register-typescript.mjs --test frontend/design-desktop/test/render-terminal-diagnostics.test.mjs frontend/design-desktop/test/render-producer-identity.test.mjs frontend/design-desktop/test/render-runtime-configuration.test.mjs frontend/design-desktop/test/render-surface-ledger.test.mjs frontend/design-client/src/kernel/render-diagnostics.test.mjs frontend/design-client/src/kernel/render-failure-budget-fields.test.mjs frontend/design-client/src/kernel/render-failure-origin.test.mjs frontend/design-client/src/kernel/pose-feedback.test.mjs frontend/design-client/src/kernel/gpu/maintenance-residency.test.mjs

The TypeScript registration loader is already part of the exact baseline. The configurations are test evidence, not production payload and are not installed by apply_increment.py.

## Reproduce packaging checks

From the bundle root:

1. PYTHONDONTWRITEBYTECODE=1 python3 evidence/test_apply_increment.py .
2. PYTHONDONTWRITEBYTECODE=1 python3 evidence/verify_composition.py .
3. sha256sum --check SHA256SUMS

The first two commands use isolated temporary directories. Component replay uses all five immutable patches in evidence/patches and adjusts exactly two context-only lines for neighboring sampling changes, verifying added/deleted lines stay identical. It does not operate on the live checkout. The combined candidate.patch also passed independent forward and reverse application with exact byte restoration, including removal of newly added files.

## Proof boundaries

Actual WASM exercises the original 64 MiB primitive failure on an oversized rotated image. The corrected optional table eligibility avoids dense generation on that ineligible route and preserves exact strip coordinates. Transport tests extract the actual Worker diagnostic sink expression and use real terminal batching, JSON and host sanitization with detail false and true. They do not boot the complete Worker/Electron application. Non-detail transport retains latest/count per event, not every failure in an arbitrary burst.

Mounted Canvas uses real React/Editor with mocked rendering. Removing an extra submission timer is not physical same-frame presentation acceptance. Pose changes here diagnose lifecycle; unverified fatal asynchronous automatic fallback is excluded. Budget changes add failure-only classification diagnostics, not a budget-pressure repair or retrospective knowledge of untagged textures. Overall surface-budget errors and ordinary blue-selection-box physical frame coherence remain unresolved.

No production/full application build, hardware GPU pixels, Electron/macOS GUI, physical same-frame latency, FPS, release performance or complete 117/FIG interaction replay was accepted. CPU, WASM and mocks cannot establish those outcomes.
