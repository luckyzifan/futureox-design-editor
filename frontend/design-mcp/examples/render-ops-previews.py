#!/usr/bin/env python3
"""Encode real VectorEngine CPU RGBA buffers as PNG; does not redraw designs."""
import hashlib
import json
import pathlib
import sys
from PIL import Image
root = pathlib.Path(sys.argv[1]).resolve()
results = []
for source in sorted(root.glob('*/native-cpu.json')):
    metadata = json.loads(source.read_text())
    raw = source.with_suffix('.rgba').read_bytes()
    assert hashlib.sha256(raw).hexdigest() == metadata['sha256']
    output = source.with_suffix('.png')
    Image.frombytes('RGBA', (metadata['width'], metadata['height']), raw).save(output)
    results.append({'file': str(output.relative_to(root)), 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), **metadata})
assert len(results) == 5, 'All five native CPU buffers are required'
(root / 'native-cpu-preview-manifest.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results, indent=2))
