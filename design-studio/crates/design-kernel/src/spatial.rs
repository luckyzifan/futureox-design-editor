//! Derive flat 3D planes in the ordinary render scene. The editor, history,
//! and FD keep the original 2D geometry and the authored effect parameters.
use crate::{
    math::{Point, Transform},
    path::Contour,
    scene::{Document, Node},
    spatial_curve::{PAGE_TOLERANCE, project_contours},
    spatial_material::{self, Appearance, INTERSECTION_BUDGET, MaterialPlane},
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
    #[serde(skip_serializing_if = "is_false")]
    pub(crate) hide_strokes: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub(crate) composed: bool,
    #[serde(skip)]
    pub(crate) appearances: Vec<Appearance>,
    #[serde(skip)]
    pub(crate) inset_colors: Option<([u8; 3], [u8; 3])>,
}

impl Projection {
    pub(crate) fn new(transform: Transform, visible: bool) -> Self {
        Self { transform, visible, hide_fills: false, vector_geometry: None,
            hide_strokes: false, composed: false, appearances: Vec::new(), inset_colors: None }
    }
}

fn corners(node: &Node) -> [Point; 4] {
    [Point::new(0., 0.), Point::new(node.width, 0.), Point::new(node.width, node.height), Point::new(0., node.height)]
}

fn project(node: &Node, pose: &Pose, camera: Option<Camera>, page_parent: Transform, color_managed: bool) -> Result<Projection, String> {
    let plane = Plane::new(node, pose);
    let affine = node.transform.concat(plane.xy);
    let fallback = Projection::new(node.transform, false);
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
        return Ok(Projection::new(transform, true));
    }

    // The outline projects independently from the paint. Paints and styles
    // that need inverse projective sampling keep their explicit admission gate.
    if !matches!(node.kind.as_str(), "rectangle" | "ellipse" | "vector" | "polygon" | "star")
        || !node.children.is_empty() || node.mask || node.clip || node.path_offset != 0.
        || node.vector_brush.is_some() || node.repeat.is_some()
        || !node.bindings.is_empty() || !node.style_refs.is_empty()
        || node.fills.iter().any(|p| p.visible && p.kind != "solid")
        || node.effects.iter().any(|e| e.visible)
    {
        return Err("Tilt with perspective requires solid vector layers without other enabled effects".into());
    }
    let inverse = node.transform.inverse()?;
    let tolerance = PAGE_TOLERANCE / page_parent.max_scale().max(1.);
    let mut patch=Projection::new(node.transform,true);
    if spatial_material::has_strokes(node) {
        if color_managed || node.blend != "normal" {
            return Err("Projected strokes require normal SDR compositing".into());
        }
        let mut remaining=INTERSECTION_BUDGET;
        let (outline,paints)=spatial_material::materials(node,tolerance,point,&mut remaining)?;
        let planes=[MaterialPlane { paints:&paints, depth:crate::spatial_depth::PlaneDepth([0.;3]),opacity:node.opacity }];
        patch.vector_geometry=Some(outline_geometry(&outline.contours,inverse,outline.even_odd)?);
        patch.appearances=spatial_material::appearances(&planes,inverse,&mut remaining)?;
        patch.inset_colors = spatial_material::inset_colors(node, &patch.appearances);
        patch.composed=true;
        patch.hide_strokes=true;
        patch.visible=!patch.appearances.is_empty();
    } else {
        let contours = project_contours(&node.paths()?.0, tolerance, point)?;
        patch.vector_geometry=Some(outline_geometry(&contours,inverse,node.fill_even_odd())?);
    }
    Ok(patch)
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
                let mut patch=Projection::new(node.transform,node.visible);
                patch.hide_fills=true;
                result.insert(id.to_owned(), patch);
                if node.visible {
                    result.extend(crate::spatial_depth::project_scene(doc, node, own_camera.or(next), page_parent.concat(node.transform), pose)?);
                }
                return Ok(());
            }
            let projection = match pose {
                Some(pose) => project(node, &pose, camera, page_parent, doc.color_management.is_some())?,
                None => Projection::new(node.transform,node.visible),
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
    apply_projection(doc, patches)
}

