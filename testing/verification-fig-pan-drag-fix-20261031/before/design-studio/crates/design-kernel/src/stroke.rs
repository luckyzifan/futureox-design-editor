use crate::{
    math::Point,
    path::{Contour, area},
};
mod markers;
pub use markers::{Marker, has_markers};
mod profile;
pub use profile::{WidthPoint, expand, handles, maximum_width, validate};
fn polygon(mut points: Vec<Point>) -> Contour {
    if area(&points) < 0. {
        points.reverse();
    }
    Contour {
        points,
        closed: true,
    }
}
// Sagitta bound in the caller's coordinate space. Never silently clamp the
// segment count: that turns a subpixel request into visible high-zoom facets.
fn arc_segments(radius: f64, sweep: f64, tolerance: f64) -> Result<usize, String> {
    if !radius.is_finite() || !sweep.is_finite() || !tolerance.is_finite() || tolerance <= 0. {
        return Err("Invalid stroke arc tolerance".into());
    }
    let step = if radius <= tolerance {
        std::f64::consts::PI
    } else {
        // Equivalent to 2*acos(1-t/r), without cancellation for small t/r.
        4. * (0.5 * tolerance / radius).sqrt().asin()
    };
    let count = (sweep.abs() / step).ceil().max(1.);
    if !count.is_finite() || count > 131072. {
        return Err("Stroke arc subdivision budget exceeded".into());
    }
    Ok(count as usize)
}
fn disk(p: Point, r: f64, tolerance: f64) -> Result<Contour, String> {
    let segments = arc_segments(r, std::f64::consts::TAU, tolerance)?.max(12);
    Ok(polygon(
        (0..segments)
            .map(|i| {
                let a = i as f64 * std::f64::consts::TAU / segments as f64;
                p + Point::new(a.cos(), a.sin()) * r
            })
            .collect(),
    ))
}
pub(super) fn pattern(pattern: &str) -> Result<Vec<f64>, String> {
    if pattern.len() > 1000 {
        return Err("Dash pattern budget exceeded".into());
    }
    let mut pattern = pattern
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .map(|v| {
            v.parse::<f64>()
                .map_err(|_| "Invalid dash pattern".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if pattern
        .iter()
        .any(|v| !v.is_finite() || *v < 0. || (*v > 0. && *v < 1e-6) || *v > 1e7)
    {
        return Err("Invalid dash length".into());
    }
    if pattern.is_empty() || pattern.iter().all(|v| *v == 0.) {
        return Ok(Vec::new());
    }
    if pattern.len() % 2 == 1 {
        pattern.extend(pattern.clone());
    }
    Ok(pattern)
}
pub fn dash(cs: &[Contour], values: &str) -> Result<Vec<Contour>, String> {
    dash_with_offset(cs, values, 0.)
}
/// SVG dash offset consumes distance into the repeated, even-length pattern.
/// Callers pass a validated nonempty pattern containing a positive length.
pub(super) fn dash_start(pattern: &[f64], offset: f64) -> (usize, f64) {
    let mut distance = offset.rem_euclid(pattern.iter().sum());
    let mut phase = 0;
    while distance >= pattern[phase] {
        distance -= pattern[phase];
        phase = (phase + 1) % pattern.len();
    }
    (phase, pattern[phase] - distance)
}
pub fn dash_with_offset(cs: &[Contour], values: &str, offset: f64) -> Result<Vec<Contour>, String> {
    if !offset.is_finite() || offset.abs() > 1e7 {
        return Err("Invalid dash offset".into());
    }
    let pattern = pattern(values)?;
    dash_geometry(cs, &pattern, offset, &mut 0)
}
// Lengths are already validated in document units by the public entry point.
pub(super) fn dash_geometry(
    cs: &[Contour],
    pattern: &[f64],
    offset: f64,
    count: &mut usize,
) -> Result<Vec<Contour>, String> {
    if pattern.is_empty() {
        return Ok(cs.to_vec());
    }
    let mut out = Vec::new();
    for c in cs {
        let mut points = c.points.clone();
        if c.closed && !points.is_empty() {
            points.push(points[0]);
        }
        let (mut phase, mut remaining) = dash_start(pattern, offset);
        let mut active = Vec::new();
        let mut parts = Vec::new();
        for pair in points.windows(2) {
            let mut a = pair[0];
            let b = pair[1];
            let mut length = (b - a).length();
            while length > 1e-10 {
                while remaining <= 1e-10 {
                    if phase % 2 == 0 && active.len() > 1 {
                        parts.push(Contour {
                            points: std::mem::take(&mut active),
                            closed: false,
                        });
                    }
                    phase = (phase + 1) % pattern.len();
                    remaining = pattern[phase];
                }
                let take = remaining.min(length);
                let end = a.lerp(b, take / length);
                if phase % 2 == 0 {
                    if active.is_empty() {
                        active.push(a);
                    }
                    active.push(end);
                }
                *count += 1;
                if *count > 20000 {
                    return Err("Dash subdivision budget exceeded".into());
                }
                a = end;
                length -= take;
                remaining -= take;
            }
        }
        if active.len() > 1 {
            parts.push(Contour {
                points: active,
                closed: false,
            });
        }
        if c.closed && parts.len() > 1 {
            let first = parts[0].points[0];
            let last = *parts.last().expect("parts").points.last().expect("points");
            if (first - last).length() < 1e-8 {
                let mut tail = parts.pop().expect("tail");
                tail.points.extend_from_slice(&parts[0].points[1..]);
                parts[0] = tail;
            }
        }
        out.extend(parts);
    }
    Ok(out)
}
pub fn outline(
    cs: &[Contour],
    width: f64,
    cap: &str,
    join: &str,
    tolerance: f64,
) -> Result<Vec<Contour>, String> {
    if !width.is_finite() || !(0. ..=20000.).contains(&width) {
        return Err("Invalid stroke width".into());
    }
    outline_geometry(cs, width, cap, join, tolerance, &mut 0)
}
// Internal normalized units must not be tested against authored width limits.
pub(super) fn outline_geometry(
    cs: &[Contour],
    width: f64,
    cap: &str,
    join: &str,
    tolerance: f64,
    output_points: &mut usize,
) -> Result<Vec<Contour>, String> {
    if width == 0. {
        return Ok(Vec::new());
    }
    let r = width / 2.;
    let mut out = Vec::new();
    let mut push = |contour: Contour| {
        *output_points += contour.points.len();
        if *output_points > 2_000_000 {
            return Err("Stroke output budget exceeded".to_string());
        }
        out.push(contour);
        Ok(())
    };
    for c in cs {
        let mut ps = c.points.clone();
        ps.dedup_by(|a, b| (*a - *b).length() < 1e-10);
        // A closed contour may explicitly repeat its first point. Keeping it
        // gives the two seam vertices a zero-length neighbor, so neither emits
        // the join. Match the profiled-stroke route's closure normalization.
        if c.closed && ps.len() > 1 && (ps[0] - ps[ps.len() - 1]).length() < 1e-10 {
            ps.pop();
        }
        if ps.len() < 2 {
            if cap == "round" && !ps.is_empty() {
                push(disk(ps[0], r, tolerance)?)?;
            }
            continue;
        }
        let edges = if c.closed { ps.len() } else { ps.len() - 1 };
        for i in 0..edges {
            let mut a = ps[i];
            let mut b = ps[(i + 1) % ps.len()];
            let delta = b - a;
            let len = delta.length();
            if len < 1e-10 {
                continue;
            }
            let tangent = delta * (1. / len);
            let normal = tangent.normal() * r;
            if !c.closed && cap == "square" {
                if i == 0 {
                    a = a - tangent * r;
                }
                if i == edges - 1 {
                    b = b + tangent * r;
                }
            }
            push(polygon(vec![
                a + normal,
                b + normal,
                b - normal,
                a - normal,
            ]))?;
        }
        for i in 0..ps.len() {
            let p = ps[i];
            if !c.closed && (i == 0 || i == ps.len() - 1) {
                if cap == "round" {
                    push(disk(p, r, tolerance)?)?;
                }
                continue;
            }
            let prev = ps[(i + ps.len() - 1) % ps.len()];
            let next = ps[(i + 1) % ps.len()];
            let a = p - prev;
            let b = next - p;
            let a = a * (1. / a.length().max(1e-10));
            let b = b * (1. / b.length().max(1e-10));
            let turn = a.cross(b);
            if turn.abs() < 1e-10 {
                if a.dot(b) < 0. && join == "round" {
                    push(disk(p, r, tolerance)?)?;
                }
                continue;
            }
            let sign = -turn.signum();
            let left = p + a.normal() * (r * sign);
            let right = p + b.normal() * (r * sign);
            if join == "round" {
                // The adjoining segment quads already cover the inner side.
                // Only tessellate the exterior circular sector, not a full
                // disk at every flattened curve vertex. The same sagitta
                // tolerance now scales with the actual turn angle.
                push(profile::arc(p, left, turn.atan2(a.dot(b)), tolerance)?)?;
                continue;
            }
            let mut poly = vec![p, left];
            if join == "miter" {
                let t = (right - left).cross(b) / turn;
                let m = left + a * t;
                if (m - p).length() <= r * 4. {
                    poly.push(m);
                }
            }
            poly.push(right);
            push(polygon(poly))?;
        }
    }
    Ok(out)
}
