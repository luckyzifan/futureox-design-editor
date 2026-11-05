use crate::math::{Point, Transform};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Contour {
    pub points: Vec<Point>,
    pub closed: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    Move(Point),
    Line(Point),
    Quad(Point, Point),
    Cubic(Point, Point, Point),
    Arc {
        center: Point,
        radius: Point,
        start: f64,
        sweep: f64,
    },
    SmoothCorner(SmoothCorner),
    Close,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Path {
    pub commands: Vec<Command>,
}
/// Immutable local fill/stroke paths. Text may use one shared outline for
/// both; device preparation never mutates these owners.
pub(crate) enum LocalPaths {
    Owned((Path,Path)),
    Text(std::sync::Arc<Path>),
}
impl LocalPaths {
    pub(crate) fn pair(&self)->(&Path,&Path) {
        match self {Self::Owned((fill,stroke))=>(fill,stroke),Self::Text(path)=>(path,path)}
    }
}
pub(crate) type SharedPaths = std::sync::Arc<LocalPaths>;
#[derive(Clone, Copy)]
struct FillGuard {
    min: Point,
    max: Point,
}
/// Internal retained superellipse quarter. This is not a serialized scene or
/// SVG command, and is not the Figma corner-smoothing algorithm.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SmoothCorner {
    pub(crate) center: Point,
    pub(crate) radius: f64,
    pub(crate) power: f64,
    pub(crate) quadrant: usize,
}
impl SmoothCorner {
    pub(crate) fn orient(self, p: Point) -> Point {
        match self.quadrant {
            0 => Point::new(p.y, -p.x),
            1 => p,
            2 => Point::new(-p.y, p.x),
            _ => Point::new(-p.x, -p.y),
        }
    }
    fn sample(self, t: f64) -> (Point, Point) {
        // Fractional powers amplify trig residuals at cardinal angles.
        if t == 0. {
            return (Point::new(1., 0.), Point::new(1., 0.));
        }
        if t == std::f64::consts::FRAC_PI_2 {
            return (Point::new(0., 1.), Point::new(0., 1.));
        }
        let (s, c) = t.sin_cos();
        let p = Point::new(c.powf(2. / self.power), s.powf(2. / self.power));
        // x^n=cos²(t), y^n=sin²(t), so the implicit normal (x^(n-1),
        // y^(n-1)) needs no additional pow calls. Subdivision reuses endpoints.
        (p, Point::new(c * c / p.x, s * s / p.y))
    }
    pub(crate) fn point(self, t: f64) -> Point {
        self.center + self.orient(self.sample(t).0) * self.radius
    }
    pub(crate) fn legacy_points(self) -> impl Iterator<Item = Point> {
        (1..=64).map(move |j| {
            let a = (-0.5 + self.quadrant as f64 * 0.5 + j as f64 / 128.) * std::f64::consts::PI;
            let (s, c) = a.sin_cos();
            self.center
                + Point::new(
                    c.signum() * c.abs().powf(2. / self.power),
                    s.signum() * s.abs().powf(2. / self.power),
                ) * self.radius
        })
    }
    fn flatten(
        self,
        m: Transform,
        tolerance: f64,
        out: &mut Vec<Point>,
        remaining: &mut usize,
        clip: Option<FillGuard>,
    ) -> Result<(), String> {
        if !self.center.finite()
            || !self.radius.is_finite()
            || self.radius < 0.
            || !self.power.is_finite()
            || self.power < 2.
        {
            return Err("Invalid smooth corner".into());
        }
        let center = m.point(self.center);
        if self.radius == 0. {
            if !center.finite() {
                return Err("Invalid smooth corner device point".into());
            }
            if *remaining == 0 {
                return Err("Smooth corner subdivision budget exceeded".into());
            }
            out.push(center);
            *remaining -= 1;
            return Ok(());
        }
        let linear = |p: Point| {
            let p = self.orient(p) * self.radius;
            Point::new(m.0[0] * p.x + m.0[2] * p.y, m.0[1] * p.x + m.0[3] * p.y)
        };
        // Include uncancelled source products: a large center/translation can
        // cancel in device space without recovering bits lost in local geometry.
        let extent =
            ((m.0[0] * self.center.x).abs() + (m.0[2] * self.center.y).abs() + m.0[4].abs()).max(
                (m.0[1] * self.center.x).abs() + (m.0[3] * self.center.y).abs() + m.0[5].abs(),
            ) + linear(Point::new(1., 0.)).length()
                + linear(Point::new(0., 1.)).length();
        let roundoff = 32. * f64::EPSILON * extent;
        if !extent.is_finite() || roundoff >= tolerance {
            return Err(
                "Smooth corner cannot satisfy error tolerance at this coordinate precision".into(),
            );
        }
        let tolerance = tolerance - roundoff;
        let mut stack = vec![(
            0.,
            self.sample(0.),
            std::f64::consts::FRAC_PI_2,
            self.sample(std::f64::consts::FRAC_PI_2),
            0u8,
        )];
        let mut generated = 0usize;
        while let Some((ta, (a, na), tb, (b, nb), depth)) = stack.pop() {
            if generated >= 131072 || *remaining == 0 {
                return Err("Smooth corner subdivision budget exceeded".into());
            }
            // The entire monotone subarc AND its chord lie inside this
            // transformed endpoint box. Replacing it by the chord outside one
            // guard half-plane preserves winding everywhere inside the guard.
            // This is fill-only clipping, never a relaxed curve-error contract.
            let outside = clip.is_some_and(|clip| {
                let ps =
                    [a, b, Point::new(a.x, b.y), Point::new(b.x, a.y)].map(|p| center + linear(p));
                ps.iter().all(|p| p.x < clip.min.x - roundoff)
                    || ps.iter().all(|p| p.x > clip.max.x + roundoff)
                    || ps.iter().all(|p| p.y < clip.min.y - roundoff)
                    || ps.iter().all(|p| p.y > clip.max.y + roundoff)
            });
            let chord = linear(b - a);
            let tangent = Point::new(-na.y, na.x);
            let determinant = tangent.dot(nb);
            // A convex superellipse subarc lies inside its tangent triangle.
            // Distance to the finite chord segment is convex, so the tangent
            // intersection gives an upper bound, preserved by any affine map.
            // Near-parallel tangents instead use the enclosing monotone box.
            let error = if outside {
                0.
            } else if determinant > 32. * f64::EPSILON {
                let v = tangent * ((b - a).dot(nb) / determinant);
                distance_to_segment(linear(v), Point::default(), chord)
            } else {
                distance_to_segment(linear(Point::new(b.x - a.x, 0.)), Point::default(), chord).max(
                    distance_to_segment(linear(Point::new(0., b.y - a.y)), Point::default(), chord),
                )
            };
            if error.is_finite() && error <= tolerance {
                let p = center + linear(b);
                if !p.finite() {
                    return Err("Invalid smooth corner device point".into());
                }
                out.push(p);
                generated += 1;
                *remaining -= 1;
                continue;
            }
            if depth == 32 {
                return Err("Smooth corner cannot satisfy error tolerance".into());
            }
            let t = (ta + tb) * 0.5;
            if t == ta || t == tb {
                return Err("Smooth corner cannot satisfy error tolerance".into());
            }
            let mid = self.sample(t);
            stack.push((t, mid, tb, (b, nb), depth + 1));
            stack.push((ta, (a, na), t, mid, depth + 1));
        }
        Ok(())
    }
}
fn distance_to_segment(p: Point, a: Point, b: Point) -> f64 {
    let d = b - a;
    let t = ((p - a).dot(d) / d.dot(d).max(1e-30)).clamp(0., 1.);
    (p - a.lerp(b, t)).length()
}

