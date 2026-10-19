//! Curve graph Boolean operations. Cubic segments remain cubic after clipping.
//! Uses flo_curves' Bézier clipping/intersection graph; signed winding is selected
//! per operand, including self intersections and coincident contours.
use crate::{
    boolean::Operation,
    math::{Point, Transform},
    path::{Command, Path},
    scene::{Document, Edge, Network, Vertex},
};
use flo_curves::{Coord2, bezier::path::*};

pub fn curves(path: &Path, m: Transform) -> Result<Vec<SimpleBezierPath>, String> {
    let mut out = Vec::new();
    let mut parts = Vec::new();
    let mut start = Point::default();
    let mut pen = start;
    let c = |p: Point| {
        let p = m.point(p);
        Coord2(p.x, p.y)
    };
    for cmd in &path.commands {
        match *cmd {
            Command::Move(p) => {
                if !parts.is_empty() {
                    return Err("Boolean operands must be closed".into());
                }
                start = p;
                pen = p;
            }
            Command::Line(p) => {
                parts.push((c(pen.lerp(p, 1. / 3.)), c(pen.lerp(p, 2. / 3.)), c(p)));
                pen = p;
            }
            Command::Quad(q, p) => {
                parts.push((c(pen.lerp(q, 2. / 3.)), c(p.lerp(q, 2. / 3.)), c(p)));
                pen = p;
            }
            Command::Cubic(a, b, p) => {
                parts.push((c(a), c(b), c(p)));
                pen = p;
            }
            Command::Arc {
                center,
                radius,
                start: a,
                sweep,
            } => {
                // flo_curves only accepts polynomial cubics: the exact conic
                // decomposition happens first, the bounded `to_cubic`
                // downgrade is the final step at this engine boundary.
                let pieces = crate::path::rational_arc(
                    center,
                    radius,
                    a,
                    sweep,
                    std::f64::consts::FRAC_PI_4,
                )?;
                if pieces.is_empty() {
                    let end = center + Point::new(radius.x * a.cos(), radius.y * a.sin());
                    parts.push((c(end), c(end), c(end)));
                    pen = end;
                }
                for (from, piece) in pieces {
                    let (b1, b2, end) = piece.to_cubic(from);
                    parts.push((c(b1), c(b2), c(end)));
                    pen = end;
                }
            }
            Command::SmoothCorner(corner) => {
                // Preserve the pre-existing polygon approximation at the curve
                // Boolean boundary; flo_curves has no superellipse primitive.
                for p in corner.legacy_points() {
                    parts.push((c(pen.lerp(p, 1. / 3.)), c(pen.lerp(p, 2. / 3.)), c(p)));
                    pen = p;
                }
            }
            Command::Close => {
                if (pen - start).length() > 1e-10 {
                    parts.push((
                        c(pen.lerp(start, 1. / 3.)),
                        c(pen.lerp(start, 2. / 3.)),
                        c(start),
                    ));
                }
                if !parts.is_empty() {
                    out.push((c(start), std::mem::take(&mut parts)));
                }
                pen = start;
            }
        }
    }
    if !parts.is_empty() {
        return Err("Boolean operands must be closed".into());
    }
    Ok(out)
}
pub fn network(paths: Vec<SimpleBezierPath>) -> Network {
    let mut g = Network {
        vertices: vec![],
        edges: vec![],
        filled_faces: None,
        fill_rule: "evenodd".into(),
    };
    for (start, segments) in paths {
        if segments.is_empty() {
            continue;
        }
        let base = g.vertices.len();
        g.vertices.push(Vertex {
            id: base.to_string(),
            x: start.0,
            y: start.1,
        });
        for (i, (a, b, p)) in segments.iter().enumerate() {
            let last = i + 1 == segments.len() && (p.0 - start.0).hypot(p.1 - start.1) < 0.01;
            let to = if last { base } else { g.vertices.len() };
            if !last {
                g.vertices.push(Vertex {
                    id: to.to_string(),
                    x: p.0,
                    y: p.1,
                });
            }
            g.edges.push(Edge {
                id: g.edges.len().to_string(),
                from: (base + i).to_string(),
                to: to.to_string(),
                c1: Some(Point::new(a.0, a.1)),
                c2: Some(Point::new(b.0, b.1)),
            });
        }
    }
    g
}
pub fn combine(inputs: &[(Path, Transform, bool)], op: Operation) -> Result<Network, String> {
    if inputs.is_empty() || inputs.len() > 64 {
        return Err("Select 1–64 curve operands".into());
    }
    let paths = inputs
        .iter()
        .map(|(p, m, _)| curves(p, *m))
        .collect::<Result<Vec<_>, _>>()?;
    let edges: usize = paths.iter().flatten().map(|p| p.1.len()).sum();
    // Real native compound masks contain several thousand authored segments.
    // Keep the 64-operand and 10000-output caps; no unbounded admission.
    if edges > 8192 {
        return Err("Curve Boolean exceeds 8192 source segments; split the operation".into());
    }
    if edges == 0 {
        return Ok(network(vec![]));
    }
    let accuracy = 0.001;
    let mut graph = GraphPath::new();
    for (i, p) in paths.iter().enumerate() {
        let mut operand = GraphPath::from_merged_paths(p.iter().map(|p| (p, PathLabel(i as u32))));
        // Operand self-intersections are split before cross-operand clipping.
        operand.self_collide(accuracy);
        graph = if i == 0 {
            graph.merge(operand)
        } else {
            graph.collide(operand, accuracy)
        };
    }
    graph.round(accuracy);
    graph.set_edge_kinds_by_ray_casting(|counts| {
        let filled: Vec<_> = inputs
            .iter()
            .enumerate()
            .map(|(i, (_, _, evenodd))| {
                let w = counts.get(i).copied().unwrap_or(0);
                if *evenodd { w.abs() % 2 != 0 } else { w != 0 }
            })
            .collect();
        match op {
            Operation::Union => filled.iter().any(|v| *v),
            Operation::Subtract => filled[0] && !filled[1..].iter().any(|v| *v),
            Operation::Intersect => filled.iter().all(|v| *v),
            Operation::Exclude => filled.iter().filter(|v| **v).count() % 2 != 0,
        }
    });
    graph.heal_exterior_gaps();
    let result: Vec<SimpleBezierPath> = graph.exterior_paths();
    if result.iter().map(|p| p.1.len()).sum::<usize>() > 10000 {
        return Err("Curve Boolean output budget exceeded".into());
    }
    Ok(network(result))
}
pub fn resolve(doc: &mut Document) -> Result<(), String> { resolve_cached(doc, true) }
fn resolve_cached(doc: &mut Document, memoize: bool) -> Result<(), String> {
    fn visit(doc: &mut Document, id: &str, depth: usize, cache: &mut crate::curve_boolean_cache::Cache, memoize: bool) -> Result<(), String> {
        if depth > 64 {
            return Err("Boolean depth exceeded".into());
        }
        let children = doc.nodes[id].children.clone();
        for child in &children {
            visit(doc, child, depth + 1, cache, memoize)?;
        }
        if let Some(op) = doc.nodes[id].boolean_operation {
            let inputs = children
                .iter()
                .filter(|c| doc.nodes[*c].visible)
                .map(|c| {
                    let n = &doc.nodes[c];
                    Ok((
                        n.paths()?.0,
                        n.transform,
                        n.network.as_ref().is_none_or(|g| g.fill_rule == "evenodd"),
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?;
            let g = if inputs.is_empty() {
                network(vec![])
            } else {
                let key = crate::curve_boolean_cache::Cache::key(&inputs, op);
                if let Some(cached) = memoize.then(|| cache.get(&key)).flatten() { cached } else {
                    let result = combine(&inputs, op).map_err(|e| format!("Boolean node {id}: {e}"))?;
                    if memoize { cache.insert(key, &result); } result
                }
            };
            doc.nodes.get_mut(id).unwrap().network = Some(g);
        }
        Ok(())
    }
    let roots: Vec<_> = doc.pages.iter().flat_map(|p| p.children.clone()).collect();
    let mut cache = crate::curve_boolean_cache::Cache::default();
    for id in roots {
        visit(doc, &id, 0, &mut cache, memoize)?;
    }
    Ok(())
}

#[cfg(test)]
mod memo_tests {
    use super::*;
    #[test]
    fn repeated_boolean_geometry_matches_uncached_resolution() {
        let mut nodes=serde_json::Map::new();let mut roots=Vec::new();
        for i in 0..32 {
            let id=format!("b{i}");let a=format!("a{i}");let b=format!("c{i}");roots.push(id.clone());
            nodes.insert(id.clone(),serde_json::json!({"id":id,"kind":"group","width":80,"height":80,"booleanOperation": (["union","subtract","intersect","exclude"][i%4]),"children":[a,b]}));
            for (id,x) in [(a,0.),(b,20.125)] {nodes.insert(id.clone(),serde_json::json!({"id":id,"kind":"ellipse","width":48,"height":48,"transform":[1,0,0,1,x,0]}));}
        }
        let mut fast:Document=serde_json::from_value(serde_json::json!({"schemaVersion":5,"id":"d","name":"memo","pages":[{"id":"p","name":"p","background":"#ffffff","children":roots}],"nodes":nodes})).unwrap();
        let mut reference=fast.clone();resolve_cached(&mut fast,true).unwrap();resolve_cached(&mut reference,false).unwrap();
        assert_eq!(serde_json::to_vec(&fast).unwrap(),serde_json::to_vec(&reference).unwrap());
    }
}
