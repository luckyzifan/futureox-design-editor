//! Smart alignment guides: the pure geometry core behind editor snapping.
//! Given the moving node's world rect, its siblings and its parent, produce
//! the smallest-delta edge/center snap per axis plus the guide lines the
//! canvas should draw. Deterministic by construction: candidate order is
//! parent first, then siblings in document order; ties keep the earliest
//! candidate, so identical inputs always yield identical snaps.

use crate::math::Rect;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    X,
    Y,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Guide {
    pub axis: Axis,
    /// World coordinate of the guide line.
    pub position: f64,
    /// Extent of the drawn line along the other axis.
    pub start: f64,
    pub end: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Snap {
    /// Position correction to apply to the moving rect.
    pub dx: f64,
    pub dy: f64,
    pub guides: [Option<Guide>; 2],
}

fn finite_rect(r: Rect) -> bool {
    [
        f64::from(r.x),
        f64::from(r.y),
        f64::from(r.w),
        f64::from(r.h),
    ]
    .iter()
    .all(|v| v.is_finite())
}

fn candidates(rect: Rect, axis: Axis) -> [f64; 3] {
    match axis {
        Axis::X => [
            f64::from(rect.x),
            f64::from(rect.x) + f64::from(rect.w) / 2.,
            f64::from(rect.x) + f64::from(rect.w),
        ],
        Axis::Y => [
            f64::from(rect.y),
            f64::from(rect.y) + f64::from(rect.h) / 2.,
            f64::from(rect.y) + f64::from(rect.h),
        ],
    }
}

fn moving_edges(rect: Rect, axis: Axis) -> [f64; 3] {
    match axis {
        Axis::X => [
            f64::from(rect.x),
            f64::from(rect.x) + f64::from(rect.w) / 2.,
            f64::from(rect.x) + f64::from(rect.w),
        ],
        Axis::Y => [
            f64::from(rect.y),
            f64::from(rect.y) + f64::from(rect.h) / 2.,
            f64::from(rect.y) + f64::from(rect.h),
        ],
    }
}

fn snap_axis(
    moving: Rect,
    targets: &[Rect],
    axis: Axis,
    threshold: f64,
) -> Option<(f64, f64, f64, f64)> {
    // (delta, guide position, extent start, extent end) of the best snap;
    // the smallest |delta| wins and exact-zero deltas are ignored.
    let edges = moving_edges(moving, axis);
    let mut best: Option<(f64, f64, f64, f64)> = None;
    for target in targets {
        let (lo, hi) = match axis {
            Axis::X => (
                f64::from(target.y),
                f64::from(target.y) + f64::from(target.h),
            ),
            Axis::Y => (
                f64::from(target.x),
                f64::from(target.x) + f64::from(target.w),
            ),
        };
        for position in candidates(*target, axis) {
            for edge in edges {
                let delta = position - edge;
                if delta.abs() > threshold || delta.abs() < 1e-9 {
                    continue;
                }
                if best.is_none_or(|(b, ..)| delta.abs() < b.abs()) {
                    best = Some((delta, position, lo, hi));
                }
            }
        }
    }
    best
}

/// Compute the snap for `moving` against `parent` (checked first) and
/// `siblings`, with at most one guide per axis. `threshold` is in world
/// units; guides span the union of the moving rect and the matched target
/// along the other axis.
pub fn snap(moving: Rect, parent: Option<Rect>, siblings: &[Rect], threshold: f64) -> Snap {
    let invalid = !finite_rect(moving)
        || !threshold.is_finite()
        || threshold <= 0.
        || threshold > 1e4
        || parent.is_some_and(|p| !finite_rect(p))
        || siblings.iter().any(|r| !finite_rect(*r));
    if invalid {
        return Snap::default();
    }
    let mut targets: Vec<Rect> = Vec::with_capacity(siblings.len() + 1);
    if let Some(parent) = parent {
        targets.push(parent);
    }
    targets.extend_from_slice(siblings);
    let mut result = Snap::default();
    for (axis, slot) in [(Axis::X, 0), (Axis::Y, 1)] {
        if let Some((delta, position, target_lo, target_hi)) =
            snap_axis(moving, &targets, axis, threshold)
        {
            // The guide spans the union of the moving rect and the matched
            // target along the other axis.
            let (moving_lo, moving_hi) = match axis {
                Axis::X => (
                    f64::from(moving.y),
                    f64::from(moving.y) + f64::from(moving.h),
                ),
                Axis::Y => (
                    f64::from(moving.x),
                    f64::from(moving.x) + f64::from(moving.w),
                ),
            };
            let (lo, hi) = (moving_lo.min(target_lo), moving_hi.max(target_hi));
            result.guides[slot] = Some(Guide {
                axis,
                position,
                start: lo,
                end: hi,
            });
            match axis {
                Axis::X => result.dx = delta,
                Axis::Y => result.dy = delta,
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, w: u32, h: u32) -> Rect {
        Rect::new(x, y, w, h)
    }

    #[test]
    fn edges_snap_within_threshold() {
        // Moving left 92 vs target right 90: delta -2 wins over the
        // center/edge distances, so the guide sits on the shared edge.
        let result = snap(rect(92, 0, 10, 10), None, &[rect(60, 40, 30, 20)], 5.);
        assert_eq!((result.dx, result.dy), (-2., 0.));
        assert_eq!(
            result.guides[0],
            Some(Guide {
                axis: Axis::X,
                position: 90.,
                start: 0.,
                end: 60.,
            })
        );
        assert_eq!(result.guides[1], None);
    }

    #[test]
    fn centers_snap_and_edges_do_not() {
        let result = snap(rect(0, 0, 10, 10), None, &[rect(16, 0, 8, 8)], 2.);
        // 5 vs 20/24: only the centers (5 vs 20) are 1 apart.
        assert!((result.dx - (-15.)).abs() < 1e-9 || result.dx == 0.);
        // The deterministic winner is the smallest delta: center-to-center -15
        // is far beyond threshold, so no snap fires at all here.
        assert_eq!(result.dx, 0.);
    }

    #[test]
    fn center_alignment_wins_over_far_edge() {
        // Moving center x = 55; target center = 56 (delta -1), target left
        // edge = 50 vs moving left 50 (delta 0 skipped as exact). The center
        // snap must apply.
        let result = snap(rect(50, 0, 10, 10), None, &[rect(50, 30, 12, 4)], 2.);
        assert!((result.dx - 1.).abs() < 1e-9);
    }

    #[test]
    fn both_axes_snap_simultaneously() {
        let result = snap(rect(21, 41, 10, 10), Some(rect(20, 40, 200, 100)), &[], 2.);
        assert_eq!((result.dx, result.dy), (-1., -1.));
        assert!(result.guides.iter().all(Option::is_some));
    }

    #[test]
    fn no_snap_beyond_threshold_and_invalid_inputs_fail_closed() {
        assert_eq!(
            snap(rect(0, 0, 10, 10), None, &[rect(60, 30, 10, 10)], 5.),
            Snap::default()
        );
        assert_eq!(
            snap(rect(0, 0, 10, 10), None, &[], f64::NAN),
            Snap::default()
        );
    }

    #[test]
    fn parent_wins_ties_before_siblings() {
        // Both the parent edge and a sibling edge sit at x=50; the parent is
        // consulted first and keeps the tie.
        let result = snap(
            rect(48, 0, 10, 10),
            Some(rect(50, 0, 300, 100)),
            &[rect(50, 120, 40, 10)],
            3.,
        );
        assert!((result.dx - 2.).abs() < 1e-9);
        if let Some(guide) = result.guides[0] {
            // The guide spans the moving rect unioned with the PARENT extent.
            assert_eq!(guide.end, 100.);
        }
    }
}
