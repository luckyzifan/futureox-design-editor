# Exact 146825d fatal recovery verification

Baseline: 146825dad9e292b1b06046d17a269397d75ab323. Approved source-manifest SHA-256: a77cc0277ccee605176c08bda4dfe630e0e91aebd5a3c6999b28b3ec5147a424.

Every baseline hash was independently obtained from this Git commit, not inferred from an old working-tree overlay. Every candidate hash matches the new source on which the final tests ran. The previous five-part repair is already in this commit; it is not an extra installation prerequisite and its payload is not bundled again.

## Fresh results

- Renderer: 284 passed across 18 files, final-renderer.log.
- Pose/Editor: 101 passed across 3 files, final-pose.log.
- Mounted Canvas: 17 passed across 3 files, final-mounted.log.
- Node: 82 passed across 9 files, final-node.log.
- Total: 484 distinct named tests, zero failures.
- Scoped strict production TypeScript plus transitive dependencies passed. final-typecheck.log is empty on success; the final test runner used set -e and wrote final-status.txt only after all stages completed.
- Patch forward/reverse checks and exact byte restoration passed for all 7 files, including removal of all 3 newly added files: patch-check.json.
- Twelve safety guards passed on the frozen payload: guard-tests.json.

The new-baseline audit checked all seven patch preconditions, preserved the new filter(...).pop() compatibility test edit, and matched the baseline source fingerprint across 1,973 files. The packaging check independently compared the compatibility test with exact Git and rechecked Rust/vendor tree identities. baseline-audit-summary.json retains these outcomes and the original audit hash.

Final test logs contain synthetic automated tests, not user reproduction logs. Only the absolute validation workspace prefix in three headers was changed to <Core>/. Both original and bundled hashes are in evidence-provenance.json. Source bytes remain unchanged. Historical component/merge patch hashes are provenance only; candidate.patch is the applicable patch for this exact new baseline.

## Reproduce tests

Use a checkout at the exact baseline with this increment applied, the project's existing matching dependencies, and the matching generated kernel. No dependencies or generated binaries are bundled. runtime-identity.json records the tool and package versions and Rust/vendor tree identities.

Set FUTUREOX_EXPECT_KERNEL_SHA256 to d0062466914e7e79f58375153a110077dd54374060918b04f9e370ae163c609c. This preserved dev opt1 WASM is source-equivalent, not a new Rust build or release-performance artifact. If necessary, set TMPDIR to an existing writable directory with sufficient space on your own machine.

Copy the four exact configurations from evidence/configs/ temporarily into frontend/design-client without overwriting existing local files. From frontend/design-client:

1. node node_modules/vitest/vitest.mjs run --config vitest.repair2-all-renderer.config.mts
2. node node_modules/vitest/vitest.mjs run --config vitest.pose-combined.config.mts
3. node node_modules/vitest/vitest.mjs run --config vitest.all-mounted.config.mts
4. node node_modules/typescript/bin/tsc --project tsconfig.combined-check.json

From the Core root, run the following single command:

node --import ./testing/lib/register-typescript.mjs --test frontend/design-desktop/test/render-terminal-diagnostics.test.mjs frontend/design-desktop/test/render-producer-identity.test.mjs frontend/design-desktop/test/render-runtime-configuration.test.mjs frontend/design-desktop/test/render-surface-ledger.test.mjs frontend/design-client/src/kernel/render-diagnostics.test.mjs frontend/design-client/src/kernel/render-failure-budget-fields.test.mjs frontend/design-client/src/kernel/render-failure-origin.test.mjs frontend/design-client/src/kernel/pose-feedback.test.mjs frontend/design-client/src/kernel/gpu/maintenance-residency.test.mjs

The seven-file increment also includes vitest.async-mounted.config.mts as a test-support file for running only the new mounted recovery test; the 484-test final acceptance used vitest.all-mounted.config.mts.

## Reproduce packaging checks

From the bundle root:

1. PYTHONDONTWRITEBYTECODE=1 python3 evidence/test_apply_increment.py .
2. PYTHONDONTWRITEBYTECODE=1 python3 evidence/verify_patch.py .
3. sha256sum --check SHA256SUMS

The first two commands operate only in temporary Git fixtures. Guard tests replace the fixture manifest's HEAD with the fixture's own commit, never apply to a user checkout, and verify preservation of unrelated working/staged data.

## Scope and limits

Recovery tests cover a fatal result after the pointer has stopped while its gesture remains active, synchronous native throws, exactly-once transfer of the latest absolute patch, original-transaction commit/undo/redo/cancel behavior, stale notification fences, intervening state changes and reentry. Mounted tests exercise actual React/Canvas and Editor with a mocked rendering boundary.

Fatal results arriving after the gesture has ended must be rejected and must not revive that gesture. This increment does not repair the underlying delay of late capture/completion or establish that such failures are now resolved. Its recovery scope must not be generalized to all observed fatal errors.

Recovery does not imply automatic reenablement of the native fast path for later gestures. The existing error latch may leave later gestures on fallback. Diagnostic unacknowledged-pose summaries are retained; receipt or recovery is not proof that pixels reached the display. This is not a lower-quality ordinary preview feature.

No hardware GPU pixels, Electron/macOS GUI, physical same-frame alignment, FPS, release performance, full production build or complete real-document interaction replay was accepted. Current rotation flicker, large-surface working-set peaks, overall budget failures and ordinary blue-selection-box/content physical frame coherence remain open.
