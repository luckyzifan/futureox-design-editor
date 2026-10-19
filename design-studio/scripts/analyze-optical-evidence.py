#!/usr/bin/env python3
"""Measure original Figma evidence; never rewrite, align or resample references.

Requires Pillow and NumPy. Candidate filtering is an independent 1-D experiment,
not a production renderer or a replacement for strict RGBA comparisons.
"""
import argparse
from collections import Counter
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
REFS = ROOT / 'frontend/design-client/public/fidelity'


def verified_images(directory):
    provenance = json.loads((directory / 'provenance.json').read_text())
    images = {}
    for name, expected in provenance['files'].items():
        if isinstance(expected, dict):
            expected = expected['sha256']
        raw = (directory / name).read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError(f'Reference changed: {directory / name}')
        images[name] = np.asarray(Image.open(directory / name).convert('RGBA'))
    return images, provenance


def verify_probe_parameters():
    checked = 0
    rounded = []
    for directory, name in [('optics-2026-10-08','figma-optics-probes-2026-10-08.json'),
                            ('optics-holdout-2026-10-08','figma-optics-holdout-2026-10-08.json')]:
        probes = {p['name']:p for p in json.loads((ROOT / 'testing/fixtures/design' / name).read_text())['cases']}
        for case in json.loads((REFS / directory / 'cases.json').read_text()):
            probe = probes[case['id']]
            expected = probe['effects'][0]
            effect = case['document']['nodes']['a']['effects'][0]
            if case['figmaNodeId'] != probe['id'] or case['figmaEffects'] != probe['effects']:
                raise ValueError('Descriptive probe metadata does not match the Figma readback')
            if effect['radius'] != expected['radius'] or any(effect['glass'][key] != expected[key]
                    for key in ('depth','refraction','dispersion','lightAngle','lightIntensity')):
                raise ValueError('Rendered effect parameters do not match the Figma readback')
            scale = probe['spec']['scale']
            if (case['options']['width'],case['options']['height'],case['options']['view']['zoom']) != (128*scale,128*scale,scale):
                raise ValueError('Export dimensions do not match the recorded scale')
            authored = probe['spec'].get('radius',0)
            if authored != expected['radius']:
                rounded.append({'id':case['id'],'authoredRadius':authored,'renderedAndReadBackRadius':expected['radius']})
            checked += 1
    return {'checkedCases':checked,'binary32RadiusReadbacks':rounded}


def tent_weight(radius, distance):
    r, d = Fraction(radius), Fraction(distance)
    if not r:
        return Fraction(d == 0)
    def cube(x):
        return max(x, 0) ** 3
    def integral(x):
        return (cube(x+r)-2*cube(x)+cube(x-r))/(6*r*r)
    return integral(d+1)-2*integral(d)+integral(d-1)


def box_widths(sigma, count):
    # Kovesi 2010, equations 3 and 5. Odd centered box widths, sigma=r/2.
    lower = math.floor(math.sqrt(12*sigma*sigma/count + 1))
    lower = max(1, lower - (lower % 2 == 0))
    upper = lower + 2
    passes = round((12*sigma*sigma-count*lower*lower-4*count*lower-3*count)
                   / (-4*lower-4))
    passes = min(count, max(0, passes))
    return [lower]*passes + [upper]*(count-passes)


