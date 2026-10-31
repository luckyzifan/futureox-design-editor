//! Parameterized cubic corner construction, validated against real Figma
//! flattened paths. The authored rectangle uses this path for rendering,
//! picking, stroke expansion and export. No raster correction/model inference.
use crate::{
    math::Point,
    path::{Command, Path},
};

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
    for (index, (r, s, p)) in corners.into_iter().enumerate() {
        path.commands.push(if index == 0 {
            Command::Move(p[0])
        } else {
            Command::Line(p[0])
        });
        if r == 0. {
            continue;
        }
        // Figma's zero-smoothing rectangle remains circular. A browser PNG
        // comparison proves that flattening that case to cubics changes pixels;
        // do not substitute the flattened approximation for the exact arc.
        if smoothing == 0. {
            let center = match index {
                0 => Point::new(r, r),
                1 => Point::new(width - r, r),
                2 => Point::new(width - r, height - r),
                _ => Point::new(r, height - r),
            };
            path.commands.push(Command::Arc {
                center,
                radius: Point::new(r, r),
                start: std::f64::consts::PI + index as f64 * std::f64::consts::FRAC_PI_2,
                sweep: std::f64::consts::FRAC_PI_2,
            });
            continue;
        }
        if s > 0. {
            path.commands.push(Command::Cubic(p[1], p[2], p[3]));
        }
        if s < 1. {
            path.commands.push(Command::Cubic(p[4], p[5], p[6]));
        }
        if s > 0. {
            path.commands.push(Command::Cubic(p[7], p[8], p[9]));
        }
    }
    path.commands.push(Command::Close);
    path
}
