# Phase 3 final frozen-input verification

All selected stages passed. This is CPU/WASM and orchestration-contract verification, not hardware GPU acceptance.

## Final frontend matrix

- TypeScript: passed.
- Complete default Vitest: 245 files, 1,601 passed, 1 skipped, 0 failed. Two workers; real regenerated WASM and production font initialized by the default test setup.
- Render contracts: 59 passed.
- Renderer contracts: 55 passed (27 regression cases and 28 effect-lifetime cases).
- Render-policy: 20 passed.
- Edit-preview contracts: 21 passed.
- Explicit diagnostics rerun: 14 passed, also present in render contracts.
- Deduplicated: 130 additional distinct Node passes beyond Vitest; 1,731 unique frontend passes in this selected matrix. Of 169 Node pass executions, 14 repeat the diagnostics file and 25 repeat shared renderer cases already in Vitest. No duplicate count is treated as extra coverage.

The default run includes phase-3 scheduler, progressive-surface, budget-client, renderer and UI regressions. The private real-117 append-document case remains skipped. Two historical design-file-import checks still return trivially when private fixtures are missing; they are not evidence of actual-file import validation.

## Frozen inputs

- All 662 frontend source/config/generated-WASM/font inputs were unchanged before and after the run.
- All 298 Rust source/build inputs were unchanged before and after the run.
- Both generated/public WASM files: 39,241,063 bytes; SHA-256 b0d67c94e19364f42f69953c799622a1c330459e3c2e37eae4e1f6ecc4b62901.
- All seven source/generated hashes supplied by the pointwise owner were independently rechecked successfully.
- Frontend input-manifest SHA-256: 198a919838f1922ea6e7520834711bd14b068d6187fc579e56881f437a9600d0.
- Rust input-manifest SHA-256: 978ae3ac547763c5e9345f75883c65e4a592916ed747db855c73aa7590452570.

## Separate native evidence

The pointwise owner completed 28 native CPU tests on the final source: 10 pointwise-region cases plus 18 existing interaction/budget/tile-culling regressions. Its log and frozen source/artifact hashes were inspected here; these are not presented as a separate aggregate rerun or added to the frontend total. The portable WASM rebuild used desktop-dev with no SIMD or wasm-opt.

## Limits retained

No GPU device, browser or Electron GUI was launched. No hardware VRAM, shader-pixel equivalence, FPS, user-document reproduction or 3200% acceptance is claimed. Product GPU defaults remain preserved by the passing policy/contract tests.

The selected Node matrix does not execute every historical .mjs/Bun/browser script. The known export-ownership.test.mjs source-extraction failure remains outside the matrix, unchanged and not counted as passed. Existing private-fixture gaps remain explicit.

## Evidence shipped in this directory

- frontend-final-summary.json: precise counts, test identities, duplicate accounting, stage exit codes, input-integrity conclusions, limits and provenance.
- frontend-final-typecheck.log and frontend-final-vitest.log: final type checking and complete default-suite run output.
- frontend-final-render-contracts.log, frontend-final-renderer-contracts.log, frontend-final-render-policy.log, frontend-final-edit-preview-contracts.log and frontend-final-diagnostics.log: selected standalone Node run output.
- pointwise-native-regressions.log and pointwise-build-web.log: separate native CPU tests and portable WASM build output.
- pointwise-native-prepare-build.log and pointwise-native-prepare-runtime.log: rebuilt native preparation program and its three actual Rust/WASM bridge checks.
- viewport-priority-result.json: focused scheduling verification and scope limits.
- budget-diagnostics-client.log, budget-diagnostics-node.log, budget-diagnostics-recovery.log, budget-diagnostics-renderer.log, budget-diagnostics-typecheck.log and budget-diagnostics-inputs.sha256: focused diagnostics checks and their input identities before the final aggregate.

The complete per-test assertion JSON and before/after per-file input manifests were retained with the build verification but are not included in this source increment. Their result counts, manifest digests and unchanged-input conclusions are recorded above and in frontend-final-summary.json. The package does not include the local aggregate-runner or snapshot scripts.