def blur_candidates():
    images, provenance = verified_images(REFS / 'materials-2026-10-08')
    observed = json.loads((ROOT / 'testing/fixtures/design/figma-material-measurements-2026-10-08.json').read_text())
    result = []
    for row in observed['blur']:
        actual = images[row['id']+'.png'][64, :, 0].astype(float)
        if actual.tolist() != row['redCenterRow']:
            raise ValueError('Stored center row does not match original PNG')
        radius = row['radius']
        for density in (1, 2, 4):
            for model in ('integrated-tent', 'kovesi-3-box', 'kovesi-5-box'):
                values = np.zeros(128*density)
                values[63*density:64*density] = 255
                if radius >= 0.5:
                    if model == 'integrated-tent':
                        r = Fraction(radius)*density
                        reach = math.ceil(r)
                        kernel = [float(tent_weight(r, abs(i))) for i in range(-reach, reach+1)]
                        values = np.convolve(values, kernel, mode='same')
                    else:
                        for width in box_widths(radius*density/2, 3 if model == 'kovesi-3-box' else 5):
                            values = np.convolve(values, np.ones(width)/width, mode='same')
                # Candidate has one final quantization; alternate intermediate
                # quantization graphs are not ruled out by rejecting this one.
                candidate = np.rint(values.reshape(128, density).mean(axis=1))
                error = abs(candidate-actual)
                result.append({'id':row['id'], 'radius':radius, 'model':model,
                               'density':density, 'differentSamples':int(np.count_nonzero(error)),
                               'maximum':int(error.max()), 'absoluteErrorSum':int(error.sum())})
    return {'rows':result, 'referenceArchiveHashes':[a['sha256'] for a in provenance['archives']],
            'boundary':'One-dimensional center rows; sigma=radius/2 and measured layer activation r>=0.5. '
                       'No geometry alignment, no reference normalization; not full-image acceptance.'}


class SvgNoise:
    """Independent SVG 1.1 seed-0 lattice; quintic fade is only a candidate."""
    def __init__(self):
        seed = 1
        def random():
            nonlocal seed
            seed = (seed*16807) % 2147483647
            return seed
        self.perm = np.arange(256)
        self.grad = np.zeros((4,256,2))
        for channel in self.grad:
            for gradient in channel:
                gradient[:] = [(random()%512-256)/256 for _ in range(2)]
                length = np.linalg.norm(gradient)
                if length:
                    gradient /= length
        for i in range(255,0,-1):
            j = random()%256
            self.perm[i], self.perm[j] = self.perm[j], self.perm[i]

    def noise(self, x, y, channel, quintic):
        x, y = x % 256, y % 256
        ix, iy = np.floor(x).astype(int), np.floor(y).astype(int)
        u, v = x-ix, y-iy
        def fade(t):
            return t*t*t*(t*(t*6-15)+10) if quintic else t*t*(3-2*t)
        def dot(dx,dy):
            g = self.grad[channel,self.perm[(self.perm[(ix+dx)%256]+iy+dy)%256]]
            return (u-dx)*g[...,0]+(v-dy)*g[...,1]
        a, b = dot(0,0), dot(0,1)
        top, bottom = a+fade(u)*(dot(1,0)-a), b+fade(u)*(dot(1,1)-b)
        return top+fade(v)*(bottom-top)


