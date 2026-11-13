//! Curved, corner, cusp and closed Stretch.
//!
//! Straight forward-only guides never reach this module. Everywhere else the
//! source maps by certified arc length and the left normal:
//! `M(x,y) = P(s) + N(s) * h(y)`, `s = (x-xmin) * L / (xmax-xmin)`,
//! `h = (y-yc) * width / (ymax-ymin)`.
//! A tangent break uses the outgoing normal, matching Scatter joins. An outline
//! that crosses the break inserts the circular arc swept by that normal through
//! the guide's signed turn. An exact reversal (no signed cross) sweeps `+π`.
//!
//! Straight pieces are exact affine images of source de Casteljau pieces, so
//! source cubics are not flattened. Curved pieces are Hermite cubics whose
//! deviation from `M` is at most [`super::ARC_ERROR`], on top of the existing
//! inverse-length budget, for a total of `2 * ARC_ERROR` local units. A budget
//! miss rejects the brush instead of coarsening it.
use super::{Curve, Point, Segment, Track, ARC_ERROR, LIMIT, WORK_LIMIT};
use crate::path::Command;

const FIT_ERROR: f64 = ARC_ERROR;
const T_ORDER: usize = 7;

#[derive(Clone, Copy, Debug)]
struct Iv {
    lo: f64,
    hi: f64,
}
impl Iv {
    fn new(a: f64, b: f64) -> Self {
        if !a.is_finite() || !b.is_finite() {
            return Self::unbounded();
        }
        if a <= b {
            Self { lo: a, hi: b }
        } else {
            Self { lo: b, hi: a }
        }
    }
    fn pt(x: f64) -> Self {
        if x.is_finite() {
            Self { lo: x, hi: x }
        } else {
            Self::unbounded()
        }
    }
    fn zero() -> Self {
        Self { lo: 0., hi: 0. }
    }
    fn unbounded() -> Self {
        Self {
            lo: f64::NEG_INFINITY,
            hi: f64::INFINITY,
        }
    }
    fn is_bounded(self) -> bool {
        self.lo.is_finite() && self.hi.is_finite()
    }
    fn width(self) -> f64 {
        self.hi - self.lo
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
        Self::new(self.lo + other.lo, self.hi + other.hi)
    }
    fn sub(self, other: Self) -> Self {
        Self::new(self.lo - other.hi, self.hi - other.lo)
    }
    fn neg(self) -> Self {
        Self {
            lo: -self.hi,
            hi: -self.lo,
        }
    }
    fn scale(self, k: f64) -> Self {
        if !k.is_finite() {
            return Self::unbounded();
        }
        if k >= 0. {
            Self::new(self.lo * k, self.hi * k)
        } else {
            Self::new(self.hi * k, self.lo * k)
        }
    }
    fn mul(self, other: Self) -> Self {
        if !self.is_bounded() || !other.is_bounded() {
            return Self::unbounded();
        }
        let v = [
            self.lo * other.lo,
            self.lo * other.hi,
            self.hi * other.lo,
            self.hi * other.hi,
        ];
        Self::new(
            v.into_iter().fold(f64::INFINITY, f64::min),
            v.into_iter().fold(f64::NEG_INFINITY, f64::max),
        )
    }
    fn recip(self) -> Self {
        if self.lo > 0. || self.hi < 0. {
            Self::new(1. / self.hi, 1. / self.lo)
        } else {
            Self::unbounded()
        }
    }
    fn div(self, other: Self) -> Self {
        self.mul(other.recip())
    }
    fn sqr(self) -> Self {
        if !self.is_bounded() {
            return Self::unbounded();
        }
        if self.lo >= 0. {
            Self::new(self.lo * self.lo, self.hi * self.hi)
        } else if self.hi <= 0. {
            Self::new(self.hi * self.hi, self.lo * self.lo)
        } else {
            Self::new(0., self.lo.abs().max(self.hi.abs()).powi(2))
        }
    }
    fn sqrt(self) -> Self {
        if self.hi < 0. || !self.hi.is_finite() {
            return Self::unbounded();
        }
        let lo = if self.lo <= 0. { 0. } else { self.lo.sqrt() };
        Self::new(lo, self.hi.max(0.).sqrt())
    }
}

#[derive(Clone, Copy, Debug)]
struct Iv2 {
    x: Iv,
    y: Iv,
}
impl Iv2 {
    fn new(x: Iv, y: Iv) -> Self {
        Self { x, y }
    }
    fn add(self, other: Self) -> Self {
        Self::new(self.x.add(other.x), self.y.add(other.y))
    }
    fn sub(self, other: Self) -> Self {
        Self::new(self.x.sub(other.x), self.y.sub(other.y))
    }
    fn scale(self, k: Iv) -> Self {
        Self::new(self.x.mul(k), self.y.mul(k))
    }
    fn hypot_upper(self) -> f64 {
        self.x.abs_max().hypot(self.y.abs_max())
    }
}

fn binom(n: usize, k: usize) -> f64 {
    const C: [[u64; 8]; 8] = [
        [1, 0, 0, 0, 0, 0, 0, 0],
        [1, 1, 0, 0, 0, 0, 0, 0],
        [1, 2, 1, 0, 0, 0, 0, 0],
        [1, 3, 3, 1, 0, 0, 0, 0],
        [1, 4, 6, 4, 1, 0, 0, 0],
        [1, 5, 10, 10, 5, 1, 0, 0],
        [1, 6, 15, 20, 15, 6, 1, 0],
        [1, 7, 21, 35, 35, 21, 7, 1],
    ];
    C[n][k] as f64
}

fn poly_eval(c: &[f64], t: f64) -> f64 {
    let mut y = 0_f64;
    for &ck in c.iter().rev() {
        y = y.mul_add(t, ck);
    }
    y
}
fn poly_deriv(c: &[f64]) -> Vec<f64> {
    c.iter()
        .enumerate()
        .skip(1)
        .map(|(i, &a)| a * i as f64)
        .collect()
}
fn poly_mul(a: &[f64], b: &[f64]) -> Vec<f64> {
    if a.is_empty() || b.is_empty() {
        return vec![0.];
    }
    let mut out = vec![0.; a.len() + b.len() - 1];
    for (i, &x) in a.iter().enumerate() {
        for (j, &y) in b.iter().enumerate() {
            out[i + j] += x * y;
        }
    }
    out
}

