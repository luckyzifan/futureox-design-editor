//! Attached connector geometry is resolved with the document's layout in Rust.
use crate::{
    math::{Point, Transform},
    scene::{Document, Edge, Network, Vertex},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Endpoint {
    pub point: Point,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<Point>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connector {
    pub from: Endpoint,
    pub to: Endpoint,
    pub style: String,
}
pub fn validate(doc: &Document) -> Result<(), String> {
    for n in doc.nodes.values() {
        if let Some(c) = &n.connector {
            if doc.schema_version < 10
                || n.kind != "vector"
                || !matches!(c.style.as_str(), "straight" | "elbow")
                || !n.children.is_empty()
            {
                return Err("Invalid connector".into());
            }
            for e in [&c.from, &c.to] {
                if !e.point.finite() || e.point.x.abs() > 1e7 || e.point.y.abs() > 1e7 {
                    return Err("Invalid connector point".into());
                }
                if let Some(id) = &e.node_id
                    && (id == &n.id
                        || doc
                            .nodes
                            .get(id)
                            .is_none_or(|n| n.connector.is_some() || n.kind == "slice")
                        || e.anchor.is_none_or(|p| {
                            !p.finite() || !(0. ..=1.).contains(&p.x) || !(0. ..=1.).contains(&p.y)
                        }))
                {
                    return Err("Invalid connector attachment".into());
                }
            }
        }
    }
    Ok(())
}
pub fn resolve(doc: &mut Document) -> Result<(), String> {
    if !doc.nodes.values().any(|n| n.connector.is_some()) {
        return Ok(());
    }
    let mut transforms = BTreeMap::new();
    fn visit(doc: &Document, id: &str, parent: Transform, out: &mut BTreeMap<String, Transform>) {
        let n = &doc.nodes[id];
        let world = parent.concat(n.transform);
        out.insert(id.into(), world);
        for id in &n.children {
            visit(doc, id, world, out)
        }
    }
    for p in &doc.pages {
        for id in &p.children {
            visit(doc, id, Transform::default(), &mut transforms)
        }
    }
    let mut parents = BTreeMap::new();
    for n in doc.nodes.values() {
        for id in &n.children {
            parents.insert(id.clone(), n.id.clone());
        }
    }
    let ids: Vec<_> = doc
        .nodes
        .values()
        .filter(|n| n.connector.is_some())
        .map(|n| n.id.clone())
        .collect();
    for id in ids {
        let c = doc.nodes[&id].connector.as_ref().unwrap().clone();
        let endpoint = |e: &Endpoint| -> Point {
            if let Some(n) = e.node_id.as_ref().and_then(|id| doc.nodes.get(id)) {
                let a = e.anchor.unwrap();
                transforms[&n.id].point(Point::new(n.width * a.x, n.height * a.y))
            } else {
                e.point
            }
        };
        let a = endpoint(&c.from);
        let b = endpoint(&c.to);
        let mut points = vec![a];
        if c.style == "elbow" {
            let horizontal = |e: &Endpoint| e.anchor.is_none_or(|p| p.x == 0. || p.x == 1.);
            match (horizontal(&c.from), horizontal(&c.to)) {
                (true, true) => {
                    let x = (a.x + b.x) / 2.;
                    points.extend([Point::new(x, a.y), Point::new(x, b.y)]);
                }
                (false, false) => {
                    let y = (a.y + b.y) / 2.;
                    points.extend([Point::new(a.x, y), Point::new(b.x, y)]);
                }
                (true, false) => points.push(Point::new(b.x, a.y)),
                (false, true) => points.push(Point::new(a.x, b.y)),
            }
        }
        points.push(b);
        points.dedup_by(|a, b| (*a - *b).length() < 1e-9);
        if points.len() < 2 {
            points.push(Point::new(a.x + 0.01, a.y))
        }
        let parent = parents.get(&id).map(|p| transforms[p]).unwrap_or_default();
        let local = parent.inverse()?;
        let mut points: Vec<_> = points.into_iter().map(|p| local.point(p)).collect();
        let x = points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
        let y = points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
        let width = (points.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max) - x).max(0.01);
        let height = (points.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max) - y).max(0.01);
        for p in &mut points {
            p.x -= x;
            p.y -= y
        }
        let n = doc.nodes.get_mut(&id).unwrap();
        n.transform = Transform([1., 0., 0., 1., x, y]);
        n.width = width;
        n.height = height;
        n.network = Some(Network {
            vertices: points
                .iter()
                .enumerate()
                .map(|(i, p)| Vertex {
                    id: format!("v{i}"),
                    x: p.x,
                    y: p.y,
                })
                .collect(),
            edges: (0..points.len() - 1)
                .map(|i| Edge {
                    id: format!("e{i}"),
                    from: format!("v{i}"),
                    to: format!("v{}", i + 1),
                    c1: None,
                    c2: None,
                })
                .collect(),
            fill_rule: "nonzero".into(),
            filled_faces: None,
        });
        let binding = n.connector.as_mut().unwrap();
        binding.from.point = a;
        binding.to.point = b;
    }
    Ok(())
}
