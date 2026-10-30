#!/usr/bin/env python3
"""Independent exact-rational, single-round bilinear interpolation fixtures."""
import argparse
import importlib.util
import json
from pathlib import Path
import random

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('rounding_oracle', Path(__file__).with_name('generate-precision-vectors.py'))
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
DESTINATION = ROOT / 'testing/fixtures/design/sampling-vectors.json'


def corpus():
    rng = random.Random(20261008)
    rows = []
    def add(p, u, v):
        a, b, c, d = map(oracle.exact, p)
        x, y = oracle.exact(u), oracle.exact(v)
        value = a * (1-x) * (1-y) + b * x * (1-y) + c * (1-x) * y + d * x * y
        rows.append([*p, u, v, oracle.binary32(value)])
    fractions = [0, 1, 0x7fffff, 0x800000, 0x2f7fffff, 0x3dcccccd,
                 0x3eaaaaab, 0x3effffff, 0x3f000000, 0x3f000001, 0x3f7fffff, 0x3f800000]
    patterns = [[0x4083f34d] * 4, [0xbe4ccccd] * 4, [0x80000000] * 4,
                [0, 1, 0x80000001, 0x800000],
                [0x7f7fffff, 0xff7fffff, 0x3f800000, 0xbf800000],
                [0x3f800000, 0xbf800000, 0xbf800000, 0x3f800000],
                [0, 0x3f800000, 0x40000000, 0x40800000]]
    for p in patterns:
        for u in fractions:
            for v in fractions:
                add(p, u, v)
    for _ in range(4000):
        p = [rng.randrange(0x7f800000) | (rng.randrange(2) << 31) for _ in range(4)]
        add(p, rng.randrange(0x3f800001), rng.randrange(0x3f800001))
    # Common image samples, near cancellation and quantization boundaries.
    for _ in range(2000):
        p = [oracle.binary32(oracle.Fraction(rng.randrange(-1000, 1001), 37)) for _ in range(4)]
        add(p, oracle.binary32(oracle.Fraction(rng.randrange(1025), 1024)),
            oracle.binary32(oracle.Fraction(rng.randrange(1025), 1024)))
    return {'version': 1, 'contract': 'Exact bilinear of finite f32 samples and f32 u/v in [0,1], one RNE; exact zero canonical +0', 'vectors': rows}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    data = json.dumps(corpus(), separators=(',', ':')) + '\n'
    if args.check:
        if DESTINATION.read_text() != data:
            raise SystemExit('Bilinear oracle fixtures are stale')
    else:
        DESTINATION.write_text(data)
    print(f'{len(json.loads(data)["vectors"])} exact bilinear vectors')
