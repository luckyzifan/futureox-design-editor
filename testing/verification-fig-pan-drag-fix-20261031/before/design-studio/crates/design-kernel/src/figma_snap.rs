//! Figma snap scoring core, recovered from the fullscreen engine
//! (SNAP-SCORING-2026-10-26: f20000 candidate window query, f32510 gap
//! targets, f32509 implied frame margins, f28420 dot grid, f31923 vector
//! vertex snapping).
//!
//! Selection rule (f20000 @0x118435b): **nearest-wins inside the caller's
//! window radius `r` — no layered weights**. The initial best score is `r`
//! itself (or unbounded `inf` when the container flag bit0 is set), the
//! window is the binary-searched range `[x−r, x+r]` over a coordinate-sorted
//! target array, and replacement uses strict `<`, so an equal-distance tie
//! keeps the earlier candidate in sorted order (the smaller coordinate).
//! The radius is supplied by the caller per query — the engine never
//! hard-codes a pixel threshold in the scorer.
//!
//! Constants carry their disassembly provenance; semantics marked
//! `[推断]` in the source document are marked `inferred` here and never
//! presented as verified behavior.

/// A candidate coordinate ≈ −1 (±1e-6) means "this axis does not
/// participate"; the scorer short-circuits it (f20000 @0x11844f1/0x118450d).
pub const AXIS_SENTINEL: f64 = -1.;
/// Tolerance for the axis-sentinel test above.
pub const AXIS_SENTINEL_EPSILON: f64 = 1e-6;
/// Gap target position factor: `(edge_a + edge_b) × 0.5` — the gap target
/// sits on the midline between two adjacent object edges
/// (f32510 @0x1fa3dee).
pub const GAP_MIDPOINT_FACTOR: f64 = 0.5;
/// Equidistant-gap matching key: widths quantized to milli-pixels,
/// `trunc(width × 1000)` as f32 (f32510 @0x1fa3e1e-0x1fa3e2a). Only gaps
/// with the same key snap to each other.
pub const GAP_MILLIPIXEL_SCALE: f32 = 1000.;
/// Degenerate-gap gate: `gap_start + 1e-6 > threshold` must hold before the
/// gap enters the table (f32510 @0x1fa4344-0x1fa4351). Gate comparison is
/// verified; its interaction intent is inferred.
pub const GAP_DEGENERATE_EPSILON: f64 = 1e-6;
/// Implied frame-margin promotion factor: a padding-line target is
/// generated for a side only when the content offset exceeds
/// `padding[side] × 0.15` (f32509 @0x1f9f8cc-0x1f9f8d6). Comparison
/// verified, promotion intent inferred.
pub const MARGIN_PROMOTION_FACTOR: f64 = 0.15;
/// Dot-grid reject radius: a grid point is dropped (bit11 cleared) when
/// `sqrt(dx²+dy²) > 5.0 × scale` (f28420 @0x1aab85e-0x1aab87a). `scale` is
/// inferred to be the view scale, giving a 5 px screen-equivalent radius.
pub const DOT_GRID_REJECT_RADIUS: f64 = 5.;
/// Pixel rounding bias applied before quantization,
/// `floor(w0 + w1 + 0.055)` (f28420 @0x1aaba58-0x1aaba62) — keeps values
/// like 7.9999999 from quantizing down to 7.
pub const DOT_GRID_ROUNDING_BIAS: f64 = 0.055;
/// Default grid step passed through the grid parameter getter
/// (f28420 @0x1aa8d3e).
pub const GRID_DEFAULT_STEP: f32 = 10.;
/// Secondary grid step from the same getter (f28420 @0x1aa8d43).
pub const GRID_SECONDARY_STEP: f32 = 5.;
/// Spatial-hash bucket bounding-box outward pad, 25.0
/// (f28420 @0x1aa9660/0x1aa9674).
pub const SPATIAL_BUCKET_PAD: f64 = 25.;
/// Vector-segment intersection parameter bounds: t is accepted only in
/// `[1e-6, 0.999999]`, symmetrically excluding both endpoints
/// (f31923 @0x1ed2de3-0x1ed2e01).
pub const VERTEX_T_MIN: f64 = 1e-6;
/// Upper t bound. The recovered slice cites the f64 literal
/// `0x1.ffffde7210be9p-1` and equates it with `1 − 1e-6` = 0.999999
/// (the literal decodes to ≈0.9999997 — the document rounds); the semantic
/// bound is "symmetrically exclude both endpoints by 1e-6".
pub const VERTEX_T_MAX: f64 = 0.999_999;
/// Vector vertex ids live in the low 26 bits of their 32-bit slot:
/// `(packed << 6) >> 6` (f31923 @0x1ed3124-0x1ed312d).
pub const VERTEX_ID_BITS: u32 = 26;

