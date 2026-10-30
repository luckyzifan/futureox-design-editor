//! Interactive vector tools retain authored cubic segments; no raster preview geometry.
use crate::{
    math::Point,
    scene::{Edge, Network, Vertex},
};
use serde::{Deserialize, Serialize};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub network: Network,
    pub point: Point,
    pub action: String,
    #[serde(default)]
    pub edge: Option<String>,
    #[serde(default)]
    pub delta: Point,
    #[serde(default)]
    pub parameter: Option<f64>,
    #[serde(default)]
    pub nonce: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultData {
    pub network: Network,
    pub edge: String,
    pub parameter: f64,
    pub distance: f64,
}
fn controls(g: &Network, e: &Edge) -> Result<[Point; 4], String> {
    let v = |id: &str| {
        g.vertices
            .iter()
            .find(|v| v.id == id)
            .map(|v| Point::new(v.x, v.y))
            .ok_or("Missing vertex".to_string())
    };
    let a = v(&e.from)?;
    let b = v(&e.to)?;
    Ok(if e.c1.is_none() && e.c2.is_none() {
        [a, a.lerp(b, 1. / 3.), a.lerp(b, 2. / 3.), b]
    } else {
        [a, e.c1.unwrap_or(a), e.c2.unwrap_or(b), b]
    })
}
fn at(c: [Point; 4], t: f64) -> Point {
    let s = 1. - t;
    c[0] * (s * s * s) + c[1] * (3. * s * s * t) + c[2] * (3. * s * t * t) + c[3] * (t * t * t)
}
fn nearest(c: [Point; 4], p: Point) -> (f64, f64) {
    let mut t = 0.;
    let mut best = f64::INFINITY;
    for i in 0..=64 {
        let x = i as f64 / 64.;
        let d = (at(c, x) - p).length();
        if d < best {
            best = d;
            t = x
        }
    }
    let mut lo = (t - 1. / 64.).max(0.);
    let mut hi = (t + 1. / 64.).min(1.);
    for _ in 0..32 {
        let a = lo + (hi - lo) / 3.;
        let b = hi - (hi - lo) / 3.;
        if (at(c, a) - p).length() < (at(c, b) - p).length() {
            hi = b
        } else {
            lo = a
        }
    }
    t = (lo + hi) / 2.;
    (t, (at(c, t) - p).length())
}
pub fn apply(mut r: Request) -> Result<ResultData, String> {
    if !r.point.finite()
        || !r.delta.finite()
        || r.network.edges.len() > 10000
        || r.network.vertices.len() > 10000
        || r.network.edges.is_empty()
        || r.nonce.len() > 100
    {
        return Err("Invalid vector tool input".into());
    }
    r.network.paths()?;
    let mut chosen = None;
    for (i, e) in r.network.edges.iter().enumerate() {
        if r.edge.as_ref().is_some_and(|id| id != &e.id) {
            continue;
        }
        let c = controls(&r.network, e)?;
        let (t, d) = nearest(c, r.point);
        if chosen.is_none_or(|(_, _, best): (usize, f64, f64)| d < best) {
            chosen = Some((i, t, d))
        }
    }
    let (i, nearest_t, distance) = chosen.ok_or("No vector segment")?;
    let parameter = r.parameter.unwrap_or(nearest_t);
    if !parameter.is_finite() || !(0. ..=1.).contains(&parameter) {
        return Err("Invalid curve parameter".into());
    }
    let e = r.network.edges[i].clone();
    let c = controls(&r.network, &e)?;
    match r.action.as_str() {
        "nearest" => {}
        "bend" => {
            let t = parameter.clamp(0.01, 0.99);
            let shift = r.delta * (1. / (3. * t * (1. - t)));
            let edge = &mut r.network.edges[i];
            edge.c1 = Some(c[1] + shift);
            edge.c2 = Some(c[2] + shift);
        }
        "cut" => {
            if !(0.000001..0.999999).contains(&parameter) {
                return Err("Cut inside a segment".into());
            }
            let t = parameter;
            let a = c[0].lerp(c[1], t);
            let b = c[1].lerp(c[2], t);
            let d = c[2].lerp(c[3], t);
            let ab = a.lerp(b, t);
            let bd = b.lerp(d, t);
            let mid = ab.lerp(bd, t);
            let v1 = format!("{}:a", r.nonce);
            let v2 = format!("{}:b", r.nonce);
            let edge = format!("{}:edge", r.nonce);
            if r.nonce.is_empty()
                || r.network.vertices.iter().any(|v| v.id == v1 || v.id == v2)
                || r.network.edges.iter().any(|e| e.id == edge)
            {
                return Err("Cut identity collision".into());
            }
            r.network.vertices.extend([
                Vertex {
                    id: v1.clone(),
                    x: mid.x,
                    y: mid.y,
                },
                Vertex {
                    id: v2.clone(),
                    x: mid.x,
                    y: mid.y,
                },
            ]);
            let curve = e.c1.is_some() || e.c2.is_some();
            r.network.edges[i] = Edge {
                id: e.id.clone(),
                from: e.from,
                to: v1,
                c1: curve.then_some(a),
                c2: curve.then_some(ab),
            };
            r.network.edges.push(Edge {
                id: edge,
                from: v2,
                to: e.to,
                c1: curve.then_some(bd),
                c2: curve.then_some(d),
            });
        }
        _ => return Err("Unknown vector tool action".into()),
    }
    r.network.paths()?;
    Ok(ResultData {
        network: r.network,
        edge: e.id,
        parameter,
        distance,
    })
}