// The projection and subdivision points are unchanged. Away from the
// threshold the squared norm decides the same comparison without hypot.
// The wide uncertainty band leaves all rounding-sensitive decisions (and
// exceptional operands) to the original operation.
#[inline]
fn cubic_flatness_band(tolerance: f64) -> (f64, f64) {
    if (1e-12..=1e12).contains(&tolerance) {
        let squared = tolerance * tolerance;
        (squared * (1. - 1. / 1024.), squared * (1. + 1. / 1024.))
    } else {
        (f64::NEG_INFINITY, f64::INFINITY)
    }
}

#[inline]
fn cubic_controls_flat(a: Point, b: Point, c: Point, d: Point, tolerance: f64, band: (f64, f64)) -> bool {
    let chord = d - a;
    let denominator = chord.dot(chord).max(1e-30);
    let distance = |p: Point| {
        let t = ((p - a).dot(chord) / denominator).clamp(0., 1.);
        let delta = p - a.lerp(d, t);
        let squared = delta.dot(delta);
        if squared < band.0 { 0. } else if squared > band.1 { f64::INFINITY } else { delta.length() }
    };
    let first = distance(b);
    // Keep f64::max's handling of a single NaN in the ambiguous case.
    !(first > tolerance) && first.max(distance(c)) <= tolerance
}
// Convex-hull distance bounds handle collinear overshoot and coincident endpoints.
// De Casteljau subdivision is performed AFTER the device transform, so tolerance
// is measured in device pixels, including nonuniform scale and shear.
// Algorithm background: https://agg.sourceforge.net/antigrain.com/research/adaptive_bezier/
pub fn flatten_cubic(
    a: Point,
    b: Point,
    c: Point,
    d: Point,
    tolerance: f64,
    out: &mut Vec<Point>,
) -> Result<(), String> {
    flatten_cubic_guarded(a, b, c, d, tolerance, out, None)
}
fn flatten_cubic_guarded(
    a: Point,
    b: Point,
    c: Point,
    d: Point,
    tolerance: f64,
    out: &mut Vec<Point>,
    clip: Option<FillGuard>,
) -> Result<(), String> {
    let mut stack = vec![(a, b, c, d, 0u8)];
    let band = cubic_flatness_band(tolerance);
    while let Some((a, b, c, d, depth)) = stack.pop() {
        if out.len() > 131072 {
            return Err("Curve subdivision budget exceeded".into());
        }
        // A Bezier curve and its chord lie in the control-point convex hull.
        // Replacing a subcurve entirely beyond one guard half-plane preserves
        // fill winding inside the guard; stroke/length/export callers use None.
        let outside = clip.is_some_and(|clip| {
            if a.x >= clip.min.x && a.x <= clip.max.x && a.y >= clip.min.y && a.y <= clip.max.y {
                return false;
            }
            let ps = [a, b, c, d];
            let pad = 64.
                * f64::EPSILON
                * ps.iter()
                    .map(|p| p.x.abs().max(p.y.abs()))
                    .fold(0_f64, f64::max);
            ps.iter().all(|p| p.x < clip.min.x - pad)
                || ps.iter().all(|p| p.x > clip.max.x + pad)
                || ps.iter().all(|p| p.y < clip.min.y - pad)
                || ps.iter().all(|p| p.y > clip.max.y + pad)
        });
        let flat = outside || cubic_controls_flat(a, b, c, d, tolerance, band);
        if flat {
            out.push(d);
            continue;
        }
        if depth == 24 {
            return Err("Curve cannot satisfy error tolerance".into());
        }
        let ab = a.lerp(b, 0.5);
        let bc = b.lerp(c, 0.5);
        let cd = c.lerp(d, 0.5);
        let abc = ab.lerp(bc, 0.5);
        let bcd = bc.lerp(cd, 0.5);
        let mid = abc.lerp(bcd, 0.5);
        stack.push((mid, bcd, cd, d, depth + 1));
        stack.push((a, ab, abc, mid, depth + 1));
    }
    Ok(())
}
/// Exact elliptical-arc piece: a rational quadratic Bézier whose endpoints
/// carry unit weight and whose middle weight is cos(Δθ/2). Together with its
/// start point this is the conic form of `Command::Arc`. Evaluation and
/// bounds are exact; only the polynomial `to_cubic` downgrade approximates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RationalQuad {
    pub control: Point,
    pub weight: f64,
    pub end: Point,
}
impl RationalQuad {
    pub fn at(self, from: Point, t: f64) -> Point {
        let s = 1. - t;
        let w = [s * s, 2. * self.weight * s * t, t * t];
        (from * w[0] + self.control * w[1] + self.end * w[2]) * (1. / (w[0] + w[1] + w[2]))
    }
    /// Parameters of the per-axis extrema: roots of the quadratic derivative
    /// numerator N'D − ND'. The denominator stays positive for w > 0.
    fn extrema(self, from: Point) -> Vec<f64> {
        let mut out = Vec::new();
        for (p0, p1, p2) in [
            (from.x, self.control.x, self.end.x),
            (from.y, self.control.y, self.end.y),
        ] {
            let w = self.weight;
            let (a2, a1, a0) = (p0 - 2. * w * p1 + p2, 2. * (w * p1 - p0), p0);
            let (d2, d1, d0) = (2. * (1. - w), 2. * (w - 1.), 1.);
            let (c2, c1, c0) = (
                a2 * d1 - a1 * d2,
                2. * (a2 * d0 - a0 * d2),
                a1 * d0 - a0 * d1,
            );
            if c2.abs() < 1e-14 {
                if c1.abs() >= 1e-14 {
                    out.push(-c0 / c1);
                }
            } else {
                let d = c1 * c1 - 4. * c2 * c0;
                if d >= 0. {
                    let q = -0.5 * (c1 + d.sqrt().copysign(c1));
                    if q.abs() < 1e-30 {
                        out.push(-c1 / (2. * c2));
                    } else {
                        out.push(q / c2);
                        out.push(c0 / q);
                    }
                }
            }
        }
        out.retain(|t| *t > 0. && *t < 1.);
        out
    }
    /// Exact axis-aligned bounds of the piece, endpoints included.
    pub fn bounds(self, from: Point) -> (Point, Point) {
        let mut min = Point::new(from.x.min(self.end.x), from.y.min(self.end.y));
        let mut max = Point::new(from.x.max(self.end.x), from.y.max(self.end.y));
        for t in self.extrema(from) {
            let p = self.at(from, t);
            min = Point::new(min.x.min(p.x), min.y.min(p.y));
            max = Point::new(max.x.max(p.x), max.y.max(p.y));
        }
        (min, max)
    }
    /// Polynomial downgrade for engines without rational segments. Control
    /// legs span 4w/(3(1+w)) of the tangent triangle, the k=4/3·tan(Δθ/4)
    /// cubic rewritten in rational control-point form.
    pub fn to_cubic(self, from: Point) -> (Point, Point, Point) {
        let k = 4. * self.weight / (3. * (1. + self.weight));
        (
            from + (self.control - from) * k,
            self.end + (self.control - self.end) * k,
            self.end,
        )
    }
}
/// Split `Command::Arc` geometry into exact rational pieces of at most
/// `max_step` sweep each. Returns (start, piece) pairs in sweep order.
pub fn rational_arc(
    center: Point,
    radius: Point,
    start: f64,
    sweep: f64,
    max_step: f64,
) -> Result<Vec<(Point, RationalQuad)>, String> {
    if !center.finite()
        || !radius.finite()
        || radius.x == 0.
        || radius.y == 0.
        || !start.is_finite()
        || !sweep.is_finite()
        || !max_step.is_finite()
        || !(0. ..=std::f64::consts::FRAC_PI_2).contains(&max_step)
    {
        return Err("Invalid rational arc parameters".into());
    }
    if sweep == 0. {
        return Ok(Vec::new());
    }
    let count = (sweep.abs() / max_step).ceil();
    if !count.is_finite() || count > 131072. {
        return Err("Rational arc subdivision budget exceeded".into());
    }
    let count = count as usize;
    let step = sweep / count as f64;
    let weight = (step / 2.).cos();
    let point = |t: f64| center + Point::new(radius.x * t.cos(), radius.y * t.sin());
    Ok((0..count)
        .map(|i| {
            let t0 = start + step * i as f64;
            let mid = t0 + step / 2.;
            let control =
                center + Point::new(radius.x * mid.cos(), radius.y * mid.sin()) * (1. / weight);
            (
                point(t0),
                RationalQuad {
                    control,
                    weight,
                    end: point(t0 + step),
                },
            )
        })
        .collect())
}
impl Path {
    /// Preserve curves in vector exchange; a complete SVG ellipse needs two
    /// arcs because an arc with identical start/end positions draws nothing.
    pub fn svg_data(&self) -> String {
        use std::fmt::Write;
        let mut out = String::new();
        for command in &self.commands {
            match *command {
                Command::Move(p) => {
                    write!(out, "M{} {} ", p.x, p.y).unwrap();
                }
                Command::Line(p) => {
                    write!(out, "L{} {} ", p.x, p.y).unwrap();
                }
                Command::Quad(c, p) => {
                    write!(out, "Q{} {} {} {} ", c.x, c.y, p.x, p.y).unwrap();
                }
                Command::Cubic(a, b, p) => {
                    write!(out, "C{} {} {} {} {} {} ", a.x, a.y, b.x, b.y, p.x, p.y).unwrap();
                }
                Command::Arc {
                    center,
                    radius,
                    start,
                    sweep,
                } => {
                    let pieces = (sweep.abs() / std::f64::consts::PI).ceil().max(1.) as usize;
                    for i in 1..=pieces {
                        let a = start + sweep * i as f64 / pieces as f64;
                        let p = center + Point::new(radius.x * a.cos(), radius.y * a.sin());
                        if radius.x == 0. || radius.y == 0. {
                            write!(out, "L{} {} ", p.x, p.y).unwrap();
                        } else {
                            write!(
                                out,
                                "A{} {} 0 0 {} {} {} ",
                                radius.x.abs(),
                                radius.y.abs(),
                                u8::from(sweep * radius.x * radius.y > 0.),
                                p.x,
                                p.y
                            )
                            .unwrap();
                        }
                    }
                }
                Command::SmoothCorner(corner) => {
                    // SVG has no superellipse primitive. Preserve the legacy
                    // 64-chord exchange approximation; CPU precision is separate.
                    for p in corner.legacy_points() {
                        write!(out, "L{} {} ", p.x, p.y).unwrap();
                    }
                }
                Command::Close => out.push_str("Z "),
            }
        }
        out
    }
    pub fn control_bounds(&self, m: Transform) -> crate::math::Rect {
        crate::math::Rect::from_points(
            self.commands
                .iter()
                .flat_map(|c| match *c {
                    Command::Move(p) | Command::Line(p) => [Some(p), None, None, None],
                    Command::Quad(a, b) => [Some(a), Some(b), None, None],
                    Command::Cubic(a, b, c) => [Some(a), Some(b), Some(c), None],
                    Command::Arc {
                        center: c,
                        radius: r,
                        ..
                    } => [
                        Some(c - r),
                        Some(c + r),
                        Some(c + Point::new(r.x, -r.y)),
                        Some(c + Point::new(-r.x, r.y)),
                    ],
                    Command::SmoothCorner(corner) => {
                        let c = corner.center;
                        let r = Point::new(corner.radius, corner.radius);
                        [
                            Some(c - r),
                            Some(c + r),
                            Some(c + Point::new(r.x, -r.y)),
                            Some(c + Point::new(-r.x, r.y)),
                        ]
                    }
                    Command::Close => [None, None, None, None],
                })
                .flatten()
                .map(|p| m.point(p)),
        )
    }
    pub fn flatten(&self, m: Transform, tolerance: f64) -> Result<Vec<Contour>, String> {
        self.flatten_impl(m, tolerance, None)
    }
    /// Smooth-arc chord replacements outside `guard` preserve fill winding in
    /// the guard. Callers must include every effect's sampling halo. This output
    /// is unsuitable for stroke expansion, editing, or geometry export.
    pub(crate) fn flatten_for_fill(
        &self,
        m: Transform,
        tolerance: f64,
        guard: crate::math::Rect,
    ) -> Result<Vec<Contour>, String> {
        self.flatten_impl(
            m,
            tolerance,
            Some(FillGuard {
                min: Point::new(f64::from(guard.x), f64::from(guard.y)),
                max: Point::new(f64::from(guard.right()), f64::from(guard.bottom())),
            }),
        )
    }
    /// Preserve full-polyline winding at `point` and boundary proximity within
    /// `tolerance`. A floating guard avoids clamping large device coordinates to
    /// the render viewport's integer range. Never use this for stroke expansion:
    /// replacing distant arcs changes lengths, dash phase and join geometry.
    pub(crate) fn flatten_for_point(
        &self,
        m: Transform,
        tolerance: f64,
        point: Point,
    ) -> Result<Vec<Contour>, String> {
        let radius = Point::new(tolerance, tolerance);
        self.flatten_impl(
            m,
            tolerance,
            Some(FillGuard {
                min: point - radius,
                max: point + radius,
            }),
        )
    }
    fn flatten_impl(
        &self,
        m: Transform,
        tolerance: f64,
        clip: Option<FillGuard>,
    ) -> Result<Vec<Contour>, String> {
        if !tolerance.is_finite() || tolerance <= 0. || tolerance > 10. {
            return Err("Invalid flattening tolerance".into());
        }
        // Account for uncancelled affine products before fill-only culling.
        // A distant query must not conceal an unrepresentable curve contract.
        let tolerance = if self
            .commands
            .iter()
            .any(|c| matches!(c, Command::Cubic(..) | Command::Quad(..)))
        {
            let mut extent = 0_f64;
            for command in &self.commands {
                let points = match *command {
                    Command::Move(p) | Command::Line(p) => [Some(p), None, None],
                    Command::Quad(a, b) => [Some(a), Some(b), None],
                    Command::Cubic(a, b, c) => [Some(a), Some(b), Some(c)],
                    _ => [None, None, None],
                };
                for p in points.into_iter().flatten() {
                    let x = (m.0[0] * p.x).abs() + (m.0[2] * p.y).abs() + m.0[4].abs();
                    let y = (m.0[1] * p.x).abs() + (m.0[3] * p.y).abs() + m.0[5].abs();
                    extent = extent.max(x).max(y);
                }
            }
            let roundoff = 64. * f64::EPSILON * extent;
            if !extent.is_finite() || roundoff >= tolerance {
                return Err(
                    "Curve cannot satisfy error tolerance at this coordinate precision".into(),
                );
            }
            tolerance - roundoff
        } else {
            tolerance
        };
        let mut contours = Vec::new();
        // At most 8 MiB of new f64 point payload across retained smooth arcs.
        let mut smooth_budget = 524288;
        let mut current = Contour::default();
        let mut pen = Point::default();
        let mut first = pen;
        for c in &self.commands {
            match *c {
                Command::Move(p) => {
                    if !current.points.is_empty() {
                        contours.push(current);
                        current = Contour::default();
                    }
                    pen = m.point(p);
                    first = pen;
                    current.points.push(pen);
                }
                Command::Line(p) => {
                    pen = m.point(p);
                    current.points.push(pen);
                }
                Command::Quad(c, p) => {
                    let c = m.point(c);
                    let p = m.point(p);
                    flatten_cubic_guarded(
                        pen,
                        pen.lerp(c, 2. / 3.),
                        p.lerp(c, 2. / 3.),
                        p,
                        tolerance,
                        &mut current.points,
                        clip,
                    )?;
                    pen = p;
                }
                Command::Cubic(b, c, d) => {
                    let d = m.point(d);
                    flatten_cubic_guarded(
                        pen,
                        m.point(b),
                        m.point(c),
                        d,
                        tolerance,
                        &mut current.points,
                        clip,
                    )?;
                    pen = d;
                }
                Command::SmoothCorner(corner) => {
                    corner.flatten(m, tolerance, &mut current.points, &mut smooth_budget, clip)?;
                    pen = *current.points.last().unwrap();
                }
                Command::Close => {
                    current.closed = true;
                    if current
                        .points
                        .last()
                        .is_some_and(|p| (*p - first).length() < 1e-12)
                    {
                        current.points.pop();
                    }
                    pen = first;
                }
                Command::Arc {
                    center,
                    radius,
                    start,
                    sweep,
                } => {
                    let device_radius = radius.x.abs().max(radius.y.abs()) * m.max_scale();
                    let step = if device_radius <= tolerance {
                        std::f64::consts::FRAC_PI_2
                    } else {
                        2. * (1. - tolerance / device_radius).clamp(-1., 1.).acos()
                    };
                    let segments = (sweep.abs() / step.max(1e-9)).ceil().max(1.) as usize;
                    if segments > 131072 {
                        return Err("Arc subdivision budget exceeded".into());
                    }
                    for i in 1..=segments {
                        let angle = start + sweep * i as f64 / segments as f64;
                        let (s, c) = angle.sin_cos();
                        pen = m.point(center + Point::new(radius.x * c, radius.y * s));
                        current.points.push(pen);
                    }
                }
            }
        }
        if !current.points.is_empty() {
            contours.push(current);
        }
        Ok(contours)
    }
    pub fn polygon(points: &[Point], closed: bool) -> Self {
        let mut p = Self::default();
        if let Some(first) = points.first() {
            p.commands.push(Command::Move(*first));
            p.commands
                .extend(points[1..].iter().copied().map(Command::Line));
            if closed {
                p.commands.push(Command::Close);
            }
        }
        p
    }
    pub fn ellipse(w: f64, h: f64) -> Self {
        let (x, y) = (w / 2., h / 2.);
        Self {
            commands: vec![
                Command::Move(Point::new(w, y)),
                Command::Arc {
                    center: Point::new(x, y),
                    radius: Point::new(x, y),
                    start: 0.,
                    sweep: std::f64::consts::TAU,
                },
                Command::Close,
            ],
        }
    }
    pub fn rectangle(w: f64, h: f64, r: [f64; 4], smoothing: f64) -> Self {
        crate::rounded::rectangle(w, h, r, smoothing)
    }
    /// Explicit superellipse geometry primitive. Authored scene rectangles use
    /// `rectangle` and its cubic corner model; this is not a document fallback.
    pub fn superellipse_rectangle(w: f64, h: f64, r: [f64; 4], smoothing: f64) -> Self {
        let mut path = Self::default();
        let r = r.map(|r| r.max(0.).min(w / 2.).min(h / 2.));
        if smoothing < 1e-6 {
            let arc = |x, y, r, start| Command::Arc {
                center: Point::new(x, y),
                radius: Point::new(r, r),
                start,
                sweep: std::f64::consts::FRAC_PI_2,
            };
            path.commands = vec![
                Command::Move(Point::new(r[0], 0.)),
                Command::Line(Point::new(w - r[1], 0.)),
                arc(w - r[1], r[1], r[1], -std::f64::consts::FRAC_PI_2),
                Command::Line(Point::new(w, h - r[2])),
                arc(w - r[2], h - r[2], r[2], 0.),
                Command::Line(Point::new(r[3], h)),
                arc(r[3], h - r[3], r[3], std::f64::consts::FRAC_PI_2),
                Command::Line(Point::new(0., r[0])),
                arc(r[0], r[0], r[0], std::f64::consts::PI),
                Command::Close,
            ];
            return path;
        }
        let centers = [
            Point::new(w - r[1], r[1]),
            Point::new(w - r[2], h - r[2]),
            Point::new(r[3], h - r[3]),
            Point::new(r[0], r[0]),
        ];
        let rs = [r[1], r[2], r[3], r[0]];
        for (quadrant, center) in centers.into_iter().enumerate() {
            let corner = SmoothCorner {
                center,
                radius: rs[quadrant],
                power: 2. + 3. * smoothing,
                quadrant,
            };
            path.commands.push(if quadrant == 0 {
                Command::Move(corner.point(0.))
            } else {
                Command::Line(corner.point(0.))
            });
            path.commands.push(Command::SmoothCorner(corner));
        }
        path.commands.push(Command::Close);
        path
    }
}
pub fn area(ps: &[Point]) -> f64 {
    ps.iter()
        .enumerate()
        .map(|(i, p)| p.cross(ps[(i + 1) % ps.len()]))
        .sum::<f64>()
        * 0.5
}
pub fn winding(p: Point, cs: &[Contour]) -> i32 {
    let mut winding = 0;
    for c in cs {
        if !c.closed {
            continue;
        }
        for (i, a) in c.points.iter().enumerate() {
            let b = c.points[(i + 1) % c.points.len()];
            let cross = (b - *a).cross(p - *a);
            if a.y <= p.y && b.y > p.y && cross > 0. {
                winding += 1;
            } else if a.y > p.y && b.y <= p.y && cross < 0. {
                winding -= 1;
            }
        }
    }
    winding
}