/// Where a snap target came from. The scorer treats all kinds identically
/// (pure distance); the kind only rides along for UI/telemetry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetKind {
    /// Object edge or center line.
    ObjectEdge,
    /// Midline of the gap between two adjacent objects; carries the
    /// milli-pixel width key so equal-width gaps align with each other.
    GapMidpoint { width_key: i64 },
    /// Frame padding line promoted per [`MARGIN_PROMOTION_FACTOR`].
    FrameMargin,
    /// Dot-grid point surviving the [`DOT_GRID_REJECT_RADIUS`] filter.
    DotGridPoint,
}

/// One scored snap candidate on a single axis.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SnapTarget {
    /// Coordinate on the snapped axis (world units).
    pub coordinate: f64,
    pub kind: TargetKind,
    /// Stable id echoed back with the winner (Figma reuses the coordinate
    /// slot as the id; we keep an explicit field).
    pub id: u32,
}

/// The winning target of one axis query.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SnapHit {
    pub target: SnapTarget,
    /// Signed correction `coordinate − moving_edge` to apply.
    pub delta: f64,
}

/// Whether a candidate coordinate participates on its axis: ≈−1 within
/// 1e-6 is the "no target on this axis" sentinel (f20000 @0x11844f1).
pub fn axis_participates(coordinate: f64) -> bool {
    (coordinate - AXIS_SENTINEL).abs() >= AXIS_SENTINEL_EPSILON
}

/// Nearest-wins window query over targets sorted stably by coordinate
/// (f20000 §2.2). The scan starts at the first coordinate ≥ `x − r`
/// (lower_bound) and stops at the first coordinate > `x + r`; a candidate
/// replaces the incumbent only on strictly smaller distance, so an
/// equal-distance tie keeps the smaller coordinate. Non-finite `r` or a
/// non-positive radius fails closed (no hit).
pub fn nearest_in_window(sorted: &[SnapTarget], x: f64, r: f64) -> Option<SnapHit> {
    if !r.is_finite() || r <= 0. {
        return None;
    }
    let mut best_score = r;
    let mut best: Option<SnapHit> = None;
    for target in sorted
        .iter()
        .skip_while(|t| t.coordinate < x - r)
        .take_while(|t| t.coordinate <= x + r)
    {
        if !axis_participates(target.coordinate) {
            continue;
        }
        let distance = (target.coordinate - x).abs();
        if distance < best_score {
            best_score = distance;
            best = Some(SnapHit {
                target: *target,
                delta: target.coordinate - x,
            });
        }
    }
    best
}

/// Gap target position: the midline between two adjacent edges,
/// `(a + b) × 0.5` (f32510 @0x1fa3dee).
pub fn gap_target(edge_a: f64, edge_b: f64) -> f64 {
    (edge_a + edge_b) * GAP_MIDPOINT_FACTOR
}

/// Milli-pixel width key used to match equal-width gaps
/// (`trunc(width × 1000)` as f32; f32510 @0x1fa3e1e).
pub fn gap_width_key(width: f64) -> i64 {
    ((width as f32) * GAP_MILLIPIXEL_SCALE) as i64
}

/// Degenerate-gap gate: the recovered comparison is
/// `gap_start + 1e-6 > threshold` (f32510 @0x1fa4344). The comparison is
/// verified; what the threshold means at the call site is inferred, so
/// callers gate their own gap generation on this predicate.
pub fn gap_passes_gate(gap_start: f64, threshold: f64) -> bool {
    gap_start + GAP_DEGENERATE_EPSILON > threshold
}

