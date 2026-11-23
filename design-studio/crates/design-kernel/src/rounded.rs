//! Parameterized cubic corner construction, validated against real Figma
//! flattened paths. The authored rectangle uses this path for rendering,
//! picking, stroke expansion and export. No raster correction/model inference.
use crate::{
    math::Point,
    path::{Command, Path},
};

/// Radius actually consumed by each corner, in TL, TR, BR, BL order.
/// Matches the limit inside [`rectangle`] before smoothing expands the handle.
pub fn fitted_radii(width: f64, height: f64, radii: [f64; 4]) -> [f64; 4] {
    let radii = radii.map(|r| r.max(0.));
    let mut fitted = [0.; 4];
    for i in 0..4 {
        let r = radii[i];
        let horizontal = if i == 0 {
            1
        } else if i == 1 {
            0
        } else if i == 2 {
            3
        } else {
            2
        };
        let vertical = 3 - i;
        let limit = if r == 0. {
            0.
        } else {
            (width * r / (r + radii[horizontal])).min(height * r / (r + radii[vertical]))
        };
        fitted[i] = r.min(limit);
    }
    fitted
}

pub fn rectangle(width: f64, height: f64, radii: [f64; 4], smoothing: f64) -> Path {
    let radii = radii.map(|r| r.max(0.));
    let mut corners = Vec::with_capacity(4);
    for i in 0..4 {
        let r = radii[i];
        let horizontal = if i == 0 {
            1
        } else if i == 1 {
            0
        } else if i == 2 {
            3
        } else {
            2
        };
        let vertical = 3 - i;
        let limit = if r == 0. {
            0.
        } else {
            (width * r / (r + radii[horizontal])).min(height * r / (r + radii[vertical]))
        };
        let r = r.min(limit);
        let s = if r > 0. {
            smoothing.clamp(0., 1.).min((limit / r - 1.).max(0.))
        } else {
            0.
        };
        let consumed = (1. + s) * r;
        let theta = s * std::f64::consts::FRAC_PI_4;
        let (sin, cos) = theta.sin_cos();
        // Stable forms of r*(1-cos(theta)) and d/tan(theta).
        let d = r * sin * sin / (1. + cos);
        let c = r * sin * cos / (1. + cos);
        let end = r * (1. - sin);
        let b = (consumed - end - c) / 3.;
        let a = 2. * b;
        let k = 4. / 3. * ((std::f64::consts::FRAC_PI_2 - 2. * theta) / 4.).tan() * r;
        let points = [
            Point::new(0., consumed),
            Point::new(0., consumed - a),
            Point::new(0., end + c),
            Point::new(d, end),
            Point::new(d + k * sin, end - k * cos),
            Point::new(end - k * cos, d + k * sin),
            Point::new(end, d),
            Point::new(end + c, 0.),
            Point::new(consumed - a, 0.),
            Point::new(consumed, 0.),
        ];
        let orient = |p: Point| match i {
            0 => p,
            1 => Point::new(width - p.y, p.x),
            2 => Point::new(width - p.x, height - p.y),
            _ => Point::new(p.y, height - p.x),
        };
        corners.push((r, s, points.map(orient)));
    }
    let mut path = Path::default();
    let mut bias = Vec::new();
    let push = |path: &mut Path,
                bias: &mut Vec<Option<crate::path::SmoothCoverageBias>>,
                command,
                coverage| {
        path.commands.push(command);
        bias.push(coverage);
    };
    for (index, (r, s, p)) in corners.into_iter().enumerate() {
        push(
            &mut path,
            &mut bias,
            if index == 0 {
                Command::Move(p[0])
            } else {
                Command::Line(p[0])
            },
            None,
        );
        if r == 0. {
            continue;
        }
        if smoothing == 0. {
            let center = match index {
                0 => Point::new(r, r),
                1 => Point::new(width - r, r),
                2 => Point::new(width - r, height - r),
                _ => Point::new(r, height - r),
            };
            push(
                &mut path,
                &mut bias,
                Command::Arc {
                    center,
                    radius: Point::new(r, r),
                    start: std::f64::consts::PI + index as f64 * std::f64::consts::FRAC_PI_2,
                    sweep: std::f64::consts::FRAC_PI_2,
                },
                None,
            );
            continue;
        }
        if s > 0. {
            push(
                &mut path,
                &mut bias,
                Command::Cubic(p[1], p[2], p[3]),
                Some(crate::path::SmoothCoverageBias::Shoulder(s)),
            );
        }
        if s < 1. {
            push(
                &mut path,
                &mut bias,
                Command::Cubic(p[4], p[5], p[6]),
                Some(crate::path::SmoothCoverageBias::Arc(s)),
            );
        }
        if s > 0. {
            push(
                &mut path,
                &mut bias,
                Command::Cubic(p[7], p[8], p[9]),
                Some(crate::path::SmoothCoverageBias::Shoulder(s)),
            );
        }
    }
    push(&mut path, &mut bias, Command::Close, None);
    if bias.iter().any(Option::is_some) {
        path.coverage_bias = bias;
        path.coverage_center = Some(Point::new(width * 0.5, height * 0.5));
    }
    path
}