#[cfg(test)]
mod smooth_fill_tests {
    use super::*;
    use crate::{math::Rect, raster::rasterize};

    #[test]
    fn cubic_flatness_matches_original_at_rounding_boundaries_and_degenerate_chords() {
        let p = Point::new;
        for scale in [1e-100, 1e-12, 1./64., 1., 1e12, 1e100] {
            for (a,b,c,d) in [
                (p(0.,0.),p(0.6,0.8),p(-0.8,0.6),p(0.,0.)),
                (p(1.,0.),p(-2.,0.),p(3.,0.),p(2.,0.)),
                (p(-1.,2.),p(1.,-1.),p(3.,2.),p(2.,3.)),
                (p(1.,0.),p(f64::NAN,2.),p(2.,1.),p(3.,0.)),
            ] {
                let (a,b,c,d) = (a*scale,b*scale,c*scale,d*scale);
                let actual = distance_to_segment(b,a,d).max(distance_to_segment(c,a,d));
                for tolerance in [actual.next_down(), actual, actual.next_up(), actual*0.5, actual*2.] {
                    assert_eq!(cubic_controls_flat(a,b,c,d,tolerance,cubic_flatness_band(tolerance)),
                        actual<=tolerance, "scale={scale} tolerance={tolerance}");
                }
            }
        }
    }
    #[test]
    fn point_guard_preserves_compound_signed_winding_with_reversed_holes() {
        let outer = Path::superellipse_rectangle(4000., 4000., [2000.; 4], 1.);
        let inner = Path::superellipse_rectangle(3000., 3000., [1500.; 4], 1.);
        for m in [
            Transform([32., 0., 0., 32., 0., 0.]),
            Transform([-32., 8., 15., 4., 3e9, -3e9]),
        ] {
            let im = m.concat(Transform([1., 0., 0., 1., 500., 500.]));
            let full_outer = outer.flatten(m, 1. / 64.).unwrap();
            let full_inner = inner.flatten(im, 1. / 64.).unwrap();
            for reverse in [false, true] {
                let mut full = full_outer.clone();
                let mut hole = full_inner.clone();
                if reverse {
                    hole[0].points.reverse();
                }
                full.extend(hole);
                for y in 0..17 {
                    for x in 0..17 {
                        let p = m.point(Point::new(x as f64 * 250., y as f64 * 250.));
                        let mut clipped = outer.flatten_for_point(m, 1. / 64., p).unwrap();
                        let mut hole = inner.flatten_for_point(im, 1. / 64., p).unwrap();
                        if reverse {
                            hole[0].points.reverse();
                        }
                        clipped.extend(hole);
                        // Exact signed count covers both evenodd and nonzero.
                        assert_eq!(winding(p, &clipped), winding(p, &full));
                    }
                }
            }
        }
    }

