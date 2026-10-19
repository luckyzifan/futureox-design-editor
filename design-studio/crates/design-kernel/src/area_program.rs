#![allow(clippy::cloned_ref_to_slice_refs)]
//! Shared scanline interval geometry for analytic GPU coverage. This contains
//! no rendered pixels, colours or CPU-generated coverage masks. GPU consumers
//! intersect each pixel with these intervals using the binary64 coverage ALU.
use crate::{coverage, math::Rect, path::Contour, raster};

pub const MAX_FLOATS: usize = 2_000_000;
pub struct AreaProgram {
    pub rect: Rect,
    pub data: Vec<f32>,
}

// Output floats do not bound work for retraced/zero-width edges, which emit no
// intervals. At 4096px and eight samples this permits about 244 full-height
// edges (many more short edges); callers receive an explicit resource error.
const MAX_SCANLINE_EDGE_VISITS: u64 = 8_000_000;

fn validate_points(contours: &[Contour]) -> Result<(), String> {
    if contours.iter().flat_map(|c| &c.points).any(|p| !p.finite()) {
        return Err("Non-finite interval geometry".into());
    }
    Ok(())
}

pub(crate) fn clipped_rect(contours: &[Contour], limit: Rect) -> Result<Rect, String> {
    clip_bounds(Rect::from_points(contours.iter().flat_map(|c|c.points.iter().copied())).expand(1),limit)
}
pub(crate) fn clip_bounds(bounds:Rect,limit:Rect)->Result<Rect,String>{
    let invalid = || "Invalid interval geometry limit".to_string();
    let right = limit
        .x
        .checked_add(i32::try_from(limit.w).map_err(|_| invalid())?)
        .ok_or_else(invalid)?;
    let bottom = limit
        .y
        .checked_add(i32::try_from(limit.h).map_err(|_| invalid())?)
        .ok_or_else(invalid)?;
    let x = bounds.x.max(limit.x);
    let y = bounds.y.max(limit.y);
    // Both endpoints can be valid i32 yet a disjoint subtraction can overflow.
    // The resulting nonempty dimensions are bounded by the clamped geometry.
    Ok(Rect::new(
        x,
        y,
        (i64::from(bounds.right().min(right)) - i64::from(x)).max(0) as u32,
        (i64::from(bounds.bottom().min(bottom)) - i64::from(y)).max(0) as u32,
    ))
}

fn interval_header(height: u32, samples: u32) -> Result<usize, String> {
    let size = 4 + u64::from(height) * u64::from(samples) * 4;
    if size > MAX_FLOATS as u64 {
        return Err("Interval header budget exceeded".into());
    }
    Ok(size as usize)
}

fn check_scanline_work(contours: &[Contour], rect: Rect, samples: u32) -> Result<(), String> {
    check_scanline_work_limit(contours, rect, samples, MAX_SCANLINE_EDGE_VISITS)
}

fn check_scanline_work_limit(
    contours: &[Contour],
    rect: Rect,
    samples: u32,
    max_visits: u64,
) -> Result<(), String> {
    let mut visits = 0_u64;
    let rows = u64::from(rect.h) * u64::from(samples);
    for contour in contours.iter().filter(|c| c.closed && c.points.len() >= 3) {
        for (index, a) in contour.points.iter().enumerate() {
            let b = contour.points[(index + 1) % contour.points.len()];
            // Match the selected scanner: visit_sample_spans preserves even
            // sub-epsilon non-horizontal edges; visit_spans skips them.
            if a.y == b.y || (samples == 8 && (a.y - b.y).abs() < 1e-14) {
                continue;
            }
            let low = a.y.min(b.y).max(f64::from(rect.y));
            let high = a.y.max(b.y).min(f64::from(rect.bottom()));
            if high <= low {
                continue;
            }
            let (start, end) = if a.y < b.y { (*a, b) } else { (b, *a) };
            let dx = end.x - start.x;
            let dy = end.y - start.y;
            if !dx.is_finite() || !dy.is_finite() {
                return Err("Non-finite scanline interpolation".into());
            }
            // Match the scanner's exact operation order. Extrema over the
            // clipped y interval bound every actual sample's intermediate
            // product, quotient and sum; do not let NaN be hidden by clipping.
            for y in [low, high] {
                let offset = y - start.y;
                let product = offset * dx;
                let quotient = product / dy;
                let crossing = start.x + quotient;
                if [offset, product, quotient, crossing]
                    .iter()
                    .any(|v| !v.is_finite())
                {
                    return Err("Non-finite scanline interpolation".into());
                }
            }
            // Conservative count of sample rows intersecting this edge. The
            // one-row pad covers fractional endpoints without walking rows.
            let edge_visits = (((high - low) * f64::from(samples)).ceil() as u64 + 1).min(rows);
            visits = visits.saturating_add(edge_visits);
            if visits > max_visits {
                return Err("Scanline work budget exceeded".into());
            }
        }
    }
    Ok(())
}