def texture_statistics():
    images, _ = verified_images(REFS / 'texture-ramps-2026-10-08')
    yy, xx = np.mgrid[64:192,64:192]
    noise, records = SvgNoise(), []
    for size in (8,16):
        for channel, axis in enumerate('xy'):
            base = images[f'TextureRamp-{axis}-0.png'][64:192,64:192,0].astype(float)
            actual = images[f'TextureRamp-{axis}-{size}.png'][64:192,64:192,0].astype(float)
            # Subtract the observed neutral ramp, retaining a +/-1 byte
            # nominal rounding uncertainty from two 8-bit observations. Unknown
            # dither/encoding errors are additional, so this is not a certified
            # bound on the hidden displacement. Displacement radius
            # 64 maps to signed width 128 in the current schema-5 renderer.
            measured = (actual-base)*256/255/128
            centered = measured-measured.mean()
            power = abs(np.fft.fftshift(np.fft.fft2(centered*np.outer(np.hanning(128),np.hanning(128)))))**2
            frequency = np.fft.fftshift(np.fft.fftfreq(128))
            fy, fx = np.meshgrid(frequency,frequency,indexing='ij')
            record = {'axis':axis,'size':size,'sampleCount':int(measured.size),
                      'mean':float(measured.mean()),'standardDeviation':float(measured.std()),
                      'nominalTwoRoundingBound':2/255,
                      'hiddenDisplacementBoundCertified':False,
                      'powerFrequencyCentroid':float((power*np.hypot(fx,fy)).sum()/power.sum()),
                      'correlationAtLags':{},'candidates':[]}
            for lag in (1,2,4,8,16,32):
                record['correlationAtLags'][str(lag)] = {
                    'x':float(np.corrcoef(centered[:,:-lag].ravel(),centered[:,lag:].ravel())[0,1]),
                    'y':float(np.corrcoef(centered[:-lag].ravel(),centered[lag:].ravel())[0,1])}
            for quintic in (False,True):
                prediction = sum(noise.noise((xx+.5)/size*2**i,(yy+.5)/size*2**i,channel,quintic)*.5**i for i in range(3))*.5
                record['candidates'].append({'model':'SVG lattice + quintic fade' if quintic else 'SVG lattice + cubic fade',
                    'correlation':float(np.corrcoef(measured.ravel(),prediction.ravel())[0,1]),
                    'meanSquaredError':float(((measured-prediction)**2).mean())})
            records.append(record)
    return {'rows':records,'boundary':'Finite quantized ramp inversion, not exact displacement recovery. '
            'Two fixed seed/origin candidates, not an exhaustive noise search; quintic variant is not the complete Perlin 2002 3-D algorithm.'}


def gradient_statistics():
    images, _ = verified_images(REFS / 'gradient-quantization-2026-10-08')
    a = images['GradientQA-red-ramp.png'][32:96,32:96]
    rows = []
    for c, name in ((1,'green'),(2,'blue')):
        channel = a[:,:,c]
        rows.append({'channel':name,'histogram':{str(int(k)):int(v) for k,v in Counter(channel.ravel()).items()},
                     'lagMismatchFractions':{str(lag):{'x':float(np.mean(channel[:,:-lag]!=channel[:,lag:])),
                                                     'y':float(np.mean(channel[:-lag]!=channel[lag:]))} for lag in (1,2,4,8,16,32)}})
    return {'constantEndpointChannelsInChangingRedRamp':rows,
            'boundary':'Spatial changes alone do not identify error diffusion, ordered dither, a noise table, or the quantization stage. No dither was added to production.'}


def frost_statistics():
    images, _ = verified_images(REFS / 'optics-2026-10-08')
    cases = json.loads((REFS / 'optics-2026-10-08/cases.json').read_text())
    result = []
    for scale in (1,2,4):
        groups = {}
        for case in cases:
            spec = case['probe']
            if spec['family'] != 'frost' or spec['scale'] != scale:
                continue
            image = images[case['reference']]
            if image.shape[:2] != (128*scale,128*scale):
                raise ValueError('Unexpected original export dimensions')
            groups.setdefault(hashlib.sha256(image.tobytes()).hexdigest(),[]).append(spec['radius'])
        zero = images[f'OpticsQA-frost-0-{scale}x.png']
        one = images[f'OpticsQA-frost-1-{scale}x.png']
        result.append({'scale':scale,'identicalRgbaGroups':list(groups.values()),
                       'zeroVsOneDifferentBytes':int(np.count_nonzero(zero!=one)),
                       'zeroVsOneCenterRowDifferentBytes':int(np.count_nonzero(zero[64*scale]!=one[64*scale]))})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    args = parser.parse_args()
    result = {'scope':'Independent measurements and candidate rejection; no full-image or private-algorithm equivalence claim.',
              'probeParameters':verify_probe_parameters(),
              'frost':frost_statistics(),'blurCandidates':blur_candidates(),
              'texture':texture_statistics(),'gradient':gradient_statistics()}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'output':str(args.output),'blurComparisons':len(result['blurCandidates']['rows']),
                      'textureMeasurements':len(result['texture']['rows'])}))


if __name__ == '__main__':
    main()