    #[test]
    fn point_guard_reduces_fill_work_but_is_not_a_stroke_centerline() {
        let path = Path::superellipse_rectangle(4000., 4000., [2000.; 4], 1.);
        let m = Transform([32., 0., 0., 32., 0., 0.]);
        let p = Point::new(64000., 64000.);
        let full = path.flatten(m, 1. / 64.).unwrap();
        let clipped = path.flatten_for_point(m, 1. / 64., p).unwrap();
        assert!(full[0].points.len() > 8000);
        assert!(clipped[0].points.len() < 20);
        let perimeter = |cs: &[Contour]| -> f64 {
            cs.iter()
                .flat_map(|c| {
                    c.points
                        .iter()
                        .enumerate()
                        .map(move |(i, a)| (c.points[(i + 1) % c.points.len()] - *a).length())
                })
                .sum()
        };
        // Reusing this fill output for strokes would corrupt dash/profile phase.
        assert!(perimeter(&full) - perimeter(&clipped) > 1000.);
        assert_eq!(winding(p, &full), winding(p, &clipped));
    }

    #[test]
    fn clipped_smooth_fill_preserves_full_polygon_winding_and_coverage() {
        let path = Path::superellipse_rectangle(4000., 4000., [2000.; 4], 1.);
        for m in [
            Transform([32., 0., 0., 32., -119400.25, -7900.375]),
            Transform([-32., 8., 15., 4., 115500.25, -34300.375]),
            Transform([1., 0., 0., 1., -1970.125, -1970.375]),
        ] {
            let full = path.flatten(m, 1. / 64.).unwrap();
            for guard in [
                Rect::new(0, 0, 64, 64),
                Rect::new(-64, -64, 128, 128),
                Rect::new(47, -21, 64, 64),
            ] {
                let clipped = path.flatten_for_fill(m, 1. / 64., guard).unwrap();
                for evenodd in [true, false] {
                    let expected = rasterize(&full, guard, evenodd);
                    let actual = rasterize(&clipped, guard, evenodd);
                    assert_eq!(
                        actual.data, expected.data,
                        "{m:?}, {guard:?}, evenodd={evenodd}"
                    );
                }
                assert!(clipped[0].points.len() < 100);
                assert!(full[0].points.len() > 100);
            }
        }
    }