/// Outer enclosure of a polynomial on `[a,b]`. Splitting tightens it; the slope
/// bound stays valid even when subdivision stops.
fn poly_range(c: &[f64], a: f64, b: f64) -> Iv {
    poly_range_depth(c, a, b, 0)
}
fn poly_range_depth(c: &[f64], a: f64, b: f64, depth: u32) -> Iv {
    if !(a.is_finite() && b.is_finite()) || a > b {
        return Iv::unbounded();
    }
    if c.is_empty() {
        return Iv::zero();
    }
    if c.len() == 1 {
        return Iv::pt(c[0]);
    }
    let pa = poly_eval(c, a);
    let pb = poly_eval(c, b);
    if !pa.is_finite() || !pb.is_finite() {
        return Iv::unbounded();
    }
    let derivative = if depth >= 10 {
        let scale = a.abs().max(b.abs()).max(1.);
        let mut magnitude = 0.;
        let mut power = 1.;
        for coefficient in poly_deriv(c) {
            magnitude += coefficient.abs() * power;
            power *= scale;
        }
        Iv::new(-magnitude, magnitude)
    } else {
        poly_range_depth(&poly_deriv(c), a, b, depth + 1)
    };
    if !derivative.is_bounded() {
        return Iv::unbounded();
    }
    let span = b - a;
    let upper = (pa + derivative.hi.max(0.) * span).min(pb + (-derivative.lo).max(0.) * span);
    let lower = (pa + derivative.lo.min(0.) * span).max(pb - derivative.hi.max(0.) * span);
    let bound = Iv::new(lower.min(pa).min(pb), upper.max(pa).max(pb));
    let ends = (pa - pb).abs();
    // A linear polynomial is already exact. Keep splitting only while the slope
    // bound still claims interior extrema beyond the endpoints.
    if depth < 8 && bound.width() > ends + 1e-9 * (1. + bound.abs_max()) && span > 1e-8 {
        let mid = (a + b) * 0.5;
        return poly_range_depth(c, a, mid, depth + 1).union(poly_range_depth(
            c,
            mid,
            b,
            depth + 1,
        ));
    }
    bound
}

fn deriv_ranges(poly: &[f64], t0: f64, t1: f64, order: usize) -> Vec<Iv> {
    let mut current = poly.to_vec();
    let mut out = Vec::with_capacity(order);
    for _ in 0..order {
        out.push(poly_range(&current, t0, t1));
        current = poly_deriv(&current);
        if current.is_empty() {
            current = vec![0.];
        }
    }
    out
}

fn mul_derivs(a: &[Iv], b: &[Iv]) -> Vec<Iv> {
    let n = a.len().min(b.len());
    (0..n)
        .map(|k| {
            let mut sum = Iv::zero();
            for i in 0..=k {
                sum = sum.add(a[i].mul(b[k - i]).scale(binom(k, i)));
            }
            sum
        })
        .collect()
}
fn div_derivs(a: &[Iv], b: &[Iv]) -> Vec<Iv> {
    let n = a.len().min(b.len());
    let mut result = vec![Iv::zero(); n];
    if n == 0 {
        return result;
    }
    result[0] = a[0].div(b[0]);
    for k in 1..n {
        let mut middle = Iv::zero();
        for i in 0..k {
            middle = middle.add(result[i].mul(b[k - i]).scale(binom(k, i)));
        }
        result[k] = a[k].sub(middle).div(b[0]);
    }
    result
}
fn sqrt_derivs(q: &[Iv]) -> Vec<Iv> {
    let n = q.len();
    let mut s = vec![Iv::zero(); n];
    if n == 0 {
        return s;
    }
    s[0] = q[0].sqrt();
    for k in 1..n {
        let mut middle = Iv::zero();
        for i in 1..k {
            middle = middle.add(s[i].mul(s[k - i]).scale(binom(k, i)));
        }
        s[k] = q[k].sub(middle).div(s[0].scale(2.));
    }
    s
}
fn shift(d: &[Iv]) -> Vec<Iv> {
    if d.len() <= 1 {
        return vec![Iv::zero()];
    }
    d[1..].to_vec()
}

#[derive(Clone, Copy)]
struct GuideJet {
    tangent: Iv2,
    normal: Iv2,
    kappa: Iv,
    kappa_s: Iv,
    kappa_ss: Iv,
    kappa_sss: Iv,
}
fn guide_jet(points: [Point; 4], t0: f64, t1: f64) -> GuideJet {
    let a = points[1] - points[0];
    let b = points[2] - points[1];
    let c = points[3] - points[2];
    let dx = [3. * a.x, 6. * (b.x - a.x), 3. * (a.x - 2. * b.x + c.x)];
    let dy = [3. * a.y, 6. * (b.y - a.y), 3. * (a.y - 2. * b.y + c.y)];
    let dx_d = deriv_ranges(&dx, t0, t1, T_ORDER);
    let dy_d = deriv_ranges(&dy, t0, t1, T_ORDER);
    let speed_sq = mul_derivs(&dx_d, &dx_d)
        .iter()
        .zip(mul_derivs(&dy_d, &dy_d))
        .map(|(x, y)| (*x).add(y))
        .collect::<Vec<_>>();
    let sigma = sqrt_derivs(&speed_sq);
    let gx = dx_d[0];
    let gy = dy_d[0];
    let tangent = Iv2::new(gx.div(sigma[0]), gy.div(sigma[0]));
    let normal = Iv2::new(tangent.y.neg(), tangent.x);
    // G'' is the t-derivative of G'. cross(G', G'') and G'·G'' use order-0.. boxes.
    let gxx = shift(&dx_d);
    let gyy = shift(&dy_d);
    let cross = {
        let left = mul_derivs(&dx_d, &gyy);
        let right = mul_derivs(&dy_d, &gxx);
        left.iter()
            .zip(right)
            .map(|(a, b)| a.sub(b))
            .collect::<Vec<_>>()
    };
    let sigma3 = mul_derivs(&speed_sq, &sigma);
    let kappa_t = div_derivs(&cross, &sigma3);
    let kappa_s_t = div_derivs(&shift(&kappa_t), &sigma);
    let kappa_ss_t = div_derivs(&shift(&kappa_s_t), &sigma);
    let kappa_sss_t = div_derivs(&shift(&kappa_ss_t), &sigma);
    GuideJet {
        tangent,
        normal,
        kappa: kappa_t.first().copied().unwrap_or_else(Iv::unbounded),
        kappa_s: kappa_s_t.first().copied().unwrap_or_else(Iv::unbounded),
        kappa_ss: kappa_ss_t.first().copied().unwrap_or_else(Iv::unbounded),
        kappa_sss: kappa_sss_t.first().copied().unwrap_or_else(Iv::unbounded),
    }
}

