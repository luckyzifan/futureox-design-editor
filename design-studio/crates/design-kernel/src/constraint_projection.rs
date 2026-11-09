
//! Constraint math: normalize axes, project coordinates, then select an anchor.
//! Layout applies these anchors in the parent's local coordinate system.

use crate::layout::Anchor;

pub const COLLINEAR_EPSILON: f64 = 1e-6;
pub const DEGREES_PER_RADIAN: f64 = 57.295779513082320876798154814105;
pub const ANGLE_EPSILON_DEGREES: f64 = 1e-6;
pub const FRAC_PI_2: f64 = std::f64::consts::FRAC_PI_2;
/// See [`FRAC_PI_2`].
pub const PI: f64 = std::f64::consts::PI;
/// See [`FRAC_PI_2`].
pub const SQRT_2: f64 = std::f64::consts::SQRT_2;

/// Normalize an axis; a zero-length vector stays zero.
pub fn normalize_unit(x: f64, y: f64) -> (f64, f64) {
    let len = x * x + y * y;
    if len != 0. {
        (x / len.sqrt(), y / len.sqrt())
    } else {
        (0., 0.)
    }
}

pub fn axes_collinear(x1: f64, y1: f64, x2: f64, y2: f64) -> bool {
    (x1 * y2 + x2 * y1).abs() < COLLINEAR_EPSILON
}

pub fn basis_pair(u: (f64, f64), v: (f64, f64)) -> ((f64, f64), (f64, f64)) {
    if axes_collinear(u.0, u.1, v.0, v.1) {
        (v, u)
    } else {
        (u, v)
    }
}

pub fn rotation_is_significant(angle_radians: f64) -> bool {
    (angle_radians * DEGREES_PER_RADIAN).abs() > ANGLE_EPSILON_DEGREES
}

pub fn proportional_map(value: f64, src_extent: f64, dst_extent: f64) -> f64 {
    if src_extent > 0. {
        value * (dst_extent / src_extent)
    } else {
        value
    }
}

/// Coordinates of `(dx, dy)` in the frame spanned by the given basis
/// vectors (dot products against each axis). With orthonormal axes this is
/// the rotated-frame projection the π/2 / π / √2 constant family supports;
/// projecting back with the same axes recomposes the original vector.
pub fn project_into_basis(
    dx: f64,
    dy: f64,
    ux: (f64, f64),
    uy: (f64, f64),
) -> (f64, f64) {
    (dx * ux.0 + dy * ux.1, dx * uy.0 + dy * uy.1)
}

/// Recompose parent-frame coordinates from basis coordinates and axis
/// vectors — the inverse direction of [`project_into_basis`].
pub fn recompose_from_basis(u: f64, v: f64, ux: (f64, f64), uy: (f64, f64)) -> (f64, f64) {
    (u * ux.0 + v * uy.0, u * ux.1 + v * uy.1)
}

/// Rotation angle of a 2×3 affine transform's linear part.
pub fn transform_rotation(a: f64, b: f64, _c: f64, _d: f64) -> f64 {
    b.atan2(a)
}

pub fn transform_basis_axes(a: f64, b: f64, c: f64, d: f64) -> ((f64, f64), (f64, f64)) {
    basis_pair(normalize_unit(a, b), normalize_unit(c, d))
}

/// Supported anchor modes, separated by layout axis.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConstraintOpcode {
    HorizontalStart,
    HorizontalCenter,
    HorizontalEnd,
    HorizontalStretch,
    HorizontalScale,
    VerticalStart,
    VerticalCenter,
    VerticalEnd,
    VerticalStretch,
    VerticalScale,
}

impl ConstraintOpcode {
    /// Opcode for one axis of our constraint model. Axis 0 is horizontal,
    /// axis 1 vertical.
    pub fn from_anchor(axis: usize, anchor: Anchor) -> Self {
        match (axis, anchor) {
            (0, Anchor::Start) => Self::HorizontalStart,
            (0, Anchor::Center) => Self::HorizontalCenter,
            (0, Anchor::End) => Self::HorizontalEnd,
            (0, Anchor::Stretch) => Self::HorizontalStretch,
            (0, Anchor::Scale) => Self::HorizontalScale,
            (_, Anchor::Start) => Self::VerticalStart,
            (_, Anchor::Center) => Self::VerticalCenter,
            (_, Anchor::End) => Self::VerticalEnd,
            (_, Anchor::Stretch) => Self::VerticalStretch,
            (_, Anchor::Scale) => Self::VerticalScale,
        }
    }

