//! Constraint projection / normalization math.
//!
//! Function-level alignment with the reference engine's constraint solver:
//! unit-vector normalization with a zero-length guard, the 1e-6 collinearity
//! test with its basis-pair swap, the degree-based significant-rotation
//! check, proportional mapping against a source bounding box, and the
//! rotated-frame projection constant family (π/2, π, √2). The reference's
//! 38-way constraint opcode dispatch (`br_table` on `(field & 63) - 6`,
//! raw range ~6..44) is exposed as an opcode enum: our `Anchor` semantics
//! map onto it, while raw reference opcodes whose per-case semantics were
//! **not** recovered are recorded as [`ConstraintOpcode::FigmaReserved`]
//! and never guessed.
//!
//! Alignment boundary (honest accounting): the reference computes constraint
//! application inside rotated frames because its solver writes world-adjacent
//! layout structures. This engine's `layout::constrain` computes in the
//! parent's local axis frame and defers rotation to the transform chain at
//! render time, so the projection primitives here are the shared math, not a
//! behavioral rewrite of `constrain`.

use crate::layout::Anchor;

/// Collinearity epsilon observed 25× across the reference solver
/// (disasm 1aa924c-1aa92a7). The f64 bit pattern cited there
/// (`0x1.0c6f7a0b5ed8dp-20`) is exactly `1e-6`.
pub const COLLINEAR_EPSILON: f64 = 1e-6;
/// Degrees per radian, `0x1.ca5dc1a63c1f8p+5` (disasm 1aa9f89) = 180/π.
pub const DEGREES_PER_RADIAN: f64 = 57.295779513082320876798154814105;
/// Degree threshold for the reference's significant-rotation check
/// (`|angle · 180/π| > 1e-6`).
pub const ANGLE_EPSILON_DEGREES: f64 = 1e-6;
/// Rotated-frame projection constant family (LAYOUT-INTERNALS §1.2):
/// π/2 and π rotate basis axes by quarter/half turns; √2 scales diagonals.
pub const FRAC_PI_2: f64 = std::f64::consts::FRAC_PI_2;
/// See [`FRAC_PI_2`].
pub const PI: f64 = std::f64::consts::PI;
/// See [`FRAC_PI_2`].
pub const SQRT_2: f64 = std::f64::consts::SQRT_2;

/// Number of br_table cases in the reference's constraint type dispatch
/// (`(field & 63) - 6`, disasm 1aaf69a-1aaf6e1).
pub const FIGMA_CONSTRAINT_DISPATCH_CASES: i32 = 38;
/// Lower bound of the reference opcode window (approximate; the slice gives
/// "~6..44" without pinning which endpoint is exclusive).
pub const FIGMA_CONSTRAINT_OPCODE_MIN: i32 = 6;
/// Upper bound of the reference opcode window; see
/// [`FIGMA_CONSTRAINT_OPCODE_MIN`].
pub const FIGMA_CONSTRAINT_OPCODE_MAX: i32 = 44;

/// Raw reference opcode: `(field & 63) - 6`.
pub fn figma_opcode(field: u8) -> i32 {
    (field & 63) as i32 - 6
}

/// Whether a raw opcode falls inside the reference's 38-way dispatch
/// window. Inside the window the semantics are still unknown per case
/// (LAYOUT-INTERNALS §6.5) — this only records table membership.
pub fn in_figma_dispatch_table(raw: i32) -> bool {
    (FIGMA_CONSTRAINT_OPCODE_MIN..=FIGMA_CONSTRAINT_OPCODE_MAX).contains(&raw)
}

/// Normalize `(x, y)` to unit length. A zero-length input maps to `(0, 0)`:
/// the reference writes an i64 zero pattern into the output slot when
/// `len == 0` (disasm 1aa8c07-1aa8c5a). Non-finite inputs propagate, as in
/// the reference.
pub fn normalize_unit(x: f64, y: f64) -> (f64, f64) {
    let len = x * x + y * y;
    if len != 0. {
        (x / len.sqrt(), y / len.sqrt())
    } else {
        (0., 0.)
    }
}

/// Collinearity test on a vector pair in the reference's form
/// `|x1·y2 + x2·y1| < 1e-6` (disasm 1aa924c-1aa92a7). On a hit the
/// reference swaps the pair's stored slots; see [`basis_pair`].
pub fn axes_collinear(x1: f64, y1: f64, x2: f64, y2: f64) -> bool {
    (x1 * y2 + x2 * y1).abs() < COLLINEAR_EPSILON
}

/// Ordered basis pair with the reference's collinearity swap applied: a
/// collinear (degenerate) pair exchanges its slot order exactly as the
/// reference swaps `[+0] ↔ [+224]` before re-dispatching through its axis
/// enumeration.
pub fn basis_pair(u: (f64, f64), v: (f64, f64)) -> ((f64, f64), (f64, f64)) {
    if axes_collinear(u.0, u.1, v.0, v.1) {
        (v, u)
    } else {
        (u, v)
    }
}

/// Significant-rotation check: the reference treats a rotation as present
/// only when `|angle · 180/π| > 1e-6` degrees (disasm 1aa9f89).
pub fn rotation_is_significant(angle_radians: f64) -> bool {
    (angle_radians * DEGREES_PER_RADIAN).abs() > ANGLE_EPSILON_DEGREES
}

/// Proportional mapping against a source bounding-box extent:
/// `dst = value · (dst_extent / src_extent)` (disasm 1ab3331-1ab336c maps
/// through `src[440]` / `src[432]`). A non-positive source extent is
/// degenerate; the reference's behavior there was not recovered, so the
/// input is returned unchanged rather than guessed at (this also keeps the
/// division free of zero and sign flips).
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