/// Recover the fill-only coverage residual for a cubic that is a smooth-corner
/// shoulder or circular section. Vector networks and Boolean results store the
/// same controls as [`rectangle`] but not the residual itself. A pure circular
/// corner (`smoothing == 0`) stays unmatched: its frozen flatten is a different
/// cubic and already matches without this residual.
pub(crate) fn infer_smooth_coverage_bias(
    a: Point,
    b: Point,
    c: Point,
    d: Point,
) -> Option<crate::path::SmoothCoverageBias> {
    if controls_follow_chord(a, b, c, d) {
        return None;
    }
    if let Some(smoothing) =
        shoulder_smoothing(a, b, c, d).or_else(|| shoulder_smoothing(d, c, b, a))
    {
        return Some(crate::path::SmoothCoverageBias::Shoulder(smoothing));
    }
    if let Some(smoothing) = arc_smoothing(a, b, c, d).or_else(|| arc_smoothing(d, c, b, a)) {
        return Some(crate::path::SmoothCoverageBias::Arc(smoothing));
    }
    None
}

fn controls_follow_chord(a: Point, b: Point, c: Point, d: Point) -> bool {
    let chord = d - a;
    let length = chord.length();
    if length < 1e-6 {
        return true;
    }
    let limit = (1e-4 * length).max(1e-4);
    let distance = |p: Point| {
        let t = ((p - a).dot(chord) / chord.dot(chord)).clamp(0., 1.);
        (p - (a + chord * t)).length()
    };
    distance(b) <= limit && distance(c) <= limit
}

fn rotate(point: Point, angle: f64) -> Point {
    let (sin, cos) = angle.sin_cos();
    Point::new(cos * point.x - sin * point.y, sin * point.x + cos * point.y)
}

fn shoulder_smoothing(a: Point, b: Point, c: Point, d: Point) -> Option<f64> {
    let tangent = b - a;
    if tangent.length() < 1e-6 {
        return None;
    }
    let angle = -std::f64::consts::FRAC_PI_2 - tangent.y.atan2(tangent.x);
    let map = |point: Point| rotate(point - a, angle);
    let (b, c, d) = (map(b), map(c), map(d));
    if b.x.abs() > 1e-3 || b.y >= -1e-5 {
        return None;
    }
    for mirror in [1., -1.] {
        let (c, d) = (Point::new(c.x * mirror, c.y), Point::new(d.x * mirror, d.y));
        if c.x.abs() > 1e-3 || d.x <= 1e-4 {
            continue;
        }
        let handle = -b.y;
        let cc = c.y - d.y;
        if handle <= 0. || cc <= 1e-4 {
            continue;
        }
        if (handle - 2. * (-d.y - cc) / 3.).abs() > 1e-3 * handle {
            continue;
        }
        let theta = (d.x / cc).atan();
        let smoothing = theta / std::f64::consts::FRAC_PI_4;
        if !(1e-3..1.0001).contains(&smoothing) {
            continue;
        }
        let (sin, cos) = theta.sin_cos();
        let radius = d.x * (1. + cos) / (sin * sin);
        if !radius.is_finite() || radius < 0.25 {
            continue;
        }
        let end = radius * (1. - sin);
        let consumed = (1. + smoothing) * radius;
        if ((end - consumed) - d.y).abs() > 1e-3 * radius {
            continue;
        }
        let smoothing = smoothing.clamp(0., 1.);
        let expected = shoulder_cubic(radius, smoothing);
        let scale = radius.max(1.);
        let (b_expected, c_expected, d_expected) = (
            expected.1 - expected.0,
            expected.2 - expected.0,
            expected.3 - expected.0,
        );
        if (b - b_expected)
            .length()
            .max((c - c_expected).length())
            .max((d - d_expected).length())
            > 2e-3 * scale
        {
            continue;
        }
        return Some(smoothing);
    }
    None
}

