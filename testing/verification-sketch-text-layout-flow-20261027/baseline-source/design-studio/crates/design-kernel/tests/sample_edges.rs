use futureox_design_kernel::{
    math::{Point, Rect},
    path::Contour,
    raster::{Mask, rasterize_sample},
};
// Frozen pre-sweep implementation is the byte-level compatibility oracle.
fn legacy_sample(cs: &[Contour], limit: Rect, even_odd: bool, sample: Option<usize>) -> Mask {
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
    let offsets = futureox_design_kernel::fidelity::SAMPLE_OFFSETS;
    let mut crossings = Vec::new();
    for y in rect.y..rect.bottom() {
        for (index, &(sx, sy)) in offsets.iter().enumerate() {
            if sample.is_some_and(|s| s != index) {
                continue;
            }
            crossings.clear();
            let py = f64::from(y) + sy;
            for c in cs.iter().filter(|c| c.closed && c.points.len() >= 3) {
                for (i, a) in c.points.iter().enumerate() {
                    let b = c.points[(i + 1) % c.points.len()];
                    if a.y <= py && py < b.y {
                        crossings.push((a.x + (py - a.y) * (b.x - a.x) / (b.y - a.y), 1));
                    } else if b.y <= py && py < a.y {
                        crossings.push((b.x + (py - b.y) * (a.x - b.x) / (a.y - b.y), -1));
                    }
                }
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
                } else if before && !after {
                    let start = ((left - sx).ceil() as i32).max(rect.x);
                    let end = ((right - sx).ceil() as i32).min(rect.right());
                    for x in start..end {
                        if let Some(i) = rect.index(x, y) {
                            mask.data[i] += if sample.is_some() { 1. } else { 0.25 };
                        }
                    }
                }
            }
        }
    }
    for v in &mut mask.data {
        *v = (*v * 255.).round_ties_even() / 255.;
    }
    mask
}

#[test]
fn active_edges_match_legacy_sampling_at_clip_and_winding_boundaries() {
    let mut seed = 0x7ca521b9_u64;
    let mut random = || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        (seed >> 32) as f64 / u32::MAX as f64
    };
    for case in 0..80 {
        let mut contours = vec![];
        for _ in 0..4 {
            let mut points = vec![];
            for _ in 0..(3 + case % 13) {
                points.push(Point::new(random() * 90. - 25., random() * 100. - 35.));
            }
            contours.push(Contour {
                points,
                closed: true,
            });
        }
        contours.push(Contour {
            points: vec![
                Point::new(-4., 13.125),
                Point::new(33., 13.125),
                Point::new(33., 14.875),
                Point::new(-4., 14.875),
            ],
            closed: true,
        });
        let clip = Rect {
            x: -5,
            y: 13,
            w: 45,
            h: 33,
        };
        for rule in [false, true] {
            for sample in [None, Some(0), Some(1), Some(2), Some(3)] {
                let old = legacy_sample(&contours, clip, rule, sample);
                let new = rasterize_sample(&contours, clip, rule, sample);
                assert_eq!(old.rect, new.rect);
                assert_eq!(
                    old.data, new.data,
                    "case {case}, rule {rule}, sample {sample:?}"
                );
            }
        }
    }
}