    #[test]
    fn fill_clipping_never_changes_the_full_geometry_api() {
        let path = Path::superellipse_rectangle(4000., 4000., [2000.; 4], 1.);
        let m = Transform([32., 0., 0., 32., -119400.25, -7900.375]);
        let before = path.flatten(m, 1. / 64.).unwrap();
        path.flatten_for_fill(m, 1. / 64., Rect::new(0, 0, 64, 64))
            .unwrap();
        let after = path.flatten(m, 1. / 64.).unwrap();
        assert_eq!(before[0].points, after[0].points);
    }

    #[test]
    fn precision_guard_counts_source_products_before_cancellation() {
        let mut path = Path::superellipse_rectangle(1e7, 100., [1e-10; 4], 1.);
        path.commands.truncate(2);
        assert!(
            path.flatten(Transform([1e12, 0., 0., 1e12, -1e19, 0.]), 0.01)
                .unwrap_err()
                .contains("coordinate precision")
        );
    }

    #[test]
    fn smooth_budget_is_shared_across_contours() {
        // Each corner fits the per-corner budget, but repeated disjoint
        // contours must not each acquire a fresh aggregate allocation budget.
        let mut path = Path::superellipse_rectangle(2e7, 2e7, [1e7; 4], 1.);
        path.commands.truncate(2);
        path.commands.push(Command::Close);
        let one = path.flatten(Transform::default(), 0.001).unwrap();
        assert!(one[0].points.len() > 32768);
        let commands = path.commands.clone();
        for _ in 0..16 {
            path.commands.extend(commands.clone());
        }
        assert!(
            path.flatten(Transform::default(), 0.001)
                .unwrap_err()
                .contains("budget")
        );
    }
    #[test]
    fn clipped_compound_smooth_contours_preserve_holes_in_all_quadrants() {
        let mut path = Path::superellipse_rectangle(4000., 4000., [2000.; 4], 1.);
        let mut inner = Path::superellipse_rectangle(3000., 3000., [1500.; 4], 1.);
        for command in &mut inner.commands {
            match command {
                Command::Move(p) | Command::Line(p) => *p = *p + Point::new(500., 500.),
                Command::SmoothCorner(corner) => {
                    corner.center = corner.center + Point::new(500., 500.)
                }
                _ => {}
            }
        }
        path.commands.extend(inner.commands);
        let diagonal = 1500. * 2_f64.powf(-0.2);
        for offset in [
            Point::new(diagonal, diagonal),
            Point::new(-diagonal, diagonal),
            Point::new(-diagonal, -diagonal),
            Point::new(diagonal, -diagonal),
        ] {
            let center = Point::new(2000., 2000.) + offset;
            let m = Transform([
                32.,
                0.,
                0.,
                32.,
                31.5 - center.x * 32.,
                31.5 - center.y * 32.,
            ]);
            let guard = Rect::new(0, 0, 64, 64);
            let full = path.flatten(m, 1. / 64.).unwrap();
            let clipped = path.flatten_for_fill(m, 1. / 64., guard).unwrap();
            for evenodd in [true, false] {
                assert_eq!(
                    rasterize(&full, guard, evenodd).data,
                    rasterize(&clipped, guard, evenodd).data
                );
            }
        }
    }
}

