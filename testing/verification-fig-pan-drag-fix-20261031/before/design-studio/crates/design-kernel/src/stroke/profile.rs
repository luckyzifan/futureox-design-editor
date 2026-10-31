//! Arc-length attributed stroke expansion. Geometry stays in local coordinates until
//! after expansion, so nonuniform transforms affect paths and widths identically.
use crate::{
    math::Point,
    path::Contour,
    scene::{Node, Stroke},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct WidthPoint {
    pub position: f64,
    pub left: f64,
    pub right: f64,
}

pub fn validate(s: &Stroke) -> Result<(), String> {
    if !s.width.is_finite()
        || !(0. ..=10000.).contains(&s.width)
        || !["center", "inside", "outside"].contains(&s.align.as_str())
        || !["butt", "round", "square"].contains(&s.cap.as_str())
        || !["miter", "round", "bevel"].contains(&s.join.as_str())
    {
        return Err("Invalid stroke parameters".into());
    }
    super::pattern(&s.dash)?;
    if !s.dash_offset.is_finite() || s.dash_offset.abs() > 1e7 {
        return Err("Invalid dash offset".into());
    }
    let ps = &s.width_profile;
    if ps.len() > 512
        || ps.iter().any(|p| {
            !p.position.is_finite()
                || !(0. ..=1.).contains(&p.position)
                || !p.left.is_finite()
                || !(0. ..=4.).contains(&p.left)
                || !p.right.is_finite()
                || !(0. ..=4.).contains(&p.right)
        })
        || ps.windows(2).any(|p| p[1].position - p[0].position < 1e-6)
    {
        return Err(
            "Width profile requires ordered, distinct positions (0–1) and widths (0–4)".into(),
        );
    }
    Ok(())
}

impl Node {
    pub fn validate_strokes(&self) -> Result<(), String> {
        for s in &self.strokes {
            validate(s)?;
        }
        if self.strokes.iter().any(|s| !s.width_profile.is_empty()) {
            if self.kind == "text" {
                return Err("Width profiles require vector outlines; convert text first".into());
            }
            // A branched network has no single arc-length coordinate. Keep the
            // operation explicit instead of silently choosing one branch order.
            if let Some(g) = &self.network {
                let mut degree = std::collections::HashMap::new();
                for e in &g.edges {
                    for id in [&e.from, &e.to] {
                        let d = degree.entry(id).or_insert(0);
                        *d += 1;
                        if *d > 2 {
                            return Err("Width profiles require unbranched paths".into());
                        }
                    }
                }
            }
            let (_, path) = self.paths()?;
            if path
                .commands
                .iter()
                .any(|c| matches!(c, crate::path::Command::Close))
            {
                for s in &self.strokes {
                    validate_seam(&s.width_profile)?;
                }
            }
        }
        Ok(())
    }
}

fn validate_seam(ps: &[WidthPoint]) -> Result<(), String> {
    if let (Some(a), Some(b)) = (ps.first(), ps.last())
        && a.position == 0.
        && b.position == 1.
        && ((a.left - b.left).abs() > 1e-9 || (a.right - b.right).abs() > 1e-9)
    {
        return Err("Closed stroke profile must have matching widths at 0 and 1".into());
    }
    Ok(())
}

pub fn maximum_width(s: &Stroke) -> f64 {
    s.width
        * if s.width_profile.is_empty() {
            1.
        } else {
            s.width_profile
                .iter()
                .map(|p| p.left.max(p.right))
                .fold(0., f64::max)
        }
}

#[derive(Serialize)]
pub struct Handle {
    pub index: usize,
    pub contour: usize,
    pub point: Point,
    pub normal: Point,
}

pub fn handles(n: &Node, stroke_index: usize) -> Result<Vec<Handle>, String> {
    n.validate_strokes()?;
    let s = n.strokes.get(stroke_index).ok_or("Missing stroke")?;
    let (_, path) = n.paths()?;
    let cs = path.flatten(crate::math::Transform::default(), 0.02)?;
    let mut result = Vec::new();
    for (contour, c) in cs.iter().enumerate() {
        let mut ps = c.points.clone();
        ps.dedup_by(|a, b| (*a - *b).length() < 1e-10);
        if c.closed && ps.len() > 1 {
            ps.push(ps[0]);
        }
        let total: f64 = ps.windows(2).map(|p| (p[1] - p[0]).length()).sum();
        if total < 1e-10 {
            continue;
        }
        for (index, p) in s.width_profile.iter().enumerate() {
            if c.closed && p.position == 1. && s.width_profile[0].position == 0. {
                continue;
            }
            let target = total * p.position;
            let mut at = 0.;
            for pair in ps.windows(2) {
                let length = (pair[1] - pair[0]).length();
                if length < 1e-10 {
                    continue;
                }
                if target <= at + length + 1e-9 {
                    result.push(Handle {
                        index,
                        contour,
                        point: pair[0].lerp(pair[1], ((target - at) / length).clamp(0., 1.)),
                        normal: (pair[1] - pair[0]).normal(),
                    });
                    // Repeated subpaths share the same profile controls. Bound
                    // the overlay without limiting the rendered document.
                    if result.len() == 4096 {
                        return Ok(result);
                    }
                    break;
                }
                at += length;
            }
        }
    }
    Ok(result)
}

fn widths(ps: &[WidthPoint], t: f64, closed: bool) -> (f64, f64) {
    let i = ps.partition_point(|p| p.position <= t);
    let first = ps[0];
    let last = ps[ps.len() - 1];
    let (a, b) = if i == 0 {
        if !closed {
            return (first.left, first.right);
        }
        (
            WidthPoint {
                position: last.position - 1.,
                ..last
            },
            first,
        )
    } else if i == ps.len() {
        if !closed {
            return (last.left, last.right);
        }
        (
            last,
            WidthPoint {
                position: first.position + 1.,
                ..first
            },
        )
    } else {
        (ps[i - 1], ps[i])
    };
    let f = if b.position - a.position <= 1e-12 {
        0.
    } else {
        ((t - a.position) / (b.position - a.position)).clamp(0., 1.)
    };
    (
        a.left + (b.left - a.left) * f,
        a.right + (b.right - a.right) * f,
    )
}

#[derive(Clone, Copy)]
struct Sample {
    p: Point,
    left: f64,
    right: f64,
}
impl Sample {
    fn lerp(self, b: Self, t: f64) -> Self {
        Self {
            p: self.p.lerp(b.p, t),
            left: self.left + (b.left - self.left) * t,
            right: self.right + (b.right - self.right) * t,
        }
    }
}

/// Generate positive-winding union primitives, shared by CPU rasterization,
/// GPU stencil/cover, hit testing, and SVG/outline export. `dilation` grows each
/// side for picking; it does not amplify pressure at narrow profile points.
pub fn expand(
    cs: &[Contour],
    s: &Stroke,
    tolerance: f64,
    dilation: f64,
) -> Result<Vec<Contour>, String> {
    validate(s)?;
    let mut result = expand_body(cs, s, tolerance, dilation)?;
    let mut count = result.iter().map(|c| c.points.len()).sum();
    result.extend(super::markers::expand(
        cs, s, tolerance, dilation, &mut count,
    )?);
    Ok(result)
}
fn expand_body(
    cs: &[Contour],
    s: &Stroke,
    tolerance: f64,
    dilation: f64,
) -> Result<Vec<Contour>, String> {
    if !tolerance.is_finite()
        || tolerance <= 0.
        || !dilation.is_finite()
        || !(0. ..=1000.).contains(&dilation)
    {
        return Err("Invalid stroke expansion tolerance".into());
    }
    let width = s.width * if s.align == "center" { 1. } else { 2. };
    let synthesized_profile = s.width_profile.is_empty() && width + dilation * 2. > 20000.;
    let mut uniform;
    let s = if synthesized_profile {
        // Preserve both the large-dilation profile route and the original
        // uniform path's GLOBAL dash budget after converting the representation.
        uniform = s.clone();
        uniform.width_profile.push(WidthPoint {
            position: 0.,
            left: 1.,
            right: 1.,
        });
        &uniform
    } else {
        s
    };
    let pattern = super::pattern(&s.dash)?;
    let mut budget = Budget {
        synthesized_profile,
        ..Budget::default()
    };
    if tolerance >= 1e-6 {
        return expand_geometry(cs, s, tolerance, dilation, &pattern, &mut budget);
    }
    // An absolute short-edge epsilon must not swallow a device-visible segment.
    // Use one exact power-of-two unit change for each ENTIRE contour, including
    // arc lengths, dash phase, width, picking dilation and geometric tolerance.
    // Ordinary inputs take the unchanged path above. Original document limits
    // have already been checked; normalized lengths are not document values.
    let exponent = (-6. - tolerance.log2()).ceil();
    if !exponent.is_finite() || exponent > 1023. {
        return Err("Stroke normalization exceeds numerical range".into());
    }
    let factor = 2f64.powi(exponent as i32);
    let mut normalized = s.clone();
    normalized.width *= factor;
    normalized.dash_offset *= factor;
    let tolerance = tolerance * factor;
    let dilation = dilation * factor;
    let pattern: Vec<_> = pattern.into_iter().map(|v| v * factor).collect();
    // Leave ample headroom for squared/cross-product geometric arithmetic.
    let safe = |v: f64| v.is_finite() && v.abs() <= 1e100;
    if ![
        normalized.width,
        normalized.dash_offset,
        tolerance,
        dilation,
    ]
    .into_iter()
    .all(safe)
        || pattern.iter().any(|v| !safe(*v))
        || !pattern.iter().sum::<f64>().is_finite()
    {
        return Err("Stroke normalization exceeds numerical range".into());
    }
    let mut result = Vec::new();
    for contour in cs {
        let Some(origin) = contour.points.first().copied() else {
            continue;
        };
        if !origin.finite() {
            return Err("Invalid stroke contour point".into());
        }
        let points: Vec<_> = contour
            .points
            .iter()
            .map(|p| (*p - origin) * factor)
            .collect();
        if points.iter().any(|p| !safe(p.x) || !safe(p.y)) {
            return Err("Stroke normalization exceeds numerical range".into());
        }
        let local = Contour {
            points,
            closed: contour.closed,
        };
        let mut output = expand_geometry(
            &[local],
            &normalized,
            tolerance,
            dilation,
            &pattern,
            &mut budget,
        )?;
        for contour in &mut output {
            for point in &mut contour.points {
                *point = *point * (1. / factor) + origin;
                if !point.finite() {
                    return Err("Stroke normalization produced a nonfinite point".into());
                }
            }
        }
        result.extend(output);
    }
    Ok(result)
}

#[derive(Default)]
struct Budget {
    input: usize,
    output: usize,
    dash: usize,
    synthesized_profile: bool,
}
fn expand_geometry(
    cs: &[Contour],
    s: &Stroke,
    tolerance: f64,
    dilation: f64,
    pattern: &[f64],
    budget: &mut Budget,
) -> Result<Vec<Contour>, String> {
    let width = s.width * if s.align == "center" { 1. } else { 2. };
    if s.width_profile.is_empty() {
        let dashed = super::dash_geometry(cs, pattern, s.dash_offset, &mut budget.dash)?;
        return super::outline_geometry(
            &dashed,
            width + dilation * 2.,
            &s.cap,
            &s.join,
            tolerance,
            &mut budget.output,
        );
    }
    if width == 0. {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for c in cs {
        if c.closed {
            validate_seam(&s.width_profile)?;
        }
        let mut points = c.points.clone();
        points.dedup_by(|a, b| (*a - *b).length() < 1e-10);
        if c.closed && points.len() > 1 && (points[0] - points[points.len() - 1]).length() < 1e-10 {
            points.pop();
        }
        if points.is_empty() {
            continue;
        }
        if c.closed {
            points.push(points[0]);
        }
        let total: f64 = points.windows(2).map(|p| (p[1] - p[0]).length()).sum();
        let sample = |p, t| {
            let (left, right) = widths(&s.width_profile, t, c.closed);
            Sample {
                p,
                left: left * width / 2. + dilation,
                right: right * width / 2. + dilation,
            }
        };
        let mut samples = vec![sample(points[0], 0.)];
        let mut at = 0.;
        let mut knot = 0;
        for pair in points.windows(2) {
            let len = (pair[1] - pair[0]).length();
            if len < 1e-10 {
                continue;
            }
            let end = at + len;
            while knot < s.width_profile.len() {
                let distance = s.width_profile[knot].position * total;
                if distance >= end - 1e-10 {
                    break;
                }
                knot += 1;
                if distance > at + 1e-10 {
                    samples.push(sample(
                        pair[0].lerp(pair[1], (distance - at) / len),
                        distance / total,
                    ));
                }
            }
            samples.push(sample(pair[1], end / total));
            at = end;
        }
        budget.input += samples.len();
        if budget.input > 100_000 {
            return Err("Width profile subdivision budget exceeded".into());
        }
        let mut local_dash_count = 0;
        let dash_count = if budget.synthesized_profile {
            &mut budget.dash
        } else {
            &mut local_dash_count
        };
        let parts = split_dashes(&samples, c.closed, pattern, s.dash_offset, dash_count)?;
        for (ps, closed) in parts {
            emit(&ps, closed, s, tolerance, &mut out, &mut budget.output)?;
        }
    }
    Ok(out)
}

fn split_dashes(
    samples: &[Sample],
    closed: bool,
    pattern: &[f64],
    offset: f64,
    count: &mut usize,
) -> Result<Vec<(Vec<Sample>, bool)>, String> {
    if pattern.is_empty() {
        let mut ps = samples.to_vec();
        if closed && ps.len() > 1 {
            ps.pop();
        }
        return Ok(vec![(ps, closed)]);
    }
    let mut result: Vec<(Vec<Sample>, bool)> = Vec::new();
    let mut active = Vec::new();
    let (mut phase, mut remaining) = super::dash_start(pattern, offset);
    for pair in samples.windows(2) {
        let mut a = pair[0];
        let b = pair[1];
        let mut length = (b.p - a.p).length();
        while length > 1e-10 {
            while remaining <= 1e-10 {
                if phase % 2 == 0 && active.len() > 1 {
                    result.push((std::mem::take(&mut active), false));
                }
                phase = (phase + 1) % pattern.len();
                remaining = pattern[phase];
            }
            let take = remaining.min(length);
            let end = a.lerp(b, take / length);
            if phase % 2 == 0 {
                if active.is_empty() {
                    active.push(a);
                }
                active.push(end);
            }
            *count += 1;
            if *count > 20_000 {
                return Err("Dash subdivision budget exceeded".into());
            }
            a = end;
            length -= take;
            remaining -= take;
        }
    }
    if active.len() > 1 {
        result.push((active, false));
    }
    if closed && !result.is_empty() {
        let first = result[0].0[0].p;
        let last = result.last().unwrap().0.last().unwrap().p;
        if (first - last).length() < 1e-8 {
            if result.len() == 1 {
                result[0].0.pop();
                result[0].1 = true;
            } else {
                let mut tail = result.pop().unwrap().0;
                tail.extend_from_slice(&result[0].0[1..]);
                result[0].0 = tail;
            }
        }
    }
    Ok(result)
}

pub(super) fn arc(
    center: Point,
    start: Point,
    sweep: f64,
    tolerance: f64,
) -> Result<Contour, String> {
    let r = (start - center).length();
    let angle = (start.y - center.y).atan2(start.x - center.x);
    let count = super::arc_segments(r, sweep, tolerance)?;
    let mut ps = vec![center];
    ps.extend((0..=count).map(|i| {
        let a = angle + sweep * i as f64 / count as f64;
        center + Point::new(a.cos(), a.sin()) * r
    }));
    Ok(super::polygon(ps))
}

fn emit(
    ps: &[Sample],
    closed: bool,
    s: &Stroke,
    tolerance: f64,
    out: &mut Vec<Contour>,
    count: &mut usize,
) -> Result<(), String> {
    let mut push = |c: Contour| {
        *count += c.points.len();
        if *count > 2_000_000 {
            return Err("Stroke output budget exceeded".to_string());
        }
        out.push(c);
        Ok(())
    };
    if ps.len() < 2 {
        if let Some(p) = ps.first()
            && s.cap == "round"
        {
            push(super::disk(p.p, (p.left + p.right) / 2., tolerance)?)?;
        }
        return Ok(());
    }
    let edges = if closed { ps.len() } else { ps.len() - 1 };
    for i in 0..edges {
        let a = ps[i];
        let b = ps[(i + 1) % ps.len()];
        let d = b.p - a.p;
        let normal = d.normal();
        push(super::polygon(vec![
            a.p + normal * a.left,
            b.p + normal * b.left,
            b.p - normal * b.right,
            a.p - normal * a.right,
        ]))?;
    }
    for (i, p) in ps.iter().enumerate() {
        if !closed && (i == 0 || i == ps.len() - 1) {
            let other = if i == 0 { ps[1].p } else { ps[i - 1].p };
            let d = other - p.p;
            let inward = d * (1. / d.length().max(1e-10));
            let normal = inward.normal() * if i == 0 { 1. } else { -1. };
            let left = p.p + normal * p.left;
            let right = p.p - normal * p.right;
            let r = (p.left + p.right) / 2.;
            if s.cap == "round" && r > 0. {
                push(arc(
                    (left + right) * 0.5,
                    left,
                    if i == 0 {
                        std::f64::consts::PI
                    } else {
                        -std::f64::consts::PI
                    },
                    tolerance,
                )?)?;
            } else if s.cap == "square" {
                push(super::polygon(vec![
                    left,
                    left - inward * r,
                    right - inward * r,
                    right,
                ]))?;
            }
            continue;
        }
        let prev = ps[(i + ps.len() - 1) % ps.len()];
        let next = ps[(i + 1) % ps.len()];
        let a = p.p - prev.p;
        let b = next.p - p.p;
        let a = a * (1. / a.length().max(1e-10));
        let b = b * (1. / b.length().max(1e-10));
        let turn = a.cross(b);
        if turn.abs() < 1e-10 && a.dot(b) > 0. {
            continue;
        }
        if turn.abs() < 1e-10 && a.dot(b) < 0. {
            if s.join == "round" {
                // At a reversal both sides become exterior; choosing just the
                // right radius clips an asymmetric cusp.
                push(super::disk(p.p, p.left.max(p.right), tolerance)?)?;
            }
            continue;
        }
        let sign = if turn >= 0. { -1. } else { 1. };
        let (r, prev_r, next_r) = if sign > 0. {
            (p.left, prev.left, next.left)
        } else {
            (p.right, prev.right, next.right)
        };
        let left = p.p + a.normal() * (r * sign);
        let right = p.p + b.normal() * (r * sign);
        if s.join == "round" && r > 0. {
            let sweep = if turn.abs() < 1e-10 {
                std::f64::consts::PI
            } else {
                turn.atan2(a.dot(b))
            };
            push(arc(p.p, left, sweep, tolerance)?)?;
        } else {
            let mut poly = vec![p.p, left];
            if s.join == "miter" && r > 0. {
                // Intersect the actual tapered offset edges, not parallel lines
                // at constant radius. This matters at large pressure gradients.
                let da = left - (prev.p + a.normal() * (prev_r * sign));
                let db = next.p + b.normal() * (next_r * sign) - right;
                let cross = da.cross(db);
                if cross.abs() > 1e-12 {
                    let m = left + da * ((right - left).cross(db) / cross);
                    if m.finite() && (m - p.p).length() <= r * 4. {
                        poly.push(m);
                    }
                }
            }
            poly.push(right);
            push(super::polygon(poly))?;
        }
    }
    Ok(())
}
