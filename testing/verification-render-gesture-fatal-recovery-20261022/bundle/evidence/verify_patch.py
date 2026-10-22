#!/usr/bin/env python3
"""Verify the bundled patch forward and backward in a temporary Git fixture."""
from pathlib import Path
import hashlib, json, shutil, subprocess, sys, tempfile

bundle = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
manifest = json.loads((bundle / 'manifest.json').read_text())
sha = lambda data: hashlib.sha256(data).hexdigest()
patch = bundle / 'candidate.patch'
assert sha(patch.read_bytes()) == manifest['patchSha256']
with tempfile.TemporaryDirectory(prefix='core-patch-verification-') as temporary:
    tree = Path(temporary) / 'tree'
    shutil.copytree(bundle / 'baseline', tree)
    subprocess.run(['git', 'init', str(tree)], check=True, capture_output=True)
    for change in manifest['changes']:
        target = tree / change['path']
        assert (sha(target.read_bytes()) if target.exists() else None) == change['baselineSha256']
    for args in [('apply', '--check'), ('apply',)]:
        subprocess.run(['git', '-C', str(tree), *args, str(patch)], check=True, capture_output=True)
    for change in manifest['changes']:
        assert sha((tree / change['path']).read_bytes()) == change['sha256']
    for args in [('apply', '--reverse', '--check'), ('apply', '--reverse')]:
        subprocess.run(['git', '-C', str(tree), *args, str(patch)], check=True, capture_output=True)
    for change in manifest['changes']:
        target = tree / change['path']
        assert (sha(target.read_bytes()) if target.exists() else None) == change['baselineSha256']
print(json.dumps({'baseline': manifest['baseline'], 'verifiedFiles': len(manifest['changes']), 'forwardExactBytes': 'passed', 'reverseExactRestoration': 'passed'}, indent=2))
