//! Certified curved Stretch.
//!
//! A source point `(x, y)` maps to `γ(s) + n * left_normal(γ, s)`, where
//! `s = (x - xmin) / (xmax - xmin) * L` uses the same midpoint arc-length
//! coordinate as Scatter and straight Stretch, and `n` scales the source
//! control-box height onto `width`. Straight guides never reach this module.
//!
//! Source Béziers are split only by exact de Casteljau. Each curved image is a
//! cubic Hermite piece whose remainder from that map is at most [`STRETCH_ERROR`].
//! The piece is rejected, not coarsened, when the remainder cannot be certified.
//! Corners (unit-tangent distance above [`TANGENT_TOL`]) and cusps (guide speed
//! below [`CUSP_SPEED`]) stay explicit errors. Closed guides are admitted only
//! when the seam tangent meets the same tolerance.
use super::{
    distance, transformed, Curve, Segment, Track, ARC_ERROR, LIMIT, STRETCH_ERROR, WORK_LIMIT,
};
use crate::math::{Point, Transform};
use crate::path::Command;

const TANGENT_TOL: f64 = 1e-8;
const CUSP_SPEED: f64 = 1e-12;
const STRAIGHT_TOL: f64 = 1e-9;
const CORNER: &str =
    "Stretch requires a straight forward-only guide; corners and cusps are unsupported";
const PRECISION: &str = "Vector brush stretch precision budget exceeded";
const ORDER: usize = 8;

pub(super) fn run(
    source: &crate::path::Path,
    track: &Track,
    xmin: f64,
    xmax: f64,
    ymin: f64,
    ymax: f64,
    yc: f64,
    width: f64,
    out: &mut Vec<Command>,
    work: &mut usize,
) -> Result<(), String> {
    let sx = track.length / (xmax - xmin);
    let sy = width / (ymax - ymin);
    if emit_straight_affine(source, track, xmin, yc, sx, sy, out, work)? {
        return Ok(());
    }
    reject_corners_and_cusps(track)?;
    let leaves = kappa_leaves(track)?;
    let map = Map {
        track,
        leaves: &leaves,
        sx,
        sy,
        xmin,
        yc,
    };
    let mut src = Point::default();
    let mut started = false;
    for command in &source.commands {
        match *command {
            Command::Move(p) => {
                let q = map.point(p, work)?;
                push(out, Command::Move(q))?;
                src = p;
                started = true;
            }
            Command::Line(p) => {
                map.emit(&mut [src, p], out, work)?;
                src = p;
            }
            Command::Quad(a, p) => {
                map.emit(&mut [src, a, p], out, work)?;
                src = p;
            }
            Command::Cubic(a, b, p) => {
                map.emit(&mut [src, a, b, p], out, work)?;
                src = p;
            }
            Command::Close => {
                if !started {
                    return Err("Unsupported brush source command".into());
                }
                push(out, Command::Close)?;
            }
            _ => return Err("Unsupported brush source command".into()),
        }
    }
    Ok(())
}

fn emit_straight_affine(
    source: &crate::path::Path,
    track: &Track,
    xmin: f64,
    yc: f64,
    sx: f64,
    sy: f64,
    out: &mut Vec<Command>,
    work: &mut usize,
) -> Result<bool, String> {
    let Some((origin, tangent)) = straight_frame(track) else {
        return Ok(false);
    };
    let (first, t) = track.frame(0.0, work)?;
    if distance(t, tangent) > STRAIGHT_TOL || distance(first, origin) > STRAIGHT_TOL {
        return Ok(false);
    }
    transformed(
        source,
        Transform([
            t.x * sx,
            t.y * sx,
            -t.y * sy,
            t.x * sy,
            first.x - t.x * sx * xmin + t.y * sy * yc,
            first.y - t.y * sx * xmin - t.x * sy * yc,
        ]),
        out,
    )?;
    Ok(true)
}

fn straight_frame(track: &Track) -> Option<(Point, Point)> {
    let segment = *track.segments.first()?;
    let origin = match segment {
        Segment::Line(a, _) => a,
        Segment::Cubic(curve) => curve.0[0],
    };
    let (t0, _) = segment_tangents(Some(segment)).ok()?;
    for piece in &track.segments {
        let (start, end) = segment_tangents(Some(*piece)).ok()?;
        if distance(start, t0) > STRAIGHT_TOL || distance(end, t0) > STRAIGHT_TOL {
            return None;
        }
        for p in segment_points(*piece) {
            if (p - origin).cross(t0).abs() > STRAIGHT_TOL {
                return None;
            }
        }
    }
    Some((origin, t0))
}

fn reject_corners_and_cusps(track: &Track) -> Result<(), String> {
    if track.segments.is_empty() {
        return Err(CORNER.into());
    }
    let mut previous: Option<Point> = None;
    let mut first_start: Option<Point> = None;
    for segment in &track.segments {
        if let Segment::Cubic(curve) = segment {
            speed_floor(*curve, 0)?;
        }
        let (start, end) = segment_tangents(Some(*segment))?;
        if first_start.is_none() {
            first_start = Some(start);
        }
        if let Some(prev) = previous {
            if distance(prev, start) > TANGENT_TOL {
                return Err(CORNER.into());
            }
        }
        previous = Some(end);
    }
    if track.closed {
        if distance(previous.unwrap(), first_start.unwrap()) > TANGENT_TOL {
            return Err(CORNER.into());
        }
    }
    Ok(())
}

fn speed_floor(curve: Curve, depth: u32) -> Result<(), String> {
    let h = hodograph(curve);
    let dist = if origin_in_triangle(h[0], h[1], h[2]) {
        0.0
    } else {
        dist_origin_segment(h[0], h[1])
            .min(dist_origin_segment(h[1], h[2]))
            .min(dist_origin_segment(h[2], h[0]))
    };
    if dist >= CUSP_SPEED {
        return Ok(());
    }
    if depth >= 16 {
        return Err(CORNER.into());
    }
    let (a, b) = curve.split();
    speed_floor(a, depth + 1)?;
    speed_floor(b, depth + 1)?;
    Ok(())
}

