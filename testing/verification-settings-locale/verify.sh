#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 2 || "$1" != /* || ! "$2" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'Usage: verify.sh /absolute/evidence-directory expected-kernel-sha256' >&2; exit 2
fi
root=$(cd "$(dirname "$0")/../.." && pwd)
evidence=$1
mkdir -p "$evidence"
cd "$root/frontend/design-client"
actual=$(sha256sum public/kernel/design_kernel_bg.wasm | cut -d' ' -f1)
[[ "$actual" == "$2" ]] || { echo "Kernel identity mismatch: $actual" >&2; exit 1; }
printf 'kernelSha256=%s\nnode=%s\n' "$actual" "$(node --version)" > "$evidence/verification.txt"
node node_modules/typescript/bin/tsc --noEmit > "$evidence/tsc.log" 2>&1
node node_modules/vitest/vitest.mjs run \
  src/settings-locale.test.tsx src/SettingsDialog.test.tsx src/adaptive-panels.test.tsx \
  src/operation-settings-dialog.test.tsx src/settings-preference.test.ts \
  src/keyboard-nudge.test.tsx src/nudge-preference.test.ts src/canvas-camera.test.ts \
  src/camera-state.test.ts src/desktop-session.test.ts src/canvas-action-diagnostics.test.ts \
  src/canvas-operation-diagnostics.test.ts src/numeric-expression.test.ts \
  --no-file-parallelism --maxWorkers=1 --no-cache > "$evidence/vitest.log" 2>&1
node scripts/generate-i18n-inventory.mjs "$evidence/i18n-inventory.json" > "$evidence/inventory.log" 2>&1
cmp ../../docs/I18N_REMAINING_STRINGS_V1.json "$evidence/i18n-inventory.json"
# Keep output outside the source tree. Uses verified existing WASM, not a Rust rebuild.
node node_modules/vite/bin/vite.js build --outDir "$evidence/build" > "$evidence/build.log" 2>&1
printf 'typecheck=passed\nvitest=passed\ninventory=identical\nviteBuild=passed\n' >> "$evidence/verification.txt"
