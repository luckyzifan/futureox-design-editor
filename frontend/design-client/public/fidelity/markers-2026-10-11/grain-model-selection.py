#!/usr/bin/env python3
"""Linear least-squares model selection for Figma GRAIN noise structure.

Fits displacement fields extracted from texture-ramps-2026-10-08 against
lattice noise models. Both value noise and Perlin-style gradient noise are
LINEAR in their node parameters, so octave sets, lattice size, phase and the
easing function can be compared by residual + BIC directly.

Model:  d(x,y) = A * sum_o F_o(x,y) + c
        F_o value noise    : sum_corners v[i,j] * e(fx) * e(fy)
        F_o gradient noise : sum_corners (gx*dx + gy*dy) * e(fx) * e(fy)
Run:    python3 grain-model-selection.py
"""
import numpy as np
from PIL import Image
from scipy.sparse import csr_matrix, hstack
from scipy.sparse.linalg import lsqr

BASE = "/Users/Apple/project/core/frontend/design-client/public/fidelity/texture-ramps-2026-10-08/"


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
    mask[:16] = mask[-16:] = False
    mask[:, :16] = mask[:, -16:] = False
    ys, xs = np.nonzero(mask)
    return d[mask], ys + 0.5, xs + 0.5  # pixel centers in doc px


def ease(t, kind):
    if kind == "smooth":
        return t * t * (3 - 2 * t)
    return t * t * t * (t * (t * 6 - 15) + 10)  # quintic


def build_design(ys, xs, octaves_spec, kind, grad):
    """octaves_spec: list of (L, phase). Returns sparse design matrix."""
    n = len(xs)
    blocks = []
    for (L, phase) in octaves_spec:
        qx = (xs - phase) / L
        qy = (ys - phase) / L
        ix = np.floor(qx).astype(np.int64)
        iy = np.floor(qy).astype(np.int64)
        fx = qx - ix
        fy = qy - iy
        rows_list, cols_list, vals_list = [], [], []
        # coordinate compression for node ids
        allx, ally = [], []
        for cx, cy in ((0, 0), (1, 0), (0, 1), (1, 1)):
            nx, ny = ix + cx, iy + cy
            allx.append(nx)
            ally.append(ny)
        nx_min = min(a.min() for a in allx)
        ny_min = min(a.min() for a in ally)
        ny_span = int(max(a.max() for a in ally) - ny_min + 1)
        for (cx, cy), nx, ny in zip(((0, 0), (1, 0), (0, 1), (1, 1)), allx, ally):
            wx = ease(fx if cx == 0 else 1 - fx, kind)
            wy = ease(fy if cy == 0 else 1 - fy, kind)
            w = wx * wy
            nid = (nx - nx_min) * ny_span + (ny - ny_min)
            if not grad:
                rows_list.append(np.arange(n))
                cols_list.append(nid)
                vals_list.append(w)
            else:
                dx = fx - cx
                dy = fy - cy
                rows_list.append(np.arange(n)); cols_list.append(2 * nid); vals_list.append(w * dx)
                rows_list.append(np.arange(n)); cols_list.append(2 * nid + 1); vals_list.append(w * dy)
        width = (2 * int(max(a.max() for a in allx) - nx_min + 1) * ny_span) if grad \
            else int(max(a.max() for a in allx) - nx_min + 1) * ny_span
        rows = np.concatenate(rows_list)
        cols = np.concatenate(cols_list)
        vals = np.concatenate(vals_list)
        blocks.append(csr_matrix((vals, (rows, cols)), shape=(n, width)))
    blocks.append(csr_matrix(np.ones((n, 1))))
    return hstack(blocks).tocsr()


def fit(A, d):
    x = lsqr(A, d, atol=1e-12, btol=1e-12, iter_lim=6000)[0]
    resid = d - A @ x
    return x, float(resid @ resid)


def main():
    d, ys, xs = displacement("x", 8)
    n = len(d)
    tss = float(d @ d)
    print(f"pixels: {n}, field std: {d.std():.3f}, total SS: {tss:.1f}")

    results = []
    for kind in ("smooth", "quintic"):
        for grad in (False, True):
            for phase in (0.0, 0.5):
                for L in (4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32):
                    A = build_design(ys, xs, [(L, phase)], kind, grad)
                    _, rss = fit(A, d)
                    k = A.shape[1]
                    bic = n * np.log(rss / n) + k * np.log(n)
                    results.append((bic, rss, kind, grad, phase, L, k))
    results.sort()
    print("\n=== single-octave scan (top 15 by BIC) ===")
    print(f"{'BIC':>14} {'RMSEpx':>8} {'R2':>7} {'interp':>7} {'type':>5} {'ph':>3} {'L':>3} {'k':>5}")
    for bic, rss, kind, grad, phase, L, k in results[:15]:
        print(f"{bic:14.1f} {np.sqrt(rss/n):8.3f} {1-rss/tss:7.4f} {kind:>7} {'grad' if grad else 'val':>5} {phase:3.1f} {L:3d} {k:5d}")

    _, _, kind, grad, phase, L0, _ = results[0]
    print(f"\n=== octave combos around L0={L0} ({kind}, {'grad' if grad else 'value'}, phase={phase}) ===")
    L0f = float(L0)
    combos = [
        [(L0f, phase)],
        [(2 * L0f, phase)],
        [(L0f, phase), (L0f / 2, phase)],
        [(2 * L0f, phase), (L0f, phase)],
        [(2 * L0f, phase), (L0f, phase), (L0f / 2, phase)],
        [(L0f, phase), (L0f / 2, phase), (L0f / 4, phase)],   # current kernel model shape
        [(4 * L0f, phase), (2 * L0f, phase)],
    ]
    for spec in combos:
        A = build_design(ys, xs, spec, kind, grad)
        k = A.shape[1]
        _, rss = fit(A, d)
        bic = n * np.log(rss / n) + k * np.log(n)
        desc = "+".join(str(l) for l, _ in spec)
        print(f"  {desc:>18}: RMSE={np.sqrt(rss/n):7.3f}px  R2={1-rss/tss:6.4f}  k={k:5d}  BIC={bic:12.1f}")


if __name__ == "__main__":
    main()
