"""External comparison report. Nonzero differences stay visible in results."""
import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image

out, reference = map(Path, sys.argv[1:3])
inputs = json.loads((out / 'inputs.json').read_text())
rows = []
for row in inputs['rows']:
    if 'error' in row:
        rows.append(row)
        print(json.dumps(row))
        continue
    actual = np.asarray(Image.open(out / f"{row['name']}-{row['profile']}.png").convert('RGBA'), dtype=np.int16)
    expected = np.asarray(Image.open(reference / f"{row['name']}.png").convert('RGBA'), dtype=np.int16)
    if actual.shape != expected.shape:
        raise ValueError('Reference geometry mismatch')
    delta = np.abs(actual - expected)
    item = dict(row, differentBytes=int(np.count_nonzero(delta)), differentPixels=int(np.count_nonzero(delta.any(axis=2))), maxChannelDelta=int(delta.max()), meanChannelDelta=float(delta.mean()))
    if row['size']:
        base = np.asarray(Image.open(reference / f"TextureRamp-{row['axis']}-0.png").convert('RGBA'), dtype=float)[:, :, 0]
        valid = (base > 40) & (base < 215) & (expected[:, :, 0] > 12) & (expected[:, :, 0] < 244) & (expected[:, :, 3] == 255) & (actual[:, :, 3] == 255)
        truth = (base - expected[:, :, 0])[valid]
        predicted = (base - actual[:, :, 0])[valid]
        item['displacementR2'] = float(1 - np.sum((truth - predicted) ** 2) / np.sum((truth - truth.mean()) ** 2))
        item['comparisonPixels'] = int(valid.sum())
        field = np.fromfile(out / f"{row['name']}-field.f32", dtype='<f4').reshape(256, 256, 4)
        profile = base.mean(axis=0 if row['axis'] == 'x' else 1)
        slope = np.polyfit(np.arange(256), profile, 1)[0]
        prediction = (-field[:, :, 0 if row['axis'] == 'x' else 1] * slope)[valid]
        item['fieldR2'] = float(1 - np.sum((truth - prediction) ** 2) / np.sum((truth - truth.mean()) ** 2))
    rows.append(item)
    print(json.dumps(item))
controls = [r for r in rows if r['profile'] == 'figma' and r['size'] == 0]
exact_controls = len(controls) == 2 and all(r.get('differentBytes') == 0 for r in controls)
figma_controls = [r for r in rows if r['profile'] == 'figma']
figma_exact = len(figma_controls) == 6 and all(r.get('differentBytes') == 0 for r in figma_controls)
(out / 'results.json').write_text(json.dumps({'scope': 'Frozen 2026-10-08 Figma PNGs; not current-editor or cross-backend acceptance', 'rows': rows, 'requiredGradientControlsExact': exact_controls, 'figmaControlsExact': figma_exact, 'allExact': all(r.get('differentBytes') == 0 for r in rows)}, indent=2))
if not exact_controls:
    raise AssertionError('Measured axis-matrix gradient controls regressed; texture residuals remain separately reported')
if not figma_exact:
    raise AssertionError('Frozen Figma GRAIN/gradient controls must all match exactly')
