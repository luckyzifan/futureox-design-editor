#!/usr/bin/env python3
"""Independent integer JFA replay versus exact grid EDT (Pillow/NumPy/SciPy).

This is a diagnostic, not a readback of a GPU stage. Grid EDT is not distance
to a continuous vector boundary; --rounded-rect measures that distinction.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mask',type=Path,required=True)
    parser.add_argument('--rounded-rect',type=float,nargs=5,metavar=('X','Y','W','H','R'))
    parser.add_argument('--output',type=Path,required=True)
    args = parser.parse_args()
    rgba = np.asarray(Image.open(args.mask).convert('RGBA'))
    inside = rgba[:,:,3] > 127
    height, width = inside.shape
    if inside.all() or not inside.any():
        raise ValueError('Probe requires both inside and outside seeds')
    yy, xx = np.indices(inside.shape)
    field = np.stack([xx,yy],axis=-1).astype(np.int64)
    field[inside] = -1
    step = (1 << (max(width,height)-1).bit_length()) // 2
    schedule = []
    while step:
        schedule.append(step)
        score = np.full(inside.shape,np.iinfo(np.int64).max)
        best = np.full_like(field,-1)
        for dy in (-step,0,step):
            for dx in (-step,0,step):
                sy, sx = yy+dy, xx+dx
                valid = (sx>=0)&(sx<width)&(sy>=0)&(sy<height)
                candidate = field[sy.clip(0,height-1),sx.clip(0,width-1)]
                valid &= candidate[:,:,0]>=0
                distance = (xx-candidate[:,:,0])**2+(yy-candidate[:,:,1])**2
                take = valid & (distance<score)
                score[take], best[take] = distance[take], candidate[take]
        field, step = best, step//2
    if np.any(field[:,:,0]<0):
        raise ValueError('JFA did not propagate a seed to every pixel')
    squared = (xx-field[:,:,0])**2+(yy-field[:,:,1])**2
    # Use exact integer differences to the indices chosen by SciPy EDT;
    # no floating-point squared-distance rounding decides equivalence.
    seeds = distance_transform_edt(inside,return_distances=False,return_indices=True)
    exact = (yy-seeds[0])**2+(xx-seeds[1])**2
    mismatch = squared != exact
    distance = np.sqrt(squared)
    result = {'maskSha256':hashlib.sha256(args.mask.read_bytes()).hexdigest(),
              'size':[width,height],'steps':schedule,'threshold':'alpha > 127',
              'gridSquaredDistanceMismatches':int(mismatch.sum()),
              'gridDistanceMaximumError':float(abs(distance-np.sqrt(exact)).max()),
              'mismatchesWithinTwoPixelsOfGridEdge':int(np.count_nonzero(mismatch & (exact<=4))),
              'scope':'Independent replay on this raster mask only; not GPU stage readback or arbitrary-shape proof.'}
    if args.rounded_rect:
        x,y,w,h,r = args.rounded_rect
        if not (0 < r <= min(w,h)/2):
            raise ValueError('Invalid circular rounded rectangle')
        qx, qy = abs(xx+.5-(x+w/2))-(w/2-r), abs(yy+.5-(y+h/2))-(h/2-r)
        continuous = r-np.hypot(np.maximum(qx,0),np.maximum(qy,0))-np.minimum(np.maximum(qx,qy),0)
        region = inside & (continuous>0) & (continuous<16)
        error = abs(distance-.5-continuous)
        result['continuousBoundary'] = {'roundedRect':args.rounded_rect,
            'bandPixels':int(region.sum()),'gridMinusHalfMaximumError':float(error[region].max()),
            'gridMinusHalfMeanError':float(error[region].mean()),
            'boundary':'16 device-pixel interior band; subtracting half a grid pixel does not recover a continuous curved boundary.'}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
