use crate::{
    math::{Point, Transform},
    path::{Command, Path},
};
use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
pub fn paths_bounds(fill:&Path, stroke:&Path, matrix:Transform)->Option<Bounds>{
    match (path_bounds(fill,matrix),path_bounds(stroke,matrix)){
        (Some(a),Some(b))=>{let x=a.x.min(b.x);let y=a.y.min(b.y);Some(Bounds{x,y,width:(a.x+a.width).max(b.x+b.width)-x,height:(a.y+a.height).max(b.y+b.height)-y})},
        (a,b)=>a.or(b),
    }
}
#[derive(Default)]
struct Builder {
    range: Option<[f64; 4]>,
}
impl Builder {
    fn add(&mut self, p: Point) {
        if let Some(r) = &mut self.range {
            r[0] = r[0].min(p.x);
            r[1] = r[1].min(p.y);
            r[2] = r[2].max(p.x);
            r[3] = r[3].max(p.y)
        } else {
            self.range = Some([p.x, p.y, p.x, p.y])
        }
    }
    fn finish(self) -> Option<Bounds> {
        self.range.map(|r| Bounds {
            x: r[0],
            y: r[1],
            width: r[2] - r[0],
            height: r[3] - r[1],
        })
    }
}
fn roots(a: f64, b: f64, c: f64) -> Vec<f64> {
    if a == 0. {
        return if b == 0. { vec![] } else { vec![-c / b] };
    }
    let d = b * b - 4. * a * c;
    if d < 0. {
        return vec![];
    }
    let q = -0.5 * (b + d.sqrt().copysign(b));
    if q == 0. {
        vec![-b / (2. * a)]
    } else {
        vec![q / a, c / q]
    }
}
fn cubic(out: &mut Builder, a: Point, b: Point, c: Point, d: Point) {
    out.add(a);
    out.add(d);
    for (p0, p1, p2, p3) in [(a.x, b.x, c.x, d.x), (a.y, b.y, c.y, d.y)] {
        for t in roots(
            -p0 + 3. * p1 - 3. * p2 + p3,
            2. * (p0 - 2. * p1 + p2),
            p1 - p0,
        ) {
            if t > 0. && t < 1. {
                let s = 1. - t;
                out.add(
                    a * (s * s * s) + b * (3. * s * s * t) + c * (3. * s * t * t) + d * (t * t * t),
                );
            }
        }
    }
}
pub fn path_bounds(path: &Path, m: Transform) -> Option<Bounds> {
    let mut out = Builder::default();
    let mut at = Point::default();
    let mut first = at;
    for command in &path.commands {
        match *command {
            Command::Move(p) => {
                at = p;
                first = p;
            }
            Command::Line(p) => {
                out.add(m.point(at));
                out.add(m.point(p));
                at = p;
            }
            Command::Quad(b, d) => {
                cubic(
                    &mut out,
                    m.point(at),
                    m.point(at + (b - at) * (2. / 3.)),
                    m.point(d + (b - d) * (2. / 3.)),
                    m.point(d),
                );
                at = d;
            }
            Command::Cubic(b, c, d) => {
                cubic(&mut out, m.point(at), m.point(b), m.point(c), m.point(d));
                at = d;
            }
            Command::SmoothCorner(corner) => {
                out.add(m.point(corner.point(0.)));
                out.add(m.point(corner.point(std::f64::consts::FRAC_PI_2)));
                let u = corner.orient(Point::new(1., 0.));
                let v = corner.orient(Point::new(0., 1.));
                for (a, b) in [
                    (m.0[0] * u.x + m.0[2] * u.y, m.0[0] * v.x + m.0[2] * v.y),
                    (m.0[1] * u.x + m.0[3] * u.y, m.0[1] * v.x + m.0[3] * v.y),
                ] {
                    // Interior support extrema exist only when the two positive-
                    // quadrant coefficients have the same sign. Normalize first.
                    if a != 0. && b != 0. && a.signum() == b.signum() {
                        let scale = a.abs().max(b.abs());
                        let x = (a.abs() / scale).powf(1. / (corner.power - 1.));
                        let y = (b.abs() / scale).powf(1. / (corner.power - 1.));
                        let norm =
                            (x.powf(corner.power) + y.powf(corner.power)).powf(1. / corner.power);
                        out.add(m.point(
                            corner.center
                                + corner.orient(Point::new(x / norm, y / norm)) * corner.radius,
                        ));
                    }
                }
                at = corner.point(std::f64::consts::FRAC_PI_2);
            }
            Command::Close => {
                out.add(m.point(at));
                out.add(m.point(first));
                at = first;
            }
            Command::Arc {
                center,
                radius,
                start,
                sweep,
            } => {
                let point =
                    |a: f64| m.point(center + Point::new(radius.x * a.cos(), radius.y * a.sin()));
                out.add(point(start));
                out.add(point(start + sweep));
                let [a, b, c, d, _, _] = m.0;
                for angle in [
                    (c * radius.y).atan2(a * radius.x),
                    (d * radius.y).atan2(b * radius.x),
                ] {
                    for t in [angle, angle + std::f64::consts::PI] {
                        let delta = if sweep >= 0. {
                            (t - start).rem_euclid(std::f64::consts::TAU)
                        } else {
                            (start - t).rem_euclid(std::f64::consts::TAU)
                        };
                        if delta <= sweep.abs() + 1e-12 {
                            out.add(point(t));
                        }
                    }
                }
                at = center
                    + Point::new(
                        radius.x * (start + sweep).cos(),
                        radius.y * (start + sweep).sin(),
                    );
            }
        }
    }
    out.finish()
}
