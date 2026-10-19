#!/usr/bin/env bash
# Bounded, local-only ABBA comparison. Use an idle checkout; six source files
# are temporarily replaced and restored. Does not download or rebuild anything.
set -eu
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo 'Usage: reproduce-inspector.sh BASELINE_SOURCE_DIRECTORY [OUTPUT_DIRECTORY]' >&2
  exit 2
fi
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
baseline=$(cd "$1" && pwd)
out=${2:-"$repo/test-results/editor-cpu-abba"}
mkdir -p "$out"
out=$(cd "$out" && pwd)
client="$repo/frontend/design-client"
files='MultiSelectionInspector.tsx MultiStylePanel.tsx property-units.ts selection-properties.ts Canvas.tsx engine.ts'
python3 - "$baseline" "$here/source-hashes.json" <<'PY'
import hashlib,json,sys
from pathlib import Path
source=Path(sys.argv[1]); expected=json.load(open(sys.argv[2]))['baselineFiles']
for name,digest in expected.items():
    path=source/name
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
        raise SystemExit(f'Baseline bytes do not match the frozen delivery: {name}')
PY
for path in node_modules/vitest/vitest.mjs public/kernel/design_kernel_bg.wasm public/fonts/NotoSansSC.ttf; do
  test -f "$client/$path" || { echo "Required local dependency missing: $path" >&2; exit 2; }
done
mkdir -p "$out/optimized"
for file in $files; do cp "$client/src/$file" "$out/optimized/$file"; done
restore() { for file in $files; do cp "$out/optimized/$file" "$client/src/$file"; done; }
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$client"
node --version > "$out/runtime.txt"
sha256sum public/kernel/design_kernel_bg.wasm public/fonts/NotoSansSC.ttf src/multiselection-cpu-runtime.test.tsx >> "$out/runtime.txt"
: > "$out/status.txt"
for variant in old-a new-a new-b old-b; do
  case "$variant" in old-*) source=$baseline; expected=1;; *) source="$out/optimized"; expected=0;; esac
  for file in $files; do cp "$source/$file" "src/$file"; done
  : > "$out/$variant.jsonl"
  set +e
  MULTISELECTION_CPU_METRICS="$out/$variant.jsonl" node node_modules/vitest/vitest.mjs run \
    src/multiselection-cpu-runtime.test.tsx -t 'mount .* selected' \
    --reporter=default --reporter=json "--outputFile.json=$out/$variant.results.json" \
    > "$out/$variant.log" 2>&1
  status=$?
  set -e
  printf '%s exit=%s expected=%s\n' "$variant" "$status" "$expected" | tee -a "$out/status.txt"
  if [ "$status" != "$expected" ]; then cat "$out/$variant.log"; exit 1; fi
  python3 - "$variant" "$out/$variant.results.json" "$out/$variant.jsonl" <<'PY'
import json,sys
variant=sys.argv[1]; report=json.load(open(sys.argv[2])); rows=[json.loads(s) for s in open(sys.argv[3]) if s.strip()]
old=variant.startswith('old-')
assert report['numFailedTests']==(2 if old else 0), report
assert report['numPassedTests']==(0 if old else 2), report
assert len(rows)==2 and sorted(r['selected'] for r in rows)==[300,3000], rows
for row in rows:
    assert row['allParentsCalls']==(row['selected']*12+2 if old else 3), row
if old:
    failures=[a for result in report['testResults'] for a in result['assertionResults'] if a['status']=='failed']
    assert len(failures)==2
    assert all('to be less than or equal to 5' in '\n'.join(a['failureMessages']) for a in failures), failures
PY
done
python3 - "$out" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1]); variants=['old-a','new-a','new-b','old-b']
rows={v:[json.loads(s) for s in (root/f'{v}.jsonl').read_text().splitlines()] for v in variants}
for size in [300,3000]:
    cases=[next(row for row in rows[v] if row['selected']==size) for v in variants]
    assert all(case['fields']==cases[0]['fields'] for case in cases)
    print(size, 'selected; fields identical;', [(v,round(c['durationMs'],2),c['allParentsCalls']) for v,c in zip(variants,cases)])
PY
