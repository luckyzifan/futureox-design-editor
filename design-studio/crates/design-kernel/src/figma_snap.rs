//! Axis snapping: stable nearest-target selection, gap targets and grid helpers.
//! The caller supplies the query radius; equal-distance targets keep sorted order.

pub const AXIS_SENTINEL: f64 = -1.;
/// Tolerance for the axis-sentinel test above.
pub const AXIS_SENTINEL_EPSILON: f64 = 1e-6;
pub const GAP_MIDPOINT_FACTOR: f64 = 0.5;
pub const GAP_MILLIPIXEL_SCALE: f32 = 1000.;
pub const GAP_DEGENERATE_EPSILON: f64 = 1e-6;
pub const MARGIN_PROMOTION_FACTOR: f64 = 0.15;
pub const DOT_GRID_REJECT_RADIUS: f64 = 5.;
pub const DOT_GRID_ROUNDING_BIAS: f64 = 0.055;
pub const GRID_DEFAULT_STEP: f32 = 10.;
pub const GRID_SECONDARY_STEP: f32 = 5.;
pub const SPATIAL_BUCKET_PAD: f64 = 25.;
pub const VERTEX_T_MIN: f64 = 1e-6;
/// Upper t bound. The recovered slice cites the f64 literal
/// `0x1.ffffde7210be9p-1` and equates it with `1 − 1e-6` = 0.999999
/// (the literal decodes to ≈0.9999997 — the document rounds); the semantic
/// bound is "symmetrically exclude both endpoints by 1e-6".
pub const VERTEX_T_MAX: f64 = 0.999_999;
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

pub fn axis_participates(coordinate: f64) -> bool {
    (coordinate - AXIS_SENTINEL).abs() >= AXIS_SENTINEL_EPSILON
}

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

pub fn gap_target(edge_a: f64, edge_b: f64) -> f64 {
    (edge_a + edge_b) * GAP_MIDPOINT_FACTOR
}

pub fn gap_width_key(width: f64) -> i64 {
    ((width as f32) * GAP_MILLIPIXEL_SCALE) as i64
}

pub fn gap_passes_gate(gap_start: f64, threshold: f64) -> bool {
    gap_start + GAP_DEGENERATE_EPSILON > threshold
}

pub fn margin_target_promoted(content_offset: f64, padding: f32) -> bool {
    content_offset > f64::from(padding) * MARGIN_PROMOTION_FACTOR
}

pub fn dot_grid_point_rejected(dx: f64, dy: f64, scale: f64) -> bool {
    dx.hypot(dy) > DOT_GRID_REJECT_RADIUS * scale
}

pub fn quantize_biased(w0: f64, w1: f64) -> f64 {
    (w0 + w1 + DOT_GRID_ROUNDING_BIAS).floor()
}

pub fn default_grid_steps() -> (f32, f32) {
    (GRID_DEFAULT_STEP, GRID_SECONDARY_STEP)
}

pub fn vertex_t_in_range(t: f64) -> bool {
    (VERTEX_T_MIN..=VERTEX_T_MAX).contains(&t)
}

pub fn vertex_id(packed: u32) -> u32 {
    (packed << (32 - VERTEX_ID_BITS)) >> (32 - VERTEX_ID_BITS)
}

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
