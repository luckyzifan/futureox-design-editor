
/// Wrap into (−180, 180]. Exactly 180° lands on −180°, matching a full half-turn.
pub fn normalize_degrees(degrees: f64) -> f64 {
    if !degrees.is_finite() {
        return 0.;
    }
    let wrapped = (degrees + 180.).rem_euclid(360.) - 180.;
    if wrapped == 0. {
        0.
    } else {
        wrapped
    }
}

/// Clockwise degrees of an affine x-axis. `a`/`b` are the first column.
pub fn clockwise_degrees(a: f64, b: f64) -> f64 {
    if !a.is_finite() || !b.is_finite() {
        return 0.;
    }
    normalize_degrees(b.atan2(a).to_degrees())
}

/// World-space rotation that takes the pointer from `start` to `end` around
/// `center`. `initial` is the object's clockwise angle at pointer-down.
/// The matrix is `translate(center) · rotate(delta) · translate(-center)`
/// with Y-down clockwise positive. `degrees` is the resulting absolute angle.
pub fn rotation_drag(
    center: (f64, f64),
    start: (f64, f64),
    end: (f64, f64),
    initial: f64,
    snap: bool,
) -> ([f64; 6], f64) {
    let raw = normalize_degrees(
        (end.1 - center.1).atan2(end.0 - center.0).to_degrees()
            - (start.1 - center.1).atan2(start.0 - center.0).to_degrees(),
    );
    let absolute = initial + raw;
    let snapped = if snap {
        (absolute / 15.).round() * 15.
    } else {
        absolute
    };
    let delta = snapped - initial;
    let radians = delta.to_radians();
    let (sin, cos) = radians.sin_cos();
    let (cx, cy) = center;
    // [cos, sin, -sin, cos, tx, ty] around the center.
    let matrix = [
        cos,
        sin,
        -sin,
        cos,
        cx - cos * cx + sin * cy,
        cy - sin * cx - cos * cy,
    ];
    (matrix, normalize_degrees(snapped))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clockwise_column_is_positive_and_counterclockwise_is_negative() {
        assert!((clockwise_degrees(1., 0.) - 0.).abs() < 1e-9);
        assert!((clockwise_degrees(0., 1.) - 90.).abs() < 1e-9);
        assert!((clockwise_degrees(0., -1.) - -90.).abs() < 1e-9);
        assert!((clockwise_degrees(-1., 0.) - 180.).abs() < 1e-6 || (clockwise_degrees(-1., 0.) - -180.).abs() < 1e-6);
    }

    #[test]
    fn drag_clockwise_reports_positive_and_follows_the_pointer() {
        let center = (100., 80.);
        let start = (160., 80.);
        let end = (100., 140.);
        let (matrix, degrees) = rotation_drag(center, start, end, 0., false);
        assert!((degrees - 90.).abs() < 1e-6);
        let x = matrix[0] * start.0 + matrix[2] * start.1 + matrix[4];
        let y = matrix[1] * start.0 + matrix[3] * start.1 + matrix[5];
        assert!((x - end.0).abs() < 1e-6);
        assert!((y - end.1).abs() < 1e-6);
    }

    #[test]
    fn drag_counterclockwise_is_negative_and_shift_snaps_to_fifteen() {
        let center = (0., 0.);
        let start = (40., 0.);
        let end = (40. * 28_f64.to_radians().cos(), -40. * 28_f64.to_radians().sin());
        let (_, free) = rotation_drag(center, start, end, 0., false);
        let (_, snapped) = rotation_drag(center, start, end, 10., true);
        assert!(free < 0.);
        assert!((free + 28.).abs() < 1e-6);
        assert!((snapped - -15.).abs() < 1e-6 || (snapped - -30.).abs() < 1e-6);
        let absolute = 10_f64 - 28.;
        let expect = (absolute / 15.).round() * 15.;
        assert!((snapped - normalize_degrees(expect)).abs() < 1e-6);
    }

    #[test]
    fn past_half_turn_wraps_toward_zero() {
        assert!((normalize_degrees(195.) - -165.).abs() < 1e-9);
        assert!((normalize_degrees(-195.) - 165.).abs() < 1e-9);
    }
}
