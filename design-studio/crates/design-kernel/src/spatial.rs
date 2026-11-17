//! Derive flat 3D planes in the ordinary render scene. The editor, history,
//! and FD keep the original 2D geometry and the authored effect parameters.
use crate::{
    math::{Point, Transform},
    path::Command,
    scene::{Document, Node},
    vector_geometry::{Curve, VectorGeometry},
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pose {
    pub rotate_x: f64,
    pub rotate_y: f64,
    pub rotate_z: f64,
    pub depth: f64,
    pub origin: [f64; 2],
    pub backface_visible: bool,
    pub visible: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Perspective {
    pub distance: f64,
    pub visible: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpatialEffects {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pose: Option<Pose>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub perspective: Option<Perspective>,
}

impl SpatialEffects {
    pub(crate) fn validate(&self, node: &Node, schema: u32) -> Result<(), String> {
        if schema < 24 || (self.pose.is_none() && self.perspective.is_none()) {
            return Err("Spatial effects require document schema 24".into());
        }
        if let Some(pose) = self.pose {
            if matches!(node.kind.as_str(), "slice" | "section")
                || [pose.rotate_x, pose.rotate_y, pose.rotate_z].iter().any(|angle| !(-36_000. ..=36_000.).contains(angle))
                || !(-1e6..=1e6).contains(&pose.depth)
                || pose.origin.iter().any(|axis| !(0. ..=1.).contains(axis))
            {
                return Err("Invalid 3D transform parameters or layer type".into());
            }
        }
        if let Some(view) = self.perspective {
            if node.kind != "frame" || node.graphic || !(1. ..=1e7).contains(&view.distance) {
                return Err("Perspective requires a frame and a distance of 1–10000000".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct Camera {
    distance: f64,
    center: Point,
    parent_to_scene: Transform,
}

/// Coefficients of the 3D plane before the homogeneous divide. The local Z
/// rotation runs first, then Y, then X. Depth is along the parent's Z axis.
struct Plane {
    pivot: Point,
    xy: Transform,
    zx: f64,
    zy: f64,
    depth: f64,
}

fn sin_cos(degrees: f64) -> (f64, f64) {
    match degrees.rem_euclid(360.) {
        0. => (0., 1.),
        90. => (1., 0.),
        180. => (0., -1.),
        270. => (-1., 0.),
        angle => angle.to_radians().sin_cos(),
    }
}

impl Plane {
    fn new(node: &Node, pose: &Pose) -> Self {
        let (sx, cx) = sin_cos(pose.rotate_x);
        let (sy, cy) = sin_cos(pose.rotate_y);
        let (sz, cz) = sin_cos(pose.rotate_z);
        let x = node.width * pose.origin[0];
        let y = node.height * pose.origin[1];
        let a = cy * cz;
        let b = cx * sz + sx * sy * cz;
        let c = -cy * sz;
        let d = cx * cz - sx * sy * sz;
        Self {
            pivot: Point::new(x, y),
            xy: Transform([a, b, c, d, x - a * x - c * y, y - b * x - d * y]),
            zx: sx * sz - cx * sy * cz,
            zy: sx * cz + cx * sy * sz,
            depth: pose.depth,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Projection {
    pub(crate) transform: Transform,
    pub(crate) visible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vector_geometry: Option<VectorGeometry>,
}

fn corners(node: &Node) -> [Point; 4] {
    [Point::new(0., 0.), Point::new(node.width, 0.), Point::new(node.width, node.height), Point::new(0., node.height)]
}

fn project(node: &Node, pose: &Pose, camera: Option<Camera>) -> Result<Projection, String> {
    let plane = Plane::new(node, pose);
    let affine = node.transform.concat(plane.xy);
    let fallback = Projection { transform: node.transform, visible: false, vector_geometry: None };
    if !node.visible { return Ok(fallback); }
    let basis = camera.map(|c| c.parent_to_scene.inverse()).transpose()?;
    let point = |p: Point| -> Result<Point, String> {
        let local = affine.point(p);
        let Some(c) = camera else { return Ok(local) };
        let original = c.parent_to_scene.point(local);
        let depth = plane.depth + plane.zx * (p.x - plane.pivot.x) + plane.zy * (p.y - plane.pivot.y);
        let w = 1. - depth / c.distance;
        if !w.is_finite() || w < 1. / 32. {
            return Err("The layer crosses the perspective camera's near plane".into());
        }
        let projected = Point::new(c.center.x + (original.x - c.center.x) / w, c.center.y + (original.y - c.center.y) / w);
        let p = basis.unwrap().point(projected);
        if !p.x.is_finite() || !p.y.is_finite() || p.x.abs().max(p.y.abs()) > 1e7 {
            return Err("Perspective output exceeds the scene coordinate budget".into());
        }
        Ok(p)
    };
    let projective = camera.is_some() && (plane.zx != 0. || plane.zy != 0.);
    let [tl, tr, br, bl] = corners(node);
    let [tl, tr, _br, bl] = [point(tl)?, point(tr)?, point(br)?, point(bl)?];
    let area = (tr.x - tl.x) * (bl.y - tl.y) - (tr.y - tl.y) * (bl.x - tl.x);
    let [a, b, c, d, _, _] = node.transform.0;
    let normal = area / ((a * d - b * c) * node.width * node.height);
    if normal.abs() < 1e-12 || (!pose.backface_visible && normal < 0.) {
        return Ok(fallback);
    }
    if !projective {
        let transform = if camera.is_none() {
            affine
        } else {
            Transform([(tr.x - tl.x) / node.width, (tr.y - tl.y) / node.width,
                (bl.x - tl.x) / node.height, (bl.y - tl.y) / node.height, tl.x, tl.y])
        };
        return Ok(Projection { transform, visible: true, vector_geometry: None });
    }

    // A line under a homography stays a line. Only admit this exact vector
    // path when its paint needs no inverse projective sampling. Reject
    // unsupported content before committing instead of losing its appearance.
    if !matches!(node.kind.as_str(), "rectangle" | "vector" | "polygon" | "star")
        || !node.children.is_empty() || node.mask || node.clip || node.path_offset != 0.
        || node.vector_brush.is_some() || node.repeat.is_some()
        || !node.bindings.is_empty() || !node.style_refs.is_empty()
        || node.fills.iter().any(|p| p.visible && p.kind != "solid")
        || node.strokes.iter().any(|s| s.visible && s.paint.visible && s.width > 0.)
        || node.effects.iter().any(|e| e.visible)
    {
        return Err("Tilt with perspective currently supports straight, solid vector layers without enabled strokes or other effects".into());
    }
    let (path, _) = node.paths()?;
    let inverse = node.transform.inverse()?;
    let coords = |p| point(p).map(|p| { let p = inverse.point(p); [p.x, p.y] });
    let fill = path.commands.into_iter().map(|command| match command {
        Command::Move(p) => Ok(Curve::Move(coords(p)?)),
        Command::Line(p) => Ok(Curve::Line(coords(p)?)),
        Command::Close => Ok(Curve::Close),
        _ => Err("Tilt with perspective currently requires a straight vector outline".into()),
    }).collect::<Result<Vec<_>, String>>()?;
    let geometry = VectorGeometry {
        fill_rule: if node.fill_even_odd() { "evenodd" } else { "nonzero" }.into(),
        fill,
        stroke: None,
        corner_source: None,
    };
    geometry.validate()?;
    Ok(Projection { transform: node.transform, visible: true, vector_geometry: Some(geometry) })
}

pub(crate) fn has_spatial(doc: &Document) -> bool {
    doc.schema_version >= 24 && doc.nodes.values().any(|n| n.spatial.is_some())
}

pub(crate) fn projections(doc: &Document) -> Result<BTreeMap<String, Projection>, String> {
    let mut result = BTreeMap::new();
    if !has_spatial(doc) { return Ok(result); }
    fn visit(doc: &Document, id: &str, camera: Option<Camera>, result: &mut BTreeMap<String, Projection>) -> Result<(), String> {
        let node = &doc.nodes[id];
        let mut next = camera.map(|mut camera| {
            camera.parent_to_scene = camera.parent_to_scene.concat(node.transform);
            camera
        });
        if let Some(effects) = &node.spatial {
            let pose = effects.pose.filter(|pose| pose.visible);
            let projection = match pose {
                Some(pose) => project(node, &pose, camera)?,
                None => Projection { transform: node.transform, visible: node.visible, vector_geometry: None },
            };
            result.insert(id.to_owned(), projection);
            if pose.is_some() { next = None; }
            if let Some(camera) = effects.perspective.filter(|camera| camera.visible) {
                next = Some(Camera { distance: camera.distance, center: Point::new(node.width / 2., node.height / 2.), parent_to_scene: Transform::default() });
            }
        }
        for child in &node.children { visit(doc, child, next, result)?; }
        Ok(())
    }
    for page in &doc.pages {
        for id in &page.children { visit(doc, id, None, &mut result)?; }
    }
    Ok(result)
}

pub(crate) fn resolve(doc: &mut Document) -> Result<(), String> {
    for (id, projection) in projections(doc)? {
        let node = doc.nodes.get_mut(&id).unwrap();
        node.spatial = None;
        node.transform = projection.transform;
        node.visible = projection.visible;
        if let Some(geometry) = projection.vector_geometry {
            node.kind = "vector".into();
            node.network = None;
            node.vector_geometry = Some(Arc::new(geometry));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::renderer::{Engine, RenderOptions};
    use serde_json::{json, Value};

    fn fixture() -> Value {
        json!({
            "id": "spatial-oracle", "name": "Spatial effects", "schemaVersion": 24,
            "pages": [{"id":"p","name":"Page","children":["parent"],"background":"#ffffff"}],
            "nodes": {
                "parent": {"id":"parent","kind":"frame","width":300,"height":200,"children":["shape"],
                    "fills":[{"kind":"solid","color":"#ffffff"}],
                    "spatial":{"perspective":{"distance":540,"visible":true}}},
                "shape": {"id":"shape","kind":"rectangle","width":100,"height":60,"transform":[1,0,0,1,60,80],
                    "fills":[{"kind":"solid","color":"#d9d9d9"}],
                    "spatial":{"pose":{"rotateX":30,"rotateY":25,"rotateZ":0,"depth":40,
                        "origin":[0.5,0.5],"visible":true,"backfaceVisible":true}}}
            }
        })
    }

    #[test]
    fn exact_render_and_gpu_plan_match_an_independent_projected_quadrilateral() {
        let doc = fixture();
        let mut spatial = Engine::new();
        spatial.load_document(&doc.to_string()).unwrap();

        // Oracle constructed from four homogeneous corner projections for
        // the Figma fixture: rotation X30/Y25, Z depth 40, center of
        // perspective (150,100), distance 540. Coordinates are shape-local.
        let mut oracle = doc.clone();
        oracle["nodes"]["parent"].as_object_mut().unwrap().remove("spatial");
        let shape = oracle["nodes"]["shape"].as_object_mut().unwrap();
        shape.remove("spatial");
        shape.insert("kind".into(), json!("vector"));
        shape.insert("vectorGeometry".into(), json!({"fillRule":"evenodd","fill":[
            {"move":[-2.752771640693055,-8.860389382591933]},
            {"line":[95.38216903737631,14.516659450954108]},
            {"line":[95.70298187422136,69.94031927749359]},
            {"line":[-8.715022761203684,49.407032973625604]},
            "close"
        ]}));

        let json = json!({"pageId":"p","width":300,"height":200,"view":{"x":0,"y":0,"zoom":1},"transparent":true});
        let options: RenderOptions = serde_json::from_value(json.clone()).unwrap();
        let mut reference = Engine::new();
        reference.load_document(&oracle.to_string()).unwrap();
        let exact = spatial.render(&options).unwrap();
        assert_eq!(exact, reference.render(&options).unwrap());
        assert_eq!(
            spatial.compile_gpu_request(&json.to_string()).unwrap().into_packet().unwrap(),
            reference.compile_gpu_request(&json.to_string()).unwrap().into_packet().unwrap(),
        );

        let mut changed = doc.clone();
        changed["nodes"]["shape"]["spatial"]["pose"]["visible"] = json!(false);
        spatial.load_document(&changed.to_string()).unwrap();
        assert_ne!(exact, spatial.render(&options).unwrap());
        spatial.load_document(&doc.to_string()).unwrap();
        assert_eq!(exact, spatial.render(&options).unwrap());
    }

    #[test]
    fn spatial_validation_rejects_camera_crossing_and_unsupported_curve() {
        let mut plane = fixture();
        plane["nodes"]["shape"]["spatial"]["pose"]["depth"] = json!(541);
        let mut engine = Engine::new();
        let near = engine.load_document(&plane.to_string()).unwrap_err();
        assert!(near.contains("near plane"), "{near}");
        let mut curved = fixture();
        curved["nodes"]["shape"]["radii"] = json!([12,12,12,12]);
        let curve = engine.load_document(&curved.to_string()).unwrap_err();
        assert!(curve.contains("straight vector outline"), "{curve}");
    }
}
