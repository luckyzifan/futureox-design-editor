#!/bin/zsh
# Batch import→export→re-import triage over public .sketch samples.
# Fixtures live under their own directories (untrusted downloads); this driver
# stays outside them and passes paths as arguments only.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO_DIR="$ROOT/design-studio"
OUT_DIR="${TMPDIR:-/tmp}/sketch-public-roundtrip-20261105"
mkdir -p "$OUT_DIR"
cd "$DEMO_DIR" || exit 2
CORE_DOCUMENT_MEMORY_BYTES=${CORE_DOCUMENT_MEMORY_BYTES:-4294967296}
export CORE_DOCUMENT_MEMORY_BYTES

printf "%-52s %8s  %s\n" "FILE" "BYTES" "RESULT"
for f in "$ROOT"/testing/fixtures/sketch-public-20261105/*/*.sketch(N); do
  name="${f:t}"
  out="$OUT_DIR/${name:r}-roundtrip.sketch"
  log="$OUT_DIR/${name:r}.log"
  if cargo run --locked -q -p futureox-design-kernel \
      --example sketch_roundtrip_demo -- "$f" "$out" >"$log" 2>&1; then
    line=$(grep -m1 '^roundtrip:' "$log")
    printf "%-52s %8s  OK   %s\n" "$name" "$(grep -o '| [0-9]* bytes' "$log" | grep -o '[0-9]*')" "$line"
  else
    err=$(grep -m1 -E 'panicked|Error|error:' "$log" | cut -c1-140)
    printf "%-52s %8s  FAIL %s\n" "$name" "$(stat -f%z "$f")" "$err"
  fi
done