fn chain4(f: &[Iv2; 5], s: &[Iv; 5]) -> Iv2 {
    // Fourth u-derivative of F(s(u)). f[k] = d^k F/ds^k, s[k] = d^k s/du^k.
    let s1 = s[1];
    let s2 = s[2];
    let s3 = s[3];
    let s4 = s[4];
    f[4].scale(s1.sqr().sqr())
        .add(f[3].scale(s1.sqr().mul(s2).scale(6.)))
        .add(f[2].scale(s2.sqr().scale(3.).add(s1.mul(s3).scale(4.))))
        .add(f[1].scale(s4))
}

fn product4(n: &[Iv2; 5], h: &[Iv; 5]) -> Iv2 {
    let mut sum = Iv2::new(Iv::zero(), Iv::zero());
    for i in 0..=4 {
        sum = sum.add(n[i].scale(h[4 - i].scale(binom(4, i))));
    }
    sum
}

#[derive(Clone, Copy)]
enum Piece {
    Line { a: Point, b: Point },
    Cubic { p: [Point; 4] },
}
impl Piece {
    fn end(self, start: bool) -> Point {
        match self {
            Self::Line { a, b } => {
                if start {
                    a
                } else {
                    b
                }
            }
            Self::Cubic { p } => {
                if start {
                    p[0]
                } else {
                    p[3]
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
struct Frame {
    point: Point,
    tangent: Point,
    normal: Point,
    kappa: f64,
    kappa_s: f64,
}

fn cubic_at(p: [Point; 4], t: f64) -> (Point, Point, Point, Point) {
    let u = 1. - t;
    let b0 = u * u * u;
    let b1 = 3. * u * u * t;
    let b2 = 3. * u * t * t;
    let b3 = t * t * t;
    let point = p[0] * b0 + p[1] * b1 + p[2] * b2 + p[3] * b3;
    let a = p[1] - p[0];
    let b = p[2] - p[1];
    let c = p[3] - p[2];
    let d1 = a * (3. * u * u) + b * (6. * u * t) + c * (3. * t * t);
    let d2 = (p[2] - p[1] * 2. + p[0]) * (6. * u) + (p[3] - p[2] * 2. + p[1]) * (6. * t);
    let d3 = (p[3] - p[2] * 3. + p[1] * 3. - p[0]) * 6.;
    (point, d1, d2, d3)
}
fn line_at(a: Point, b: Point, t: f64) -> (Point, Point, Point, Point) {
    (a.lerp(b, t), b - a, Point::new(0., 0.), Point::new(0., 0.))
}

fn frame_from_derivatives(point: Point, d1: Point, d2: Point, d3: Point) -> Frame {
    let mut tangent_vector = d1;
    if tangent_vector.length() < 1e-12 {
        tangent_vector = d2;
    }
    if tangent_vector.length() < 1e-12 {
        tangent_vector = d3;
    }
    let sigma = tangent_vector.length();
    let tangent = if sigma > 0. {
        tangent_vector * (1. / sigma)
    } else {
        Point::new(1., 0.)
    };
    let normal = Point::new(-tangent.y, tangent.x);
    let speed = d1.length();
    if speed < 1e-12 {
        return Frame {
            point,
            tangent,
            normal,
            kappa: 0.,
            kappa_s: 0.,
        };
    }
    let cross = d1.cross(d2);
    let kappa = cross / speed.powi(3);
    let numer = d1.cross(d3) * speed * speed - 3. * cross * d1.dot(d2);
    let kappa_s = numer / speed.powi(6);
    Frame {
        point,
        tangent,
        normal,
        kappa,
        kappa_s,
    }
}
fn frame_at_parameter(piece: Piece, t: f64) -> Frame {
    let (point, d1, d2, d3) = match piece {
        Piece::Line { a, b } => line_at(a, b, t),
        Piece::Cubic { p } => cubic_at(p, t),
    };
    frame_from_derivatives(point, d1, d2, d3)
}

struct SpineSeg {
    piece: Piece,
    s0: f64,
    s1: f64,
    jet: GuideJet,
}
fn line_jet(a: Point, b: Point) -> GuideJet {
    let length = (b - a).length();
    let tangent = if length > 0. {
        (b - a) * (1. / length)
    } else {
        Point::new(1., 0.)
    };
    GuideJet {
        tangent: Iv2::new(Iv::pt(tangent.x), Iv::pt(tangent.y)),
        normal: Iv2::new(Iv::pt(-tangent.y), Iv::pt(tangent.x)),
        kappa: Iv::zero(),
        kappa_s: Iv::zero(),
        kappa_ss: Iv::zero(),
        kappa_sss: Iv::zero(),
    }
}
struct Corner {
    s: f64,
    x: f64,
    point: Point,
    normal_in: Point,
    normal_out: Point,
    theta: f64,
}

struct Mapper {
    segs: Vec<SpineSeg>,
    corners: Vec<Corner>,
    xmin: f64,
    sx: f64,
    yc: f64,
    sy: f64,
    length: f64,
}

fn tick(work: &mut usize) -> Result<(), String> {
    *work += 1;
    if *work > WORK_LIMIT {
        Err("Vector brush arc-length work budget exceeded".into())
    } else {
        Ok(())
    }
}

fn split_bezier(p: [Point; 4], t: f64) -> ([Point; 4], [Point; 4]) {
    let p01 = p[0].lerp(p[1], t);
    let p12 = p[1].lerp(p[2], t);
    let p23 = p[2].lerp(p[3], t);
    let p012 = p01.lerp(p12, t);
    let p123 = p12.lerp(p23, t);
    let mid = p012.lerp(p123, t);
    ([p[0], p01, p012, mid], [mid, p123, p23, p[3]])
}
fn sub_bezier(p: [Point; 4], u0: f64, u1: f64) -> [Point; 4] {
    let u0 = u0.clamp(0., 1.);
    let u1 = u1.clamp(u0, 1.);
    if u0 <= 1e-15 && u1 >= 1. - 1e-15 {
        return p;
    }
    let (_, right) = split_bezier(p, u0);
    let local = if u0 >= 1. {
        0.
    } else {
        ((u1 - u0) / (1. - u0)).clamp(0., 1.)
    };
    split_bezier(right, local).0
}

fn min_interior_speed(p: [Point; 4]) -> (f64, f64) {
    let a = p[1] - p[0];
    let b = p[2] - p[1];
    let c = p[3] - p[2];
    let dx = [3. * a.x, 6. * (b.x - a.x), 3. * (a.x - 2. * b.x + c.x)];
    let dy = [3. * a.y, 6. * (b.y - a.y), 3. * (a.y - 2. * b.y + c.y)];
    let dx2 = poly_mul(&dx, &dx);
    let dy2 = poly_mul(&dy, &dy);
    let mut speed_sq = vec![0.; dx2.len().max(dy2.len())];
    for (i, value) in dx2.iter().enumerate() {
        speed_sq[i] += value;
    }
    for (i, value) in dy2.iter().enumerate() {
        speed_sq[i] += value;
    }
    let derivative = poly_deriv(&speed_sq);
    let mut best = (0.5, f64::MAX);
    let mut candidates = vec![0., 1.];
    // Derivative is degree 3. Isolate its roots by the quadratic critical points of that cubic.
    if derivative.len() >= 2 {
        let second = poly_deriv(&derivative);
        if second.len() >= 3 && second[2].abs() > 1e-18 {
            let disc = second[1] * second[1] - 4. * second[2] * second[0];
            if disc >= 0. {
                let q = -0.5 * (second[1] + disc.sqrt().copysign(second[1]));
                if q != 0. {
                    candidates.push(q / second[2]);
                    candidates.push(second[0] / q);
                }
            }
        } else if second.len() >= 2 && second[1].abs() > 1e-18 {
            candidates.push(-second[0] / second[1]);
        }
    }
    candidates.retain(|t| (0. ..=1.).contains(t) && t.is_finite());
    candidates.sort_by(f64::total_cmp);
    candidates.dedup_by(|a, b| (*a - *b).abs() < 1e-8);
    for window in candidates.windows(2) {
        let (mut lo, mut hi) = (window[0], window[1]);
        let f = |t: f64| poly_eval(&derivative, t);
        if f(lo) == 0. {
            let speed = poly_eval(&speed_sq, lo).max(0.).sqrt();
            if speed < best.1 {
                best = (lo, speed);
            }
            continue;
        }
        if f(lo).signum() == f(hi).signum() {
            continue;
        }
        for _ in 0..40 {
            let mid = (lo + hi) * 0.5;
            if f(lo).signum() == f(mid).signum() {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let t = (lo + hi) * 0.5;
        let speed = poly_eval(&speed_sq, t).max(0.).sqrt();
        if speed < best.1 {
            best = (t, speed);
        }
    }
    for t in [0., 0.5, 1.] {
        let speed = poly_eval(&speed_sq, t).max(0.).sqrt();
        if speed < best.1 {
            best = (t, speed);
        }
    }
    best
}

fn expand_track(track: &Track, work: &mut usize) -> Result<Vec<SpineSeg>, String> {
    let mut segs = Vec::new();
    for (index, segment) in track.segments.iter().enumerate() {
        tick(work)?;
        let s0 = track.ends[index];
        let s1 = track.ends[index + 1];
        match *segment {
            Segment::Line(a, b) => segs.push(SpineSeg {
                piece: Piece::Line { a, b },
                s0,
                s1,
                jet: line_jet(a, b),
            }),
            Segment::Cubic(curve) => {
                let (t, speed) = min_interior_speed(curve.0);
                let scale = curve
                    .0
                    .iter()
                    .fold(0_f64, |m, p| m.max(p.x.abs()).max(p.y.abs()))
                    .max(1.);
                if (0.02..0.98).contains(&t) && speed < 1e-8 * scale {
                    let (left, right) = split_bezier(curve.0, t);
                    let mut left_work = 0;
                    let (l0, l1) = Curve(left)
                        .bounds(ARC_ERROR, 0, &mut left_work)
                        .unwrap_or((0., 1.));
                    let (r0, r1) = Curve(right)
                        .bounds(ARC_ERROR, 0, &mut left_work)
                        .unwrap_or((0., 1.));
                    *work += left_work.min(WORK_LIMIT);
                    tick(work)?;
                    let left_share = (l0 + l1).max(0.);
                    let right_share = (r0 + r1).max(0.);
                    let total = (left_share + right_share).max(1e-15);
                    let mid = s0 + (s1 - s0) * (left_share / total);
                    segs.push(SpineSeg {
                        piece: Piece::Cubic { p: left },
                        s0,
                        s1: mid,
                        jet: guide_jet(left, 0., 1.),
                    });
                    segs.push(SpineSeg {
                        piece: Piece::Cubic { p: right },
                        s0: mid,
                        s1,
                        jet: guide_jet(right, 0., 1.),
                    });
                } else {
                    segs.push(SpineSeg {
                        piece: Piece::Cubic { p: curve.0 },
                        s0,
                        s1,
                        jet: guide_jet(curve.0, 0., 1.),
                    });
                }
            }
        }
    }
    Ok(segs)
}

fn turn_angle(incoming: Point, outgoing: Point) -> f64 {
    let cross = incoming.cross(outgoing);
    let dot = incoming.dot(outgoing);
    if cross.abs() <= 1e-12 && dot < 0. {
        std::f64::consts::PI
    } else {
        cross.atan2(dot)
    }
}

impl Mapper {
    fn new(
        track: &Track,
        xmin: f64,
        xmax: f64,
        ymin: f64,
        ymax: f64,
        width: f64,
        work: &mut usize,
    ) -> Result<Self, String> {
        let segs = expand_track(track, work)?;
        let sx = track.length / (xmax - xmin);
        let sy = width / (ymax - ymin);
        let max_h = width * 0.5;
        let mut corners = Vec::new();
        for index in 0..segs.len().saturating_sub(1) {
            tick(work)?;
            let incoming = frame_at_parameter(segs[index].piece, 1.).tangent;
            let outgoing = frame_at_parameter(segs[index + 1].piece, 0.).tangent;
            let theta = turn_angle(incoming, outgoing);
            if max_h * theta.abs() <= FIT_ERROR * 0.25 {
                continue;
            }
            let s = segs[index].s1;
            corners.push(Corner {
                s,
                x: xmin + s / sx,
                point: segs[index].piece.end(false),
                normal_in: Point::new(-incoming.y, incoming.x),
                normal_out: Point::new(-outgoing.y, outgoing.x),
                theta,
            });
        }
        Ok(Self {
            segs,
            corners,
            xmin,
            sx,
            yc: (ymin + ymax) * 0.5,
            sy,
            length: track.length,
        })
    }

    fn s_of(&self, x: f64) -> f64 {
        ((x - self.xmin) * self.sx).clamp(0., self.length)
    }
    fn h_of(&self, y: f64) -> f64 {
        (y - self.yc) * self.sy
    }

    fn segment_index(&self, s: f64) -> usize {
        self.segs
            .iter()
            .position(|seg| s <= seg.s1 + 1e-12)
            .unwrap_or(self.segs.len() - 1)
    }

    fn frame_on(&self, index: usize, s: f64, work: &mut usize) -> Result<Frame, String> {
        tick(work)?;
        let seg = &self.segs[index];
        let span = (seg.s1 - seg.s0).max(0.);
        let local = (s - seg.s0).clamp(0., span);
        match seg.piece {
            Piece::Line { a, b } => {
                let tangent = if span > 0. {
                    (b - a) * (1. / (b - a).length())
                } else {
                    Point::new(1., 0.)
                };
                Ok(Frame {
                    point: if span > 0. { a + tangent * local } else { a },
                    tangent,
                    normal: Point::new(-tangent.y, tangent.x),
                    kappa: 0.,
                    kappa_s: 0.,
                })
            }
            Piece::Cubic { p } => {
                let t = if span <= 1e-15 || local <= 0. {
                    0.
                } else if local >= span {
                    1.
                } else {
                    self.parameter_at(p, local, work)?
                };
                Ok(frame_at_parameter(Piece::Cubic { p }, t))
            }
        }
    }

    /// Parameter whose certified arc length is `distance`, bracketed inside the
    /// published inverse-length budget.
    fn parameter_at(&self, p: [Point; 4], distance: f64, work: &mut usize) -> Result<f64, String> {
        if distance <= 0. {
            return Ok(0.);
        }
        let curve = Curve(p);
        let (_total_lo, total_hi) = curve.bounds(ARC_ERROR / 64., 0, work)?;
        if distance >= total_hi {
            return Ok(1.);
        }
        let mut interval = curve;
        let mut start = 0.;
        let mut end = 1.;
        let mut distance = distance.max(0.);
        for _ in 0..48 {
            tick(work)?;
            let (_lo, hi) = interval.bounds(ARC_ERROR / 64., 0, work)?;
            if hi <= ARC_ERROR / 64. {
                return Ok((start + end) * 0.5);
            }
            if distance <= 0. {
                return Ok(start);
            }
            if distance >= hi {
                return Ok(end);
            }
            let (left, right) = interval.split();
            let (left_lo, left_hi) = left.bounds(ARC_ERROR / 64., 0, work)?;
            let mid = (start + end) * 0.5;
            if distance < left_lo {
                interval = left;
                end = mid;
            } else if distance > left_hi {
                interval = right;
                start = mid;
                distance -= (left_lo + left_hi) * 0.5;
            } else {
                return Ok(mid);
            }
        }
        Err("Vector brush stretch precision budget exceeded".into())
    }

    fn frame(&self, s: f64, incoming: bool, work: &mut usize) -> Result<Frame, String> {
        let s = s.clamp(0., self.length);
        if let Some(corner) = self
            .corners
            .iter()
            .find(|corner| (corner.s - s).abs() <= 1e-9)
        {
            let tangent = if incoming {
                Point::new(corner.normal_in.y, -corner.normal_in.x)
            } else {
                Point::new(corner.normal_out.y, -corner.normal_out.x)
            };
            let normal = if incoming {
                corner.normal_in
            } else {
                corner.normal_out
            };
            return Ok(Frame {
                point: corner.point,
                tangent,
                normal,
                kappa: 0.,
                kappa_s: 0.,
            });
        }
        let mut index = self.segment_index(s);
        if incoming && (s - self.segs[index].s0).abs() <= 1e-9 && index > 0 {
            index -= 1;
        }
        self.frame_on(index, s, work)
    }

    fn map_point(&self, x: f64, y: f64, incoming: bool, work: &mut usize) -> Result<Point, String> {
        let frame = self.frame(self.s_of(x), incoming, work)?;
        Ok(frame.point + frame.normal * self.h_of(y))
    }
    fn map_derivative(
        &self,
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
        incoming: bool,
        work: &mut usize,
    ) -> Result<Point, String> {
        let frame = self.frame(self.s_of(x), incoming, work)?;
        let h = self.h_of(y);
        let ds = self.sx * dx;
        let dh = self.sy * dy;
        if !frame.kappa.is_finite() || !frame.kappa_s.is_finite() {
            return Err("Vector brush stretch precision budget exceeded".into());
        }
        Ok(frame.tangent * ((1. - frame.kappa * h) * ds) + frame.normal * dh)
    }

    fn straight_affine(&self, s0: f64, s1: f64) -> Option<(Point, Point, f64)> {
        if s1 < s0 {
            return self.straight_affine(s1, s0);
        }
        let mut tangent = None;
        for seg in &self.segs {
            if seg.s1 < s0 - 1e-9 || seg.s0 > s1 + 1e-9 {
                continue;
            }
            let Piece::Line { a, b } = seg.piece else {
                return None;
            };
            let direction = b - a;
            let length = direction.length();
            if length <= 1e-15 {
                continue;
            }
            let unit = direction * (1. / length);
            if let Some(previous) = tangent {
                if (unit - previous).length() > 1e-12 {
                    return None;
                }
            } else {
                tangent = Some(unit);
            }
        }
        if self
            .corners
            .iter()
            .any(|corner| corner.s > s0 + 1e-9 && corner.s < s1 - 1e-9)
        {
            return None;
        }
        let tangent = tangent?;
        let origin = self.segs.iter().find(|seg| s0 <= seg.s1 + 1e-12)?;
        let Piece::Line { a, b } = origin.piece else {
            return None;
        };
        let span = (b - a).length().max(1e-15);
        let local = (s0 - origin.s0).clamp(0., origin.s1 - origin.s0);
        let point = a + (b - a) * (local / span);
        Some((point, tangent, s0))
    }

    fn map_affine_point(
        &self,
        origin: Point,
        tangent: Point,
        s_origin: f64,
        x: f64,
        y: f64,
    ) -> Point {
        let normal = Point::new(-tangent.y, tangent.x);
        origin + tangent * (self.s_of(x) - s_origin) + normal * self.h_of(y)
    }

    fn fourth_bound(&self, kind: Src, u0: f64, u1: f64) -> f64 {
        let (x0, x1) = kind.x_range(u0, u1);
        let s0 = self.s_of(x0.min(x1));
        let s1 = self.s_of(x0.max(x1));
        if self
            .corners
            .iter()
            .any(|corner| corner.s > s0 + 1e-9 && corner.s < s1 - 1e-9)
        {
            return f64::INFINITY;
        }
        let mut bound = 0_f64;
        let mut saw = false;
        for seg in &self.segs {
            if seg.s1 < s0 - 1e-9 || seg.s0 > s1 + 1e-9 {
                continue;
            }
            saw = true;
            bound = bound.max(self.fourth_on_segment(seg, kind, u0, u1));
        }
        if saw {
            bound
        } else {
            0.
        }
    }

    fn fourth_on_segment(&self, seg: &SpineSeg, kind: Src, u0: f64, u1: f64) -> f64 {
        let jet = seg.jet;
        let (sx, hx) = kind.derivative_ranges(u0, u1, self.sx, self.sy, self.yc);
        let kappa = jet.kappa;
        let ks = jet.kappa_s;
        let kss = jet.kappa_ss;
        let ksss = jet.kappa_sss;
        let tangent = jet.tangent;
        let normal = jet.normal;
        let k2 = kappa.sqr();
        let p_s = [
            Iv2::new(Iv::zero(), Iv::zero()),
            tangent,
            normal.scale(kappa),
            normal.scale(ks).sub(tangent.scale(k2)),
            normal
                .scale(kss.sub(kappa.mul(k2)))
                .sub(tangent.scale(kappa.mul(ks).scale(3.))),
        ];
        let n_s = [
            normal,
            tangent.scale(kappa.scale(-1.)),
            tangent.scale(ks.scale(-1.)).sub(normal.scale(k2)),
            tangent
                .scale(kappa.mul(k2).sub(kss))
                .sub(normal.scale(kappa.mul(ks).scale(3.))),
            tangent.scale(kappa.sqr().mul(ks).scale(6.).sub(ksss)).add(
                normal.scale(
                    kappa
                        .sqr()
                        .sqr()
                        .sub(kappa.mul(kss).scale(4.))
                        .sub(ks.sqr().scale(3.)),
                ),
            ),
        ];
        let p_u = chain4(&p_s, &sx);
        let bend = product4(&compose_all(&n_s, &sx), &hx);
        p_u.add(bend).hypot_upper()
    }
}

fn compose_all(f: &[Iv2; 5], s: &[Iv; 5]) -> [Iv2; 5] {
    let s1 = s[1];
    let s2 = s[2];
    let s3 = s[3];
    let s4 = s[4];
    [
        f[0],
        f[1].scale(s1),
        f[2].scale(s1.sqr()).add(f[1].scale(s2)),
        f[3].scale(s1.mul(s1.sqr()))
            .add(f[2].scale(s1.mul(s2).scale(3.)))
            .add(f[1].scale(s3)),
        f[4].scale(s1.sqr().sqr())
            .add(f[3].scale(s1.sqr().mul(s2).scale(6.)))
            .add(f[2].scale(s2.sqr().scale(3.).add(s1.mul(s3).scale(4.))))
            .add(f[1].scale(s4)),
    ]
}

#[derive(Clone, Copy)]
enum Src {
    Line { a: Point, b: Point },
    Cubic { p: [Point; 4] },
}
impl Src {
    fn at(self, u: f64) -> (Point, Point) {
        match self {
            Self::Line { a, b } => (a.lerp(b, u), b - a),
            Self::Cubic { p } => {
                let (point, d1, _, _) = cubic_at(p, u);
                (point, d1)
            }
        }
    }
    fn x_range(self, u0: f64, u1: f64) -> (f64, f64) {
        match self {
            Self::Line { a, b } => {
                let x0 = a.lerp(b, u0).x;
                let x1 = a.lerp(b, u1).x;
                (x0.min(x1), x0.max(x1))
            }
            Self::Cubic { p } => {
                let sub = sub_bezier(p, u0, u1);
                let xs = [sub[0].x, sub[1].x, sub[2].x, sub[3].x];
                let power = bernstein_to_power(xs);
                let mut values = vec![xs[0], xs[3]];
                let derivative = [power[1], 2. * power[2], 3. * power[3]];
                for t in quadratic_roots(derivative[2], derivative[1], derivative[0]) {
                    if (0. ..=1.).contains(&t) {
                        values.push(poly_eval(&power, t));
                    }
                }
                (
                    values.iter().copied().fold(f64::INFINITY, f64::min),
                    values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                )
            }
        }
    }
    fn derivative_ranges(self, u0: f64, u1: f64, sx: f64, sy: f64, yc: f64) -> ([Iv; 5], [Iv; 5]) {
        match self {
            Self::Line { a, b } => {
                let p0 = a.lerp(b, u0);
                let p1 = a.lerp(b, u1);
                let d = b - a;
                let h0 = Iv::new((p0.y - yc) * sy, (p1.y - yc) * sy);
                (
                    [
                        Iv::zero(),
                        Iv::pt(d.x * sx),
                        Iv::zero(),
                        Iv::zero(),
                        Iv::zero(),
                    ],
                    [h0, Iv::pt(d.y * sy), Iv::zero(), Iv::zero(), Iv::zero()],
                )
            }
            Self::Cubic { p } => {
                let sub = sub_bezier(p, u0, u1);
                let xs = bernstein_to_power([sub[0].x, sub[1].x, sub[2].x, sub[3].x]);
                let ys = bernstein_to_power([sub[0].y, sub[1].y, sub[2].y, sub[3].y]);
                let x_ranges = deriv_ranges(&xs, 0., 1., 5);
                let y_ranges = deriv_ranges(&ys, 0., 1., 5);
                // Subcurve parameter v in [0,1] corresponds to u in [u0,u1], v=(u-u0)/du.
                // Derivatives above were taken wrt v. Convert to u by the chain du factor.
                let du = (u1 - u0).max(1e-15);
                let mut s = [Iv::zero(); 5];
                let mut h = [Iv::zero(); 5];
                for k in 0..5 {
                    let scale = du.powi(-(k as i32));
                    s[k] = x_ranges[k].scale(sx * scale);
                    h[k] = y_ranges[k].scale(sy * scale);
                }
                h[0] = y_ranges[0].sub(Iv::pt(yc)).scale(sy);
                (s, h)
            }
        }
    }
    fn roots_at_x(self, x: f64) -> Vec<f64> {
        match self {
            Self::Line { a, b } => {
                let dx = b.x - a.x;
                if dx.abs() <= 1e-15 {
                    return Vec::new();
                }
                let t = (x - a.x) / dx;
                if (1e-10..1. - 1e-10).contains(&t) {
                    vec![t]
                } else {
                    Vec::new()
                }
            }
            Self::Cubic { p } => {
                let mut power = bernstein_to_power([p[0].x, p[1].x, p[2].x, p[3].x]);
                power[0] -= x;
                cubic_roots_unit(power[3], power[2], power[1], power[0])
            }
        }
    }
}

fn bernstein_to_power(c: [f64; 4]) -> [f64; 4] {
    [
        c[0],
        -3. * c[0] + 3. * c[1],
        3. * c[0] - 6. * c[1] + 3. * c[2],
        -c[0] + 3. * c[1] - 3. * c[2] + c[3],
    ]
}
fn quadratic_roots(a: f64, b: f64, c: f64) -> Vec<f64> {
    if !a.is_finite() || !b.is_finite() || !c.is_finite() {
        return Vec::new();
    }
    if a.abs() < 1e-18 {
        return if b.abs() < 1e-18 {
            Vec::new()
        } else {
            vec![-c / b]
        };
    }
    let d = b * b - 4. * a * c;
    if d < 0. {
        return Vec::new();
    }
    let q = -0.5 * (b + d.sqrt().copysign(b));
    if q == 0. {
        vec![-b / (2. * a)]
    } else {
        vec![q / a, c / q]
    }
}
fn cubic_roots_unit(a: f64, b: f64, c: f64, d: f64) -> Vec<f64> {
    let f = |t: f64| ((a * t + b) * t + c) * t + d;
    let mut knots = vec![0., 1.];
    for t in quadratic_roots(3. * a, 2. * b, c) {
        if (0. ..=1.).contains(&t) {
            knots.push(t);
        }
    }
    knots.sort_by(f64::total_cmp);
    knots.dedup_by(|p, q| (*p - *q).abs() < 1e-12);
    let mut roots = Vec::new();
    for window in knots.windows(2) {
        let (mut lo, mut hi) = (window[0], window[1]);
        let (flo, fhi) = (f(lo), f(hi));
        if !flo.is_finite() || !fhi.is_finite() {
            continue;
        }
        if flo.abs() <= 1e-10 {
            roots.push(lo);
            continue;
        }
        if flo.signum() == fhi.signum() {
            continue;
        }
        for _ in 0..50 {
            let mid = (lo + hi) * 0.5;
            if f(lo).signum() == f(mid).signum() {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let root = (lo + hi) * 0.5;
        if (1e-10..1. - 1e-10).contains(&root) {
            roots.push(root);
        }
    }
    roots.sort_by(f64::total_cmp);
    roots.dedup_by(|p, q| (*p - *q).abs() < 1e-8);
    roots
}

fn push_command(out: &mut Vec<Command>, command: Command) -> Result<(), String> {
    if out.len() >= LIMIT {
        return Err("Vector brush stretch output budget exceeded".into());
    }
    if !command_finite(&command) {
        return Err("Vector brush stretch precision budget exceeded".into());
    }
    out.push(command);
    Ok(())
}
fn command_finite(command: &Command) -> bool {
    match *command {
        Command::Move(p) | Command::Line(p) => p.finite(),
        Command::Cubic(a, b, c) => a.finite() && b.finite() && c.finite(),
        Command::Quad(a, b) => a.finite() && b.finite(),
        Command::Arc {
            center,
            radius,
            start,
            sweep,
        } => center.finite() && radius.finite() && start.is_finite() && sweep.is_finite(),
        Command::Close => true,
        Command::SmoothCorner(_) => false,
    }
}

impl Mapper {
    fn emit_join(
        &self,
        corner: &Corner,
        y: f64,
        low_to_high: bool,
        out: &mut Vec<Command>,
    ) -> Result<(), String> {
        let h = self.h_of(y);
        let radius = h.abs();
        if radius <= 1e-12 {
            return Ok(());
        }
        let (from, sweep) = if low_to_high {
            (corner.normal_in, corner.theta)
        } else {
            (corner.normal_out, -corner.theta)
        };
        let vector = from * h;
        push_command(
            out,
            Command::Arc {
                center: corner.point,
                radius: Point::new(radius, radius),
                start: vector.y.atan2(vector.x),
                sweep,
            },
        )
    }

    fn emit_span(
        &self,
        kind: Src,
        u0: f64,
        u1: f64,
        out: &mut Vec<Command>,
        work: &mut usize,
    ) -> Result<(), String> {
        self.fit(kind, u0, u1, 0, out, work)
    }

    fn fit(
        &self,
        kind: Src,
        u0: f64,
        u1: f64,
        depth: u32,
        out: &mut Vec<Command>,
        work: &mut usize,
    ) -> Result<(), String> {
        tick(work)?;
        let du = u1 - u0;
        if du <= 1e-12 {
            return Ok(());
        }
        let (x0, x1) = kind.x_range(u0, u1);
        let s0 = self.s_of(x0.min(x1));
        let s1 = self.s_of(x0.max(x1));
        if let Some((origin, tangent, s_origin)) = self.straight_affine(s0, s1) {
            return self.emit_exact_affine(kind, u0, u1, origin, tangent, s_origin, out);
        }
        let fourth = self.fourth_bound(kind, u0, u1);
        let hermite_error = fourth * du.powi(4) / 384.;
        if fourth.is_finite() && hermite_error <= FIT_ERROR {
            let start_incoming = self.corner_side_is_incoming(kind, u0, u1);
            let end_incoming = self.corner_side_is_incoming(kind, u1, u0);
            let (p0, d0_src) = kind.at(u0);
            let (p1, d1_src) = kind.at(u1);
            let g0 = self.map_point(p0.x, p0.y, start_incoming, work)?;
            let g1 = self.map_point(p1.x, p1.y, end_incoming, work)?;
            let d0 = self.map_derivative(p0.x, p0.y, d0_src.x, d0_src.y, start_incoming, work)?;
            let d1 = self.map_derivative(p1.x, p1.y, d1_src.x, d1_src.y, end_incoming, work)?;
            let c1 = g0 + d0 * (du / 3.);
            let c2 = g1 - d1 * (du / 3.);
            let mut samples_ok = c1.finite() && c2.finite();
            if samples_ok {
                for t in [0.25, 0.5, 0.75] {
                    let u = u0 + du * t;
                    let (p, _) = kind.at(u);
                    let mapped = self.map_point(p.x, p.y, false, work)?;
                    let on_cubic = cubic_at([g0, c1, c2, g1], t).0;
                    if (mapped - on_cubic).length() > FIT_ERROR {
                        samples_ok = false;
                        break;
                    }
                }
            }
            if samples_ok {
                return push_command(out, Command::Cubic(c1, c2, g1));
            }
        }
        if depth >= 16 || du < 1e-7 {
            let speed = self.speed_bound(kind, u0, u1);
            if speed.is_finite() && speed * du <= FIT_ERROR {
                let end_incoming = self.corner_side_is_incoming(kind, u1, u0);
                let (p1, _) = kind.at(u1);
                let g1 = self.map_point(p1.x, p1.y, end_incoming, work)?;
                return push_command(out, Command::Line(g1));
            }
            return Err("Vector brush stretch precision budget exceeded".into());
        }
        let mid = (u0 + u1) * 0.5;
        self.fit(kind, u0, mid, depth + 1, out, work)?;
        self.fit(kind, mid, u1, depth + 1, out, work)
    }

    /// `true` when `u` sits on a corner and the span interior lies on the low-s side,
    /// so the limit uses the incoming normal. The outgoing normal is the other side.
    fn corner_side_is_incoming(&self, kind: Src, u: f64, toward: f64) -> bool {
        let (point, _) = kind.at(u);
        let Some(corner) = self
            .corners
            .iter()
            .find(|corner| (corner.x - point.x).abs() <= 1e-7)
        else {
            return false;
        };
        let (other, _) = kind.at(toward);
        other.x < corner.x
    }

    fn speed_bound(&self, kind: Src, u0: f64, u1: f64) -> f64 {
        let (sx, hx) = kind.derivative_ranges(u0, u1, self.sx, self.sy, self.yc);
        let (x0, x1) = kind.x_range(u0, u1);
        let s0 = self.s_of(x0.min(x1));
        let s1 = self.s_of(x0.max(x1));
        let mut kappa = 0_f64;
        for seg in &self.segs {
            if seg.s1 < s0 - 1e-9 || seg.s0 > s1 + 1e-9 {
                continue;
            }
            kappa = kappa.max(seg.jet.kappa.abs_max());
        }
        let h = hx[0].abs_max();
        (1. + kappa * h) * sx[1].abs_max() + hx[1].abs_max()
    }

    fn emit_exact_affine(
        &self,
        kind: Src,
        u0: f64,
        u1: f64,
        origin: Point,
        tangent: Point,
        s_origin: f64,
        out: &mut Vec<Command>,
    ) -> Result<(), String> {
        let map = |p: Point| self.map_affine_point(origin, tangent, s_origin, p.x, p.y);
        match kind {
            Src::Line { .. } => {
                let (_, end) = {
                    let (p, _) = kind.at(u1);
                    ((), map(p))
                };
                push_command(out, Command::Line(end))
            }
            Src::Cubic { p } => {
                let sub = sub_bezier(p, u0, u1);
                push_command(out, Command::Cubic(map(sub[1]), map(sub[2]), map(sub[3])))
            }
        }
    }

    fn map_edge(&self, kind: Src, out: &mut Vec<Command>, work: &mut usize) -> Result<(), String> {
        let mut splits = vec![0., 1.];
        for corner in &self.corners {
            splits.extend(kind.roots_at_x(corner.x));
        }
        splits.retain(|t| t.is_finite());
        splits.sort_by(f64::total_cmp);
        splits.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        for window in splits.windows(2) {
            let (u0, u1) = (window[0], window[1]);
            if u1 - u0 <= 1e-12 {
                continue;
            }
            self.emit_span(kind, u0, u1, out, work)?;
            if (u1 - 1.).abs() <= 1e-9 {
                continue;
            }
            let (left, _) = kind.at((u0 + u1) * 0.5);
            let (right_u0, right_u1) = {
                let next = splits
                    .iter()
                    .copied()
                    .find(|t| *t > u1 + 1e-12)
                    .unwrap_or(1.);
                (u1, next)
            };
            if right_u1 - right_u0 <= 1e-12 {
                continue;
            }
            let (right, _) = kind.at((right_u0 + right_u1) * 0.5);
            let (at, _) = kind.at(u1);
            if let Some(corner) = self
                .corners
                .iter()
                .find(|corner| (corner.x - at.x).abs() <= 1e-7)
            {
                let low_to_high = left.x < corner.x && right.x > corner.x;
                let high_to_low = left.x > corner.x && right.x < corner.x;
                if low_to_high || high_to_low {
                    self.emit_join(corner, at.y, low_to_high, out)?;
                }
            }
        }
        Ok(())
    }

    fn map_path(&self, source: &super::Path, work: &mut usize) -> Result<Vec<Command>, String> {
        let mut out = Vec::new();
        let mut pen = Point::new(0., 0.);
        let mut first = Point::new(0., 0.);
        let mut first_src = Point::new(0., 0.);
        let mut have = false;
        for command in &source.commands {
            tick(work)?;
            match *command {
                Command::Move(p) => {
                    let mapped = self.map_point(p.x, p.y, false, work)?;
                    push_command(&mut out, Command::Move(mapped))?;
                    pen = p;
                    first = mapped;
                    first_src = p;
                    have = true;
                }
                Command::Line(p) => {
                    self.map_edge(Src::Line { a: pen, b: p }, &mut out, work)?;
                    pen = p;
                }
                Command::Cubic(a, b, p) => {
                    self.map_edge(Src::Cubic { p: [pen, a, b, p] }, &mut out, work)?;
                    pen = p;
                }
                Command::Quad(control, p) => {
                    let a = pen.lerp(control, 2. / 3.);
                    let b = p.lerp(control, 2. / 3.);
                    self.map_edge(Src::Cubic { p: [pen, a, b, p] }, &mut out, work)?;
                    pen = p;
                }
                Command::Close => {
                    if have && (pen - first_src).length() > 1e-9 {
                        self.map_edge(
                            Src::Line {
                                a: pen,
                                b: first_src,
                            },
                            &mut out,
                            work,
                        )?;
                    }
                    if have {
                        if let (Some(last), true) =
                            (out.last().cloned(), (pen - first_src).length() <= 1e-9)
                        {
                            let end = match last {
                                Command::Move(p)
                                | Command::Line(p)
                                | Command::Cubic(_, _, p)
                                | Command::Quad(_, p) => p,
                                Command::Arc {
                                    center,
                                    radius,
                                    start,
                                    sweep,
                                } => {
                                    let angle = start + sweep;
                                    center
                                        + Point::new(radius.x * angle.cos(), radius.y * angle.sin())
                                }
                                Command::Close | Command::SmoothCorner(_) => first,
                            };
                            if (end - first).length() > 1e-8 && (end - first).length() <= FIT_ERROR
                            {
                                push_command(&mut out, Command::Line(first))?;
                            }
                        }
                    }
                    push_command(&mut out, Command::Close)?;
                    pen = first_src;
                }
                _ => return Err("Unsupported brush source command".into()),
            }
        }
        Ok(out)
    }
}

pub(super) fn apply(
    track: &Track,
    source: &super::Path,
    xmin: f64,
    xmax: f64,
    ymin: f64,
    ymax: f64,
    width: f64,
    work: &mut usize,
) -> Result<Vec<Command>, String> {
    let mapper = Mapper::new(track, xmin, xmax, ymin, ymax, width, work)?;
    mapper.map_path(source, work)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polynomial_range_encloses_a_parabola() {
        let range = poly_range(&[-1., 0., 1.], -2., 2.);
        assert!(range.lo <= -1. && range.hi >= 3.);
        assert!(range.lo > -1.1 && range.hi < 3.1);
    }

    #[test]
    fn line_guide_fourth_derivative_stays_inside_the_fit_budget() {
        let p = [
            Point::new(0., 0.),
            Point::new(10., 0.),
            Point::new(20., 0.),
            Point::new(30., 0.),
        ];
        let jet = guide_jet(p, 0., 1.);
        assert!(jet.kappa.abs_max() < 1e-6, "kappa {}", jet.kappa.abs_max());
        assert!(
            jet.kappa_s.abs_max() < 1e-4,
            "kappa_s {}",
            jet.kappa_s.abs_max()
        );
    }
}