pub fn fill_region(
    mut network: Network,
    point: Point,
    initially_filled: bool,
) -> Result<Network, String> {
    if !point.finite() || network.edges.len() > 10000 || network.vertices.len() > 10000 {
        return Err("Invalid fill selection".into());
    }
    let faces = network.faces()?;
    let mut hits = Vec::new();
    for (key, path) in &faces {
        let contours = path.flatten(crate::math::Transform::default(), 0.001)?;
        if crate::path::winding(point, &contours) != 0 {
            hits.push((
                key.clone(),
                contours
                    .iter()
                    .map(|c| crate::path::area(&c.points).abs())
                    .sum::<f64>(),
            ))
        }
    }
    hits.sort_by(|a, b| a.1.total_cmp(&b.1));
    let key = hits
        .first()
        .map(|h| h.0.clone())
        .ok_or("Click a closed vector region")?;
    let mut selected = network.filled_faces.take().unwrap_or_else(|| {
        if initially_filled {
            faces.into_iter().map(|f| f.0).collect()
        } else {
            vec![]
        }
    });
    if let Some(i) = selected.iter().position(|f| {
        let mut f = f.clone();
        f.sort();
        f == key
    }) {
        selected.remove(i);
    } else {
        selected.push(key)
    }
    network.filled_faces = Some(selected);
    Ok(network)
}

/// Translate selected vertices and their incident control points exactly once.
pub fn translate_vertices(
    mut network: Network,
    ids: &[String],
    delta: Point,
) -> Result<Network, String> {
    use std::collections::HashSet;
    if !delta.finite()
        || ids.len() > 10000
        || network.vertices.len() > 10000
        || network.edges.len() > 10000
    {
        return Err("Invalid vertex translation".into());
    }
    let selected: HashSet<_> = ids.iter().map(String::as_str).collect();
    if selected
        .iter()
        .any(|id| !network.vertices.iter().any(|v| v.id == *id))
    {
        return Err("Unknown selected vertex".into());
    }
    for v in &mut network.vertices {
        if selected.contains(v.id.as_str()) {
            v.x += delta.x;
            v.y += delta.y
        }
    }
    for e in &mut network.edges {
        if selected.contains(e.from.as_str())
            && let Some(p) = &mut e.c1
        {
            *p = *p + delta
        }
        if selected.contains(e.to.as_str())
            && let Some(p) = &mut e.c2
        {
            *p = *p + delta
        }
    }
    if network
        .vertices
        .iter()
        .any(|v| !v.x.is_finite() || !v.y.is_finite() || v.x.abs() > 1e7 || v.y.abs() > 1e7)
        || network
            .edges
            .iter()
            .flat_map(|e| [e.c1, e.c2])
            .flatten()
            .any(|p| !p.finite() || p.x.abs() > 1e7 || p.y.abs() > 1e7)
    {
        return Err("Vertex translation exceeds coordinate budget".into());
    }
    network.paths()?;
    Ok(network)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn request(action: &str) -> Request {
        Request {
            network: Network {
                vertices: vec![
                    Vertex {
                        id: "a".into(),
                        x: 0.,
                        y: 0.,
                    },
                    Vertex {
                        id: "b".into(),
                        x: 100.,
                        y: 0.,
                    },
                ],
                edges: vec![Edge {
                    id: "e".into(),
                    from: "a".into(),
                    to: "b".into(),
                    c1: None,
                    c2: None,
                }],
                filled_faces: None,
                fill_rule: "evenodd".into(),
            },
            point: Point::new(50., 0.),
            action: action.into(),
            edge: None,
            delta: Point::new(0., 30.),
            parameter: Some(0.5),
            nonce: "cut".into(),
        }
    }
    #[test]
    fn bend_moves_point_and_retains_endpoints() {
        let out = apply(request("bend")).unwrap();
        let c = controls(&out.network, &out.network.edges[0]).unwrap();
        assert!((at(c, 0.5) - Point::new(50., 30.)).length() < 1e-9);
        assert_eq!(c[0], Point::new(0., 0.));
        assert_eq!(c[3], Point::new(100., 0.));
    }
    #[test]
    fn cut_cubic_retains_the_curve_exactly() {
        let mut r = request("cut");
        r.network.edges[0].c1 = Some(Point::new(10., 80.));
        r.network.edges[0].c2 = Some(Point::new(80., -40.));
        let original = controls(&r.network, &r.network.edges[0]).unwrap();
        let out = apply(r).unwrap();
        assert_eq!(out.network.vertices.len(), 4);
        let a = controls(&out.network, &out.network.edges[0]).unwrap();
        let b = controls(&out.network, &out.network.edges[1]).unwrap();
        for i in 0..=100 {
            let t = i as f64 / 100.;
            let p = if t <= 0.5 {
                at(a, t * 2.)
            } else {
                at(b, (t - 0.5) * 2.)
            };
            assert!((p - at(original, t)).length() < 1e-10)
        }
    }
}
