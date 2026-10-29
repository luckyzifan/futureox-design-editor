use crate::{
    math::{Point, Rect},
    path::Contour,
};
#[derive(Clone, Debug)]
pub struct Mask {
    pub rect: Rect,
    pub data: Vec<f32>,
}
impl Mask {
    pub fn at(&self, x: i32, y: i32) -> f32 {
        self.rect.index(x, y).map_or(0., |i| self.data[i])
    }
}
#[derive(Clone, Copy)]
struct Edge {
    a: Point,
    b: Point,
    sign: i32,
}
/// Standard rotated-grid four-sample coverage, quantized to UNORM8 before paint.
/// The two-times compositor resolves these subpixels only after layer blending.
pub fn rasterize_msaa4(cs: &[Contour], limit: Rect, even_odd: bool) -> Mask {
    rasterize_sample(cs, limit, even_odd, None)
}
pub fn rasterize_sample(
    cs: &[Contour],
    limit: Rect,
    even_odd: bool,
    sample: Option<usize>,
) -> Mask {
    rasterize_sample_impl(cs, limit, even_odd, sample, true)
}
/// Exact quarter-sample coverage for floating-point color surfaces.
pub fn rasterize_sample_linear(
    cs: &[Contour],
    limit: Rect,
    even_odd: bool,
    sample: Option<usize>,
) -> Mask {
    rasterize_sample_impl(cs, limit, even_odd, sample, false)
}
fn rasterize_sample_impl(
    cs: &[Contour],
    limit: Rect,
    even_odd: bool,
    sample: Option<usize>,
    quantize: bool,
) -> Mask {
    let rect = Rect::from_points(cs.iter().flat_map(|c| c.points.iter().copied()))
        .expand(1)
        .intersect(limit);
    let mut mask = Mask {
        rect,
        data: vec![0.; rect.pixels()],
    };
    if rect.empty() {
        return mask;
    }
    visit_sample_spans(cs, rect, even_odd, sample, |row, left, right| {
        let sx = crate::fidelity::SAMPLE_OFFSETS[(row % 4) as usize].0;
        let y = rect.y + (row / 4) as i32;
        let start = ((left - sx).ceil() as i32).max(rect.x);
        let end = ((right - sx).ceil() as i32).min(rect.right());
        for x in start..end {
            if let Some(i) = rect.index(x, y) {
                mask.data[i] += if sample.is_some() { 1. } else { 0.25 };
            }
        }
        true
    });
    if quantize {
        for v in &mut mask.data {
            *v = (*v * 255.).round_ties_even() / 255.;
        }
    }
    mask
}
/// Shared four-sample scanline geometry. The callback receives continuous
/// binary64 interior intervals; it never receives pixels or a coverage bitmap.
pub(crate) fn visit_sample_spans(
    cs: &[Contour],
    rect: Rect,
    even_odd: bool,
    sample: Option<usize>,
    mut emit: impl FnMut(u32, f64, f64) -> bool,
) -> bool {
    // Keep the sample locations and intersection expression unchanged. Only
    // edges crossing the current sample row participate (active-edge sweep).
    // Sorting sample Y first also keeps this valid if the fixed grid is reordered.
    let offsets = crate::fidelity::SAMPLE_OFFSETS;
    let mut samples: Vec<_> = offsets
        .iter()
        .enumerate()
        .filter(|(i, _)| sample.is_none_or(|s| s == *i))
        .collect();
    samples.sort_by(|a, b| a.1.1.total_cmp(&b.1.1));
    let mut edges = Vec::new();
    for c in cs.iter().filter(|c| c.closed && c.points.len() >= 3) {
        for (i, a) in c.points.iter().enumerate() {
            let b = c.points[(i + 1) % c.points.len()];
            if a.y == b.y {
                continue;
            }
            let edge = if a.y < b.y {
                Edge { a: *a, b, sign: 1 }
            } else {
                Edge {
                    a: b,
                    b: *a,
                    sign: -1,
                }
            };
            if edge.b.y > f64::from(rect.y) && edge.a.y < f64::from(rect.bottom()) {
                edges.push(edge);
            }
        }
    }
    edges.sort_by(|a, b| a.a.y.total_cmp(&b.a.y));
    let mut next_edge = 0;
    let mut active: Vec<usize> = Vec::new();
    let mut crossings = Vec::new();
    for y in rect.y..rect.bottom() {
        for &(index, &(_, sy)) in &samples {
            crossings.clear();
            let py = f64::from(y) + sy;
            active.retain(|&i| edges[i].b.y > py);
            while next_edge < edges.len() && edges[next_edge].a.y <= py {
                if edges[next_edge].b.y > py {
                    active.push(next_edge);
                }
                next_edge += 1;
            }
            for &i in &active {
                let e = &edges[i];
                crossings.push((
                    e.a.x + (py - e.a.y) * (e.b.x - e.a.x) / (e.b.y - e.a.y),
                    e.sign,
                ));
            }
            crossings.sort_by(|a, b| a.0.total_cmp(&b.0));
            let mut winding = 0;
            let mut left = 0.;
            for &(right, sign) in &crossings {
                let before = if even_odd {
                    winding % 2 != 0
                } else {
                    winding != 0
                };
                winding += sign;
                let after = if even_odd {
                    winding % 2 != 0
                } else {
                    winding != 0
                };
                if !before && after {
                    left = right;
                } else if before
                    && !after
                    && !emit((y - rect.y) as u32 * 4 + index as u32, left, right)
                {
                    return false;
                }
            }
        }
    }
    true
}

