#!/usr/bin/env bash
# Targeted unit verification only. Never installs dependencies or builds artifacts.
set -uo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || exit 2
CLIENT="$ROOT/frontend/design-client"
SUITE="high-zoom"
TESTS=(
  "src/kernel/gpu/renderer.test.ts"
  "src/kernel/gpu/high-zoom.test.ts"
)

usage() {
  printf 'Usage: %s [--list] [--log-dir DIRECTORY]\n' "$(basename "$0")"
  printf '%s\n' \
    "Runs only the $SUITE Vitest unit selection using already-prepared local dependencies." \
    'Requires Node, local Vitest, generated kernel bindings/WASM, and the bundled test font.' \
    'Does not install, compile the app/kernel, start a browser, or validate GPU pixels/FPS.' \
    'Creates a unique log directory; all output and the actual failure status are retained.' \
    'Missing prerequisites exit 2. Test failures preserve the test runner exit status.'
}

LOG_PARENT="${TMPDIR:-/tmp}"
LIST_ONLY=0
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --list) LIST_ONLY=1; shift ;;
    --log-dir)
      if (($# < 2)) || [[ -z "$2" ]]; then
        printf 'ERROR: --log-dir requires a directory.\n' >&2
        exit 2
      fi
      LOG_PARENT="$2"; shift 2 ;;
    *) printf 'ERROR: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
if ((LIST_ONLY)); then
  printf '%s\n' "Selected unit suite: $SUITE" "${TESTS[@]}"
  exit 0
fi

mkdir -p -- "$LOG_PARENT" || exit 2
LOG_DIR="$(mktemp -d "${LOG_PARENT%/}/futureox-${SUITE}.XXXXXX")" || exit 2
LOG="$LOG_DIR/result.log"
printf 'Log: %s\n' "$LOG"

run_suite() {
  local missing=0 file status
  printf 'Suite: %s\nRepository: %s\n' "$SUITE" "$ROOT"
  printf 'Selected files (%d):\n' "${#TESTS[@]}"
  printf '  %s\n' "${TESTS[@]}"
  if ! command -v node >/dev/null 2>&1; then
    printf 'ERROR: Node is not available.\n' >&2
    missing=1
  fi
  for file in \
    node_modules/vitest/vitest.mjs \
    public/kernel/design_kernel_bg.wasm \
    src/generated/design-kernel/design_kernel.js \
    public/fonts/NotoSansSC.ttf \
    "${TESTS[@]}"; do
    if [[ ! -f "$CLIENT/$file" ]]; then
      printf 'ERROR: missing prerequisite: %s\n' "$CLIENT/$file" >&2
      missing=1
    fi
  done
  if ((missing)); then
    printf '%s\n' 'NOT RUN: prepare dependencies and kernel artifacts separately, then rerun.' >&2
    return 2
  fi
  cd -- "$CLIENT" || return 2
  printf 'Node: '; node --version || return 2
  printf 'Running local Vitest; no package-manager install or build step.\n'
  node ./node_modules/vitest/vitest.mjs run "${TESTS[@]}"
  status=$?
  if ((status)); then
    printf 'FAILED: %s unit selection (runner exit %d).\n' "$SUITE" "$status" >&2
  else
    printf 'PASSED: selected %s unit suite only; see runner output for actual counts.\n' "$SUITE"
  fi
  return "$status"
}

run_suite 2>&1 | tee "$LOG"
STATUSES=("${PIPESTATUS[@]}")
if ((STATUSES[1] != 0)); then
  printf 'ERROR: log write failed (tee exit %d).\n' "${STATUSES[1]}" >&2
fi
if ((STATUSES[0] != 0)); then
  exit "${STATUSES[0]}"
fi
if ((STATUSES[1] != 0)); then
  exit 2
fi
