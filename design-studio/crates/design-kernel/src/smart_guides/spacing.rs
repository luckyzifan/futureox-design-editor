//! Equal gaps for a fixed set of gesture targets.
use super::{Axis, Snap, WorldRect, finite_rect};
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct GapLine {
    pub start: f64,
    pub end: f64,
    pub cross: f64,
}

pub type GapPair = [GapLine; 2];

#[derive(Clone, Copy)]
struct Span {
    start: f64,
    end: f64,
    cross_start: f64,
    cross_end: f64,
}

impl Span {
    fn new(rect: WorldRect, axis: Axis) -> Self {
        match axis {
            Axis::X => Self {
                start: rect.x,
                end: rect.x + rect.w,
                cross_start: rect.y,
                cross_end: rect.y + rect.h,
            },
            Axis::Y => Self {
                start: rect.y,
                end: rect.y + rect.h,
                cross_start: rect.x,
                cross_end: rect.x + rect.w,
            },
        }
    }

    fn near(self, other: Self, threshold: f64) -> bool {
        self.cross_start <= other.cross_end + threshold
            && other.cross_start <= self.cross_end + threshold
    }

    fn at(self, start: f64) -> Self {
        Self {
            start,
            end: start + (self.end - self.start),
            ..self
        }
    }
}

fn gap(left: Span, right: Span) -> GapLine {
    let lo = left.cross_start.max(right.cross_start);
    let hi = left.cross_end.min(right.cross_end);
    let cross = if lo <= hi {
        lo * 0.5 + hi * 0.5
    } else {
        left.cross_start.min(right.cross_start) * 0.5 + left.cross_end.max(right.cross_end) * 0.5
    };
    GapLine {
        start: left.end,
        end: right.start,
        cross,
    }
}

#[derive(Clone, Copy)]
struct Hit {
    delta: f64,
    lines: GapPair,
    reference_distance: f64,
}

fn wins(delta: f64, distance: f64, threshold: f64, best: Option<Hit>) -> bool {
    delta.abs() < threshold
        && best.is_none_or(|hit| {
            delta
                .abs()
                .total_cmp(&hit.delta.abs())
                .then(distance.total_cmp(&hit.reference_distance))
                .is_lt()
        })
}

pub struct SpacingIndex {
    spans: [Vec<Span>; 2],
}

impl SpacingIndex {
    pub fn new(siblings: &[WorldRect]) -> Self {
        let spans = [Axis::X, Axis::Y].map(|axis| {
            let mut spans: Vec<_> = siblings
                .iter()
                .copied()
                .filter(|r| finite_rect(*r) && r.w > 0. && r.h > 0.)
                .map(|r| Span::new(r, axis))
                .collect();
            spans.sort_by(|a, b| a.start.total_cmp(&b.start));
            spans
        });
        Self { spans }
    }

    /// Retain exact edge/center ties. Spacing uses the immediate free interval
    /// and the clear gaps in the same band. Each axis makes two linear scans
    /// of the pre-sorted targets, without sorting or allocating on a query.
    pub fn snap(
        &self,
        moving: WorldRect,
        threshold: f64,
        mut edges: Snap,
    ) -> (Snap, [Option<GapPair>; 2]) {
        let mut gaps = [None, None];
        if !finite_rect(moving)
            || moving.w <= 0.
            || moving.h <= 0.
            || !threshold.is_finite()
            || threshold <= 0.
            || threshold > 1e4
        {
            return (edges, gaps);
        }
        for (slot, axis) in [Axis::X, Axis::Y].into_iter().enumerate() {
            let delta = if slot == 0 {
                &mut edges.dx
            } else {
                &mut edges.dy
            };
            let limit = if edges.guides[slot].is_some() {
                threshold.min(delta.abs())
            } else {
                threshold
            };
            if limit == 0. {
                continue;
            }
            if let Some(hit) = self.snap_axis(slot, Span::new(moving, axis), threshold, limit) {
                *delta = hit.delta;
                edges.guides[slot] = None;
                edges.target_spans[slot] = None;
                gaps[slot] = Some(hit.lines);
            }
        }
        (edges, gaps)
    }

