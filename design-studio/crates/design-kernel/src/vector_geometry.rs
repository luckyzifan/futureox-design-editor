//! Serializable f64 render geometry, independent of the point-editing graph.
//! This is a facet of the existing Node, not a second scene or renderer. Source
//! curves are retained exactly; tessellation remains in the existing pipeline.
use crate::{
    math::Point,
    path::{Command, Path},
    scene::{Edge, Network, Vertex},
};
use serde::{Deserialize, Serialize};

pub const MAX_COMMANDS: usize = 131_072;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Curve {
    Move([f64; 2]),
    Line([f64; 2]),
    Quad([f64; 4]),
    Cubic([f64; 6]),
    Close,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VectorGeometry {
    pub fill_rule: String,
    pub fill: Vec<Curve>,
    /// None shares the fill curves; Some(empty) explicitly has no stroke.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<Vec<Curve>>,
}
fn point(p: [f64; 2]) -> Point {
    Point::new(p[0], p[1])
}
pub(crate) fn encode(path: &Path) -> Result<Vec<Curve>, String> {
    path.commands.iter().map(|command| Ok(match *command {
        Command::Move(p) => Curve::Move([p.x,p.y]),
        Command::Line(p) => Curve::Line([p.x,p.y]),
        Command::Quad(c,p) => Curve::Quad([c.x,c.y,p.x,p.y]),
        Command::Cubic(a,b,p) => Curve::Cubic([a.x,a.y,b.x,b.y,p.x,p.y]),
        Command::Close => Curve::Close,
        _ => return Err("Native arcs retain their parametric authoring; no implicit curve approximation".into()),
    })).collect()
}
fn decode(curves: &[Curve]) -> Path {
    Path {
        commands: curves
            .iter()
            .map(|curve| match *curve {
                Curve::Move(p) => Command::Move(point(p)),
                Curve::Line(p) => Command::Line(point(p)),
                Curve::Quad(p) => Command::Quad(point([p[0], p[1]]), point([p[2], p[3]])),
                Curve::Cubic(p) => Command::Cubic(
                    point([p[0], p[1]]),
                    point([p[2], p[3]]),
                    point([p[4], p[5]]),
                ),
                Curve::Close => Command::Close,
            })
            .collect(),
    }
}
impl VectorGeometry {
    /// Sketch contours already have an authored traversal. Preserve it directly
    /// instead of constructing face topology just to rediscover this ordering.
    pub fn ordered_network(network: &Network, closed: bool) -> Result<Self, String> {
        let count = network.vertices.len();
        if count > MAX_COMMANDS - 2
            || network.edges.len()
                != if closed {
                    count
                } else {
                    count.saturating_sub(1)
                }
        {
            return Err("Invalid ordered contour".into());
        }
        let mut path = Path::default();
        if let Some(first) = network.vertices.first() {
            path.commands.push(Command::Move(first.point()));
        }
        for (i, edge) in network.edges.iter().enumerate() {
            let from = &network.vertices[i];
            let to = &network.vertices[(i + 1) % count];
            if edge.from != from.id || edge.to != to.id {
                return Err("Contour traversal changed".into());
            }
            path.commands
                .push(if edge.c1.is_some() || edge.c2.is_some() {
                    Command::Cubic(
                        edge.c1.unwrap_or(from.point()),
                        edge.c2.unwrap_or(to.point()),
                        to.point(),
                    )
                } else {
                    Command::Line(to.point())
                });
        }
        if closed && count > 0 {
            path.commands.push(Command::Close);
        }
        let empty = Path::default();
        Self::from_paths(
            if closed { &path } else { &empty },
            &path,
            &network.fill_rule,
        )
    }
    pub fn from_paths(fill: &Path, stroke: &Path, rule: &str) -> Result<Self, String> {
        let fill = encode(fill)?;
        let line = encode(stroke)?;
        let value = Self {
            fill_rule: rule.into(),
            stroke: if fill == line { None } else { Some(line) },
            fill,
        };
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.fill_rule.as_str(), "evenodd" | "nonzero")
            || self
                .fill
                .len()
                .saturating_add(self.stroke.as_ref().map_or(0, Vec::len))
                > MAX_COMMANDS
        {
            return Err(
                "Vector render geometry exceeds its command allowance or has an invalid fill rule"
                    .into(),
            );
        }
        for (curves, fill) in [
            (&self.fill, true),
            (self.stroke.as_ref().unwrap_or(&self.fill), false),
        ] {
            let mut open = false;
            for curve in curves {
                let coords: &[f64] = match curve {
                    Curve::Move(p) => {
                        if fill && open {
                            return Err("Fill contours must close explicitly".into());
                        }
                        open = true;
                        p
                    }
                    Curve::Line(p) => p,
                    Curve::Quad(p) => p,
                    Curve::Cubic(p) => p,
                    Curve::Close => &[],
                };
                if !open || coords.iter().any(|v| !v.is_finite() || v.abs() > 1e7) {
                    return Err("Invalid vector render curve".into());
                }
                if matches!(curve, Curve::Close) {
                    open = false;
                }
            }
            if fill && open {
                return Err("Fill contours must close explicitly".into());
            }
        }
        Ok(())
    }
    pub fn paths(&self) -> Result<(Path, Path), String> {
        self.validate()?;
        Ok((
            decode(&self.fill),
            decode(self.stroke.as_ref().unwrap_or(&self.fill)),
        ))
    }
    pub fn scale(&mut self, sx: f64, sy: f64) {
        for curve in self.fill.iter_mut().chain(self.stroke.iter_mut().flatten()) {
            let values: &mut [f64] = match curve {
                Curve::Move(p) | Curve::Line(p) => p,
                Curve::Quad(p) => p,
                Curve::Cubic(p) => p,
                Curve::Close => continue,
            };
            for pair in values.chunks_exact_mut(2) {
                pair[0] *= sx;
                pair[1] *= sy;
            }
        }
    }
    /// Materialize only for explicit point editing or a bounded format encoder.
    /// No command is flattened or rounded. Independent fill/stroke topology must
    /// remain in its original representation instead of fabricating editable faces.
    pub fn network(&self, limit: usize) -> Result<Network, String> {
        self.validate()?;
        let curves = self.stroke.as_ref().unwrap_or(&self.fill);
        let mut network = Network {
            vertices: Vec::new(),
            edges: Vec::new(),
            fill_rule: self.fill_rule.clone(),
            filled_faces: None,
        };
        let mut start: Option<usize> = None;
        let mut at: Option<usize> = None;
        let mut closed = Vec::new();
        let mut contour = Vec::new();
        let add_vertex = |network: &mut Network, p: Point| {
            let index = network.vertices.len();
            network.vertices.push(Vertex {
                id: format!("v{index}"),
                x: p.x,
                y: p.y,
            });
            index
        };
        for curve in curves {
            if network.vertices.len() > limit || network.edges.len() > limit * 2 {
                return Err("Point editing working set exceeded; retain render geometry and edit a smaller source object".into());
            }
            match *curve {
                Curve::Move(p) => {
                    contour.clear();
                    contour.push(curve.clone());
                    let index = add_vertex(&mut network, point(p));
                    start = Some(index);
                    at = Some(index);
                }
                Curve::Close => {
                    let from = at.ok_or("Missing contour start")?;
                    let to = start.unwrap();
                    if from != to {
                        network.edges.push(Edge {
                            id: format!("e{}", network.edges.len()),
                            from: format!("v{from}"),
                            to: format!("v{to}"),
                            c1: None,
                            c2: None,
                        });
                    }
                    contour.push(Curve::Close);
                    closed.append(&mut contour);
                    at = None;
                }
                _ => {
                    contour.push(curve.clone());
                    let from = at.ok_or("Missing contour start")?;
                    let a = network.vertices[from].point();
                    let (end, c1, c2) = match *curve {
                        Curve::Line(p) => (point(p), None, None),
                        Curve::Cubic(p) => (
                            point([p[4], p[5]]),
                            Some(point([p[0], p[1]])),
                            Some(point([p[2], p[3]])),
                        ),
                        Curve::Quad(p) => {
                            let c = point([p[0], p[1]]);
                            let end = point([p[2], p[3]]);
                            (
                                end,
                                Some(a + (c - a) * (2. / 3.)),
                                Some(end + (c - end) * (2. / 3.)),
                            )
                        }
                        _ => unreachable!(),
                    };
                    let first = &network.vertices[start.unwrap()];
                    let to = if end.x.to_bits() == first.x.to_bits()
                        && end.y.to_bits() == first.y.to_bits()
                    {
                        start.unwrap()
                    } else {
                        add_vertex(&mut network, end)
                    };
                    network.edges.push(Edge {
                        id: format!("e{}", network.edges.len()),
                        from: format!("v{from}"),
                        to: format!("v{to}"),
                        c1,
                        c2,
                    });
                    at = Some(to);
                }
            }
        }
        if network.vertices.len() > limit || network.edges.len() > limit * 2 {
            return Err("Point editing working set exceeded".into());
        }
        if self.fill != closed {
            return Err("Independent fill geometry requires its own source editing session".into());
        }
        Ok(network)
    }
}
