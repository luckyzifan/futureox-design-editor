//! Subdivide projected Béziers in homogeneous coordinates. Dividing their
//! controls first and treating them as a polynomial changes the silhouette.
use crate::{
    math::Point,
    path::{Command, Contour, Path, rational_arc},
};

const MAX_POINTS: usize = crate::vector_geometry::MAX_COMMANDS;
pub(crate) const PAGE_TOLERANCE: f64 = 1. / 65536.;

#[derive(Clone, Copy)]
struct WeightedPoint {
    numerator: Point,
    denominator: f64,
}

impl WeightedPoint {
    fn midway(self, other: Self) -> Self {
        Self {
            numerator: self.numerator.lerp(other.numerator, 0.5),
            denominator: (self.denominator + other.denominator) * 0.5,
        }
    }

    fn projected(self) -> Point {
        self.numerator * (1. / self.denominator)
    }
}

fn push(contour: &mut Contour, total: &mut usize, point: Point) -> Result<(), String> {
    if *total >= MAX_POINTS || !point.finite() {
        return Err("Projected outline exceeds the geometry budget".into());
    }
    *total += 1;
    contour.points.push(point);
    Ok(())
}

fn flatten_segment(
    points: &[WeightedPoint],
    tolerance: f64,
    level: u8,
    contour: &mut Contour,
    total: &mut usize,
) -> Result<(), String> {
    let a = points[0].projected();
    let b = points[points.len() - 1].projected();
    let chord = b - a;
    let squared = chord.dot(chord);
    // With positive weights the divided curve lies in the projected convex
    // hull. The distance to the finite chord is a convex function.
    if points[1..points.len() - 1].iter().all(|point| {
        let p = point.projected();
        let t = if squared == 0. { 0. } else { ((p - a).dot(chord) / squared).clamp(0., 1.) };
        (p - (a + chord * t)).length() <= tolerance
    }) {
        return push(contour, total, b);
    }
    if level >= 24 {
        return Err("Projected curve subdivision did not converge".into());
    }
    let mut work = [points[0]; 4];
    let mut left = work;
    let mut right = work;
    let count = points.len();
    work[..count].copy_from_slice(points);
    right[count - 1] = points[count - 1];
    for step in 1..count {
        for i in 0..count - step {
            work[i] = work[i].midway(work[i + 1]);
        }
        left[step] = work[0];
        right[count - step - 1] = work[count - step - 1];
    }
    flatten_segment(&left[..count], tolerance, level + 1, contour, total)?;
    flatten_segment(&right[..count], tolerance, level + 1, contour, total)
}

/// `project` returns the divided point and its homogeneous weight. An
/// elliptic arc carries an additional conic weight before the homography.
pub(crate) fn project_contours(
    path: &Path,
    tolerance: f64,
    project: impl Fn(Point) -> Result<(Point, f64), String>,
) -> Result<Vec<Contour>, String> {
    let weight = |point, curve_weight: f64| -> Result<WeightedPoint, String> {
        let (projected, denominator) = project(point)?;
        let denominator = denominator * curve_weight;
        if !denominator.is_finite() || denominator <= 0. {
            return Err("Invalid homogeneous curve weight".into());
        }
        Ok(WeightedPoint { numerator: projected * denominator, denominator })
    };
    let mut contours = Vec::new();
    let mut contour = Contour::default();
    let mut total = 0;
    let mut pen = Point::default();
    let mut start = pen;
    for command in &path.commands {
        match *command {
            Command::Move(p) => {
                if !contour.points.is_empty() {
                    contours.push(std::mem::take(&mut contour));
                }
                pen = p;
                start = p;
                push(&mut contour, &mut total, project(p)?.0)?;
            }
            Command::Line(p) => {
                pen = p;
                push(&mut contour, &mut total, project(p)?.0)?;
            }
            Command::Quad(c, p) => {
                let controls = [weight(pen, 1.)?, weight(c, 1.)?, weight(p, 1.)?];
                flatten_segment(&controls, tolerance, 0, &mut contour, &mut total)?;
                pen = p;
            }
            Command::Cubic(c, d, p) => {
                let controls = [weight(pen, 1.)?, weight(c, 1.)?, weight(d, 1.)?, weight(p, 1.)?];
                flatten_segment(&controls, tolerance, 0, &mut contour, &mut total)?;
                pen = p;
            }
            Command::Arc { center, radius, start, sweep } => {
                // A zero-radius corner occupies the point already written by
                // its adjacent edge. It has no conic to project.
                if radius.x == 0. && radius.y == 0. {
                    pen = center;
                    continue;
                }
                for (from, arc) in rational_arc(center, radius, start, sweep, std::f64::consts::FRAC_PI_2)? {
                    let controls = [weight(from, 1.)?, weight(arc.control, arc.weight)?, weight(arc.end, 1.)?];
                    flatten_segment(&controls, tolerance, 0, &mut contour, &mut total)?;
                    pen = arc.end;
                }
            }
            Command::SmoothCorner(_) => return Err("Projective soft corners require a Bézier outline".into()),
            Command::Close => {
                contour.closed = true;
                if contour.points.len() > 1 && (contour.points[0] - *contour.points.last().unwrap()).length() < 1e-12 {
                    contour.points.pop();
                }
                pen = start;
            }
        }
    }
    if !contour.points.is_empty() {
        contours.push(contour);
    }
    Ok(contours)
}
