#!/usr/bin/env python3
"""Replay the five immutable component patches in an isolated temporary tree."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile

bundle = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
composition = json.loads((bundle / 'evidence' / 'combined-composition.json').read_text())
sha = lambda data: hashlib.sha256(data).hexdigest()
adjustments = {
    'pose-lifecycle-diagnostics-v2.patch': (
        ' const imageFieldRegionLimits = {imageFieldRegionPath:2,imageFieldRegionOutcome:2,imageFieldRegionCount:1e9,\n',
        ' const imageFieldRegionLimits = {imageFieldCallsite:7,imageFieldStage:5,imageFieldOutcome:3,imageFieldAxes:2,imageFieldSample:4,imageFieldLevel:32,\n',
    ),
    '09e6-surface-budget-diagnostics-v2.patch': (
        '               field = this.imageGrid(regionNode, regionPaint, image, level)\n',
        '               field = this.imageGrid(regionNode, regionPaint, image, level, [0, 0], undefined, 4)\n',
    ),
}
with tempfile.TemporaryDirectory(prefix='core-09e6-composition-') as temporary:
    tree = Path(temporary) / 'tree'
    shutil.copytree(bundle / 'baseline', tree)
    subprocess.run(['git', 'init', str(tree)], check=True, capture_output=True)
    for relative, expected in composition['baseHashes'].items():
        target = tree / relative
        assert (sha(target.read_bytes()) if target.exists() else None) == expected, relative
    for record in composition['patches']:
        patch = bundle / record['path']
        original = patch.read_bytes()
        assert sha(original) == record['sha256'], patch.name
        adjusted = original.decode()
        if patch.name in adjustments:
            before, after = adjustments[patch.name]
            assert adjusted.count(before) == 1, patch.name
            adjusted = adjusted.replace(before, after)
            # Both transforms change only context, never added/deleted source.
            source_lines = lambda text: [line for line in text.splitlines() if line.startswith(('+', '-'))]
            assert source_lines(adjusted) == source_lines(original.decode())
        derived = Path(temporary) / patch.name
        derived.write_text(adjusted)
        for args in [('apply', '--check'), ('apply',)]:
            subprocess.run(['git', '-C', str(tree), *args, str(derived)], check=True, capture_output=True)
    for relative, expected in composition['files'].items():
        assert sha((tree / relative).read_bytes()) == expected, relative
        assert (tree / relative).read_bytes() == (bundle / 'source' / relative).read_bytes(), relative
print(json.dumps({'baseline': composition['baseline'], 'patches': len(composition['patches']), 'matchedFiles': len(composition['files']), 'contextOnlyAdjustments': len(adjustments), 'changedSourceLinesInAdjustments': 0, 'result': 'passed'}, indent=2))