#[cfg(test)]
mod rational_tests {
    use super::*;
    use crate::bounds::path_bounds;

    fn residual(center: Point, radius: Point, p: Point) -> f64 {
        let q = (p - center) / radius;
        q.length() - 1.
    }
    impl std::ops::Div<Point> for Point {
        type Output = Point;
        fn div(self, b: Point) -> Point {
            Point::new(self.x / b.x, self.y / b.y)
        }
    }

    #[test]
    fn rational_pieces_stay_exactly_on_the_ellipse() {
        for (radius, start, sweep) in [
            (Point::new(10., 10.), 0.3, 4.2),
            (Point::new(10., 3.5), -2., -5.1),
            (Point::new(6., 9.), 1., std::f64::consts::TAU),
        ] {
            let center = Point::new(4., -7.);
            let pieces =
                rational_arc(center, radius, start, sweep, std::f64::consts::FRAC_PI_2).unwrap();
            assert_eq!(
                pieces.len(),
                (sweep.abs() / std::f64::consts::FRAC_PI_2).ceil() as usize
            );
            let step = sweep / pieces.len() as f64;
            for (i, (from, piece)) in pieces.iter().enumerate() {
                let t0 = start + step * i as f64;
                for (k, denominator) in [(0, 1), (1, 3), (1, 2), (2, 3), (1, 1)] {
                    let t = k as f64 / denominator as f64;
                    let p = piece.at(*from, t);
                    assert!(residual(center, radius, p).abs() < 1e-12, "{p:?}");
                    if k == denominator {
                        assert_eq!(p, piece.end);
                    }
                }
                // The rational midpoint is the exact mid-angle arc point.
                let mid = t0 + step / 2.;
                let exact = center + Point::new(radius.x * mid.cos(), radius.y * mid.sin());
                let at_half = piece.at(*from, 0.5);
                assert!((at_half - exact).length() < 1e-12);
            }
            assert_eq!(pieces[0].0, {
                let (s, c) = start.sin_cos();
                center + Point::new(radius.x * c, radius.y * s)
            });
        }
    }