fn shoulder_cubic(radius: f64, smoothing: f64) -> (Point, Point, Point, Point) {
    let theta = smoothing * std::f64::consts::FRAC_PI_4;
    let (sin, cos) = theta.sin_cos();
    let d = radius * sin * sin / (1. + cos);
    let c = radius * sin * cos / (1. + cos);
    let end = radius * (1. - sin);
    let consumed = (1. + smoothing) * radius;
    let handle = 2. * (consumed - end - c) / 3.;
    (
        Point::new(0., consumed),
        Point::new(0., consumed - handle),
        Point::new(0., end + c),
        Point::new(d, end),
    )
}

fn arc_smoothing(a: Point, b: Point, c: Point, d: Point) -> Option<f64> {
    let chord = d - a;
    let distance = chord.length();
    if distance < 0.05 {
        return None;
    }
    let angle = -std::f64::consts::FRAC_PI_4 - chord.y.atan2(chord.x);
    let map = |point: Point| rotate(point - a, angle);
    let (b, c, d) = (map(b), map(c), map(d));
    if d.x <= 0. || (d.x + d.y).abs() > 1e-2 * distance {
        return None;
    }
    // Fitted smoothing can collapse to a quarter circle while the authored
    // value stays positive. That cubic still carries the Arc(0) residual.
    let radius = distance / std::f64::consts::SQRT_2;
    let kappa = 4. / 3. * std::f64::consts::FRAC_PI_8.tan();
    let k = kappa * radius;
    let quarter_error = (b - Point::new(0., -k))
        .length()
        .max((c - Point::new(radius - k, -radius)).length())
        .max((d - Point::new(radius, -radius)).length());
    if radius >= 0.25 && quarter_error <= 2e-3 * radius.max(1.) {
        return Some(0.);
    }
    let mut best: Option<(f64, f64)> = None;
    for step in 1..80 {
        let smoothing = step as f64 / 80.;
        let theta = smoothing * std::f64::consts::FRAC_PI_4;
        let (sin, cos) = theta.sin_cos();
        let factor = (1. - sin) - sin * sin / (1. + cos);
        if factor < 1e-4 {
            continue;
        }
        let radius = (distance / std::f64::consts::SQRT_2) / factor;
        if radius < 0.25 {
            continue;
        }
        let dd = radius * sin * sin / (1. + cos);
        let end = radius * (1. - sin);
        let k = 4. / 3. * ((std::f64::consts::FRAC_PI_2 - 2. * theta) / 4.).tan() * radius;
        let c1 = Point::new(k * sin, -k * cos);
        let c2 = Point::new(end - dd - k * cos, dd - end + k * sin);
        let end_point = Point::new(end - dd, dd - end);
        let error = (b - c1)
            .length()
            .max((c - c2).length())
            .max((d - end_point).length());
        if best.is_none_or(|(previous, _)| error < previous) {
            best = Some((error, smoothing));
        }
    }
    let (error, smoothing) = best?;
    let radius = distance;
    if error > 2e-3 * radius.max(1.) {
        return None;
    }
    Some(smoothing)
}