// Eight vertical samples with exact horizontal interval coverage. The half-open
// [y_min,y_max) edge convention prevents double-counting shared vertices.
pub fn rasterize(cs: &[Contour], limit: Rect, even_odd: bool) -> Mask {
    let rect = Rect::from_points(cs.iter().flat_map(|c| c.points.iter().copied()))
        .expand(1)
        .intersect(limit);
    let mut mask = Mask {
        rect,
        data: vec![0.; rect.pixels()],
    };
    if rect.empty() {
        return mask;
    }
    if let Some(bounds) = crate::coverage::rectangle(cs) {
        for y in rect.y.max(bounds[1].floor() as i32)..rect.bottom().min(bounds[3].ceil() as i32) {
            for x in rect.x.max(bounds[0].floor() as i32)..rect.right().min(bounds[2].ceil() as i32)
            {
                let i = (y - rect.y) as usize * rect.w as usize + (x - rect.x) as usize;
                mask.data[i] = crate::coverage::rectangle_pixel(bounds, x as f64, y as f64) as f32;
            }
        }
        return mask;
    }
    visit_spans(cs, rect, even_odd, |row, left, right| {
        for px in left.floor() as i32..right.ceil() as i32 {
            if let Some(i) = rect.index(px, rect.y + (row / 8) as i32) {
                let coverage =
                    (right.min(f64::from(px) + 1.) - left.max(f64::from(px))).max(0.) / 8.;
                mask.data[i] += coverage as f32;
            }
        }
        true
    });
    for a in &mut mask.data {
        *a = a.clamp(0., 1.);
    }
    mask
}

/// Shared scanline geometry compiler. Emits sorted interior intervals, not
/// pixels or coverage masks. A consumer may stop on its explicit work budget.
pub(crate) fn visit_spans(
    cs: &[Contour],
    rect: Rect,
    even_odd: bool,
    mut emit: impl FnMut(u32, f64, f64) -> bool,
) -> bool {
    let samples = 8;
    let rows = rect.h as usize * samples;
    // One contiguous edge arena; empty row buckets own no Vec/allocation.
    // Head/tail links retain authored insertion order within each row.
    let mut buckets = vec![(usize::MAX,usize::MAX); rows];
    let mut bucket_edges:Vec<(Edge,usize)>=Vec::new();
    for c in cs {
        if c.points.len() < 3 || !c.closed {
            continue;
        }
        for (i, a) in c.points.iter().enumerate() {
            let b = c.points[(i + 1) % c.points.len()];
            if (a.y - b.y).abs() < 1e-14 {
                continue;
            }
            let edge = if a.y < b.y {
                Edge { a: *a, b, sign: 1 }
            } else {
                Edge {
                    a: b,
                    b: *a,
                    sign: -1,
                }
            };
            let first = ((edge.a.y - rect.y as f64) * samples as f64 - 0.5)
                .ceil()
                .max(0.) as usize;
            if first < rows && edge.b.y > rect.y as f64 {
                let index=bucket_edges.len();
                let (head,tail)=&mut buckets[first];
                if *tail==usize::MAX {*head=index;}else{bucket_edges[*tail].1=index;}
                *tail=index;bucket_edges.push((edge,usize::MAX));
            }
        }
    }
    let mut active: Vec<Edge> = Vec::new();
    let mut crossings: Vec<(f64, i32)> = Vec::new();
    for (row, (head,_)) in buckets.into_iter().enumerate() {
        let y = rect.y as f64 + (row as f64 + 0.5) / samples as f64;
        active.retain(|e| e.b.y > y);
        let mut at=head;
        while at!=usize::MAX {
            let (edge,next)=bucket_edges[at];
            if edge.b.y>y {active.push(edge);}
            at=next;
        }
        crossings.clear();
        crossings.extend(active.iter().map(|e| {
            (
                e.a.x + (y - e.a.y) * (e.b.x - e.a.x) / (e.b.y - e.a.y),
                e.sign,
            )
        }));
        crossings.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut winding = 0;
        let mut start = 0.;
        for &(x, sign) in &crossings {
            let before = if even_odd {
                winding % 2 != 0
            } else {
                winding != 0
            };
            winding += sign;
            let after = if even_odd {
                winding % 2 != 0
            } else {
                winding != 0
            };
            if !before && after {
                start = x;
            } else if before && !after {
                let left = start.max(rect.x as f64);
                let right = x.min(rect.right() as f64);
                if right <= left {
                    continue;
                }
                if !emit(row as u32, left, right) {
                    return false;
                }
            }
        }
    }
    true
}

#[cfg(test)]
#[path="raster_bucket_tests.rs"]
mod bucket_tests;