fn endpoint(x: f64, origin: i32) -> (f32, f32, [f32; 4]) {
    let floor = x.floor();
    let up = f64::from(x - floor >= 0.5);
    // Nearest-integer subtraction is exact (Sterbenz), including tiny negative
    // coordinates. A naive fraction x-floor(x) can round 1-epsilon to 1 and
    // erase a thin interval next to zero. Preserve signed remainders instead.
    let remainder = x - (floor + up);
    let bits = remainder.to_bits();
    (
        (floor - f64::from(origin)) as f32,
        up as f32,
        std::array::from_fn(|i| ((bits >> (i * 16)) & 65535) as f32),
    )
}
impl AreaProgram {
    pub(crate) fn compile_crop(contours:&[Contour],rect:Rect,even_odd:bool,samples:bool)->Result<Self,String>{
        validate_points(contours)?;
        if samples {Self::samples_at_rect(contours,rect,even_odd)} else {Self::area_at_rect(contours,rect,even_odd)}
    }
    /// Four correlated coverage samples, sharing the CPU's continuous f64
    /// crossing positions. GPU consumers classify each requested sample.
    pub fn compile_samples(
        contours: &[Contour],
        limit: Rect,
        even_odd: bool,
    ) -> Result<Self, String> {
        validate_points(contours)?;
        let rect = clipped_rect(contours, limit)?;
        Self::samples_at_rect(contours,rect,even_odd)
    }
    fn samples_at_rect(contours:&[Contour],rect:Rect,even_odd:bool)->Result<Self,String>{
        if rect.empty() {
            return Ok(Self {
                rect,
                data: vec![2., 0., 0., 0.],
            });
        }
        if coverage::rectangle(contours).is_some() {
            let mut program = Self::area_at_rect(contours, rect, even_odd)?;
            program.data[0] = 4.;
            return Ok(program);
        }
        check_scanline_work(contours, rect, 4)?;
        let header = interval_header(rect.h, 4)?;
        let mut data = vec![0.; header];
        data[..4].copy_from_slice(&[3., 1., rect.w as f32, rect.h as f32]);
        let complete =
            raster::visit_sample_spans(contours, rect, even_odd, None, |row, left, right| {
                let left = left.max(f64::from(rect.x));
                let right = right.min(f64::from(rect.right()));
                if right <= left {
                    return true;
                }
                if data.len() + 12 > MAX_FLOATS {
                    return false;
                }
                let header = 4 + row as usize * 4;
                if data[header + 1] == 0. {
                    data[header] = (data.len() / 4) as f32;
                }
                data[header + 1] += 1.;
                let (l, lu, lb) = endpoint(left, rect.x);
                let (r, ru, rb) = endpoint(right, rect.x);
                data.extend([l, r, lu, ru]);
                data.extend(lb);
                data.extend(rb);
                true
            });
        if !complete {
            return Err("Sample interval program budget exceeded".into());
        }
        Ok(Self { rect, data })
    }
    pub fn compile(contours: &[Contour], limit: Rect, even_odd: bool) -> Result<Self, String> {
        validate_points(contours)?;
        let rect = clipped_rect(contours, limit)?;
        Self::area_at_rect(contours,rect,even_odd)
    }
    fn area_at_rect(contours:&[Contour],rect:Rect,even_odd:bool)->Result<Self,String>{
        if rect.empty() {
            return Ok(Self {
                rect,
                data: vec![2., 0., 0., 0.],
            });
        }
        if let Some(bounds) = coverage::rectangle(contours) {
            let (lx, lu, lb) = endpoint(bounds[0].max(f64::from(rect.x)), rect.x);
            let (rx, ru, rb) = endpoint(bounds[2].min(f64::from(rect.right())), rect.x);
            let (ty, tu, tb) = endpoint(bounds[1].max(f64::from(rect.y)), rect.y);
            let (by, bu, bb) = endpoint(bounds[3].min(f64::from(rect.bottom())), rect.y);
            let mut data = vec![
                1.,
                0.,
                rect.w as f32,
                rect.h as f32,
                lx,
                rx,
                lu,
                ru,
                ty,
                by,
                tu,
                bu,
            ];
            for bits in [lb, rb, tb, bb] {
                data.extend(bits);
            }
            return Ok(Self { rect, data });
        }
        check_scanline_work(contours, rect, 8)?;
        let header = interval_header(rect.h, 8)?;
        let mut data = vec![0.; header];
        data[..4].copy_from_slice(&[0., 1., rect.w as f32, rect.h as f32]);
        let complete = raster::visit_spans(contours, rect, even_odd, |row, left, right| {
            if data.len() + 12 > MAX_FLOATS {
                return false;
            }
            let header = 4 + row as usize * 4;
            if data[header + 1] == 0. {
                data[header] = (data.len() / 4) as f32;
            }
            data[header + 1] += 1.;
            let (l, lu, lb) = endpoint(left, rect.x);
            let (r, ru, rb) = endpoint(right, rect.x);
            data.extend([l, r, lu, ru]);
            data.extend(lb);
            data.extend(rb);
            true
        });
        if !complete {
            return Err("Analytic scanline interval budget exceeded".into());
        }
        Ok(Self { rect, data })
    }
}

