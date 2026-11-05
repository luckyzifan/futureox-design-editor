//! Smart alignment guides: the pure geometry core behind editor snapping.
//! Given the moving node's world rect, its siblings and its parent, produce
//! the smallest-delta edge/center snap per axis plus the guide lines the
//! canvas should draw. Deterministic by construction: candidate order is
//! parent first, then siblings in document order; ties keep the earliest
//! candidate, so identical inputs always yield identical snaps.

use crate::math::Rect;

/// Snapping uses authored world coordinates, independently of the integer
/// pixel rectangles used by rasterization. Rounding before the query made
/// fractional edges and guides jump by whole world units at high zoom.
#[derive(Clone, Copy, Debug)]
pub struct WorldRect { pub x:f64, pub y:f64, pub w:f64, pub h:f64 }
impl From<Rect> for WorldRect {
    fn from(r:Rect)->Self { Self{x:r.x as f64,y:r.y as f64,w:r.w as f64,h:r.h as f64} }
}

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
    /// Matched target extent on the perpendicular axis. The UI can project
    /// the guide after Shift/pixel constraints without querying targets twice.
    pub target_spans: [Option<(f64, f64)>; 2],
}

fn finite_rect(r: WorldRect) -> bool {
    [
        f64::from(r.x),
        f64::from(r.y),
        f64::from(r.w),
        f64::from(r.h),
    ]
    .iter()
    .all(|v| v.is_finite()) && r.w>=0. && r.h>=0. && (r.x+r.w).is_finite() && (r.y+r.h).is_finite()
}

fn candidates(rect: WorldRect, axis: Axis) -> [f64; 3] {
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

fn moving_edges(rect: WorldRect, axis: Axis) -> [f64; 3] {
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
    moving: WorldRect,
    targets: &[WorldRect],
    axis: Axis,
    threshold: f64,
) -> Option<(f64, f64, f64, f64)> {
    // (delta, guide position, extent start, extent end) of the best snap;
    // the smallest |delta| wins, including an already aligned edge.
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
                if delta.abs() > threshold {
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
    snap_world(moving.into(),parent.map(Into::into),&siblings.iter().copied().map(Into::into).collect::<Vec<_>>(),threshold)
}

pub fn snap_world(moving: WorldRect, parent: Option<WorldRect>, siblings: &[WorldRect], threshold: f64) -> Snap {
    let invalid = !finite_rect(moving)
        || !threshold.is_finite()
        || threshold <= 0.
        || threshold > 1e4
        || parent.is_some_and(|p| !finite_rect(p))
        || siblings.iter().any(|r| !finite_rect(*r));
    if invalid {
        return Snap::default();
    }
    let mut targets: Vec<WorldRect> = Vec::with_capacity(siblings.len() + 1);
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
            result.target_spans[slot] = Some((target_lo, target_hi));
            match axis {
                Axis::X => result.dx = delta,
                Axis::Y => result.dy = delta,
            }
        }
    }
    result
}

