//! Bounded least-squares cubic fitting with chord-length parameters and optional
//! Newton refinement. No graphics or curve-fitting library is used. Pressure is
//! simplified separately in arc-length space so spatial simplification cannot
//! discard a pressure extremum on an otherwise straight path.
use crate::{
    math::Point,
    scene::{Edge, Network, Vertex},
    stroke::WidthPoint,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Sample {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
}
impl Sample {
    fn point(self) -> Point {
        Point::new(self.x, self.y)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub samples: Vec<Sample>,
    pub tolerance: f64,
    pub pressure_tolerance: f64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fitted {
    pub network: Network,
    pub width_profile: Vec<WidthPoint>,
    pub origin: Point,
    pub width: f64,
    pub height: f64,
    pub dot_pressure: Option<f64>,
    pub input_samples: usize,
}
#[derive(Clone, Copy, Debug)]
struct Cubic {
    a: Point,
    b: Point,
    c: Point,
    d: Point,
}
impl Cubic {
    fn at(self, t: f64) -> Point {
        let s = 1. - t;
        self.a * (s * s * s)
            + self.b * (3. * s * s * t)
            + self.c * (3. * s * t * t)
            + self.d * (t * t * t)
    }
    fn derivative(self, t: f64) -> Point {
        let s = 1. - t;
        (self.b - self.a) * (3. * s * s)
            + (self.c - self.b) * (6. * s * t)
            + (self.d - self.c) * (3. * t * t)
    }
    fn second(self, t: f64) -> Point {
        (self.c - self.b * 2. + self.a) * (6. * (1. - t))
            + (self.d - self.c * 2. + self.b) * (6. * t)
    }
}
fn unit(p: Point) -> Point {
    p * (1. / p.length().max(1e-12))
}
fn parameters(ps: &[Point]) -> Vec<f64> {
    let mut values = vec![0.];
    let mut at = 0.;
    for pair in ps.windows(2) {
        at += (pair[1] - pair[0]).length();
        values.push(at);
    }
    for v in &mut values {
        *v /= at.max(1e-12);
    }
    values
}
fn fit(ps: &[Point], u: &[f64], start: Point, end: Point) -> Cubic {
    let a = ps[0];
    let d = ps[ps.len() - 1];
    let (mut c00, mut c01, mut c11, mut x0, mut x1) = (0., 0., 0., 0., 0.);
    for (p, t) in ps.iter().zip(u) {
        let s = 1. - t;
        let b0 = s * s * s;
        let b1 = 3. * s * s * t;
        let b2 = 3. * s * t * t;
        let b3 = t * t * t;
        let v0 = start * b1;
        let v1 = end * b2;
        let residual = *p - a * (b0 + b1) - d * (b2 + b3);
        c00 += v0.dot(v0);
        c01 += v0.dot(v1);
        c11 += v1.dot(v1);
        x0 += v0.dot(residual);
        x1 += v1.dot(residual);
    }
    let det = c00 * c11 - c01 * c01;
    let length: f64 = ps.windows(2).map(|p| (p[1] - p[0]).length()).sum();
    let (mut alpha, mut beta) = if det.abs() > 1e-12 {
        ((x0 * c11 - x1 * c01) / det, (c00 * x1 - c01 * x0) / det)
    } else {
        (0., 0.)
    };
    if alpha < length * 1e-6
        || beta < length * 1e-6
        || alpha > length
        || beta > length
        || !alpha.is_finite()
        || !beta.is_finite()
    {
        alpha = (d - a).length() / 3.;
        if alpha < 1e-12 {
            alpha = length / 3.;
        }
        beta = alpha;
    }
    Cubic {
        a,
        b: a + start * alpha,
        c: d + end * beta,
        d,
    }
}
fn error(ps: &[Point], u: &[f64], curve: Cubic) -> (f64, usize) {
    let mut max = 0.;
    let mut split = ps.len() / 2;
    for i in 1..ps.len() - 1 {
        let delta = curve.at(u[i]) - ps[i];
        let e = delta.dot(delta);
        if e > max {
            max = e;
            split = i;
        }
    }
    (max, split)
}
fn curves(ps: &[Point], tolerance: f64) -> Result<Vec<Cubic>, String> {
    // Preserve hard turns before fitting; smooth recursive splits share tangents.
    let mut cuts = vec![0];
    for i in 1..ps.len() - 1 {
        if unit(ps[i] - ps[i - 1]).dot(unit(ps[i + 1] - ps[i])) < 0.25 {
            cuts.push(i);
        }
    }
    cuts.push(ps.len() - 1);
    if cuts.len() > 1025 {
        return Err("Freehand corner budget exceeded".into());
    }
    let mut result = Vec::new();
    let mut work = 0;
    for cut in cuts.windows(2) {
        let mut stack = vec![(
            cut[0],
            cut[1],
            unit(ps[cut[0] + 1] - ps[cut[0]]),
            unit(ps[cut[1] - 1] - ps[cut[1]]),
            0,
        )];
        while let Some((lo, hi, start, end, depth)) = stack.pop() {
            let range = &ps[lo..=hi];
            let mut u = parameters(range);
            let mut curve = fit(range, &u, start, end);
            let (mut max, mut split) = error(range, &u, curve);
            for _ in 0..4 {
                work += range.len();
                if work > 4_000_000 {
                    return Err("Freehand fitting work budget exceeded".into());
                }
                if max <= tolerance * tolerance || range.len() == 2 {
                    break;
                }
                let next: Vec<f64> = range
                    .iter()
                    .zip(&u)
                    .enumerate()
                    .map(|(i, (p, t))| {
                        if i == 0 {
                            return 0.;
                        }
                        if i == range.len() - 1 {
                            return 1.;
                        }
                        let delta = curve.at(*t) - *p;
                        let derivative = curve.derivative(*t);
                        let denom = derivative.dot(derivative) + delta.dot(curve.second(*t));
                        if denom.abs() < 1e-12 {
                            *t
                        } else {
                            (*t - delta.dot(derivative) / denom).clamp(0., 1.)
                        }
                    })
                    .collect();
                if next.windows(2).any(|p| p[1] <= p[0]) {
                    break;
                }
                let candidate = fit(range, &next, start, end);
                let (e, at) = error(range, &next, candidate);
                if e >= max {
                    break;
                }
                u = next;
                curve = candidate;
                max = e;
                split = at;
            }
            if max <= tolerance * tolerance || range.len() == 2 {
                result.push(curve);
                if result.len() > 1024 {
                    return Err("Freehand curve budget exceeded".into());
                }
            } else {
                if depth >= 32 {
                    return Err("Freehand fitting depth exceeded".into());
                }
                let at = lo + split;
                let tangent = unit(ps[at + 1] - ps[at - 1]);
                let tangent = if tangent.length() < 1e-10 {
                    unit(ps[at + 1] - ps[at])
                } else {
                    tangent
                };
                stack.push((at, hi, tangent, end, depth + 1));
                stack.push((lo, at, start, tangent * -1., depth + 1));
            }
        }
    }
    Ok(result)
}
fn profile(samples: &[Sample], tolerance: f64) -> Result<Vec<WidthPoint>, String> {
    let ps: Vec<Point> = samples.iter().map(|s| s.point()).collect();
    let ts = parameters(&ps);
    let mut keep = vec![false; samples.len()];
    keep[0] = true;
    keep[samples.len() - 1] = true;
    let mut stack = vec![(0, samples.len() - 1)];
    let mut count = 2;
    let mut work = 0;
    while let Some((lo, hi)) = stack.pop() {
        let mut max = tolerance;
        let mut split = None;
        for i in lo + 1..hi {
            work += 1;
            if work > 4_000_000 {
                return Err("Pressure fitting work budget exceeded".into());
            }
            let t = (ts[i] - ts[lo]) / (ts[hi] - ts[lo]).max(1e-12);
            let expected = samples[lo].pressure + (samples[hi].pressure - samples[lo].pressure) * t;
            let e = (samples[i].pressure - expected).abs();
            if e > max {
                max = e;
                split = Some(i);
            }
        }
        if let Some(at) = split {
            count += 1;
            if count > 512 {
                return Err("Pressure profile exceeds 512 controls; increase smoothing".into());
            }
            keep[at] = true;
            stack.push((lo, at));
            stack.push((at, hi));
        }
    }
    let mut out: Vec<WidthPoint> = Vec::new();
    for (i, s) in samples.iter().enumerate().filter(|(i, _)| keep[*i]) {
        let p = WidthPoint {
            position: ts[i],
            left: s.pressure * 2.,
            right: s.pressure * 2.,
        };
        if out
            .last()
            .is_some_and(|prev| p.position - prev.position < 1e-6)
        {
            return Err("Pressure controls are too close along path".into());
        }
        out.push(p);
    }
    Ok(out)
}

pub fn fit_samples(request: Request) -> Result<Fitted, String> {
    if request.samples.is_empty()
        || request.samples.len() > 8192
        || !request.tolerance.is_finite()
        || !(0.01..=20.).contains(&request.tolerance)
        || !request.pressure_tolerance.is_finite()
        || !(0.001..=0.2).contains(&request.pressure_tolerance)
        || request.samples.iter().any(|s| {
            !s.point().finite()
                || s.x.abs() > 1e7
                || s.y.abs() > 1e7
                || !s.pressure.is_finite()
                || !(0. ..=1.).contains(&s.pressure)
        })
    {
        return Err("Invalid freehand samples or fitting tolerance".into());
    }
    let input_samples = request.samples.len();
    let mut samples: Vec<Sample> = Vec::new();
    for s in request.samples {
        if let Some(last) = samples.last_mut()
            && (last.point() - s.point()).length() < 1e-6
        {
            last.pressure = last.pressure.max(s.pressure);
        } else {
            samples.push(s);
        }
    }
    let mut network = Network {
        vertices: Vec::new(),
        edges: Vec::new(),
        filled_faces: None,
        fill_rule: "nonzero".into(),
    };
    if samples.len() == 1 {
        return Ok(Fitted {
            network,
            width_profile: Vec::new(),
            origin: samples[0].point(),
            width: 1.,
            height: 1.,
            dot_pressure: Some(samples[0].pressure),
            input_samples,
        });
    }
    let ps: Vec<Point> = samples.iter().map(|s| s.point()).collect();
    let curves = curves(&ps, request.tolerance)?;
    let mut path = crate::path::Path::default();
    path.commands.push(crate::path::Command::Move(ps[0]));
    path.commands.extend(
        curves
            .iter()
            .map(|c| crate::path::Command::Cubic(c.b, c.c, c.d)),
    );
    let bounds = crate::bounds::path_bounds(&path, crate::math::Transform::default())
        .ok_or("Empty fitted path")?;
    let min = Point::new(bounds.x, bounds.y);
    let max = Point::new(bounds.x + bounds.width, bounds.y + bounds.height);
    network.vertices.push(Vertex {
        id: "v0".into(),
        x: ps[0].x - min.x,
        y: ps[0].y - min.y,
    });
    for (i, c) in curves.iter().enumerate() {
        let id = format!("v{}", i + 1);
        network.vertices.push(Vertex {
            id: id.clone(),
            x: c.d.x - min.x,
            y: c.d.y - min.y,
        });
        network.edges.push(Edge {
            id: format!("e{i}"),
            from: format!("v{i}"),
            to: id,
            c1: Some(c.b - min),
            c2: Some(c.c - min),
        });
    }
    Ok(Fitted {
        network,
        width_profile: profile(&samples, request.pressure_tolerance)?,
        origin: min,
        width: (max.x - min.x).max(1.),
        height: (max.y - min.y).max(1.),
        dot_pressure: None,
        input_samples,
    })
}
pub fn fit_json(json: &str) -> Result<String, String> {
    let request = serde_json::from_str(json).map_err(|e| format!("{e}"))?;
    serde_json::to_string(&fit_samples(request)?).map_err(|e| format!("{e}"))
}
