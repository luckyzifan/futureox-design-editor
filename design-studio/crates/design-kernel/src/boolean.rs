use crate::{
    math::Point,
    path::{Contour, area, winding},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Union,
    Subtract,
    Intersect,
    Exclude,
}
#[derive(Clone)]
struct Segment {
    a: Point,
    b: Point,
    cuts: Vec<f64>,
}
pub fn boolean(inputs: &[Vec<Contour>], op: Operation) -> Result<Vec<Contour>, String> {
    boolean_with_rules(inputs, op, &[])
}
pub fn boolean_with_rules(
    inputs: &[Vec<Contour>],
    op: Operation,
    even_odd: &[bool],
) -> Result<Vec<Contour>, String> {
    let mut segments: Vec<Segment> = inputs
        .iter()
        .flatten()
        .filter(|c| c.closed)
        .flat_map(|c| {
            c.points.iter().enumerate().map(|(i, a)| Segment {
                a: *a,
                b: c.points[(i + 1) % c.points.len()],
                cuts: vec![0., 1.],
            })
        })
        .filter(|s| (s.b - s.a).length() > 1e-10)
        .collect();
    if segments.len() > 12000 {
        return Err("Boolean input exceeds 12000 edges".into());
    }
    if segments.is_empty() {
        return Ok(Vec::new());
    }
    let magnitude = segments
        .iter()
        .map(|s| s.a.x.abs().max(s.a.y.abs()))
        .fold(1., f64::max);
    let eps = (magnitude * 1e-11).max(1e-8);
    let snap = eps * 4.;
    fn cut(s: &mut Segment, t: f64) {
        if (-1e-9..=1. + 1e-9).contains(&t) {
            s.cuts.push(t.clamp(0., 1.));
        }
    }
    let mut order: Vec<usize> = (0..segments.len()).collect();
    order.sort_by(|a, b| {
        segments[*a]
            .a
            .x
            .min(segments[*a].b.x)
            .total_cmp(&segments[*b].a.x.min(segments[*b].b.x))
    });
    let mut comparisons = 0usize;
    for (at, &i) in order.iter().enumerate() {
        let max_x = segments[i].a.x.max(segments[i].b.x);
        for &j in &order[at + 1..] {
            if segments[j].a.x.min(segments[j].b.x) > max_x + eps {
                break;
            }
            comparisons += 1;
            if comparisons > 20_000_000 {
                return Err("Boolean intersection budget exceeded".into());
            }
            let (a, b) = if i < j {
                let (l, r) = segments.split_at_mut(j);
                (&mut l[i], &mut r[0])
            } else {
                let (l, r) = segments.split_at_mut(i);
                (&mut r[0], &mut l[j])
            };
            if a.a.y.max(a.b.y) + eps < b.a.y.min(b.b.y)
                || b.a.y.max(b.b.y) + eps < a.a.y.min(a.b.y)
            {
                continue;
            }
            let r = a.b - a.a;
            let s = b.b - b.a;
            let q = b.a - a.a;
            let det = r.cross(s);
            if det.abs() > 1e-12 * (r.length() * s.length()).max(1.) {
                let t = q.cross(s) / det;
                let u = q.cross(r) / det;
                if (-1e-9..=1. + 1e-9).contains(&t) && (-1e-9..=1. + 1e-9).contains(&u) {
                    cut(a, t);
                    cut(b, u);
                }
            } else if q.cross(r).abs() <= eps * r.length() {
                cut(a, (b.a - a.a).dot(r) / r.dot(r));
                cut(a, (b.b - a.a).dot(r) / r.dot(r));
                cut(b, (a.a - b.a).dot(s) / s.dot(s));
                cut(b, (a.b - b.a).dot(s) / s.dot(s));
            }
        }
    }
    let filled = |p: Point| {
        let bs = inputs
            .iter()
            .enumerate()
            .map(|(i, cs)| {
                let w = winding(p, cs);
                if even_odd.get(i).copied().unwrap_or(true) {
                    w.abs() % 2 != 0
                } else {
                    w != 0
                }
            })
            .collect::<Vec<_>>();
        match op {
            Operation::Union => bs.iter().any(|b| *b),
            Operation::Intersect => bs.iter().all(|b| *b),
            Operation::Subtract => bs[0] && !bs[1..].iter().any(|b| *b),
            Operation::Exclude => bs.iter().filter(|b| **b).count() % 2 != 0,
        }
    };
    type Key = (i64, i64);
    let key = |p: Point| ((p.x / snap).round() as i64, (p.y / snap).round() as i64);
    let mut edges: BTreeMap<(Key, Key), (Point, Point)> = BTreeMap::new();
    let source_lines: Vec<_> = segments.iter().map(|s| (s.a, s.b)).collect();
    let coordinate_noise = 64. * f64::EPSILON * magnitude;
    for s in &mut segments {
        s.cuts.sort_by(f64::total_cmp);
        s.cuts.dedup_by(|a, b| (*a - *b).abs() < 1e-12);
        for pair in s.cuts.windows(2) {
            let mut a = s.a.lerp(s.b, pair[0]);
            let mut b = s.a.lerp(s.b, pair[1]);
            let len = (b - a).length();
            if len < eps {
                continue;
            }
            let mid = a.lerp(b, 0.5);
            // At a shallow stroke join the next boundary can be much closer
            // than the global epsilon. Sample within that local clearance,
            // otherwise both probes cross the thin wedge and a boundary edge
            // disappears. Ignore only coincident lines at arithmetic noise.
            let probe_distance = (len * 0.001).min(eps * 8.);
            let reach = probe_distance * 4.;
            let clearance = source_lines
                .iter()
                .filter(|(p, q)| {
                    mid.x + reach >= p.x.min(q.x)
                        && mid.x - reach <= p.x.max(q.x)
                        && mid.y + reach >= p.y.min(q.y)
                        && mid.y - reach <= p.y.max(q.y)
                })
                .filter_map(|(p, q)| {
                    let d = *q - *p;
                    let t = ((mid - *p).dot(d) / d.dot(d)).clamp(0., 1.);
                    let distance = (mid - (*p + d * t)).length();
                    (distance > coordinate_noise).then_some(distance)
                })
                .fold(f64::INFINITY, f64::min);
            let normal = (b - a).normal() * probe_distance.min(clearance * 0.25);
            let l = filled(mid + normal);
            let r = filled(mid - normal);
            if l == r {
                continue;
            }
            if !l {
                std::mem::swap(&mut a, &mut b);
            }
            edges.insert((key(a), key(b)), (a, b));
        }
    }
    let mut outgoing: BTreeMap<Key, Vec<(Key, Key)>> = BTreeMap::new();
    for &(a, b) in edges.keys() {
        outgoing.entry(a).or_default().push((a, b));
    }
    let mut visited = BTreeSet::new();
    let mut out = Vec::new();
    for &start in edges.keys() {
        if visited.contains(&start) {
            continue;
        }
        let mut at = start;
        let mut points = Vec::new();
        let mut closed = false;
        for _ in 0..=edges.len() {
            if !visited.insert(at) {
                break;
            }
            let (a, b) = edges[&at];
            points.push(a);
            if at.1 == start.0 {
                closed = true;
                break;
            }
            let back = (a.y - b.y).atan2(a.x - b.x);
            let next = outgoing
                .get(&at.1)
                .into_iter()
                .flatten()
                .filter(|e| !visited.contains(*e))
                .min_by(|a, b| {
                    let (pa, qa) = edges[a];
                    let (pb, qb) = edges[b];
                    let aa =
                        (back - (qa.y - pa.y).atan2(qa.x - pa.x)).rem_euclid(std::f64::consts::TAU);
                    let ab =
                        (back - (qb.y - pb.y).atan2(qb.x - pb.x)).rem_euclid(std::f64::consts::TAU);
                    aa.total_cmp(&ab)
                });
            if let Some(next) = next {
                at = *next;
            } else {
                break;
            }
        }
        if !closed {
            return Err("Boolean boundary did not close; source geometry preserved".into());
        }
        if points.len() >= 3 && area(&points).abs() > eps * eps {
            out.push(Contour {
                points,
                closed: true,
            });
        }
    }
    Ok(out)
}
