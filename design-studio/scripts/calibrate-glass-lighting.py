#!/usr/bin/env python3
"""Fit four shared lighting coefficients on measured straight edges.

Requires Pillow, NumPy, SciPy. Never writes production constants or references.
The prospective optics-holdout dataset is deliberately not opened here.
Full PNG acceptance, including corners, remains in compare-figma.py.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.optimize import least_squares

ROOT = Path(__file__).resolve().parents[2]
TRAIN = {'MaterialQA-light-0', 'MaterialQA-light-180',
         'OpticsQA-light-45-0.5-depth-8-2x'}
DYADIC = [0.9375, 2., 0.5, 0.125]


def observations():
    rows = []
    for name in ('material-parameters-2026-10-08', 'optics-2026-10-08'):
        directory = ROOT / 'frontend/design-client/public/fidelity' / name
        for case in json.loads((directory / 'cases.json').read_text()):
            if 'light' not in case['id']:
                continue
            path = directory / case['reference']
            if hashlib.sha256(path.read_bytes()).hexdigest() != case['referenceSha256']:
                raise ValueError(f'Changed reference: {path}')
            glass = case['document']['nodes']['a']['effects'][0]['glass']
            scale = case['options']['view']['zoom']
            pixels = np.asarray(Image.open(path).convert('RGBA'))
            angle = np.deg2rad(glass['lightAngle'])
            direction = np.array([np.sin(angle), -np.cos(angle)])
            edges = [((0,1), lambda d: (int(64*scale), int(16*scale+d))),
                     ((1,0), lambda d: (int(16*scale+d), int(64*scale))),
                     ((0,-1), lambda d: (int(64*scale), int(112*scale-1-d))),
                     ((-1,0), lambda d: (int(112*scale-1-d), int(64*scale)))]
            for normal, location in edges:
                for distance in range(int(20*scale)):
                    x, y = location(distance)
                    rows.append((case['id'], scale, glass['depth'], glass['lightIntensity'],
                                 float(np.dot(normal,direction)), distance, float(pixels[y,x,0])))
    return rows


def predict(parameters, rows):
    width, strength, direction_bias, tint_strength = parameters
    scale, depth, light, dot, distance, _ = np.asarray([r[1:] for r in rows]).T
    distances = (2*distance[:,None]+np.array([1,2]))/(2*scale[:,None])
    edge = np.maximum(1-distances/depth[:,None],0)
    tint = dot[:,None]*light[:,None]*edge**2*tint_strength
    gray = np.where(tint<0,128*(1+tint),128+127*tint)
    rim = np.clip(1-(distances-0.25/scale[:,None])/width,0,1)
    highlight = np.clip(light[:,None]*abs(dot[:,None])**1.5*
                        (strength-direction_bias*dot[:,None])*rim,0,1)
    # Fitting keeps this smooth. Production uses explicit f32 operations and
    # RGBA8 materialization; this surrogate cannot certify exact pixels.
    return ((gray+(255-gray)*highlight)*.9+255*.1).mean(axis=1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    args = parser.parse_args()
    data = observations()
    train = [r for r in data if r[0] in TRAIN]
    fit = least_squares(lambda p:predict(p,train)-np.array([r[-1] for r in train]),
                        [.9,2.1,.3,.16],bounds=([.1,0,-1,0],[2,4,1,.5]),max_nfev=200)
    if not fit.success:
        raise RuntimeError(fit.message)
    result = {'trainingCases':sorted(TRAIN),'fitParameters':fit.x.tolist(),
              'retainedDyadicParameters':DYADIC,'straightEdgeComparisons':[],
              'boundary':'Empirical directional rim plus bevel tint, not a physical BSDF or Figma shader identification. '
                         'Existing diagnostic samples are not blind holdouts. Eight later prospective holdouts are excluded from this fitting script.'}
    for name in dict.fromkeys(r[0] for r in data):
        rows = [r for r in data if r[0] == name]
        actual = np.array([r[-1] for r in rows])
        record = {'id':name,'split':'fit' if name in TRAIN else 'diagnostic'}
        for label, parameters in [('fit',fit.x),('dyadic',DYADIC)]:
            error = abs(predict(parameters,rows)-actual)
            record[label] = {'maximum':float(error.max()),'meanAbsoluteError':float(error.mean())}
        result['straightEdgeComparisons'].append(record)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'output':str(args.output),'fitParameters':fit.x.tolist()}))


if __name__ == '__main__':
    main()
