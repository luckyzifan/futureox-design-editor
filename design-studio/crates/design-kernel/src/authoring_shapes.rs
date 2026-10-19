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
    let mut corners = Vec::with_capacity(points.len());
    for (i, &at) in points.iter().enumerate() {
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
        let distance = (radius / half.tan()).min(l1 / 2.).min(l2 / 2.);
        let r = distance * half.tan();
        let entry = Point::new(at.x + u.x * distance, at.y + u.y * distance);
        let exit = Point::new(at.x + v.x * distance, at.y + v.y * distance);
        let reach = r / half.sin();
        let center = Point::new(
            at.x + (u.x + v.x) / bisector * reach,
            at.y + (u.y + v.y) / bisector * reach,
        );
        let start = (entry.y - center.y).atan2(entry.x - center.x);
        let sweep = -(std::f64::consts::PI - 2. * half).copysign(cross);
        corners.push((
            entry,
            exit,
            Some(Command::Arc {
                center,
                radius: Point::new(r, r),
                start,
                sweep,
            }),
        ));
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