#[cfg(test)]
mod work_budget_tests {
    use super::*;
    use crate::math::Point;

    #[test]
    fn degenerate_retraced_edges_cannot_bypass_scanline_work_budget() {
        let contour = Contour {
            points: (0..512)
                .map(|i| Point::new(5., if i % 2 == 0 { 0. } else { 4096. }))
                .collect(),
            closed: true,
        };
        assert!(
            AreaProgram::compile(&[contour.clone()], Rect::new(0, 0, 16, 4096), false).is_err()
        );
        assert!(
            AreaProgram::compile_samples(&[contour], Rect::new(0, 0, 16, 4096), false).is_err()
        );
        let boundary = Contour {
            points: (0..1000)
                .map(|i| Point::new(5., if i % 2 == 0 { 0. } else { 1001. }))
                .collect(),
            closed: true,
        };
        assert!(check_scanline_work(&[boundary.clone()], Rect::new(0, 0, 16, 1000), 8).is_ok());
        assert!(check_scanline_work(&[boundary], Rect::new(0, 0, 16, 1001), 8).is_err());
        let typical = Contour {
            points: (0..64)
                .map(|i| {
                    let angle = i as f64 * std::f64::consts::TAU / 64.;
                    let radius = if i % 2 == 0 { 20. } else { 10. };
                    Point::new(32. + radius * angle.cos(), 32. + radius * angle.sin())
                })
                .collect(),
            closed: true,
        };
        assert!(
            AreaProgram::compile(&[typical.clone()], Rect::new(0, 0, 64, 64), false)
                .expect("ordinary complex contour remains supported")
                .data
                .len()
                > 4
        );
        assert!(
            AreaProgram::compile_samples(&[typical], Rect::new(0, 0, 64, 64), true)
                .expect("ordinary sampled contour remains supported")
                .data
                .len()
                > 4
        );
        let small = Contour {
            points: vec![Point::new(1., 0.), Point::new(1., 8.), Point::new(1., 0.)],
            closed: true,
        };
        assert!(AreaProgram::compile(&[small], Rect::new(0, 0, 16, 16), false).is_ok());
    }

    #[test]
    fn tiny_edges_are_budgeted_for_the_actual_four_sample_scan() {
        let sy = crate::fidelity::SAMPLE_OFFSETS[0].1;
        let epsilon = 2.0_f64.powi(-50);
        let contour = Contour {
            points: vec![
                Point::new(1., sy - epsilon),
                Point::new(2., sy + epsilon),
                Point::new(3., sy - epsilon),
            ],
            closed: true,
        };
        let rect = Rect::new(0, 0, 4, 1);
        let mut spans = Vec::new();
        assert!(raster::visit_sample_spans(
            &[contour.clone()],
            rect,
            false,
            None,
            |row, l, r| {
                spans.push((row, l, r));
                true
            }
        ));
        assert_eq!(spans, vec![(0, 1.5, 2.5)]);
        // Two sub-epsilon edges really cross the sample. A zero-visit budget
        // must reject them, although the eight-sample raster skips such edges.
        assert!(check_scanline_work_limit(&[contour.clone()], rect, 4, 0).is_err());
        assert!(check_scanline_work_limit(&[contour.clone()], rect, 8, 0).is_ok());
        let program = AreaProgram::compile_samples(&[contour], rect, false).unwrap();
        let base = program.data[4] as usize * 4;
        let remainder = |offset| {
            let bits = (0..4).fold(0_u64, |bits, i| {
                bits | ((program.data[offset + i] as u64) << (16 * i))
            });
            f64::from_bits(bits)
        };
        // Packed f32 words preserve binary64 crossing remainders, not rounded
        // f32 edge coordinates. Compare with the actual scanner above.
        let left = f64::from(program.rect.x)
            + f64::from(program.data[base])
            + f64::from(program.data[base + 2])
            + remainder(base + 4);
        let right = f64::from(program.rect.x)
            + f64::from(program.data[base + 1])
            + f64::from(program.data[base + 3])
            + remainder(base + 8);
        assert_eq!((left, right), (spans[0].1, spans[0].2));
    }