    #[test]
    fn rational_bounds_are_exact_extrema_of_the_arc() {
        let center = Point::new(13., -4.);
        let radius = Point::new(8., 5.);
        for (start, sweep) in [(0.3, 4.2), (-2., -5.1), (1., 6.3), (2.9, 0.7)] {
            let pieces =
                rational_arc(center, radius, start, sweep, std::f64::consts::FRAC_PI_2).unwrap();
            let mut min = Point::new(f64::INFINITY, f64::INFINITY);
            let mut max = Point::new(f64::NEG_INFINITY, f64::NEG_INFINITY);
            for (from, piece) in pieces {
                let (lo, hi) = piece.bounds(from);
                min = Point::new(min.x.min(lo.x), min.y.min(lo.y));
                max = Point::new(max.x.max(hi.x), max.y.max(hi.y));
            }
            let analytic = path_bounds(
                &Path {
                    commands: vec![
                        Command::Move(
                            center + Point::new(radius.x * start.cos(), radius.y * start.sin()),
                        ),
                        Command::Arc {
                            center,
                            radius,
                            start,
                            sweep,
                        },
                    ],
                },
                Transform::default(),
            )
            .unwrap();
            assert!((min.x - analytic.x).abs() < 1e-9, "{start} {sweep}");
            assert!((min.y - analytic.y).abs() < 1e-9);
            assert!((max.x - analytic.x - analytic.width).abs() < 1e-9);
            assert!((max.y - analytic.y - analytic.height).abs() < 1e-9);
        }
    }

