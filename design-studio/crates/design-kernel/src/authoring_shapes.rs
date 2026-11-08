use crate::{
    math::Point,
    path::{Command, Path},
    scene::EllipseArc,
};

pub fn ellipse_arc(width: f64, height: f64, arc: EllipseArc) -> Path {
    if arc.sweep_angle == 0. {
        return Path::default();
    }
    let center = Point::new(width / 2., height / 2.);
    let radius = center;
    let point = |angle: f64, scale: f64| {
        Point::new(
            center.x + angle.cos() * radius.x * scale,
            center.y + angle.sin() * radius.y * scale,
        )
    };
    let complete = arc.sweep_angle.abs() == std::f64::consts::TAU;
    let start = point(arc.start_angle, 1.);
    let mut commands = vec![
        Command::Move(start),
        Command::Arc {
            center,
            radius,
            start: arc.start_angle,
            sweep: arc.sweep_angle,
        },
    ];
    if arc.inner_radius > 0. {
        let inner = point(arc.start_angle + arc.sweep_angle, arc.inner_radius);
        if complete {
            commands.push(Command::Close);
            commands.push(Command::Move(inner));
        } else {
            commands.push(Command::Line(inner));
        }
        commands.push(Command::Arc {
            center,
            radius: Point::new(radius.x * arc.inner_radius, radius.y * arc.inner_radius),
            start: arc.start_angle + arc.sweep_angle,
            sweep: -arc.sweep_angle,
        });
    } else if !complete {
        commands.push(Command::Line(center));
    }
    commands.push(Command::Close);
    Path { commands }
}

/// Circular fillets on a closed polygon. Each corner consumes at most half of
/// either incident edge, so adjacent fillets cannot cross. Concave corners
/// retain their opposite winding instead of turning into convex bulges.
pub fn rounded_polygon(points: &[Point], radius: f64) -> Path {
    if radius <= 0. || points.len() < 3 {
        return Path::polygon(points, true);
    }
    rounded_polygon_with(points, |_|radius, 0.)
}

/// Explicit imported per-vertex circular corners. Zero keeps a sharp vertex.
pub fn rounded_polygon_radii(points:&[Point],radii:&[f64])->Result<Path,String>{
    if points.len()!=radii.len() || radii.iter().any(|r|!r.is_finite()||*r<0.) {
        return Err("Invalid polygon corner radii".into());
    }
    if points.len()<3{return Ok(Path::polygon(points,true));}
    Ok(rounded_polygon_with(points,|i|radii[i], 0.))
}

/// Same fillets as [`rounded_polygon_radii`], with Figma corner smoothing in
/// `0..=1`. Zero smoothing keeps the circular arc. A positive value starts the
/// curve farther along each edge and lengthens the cubic handles.
pub fn rounded_polygon_radii_smoothed(points:&[Point],radii:&[f64],smoothing:f64)->Result<Path,String>{
    if !smoothing.is_finite() || !(0. ..=1.).contains(&smoothing) {
        return Err("Invalid polygon corner smoothing".into());
    }
    if points.len()!=radii.len() || radii.iter().any(|r|!r.is_finite()||*r<0.) {
        return Err("Invalid polygon corner radii".into());
    }
    if points.len()<3{return Ok(Path::polygon(points,true));}
    Ok(rounded_polygon_with(points,|i|radii[i], smoothing))
}

fn rounded_polygon_with(points:&[Point],radius:impl Fn(usize)->f64, smoothing:f64)->Path {
    let mut corners = Vec::with_capacity(points.len());
    for (i, &at) in points.iter().enumerate() {
        let radius=radius(i);
        if radius==0. {corners.push((at,at,None));continue;}
        let before = points[(i + points.len() - 1) % points.len()];
        let after = points[(i + 1) % points.len()];
        let l1 = (before.x - at.x).hypot(before.y - at.y);
        let l2 = (after.x - at.x).hypot(after.y - at.y);
        let u = Point::new((before.x - at.x) / l1, (before.y - at.y) / l1);
        let v = Point::new((after.x - at.x) / l2, (after.y - at.y) / l2);
        let cross = u.x * v.y - u.y * v.x;
        let half = (u.x * v.x + u.y * v.y).clamp(-1., 1.).acos() / 2.;
        let bisector = (u.x + v.x).hypot(u.y + v.y);
        if l1 == 0.
            || l2 == 0.
            || !half.is_finite()
            || half.sin() < 1e-12
            || bisector < 1e-12
            || cross.abs() < 1e-12
        {
            corners.push((at, at, None));
            continue;
        }
        let spread = 1. + smoothing.clamp(0., 1.);
        let distance = (radius * spread / half.tan()).min(l1 / 2.).min(l2 / 2.);
        let r = distance * half.tan() / spread;
        let entry = Point::new(at.x + u.x * distance, at.y + u.y * distance);
        let exit = Point::new(at.x + v.x * distance, at.y + v.y * distance);
        let reach = r / half.sin();
        let center = Point::new(
            at.x + (u.x + v.x) / bisector * reach,
            at.y + (u.y + v.y) / bisector * reach,
        );
        let start = (entry.y - center.y).atan2(entry.x - center.x);
        let sweep = -(std::f64::consts::PI - 2. * half).copysign(cross);
        let curve = if smoothing <= 0. {
            Command::Arc {
                center,
                radius: Point::new(r, r),
                start,
                sweep,
            }
        } else {
            let k = 4. / 3. * (sweep.abs() / 4.).tan() * r * spread;
            let sign = sweep.signum();
            let tangent = |p: Point| {
                let dx = p.x - center.x;
                let dy = p.y - center.y;
                Point::new(-dy * sign, dx * sign)
            };
            let unit = |p: Point| {
                let len = p.x.hypot(p.y).max(1e-12);
                Point::new(p.x / len * k, p.y / len * k)
            };
            let tin = unit(tangent(entry));
            let tout = unit(tangent(exit));
            Command::Cubic(Point::new(entry.x + tin.x, entry.y + tin.y), Point::new(exit.x - tout.x, exit.y - tout.y), exit)
        };
        corners.push((entry, exit, Some(curve)));
    }
    let mut commands = vec![Command::Move(corners[0].0)];
    for (i, (entry, exit, curve)) in corners.into_iter().enumerate() {
        if i > 0 {
            commands.push(Command::Line(entry));
        }
        commands.push(curve.unwrap_or(Command::Line(exit)));
    }
    commands.push(Command::Close);
    Path { commands }
}

pub fn is_zero(value: &f64) -> bool {
    *value == 0.
}
pub fn validate(
    kind: &str,
    arc: Option<EllipseArc>,
    corner: f64,
    network: bool,
) -> Result<(), String> {
    if !corner.is_finite()
        || !(0. ..=1e7).contains(&corner)
        || (corner != 0. && (!matches!(kind, "polygon" | "star") || network))
    {
        return Err("Invalid polygon corner radius".into());
    }
    if let Some(a) = arc
        && (kind != "ellipse"
            || network
            || !a.start_angle.is_finite()
            || a.start_angle.abs() > 1e7
            || !a.sweep_angle.is_finite()
            || a.sweep_angle.abs() > std::f64::consts::TAU
            || !a.inner_radius.is_finite()
            || !(0. ..=1.).contains(&a.inner_radius))
    {
        return Err("Invalid ellipse arc parameters".into());
    }
    Ok(())
}