/// Whether a frame padding line is promoted as a margin target for one
/// side: the content offset must exceed `padding × 0.15`
/// (f32509 @0x1f9f8cc). Padding comes from the frame's per-side f32 array.
pub fn margin_target_promoted(content_offset: f64, padding: f32) -> bool {
    content_offset > f64::from(padding) * MARGIN_PROMOTION_FACTOR
}

/// Dot-grid reject test: `sqrt(dx²+dy²) > 5.0 × scale` drops the point
/// (f28420 @0x1aab85e). Returns `true` when the point must be rejected.
pub fn dot_grid_point_rejected(dx: f64, dy: f64, scale: f64) -> bool {
    dx.hypot(dy) > DOT_GRID_REJECT_RADIUS * scale
}

/// Biased integer quantization `floor(w0 + w1 + 0.055)`
/// (f28420 @0x1aaba58): the bias keeps float dust below a pixel from
/// quantizing to the previous integer.
pub fn quantize_biased(w0: f64, w1: f64) -> f64 {
    (w0 + w1 + DOT_GRID_ROUNDING_BIAS).floor()
}

/// Default (step, secondary step) pair from the grid parameter getter
/// (f28420 @0x1aa8d3e/0x1aa8d43).
pub fn default_grid_steps() -> (f32, f32) {
    (GRID_DEFAULT_STEP, GRID_SECONDARY_STEP)
}

/// Whether a segment-intersection parameter t is accepted:
/// `[1e-6, 0.999999]`, symmetrically excluding both endpoints
/// (f31923 @0x1ed2de3).
pub fn vertex_t_in_range(t: f64) -> bool {
    (VERTEX_T_MIN..=VERTEX_T_MAX).contains(&t)
}

/// Effective vector vertex id: the low 26 bits of the packed 32-bit slot
/// (`(v << 6) >> 6`; f31923 @0x1ed3124).
pub fn vertex_id(packed: u32) -> u32 {
    (packed << (32 - VERTEX_ID_BITS)) >> (32 - VERTEX_ID_BITS)
}

/// Per-axis target set with the scorer's sorted-array invariant. Insertion
/// keeps duplicate coordinates in insertion order (stable), matching the
/// reference's tie behavior.
#[derive(Debug, Default)]
pub struct SnapAxis {
    targets: Vec<SnapTarget>,
    sorted: bool,
}

