#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?Usage: bash verify.sh ABSOLUTE_EVIDENCE_DIRECTORY EXPECTED_WASM_SHA256}"
EXPECTED="${2:?Supply the exact kernel SHA256 for the source increment}"
[[ "$OUT" = /* ]] || { echo "Evidence directory must be absolute" >&2; exit 2; }
[[ "$EXPECTED" =~ ^[a-f0-9]{64}$ ]] || { echo "Expected SHA256 must be 64 lowercase hex characters" >&2; exit 2; }
mkdir -p "$OUT"
cd "$ROOT/frontend/design-client"
ACTUAL="$(sha256sum public/kernel/design_kernel_bg.wasm | cut -d ' ' -f1)"
[[ "$ACTUAL" = "$EXPECTED" ]] || { echo "Kernel SHA256 mismatch" >&2; exit 2; }
export FUTUREOX_EXPECT_KERNEL_SHA256="$EXPECTED"
export FUTUREOX_COVERAGE_MANIFEST="$OUT/operation-coverage.json"
node_modules/.bin/tsc --noEmit 2>&1 | tee "$OUT/tsc.log"
node_modules/.bin/vitest run \
  src/automation/edit-history.test.ts \
  src/automation/operation-coverage.test.ts \
  src/automation/mcp-e2e.test.ts \
  src/automation/sketch.test.ts \
  src/import-fig-fidelity.test.ts \
  src/append-document.test.ts \
  src/automation/core.test.ts \
  src/automation/granular.test.ts \
  src/automation/permissions.test.ts \
  src/automation/export.test.ts \
  src/automation/bridge.test.ts \
  src/import-file-worker.test.ts \
  src/canvas-operation-diagnostics.test.ts \
  src/canvas-action-diagnostics.test.ts \
  --no-file-parallelism --maxWorkers=1 --no-cache 2>&1 | tee "$OUT/vitest.log"
cmp "$OUT/operation-coverage.json" "$ROOT/docs/OPERATION_COVERAGE_V1.json"
printf 'Verified kernel: %s\nManifest matches checked-in generated coverage.\n' "$ACTUAL" | tee "$OUT/verification.txt"
