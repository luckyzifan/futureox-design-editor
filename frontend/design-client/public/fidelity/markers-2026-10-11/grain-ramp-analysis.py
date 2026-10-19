#!/usr/bin/env python3
"""Extract and characterize Figma GRAIN displacement fields from the
texture-ramps-2026-10-08 fixtures (256x256 Chrome 1x exports, x/y grayscale
ramps, unclipped texture radius 64, noiseSize 8/16).

Findings recorded 2026-10-11 (see grain-notes.md in this directory):
 1. displacement amplitude ~ +-0.44*radius (p95), independent of noiseSize;
 2. correlation length ~ noiseSize, no positive peaks at multiples (no tiling
    within 64px, unlike frost which tiles at 128px);
 3. radial power spectrum peaks at ~2*noiseSize -> dominant wavelength is 2x
    noiseSize, high-frequency octaves weak/absent; contradicts a strong
    1/0.5/0.25 fBm with base lattice = noiseSize.

Model-selection campaign (grain-model-selection.py + diagnostics below)
concluded 2026-10-11:
 4. NOT any square-lattice value/gradient noise: exhaustive linear LSQ over
    lattice 4..32 x phase x easing x octave combos x rotation (full 0..90 deg)
    caps at R2 ~ 0.45; the pipeline recovers R2 = 1.0000 on simulated
    3-octave Perlin, so the exclusion is sound;
 5. NOT simplex (triangular lattice) either; no curvature alignment to any
    mod-4/8/16 lattice lines (decisive for all bilinear-lattice families);
 6. positive identification: non-stationary narrowband random field —
    radial autocovariance has a Bessel-like negative lobe (zero at 0.93*noiseSize,
    trough -0.11 at 1.25*noiseSize for size 8), spectral peak 2*noiseSize,
    local variance clumping (tile CV 0.32-0.46 vs stationary 0.088, Perlin 0.17,
    blurred white noise 0.48). Consistent with sparse-convolution / Gabor-style
    noise (sin carrier wavelength 2*noiseSize + random localized envelopes),
    NOT with lattice interpolation noise.

Usage: python3 grain-ramp-analysis.py
"""
import numpy as np
from PIL import Image

BASE = "/Users/Apple/project/core/frontend/design-client/public/fidelity/texture-ramps-2026-10-08/"


def gray(name):
    return np.asarray(Image.open(BASE + name).convert("L"), dtype=np.float64)


def displacement(axis, size):
    b = np.asarray(Image.open(BASE + f"TextureRamp-{axis}-0.png").convert("L"), np.float64)
    t = np.asarray(Image.open(BASE + f"TextureRamp-{axis}-{size}.png").convert("L"), np.float64)
    prof = b.mean(axis=0) if axis == "x" else b.mean(axis=1)
    slope = np.polyfit(np.arange(256), prof, 1)[0]
    d = (prof[None, :] - t) / slope if axis == "x" else (prof[:, None] - t) / slope
    valid = (prof > 40) & (prof < 215)
    mask = np.zeros((256, 256), bool)
    if axis == "x":
        mask[:, valid] = True
    else:
        mask[valid, :] = True
    # clamp artifacts: displaced samples that hit the gradient pad ends
    mask &= ~((t < 12) | (t > 244))
    return d, mask, slope, t


def autocorr(a, m, lag, axis):
    if axis == "x":
        A, B, MA, MB = a[:, :-lag], a[:, lag:], m[:, :-lag], m[:, lag:]
    else:
        A, B, MA, MB = a[:-lag, :], a[lag:, :], m[:-lag, :], m[lag:, :]
    num = (np.where(MA, A, 0) * np.where(MB, B, 0)).sum()
    v1 = (np.where(MA, A, 0) ** 2).sum()
    v2 = (np.where(MB, B, 0) ** 2).sum()
    return num / np.sqrt(v1 * v2)


def radial_spectrum(d):
    sub = d[16:240, 16:240].copy()
    sub -= sub.mean()
    P = np.abs(np.fft.fft2(sub)) ** 2
    P[0, 0] = 0
    n = sub.shape[0]
    f = np.fft.fftfreq(n)
    fr = np.sqrt(f[:, None] ** 2 + f[None, :] ** 2)
    bins = np.linspace(0.004, 0.5, 33)
    out = []
    for i in range(len(bins) - 1):
        m = (fr >= bins[i]) & (fr < bins[i + 1])
        out.append(float(P[m].mean()) if m.any() else 0.0)
    arr = np.array(out)
    return (bins[:-1] + bins[1:]) / 2, arr / arr.max()


def main():
    for axis in ("x", "y"):
        for size in (8, 16):
            d, mask, slope, t = displacement(axis, size)
            inner = d[mask]
            q = np.percentile(inner, [1, 5, 25, 50, 75, 95, 99])
            kurt = float(np.mean((inner - inner.mean()) ** 4) / inner.var() ** 2)
            print(f"--- {axis}-ramp noiseSize {size}: slope={slope:+.4f}")
            print(f"  p1..p99: {np.round(q, 2).tolist()}")
            print(f"  robust amplitude (p95-p5)/2 = {(q[5] - q[1]) / 2:.2f} px (radius 64)"
                  f"  kurtosis={kurt:.2f}")
            sub_d, sub_m = d[16:240, 16:240], mask[16:240, 16:240]
            vlist = []
            for i in range(0, 224, 16):
                for j in range(0, 224, 16):
                    m = sub_m[i:i+16, j:j+16]
                    if m.sum() > 100:
                        vlist.append(sub_d[i:i+16, j:j+16][m].var())
            vlist = np.array(vlist)
            print(f"  tile-var CV={vlist.std() / vlist.mean():.3f} "
                  f"(stationary expect ~0.088, perlin ~0.17, blurred-white ~0.48)")
            fill = (sub_d * sub_m).sum() / sub_m.sum()
            r = np.where(sub_m, sub_d, fill) - fill
            lags = [2, 4, 6, 8, 12, 16, 24, 32, 48, 64]
            print("  row-corr: " + ", ".join(f"{l}:{autocorr(r, sub_m, l, 'x'):+.3f}" for l in lags))
            print("  col-corr: " + ", ".join(f"{l}:{autocorr(r, sub_m, l, 'y'):+.3f}" for l in lags))
            freqs, power = radial_spectrum(d)
            top = sorted(zip(power, freqs), reverse=True)[:4]
            print("  spectrum peaks (period px): "
                  + ", ".join(f"{1 / fr:.1f}px p={p:.2f}" for p, fr in top))


if __name__ == "__main__":
    main()