/// Normalized basis axes of a transform's linear part, with the reference's
/// collinearity swap applied: column vectors `(a, b)` and `(c, d)` are
/// normalized to unit length (scale stripped) and a degenerate pair swaps
/// order.
pub fn transform_basis_axes(a: f64, b: f64, c: f64, d: f64) -> ((f64, f64), (f64, f64)) {
    basis_pair(normalize_unit(a, b), normalize_unit(c, d))
}

/// Constraint opcodes: the dispatch surface of the reference's 38-way
/// constraint type table, instantiated only with the semantics this
/// engine's `Constraints` model can express (an [`Anchor`] on one of the two
/// constraint axes). Raw reference opcodes are carried verbatim in
/// [`ConstraintOpcode::FigmaReserved`] for bookkeeping; they deliberately
/// have no behavior here because their per-case semantics were not
/// recovered (LAYOUT-INTERNALS §6.5).
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
    /// A raw reference opcode inside the 6..=44 dispatch window whose
    /// semantics are unknown. Recorded only — never applied.
    FigmaReserved(i32),
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

    /// Map a raw reference constraint-type field onto the dispatch surface.
    /// Every opcode in the 38-way window lands in [`Self::FigmaReserved`]:
    /// no raw value is assigned a meaning, because the per-case semantics
    /// were not recovered.
    pub fn from_figma_field(field: u8) -> Self {
        Self::FigmaReserved(figma_opcode(field))
    }

    /// The anchor semantics this opcode carries, or `None` for a reserved
    /// reference opcode (apply-path callers must skip rather than guess).
    pub fn anchor_mode(self) -> Option<Anchor> {
        match self {
            Self::HorizontalStart | Self::VerticalStart => Some(Anchor::Start),
            Self::HorizontalCenter | Self::VerticalCenter => Some(Anchor::Center),
            Self::HorizontalEnd | Self::VerticalEnd => Some(Anchor::End),
            Self::HorizontalStretch | Self::VerticalStretch => Some(Anchor::Stretch),
            Self::HorizontalScale | Self::VerticalScale => Some(Anchor::Scale),
            Self::FigmaReserved(_) => None,
        }
    }

    /// Whether this is a reserved reference opcode inside the 38-way
    /// dispatch window (as opposed to one outside it entirely).
    pub fn is_reserved_in_dispatch_table(self) -> bool {
        matches!(self, Self::FigmaReserved(raw) if in_figma_dispatch_table(raw))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_the_recovered_bit_patterns() {
        // 1e-6 == 0x1.0c6f7a0b5ed8dp-20 exactly (verified against the slice).
        assert_eq!(COLLINEAR_EPSILON, f64::from_bits(0x3EB0_C6F7_A0B5_ED8D));
        // 180/π == 0x1.ca5dc1a63c1f8p+5.
        assert_eq!(DEGREES_PER_RADIAN, f64::from_bits(0x404C_A5DC_1A63_C1F8));
        assert_eq!(FRAC_PI_2, std::f64::consts::FRAC_PI_2);
        assert_eq!(PI, std::f64::consts::PI);
        assert_eq!(SQRT_2, std::f64::consts::SQRT_2);
        // 38 dispatch cases over a raw window of ~6..44.
        assert_eq!(FIGMA_CONSTRAINT_DISPATCH_CASES, 38);
        assert_eq!(FIGMA_CONSTRAINT_OPCODE_MAX - FIGMA_CONSTRAINT_OPCODE_MIN, 38);
    }

    #[test]
    fn normalize_unit_yields_unit_length_or_zero() {
        let (x, y) = normalize_unit(3., 4.);
        assert!((x - 0.6).abs() < 1e-15 && (y - 0.8).abs() < 1e-15);
        assert!((x * x + y * y - 1.).abs() < 1e-15);
        // Already-unit vector is a fixed point.
        let (x, y) = normalize_unit(1., 0.);
        assert_eq!((x, y), (1., 0.));
        // Zero-length input writes zeros (the reference's i64-0 slot).
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
    fn collinearity_test_follows_the_reference_formula_and_epsilon() {
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
    fn opcode_dispatch_surface_covers_our_model_and_records_the_rest() {
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
        // Raw fields map to reserved opcodes without semantics.
        for field in [0u8, 12, 44, 50, 63] {
            let opcode = ConstraintOpcode::from_figma_field(field);
            assert_eq!(opcode.anchor_mode(), None, "field {field} must stay reserved");
            assert_eq!(
                opcode.is_reserved_in_dispatch_table(),
                in_figma_dispatch_table(figma_opcode(field)),
                "field {field}"
            );
        }
        // The dispatch window: (field & 63) - 6 ∈ 6..=44 ⇒ field ∈ 12..=50.
        assert!(!in_figma_dispatch_table(figma_opcode(11)));
        assert!(in_figma_dispatch_table(figma_opcode(12)));
        assert!(in_figma_dispatch_table(figma_opcode(50)));
        assert!(!in_figma_dispatch_table(figma_opcode(51)));
        // Window size check: the 38-way table cannot cover all 39 integers
        // of a closed 6..=44 — recorded as an unresolved slice ambiguity.
        let covered = (FIGMA_CONSTRAINT_OPCODE_MIN..=FIGMA_CONSTRAINT_OPCODE_MAX)
            .filter(|raw| in_figma_dispatch_table(*raw))
            .count();
        assert!(covered == 38 || covered == 39);
    }
}