    #[test]
    fn cubic_downgrade_error_bound_scales_with_the_sixth_power() {
        let mut worst = [0_f64; 2];
        for (slot, (max_step, bound)) in [
            (std::f64::consts::FRAC_PI_2, 3e-4),
            (std::f64::consts::FRAC_PI_4, 1e-5),
        ]
        .into_iter()
        .enumerate()
        {
            for (from, piece) in
                rational_arc(Point::default(), Point::new(1., 1.), 0.31, 5.9, max_step).unwrap()
            {
                let (c1, c2, end) = piece.to_cubic(from);
                for i in 0..=1000 {
                    let t = i as f64 / 1000.;
                    let s = 1. - t;
                    let p = from * (s * s * s)
                        + c1 * (3. * s * s * t)
                        + c2 * (3. * s * t * t)
                        + end * (t * t * t);
                    worst[slot] = worst[slot].max((p.length() - 1.).abs());
                }
            }
            assert!(
                worst[slot] > 0. && worst[slot] < bound,
                "{max_step}: {}",
                worst[slot]
            );
        }
        // Halving the piece sweep must cut the error by ~2⁶, not a constant.
        assert!(
            (30. ..100.).contains(&(worst[0] / worst[1])),
            "{}",
            worst[0] / worst[1]
        );
    }

    #[test]
    fn flatten_remains_a_certified_tessellation_of_the_exact_arc() {
        let center = Point::new(50., 40.);
        let radius = Point::new(30., 30.);
        let tolerance = 0.05;
        let path = Path {
            commands: vec![
                Command::Move(center + Point::new(radius.x, 0.)),
                Command::Arc {
                    center,
                    radius,
                    start: 0.,
                    sweep: std::f64::consts::TAU,
                },
                Command::Close,
            ],
        };
        let contours = path.flatten(Transform::default(), tolerance).unwrap();
        let points = &contours[0].points;
        for &p in points {
            assert!(residual(center, radius, p).abs() < 1e-9);
        }
        for (i, &a) in points.iter().enumerate() {
            let b = points[(i + 1) % points.len()];
            let angle = (a - center)
                .cross(b - center)
                .atan2((a - center).dot(b - center));
            let sagitta = radius.x * (1. - (angle.abs() / 2.).cos());
            assert!(sagitta <= tolerance * (1. + 1e-9), "{sagitta}");
        }
    }

    #[test]
    fn invalid_rational_arc_parameters_are_errors() {
        let c = Point::default();
        let r = Point::new(1., 1.);
        assert!(rational_arc(c, Point::new(0., 1.), 0., 1., 1.).is_err());
        assert!(rational_arc(c, r, 0., 1., 0.).is_err());
        assert!(rational_arc(c, r, 0., 1., 3.).is_err());
        assert!(rational_arc(c, r, f64::NAN, 1., 1.).is_err());
        assert!(rational_arc(c, r, 0., 0., 1.).unwrap().is_empty());
    }
}
