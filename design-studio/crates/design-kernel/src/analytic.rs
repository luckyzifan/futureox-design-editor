//! Monotone ray intersections retain the original curve, rather than a polygon
//! approximation. Sixteen floats per segment form a portable GPU command.
use crate::{
    math::{Point, Rect, Transform},
    path::{Command, Path},
};
fn roots(a: f64, b: f64, c: f64) -> Vec<f64> {
    if a.abs() < 1e-14 {
        return if b.abs() < 1e-14 {
            vec![]
        } else {
            vec![-c / b]
        };
    }
    let d = b * b - 4. * a * c;
    if d < 0. {
        return vec![];
    }
    let q = -0.5 * (b + d.sqrt().copysign(b));
    if q.abs() < 1e-30 {
        vec![-b / (2. * a)]
    } else {
        vec![q / a, c / q]
    }
}
fn cubic(a: Point, b: Point, c: Point, d: Point, t: f64) -> Point {
    a.lerp(b, t)
        .lerp(b.lerp(c, t), t)
        .lerp(b.lerp(c, t).lerp(c.lerp(d, t), t), t)
}
pub fn segments(path: &Path, m: Transform, r: Rect) -> Result<Vec<f32>, String> {
    segments_with_tolerance(path, m, r, 1. / 8192.)
}
pub(crate) fn segments_with_tolerance(
    path: &Path,
    m: Transform,
    r: Rect,
    tolerance: f64,
) -> Result<Vec<f32>, String> {
    if path.commands.iter().any(|c| {
        matches!(
            c,
            Command::SmoothCorner(_) | Command::Arc { .. } | Command::Cubic(..) | Command::Quad(..)
        )
    }) {
        // Emit the CPU's device-space curve approximation once. Solving the
        // original curve independently in a 26-step f32 shader can put an
        // individual sample on the opposite side of the CPU fill boundary.
        let mut flattened = Path::default();
        for contour in path.flatten_for_fill(m, tolerance, r, false)? {
            if Rect::from_points(contour.points.iter().copied())
                .expand(1)
                .intersect(r)
                .empty()
            {
                continue;
            }
            flattened
                .commands
                .extend(Path::polygon(&contour.points, contour.closed).commands);
        }
        return segments_with_tolerance(&flattened, Transform::default(), r, tolerance);
    }
    let shift = Point::new(f64::from(r.x), f64::from(r.y));
    let local = |p| m.point(p) - shift;
    let mut result = Vec::new();
    let mut contour = Vec::new();
    let mut pen = Point::default();
    let mut first = pen;
    let emit = |kind: f32,
                a: Point,
                b: Point,
                c: Point,
                d: Point,
                t0: f64,
                t1: f64,
                y0: f64,
                y1: f64,
                out: &mut Vec<f32>| {
        // Horizontal ray queries only visit this mask's scanlines. Retain all
        // X crossings (including edges to the right), but omit monotone pieces
        // whose Y interval cannot contribute to any covered sample.
        if (y1 - y0).abs() < 1e-12 || y0.max(y1) <= 0. || y0.min(y1) >= f64::from(r.h) {
            return;
        }
        out.extend([
            kind,
            if y1 > y0 { 1. } else { -1. },
            0.,
            0.,
            a.x as f32,
            a.y as f32,
            b.x as f32,
            b.y as f32,
            c.x as f32,
            c.y as f32,
            d.x as f32,
            d.y as f32,
            t0 as f32,
            t1 as f32,
            y0.min(y1) as f32,
            y0.max(y1) as f32,
        ]);
    };
    for command in &path.commands {
        match *command {
            Command::Move(p) => {
                contour.clear();
                pen = local(p);
                first = pen;
            }
            Command::Line(p) => {
                let p = local(p);
                emit(
                    0.,
                    pen,
                    p,
                    Point::default(),
                    Point::default(),
                    0.,
                    1.,
                    pen.y,
                    p.y,
                    &mut contour,
                );
                pen = p;
            }
            Command::SmoothCorner(corner) => {
                let _ = corner;
                return Err("Smooth corner must be flattened before GPU command emission".into());
            }
            Command::Close => {
                emit(
                    0.,
                    pen,
                    first,
                    Point::default(),
                    Point::default(),
                    0.,
                    1.,
                    pen.y,
                    first.y,
                    &mut contour,
                );
                pen = first;
                result.append(&mut contour);
            }
            Command::Cubic(_, _, _) | Command::Quad(_, _) => {
                let (b, c, d) = match *command {
                    Command::Cubic(b, c, d) => (b, c, d),
                    Command::Quad(b, d) => (b, b, d),
                    _ => unreachable!(),
                };
                let a = pen;
                let d = local(d);
                let (b, c) = if let Command::Quad(_, _) = command {
                    let q = local(b);
                    (a.lerp(q, 2. / 3.), d.lerp(q, 2. / 3.))
                } else {
                    (local(b), local(c))
                };
                let mut ts = vec![0., 1.];
                ts.extend(
                    roots(
                        -a.y + 3. * b.y - 3. * c.y + d.y,
                        2. * (a.y - 2. * b.y + c.y),
                        b.y - a.y,
                    )
                    .into_iter()
                    .filter(|t| *t > 0. && *t < 1.),
                );
                ts.sort_by(f64::total_cmp);
                ts.dedup_by(|a, b| (*a - *b).abs() < 1e-12);
                for t in ts.windows(2) {
                    emit(
                        1.,
                        a,
                        b,
                        c,
                        d,
                        t[0],
                        t[1],
                        cubic(a, b, c, d, t[0]).y,
                        cubic(a, b, c, d, t[1]).y,
                        &mut contour,
                    );
                }
                pen = d;
            }
            Command::Arc {
                center,
                radius,
                start,
                sweep,
            } => {
                let center = local(center);
                let u = m.point(Point::new(radius.x, 0.)) - m.point(Point::default());
                let v = m.point(Point::new(0., radius.y)) - m.point(Point::default());
                let at = |t: f64| center + u * t.cos() + v * t.sin();
                let end = start + sweep;
                let mut ts = vec![start, end];
                let phase = v.y.atan2(u.y);
                let lo = start.min(end);
                let hi = start.max(end);
                for k in ((lo - phase) / std::f64::consts::PI).floor() as i32
                    ..=((hi - phase) / std::f64::consts::PI).ceil() as i32
                {
                    let t = phase + f64::from(k) * std::f64::consts::PI;
                    if t > lo && t < hi {
                        ts.push(t);
                    }
                }
                ts.sort_by(f64::total_cmp);
                if sweep < 0. {
                    ts.reverse();
                }
                for t in ts.windows(2) {
                    emit(
                        2.,
                        center,
                        u,
                        v,
                        Point::default(),
                        t[0],
                        t[1],
                        at(t[0]).y,
                        at(t[1]).y,
                        &mut contour,
                    );
                }
                pen = at(end);
            }
        }
        if result.len() + contour.len() > 2_000_000 {
            return Err("GPU path exceeds the shared command buffer budget".into());
        }
    }
    Ok(result)
}