    /// Anchor used by the layout application path.
    pub fn anchor_mode(self) -> Option<Anchor> {
        match self {
            Self::HorizontalStart | Self::VerticalStart => Some(Anchor::Start),
            Self::HorizontalCenter | Self::VerticalCenter => Some(Anchor::Center),
            Self::HorizontalEnd | Self::VerticalEnd => Some(Anchor::End),
            Self::HorizontalStretch | Self::VerticalStretch => Some(Anchor::Stretch),
            Self::HorizontalScale | Self::VerticalScale => Some(Anchor::Scale),
        }
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_expected_bit_patterns() {
        // Keep the binary64 thresholds stable across layout calculations.
        assert_eq!(COLLINEAR_EPSILON, f64::from_bits(0x3EB0_C6F7_A0B5_ED8D));
        // 180/π == 0x1.ca5dc1a63c1f8p+5.
        assert_eq!(DEGREES_PER_RADIAN, f64::from_bits(0x404C_A5DC_1A63_C1F8));
        assert_eq!(FRAC_PI_2, std::f64::consts::FRAC_PI_2);
        assert_eq!(PI, std::f64::consts::PI);
        assert_eq!(SQRT_2, std::f64::consts::SQRT_2);
    }

    #[test]
    fn normalize_unit_yields_unit_length_or_zero() {
        let (x, y) = normalize_unit(3., 4.);
        assert!((x - 0.6).abs() < 1e-15 && (y - 0.8).abs() < 1e-15);
        assert!((x * x + y * y - 1.).abs() < 1e-15);
        // Already-unit vector is a fixed point.
        let (x, y) = normalize_unit(1., 0.);
        assert_eq!((x, y), (1., 0.));
        assert_eq!(normalize_unit(0., 0.), (0., 0.));
        // Axis-aligned and diagonal (the √2 family).
        assert_eq!(normalize_unit(7., 0.), (1., 0.));
        let (x, y) = normalize_unit(SQRT_2 / 2., SQRT_2 / 2.);
        assert!((x - SQRT_2 / 2.).abs() < 1e-16 && (y - SQRT_2 / 2.).abs() < 1e-16);
        // Subnormal input still normalizes (the squared length 1e-320 is
        // itself subnormal with reduced precision, so allow a loose bound);
        // only exact zero zeroes out.
        let (x, y) = normalize_unit(1e-160, 0.);
        assert!((x - 1.).abs() < 1e-5 && y == 0.);
    }

    #[test]
    fn collinearity_test_uses_a_strict_epsilon() {
        // Formula |x1·y2 + x2·y1| < 1e-6: reflected pairs collapse to 0.
        assert!(axes_collinear(1., 1., 1., -1.));
        assert!(axes_collinear(2., 0., 0., 0.)); // degenerate zero vector
        assert!(!axes_collinear(1., 0., 0., 1.)); // |1·1 + 0·0| = 1
        // Exact boundary: a formula value of exactly 1e-6 is NOT collinear
        // (strict <): |1e-6·1 + 1·0| == 1e-6.
        assert!(!axes_collinear(1e-6, 0., 1., 1.));
        // Just inside the threshold is collinear.
        assert!(axes_collinear(9.99e-7, 0., 1., 1.));
    }

    #[test]
    fn basis_pair_swaps_only_on_collinear_hits() {
        let (u, v) = ((1., 0.), (0., 1.));
        assert_eq!(basis_pair(u, v), (u, v));
        let (u, v) = ((1., 1.), (1., -1.));
        assert_eq!(basis_pair(u, v), (v, u));
    }

    #[test]
    fn rotation_significance_uses_the_degree_threshold() {
        // Threshold in radians: 1e-6 deg / (180/π).
        let threshold_rad = ANGLE_EPSILON_DEGREES / DEGREES_PER_RADIAN;
        assert!(!rotation_is_significant(0.));
        assert!(!rotation_is_significant(threshold_rad)); // == 1e-6 deg, not >
        assert!(!rotation_is_significant(threshold_rad * 0.99));
        assert!(rotation_is_significant(threshold_rad * 1.01));
        assert!(rotation_is_significant(FRAC_PI_2));
        assert!(rotation_is_significant(PI));
        assert!(rotation_is_significant(-PI));
        // A raw 2π stays significant; callers normalize through atan2
        // (`transform_rotation`) before the check.
        assert!(rotation_is_significant(2. * PI));
    }

    #[test]
    fn proportional_map_scales_against_the_source_extent() {
        assert!((proportional_map(20., 100., 200.) - 40.).abs() < 1e-12);
        assert!((proportional_map(20., 100., 50.) - 10.).abs() < 1e-12);
        assert_eq!(proportional_map(20., 0., 200.), 20.); // degenerate source
        assert_eq!(proportional_map(20., -5., 200.), 20.);
        assert!((proportional_map(-3., 10., 100.) + 30.).abs() < 1e-12);
    }

    #[test]
    fn projection_round_trips_through_orthonormal_bases() {
        // Identity frame.
        let d = (13.5, -7.25);
        let p = project_into_basis(d.0, d.1, (1., 0.), (0., 1.));
        assert_eq!(p, d);
        // Quarter-turn frame (the π/2 constant family): swapping axes.
        let ux = (FRAC_PI_2.cos(), FRAC_PI_2.sin());
        let uy = (-FRAC_PI_2.sin(), FRAC_PI_2.cos());
        let (u, v) = project_into_basis(d.0, d.1, ux, uy);
        let back = recompose_from_basis(u, v, ux, uy);
        assert!((back.0 - d.0).abs() < 1e-12 && (back.1 - d.1).abs() < 1e-12);
        // Half-turn frame (π).
        let ux = ((PI).cos(), (PI).sin());
        let uy = ((-PI / 2.).cos(), (-PI / 2.).sin());
        let (u, v) = project_into_basis(d.0, d.1, ux, uy);
        let back = recompose_from_basis(u, v, ux, uy);
        assert!((back.0 - d.0).abs() < 1e-12 && (back.1 - d.1).abs() < 1e-12);
    }

    #[test]
    fn transform_helpers_strip_scale_and_flag_degenerate_bases() {
        assert_eq!(transform_rotation(1., 0., 0., 1.), 0.);
        assert!((transform_rotation(0., 1., -1., 0.) - FRAC_PI_2).abs() < 1e-15);
        // Pure scale normalizes back to the identity basis.
        assert_eq!(transform_basis_axes(2., 0., 0., 3.), ((1., 0.), (0., 1.)));
        // Rotation + scale: normalized rotated basis.
        let (ux, uy) = transform_basis_axes(FRAC_PI_2.cos() * 5., FRAC_PI_2.sin() * 5., -FRAC_PI_2.sin() * 5., FRAC_PI_2.cos() * 5.);
        assert!((ux.1 - 1.).abs() < 1e-15 && (uy.0 - -1.).abs() < 1e-15);
        // Degenerate (collinear) columns swap order rather than divide badly.
        let (ux, uy) = transform_basis_axes(1., 0., 2., 0.);
        assert_eq!((ux, uy), ((1., 0.), (1., 0.)));
    }

    #[test]
    fn opcode_dispatch_covers_all_anchor_and_axis_combinations() {
        // All 10 anchor × axis combinations map and round-trip.
        for (axis, anchor, expected) in [
            (0, Anchor::Start, ConstraintOpcode::HorizontalStart),
            (0, Anchor::Center, ConstraintOpcode::HorizontalCenter),
            (0, Anchor::End, ConstraintOpcode::HorizontalEnd),
            (0, Anchor::Stretch, ConstraintOpcode::HorizontalStretch),
            (0, Anchor::Scale, ConstraintOpcode::HorizontalScale),
            (1, Anchor::Start, ConstraintOpcode::VerticalStart),
            (1, Anchor::Center, ConstraintOpcode::VerticalCenter),
            (1, Anchor::End, ConstraintOpcode::VerticalEnd),
            (1, Anchor::Stretch, ConstraintOpcode::VerticalStretch),
            (1, Anchor::Scale, ConstraintOpcode::VerticalScale),
        ] {
            let opcode = ConstraintOpcode::from_anchor(axis, anchor);
            assert_eq!(opcode, expected);
            assert_eq!(opcode.anchor_mode(), Some(anchor));
        }
    }
}
