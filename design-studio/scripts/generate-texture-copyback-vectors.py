#!/usr/bin/env python3
"""Synthetic Q4 sampling + source-over controls using an exact Fraction oracle."""
import argparse
from fractions import Fraction
import importlib.util
import json
from pathlib import Path
import random

ROOT = Path(__file__).resolve().parents[2]
DESTINATION = ROOT / 'testing/fixtures/design/texture-copyback-vectors.json'
spec = importlib.util.spec_from_file_location('precision_oracle', Path(__file__).with_name('generate-precision-vectors.py'))
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)


def data():
    rng = random.Random(20261009)
    rows = []
    for _ in range(128):
        pixels = []
        for _ in range(4):
            alpha = rng.randrange(256)
            pixels.append([rng.randrange(alpha + 1) for _ in range(3)] + [alpha])
        alpha = rng.randrange(256)
        destination = [rng.randrange(alpha + 1) for _ in range(3)] + [alpha]
        wx, wy = rng.randrange(257), rng.randrange(257)
        # A 2x2 texture at u=(wx/256+.5)/2 has exact Q8 x weight wx.
        uv_bits = [oracle.binary32(Fraction(w, 512) + Fraction(1, 4)) for w in (wx, wy)]
        sample = []
        for c in range(4):
            value = (pixels[0][c] * (256 - wx) * (256 - wy)
                     + pixels[1][c] * wx * (256 - wy)
                     + pixels[2][c] * (256 - wx) * wy
                     + pixels[3][c] * wx * wy)
            # Independent exact rational quantization, halfway upward.
            q = (Fraction(value, 4096) + Fraction(1, 2)).__floor__()
            sample.append(oracle.binary32(Fraction(q, 4080)))
        inverse_alpha = oracle.exact(oracle.binary32(1 - oracle.exact(sample[3])))
        output = []
        premature = []
        rounded_source = [oracle.nearest_integer(255 * oracle.exact(v)) for v in sample]
        for c in range(4):
            dst = oracle.exact(oracle.binary32(Fraction(destination[c], 255)))
            blended = oracle.exact(oracle.binary32(dst * inverse_alpha + oracle.exact(sample[c])))
            output.append(oracle.nearest_integer(255 * min(Fraction(1), blended)))
            early_src = oracle.exact(oracle.binary32(Fraction(rounded_source[c], 255)))
            early_alpha = oracle.exact(oracle.binary32(1 - oracle.exact(oracle.binary32(Fraction(rounded_source[3], 255)))))
            early = oracle.exact(oracle.binary32(dst * early_alpha + early_src))
            premature.append(oracle.nearest_integer(255 * min(Fraction(1), early)))
        rows.append(dict(pixels=pixels, uvBits=uv_bits, destination=destination,
                         sampleBits=sample, expected=output, prematurelyStored=premature))
    return dict(scope='128 deterministic synthetic 2x2 textures; Fraction sampling, binary32 FMA and exact UNORM8. No reference-image data.',
                cases=rows)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    text = json.dumps(data(), indent=2) + '\n'
    if args.check:
        if DESTINATION.read_text() != text:
            raise SystemExit('Texture copyback vectors differ; investigate before updating')
        print('128 texture copyback vectors unchanged')
    else:
        DESTINATION.write_text(text)
        print(DESTINATION.relative_to(ROOT))