impl SnapAxis {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, target: SnapTarget) {
        self.targets.push(target);
        self.sorted = false;
    }

    pub fn len(&self) -> usize {
        self.targets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.targets.is_empty()
    }

    fn ensure_sorted(&mut self) {
        if !self.sorted {
            self.targets.sort_by(|a, b| {
                a.coordinate
                    .partial_cmp(&b.coordinate)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            self.sorted = true;
        }
    }

    /// Nearest-wins query; see [`nearest_in_window`].
    pub fn nearest(&mut self, x: f64, r: f64) -> Option<SnapHit> {
        self.ensure_sorted();
        nearest_in_window(&self.targets, x, r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(coordinate: f64, id: u32) -> SnapTarget {
        SnapTarget {
            coordinate,
            kind: TargetKind::ObjectEdge,
            id,
        }
    }

    #[test]
    fn vertex_t_bounds_exclude_both_endpoints_symmetrically() {
        assert_eq!(VERTEX_T_MAX, 1. - 1e-6);
        assert!(vertex_t_in_range(VERTEX_T_MIN));
        assert!(vertex_t_in_range(VERTEX_T_MAX));
        assert!(!vertex_t_in_range(0.));
        assert!(!vertex_t_in_range(1.));
        assert!(!vertex_t_in_range(VERTEX_T_MAX + 1e-9));
        assert!(!vertex_t_in_range(f64::NAN));
    }

    #[test]
    fn vertex_ids_use_the_low_26_bits() {
        assert_eq!(vertex_id(0x03FF_FFFF), 0x03FF_FFFF);
        assert_eq!(vertex_id(0x04FF_FFFF), 0x00FF_FFFF);
        assert_eq!(vertex_id(0xFC00_0000), 0);
    }

    #[test]
    fn nearest_wins_inside_the_window() {
        let targets = vec![target(10., 1), target(12., 2), target(30., 3)];
        let hit = nearest_in_window(&targets, 11.5, 5.).unwrap();
        assert_eq!(hit.target.id, 2);
        assert!((hit.delta - 0.5).abs() < 1e-12);
        // Outside the window entirely.
        assert_eq!(nearest_in_window(&targets, 11., 0.5), None);
    }

    #[test]
    fn equal_distance_ties_keep_the_smaller_coordinate() {
        let targets = vec![target(8., 1), target(12., 2)];
        let hit = nearest_in_window(&targets, 10., 3.).unwrap();
        assert_eq!(hit.target.id, 1);
        assert_eq!(hit.delta, -2.);
    }

    #[test]
    fn window_edge_distance_never_wins_strictly() {
        // A candidate exactly at distance r does not beat the initial best
        // score r under strict `<`.
        let targets = vec![target(10., 1)];
        assert_eq!(nearest_in_window(&targets, 5., 5.), None);
        assert!(nearest_in_window(&targets, 5.0001, 5.).is_some());
    }

    #[test]
    fn axis_sentinel_targets_are_short_circuited() {
        let targets = vec![target(-1., 1), target(9., 2)];
        let hit = nearest_in_window(&targets, 9., 2.).unwrap();
        assert_eq!(hit.target.id, 2);
        assert!(!axis_participates(-1. + 5e-7));
        assert!(axis_participates(-1. + 2e-6));
        assert!(axis_participates(0.));
    }

    #[test]
    fn invalid_radius_fails_closed() {
        let targets = vec![target(10., 1)];
        assert_eq!(nearest_in_window(&targets, 10., f64::NAN), None);
        assert_eq!(nearest_in_window(&targets, 10., 0.), None);
        assert_eq!(nearest_in_window(&targets, 10., -1.), None);
    }

    #[test]
    fn gap_targets_sit_on_the_midline_with_millipixel_keys() {
        assert_eq!(gap_target(20., 30.), 25.);
        assert_eq!(gap_target(-4., 4.), 0.);
        assert_eq!(gap_width_key(8.), 8000);
        assert_eq!(gap_width_key(7.999_999), 7999);
        // Equal-width gaps share the key regardless of position.
        assert_eq!(gap_width_key(12.5), gap_width_key(12.5));
        assert_ne!(gap_width_key(12.5), gap_width_key(12.6));
        // The recovered degenerate gate keeps gaps strictly beyond the
        // threshold.
        assert!(gap_passes_gate(10.001, 10.));
        assert!(!gap_passes_gate(9.9, 10.));
    }

    #[test]
    fn margin_targets_need_fifteen_percent_of_padding() {
        // padding 20 → promote only above offset 3.
        assert!(!margin_target_promoted(3., 20.));
        assert!(margin_target_promoted(3.1, 20.));
        assert!(margin_target_promoted(1., 5.));
        assert!(!margin_target_promoted(0., 20.));
    }

    #[test]
    fn dot_grid_reject_radius_is_five_times_scale() {
        // 3-4-5 triangle at scale 1: exactly 5 is kept, beyond is dropped.
        assert!(!dot_grid_point_rejected(3., 4., 1.));
        assert!(dot_grid_point_rejected(3.1, 4., 1.));
        assert!(!dot_grid_point_rejected(6., 8., 2.));
        assert!(dot_grid_point_rejected(6.1, 8., 2.));
    }

    #[test]
    fn biased_quantization_rescues_float_dust() {
        assert_eq!(quantize_biased(7.999_999, 0.), 8.);
        assert_eq!(quantize_biased(7.4, 0.), 7.);
        assert_eq!(quantize_biased(3.25, 4.75), 8.);
        assert_eq!(quantize_biased(-0.04, 0.), 0.);
    }

    #[test]
    fn grid_steps_default_to_ten_and_five() {
        let (step, secondary) = default_grid_steps();
        assert_eq!(step, 10.);
        assert_eq!(secondary, 5.);
    }

    #[test]
    fn snap_axis_sorts_stably_and_queries() {
        let mut axis = SnapAxis::new();
        for (coordinate, id) in [(30., 3), (10., 1), (10.5, 2)] {
            axis.push(target(coordinate, id));
        }
        assert_eq!(axis.len(), 3);
        let hit = axis.nearest(10.4, 1.).unwrap();
        assert_eq!(hit.target.id, 2);
        assert!((hit.delta - 0.1).abs() < 1e-12);
        assert_eq!(axis.nearest(20., 1.), None);
    }
}
