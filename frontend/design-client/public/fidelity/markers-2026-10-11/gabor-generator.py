#!/usr/bin/env python3
"""Reference GRAIN generator prototype.

Model (parameters fitted 2026-10-11 from the texture-ramps fixtures; tuned
so the statistical fingerprint matches the measured displacement fields):
    d_channel(x, y) = sum_k a_k * cos(2*pi*f*(u_k . (p - c_k)) + phi_k)
                              * W(p - c_k; u_k)
with
    f      = 1 / (2.2 * noiseSize)             carrier wavelength ~2.2*S
    W      = Hann window (support 3*sigma), elongated along the carrier:
             sigma_along ~ 0.62*S, sigma_across ~ 0.56*S
    c_k    jittered dense grid, spacing ~ S/2
    u_k    uniform random orientation
    a_k    gaussian amplitude (fitted fingerprint prefers gaussian; the
            per-image LSQ fit of amplitudes is platykurtic, in between)
    output scale: displacement std = radius / 4  (=> p95 ~ +-0.41*radius,
             matches measured +-26px at radius 64)

Fingerprint comparison (radial autocorr vs measured, tuned err 0.048):
    gen:    +1.000 +0.943 +0.802 +0.604 +0.387 +0.185 +0.023 -0.084 -0.138 ...
    target: +1.000 +0.902 +0.758 +0.582 +0.407 +0.250 +0.121 +0.020 -0.051 ...

This prototype uses a placeholder PRNG (numpy) for a/phi/u/jitter; its
purpose is to reproduce the STATISTICAL FINGERPRINT of the GRAIN
displacement field, not any vendor's exact bytes.

Run: python3 gabor-generator.py   (prints fingerprint + saves sample PNG)
"""
import numpy as np
from PIL import Image

S = 8.0        # noiseSize
R = 64.0       # radius
SPACING = 4.0
CARRIER = 2.2 * S
SIGMA_ALONG = 5.0
SIGMA_ACROSS = 4.5
SUPPORT = 3.0
TARGET_STD = R / 4.0


def grain_field(w, h, seed=0, spacing=SPACING, carrier=CARRIER,
                s_along=SIGMA_ALONG, s_across=SIGMA_ACROSS, amp="gauss"):
    rng = np.random.default_rng(seed)
    cx = np.arange(spacing / 2, w, spacing)
    cy = np.arange(spacing / 2, h, spacing)
    CX, CY = np.meshgrid(cx, cy)
    cx = CX.ravel() + rng.uniform(-spacing / 2, spacing / 2, CX.size)
    cy = CY.ravel() + rng.uniform(-spacing / 2, spacing / 2, CY.size)
    theta = rng.uniform(0, np.pi, cx.size)
    if amp == "gauss":
        a = rng.normal(0, 0.45, cx.size)
    else:
        a = rng.uniform(-1, 1, cx.size)
    phi = rng.uniform(0, 2 * np.pi, cx.size)

    out = np.zeros((h, w))
    Y, X = np.mgrid[0:h, 0:w].astype(float)
    f = 1.0 / carrier
    cut = SUPPORT * max(s_along, s_across)
    for k in range(cx.size):
        gx = X - cx[k]
        gy = Y - cy[k]
        if gx.max() < -cut or gx.min() > cut or gy.max() < -cut or gy.min() > cut:
            continue
        u0, u1 = np.cos(theta[k]), np.sin(theta[k])
        al = gx * u0 + gy * u1
        ac = -gx * u1 + gy * u0
        rr = np.sqrt((al / s_along) ** 2 + (ac / s_across) ** 2)
        wgt = np.where(rr < SUPPORT, 0.5 * (1 + np.cos(np.pi * rr / SUPPORT)), 0.0)
        out += a[k] * np.cos(2 * np.pi * f * al + phi[k]) * wgt
    return out / out.std() * TARGET_STD


def fingerprint(v):
    inner = v[32:224, 32:224].ravel()
    print(f"  p5={np.percentile(inner,5):+.1f} p95={np.percentile(inner,95):+.1f} "
          f"(target ~ +-26)  kurtosis={np.mean((inner-inner.mean())**4)/inner.var()**2:.2f} (target 2.7-2.8)")
    d = v - v.mean()
    ac = []
    for lag in range(13):
        vals = [float((d[max(0,-dy):d.shape[0]-max(0,dy), 0:d.shape[1]-lag]
                       * d[max(0,dy):d.shape[0]-max(0,-dy), lag:]).mean())
                for dy in range(-lag, lag + 1)]
        ac.append(np.mean(vals) / d.var())
    print("  radial ac: " + " ".join(f"{x:+.2f}" for x in ac))
    print("  target   : +1.00 +0.90 +0.76 +0.58 +0.41 +0.25 +0.12 +0.02 -0.05 -0.09 -0.11 -0.11 -0.10")
    tiles = [v[i:i+16, j:j+16].var() for i in range(0, 240, 16) for j in range(0, 240, 16)]
    print(f"  tile-var CV={np.std(tiles)/np.mean(tiles):.3f} (target 0.33-0.45)")
    P = np.abs(np.fft.fft2(v - v.mean())) ** 2
    P[0, 0] = 0
    fq = np.fft.fftfreq(v.shape[0])
    fr = np.sqrt(fq[:, None] ** 2 + fq[None, :] ** 2)
    band = (fr > 0.03) & (fr < 0.16)
    fpk = fr[np.unravel_index(np.argmax(np.where(band, P, 0)), P.shape)]
    print(f"  spectrum peak wavelength = {1/fpk:.1f}px (target ~17)")


if __name__ == "__main__":
    field = grain_field(256, 256, seed=42)
    print("generator fingerprint (noiseSize=8, radius=64):")
    fingerprint(field)
    vis = np.clip(128 + field / (field.std() * 4) * 120, 0, 255).astype(np.uint8)
    Image.fromarray(vis).save("gabor-generator-sample.png")
    print("sample saved: gabor-generator-sample.png")
