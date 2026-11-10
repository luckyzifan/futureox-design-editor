use crate::path::Contour;

/// Weight of one real outside sample mixed into the far edge of a clamped
/// export background-blur lattice. Measured on the frozen 128² Chrome
/// reference: 0 leaves max channel error 7, 0.10 brings it to 3, and 0.25
/// pushes it back to 10. Interior ramps and the exact glass captures are
/// unchanged at 0.10.
pub const EXPORT_BACKDROP_EDGE_RING: f64 = 0.1;

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