fn apply_projection(doc: &mut Document, patches: BTreeMap<String, Projection>) -> Result<(), String> {
    if patches.is_empty() { return Ok(()); }
    let mut assembled=Vec::new();
    for (id, projection) in patches {
        if projection.composed {
            assembled.push((id.clone(), projection.appearances, projection.inset_colors));
        }
        let node = doc.nodes.get_mut(&id).unwrap();
        node.spatial = None;
        node.transform = projection.transform;
        node.visible = projection.visible;
        if projection.hide_fills {
            for paint in &mut node.fills { paint.visible = false; }
        }
        if projection.hide_strokes { node.strokes.clear(); }
        if let Some(geometry) = projection.vector_geometry {
            node.kind = "vector".into();
            node.network = None;
            node.vector_geometry = Some(Arc::new(geometry));
        }
    }
    let extra=assembled.iter().map(|(_,cells,_)|cells.len()).sum::<usize>();
    crate::capacity::check_document_counts(doc.nodes.len().checked_add(extra).ok_or("Projected node count overflow")?,doc.pages.len())?;
    let mut serial=0;
    for (id,cells,inset_colors) in assembled {
        let old_children=doc.nodes[&id].children.clone();
        for child in old_children { doc.nodes.get_mut(&child).unwrap().visible=false; }
        let mut children=Vec::new();
        let mut inset_stroke = None;
        for cell in cells {
            let cell_id=loop {
                serial+=1;
                let candidate=format!("spatial-cell-{serial}");
                if !doc.nodes.contains_key(&candidate) { break candidate; }
            };
            if let Some((fill, stroke)) = inset_colors
                && cell.rgb == fill
            {
                inset_stroke = Some(Box::new(spatial_material::InsetStroke {
                    interior: cell_id.clone(),
                    fill,
                    stroke,
                }));
            }
            let mut node=crate::facet::sample_node(&cell_id,"vector");
            node.blend="plus-lighter".into();
            node.locked=true;
            node.vector_geometry=Some(Arc::new(cell.geometry));
            node.fills.push(crate::scene::Paint {
                transform:None,id:String::new(),kind:"solid".into(),
                color:format!("#{:02x}{:02x}{:02x}",cell.rgb[0],cell.rgb[1],cell.rgb[2]),
                opacity:f64::from(cell.alpha)/255.,visible:true,angle:0.,stops:Vec::new(),image:None,
                fit:"cover".into(),blend:"normal".into(),adjust:None,tile:None,
            });
            children.push(cell_id.clone());
            doc.nodes.insert(cell_id,node);
        }
        let parent=doc.nodes.get_mut(&id).unwrap();
        if parent.kind!="frame" { parent.kind="group".into(); }
        parent.vector_geometry=None;
        parent.network=None;
        parent.fills.clear();
        parent.strokes.clear();
        parent.opacity=1.;
        parent.blend="normal".into();
        parent.projected_inset_stroke = inset_stroke;
        parent.children.extend(children);
    }
    // Hidden descendants do not need geometry patches. Their authoring
    // settings do not belong in the disposable render snapshot either.
    for node in doc.nodes.values_mut() {
        if node.spatial.is_some() { node.spatial = None; }
    }
    Ok(())
}

