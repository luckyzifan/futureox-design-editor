use crate::path::Contour;

pub fn backdrop_box(bounds: Option<crate::bounds::Bounds>, limit: crate::math::Rect) -> [f64; 4] {
    let Some(bounds) = bounds else {
        return [
            f64::from(limit.x),
            f64::from(limit.y),
            f64::from(limit.w),
            f64::from(limit.h),
        ];
    };
    // Establish the GPU-compatible fractional origin once, before clipping.
    // Re-rounding a translated crop origin changes its texel phase at powers
    // of two and makes tiled filtering disagree with a full-frame render.
    let mut lo = [f64::from(bounds.x as f32), f64::from(bounds.y as f32)];
    let mut hi = [lo[0] + bounds.width, lo[1] + bounds.height];
    // Preserve the object's fractional texel phase even when the view clips it.
    lo[0] += (f64::from(limit.x) - lo[0]).max(0.).floor();
    lo[1] += (f64::from(limit.y) - lo[1]).max(0.).floor();
    hi[0] = hi[0].min(f64::from(limit.right()));
    hi[1] = hi[1].min(f64::from(limit.bottom()));
    [
        lo[0],
        lo[1],
        (hi[0] - lo[0]).ceil().max(1.),
        (hi[1] - lo[1]).ceil().max(1.),
    ]
}

/// Recognize an exact axis-aligned rectangle, without rounding or an epsilon
/// that could flatten a deliberately small rotation. Open paths and holes are
/// excluded. Bounds are edges, not x/y/width/height, to avoid cancellation when
/// large shapes are clipped into a small viewport.
pub fn rectangle(cs: &[Contour]) -> Option<[f64; 4]> {
    if cs.len() != 1 || !cs[0].closed {
        return None;
    }
    let mut points = [crate::math::Point::default(); 5];
    let mut count = 0;
    for &p in &cs[0].points {
        if count > 0 && points[count - 1] == p {
            continue;
        }
        if count == 5 {
            return None;
        }
        points[count] = p;
        count += 1;
    }
    if count == 5 && points[0] == points[4] {
        count = 4;
    }
    let ps = &points[..count];
    if ps.len() != 4 || ps.iter().any(|p| !p.finite()) {
        return None;
    }
    let x0 = ps.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
    let y0 = ps.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
    let x1 = ps.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
    let y1 = ps.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let mut corners = 0u8;
    for (i, a) in ps.iter().enumerate() {
        let b = ps[(i + 1) % 4];
        if (a.x != b.x && a.y != b.y) || *a == b {
            return None;
        }
        if (a.x != x0 && a.x != x1) || (a.y != y0 && a.y != y1) {
            return None;
        }
        corners |= 1 << ((u8::from(a.x == x1)) + 2 * u8::from(a.y == y1));
    }
    (corners == 15).then_some([x0, y0, x1, y1])
}
pub fn rectangle_pixel([x0, y0, x1, y1]: [f64; 4], x: f64, y: f64) -> f64 {
    ((x + 1.).min(x1) - x.max(x0)).clamp(0., 1.) * ((y + 1.).min(y1) - y.max(y0)).clamp(0., 1.)
}

/// Reproduce the measured coverage transition of an opaque rectangle in a
/// reduced Sketch PNG. Each axis attenuates a fractional edge over one
/// authored pixel, then the two weights are resolved into byte coverage.
pub(crate) fn sketch_reduced_rectangle_edges(
    mask: &mut crate::raster::Mask, [x0, y0, x1, y1]: [f64; 4], scale: f64,
) {
    let weight = |lo: f64, hi: f64, coordinate: i32| {
        let pixel = f64::from(coordinate);
        let coverage = ((pixel + 1.).min(hi) - pixel.max(lo)).clamp(0., 1.);
        coverage * (coverage + scale).min(1.)
    };
    let mut update = |x, y| {
        if let Some(i) = mask.rect.index(x, y) {
            if mask.data[i] > 0. && mask.data[i] < 1. {
                let coverage = weight(x0, x1, x) * weight(y0, y1, y);
                mask.data[i] = ((coverage * 255.).floor() / 255.) as f32;
            }
        }
    };
    for y in [y0.floor() as i32, (y1.ceil() - 1.) as i32] {
        for x in mask.rect.x..mask.rect.right() {
            update(x, y);
        }
    }
    for x in [x0.floor() as i32, (x1.ceil() - 1.) as i32] {
        for y in mask.rect.y..mask.rect.bottom() {
            update(x, y);
        }
    }
}
