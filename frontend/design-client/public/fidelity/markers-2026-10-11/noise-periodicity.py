#!/usr/bin/env python3
"""Measure lattice periodicity in Figma reference PNGs.

High-pass filters the image (2px box residual), then reports the
row/column-averaged autocorrelation at a set of lags. A tiled noise field
shows up as clearly elevated correlation at multiples of its period and
near-zero elsewhere; lag-1-around-period going negative is the lattice
signature. Used 2026-10-11 to confirm the 128px base period in the frost
4x references and to probe Board B's large blur exports for the 256px
noise Bjango measured in-app.

Usage: python3 noise-periodicity.py <image.png> [image2.png ...]
"""
import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def periodicity(path):
    im = np.asarray(Image.open(path).convert("L"), dtype=np.float64)
    h, w = im.shape
    if h < 300 or w < 300:
        return None
    pad = np.pad(im, 1, mode="edge")
    box = (
        pad[:-2, :-2] + pad[:-2, 1:-1] + pad[:-2, 2:]
        + pad[1:-1, :-2] + pad[1:-1, 1:-1] + pad[1:-1, 2:]
        + pad[2:, :-2] + pad[2:, 1:-1] + pad[2:, 2:]
    ) / 9.0
    r = im - box
    r = r - r.mean()
    var = (r * r).mean()
    if var <= 0:
        return None

    def ac(lag):
        if lag == 0:
            return 1.0
        return (r[:, : w - lag] * r[:, lag:]).mean() / var

    lags = sorted({64, 96, 128, 160, 192, 240, 255, 256, 257, 264, 288, 320, 384, 448, 512, 640})
    lags = [l for l in lags if 0 < l < min(h, w)]
    return {l: round(float(ac(l)), 4) for l in lags}


def main():
    for path in sys.argv[1:]:
        out = periodicity(path)
        if out is None:
            print(f"{path}: <300px per side, cannot test 256 period; skipped")
            continue
        peak = max(
            (abs(v) for l, v in out.items() if l % 256 == 0),
            default=0.0,
        )
        other = [abs(v) for l, v in out.items() if l % 256 != 0 and abs(l - 255) > 0 and abs(l - 257) > 0]
        print(f"{path}:")
        print(f"  {out}")
        print(f"  256-multiple peaks vs others: {peak:.3f} vs {max(other) if other else 0:.3f}")


if __name__ == "__main__":
    main()