/// Selection exports retain the spatial ancestors but compose only the
/// selected paint. Filtering the resolved cells by source ID would discard
/// the selected face when it is represented by its parent's coverage cells.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn export_view(
    doc: &mut Document,
    selected: &[String],
    refine_inset_stroke: bool,
) -> Result<serde_json::Value, String> {
    if !selected.is_empty() {
        let selected=selected.iter().map(String::as_str).collect::<std::collections::HashSet<_>>();
        fn visit(doc: &mut Document, id: &str, selected: &std::collections::HashSet<&str>, within: bool) -> bool {
            let within=within || selected.contains(id);
            let children=doc.nodes[id].children.clone();
            let mut keep=within;
            for child in children { keep |= visit(doc,&child,selected,within); }
            let n=doc.nodes.get_mut(id).unwrap();
            if !keep { n.visible=false; }
            if keep && !within {
                n.fills.clear();
                n.strokes.clear();
                n.effects.clear();
                n.clip=false;
                n.opacity=1.;
            }
            keep
        }
        let roots=doc.pages.iter().flat_map(|p|p.children.iter().cloned()).collect::<Vec<_>>();
        for root in roots { visit(doc,&root,&selected,false); }
    }
    let patches=projections(doc)?;
    let outlines=serde_json::to_value(&patches).map_err(|e|e.to_string())?;
    // The PNG renderer regenerates the ephemeral coverage data at export
    // time. Keep its scoped source geometry across the worker's JSON boundary.
    if !refine_inset_stroke || !patches.values().any(|patch| patch.inset_colors.is_some()) {
        apply_projection(doc,patches)?;
    }
    // The caller has already resolved layout. Generated material nodes are
    // positioned in the same frame, so layout must not arrange them again.
    for n in doc.nodes.values_mut() {
        n.layout=None;
        n.sizing=None;
        n.constraints=None;
        n.component=None;
        n.component_set=false;
        n.component_key=None;
        n.instance=None;
        n.instance_origin=None;
    }
    Ok(outlines)
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

    fn colored_planes() -> Value {
        let mut doc=fixture();
        doc["schemaVersion"]=json!(25);
        doc["nodes"]["parent"]["spatial"]["preserve3d"]=json!(true);
        doc["nodes"]["parent"]["fills"]=json!([]);
        doc["nodes"]["parent"]["children"]=json!(["shape","blue"]);
        let red=&mut doc["nodes"]["shape"];
        red["transform"]=json!([1,0,0,1,100,70]);
        red["fills"]=json!([{"kind":"solid","color":"#e75252"}]);
        red["spatial"]["pose"]["rotateX"]=json!(0);
        red["spatial"]["pose"]["rotateY"]=json!(35);
        red["spatial"]["pose"]["depth"]=json!(0);
        let mut blue=red.clone();
        blue["id"]=json!("blue");
        blue["fills"][0]["color"]=json!("#427ff1");
        blue["spatial"]["pose"]["rotateY"]=json!(-35);
        doc["nodes"]["blue"]=blue;
        doc
    }

    fn spatial_render(doc: &Value) -> Vec<u8> {
        let options=serde_json::from_value(json!({
            "pageId":"p","width":300,"height":200,"transparent":true,
            "view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figma",
        })).unwrap();
        let mut engine=Engine::new();
        engine.load_document(&doc.to_string()).unwrap();
        engine.render(&options).unwrap()
    }

    fn pixel(bytes: &[u8], x: usize, y: usize) -> [u8;4] {
        bytes[(y*300+x)*4..(y*300+x)*4+4].try_into().unwrap()
    }

    #[test]
    fn translucent_faces_preserve_both_paints_at_the_local_depth_order() {
        let mut doc=colored_planes();
        doc["nodes"]["shape"]["opacity"]=json!(0.5);
        doc["nodes"]["blue"]["opacity"]=json!(0.5);
        let image=spatial_render(&doc);
        // Native Figma 126.11.9 in a transparent frame, sampled well
        // within a covered cell on opposite sides of the intersection.
        assert_eq!(pixel(&image,130,100),[175,97,134,192]);
        assert_eq!(pixel(&image,170,100),[121,112,187,192]);
        doc["nodes"]["shape"]["transform"][4]=json!(100.25);
        doc["nodes"]["blue"]["transform"][4]=json!(100.25);
        let fractional=spatial_render(&doc);
        for x in 148..153 {
            assert!((i16::from(pixel(&fractional,x,100)[3])-192).abs()<=1);
        }
        doc["pages"][0]["children"]=json!(["behind","parent"]);
        doc["nodes"]["behind"]=json!({"id":"behind","kind":"rectangle","width":300,"height":200,
            "fills":[{"kind":"solid","color":"#202830"}]});
        assert_eq!(pixel(&spatial_render(&doc),130,100),[140,83,113,255]);
    }

    #[test]
    fn scoped_export_of_a_translucent_face_keeps_its_full_projected_paint() {
        let mut source=colored_planes();
        source["nodes"]["shape"]["opacity"]=json!(0.5);
        source["nodes"]["blue"]["opacity"]=json!(0.5);
        let mut selected:crate::scene::Document=serde_json::from_value(source.clone()).unwrap();
        selected.validate().unwrap();
        let outlines=super::export_view(&mut selected, &["blue".into()], false).unwrap();
        assert!(outlines["blue"]["vectorGeometry"].is_object());
        selected.validate().unwrap();
        let raster=spatial_render(&serde_json::to_value(selected).unwrap());
        assert_eq!(pixel(&raster,130,100),[66,128,241,128]);
        assert_eq!(pixel(&raster,170,100),[66,128,241,128]);
    }

    fn stroked_plane() -> Value {
        let mut doc = colored_planes();
        doc["nodes"]["blue"]["opacity"] = json!(0);
        doc["nodes"]["shape"]["strokes"] = json!([
            {"id":"stroke","width":4,"align":"inside","join":"miter","paint":{"kind":"solid","color":"#000000"}}
        ]);
        doc
    }

    #[test]
    fn inner_stroke_projects_with_the_authored_plane() {
        let mut doc = stroked_plane();
        let shared=spatial_render(&doc);
        assert_eq!(pixel(&shared,108,99),[0,0,0,255]);
        assert_eq!(pixel(&shared,150,99),[231,82,82,255]);
        doc["nodes"]["parent"]["spatial"]["preserve3d"]=json!(false);
        assert_eq!(spatial_render(&doc),shared);
        assert_eq!(doc["nodes"]["shape"]["strokes"][0]["width"],json!(4));
    }

    #[test]
    fn projected_inset_stroke_improves_native_edge_samples_without_changing_alpha() {
        let source = stroked_plane();
        let render_selection = |refine| {
            let mut doc: crate::scene::Document = serde_json::from_value(source.clone()).unwrap();
            super::export_view(&mut doc, &["parent".into()], refine).unwrap();
            let view = serde_json::to_value(doc).unwrap();
            assert_eq!(view["nodes"]["shape"]["spatial"].is_object(), refine);
            spatial_render(&view)
        };
        let binary = render_selection(false);
        let refined = render_selection(true);
        for (x, y, native) in [(148, 73, [21, 8, 8, 255]), (151, 125, [211, 75, 75, 255])] {
            let error = |image: &[u8]| {
                pixel(image, x, y).into_iter().zip(native).map(|(a, b)| a.abs_diff(b)).max().unwrap()
            };
            assert!(error(&binary) >= 20);
            assert!(error(&refined) <= 8, "edge at {x},{y}: {:?}", pixel(&refined, x, y));
        }
        assert!(refined.iter().skip(3).step_by(4).eq(binary.iter().skip(3).step_by(4)));
        assert_eq!(pixel(&refined, 108, 99), [0, 0, 0, 255]);
        assert_eq!(pixel(&refined, 150, 99), [231, 82, 82, 255]);
    }

    #[test]
    fn a_nested_projection_keeps_depth_through_both_lenses() {
        let mut doc=colored_planes();
        doc["nodes"]["blue"]["opacity"]=json!(0);
        doc["nodes"]["parent"]["children"]=json!(["frame","blue"]);
        doc["nodes"]["frame"]=json!({
            "id":"frame","kind":"frame","width":100,"height":60,"transform":[1,0,0,1,100,70],"children":["shape"],
            "spatial":{"preserve3d":true,"perspective":{"distance":300,"visible":true},
                "pose":{"rotateX":20,"rotateY":0,"rotateZ":0,"depth":20,
                    "origin":[0.5,0.5],"visible":true,"backfaceVisible":true}},
        });
        doc["nodes"]["shape"]["transform"]=json!([1,0,0,1,0,0]);
        let bytes=spatial_render(&doc);
        let mut min=[300,200];
        let mut max=[0,0];
        for y in 0..200 {
            for x in 0..300 {
                if pixel(&bytes,x,y)[3]>=128 {
                    min=[min[0].min(x),min[1].min(y)];
                    max=[max[0].max(x+1),max[1].max(y+1)];
                }
            }
        }
        assert_eq!((min,max),([99,55],[188,135]));
    }
}
