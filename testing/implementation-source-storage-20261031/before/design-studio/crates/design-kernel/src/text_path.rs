//! Glyphs remain rigid Bézier outlines placed along a shared arc-length table.
use crate::{
    math::{Point, Transform},
    path::{Command, Path},
    scene::Network,
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextPath {
    pub network: Network,
    #[serde(default)]
    pub offset: f64,
    #[serde(default)]
    pub normal: f64,
    #[serde(default)]
    pub reverse: bool,
}
pub struct Baseline {
    points: Vec<Point>,
    lengths: Vec<f64>,
    pub length: f64,
}
impl Baseline {
    pub fn new(binding: &TextPath) -> Result<Self, String> {
        if !binding.offset.is_finite()
            || !binding.normal.is_finite()
            || binding.offset.abs() > 1e7
            || binding.normal.abs() > 1e7
            || binding.network.vertices.len() > 10000
            || binding.network.edges.len() > 10000
        {
            return Err("Invalid text path".into());
        }
        let (_, path) = binding.network.paths()?;
        let contours = path.flatten(Transform::default(), 0.0001)?;
        if contours.len() != 1 || contours[0].points.len() < 2 {
            return Err("Text requires one continuous path".into());
        }
        let mut points = contours[0].points.clone();
        if contours[0].closed {
            points.push(points[0])
        }
        if binding.reverse {
            points.reverse()
        }
        let mut lengths = vec![0.];
        for pair in points.windows(2) {
            lengths.push(lengths.last().unwrap() + (pair[1] - pair[0]).length())
        }
        let length = *lengths.last().unwrap();
        if length < 1e-9 {
            return Err("Text path is empty".into());
        }
        Ok(Self {
            points,
            lengths,
            length,
        })
    }
    pub fn pose(&self, distance: f64, normal: f64) -> Transform {
        let at = distance.clamp(0., self.length);
        let i = self
            .lengths
            .partition_point(|v| *v < at)
            .clamp(1, self.lengths.len() - 1);
        let a = self.points[i - 1];
        let b = self.points[i];
        let length = (b - a).length().max(1e-12);
        let tangent = (b - a) * (1. / length);
        let point =
            a + tangent * (at - self.lengths[i - 1]) + Point::new(-tangent.y, tangent.x) * normal;
        Transform([
            tangent.x, tangent.y, -tangent.y, tangent.x, point.x, point.y,
        ])
    }
}
pub fn transform_outline(path: &mut Path, m: Transform) {
    for command in &mut path.commands {
        match command {
            Command::Move(p) | Command::Line(p) => *p = m.point(*p),
            Command::Quad(a, b) => {
                *a = m.point(*a);
                *b = m.point(*b)
            }
            Command::Cubic(a, b, c) => {
                *a = m.point(*a);
                *b = m.point(*b);
                *c = m.point(*c)
            }
            Command::Close => {}
            _ => {}
        }
    }
}