fn segment_tangents(segment: Option<Segment>) -> Result<(Point, Point), String> {
    let segment = segment.ok_or_else(|| CORNER.to_string())?;
    match segment {
        Segment::Line(a, b) => {
            let d = b - a;
            let len = d.length();
            if len < 1e-12 {
                return Err(CORNER.into());
            }
            let t = d * (1.0 / len);
            Ok((t, t))
        }
        Segment::Cubic(curve) => Ok((unit_tangent(curve, 0.0)?, unit_tangent(curve, 1.0)?)),
    }
}

fn unit_tangent(curve: Curve, u: f64) -> Result<Point, String> {
    let (_, t, _) = frame_kappa(curve, u)?;
    Ok(t)
}

fn segment_points(segment: Segment) -> Vec<Point> {
    match segment {
        Segment::Line(a, b) => vec![a, b],
        Segment::Cubic(curve) => curve.0.to_vec(),
    }
}

fn hodograph(curve: Curve) -> [Point; 3] {
    let p = curve.0;
    [
        (p[1] - p[0]) * 3.0,
        (p[2] - p[1]) * 3.0,
        (p[3] - p[2]) * 3.0,
    ]
}

fn origin_in_triangle(a: Point, b: Point, c: Point) -> bool {
    let v0 = c - a;
    let v1 = b - a;
    let v2 = Point::default() - a;
    let dot00 = v0.dot(v0);
    let dot01 = v0.dot(v1);
    let dot02 = v0.dot(v2);
    let dot11 = v1.dot(v1);
    let dot12 = v1.dot(v2);
    let denom = dot00 * dot11 - dot01 * dot01;
    if denom.abs() < 1e-30 {
        return false;
    }
    let u = (dot11 * dot02 - dot01 * dot12) / denom;
    let v = (dot00 * dot12 - dot01 * dot02) / denom;
    u >= -1e-9 && v >= -1e-9 && u + v <= 1.0 + 1e-9
}

fn dist_origin_segment(a: Point, b: Point) -> f64 {
    let ab = b - a;
    let len2 = ab.dot(ab);
    if len2 < 1e-30 {
        return a.length();
    }
    let t = ((Point::default() - a).dot(ab) / len2).clamp(0.0, 1.0);
    (a + ab * t).length()
}

struct LeafK {
    s0: f64,
    s1: f64,
    k: [Iv; 5],
}

fn kappa_leaves(track: &Track) -> Result<Vec<LeafK>, String> {
    let mut leaves = Vec::with_capacity(track.segments.len());
    for (i, segment) in track.segments.iter().enumerate() {
        let k = match *segment {
            Segment::Line(_, _) => [Iv::pt(0.0); 5],
            Segment::Cubic(curve) => kappa_s_bounds(curve, 0)?,
        };
        leaves.push(LeafK {
            s0: track.ends[i],
            s1: track.ends[i + 1],
            k,
        });
    }
    Ok(leaves)
}

fn kappa_s_bounds(curve: Curve, depth: u32) -> Result<[Iv; 5], String> {
    match kappa_s_once(curve) {
        Ok(k) if tight(&k) || depth >= 10 => Ok(k),
        Ok(_) => merge_halves(curve, depth),
        Err(()) if depth < 12 => merge_halves(curve, depth),
        Err(()) => Err(CORNER.into()),
    }
}

fn merge_halves(curve: Curve, depth: u32) -> Result<[Iv; 5], String> {
    let (a, b) = curve.split();
    let left = kappa_s_bounds(a, depth + 1)?;
    let right = kappa_s_bounds(b, depth + 1)?;
    let mut out = left;
    for i in 0..5 {
        out[i] = out[i].union(right[i]);
    }
    Ok(out)
}

fn tight(k: &[Iv; 5]) -> bool {
    // Orders 0 and 1 are the curvature inputs of the stretch certificate.
    // Higher s-derivatives are retained for diagnostics and may be wide.
    k.iter().take(2).all(|iv| {
        iv.lo.is_finite()
            && iv.hi.is_finite()
            && iv.hi - iv.lo <= iv.abs_max().max(1.0) * 0.75 + 1.0e-3
    })
}

/// `Err(())` asks for subdivision; a still-loose jet at the depth limit is a cusp.
fn kappa_s_once(curve: Curve) -> Result<[Iv; 5], ()> {
    let (rho_c, num_c) = rho_num(curve);
    let rho = poly_jet(&rho_c);
    if rho[0].lo <= CUSP_SPEED * CUSP_SPEED {
        return Err(());
    }
    let num = poly_jet(&num_c);
    let inv = pow_jet(&rho, -1.5)?;
    let kappa_p = product_jet(&num, &inv);
    let lambda = pow_jet(&rho, 0.5)?;
    s_derivatives(&kappa_p, &lambda)
}

fn rho_num(curve: Curve) -> ([f64; 5], [f64; 5]) {
    let h = hodograph(curve);
    let (d0, d1, d2) = (h[0], h[1], h[2]);
    let a = d0 - d1 * 2.0 + d2;
    let b = (d1 - d0) * 2.0;
    let c = d0;
    let rho = [
        c.dot(c),
        2.0 * b.dot(c),
        2.0 * a.dot(c) + b.dot(b),
        2.0 * a.dot(b),
        a.dot(a),
    ];
    let num = [c.cross(b), 2.0 * c.cross(a), -a.cross(b), 0.0, 0.0];
    (rho, num)
}

struct Map<'a> {
    track: &'a Track,
    leaves: &'a [LeafK],
    sx: f64,
    sy: f64,
    xmin: f64,
    yc: f64,
}