    fn snap_axis(&self, slot: usize, moving: Span, threshold: f64, limit: f64) -> Option<Hit> {
        let relevant = || {
            self.spans[slot]
                .iter()
                .copied()
                .filter(|s| s.near(moving, threshold))
        };
        let mut before: Option<Span> = None;
        let mut after: Option<Span> = None;
        for span in relevant() {
            if span.start >= moving.end {
                after = Some(span);
                break;
            }
            if span.end > moving.start {
                return None;
            }
            if before.is_none_or(|left| span.end > left.end) {
                before = Some(span);
            }
        }
        let size = moving.end - moving.start;
        let min_start = before.map_or(f64::NEG_INFINITY, |left| left.end);
        let max_start = after.map_or(f64::INFINITY, |right| right.start - size);
        let mut best = None;
        if let (Some(left), Some(right)) = (before, after) {
            let start = min_start * 0.5 + max_start * 0.5;
            let delta = start - moving.start;
            if start > min_start && start < max_start && wins(delta, 0., limit, best) {
                let moved = moving.at(start);
                best = Some(Hit {
                    delta,
                    lines: [gap(left, moved), gap(moved, right)],
                    reference_distance: 0.,
                });
            }
        }

        let mut previous: Option<Span> = None;
        for right in relevant() {
            let Some(left) = previous else {
                previous = Some(right);
                continue;
            };
            if right.start <= left.end {
                if right.end > left.end {
                    previous = Some(right);
                }
                continue;
            }
            previous = Some(right);
            if !left.near(right, threshold) {
                continue;
            }
            let width = right.start - left.end;
            for (start, neighbor, leading) in [
                before.map(|s| (s.end + width, s, true)),
                after.map(|s| (s.start - width - size, s, false)),
            ]
            .into_iter()
            .flatten()
            {
                let delta = start - moving.start;
                let edge = if leading {
                    neighbor.end
                } else {
                    neighbor.start
                };
                let distance = (edge - left.end).abs().min((edge - right.start).abs());
                if start >= min_start && start <= max_start && wins(delta, distance, limit, best) {
                    let moved = moving.at(start);
                    let created = if leading {
                        gap(neighbor, moved)
                    } else {
                        gap(moved, neighbor)
                    };
                    if created.end > created.start {
                        best = Some(Hit {
                            delta,
                            lines: [gap(left, right), created],
                            reference_distance: distance,
                        });
                    }
                }
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smart_guides::{Guide, Index};

    fn rect(x: f64, y: f64, w: f64, h: f64) -> WorldRect {
        WorldRect { x, y, w, h }
    }

    #[test]
    fn repeats_a_clear_gap_and_reports_both_segments() {
        let siblings = [
            rect(0., 0., 10., 10.),
            rect(20., 0., 10., 10.),
            rect(210., 50., 3., 3.),
        ];
        let moving = rect(37., 0., 5., 10.);
        let edges = Index::new_world(None, &siblings).snap(moving, 6.);
        let (snap, gaps) = SpacingIndex::new(&siblings).snap(moving, 6., edges);
        assert_eq!(snap.dx, 3.);
        assert_eq!(
            gaps[0],
            Some([
                GapLine {
                    start: 10.,
                    end: 20.,
                    cross: 5.
                },
                GapLine {
                    start: 30.,
                    end: 40.,
                    cross: 5.
                },
            ])
        );
    }

    #[test]
    fn centers_between_neighbors_without_moving_an_already_equal_gap() {
        let siblings = [rect(0., 0., 10., 10.), rect(50., 0., 10., 10.)];
        let spacing = SpacingIndex::new(&siblings);
        let (snap, gaps) = spacing.snap(rect(21., 0., 10., 10.), 6., Snap::default());
        assert_eq!(snap.dx, 4.);
        assert_eq!(
            gaps[0],
            Some([
                GapLine {
                    start: 10.,
                    end: 25.,
                    cross: 5.
                },
                GapLine {
                    start: 35.,
                    end: 50.,
                    cross: 5.
                },
            ])
        );
        let (snap, gaps) = spacing.snap(rect(25., 0., 10., 10.), 6., Snap::default());
        assert_eq!(snap.dx, 0.);
        assert!(gaps[0].is_some());
    }

    #[test]
    fn ties_keep_object_edges_and_ignore_overlapping_or_zero_area_targets() {
        let a = rect(0., 0., 10., 10.);
        let b = rect(20., 0., 10., 10.);
        let moving = rect(37., 0., 5., 10.);
        let mut edges = Snap::default();
        edges.dx = -3.;
        edges.guides[0] = Some(Guide {
            axis: Axis::X,
            position: 34.,
            start: 0.,
            end: 10.,
        });
        assert_eq!(
            SpacingIndex::new(&[a, b]).snap(moving, 6., edges),
            (edges, [None, None])
        );
        let cover = rect(-5., 0., 37., 10.);
        let ruler = rect(15., -3., 0., 28.);
        let (snap, gaps) =
            SpacingIndex::new(&[a, b, cover, ruler]).snap(moving, 6., Snap::default());
        assert_eq!(snap.dx, 0.);
        assert_eq!(gaps[0], None);
    }
}
