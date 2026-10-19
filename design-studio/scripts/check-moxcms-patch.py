#!/usr/bin/env python3
"""Check that the vendored ICC fix differs only at the audited numeric patch."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
source = ROOT / 'vendor/moxcms'
manifest = json.loads((source / 'FUTUREOX-PATCH.json').read_text())
expected = {**manifest['upstreamFileSha256'], **manifest['patchedFileSha256']}
actual = {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest()
          for p in source.rglob('*') if p.is_file() and p.name != 'FUTUREOX-PATCH.json'}
if actual != expected:
    missing = sorted(expected.keys() - actual.keys())
    extra = sorted(actual.keys() - expected.keys())
    changed = sorted(k for k in actual.keys() & expected.keys() if actual[k] != expected[k])
    raise SystemExit(f'ICC patch drift: missing={missing}, extra={extra}, changed={changed}')
print(f'ICC source verified: {len(actual)} files, {len(manifest["changes"])} audited changes; licenses retained')
