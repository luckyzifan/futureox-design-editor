#!/usr/bin/env python3
"""Build reproducible probes and measure untouched real Figma PNG exports.

This is calibration evidence, not an assertion that Figma uses our filter or
noise algorithm. Approximate glass/texture mappings cannot count as fidelity
passes. No image is aligned, resampled or modified before measurement.
"""
import copy
from fractions import Fraction
import hashlib
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
REFS = ROOT / 'frontend/design-client/public/fidelity/materials-2026-10-08'
FIXTURES = ROOT / 'testing/fixtures/design'


def load(name):
    return json.loads((FIXTURES / name).read_text())


def solid(color, opacity=1):
    return {'kind': 'solid', 'color': color, 'opacity': opacity}


def rectangle(name, x, y, width, height, color):
    return {'id': name, 'kind': 'rectangle', 'width': width, 'height': height,
            'transform': [1, 0, 0, 1, x, y], 'fills': [solid(color)]}


def png(name):
    return Image.open(REFS / (name + '.png')).convert('RGBA')


def differences(a, b):
    x, y = a.tobytes(), b.tobytes()
    assert a.size == b.size
    d = [abs(v-w) for v, w in zip(x, y)]
    return {'differentBytes': sum(v != 0 for v in d), 'maximum': max(d)}


def tent(radius, distance):
    if not radius:
        return Fraction(distance == 0)
    # Independent exact box-spline integral in rational arithmetic.
    def cube(v):
        return max(v, 0) ** 3
    def primitive(x):
        return (cube(x+radius)-2*cube(x)+cube(x-radius))/(6*radius**2)
    return primitive(distance+1)-2*primitive(distance)+primitive(distance-1)


def main():
    metadata = load('figma-material-probes-2026-10-07.json')
    twins = load('figma-texture-twin-2026-10-08.json')
    for field in ('effects', 'fill', 'transform', 'width', 'height'):
        assert twins[0][field] == twins[1][field], field
    metadata['materials'].append(twins[1])
    provenance = json.loads((REFS / 'provenance.json').read_text())
    for name, expected in provenance['files'].items():
        assert hashlib.sha256((REFS/name).read_bytes()).hexdigest() == expected, name
    cases, blur_rows = [], []
    for probe in metadata['materials'] + metadata['blur']:
        name = probe['name']
        is_blur = name.startswith('BlurQA-')
        color = '#000000' if is_blur else '#808080' if probe.get('background') == 'gray' else '#ffffff'
        nodes = {'frame': {'id': 'frame', 'kind': 'frame', 'width': 128, 'height': 128,
                           'clip': True, 'fills': [solid(color)], 'children': []}}
        if probe.get('background') == 'stripes':
            for i in range(16):
                key = f'stripe-{i}'
                nodes[key] = rectangle(key, 8*i, 0, 8, 128, ['#ff0000', '#00ff00', '#0000ff', '#ffffff'][i % 4])
                nodes['frame']['children'].append(key)
        t = probe['transform']
        node = rectangle('a', t[0][2], t[1][2], probe['width'], probe['height'], '#ffffff')
        note, strict = '', True
        fx = probe['effects'][0] if probe['effects'] else None
        if is_blur:
            radius = fx['radius'] if fx else 0
            node['effects'] = [{'kind': 'blur', 'radius': radius, 'color': '#000000'}] if radius else []
            image = png(name)
            actual = [image.getpixel((x, 64))[0] for x in range(128)]
            expected = [round(255*tent(Fraction(radius), abs(x-63))) for x in range(128)]
            blur_rows.append({'id': name, 'radius': radius, 'redCenterRow': actual,
                              'integratedTentRneCenterRow': expected,
                              'differentCenterSamples': sum(a != b for a, b in zip(actual, expected)),
                              'maximumCenterDifference': max(abs(a-b) for a, b in zip(actual, expected)),
                              'asymmetricPairs': sum(actual[63-i] != actual[63+i] for i in range(1, 64))})
        elif probe['kind'] == 'glass':
            node['fills'][0]['opacity'] = probe['fill'][0]['opacity']
            node['radii'] = [probe['radius']]*4
            strict = fx['refraction'] == fx['dispersion'] == fx['lightIntensity'] == 0
            node['effects'] = [{'kind': 'glass', 'radius': fx['radius'],
                                'amount': fx['depth']*fx['refraction'],
                                'opacity': fx['lightIntensity'], 'color': '#000000'}]
            note = ('Common zero-refraction, zero-light, zero-dispersion subset.' if strict else
                    'Approximate diagnostic mapping only: amount=depth*refraction, opacity=lightIntensity; independent depth, dispersion and lightAngle are not implemented by this kernel schema.')
        else:
            node['fills'] = [{'kind': 'linear', 'color': '#4477dd', 'angle': 45,
                              'opacity': 1, 'stops': [{'offset': 0, 'color': '#4477dd'},
                                                     {'offset': 1, 'color': '#dd7744'}]}]
            node['effects'] = [{'kind': 'texture', 'radius': 0, 'amount': fx['radius'],
                                'opacity': 1, 'color': '#000000'}]
            strict = fx['radius'] == 0
            note = ('Zero displacement neutral control.' if strict else
                    'Approximate diagnostic mapping only: noiseSizeVector and clipToShape are not implemented; current kernel noise differs from Figma.')
        nodes['a'] = node
        nodes['frame']['children'].append('a')
        cases.append({'id': name, 'strictComparable': strict, 'mappingNote': note,
                      'figmaNodeId': probe['id'], 'figmaEffects': copy.deepcopy(probe['effects']),
                      'document': {'schemaVersion': 4, 'id': name, 'name': name,
                                   'pages': [{'id': 'p', 'name': 'Page', 'background': color, 'children': ['frame']}],
                                   'nodes': nodes},
                      'options': {'pageId': 'p', 'width': 128, 'height': 128,
                                  'view': {'x': 0, 'y': 0, 'zoom': 1}, 'transparent': False},
                      'reference': name+'.png', 'referenceSha256': provenance['files'][name+'.png']})
    pair_names = [('texture-size-8', 'texture-size-8-twin'),
                  ('texture-size-8', 'texture-unclipped'),
                  ('texture-size-8', 'texture-anisotropic'),
                  ('depth-1', 'depth-8'), ('depth-8', 'depth-24'),
                  ('depth-8', 'dispersion-half'), ('glass-neutral', 'light-0')]
    report = {'provenance': provenance, 'scope': 'Measured 33 real browser exports; no proprietary algorithm claim.',
              'blur': blur_rows,
              'materialPairs': [{'a': a, 'b': b, **differences(png('MaterialQA-'+a), png('MaterialQA-'+b))} for a, b in pair_names],
              'limitations': ['PNG quantization cannot identify intermediate float precision.',
                              'One translation-equivalent texture pair does not prove a global noise seed rule.',
                              'Integrated tent RNE is a candidate model, not Figma ground truth; every nonzero difference remains a failure.']}
    (REFS / 'cases.json').write_text(json.dumps(cases, ensure_ascii=False, indent=2)+'\n')
    (FIXTURES / 'figma-material-measurements-2026-10-08.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'cases': len(cases), 'strictCases': sum(c['strictComparable'] for c in cases),
                      'blurRowsDifferingFromCandidate': sum(r['differentCenterSamples'] > 0 for r in blur_rows),
                      'pairs': report['materialPairs']}))


if __name__ == '__main__':
    main()