impl Map<'_> {
    fn point(&self, p: Point, work: &mut usize) -> Result<Point, String> {
        Ok(self.eval(&[p, p], 0.0, work)?.0)
    }

    fn emit(
        &self,
        controls: &mut [Point],
        out: &mut Vec<Command>,
        work: &mut usize,
    ) -> Result<(), String> {
        if controls.iter().all(|p| distance(*p, controls[0]) <= 1e-15) {
            return Ok(());
        }
        let mut pieces = vec![controls.to_vec()];
        split_x_monotone(&mut pieces);
        for piece in pieces {
            self.fit(piece, 0, out, work)?;
        }
        Ok(())
    }

    fn fit(
        &self,
        controls: Vec<Point>,
        depth: u32,
        out: &mut Vec<Command>,
        work: &mut usize,
    ) -> Result<(), String> {
        *work += 1;
        if *work > WORK_LIMIT || depth > 24 {
            return Err(PRECISION.into());
        }
        if x_span(&controls) <= 1e-12 {
            return self.emit_constant_x(&controls, out, work);
        }
        let (p0, d0) = self.eval(&controls, 0.0, work)?;
        let (p1, d1) = self.eval(&controls, 1.0, work)?;
        let curvature = self.second_derivative_bound(&controls);
        let hermite = hermite_second(p0, d0, p1, d1);
        let k = curvature + hermite;
        let gap = k * (1.0 / 8.0_f64).powi(2) / 8.0;
        if k.is_finite()
            && gap <= STRETCH_ERROR
            && self.samples_within(&controls, p0, d0, p1, d1, STRETCH_ERROR - gap, work)?
        {
            let c1 = p0 + d0 * (1.0 / 3.0);
            let c2 = p1 - d1 * (1.0 / 3.0);
            push(out, Command::Cubic(c1, c2, p1))?;
            return Ok(());
        }
        let (left, right) = split_bezier(&controls, 0.5);
        self.fit(left, depth + 1, out, work)?;
        self.fit(right, depth + 1, out, work)
    }

    fn samples_within(
        &self,
        controls: &[Point],
        p0: Point,
        d0: Point,
        p1: Point,
        d1: Point,
        allowance: f64,
        work: &mut usize,
    ) -> Result<bool, String> {
        if allowance < 0.0 {
            return Ok(false);
        }
        for i in 1..8 {
            let u = i as f64 / 8.0;
            let (p, _) = self.eval(controls, u, work)?;
            if distance(p, hermite_point(p0, d0, p1, d1, u)) > allowance {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn emit_constant_x(
        &self,
        controls: &[Point],
        out: &mut Vec<Command>,
        work: &mut usize,
    ) -> Result<(), String> {
        let s = self.sx * (controls[0].x - self.xmin);
        let (pos, tangent, _) = locate(self.track, s, work)?;
        let normal = tangent.normal();
        let map_y = |y: f64| pos + normal * (self.sy * (y - self.yc));
        match controls {
            [_, b] => push(out, Command::Line(map_y(b.y))),
            [_, b, c] => push(out, Command::Quad(map_y(b.y), map_y(c.y))),
            [_, b, c, d] => push(out, Command::Cubic(map_y(b.y), map_y(c.y), map_y(d.y))),
            _ => Err("Unsupported brush source command".into()),
        }
    }

    fn eval(&self, controls: &[Point], u: f64, work: &mut usize) -> Result<(Point, Point), String> {
        let (p, d) = bezier_deriv(controls, u);
        let s = self.sx * (p.x - self.xmin);
        let n = self.sy * (p.y - self.yc);
        let (pos, tangent, kappa) = locate(self.track, s, work)?;
        let normal = tangent.normal();
        let at = pos + normal * n;
        let deriv = tangent * (self.sx * d.x * (1.0 - n * kappa)) + normal * (self.sy * d.y);
        Ok((at, deriv))
    }

    fn second_derivative_bound(&self, controls: &[Point]) -> f64 {
        let (s0, s1) = s_interval(controls, self.sx, self.xmin);
        let kappa = kappa_over(self.leaves, s0, s1);
        let s_abs = coord_abs_derivs(controls, true, self.sx, self.xmin);
        let n_abs = coord_abs_derivs(controls, false, self.sy, self.yc);
        let k = kappa[0].abs_max();
        let ks = kappa[1].abs_max();
        let (sp, spp) = (s_abs[1], s_abs[2]);
        let (n, np, npp) = (n_abs[0], n_abs[1], n_abs[2]);
        (spp * (1.0 + n * k)
            + 2.0 * sp * np * k
            + n * ks * sp * sp
            + npp
            + k * sp * sp
            + n * k * k * sp * sp)
            * (1.0 + 1.0e-9)
            + 1.0e-15
    }
}

fn hermite_second(p0: Point, d0: Point, p1: Point, d1: Point) -> f64 {
    let c1 = p0 + d0 * (1.0 / 3.0);
    let c2 = p1 - d1 * (1.0 / 3.0);
    let a = p0 - c1 * 2.0 + c2;
    let b = c1 - c2 * 2.0 + p1;
    6.0 * a.length().max(b.length())
}

fn s_interval(controls: &[Point], sx: f64, xmin: f64) -> (f64, f64) {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for p in controls {
        let s = sx * (p.x - xmin);
        lo = lo.min(s);
        hi = hi.max(s);
    }
    (lo, hi)
}

fn x_span(controls: &[Point]) -> f64 {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for p in controls {
        lo = lo.min(p.x);
        hi = hi.max(p.x);
    }
    hi - lo
}

fn kappa_over(leaves: &[LeafK], s0: f64, s1: f64) -> [Iv; 5] {
    let lo = s0.min(s1) - ARC_ERROR;
    let hi = s0.max(s1) + ARC_ERROR;
    let mut acc: Option<[Iv; 5]> = None;
    for leaf in leaves {
        if leaf.s1 < lo || leaf.s0 > hi {
            continue;
        }
        acc = Some(match acc {
            None => leaf.k,
            Some(mut have) => {
                for i in 0..5 {
                    have[i] = have[i].union(leaf.k[i]);
                }
                have
            }
        });
    }
    acc.unwrap_or([Iv::pt(0.0); 5])
}

fn push(out: &mut Vec<Command>, command: Command) -> Result<(), String> {
    if out.len() + 1 > LIMIT {
        return Err("Vector brush output budget exceeded".into());
    }
    out.push(command);
    Ok(())
}

fn bezier_deriv(controls: &[Point], u: f64) -> (Point, Point) {
    match controls {
        [a, b] => (*a + (*b - *a) * u, *b - *a),
        [a, b, c] => {
            let ab = *a + (*b - *a) * u;
            let bc = *b + (*c - *b) * u;
            (ab + (bc - ab) * u, (bc - ab) * 2.0)
        }
        [a, b, c, d] => {
            let v = 1.0 - u;
            let p = *a * (v * v * v)
                + *b * (3.0 * v * v * u)
                + *c * (3.0 * v * u * u)
                + *d * (u * u * u);
            let d1 =
                (*b - *a) * (3.0 * v * v) + (*c - *b) * (6.0 * v * u) + (*d - *c) * (3.0 * u * u);
            (p, d1)
        }
        _ => (Point::default(), Point::default()),
    }
}

fn hermite_point(p0: Point, d0: Point, p1: Point, d1: Point, u: f64) -> Point {
    bezier_deriv(&[p0, p0 + d0 * (1.0 / 3.0), p1 - d1 * (1.0 / 3.0), p1], u).0
}

fn split_x_monotone(pieces: &mut Vec<Vec<Point>>) {
    let mut i = 0;
    while i < pieces.len() {
        let roots = x_extrema(&pieces[i]);
        if roots.is_empty() {
            i += 1;
            continue;
        }
        let count = roots.len();
        let mut current = pieces[i].clone();
        let mut local = Vec::new();
        let mut cursor = 0.0;
        for root in roots {
            let t = ((root - cursor) / (1.0 - cursor)).clamp(0.0, 1.0);
            let (left, right) = split_bezier(&current, t);
            local.push(left);
            current = right;
            cursor = root;
        }
        local.push(current);
        pieces.splice(i..=i, local);
        i += count + 1;
    }
}

fn x_extrema(controls: &[Point]) -> Vec<f64> {
    let deriv = match controls {
        [a, b, c, d] => {
            let d0 = 3.0 * (b.x - a.x);
            let d1 = 3.0 * (c.x - b.x);
            let d2 = 3.0 * (d.x - c.x);
            [d0, 2.0 * (d1 - d0), d0 - 2.0 * d1 + d2]
        }
        [a, b, c] => [2.0 * (b.x - a.x), 2.0 * ((c.x - b.x) - (b.x - a.x)), 0.0],
        _ => return Vec::new(),
    };
    let mut roots = quad_roots(deriv[2], deriv[1], deriv[0]);
    roots.retain(|t| (1e-8..1.0 - 1e-8).contains(t));
    roots.sort_by(|a, b| a.total_cmp(b));
    roots.dedup_by(|a, b| (*a - *b).abs() < 1e-8);
    roots
}

fn quad_roots(a: f64, b: f64, c: f64) -> Vec<f64> {
    let mut roots = Vec::new();
    if a.abs() < 1e-15 {
        if b.abs() > 1e-15 {
            roots.push(-c / b);
        }
        return roots;
    }
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return roots;
    }
    let s = disc.sqrt();
    let q = -0.5 * (b + b.signum() * s);
    if q.abs() > 1e-15 {
        roots.push(q / a);
        roots.push(c / q);
    } else {
        roots.push(-b / (2.0 * a));
    }
    roots
}

fn split_bezier(controls: &[Point], t: f64) -> (Vec<Point>, Vec<Point>) {
    match controls {
        [a, b] => {
            let m = *a + (*b - *a) * t;
            (vec![*a, m], vec![m, *b])
        }
        [a, b, c] => {
            let ab = *a + (*b - *a) * t;
            let bc = *b + (*c - *b) * t;
            let m = ab + (bc - ab) * t;
            (vec![*a, ab, m], vec![m, bc, *c])
        }
        [a, b, c, d] => {
            let ab = *a + (*b - *a) * t;
            let bc = *b + (*c - *b) * t;
            let cd = *c + (*d - *c) * t;
            let abc = ab + (bc - ab) * t;
            let bcd = bc + (cd - bc) * t;
            let m = abc + (bcd - abc) * t;
            (vec![*a, ab, abc, m], vec![m, bcd, cd, *d])
        }
        _ => (controls.to_vec(), controls.to_vec()),
    }
}

fn locate(track: &Track, s: f64, work: &mut usize) -> Result<(Point, Point, f64), String> {
    if track.segments.is_empty() {
        return Err(PRECISION.into());
    }
    let s = s.clamp(0.0, track.length);
    let i = track
        .ends
        .partition_point(|end| *end <= s)
        .saturating_sub(1)
        .min(track.segments.len() - 1);
    let delta = s - track.ends[i];
    match track.segments[i] {
        Segment::Line(a, b) => {
            let len = distance(a, b);
            let t = (b - a) * (1.0 / len);
            Ok((a + t * delta.clamp(0.0, len), t, 0.0))
        }
        Segment::Cubic(curve) => locate_cubic(curve, delta, work),
    }
}

fn cheap_bracket(curve: Curve) -> (f64, f64) {
    let p = curve.0;
    (
        distance(p[0], p[3]),
        distance(p[0], p[1]) + distance(p[1], p[2]) + distance(p[2], p[3]),
    )
}

fn locate_cubic(curve: Curve, mut d: f64, work: &mut usize) -> Result<(Point, Point, f64), String> {
    // Chord/polygon brackets only. Track leaves are already flat, so this stays
    // inside the scatter inverse budget without repeating its subdivision work.
    let original = curve;
    let mut sub = curve;
    let (mut start, mut end) = (0.0, 1.0);
    for _ in 0..64 {
        *work += 1;
        if *work > WORK_LIMIT {
            return Err(PRECISION.into());
        }
        let (_lo, hi) = cheap_bracket(sub);
        if hi <= ARC_ERROR {
            return frame_kappa(original, (start + end) * 0.5);
        }
        if d <= 0.0 {
            return frame_kappa(original, start);
        }
        if d >= hi {
            return frame_kappa(original, end);
        }
        let (left, right) = sub.split();
        let (l, h) = cheap_bracket(left);
        let mid = (start + end) * 0.5;
        if d < l {
            sub = left;
            end = mid;
        } else if d > h {
            sub = right;
            start = mid;
            d -= (l + h) * 0.5;
        } else if h - l <= ARC_ERROR {
            return frame_kappa(original, mid);
        } else {
            sub = left;
            end = mid;
        }
    }
    Err(PRECISION.into())
}

fn frame_kappa(curve: Curve, u: f64) -> Result<(Point, Point, f64), String> {
    let p = curve.0;
    let v = 1.0 - u;
    let at = p[0] * (v * v * v)
        + p[1] * (3.0 * v * v * u)
        + p[2] * (3.0 * v * u * u)
        + p[3] * (u * u * u);
    let d1 = (p[1] - p[0]) * (3.0 * v * v)
        + (p[2] - p[1]) * (6.0 * v * u)
        + (p[3] - p[2]) * (3.0 * u * u);
    let speed = d1.length();
    if speed < CUSP_SPEED || !speed.is_finite() {
        return Err(CORNER.into());
    }
    let tangent = d1 * (1.0 / speed);
    let a = p[0] - p[1] * 2.0 + p[2];
    let b = p[1] - p[2] * 2.0 + p[3];
    let d2 = a * (6.0 * v) + b * (6.0 * u);
    let kappa = d1.cross(d2) / (speed * speed * speed);
    if !kappa.is_finite() {
        return Err(CORNER.into());
    }
    Ok((at, tangent, kappa))
}

fn coord_abs_derivs(controls: &[Point], x_axis: bool, scale: f64, shift: f64) -> [f64; 5] {
    let values: Vec<f64> = controls
        .iter()
        .map(|p| if x_axis { p.x } else { p.y })
        .collect();
    let power = power_basis(&values);
    let mut deriv = power;
    let mut out = [0.0; 5];
    if !x_axis {
        out[0] = controls
            .iter()
            .map(|p| (scale * (p.y - shift)).abs())
            .fold(0.0, f64::max);
    }
    for order in 1..5 {
        deriv = differentiate(&deriv);
        let (lo, hi) = bernstein_range(&deriv);
        out[order] = scale.abs() * lo.abs().max(hi.abs());
    }
    out
}

fn power_basis(values: &[f64]) -> Vec<f64> {
    match values {
        [a, b] => vec![*a, b - a],
        [a, b, c] => vec![*a, 2.0 * (b - a), a - 2.0 * b + c],
        [a, b, c, d] => vec![
            *a,
            3.0 * (b - a),
            3.0 * (a - 2.0 * b + c),
            -a + 3.0 * b - 3.0 * c + d,
        ],
        _ => vec![0.0],
    }
}

fn differentiate(coeffs: &[f64]) -> Vec<f64> {
    coeffs
        .iter()
        .enumerate()
        .skip(1)
        .map(|(k, c)| c * k as f64)
        .collect()
}

fn bernstein_range(coeffs: &[f64]) -> (f64, f64) {
    if coeffs.is_empty() {
        return (0.0, 0.0);
    }
    let n = coeffs.len() - 1;
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for j in 0..=n {
        let mut sum = 0.0;
        for k in 0..=j.min(n) {
            let denom = binom(n, k);
            if denom == 0.0 {
                continue;
            }
            sum += coeffs[k] * binom(j, k) / denom;
        }
        lo = lo.min(sum);
        hi = hi.max(sum);
    }
    if !lo.is_finite() || !hi.is_finite() {
        return (f64::NEG_INFINITY, f64::INFINITY);
    }
    let pad = 1e-12 * lo.abs().max(hi.abs()) + 1e-15;
    (lo - pad, hi + pad)
}

fn binom(n: usize, k: usize) -> f64 {
    const T: [[u64; 9]; 9] = [
        [1, 0, 0, 0, 0, 0, 0, 0, 0],
        [1, 1, 0, 0, 0, 0, 0, 0, 0],
        [1, 2, 1, 0, 0, 0, 0, 0, 0],
        [1, 3, 3, 1, 0, 0, 0, 0, 0],
        [1, 4, 6, 4, 1, 0, 0, 0, 0],
        [1, 5, 10, 10, 5, 1, 0, 0, 0],
        [1, 6, 15, 20, 15, 6, 1, 0, 0],
        [1, 7, 21, 35, 35, 21, 7, 1, 0],
        [1, 8, 28, 56, 70, 56, 28, 8, 1],
    ];
    if n > 8 || k > n {
        0.0
    } else {
        T[n][k] as f64
    }
}

#[derive(Clone, Copy)]
struct Iv {
    lo: f64,
    hi: f64,
}

impl Iv {
    fn pt(x: f64) -> Self {
        Self { lo: x, hi: x }
    }
    fn new(a: f64, b: f64) -> Self {
        if a <= b {
            Self { lo: a, hi: b }
        } else {
            Self { lo: b, hi: a }
        }
    }
    fn abs_max(self) -> f64 {
        self.lo.abs().max(self.hi.abs())
    }
    fn union(self, other: Self) -> Self {
        Self {
            lo: self.lo.min(other.lo),
            hi: self.hi.max(other.hi),
        }
    }
    fn add(self, other: Self) -> Self {
        Self {
            lo: self.lo + other.lo,
            hi: self.hi + other.hi,
        }
    }
    fn sub(self, other: Self) -> Self {
        Self {
            lo: self.lo - other.hi,
            hi: self.hi - other.lo,
        }
    }
    fn scale(self, k: f64) -> Self {
        if k >= 0.0 {
            Self {
                lo: self.lo * k,
                hi: self.hi * k,
            }
        } else {
            Self {
                lo: self.hi * k,
                hi: self.lo * k,
            }
        }
    }
    fn mul(self, other: Self) -> Self {
        let xs = [
            self.lo * other.lo,
            self.lo * other.hi,
            self.hi * other.lo,
            self.hi * other.hi,
        ];
        Self {
            lo: xs.into_iter().fold(f64::INFINITY, f64::min),
            hi: xs.into_iter().fold(f64::NEG_INFINITY, f64::max),
        }
    }
    fn pow(self, exp: f64) -> Result<Self, ()> {
        if self.lo <= 0.0 || !self.hi.is_finite() {
            return Err(());
        }
        Ok(Self::new(self.lo.powf(exp), self.hi.powf(exp)))
    }
    fn recip(self) -> Result<Self, ()> {
        if self.lo <= 0.0 && self.hi >= 0.0 {
            return Err(());
        }
        Ok(Self::new(1.0 / self.hi, 1.0 / self.lo))
    }
}

type Jet = [Iv; ORDER];

fn shift(jet: &Jet) -> Jet {
    let mut out = [Iv::pt(0.0); ORDER];
    for i in 0..ORDER - 1 {
        out[i] = jet[i + 1];
    }
    out
}

fn product_jet(a: &Jet, b: &Jet) -> Jet {
    let mut c = [Iv::pt(0.0); ORDER];
    for n in 0..ORDER {
        let mut sum = Iv::pt(0.0);
        for k in 0..=n {
            sum = sum.add(a[k].mul(b[n - k]).scale(binom(n, k)));
        }
        c[n] = sum;
    }
    c
}

fn quotient_jet(u: &Jet, v: &Jet) -> Result<Jet, ()> {
    let mut q = [Iv::pt(0.0); ORDER];
    for n in 0..ORDER {
        let mut sum = u[n];
        for k in 0..n {
            sum = sum.sub(q[k].mul(v[n - k]).scale(binom(n, k)));
        }
        q[n] = sum.mul(v[0].recip()?);
    }
    Ok(q)
}

fn pow_jet(base: &Jet, exp: f64) -> Result<Jet, ()> {
    let mut y = [Iv::pt(0.0); ORDER];
    y[0] = base[0].pow(exp)?;
    let deriv = shift(base);
    let q = quotient_jet(&deriv, base)?;
    for n in 0..ORDER - 1 {
        let mut sum = Iv::pt(0.0);
        for k in 0..=n {
            sum = sum.add(y[k].mul(q[n - k]).scale(binom(n, k)));
        }
        y[n + 1] = sum.scale(exp);
    }
    Ok(y)
}

fn poly_jet(coeffs: &[f64; 5]) -> Jet {
    let mut c = coeffs.to_vec();
    let mut jet = [Iv::pt(0.0); ORDER];
    for order in 0..ORDER {
        let (lo, hi) = bernstein_range(&c);
        jet[order] = Iv::new(lo, hi);
        c = differentiate(&c);
    }
    jet
}

fn s_derivatives(kappa_p: &Jet, lambda: &Jet) -> Result<[Iv; 5], ()> {
    let mut phi = *kappa_p;
    let mut out = [Iv::pt(0.0); 5];
    for j in 0..5 {
        out[j] = phi[0];
        if j == 4 {
            break;
        }
        let dphi = shift(&phi);
        phi = quotient_jet(&dphi, lambda)?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parabola() -> Curve {
        Curve([
            Point::new(0.0, 0.0),
            Point::new(1.0 / 3.0, 0.0),
            Point::new(2.0 / 3.0, 1.0 / 3.0),
            Point::new(1.0, 1.0),
        ])
    }

    #[test]
    fn parabola_curvature_jet_contains_the_analytic_value() {
        let curve = parabola();
        let k = kappa_s_bounds(curve, 0).unwrap();
        let at_start = frame_kappa(curve, 0.0).unwrap().2;
        let at_end = frame_kappa(curve, 1.0).unwrap().2;
        assert!((at_start - 2.0).abs() < 1e-9, "{at_start}");
        assert!((at_end - 2.0 / 5.0_f64.powf(1.5)).abs() < 1e-9, "{at_end}");
        assert!(k[0].lo <= at_start && k[0].hi >= at_start);
        assert!(k[0].lo <= at_end && k[0].hi >= at_end);
        assert!(k[0].hi < 4.0, "{:?}", (k[0].lo, k[0].hi));
        assert!(
            k[1].abs_max().is_finite() && k[1].abs_max() < 20.0,
            "{}",
            k[1].abs_max()
        );
    }

    #[test]
    fn smooth_cubic_stretch_matches_the_arc_length_map_and_not_the_chord() {
        use crate::scene::Network;
        use crate::vector_brush::{paths, VectorBrush};
        let guide: Network = serde_json::from_value(serde_json::json!({
            "vertices":[{"id":"0","x":0.0,"y":0.0},{"id":"1","x":40.0,"y":0.0}],
            "edges":[{"id":"e0","from":"0","to":"1","c1":{"x":0.0,"y":40.0},"c2":{"x":40.0,"y":40.0}}],
            "fillRule":"nonzero"
        })).unwrap();
        let source: Network = serde_json::from_value(serde_json::json!({
            "vertices":[{"id":"0","x":-2.0,"y":-1.0},{"id":"1","x":2.0,"y":-1.0},{"id":"2","x":2.0,"y":1.0},{"id":"3","x":-2.0,"y":1.0}],
            "edges":[
                {"id":"e0","from":"0","to":"1","c1":{"x":-1.0,"y":-1.0},"c2":{"x":1.0,"y":-1.0}},
                {"id":"e1","from":"1","to":"2"},
                {"id":"e2","from":"2","to":"3"},
                {"id":"e3","from":"3","to":"0"}
            ],
            "fillRule":"nonzero"
        })).unwrap();
        let brush = VectorBrush {
            source,
            mode: "stretch".into(),
            width: 4.0,
            spacing: 10.0,
            seed: 0,
            rotation: 0.0,
            rotation_variance: 0.0,
            scale_variance: 0.0,
            scatter: 0.0,
            follow_tangent: true,
        };
        let path = paths(&guide, &brush).unwrap();
        let cubics = path
            .commands
            .iter()
            .filter(|c| matches!(c, Command::Cubic(..)))
            .count();
        let lines = path
            .commands
            .iter()
            .filter(|c| matches!(c, Command::Line(_)))
            .count();
        assert!(cubics >= 2, "cubics {cubics} lines {lines}");
        assert!(lines <= 4, "lines {lines}");
        let flat = path.flatten(Transform::default(), 1.0e-6).unwrap();
        let max_y = flat
            .iter()
            .flat_map(|c| c.points.iter())
            .map(|p| p.y)
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(max_y > 15.0, "{max_y}");
        let source_path = brush.source.paths().unwrap().0;
        let deviation = oracle_hausdorff(&guide, &source_path, &path, brush.width);
        assert!(
            deviation <= STRETCH_ERROR,
            "deviation {deviation} cubics {cubics}"
        );
        assert_eq!(paths(&guide, &brush).unwrap().commands, path.commands);
        let mut work = 0usize;
        let track = super::super::Track::new(
            &guide.paths().unwrap().1,
            super::super::ARC_ERROR,
            &mut work,
        )
        .unwrap();
        let mut worst = 0.0_f64;
        for i in 0..=8 {
            let s = track.length * i as f64 / 8.0;
            let (oracle, _) = track.frame(s, &mut work).unwrap();
            let (located, _, _) = locate(&track, s, &mut work).unwrap();
            worst = worst.max(distance(oracle, located));
        }
        assert!(
            worst <= super::super::ARC_ERROR * 2.0,
            "locator vs scatter arc length {worst}"
        );
    }

    fn oracle_hausdorff(
        guide: &crate::scene::Network,
        source: &crate::path::Path,
        output: &crate::path::Path,
        width: f64,
    ) -> f64 {
        let mut points = Vec::new();
        for command in &source.commands {
            match *command {
                Command::Move(p) | Command::Line(p) => points.push(p),
                Command::Quad(a, p) => points.extend([a, p]),
                Command::Cubic(a, b, p) => points.extend([a, b, p]),
                _ => {}
            }
        }
        let xmin = points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
        let xmax = points.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
        let ymin = points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
        let ymax = points.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
        let yc = (ymin + ymax) / 2.0;
        let mut work = 0usize;
        let track = super::super::Track::new(
            &guide.paths().unwrap().1,
            super::super::ARC_ERROR,
            &mut work,
        )
        .unwrap();
        let leaves = kappa_leaves(&track).unwrap();
        let map = Map {
            track: &track,
            leaves: &leaves,
            sx: track.length / (xmax - xmin),
            sy: width / (ymax - ymin),
            xmin,
            yc,
        };
        let mut oracle = Vec::new();
        let mut pen = Point::default();
        for command in &source.commands {
            let controls: Vec<Point> = match *command {
                Command::Move(p) => {
                    pen = p;
                    oracle.push(map.point(p, &mut work).unwrap());
                    continue;
                }
                Command::Line(p) => vec![pen, p],
                Command::Quad(a, p) => vec![pen, a, p],
                Command::Cubic(a, b, p) => vec![pen, a, b, p],
                Command::Close => continue,
                _ => continue,
            };
            for i in 0..=32 {
                oracle.push(map.eval(&controls, i as f64 / 32.0, &mut work).unwrap().0);
            }
            pen = *controls.last().unwrap();
        }
        let flat = output.flatten(Transform::default(), 1.0e-7).unwrap();
        let mut drawn = Vec::new();
        for contour in &flat {
            drawn.extend(contour.points.iter().copied());
            if contour.closed && contour.points.len() >= 2 {
                drawn.push(contour.points[0]);
            }
        }
        directed_hausdorff(&oracle, &drawn)
    }

    fn stretch_of(
        guide: serde_json::Value,
        source_cubic: bool,
    ) -> Result<crate::path::Path, String> {
        let guide: crate::scene::Network = serde_json::from_value(guide).unwrap();
        let mut source = serde_json::json!({
            "vertices":[{"id":"0","x":-2.0,"y":-1.0},{"id":"1","x":2.0,"y":-1.0},{"id":"2","x":2.0,"y":1.0},{"id":"3","x":-2.0,"y":1.0}],
            "edges":[{"id":"e0","from":"0","to":"1"},{"id":"e1","from":"1","to":"2"},{"id":"e2","from":"2","to":"3"},{"id":"e3","from":"3","to":"0"}],
            "fillRule":"nonzero"
        });
        if source_cubic {
            source["edges"][0]["c1"] = serde_json::json!({"x":-1.0,"y":-1.0});
            source["edges"][0]["c2"] = serde_json::json!({"x":1.0,"y":-1.0});
        }
        let brush = crate::vector_brush::VectorBrush {
            source: serde_json::from_value(source).unwrap(),
            mode: "stretch".into(),
            width: 4.0,
            spacing: 10.0,
            seed: 7,
            rotation: 0.0,
            rotation_variance: 0.0,
            scale_variance: 0.0,
            scatter: 0.0,
            follow_tangent: true,
        };
        crate::vector_brush::paths(&guide, &brush)
    }

    #[test]
    fn corners_and_cusps_still_reject_without_a_flattened_result() {
        let corner = stretch_of(
            serde_json::json!({
                "vertices":[{"id":"0","x":0.0,"y":0.0},{"id":"1","x":30.0,"y":0.0},{"id":"2","x":30.0,"y":20.0}],
                "edges":[
                    {"id":"e0","from":"0","to":"1","c1":{"x":10.0,"y":20.0},"c2":{"x":20.0,"y":0.0}},
                    {"id":"e1","from":"1","to":"2"}
                ],
                "fillRule":"nonzero"
            }),
            false,
        );
        assert!(corner.unwrap_err().contains("cusps"));
        let cusp = stretch_of(
            serde_json::json!({
                "vertices":[{"id":"0","x":0.0,"y":0.0},{"id":"1","x":0.0,"y":0.0}],
                "edges":[{"id":"e0","from":"0","to":"1","c1":{"x":0.0,"y":0.0},"c2":{"x":10.0,"y":20.0}}],
                "fillRule":"nonzero"
            }),
            false,
        );
        let message = cusp.unwrap_err();
        assert!(message.contains("cusps"), "{message}");
    }

    #[test]
    fn collinear_cubic_matches_the_straight_affine_map() {
        let line = stretch_of(
            serde_json::json!({
                "vertices":[{"id":"0","x":0.0,"y":0.0},{"id":"1","x":30.0,"y":0.0}],
                "edges":[{"id":"e0","from":"0","to":"1"}],
                "fillRule":"nonzero"
            }),
            true,
        )
        .unwrap();
        let cubic = stretch_of(serde_json::json!({
            "vertices":[{"id":"0","x":0.0,"y":0.0},{"id":"1","x":30.0,"y":0.0}],
            "edges":[{"id":"e0","from":"0","to":"1","c1":{"x":10.0,"y":0.0},"c2":{"x":20.0,"y":0.0}}],
            "fillRule":"nonzero"
        }), true).unwrap();
        assert!(cubic
            .commands
            .iter()
            .any(|c| matches!(c, Command::Cubic(..))));
        let a = line.flatten(Transform::default(), 1e-6).unwrap();
        let b = cubic.flatten(Transform::default(), 1e-6).unwrap();
        let ap: Vec<_> = a.iter().flat_map(|c| c.points.iter().copied()).collect();
        let bp: Vec<_> = b.iter().flat_map(|c| c.points.iter().copied()).collect();
        assert!(
            directed_hausdorff(&ap, &bp) <= 1e-6,
            "{}",
            directed_hausdorff(&ap, &bp)
        );
        assert!(
            directed_hausdorff(&bp, &ap) <= 1e-6,
            "{}",
            directed_hausdorff(&bp, &ap)
        );
    }

    #[test]
    fn closed_smooth_guide_stretches_and_stays_off_the_center() {
        let k = 0.5522847498307936_f64 * 20.0;
        let path = stretch_of(
            serde_json::json!({
                "vertices":[
                    {"id":"0","x":20.0,"y":0.0},{"id":"1","x":0.0,"y":20.0},
                    {"id":"2","x":-20.0,"y":0.0},{"id":"3","x":0.0,"y":-20.0}
                ],
                "edges":[
                    {"id":"e0","from":"0","to":"1","c1":{"x":20.0,"y":k},"c2":{"x":k,"y":20.0}},
                    {"id":"e1","from":"1","to":"2","c1":{"x":-k,"y":20.0},"c2":{"x":-20.0,"y":k}},
                    {"id":"e2","from":"2","to":"3","c1":{"x":-20.0,"y":-k},"c2":{"x":-k,"y":-20.0}},
                    {"id":"e3","from":"3","to":"0","c1":{"x":k,"y":-20.0},"c2":{"x":20.0,"y":-k}}
                ],
                "fillRule":"nonzero"
            }),
            false,
        )
        .unwrap();
        let flat = path.flatten(Transform::default(), 1e-4).unwrap();
        let points: Vec<_> = flat.iter().flat_map(|c| c.points.iter().copied()).collect();
        assert!(points.len() > 8);
        assert!(
            points.iter().all(|p| (p.length() - 20.0).abs() < 4.5),
            "ribbon left the offset band"
        );
        assert!(
            points.iter().any(|p| p.length() > 21.0) && points.iter().any(|p| p.length() < 19.0)
        );
    }

    fn directed_hausdorff(from: &[Point], onto: &[Point]) -> f64 {
        if from.is_empty() || onto.len() < 2 {
            return f64::INFINITY;
        }
        from.iter()
            .map(|p| {
                onto.windows(2)
                    .map(|w| {
                        let ab = w[1] - w[0];
                        let len2 = ab.dot(ab);
                        let t = if len2 < 1e-30 {
                            0.0
                        } else {
                            ((*p - w[0]).dot(ab) / len2).clamp(0.0, 1.0)
                        };
                        distance(*p, w[0] + ab * t)
                    })
                    .fold(f64::INFINITY, f64::min)
            })
            .fold(0.0, f64::max)
    }

    #[test]
    fn rho_polynomial_matches_sampled_speed() {
        let curve = parabola();
        let (rho, num) = rho_num(curve);
        for u in [0.0, 0.25, 0.5, 0.75, 1.0] {
            let h = hodograph(curve);
            let a = h[0] - h[1] * 2.0 + h[2];
            let b = (h[1] - h[0]) * 2.0;
            let c = h[0];
            let vel = c + b * u + a * u * u;
            let acc = b + a * (2.0 * u);
            let poly =
                rho[0] + rho[1] * u + rho[2] * u * u + rho[3] * u.powi(3) + rho[4] * u.powi(4);
            assert!(
                (poly - vel.dot(vel)).abs() < 1e-9,
                "{poly} {}",
                vel.dot(vel)
            );
            let n = num[0] + num[1] * u + num[2] * u * u;
            assert!((n - vel.cross(acc)).abs() < 1e-9);
        }
    }
}
