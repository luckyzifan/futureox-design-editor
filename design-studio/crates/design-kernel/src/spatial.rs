//! Derive flat 3D planes in the ordinary render scene. The editor, history,
//! and FD keep the original 2D geometry and the authored effect parameters.
use crate::{
    math::{Point, Transform},
    path::Contour,
    scene::{Document, Node},
    spatial_curve::{PAGE_TOLERANCE, project_contours},
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
    #[serde(default, skip_serializing_if = "is_false")]
    pub preserve3d: bool,
}

fn is_false(value: &bool) -> bool { !*value }

impl SpatialEffects {
    pub(crate) fn validate(&self, node: &Node, schema: u32) -> Result<(), String> {
        if schema < 24 || (self.pose.is_none() && self.perspective.is_none() && !self.preserve3d) {
            return Err("Spatial effects require document schema 24".into());
        }
        if self.preserve3d && (schema < 25 || node.kind != "frame" || node.graphic) {
            return Err("Shared 3D space requires a frame and document schema 25".into());
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
pub(crate) struct Camera {
    pub(crate) distance: f64,
    pub(crate) center: Point,
    pub(crate) parent_to_scene: Transform,
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

pub(crate) fn sin_cos(degrees: f64) -> (f64, f64) {
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
    #[serde(skip_serializing_if = "is_false")]
    pub(crate) hide_fills: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vector_geometry: Option<VectorGeometry>,
}

fn corners(node: &Node) -> [Point; 4] {
    [Point::new(0., 0.), Point::new(node.width, 0.), Point::new(node.width, node.height), Point::new(0., node.height)]
}

fn project(node: &Node, pose: &Pose, camera: Option<Camera>, page_parent: Transform) -> Result<Projection, String> {
    let plane = Plane::new(node, pose);
    let affine = node.transform.concat(plane.xy);
    let fallback = Projection { transform: node.transform, visible: false, vector_geometry: None, hide_fills: false };
    if !node.visible { return Ok(fallback); }
    let basis = camera.map(|c| c.parent_to_scene.inverse()).transpose()?;
    let point = |p: Point| -> Result<(Point, f64), String> {
        let local = affine.point(p);
        let Some(c) = camera else { return Ok((local, 1.)) };
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
        Ok((p, w))
    };
    let projective = camera.is_some() && (plane.zx != 0. || plane.zy != 0.);
    let [tl, tr, br, bl] = corners(node);
    let [tl, tr, _br, bl] = [point(tl)?.0, point(tr)?.0, point(br)?.0, point(bl)?.0];
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
        return Ok(Projection { transform, visible: true, vector_geometry: None, hide_fills: false });
    }

    // The outline projects independently from the paint. Paints and styles
    // that need inverse projective sampling keep their explicit admission gate.
    if !matches!(node.kind.as_str(), "rectangle" | "ellipse" | "vector" | "polygon" | "star")
        || !node.children.is_empty() || node.mask || node.clip || node.path_offset != 0.
        || node.vector_brush.is_some() || node.repeat.is_some()
        || !node.bindings.is_empty() || !node.style_refs.is_empty()
        || node.fills.iter().any(|p| p.visible && p.kind != "solid")
        || node.strokes.iter().any(|s| s.visible && s.paint.visible && s.width > 0.)
        || node.effects.iter().any(|e| e.visible)
    {
        return Err("Tilt with perspective currently supports solid vector layers without enabled strokes or other effects".into());
    }
    let (path, _) = node.paths()?;
    let inverse = node.transform.inverse()?;
    let tolerance = PAGE_TOLERANCE / page_parent.max_scale().max(1.);
    let contours = project_contours(&path, tolerance, point)?;
    let geometry = outline_geometry(&contours, inverse, node.fill_even_odd())?;
    Ok(Projection { transform: node.transform, visible: true, vector_geometry: Some(geometry), hide_fills: false })
}

pub(crate) fn outline_geometry(contours: &[Contour], transform: Transform, even_odd: bool) -> Result<VectorGeometry, String> {
    let coords = |p| {
        let p = transform.point(p);
        [p.x, p.y]
    };
    let mut fill = Vec::new();
    for contour in contours {
        if let Some((first, rest)) = contour.points.split_first() {
            fill.push(Curve::Move(coords(*first)));
            fill.extend(rest.iter().map(|p| Curve::Line(coords(*p))));
            if contour.closed { fill.push(Curve::Close); }
        }
    }
    let geometry = VectorGeometry {
        fill_rule: if even_odd { "evenodd" } else { "nonzero" }.into(),
        fill,
        stroke: None,
        corner_source: None,
    };
    geometry.validate()?;
    Ok(geometry)
}

pub(crate) fn has_spatial(doc: &Document) -> bool {
    doc.schema_version >= 24 && doc.nodes.values().any(|n| n.spatial.is_some())
}

pub(crate) fn projections(doc: &Document) -> Result<BTreeMap<String, Projection>, String> {
    let mut result = BTreeMap::new();
    if !has_spatial(doc) { return Ok(result); }
    fn visit(doc: &Document, id: &str, camera: Option<Camera>, page_parent: Transform, result: &mut BTreeMap<String, Projection>) -> Result<(), String> {
        let node = &doc.nodes[id];
        let mut next = camera.map(|mut camera| {
            camera.parent_to_scene = camera.parent_to_scene.concat(node.transform);
            camera
        });
        if let Some(effects) = &node.spatial {
            let pose = effects.pose.filter(|pose| pose.visible);
            let own_camera = effects.perspective.filter(|camera| camera.visible).map(|camera| Camera {
                distance: camera.distance, center: Point::new(node.width / 2., node.height / 2.), parent_to_scene: Transform::default()
            });
            if effects.preserve3d {
                result.insert(id.to_owned(), Projection {
                    transform: node.transform, visible: node.visible, vector_geometry: None, hide_fills: true,
                });
                if node.visible {
                    result.extend(crate::spatial_depth::project_scene(doc, node, own_camera.or(next), page_parent.concat(node.transform), pose)?);
                }
                return Ok(());
            }
            let projection = match pose {
                Some(pose) => project(node, &pose, camera, page_parent)?,
                None => Projection { transform: node.transform, visible: node.visible, vector_geometry: None, hide_fills: false },
            };
            result.insert(id.to_owned(), projection);
            if pose.is_some() { next = None; }
            if own_camera.is_some() { next = own_camera; }
        }
        // A flat container is its own plane. Its child poses no longer see a
        // perspective above that plane unless it explicitly keeps them in 3D.
        if matches!(node.kind.as_str(), "frame" | "group") &&
            !node.spatial.as_ref().and_then(|spatial| spatial.perspective).is_some_and(|view| view.visible)
        {
            next = None;
        }
        let transform = result.get(id).map_or(node.transform, |patch| patch.transform);
        for child in &node.children { visit(doc, child, next, page_parent.concat(transform), result)?; }
        Ok(())
    }
    for page in &doc.pages {
        for id in &page.children { visit(doc, id, None, Transform::default(), &mut result)?; }
    }
    Ok(result)
}

pub(crate) fn resolve(doc: &mut Document) -> Result<(), String> {
    let patches = projections(doc)?;
    if patches.is_empty() { return Ok(()); }
    for (id, projection) in patches {
        let node = doc.nodes.get_mut(&id).unwrap();
        node.spatial = None;
        node.transform = projection.transform;
        node.visible = projection.visible;
        if projection.hide_fills {
            for paint in &mut node.fills { paint.visible = false; }
        }
        if let Some(geometry) = projection.vector_geometry {
            node.kind = "vector".into();
            node.network = None;
            node.vector_geometry = Some(Arc::new(geometry));
        }
    }
    // Hidden descendants do not need geometry patches. Their authoring
    // settings do not belong in the disposable render snapshot either.
    for node in doc.nodes.values_mut() {
        if node.spatial.is_some() { node.spatial = None; }
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
    fn perspective_rounding_preserves_source_geometry_and_rejects_the_near_plane() {
        let mut plane = fixture();
        plane["nodes"]["shape"]["spatial"]["pose"]["depth"] = json!(541);
        let mut engine = Engine::new();
        let near = engine.load_document(&plane.to_string()).unwrap_err();
        assert!(near.contains("near plane"), "{near}");
        let mut curved = fixture();
        curved["nodes"]["shape"]["radii"] = json!([12,12,12,12]);
        let options: RenderOptions = serde_json::from_value(json!({
            "pageId":"p","width":300,"height":200,"transparent":true,
            "view":{"x":0,"y":0,"zoom":1},
        })).unwrap();
        engine.load_document(&fixture().to_string()).unwrap();
        let sharp = engine.render(&options).unwrap();
        let doc: crate::scene::Document = serde_json::from_value(curved).unwrap();
        let before = serde_json::to_vec(&doc).unwrap();
        engine.load_document(std::str::from_utf8(&before).unwrap()).unwrap();
        let rounded = engine.render(&options).unwrap();
        assert_ne!(sharp, rounded);
        let pixel = |x: usize, y: usize| (y * 300 + x) * 4;
        // The unchanged center has the original paint. Within the former
        // top-left square corner white shows through the rounded silhouette.
        assert_eq!(&rounded[pixel(105, 109)..pixel(105, 109) + 4], &[217, 217, 217, 255]);
        assert!(rounded[pixel(59, 75)] > sharp[pixel(59, 75)]);
        assert_eq!(serde_json::to_vec(&doc).unwrap(), before);
        assert_eq!(doc.nodes["shape"].radii, [12.; 4]);
    }

    #[test]
    fn nested_space_resolves_intersecting_faces_and_backfaces_in_the_parent_perspective() {
        let mut doc = fixture();
        doc["schemaVersion"] = json!(25);
        doc["nodes"]["parent"]["fills"] = json!([]);
        doc["nodes"]["parent"]["children"] = json!(["space"]);
        doc["nodes"]["space"] = json!({
            "id": "space", "kind": "frame", "width": 300, "height": 200,
            "children": ["shape", "front"], "spatial": {"preserve3d": true},
        });
        doc["nodes"]["shape"]["transform"] = json!([1,0,0,1,100,70]);
        doc["nodes"]["shape"]["fills"] = json!([{"kind":"solid","color":"#e75252"}]);
        doc["nodes"]["shape"]["spatial"]["pose"] = json!({
            "rotateX":0,"rotateY":35,"rotateZ":0,"depth":0,"origin":[0.5,0.5],"visible":true,"backfaceVisible":true,
        });
        let mut front = doc["nodes"]["shape"].clone();
        front["id"] = json!("front");
        front["fills"] = json!([{"kind":"solid","color":"#427ff1"}]);
        front["spatial"]["pose"]["rotateY"] = json!(-35);
        doc["nodes"]["front"] = front;
        let options: RenderOptions = serde_json::from_value(json!({
            "pageId":"p","width":300,"height":200,"transparent":true,
            "view":{"x":0,"y":0,"zoom":1},
        })).unwrap();
        let render = |doc: &Value| {
            let mut engine = Engine::new();
            engine.load_document(&doc.to_string()).unwrap();
            engine.render(&options).unwrap()
        };
        let pixel = |bytes: &[u8], x: usize, y: usize| {
            let i = (y * 300 + x) * 4;
            [bytes[i], bytes[i+1], bytes[i+2], bytes[i+3]]
        };
        let left = [231,82,82,255];
        let right = [66,127,241,255];
        let shared = render(&doc);
        assert_eq!(pixel(&shared, 130, 99), left);
        assert_eq!(pixel(&shared, 170, 99), right);
        assert_eq!(pixel(&shared, 149, 99)[3], 255);
        assert_eq!(pixel(&shared, 150, 99)[3], 255);

        let mut flat = doc.clone();
        flat["nodes"]["space"].as_object_mut().unwrap().remove("spatial");
        let flat = render(&flat);
        assert_eq!(pixel(&flat, 130, 99), right);
        assert_eq!(pixel(&flat, 170, 99), right);
        // The inner flat frame removes the ancestor's perspective from its
        // child shapes, leaving the 82px foreshortened orthographic outline.
        assert_eq!(pixel(&flat, 107, 99)[3], 0);
        assert_eq!(pixel(&flat, 110, 99), right);

        doc["nodes"]["front"]["spatial"]["pose"]["rotateY"] = json!(180);
        doc["nodes"]["front"]["spatial"]["pose"]["backfaceVisible"] = json!(false);
        let backface = render(&doc);
        assert_eq!(pixel(&backface, 130, 99), left);
        assert_eq!(pixel(&backface, 170, 99), left);
    }

    #[test]
    fn keeping_nested_depth_hides_frame_fill_only_in_the_render_view() {
        let mut doc = fixture();
        doc["schemaVersion"] = json!(25);
        doc["nodes"]["parent"]["fills"][0]["color"] = json!("#202830");
        let mut engine = Engine::new();
        let opts = serde_json::from_value(json!({
            "pageId":"p","width":300,"height":200,"transparent":true,
            "view":{"x":0,"y":0,"zoom":1},
        })).unwrap();
        let flat = doc.to_string();
        doc["nodes"]["parent"]["spatial"]["preserve3d"] = json!(true);
        engine.load_document(&flat).unwrap();
        let initial = engine.render(&opts).unwrap();
        assert_eq!(&initial[..4], &[32, 40, 48, 255]);
        engine.load_document(&doc.to_string()).unwrap();
        let spatial = engine.render(&opts).unwrap();
        assert_eq!(&spatial[..4], &[0, 0, 0, 0]);
        engine.load_document(&flat).unwrap();
        assert_eq!(engine.render(&opts).unwrap(), initial);
    }
}