    #[test]
    fn public_compile_checks_limit_arithmetic_and_disjoint_extremes() {
        let contours = [Contour {
            points: vec![
                Point::new(10., 0.),
                Point::new(12., 0.),
                Point::new(11., 2.),
            ],
            closed: true,
        }];
        assert!(interval_header(u32::MAX, 8).is_err());
        assert!(interval_header(u32::MAX, 4).is_err());
        assert_eq!(interval_header(1, 8).unwrap(), 36);
        for compile in [AreaProgram::compile, AreaProgram::compile_samples] {
            for limit in [
                Rect::new(i32::MAX, 0, 1, 1),
                Rect::new(0, i32::MAX, 1, 1),
                Rect::new(0, 0, u32::MAX, 1),
            ] {
                let result = std::panic::catch_unwind(|| compile(&contours, limit, false));
                assert!(result.is_ok(), "invalid public limit must not panic");
                assert!(result.unwrap().is_err());
            }
            for x in [i32::MIN, i32::MAX - 1] {
                let result =
                    std::panic::catch_unwind(|| compile(&contours, Rect::new(x, 0, 1, 1), false));
                assert!(
                    result.is_ok(),
                    "disjoint valid limit must not overflow subtraction"
                );
                assert!(result.unwrap().unwrap().rect.empty());
            }
            assert!(
                !compile(&contours, Rect::new(0, 0, 16, 16), false)
                    .unwrap()
                    .rect
                    .empty()
            );
        }
    }

    #[test]
    fn finite_edges_with_overflowing_interpolation_fail_closed() {
        for points in [
            vec![
                Point::new(-1e308, 0.),
                Point::new(1e308, 1.),
                Point::new(0., 2.),
            ],
            vec![
                Point::new(0., -1e308),
                Point::new(1., 1e308),
                Point::new(2., 0.),
            ],
            vec![
                Point::new(0., -1e200),
                Point::new(1e200, 1e200),
                Point::new(0., 2.),
            ],
        ] {
            assert!(points.iter().all(|p| p.finite()));
            let contours = [Contour {
                points,
                closed: true,
            }];
            assert!(AreaProgram::compile(&contours, Rect::new(0, 0, 16, 2), false).is_err());
            assert!(
                AreaProgram::compile_samples(&contours, Rect::new(0, 0, 16, 2), false).is_err()
            );
        }
        // Huge axis-aligned rectangles do not interpolate edges; clipping
        // them to a small valid viewport remains a safe supported fast path.
        let rectangle = [Contour {
            points: vec![
                Point::new(-1e308, -1e308),
                Point::new(1e308, -1e308),
                Point::new(1e308, 1e308),
                Point::new(-1e308, 1e308),
            ],
            closed: true,
        }];
        for compile in [AreaProgram::compile, AreaProgram::compile_samples] {
            let result = compile(&rectangle, Rect::new(0, 0, 16, 16), false).unwrap();
            assert!(result.data.iter().all(|x| x.is_finite()));
        }
    }

    #[test]
    fn nonfinite_contours_are_rejected_before_geometry_conversion() {
        for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let contour = Contour {
                points: vec![
                    Point::new(0., 0.),
                    Point::new(invalid, 1.),
                    Point::new(2., 2.),
                ],
                closed: true,
            };
            assert!(
                AreaProgram::compile(&[contour.clone()], Rect::new(0, 0, 16, 16), false).is_err()
            );
            assert!(
                AreaProgram::compile_samples(&[contour], Rect::new(0, 0, 16, 16), false).is_err()
            );
        }
    }
}