/// Immutable gesture targets. Positions with identical coordinates retain the
/// earliest authored candidate. Queries inspect only neighbours of the three
/// moving edges, while preserving parent/target/edge tie order exactly.
pub struct Index { axes: [Vec<(f64, usize, f64, f64)>; 2] }
impl Index {
    pub fn new(parent: Option<Rect>, siblings: &[Rect]) -> Self {
        Self::new_world(parent.map(Into::into),&siblings.iter().copied().map(Into::into).collect::<Vec<_>>())
    }
    pub fn new_world(parent: Option<WorldRect>, siblings: &[WorldRect]) -> Self {
        if parent.is_some_and(|r|!finite_rect(r)) || siblings.iter().any(|r|!finite_rect(*r)) {return Self{axes:Default::default()};}
        let targets: Vec<_> = parent.into_iter().chain(siblings.iter().copied()).collect();
        let axes = std::array::from_fn(|slot| {
            let axis = if slot==0 {Axis::X} else {Axis::Y};
            let mut entries=Vec::with_capacity(targets.len()*3);
            for (id,target) in targets.iter().enumerate() {
                let (lo,hi)=if slot==0 {(f64::from(target.y),f64::from(target.y)+f64::from(target.h))}
                    else {(f64::from(target.x),f64::from(target.x)+f64::from(target.w))};
                for (edge,position) in candidates(*target,axis).into_iter().enumerate() {
                    entries.push((position,id*3+edge,lo,hi));
                }
            }
            // Signed zero is the same world position. Preserve authored rank
            // when deduplicating it, just like the reference scan's ties.
            entries.sort_by(|a,b|if a.0==b.0 {a.1.cmp(&b.1)} else {a.0.total_cmp(&b.0)});
            entries.dedup_by(|a,b|a.0==b.0);
            entries
        });
        Self {axes}
    }
    pub fn snap(&self, moving: impl Into<WorldRect>, threshold: f64) -> Snap {
        let moving=moving.into();
        if !finite_rect(moving) || !threshold.is_finite() || threshold<=0. || threshold>1e4 {return Snap::default();}
        let mut result=Snap::default();
        for (slot,axis) in [Axis::X,Axis::Y].into_iter().enumerate() {
            let positions=&self.axes[slot];
            let mut best:Option<(f64,usize,usize,f64,f64,f64)>=None;
            for (edge_id,edge) in moving_edges(moving,axis).into_iter().enumerate() {
                let right=positions.partition_point(|v|v.0<edge);
                for index in [right.checked_sub(1), (right<positions.len()).then_some(right)].into_iter().flatten() {
                    let (position,rank,lo,hi)=positions[index];let delta=position-edge;
                    if delta.abs()>threshold {continue;}
                    let replace=best.is_none_or(|(d,r,e,..)|delta.abs().total_cmp(&d.abs()).then(rank.cmp(&r)).then(edge_id.cmp(&e)).is_lt());
                    if replace {best=Some((delta,rank,edge_id,position,lo,hi));}
                }
            }
            if let Some((delta,_,_,position,lo,hi))=best {
                let (start,end)=if slot==0 {(f64::from(moving.y),f64::from(moving.y)+f64::from(moving.h))}
                    else {(f64::from(moving.x),f64::from(moving.x)+f64::from(moving.w))};
                result.guides[slot]=Some(Guide{axis,position,start:start.min(lo),end:end.max(hi)});
                result.target_spans[slot]=Some((lo,hi));
                if slot==0 {result.dx=delta;} else {result.dy=delta;}
            }
        }
        result
    }
}

#[cfg(test)]
mod indexed_tests {
    use super::*;
    #[test]
    fn indexed_targets_preserve_distant_guides_zero_skips_and_all_ties() {
        let targets: Vec<_>=(0..1000).map(|i|Rect::new(i%23*13-110,i%31*17-200,(i%17) as u32,(i%19) as u32)).collect();
        for parent in [None,Some(Rect::new(0,0,200,100))] {
            let index=Index::new(parent,&targets);
            for i in 0..500 {
                let moving=Rect::new(i%37*7-100,i%41*5-100,(i%31)as u32,(i%29)as u32);
                for threshold in [0.,0.25,0.5,1.,6.,33.,1e4,f64::NAN] {
                    assert_eq!(index.snap(moving,threshold),snap(moving,parent,&targets,threshold),"{i} {threshold}");
                }
            }
        }
    }
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
    fn aligned_edge_stays_still_when_another_center_is_nearby() {
        // The already aligned left edges have the smallest displacement.
        // A nearby center must not pull them one pixel apart.
        let result = snap(rect(50, 0, 10, 10), None, &[rect(50, 30, 12, 4)], 2.);
        assert_eq!(result.dx, 0.);
        assert_eq!(result.guides[0].unwrap().position, 50.);
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
