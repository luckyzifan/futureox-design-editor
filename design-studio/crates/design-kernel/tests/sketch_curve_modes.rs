//! Integration coverage for 22 号字典 §1 (P0-1): Sketch `curveMode` 0–4 ↔
//! kernel network c1/c2 handles, plus per-point `cornerRadius` round-tripping
//! through `bindings["sketchPointCornerRadii"]`.

use futureox_design_kernel::{
    facet::sample_node,
    interop::{export_sketch, import_sketch, read_zip_public},
    math::{Point, Transform},
    scene::{Document, Edge, Network, Page, Vertex},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

fn vertex(i: usize, x: f64, y: f64) -> Vertex {
    Vertex {
        id: format!("v{i}"),
        x,
        y,
    }
}

/// Closed ring: edge i runs v{i} → v{i+1 mod n}; `handles[i]` is that edge's
/// (c1, c2) — c1 is vertex i's outgoing handle, c2 vertex i+1's incoming one.
fn ring(anchors: &[(f64, f64)], handles: &[(Option<Point>, Option<Point>)]) -> Network {
    let n = anchors.len();
    assert_eq!(handles.len(), n);
    Network {
        filled_faces: None,
        vertices: anchors
            .iter()
            .enumerate()
            .map(|(i, &(x, y))| vertex(i, x, y))
            .collect(),
        edges: (0..n)
            .map(|i| Edge {
                id: format!("e{i}"),
                from: format!("v{i}"),
                to: format!("v{}", (i + 1) % n),
                c1: handles[i].0,
                c2: handles[i].1,
            })
            .collect(),
        fill_rule: "nonzero".into(),
    }
}

fn kernel_doc(net: Network) -> Document {
    let mut doc = Document {
        reviews: Vec::new(),
        design_system: None,
        prototype: None,
        fd_compatibility: None,
        schema_version: 1,
        color_management: None,
        raster_profile: None,
        id: "d1".into(),
        name: "CurveModes".into(),
        pages: vec![Page {
            guides: vec![],
            id: "p1".into(),
            name: "Page 1".into(),
            children: vec!["n1".into()],
            background: "#ffffff".into(),
        }],
        nodes: BTreeMap::new(),
        fonts: BTreeMap::new(),
        animations: Vec::new(),
    };
    let mut page = sample_node("p1", "page");
    page.children = vec!["n1".into()];
    let mut path = sample_node("n1", "path");
    path.name = "Path".into();
    path.width = 100.;
    path.height = 100.;
    path.transform = Transform([1., 0., 0., 1., 0., 0.]);
    path.network = Some(net);
    doc.nodes.insert("p1".into(), page);
    doc.nodes.insert("n1".into(), path);
    doc
}

/// Minimal but structurally real native .sketch container: meta.json +
/// document.json + one page holding a single shapePath with the given
/// curvePoint dicts (22 号字典 §1 string coordinates).
fn native_sketch(points: Value) -> Vec<u8> {
    let page_ref = "AAAAAAAA-0000-0000-0000-000000000001";
    let page = json!({
        "_class": "page", "name": "Page 1",
        "layers": [{
            "_class": "shapePath", "name": "Path",
            "do_objectID": "BBBBBBBB-0000-0000-0000-000000000002",
            "frame": {"_class": "rect", "x": 0., "y": 0., "width": 100., "height": 100.},
            "points": points
        }]
    });
    let entries: Vec<(String, Vec<u8>)> = vec![
        (
            "meta.json".into(),
            serde_json::to_vec(&json!({"appVersion": 101})).unwrap(),
        ),
        (
            "document.json".into(),
            serde_json::to_vec(&json!({
                "_class": "document",
                "pages": [{"_class": "MSJSONFileReference",
                           "_ref_class": "MSImmutablePage",
                           "_ref": format!("pages/{page_ref}")}]
            }))
            .unwrap(),
        ),
        (format!("pages/{page_ref}.json"), serde_json::to_vec(&page).unwrap()),
    ];
    let mut sink = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut sink);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            zip.start_file(name, options).unwrap();
            std::io::Write::write_all(&mut zip, &data).unwrap();
        }
        zip.finish().unwrap();
    }
    sink.into_inner()
}

fn import_network(points: Value) -> futureox_design_kernel::scene::Node {
    let doc = import_sketch(&native_sketch(points)).expect("import");
    doc.nodes
        .into_values()
        .find(|n| n.kind == "path")
        .expect("path node")
}

/// Parse a Sketch point, accepting both the native "{x, y}" string form and
/// the `{"_class":"point","x":..,"y":..}` dict our exporter writes.
fn pt(v: &Value) -> (f64, f64) {
    if let Some(s) = v.as_str() {
        let inner = s.trim_matches(|c| c == '{' || c == '}');
        let mut parts = inner.split(',');
        let x = parts.next().unwrap().trim().parse().unwrap();
        let y = parts.next().unwrap().trim().parse().unwrap();
        (x, y)
    } else {
        (
            v["x"].as_f64().unwrap(),
            v["y"].as_f64().unwrap(),
        )
    }
}

fn assert_pt(actual: Option<Point>, x: f64, y: f64, what: &str) {
    let p = actual.unwrap_or_else(|| panic!("{what} must exist"));
    assert!(
        (p.x - x).abs() < 1e-9 && (p.y - y).abs() < 1e-9,
        "{what}: got ({}, {}), want ({x}, {y})",
        p.x,
        p.y
    );
}

fn exported_shape_points(doc: &Document) -> Vec<Value> {
    let bytes = export_sketch(doc).expect("export");
    let files = read_zip_public(&bytes).expect("zip");
    let name = files
        .keys()
        .find(|n| n.starts_with("pages/"))
        .unwrap()
        .clone();
    let page: Value = serde_json::from_slice(&files[&name]).unwrap();
    page["layers"][0]["points"]
        .as_array()
        .expect("points")
        .clone()
}

// ---------------------------------------------------------------------------
// import: curveMode semantics (22 号字典 §1)
// ---------------------------------------------------------------------------

#[test]
fn import_none_and_straight_ignore_stored_handles() {
    // Modes 0 (None) and 1 (Straight, also the default when the key is
    // absent) mean c1/c2 = None even when the file still archives handle
    // values for the point.
    let node = import_network(json!([
        {"_class":"curvePoint","point":"{0, 0}","curveFrom":"{0.3, 0.3}",
         "curveTo":"{-0.3, -0.3}","hasCurveFrom":true,"hasCurveTo":true,
         "curveMode":0,"cornerRadius":0.0},
        // curveMode key absent → defaults to 1 (Straight)
        {"_class":"curvePoint","point":"{1, 0}","curveFrom":"{1.3, 0.3}",
         "curveTo":"{0.7, -0.3}","hasCurveFrom":true,"hasCurveTo":true,
         "cornerRadius":0.0},
        {"_class":"curvePoint","point":"{1, 1}","curveFrom":"{1.3, 1.3}",
         "curveTo":"{0.7, 0.7}","hasCurveFrom":true,"hasCurveTo":true,
         "curveMode":1,"cornerRadius":0.0},
        // Disconnected control point proves the ring itself keeps handles.
        {"_class":"curvePoint","point":"{0, 1}","curveFrom":"{0.2, 1.1}",
         "curveTo":"{-0.2, 0.9}","hasCurveFrom":true,"hasCurveTo":true,
         "curveMode":3,"cornerRadius":0.0}
    ]));
    let net = node.network.as_ref().expect("network");
    assert_eq!(net.vertices.len(), 4);
    assert_eq!(net.edges.len(), 4);
    // edge i takes c1 from point[i].curveFrom and c2 from point[i+1].curveTo
    for (i, e) in net.edges.iter().enumerate() {
        if i == 3 {
            continue;
        }
        assert!(e.c1.is_none(), "edge {i} c1 must be dropped");
    }
    // incoming handles of points 0..=2 are dropped; edge 3 ends at point 0
    for e in [&net.edges[0], &net.edges[1], &net.edges[3]] {
        assert!(e.c2.is_none(), "edge c2 into a straight point must be dropped");
    }
    assert_pt(net.edges[3].c1, 0.2, 1.1, "control outgoing");
    assert_pt(net.edges[2].c2, -0.2, 0.9, "control incoming");
}

#[test]
fn import_mirrored_derives_missing_side() {
    // Mode 2 (Mirrored): c2 = vertex + (vertex − c1). With only one side
    // stored, the other derives from the mirror formula.
    let node = import_network(json!([
        {"_class":"curvePoint","point":"{0, 0}","curveFrom":"{0, 0}",
         "curveTo":"{0, 0}","hasCurveFrom":false,"hasCurveTo":false,
         "curveMode":1,"cornerRadius":0.0},
        // only curveTo stored → curveFrom derives as 2*v − curveTo
        {"_class":"curvePoint","point":"{1, 0}","curveFrom":"{1, 0}",
         "curveTo":"{0.8, 0.2}","hasCurveFrom":false,"hasCurveTo":true,
         "curveMode":2,"cornerRadius":0.0},
        // only curveFrom stored → curveTo derives as 2*v − curveFrom
        {"_class":"curvePoint","point":"{1, 1}","curveFrom":"{1.2, 1.2}",
         "curveTo":"{1, 1}","hasCurveFrom":true,"hasCurveTo":false,
         "curveMode":2,"cornerRadius":0.0},
        {"_class":"curvePoint","point":"{0, 1}","curveFrom":"{0, 1}",
         "curveTo":"{0, 1}","hasCurveFrom":false,"hasCurveTo":false,
         "curveMode":1,"cornerRadius":0.0}
    ]));
    let net = node.network.as_ref().expect("network");
    // vertex 1: stored incoming handle, derived outgoing mirror
    assert_pt(net.edges[0].c2, 0.8, 0.2, "v1 stored curveTo");
    assert_pt(net.edges[1].c1, 1.2, -0.2, "v1 derived curveFrom");
    // vertex 2: stored outgoing handle, derived incoming mirror
    assert_pt(net.edges[2].c1, 1.2, 1.2, "v2 stored curveFrom");
    assert_pt(net.edges[1].c2, 0.8, 0.8, "v2 derived curveTo");
}

#[test]
fn import_mirrored_with_both_sides_uses_stored_handles() {
    // Mode 2 with both handles archived keeps them as read (the mirror
    // relation is Sketch's editing constraint, not re-derived on import).
    let node = import_network(json!([
        {"_class":"curvePoint","point":"{0, 0}","curveFrom":"{0, 0}",
         "curveTo":"{0, 0}","hasCurveFrom":false,"hasCurveTo":false,
         "curveMode":1,"cornerRadius":0.0},
        {"_class":"curvePoint","point":"{1, 0}","curveFrom":"{1.3, 0.1}",
         "curveTo":"{0.8, 0.0}","hasCurveFrom":true,"hasCurveTo":true,
         "curveMode":2,"cornerRadius":0.0},
        {"_class":"curvePoint","point":"{1, 1}","curveFrom":"{1, 1}",
         "curveTo":"{1, 1}","hasCurveFrom":false,"hasCurveTo":false,
         "curveMode":1,"cornerRadius":0.0}
    ]));
    let net = node.network.as_ref().expect("network");
    assert_pt(net.edges[1].c1, 1.3, 0.1, "stored curveFrom");
    assert_pt(net.edges[0].c2, 0.8, 0.0, "stored curveTo");
}

#[test]
fn import_disconnected_and_asymmetric_keep_handles_verbatim() {
    // Mode 3 (Disconnected) and 4 (Asymmetric): both sides stay independent;
    // Asymmetric's collinearity constraint is not modeled by the kernel, so
    // it materializes into two independent handles too.
    let node = import_network(json!([
        {"_class":"curvePoint","point":"{0, 0}","curveFrom":"{0, 0}",
         "curveTo":"{0, 0}","hasCurveFrom":false,"hasCurveTo":false,
         "curveMode":1,"cornerRadius":0.0},
        {"_class":"curvePoint","point":"{1, 0}","curveFrom":"{1.2, 0.1}",
         "curveTo":"{0.9, -0.2}","hasCurveFrom":true,"hasCurveTo":true,
         "curveMode":3,"cornerRadius":0.0},
        {"_class":"curvePoint","point":"{1, 1}","curveFrom":"{1.3, 1.0}",
         "curveTo":"{0.9, 1.0}","hasCurveFrom":true,"hasCurveTo":true,
         "curveMode":4,"cornerRadius":0.0}
    ]));
    let net = node.network.as_ref().expect("network");
    assert_pt(net.edges[1].c1, 1.2, 0.1, "disconnected curveFrom");
    assert_pt(net.edges[0].c2, 0.9, -0.2, "disconnected curveTo");
    assert_pt(net.edges[2].c1, 1.3, 1.0, "asymmetric curveFrom");
    assert_pt(net.edges[1].c2, 0.9, 1.0, "asymmetric curveTo");
}

// ---------------------------------------------------------------------------
// import: per-point cornerRadius → bindings + explicit lossy note
// ---------------------------------------------------------------------------

#[test]
fn import_corner_radius_rides_bindings_with_lossy_note() {
    let node = import_network(json!([
        {"_class":"curvePoint","point":"{0, 0}","curveFrom":"{0, 0}",
         "curveTo":"{0, 0}","hasCurveFrom":false,"hasCurveTo":false,
         "curveMode":1,"cornerRadius":2.0},
        {"_class":"curvePoint","point":"{1, 0}","curveFrom":"{1, 0}",
         "curveTo":"{1, 0}","hasCurveFrom":false,"hasCurveTo":false,
         "curveMode":1,"cornerRadius":0.0},
        {"_class":"curvePoint","point":"{1, 1}","curveFrom":"{1, 1}",
         "curveTo":"{1, 1}","hasCurveFrom":false,"hasCurveTo":false,
         "curveMode":1,"cornerRadius":0.5}
    ]));
    let radii: Vec<f64> = serde_json::from_str(
        node.bindings
            .get("sketchPointCornerRadii")
            .expect("corner radii binding"),
    )
    .unwrap();
    assert_eq!(radii, vec![2.0, 0.0, 0.5]);
    // The kernel has no per-vertex radius slot; the degradation must be
    // reported, not silently dropped.
    let lossy = node
        .bindings
        .get("sketchImportLossy")
        .expect("import lossy note");
    assert!(
        lossy.contains("corner-radius"),
        "corner radius degradation must be reported, got {lossy}"
    );
}

#[test]
fn export_restores_corner_radius_from_bindings() {
    let mut doc = kernel_doc(ring(
        &[(0., 0.), (1., 0.), (1., 1.)],
        &[(None, None), (None, None), (None, None)],
    ));
    doc.nodes
        .get_mut("n1")
        .unwrap()
        .bindings
        .insert("sketchPointCornerRadii".into(), "[2.0,0.0,0.5]".into());
    let points = exported_shape_points(&doc);
    let radii: Vec<f64> = points
        .iter()
        .map(|p| p["cornerRadius"].as_f64().unwrap())
        .collect();
    assert_eq!(radii, vec![2.0, 0.0, 0.5]);
}

// ---------------------------------------------------------------------------
// export: curveMode derived from handle geometry
// ---------------------------------------------------------------------------

#[test]
fn export_derives_curve_mode_from_handle_geometry() {
    // Per 22 号字典 §1 export rule: no handles → 1; both handles collinear
    // with the vertex → 2 when equally long, 4 otherwise; a single handle or
    // a non-collinear pair → 3.
    let net = ring(
        &[(0., 0.), (1., 0.), (1., 1.), (0., 1.), (-0.5, 0.5)],
        &[
            // edge 0: v0 → v1, c2 is v1's incoming mirror half
            (None, Some(Point::new(0.8, 0.))),
            // edge 1: v1 outgoing mirror half; c2 is v2's asymmetric incoming
            (Some(Point::new(1.2, 0.)), Some(Point::new(0.9, 1.))),
            // edge 2: v2 outgoing (len 0.3 vs incoming 0.1); c2 into v3
            (Some(Point::new(1.3, 1.)), Some(Point::new(0., 0.9))),
            // edge 3: v3 outgoing breaks collinearity; no c2 into v4
            (Some(Point::new(0.2, 1.1)), None),
            // edge 4: v4 outgoing only; no c2 into v0
            (Some(Point::new(-0.3, 0.5)), None),
        ],
    );
    let points = exported_shape_points(&kernel_doc(net));
    let modes: Vec<i64> = points
        .iter()
        .map(|p| p["curveMode"].as_i64().unwrap())
        .collect();
    assert_eq!(
        modes,
        vec![1, 2, 4, 3, 3],
        "straight / mirrored / asymmetric / disconnected / single-handle"
    );
    assert_eq!(points[0]["hasCurveFrom"], false);
    assert_eq!(points[0]["hasCurveTo"], false);
    assert_eq!(points[1]["hasCurveFrom"], true);
    assert_eq!(points[1]["hasCurveTo"], true);
    // v4 carries only an outgoing handle
    assert_eq!(points[4]["hasCurveFrom"], true);
    assert_eq!(points[4]["hasCurveTo"], false);
    // without a radii binding every point exports cornerRadius 0
    assert!(points.iter().all(|p| p["cornerRadius"] == 0.0));
}

// ---------------------------------------------------------------------------
// import → export round trip
// ---------------------------------------------------------------------------

#[test]
fn native_document_round_trips_modes_handles_and_radii() {
    let node = import_network(json!([
        // Straight with a corner radius: handles ignored, radius kept
        {"_class":"curvePoint","point":"{0, 0}","curveFrom":"{0.3, 0.3}",
         "curveTo":"{-0.3, -0.3}","hasCurveFrom":true,"hasCurveTo":true,
         "curveMode":1,"cornerRadius":2.0},
        // Mirrored with both halves stored
        {"_class":"curvePoint","point":"{1, 0}","curveFrom":"{1.2, 0}",
         "curveTo":"{0.8, 0}","hasCurveFrom":true,"hasCurveTo":true,
         "curveMode":2,"cornerRadius":0.0},
        // Disconnected
        {"_class":"curvePoint","point":"{1, 1}","curveFrom":"{1.2, 1.1}",
         "curveTo":"{0.9, 0.8}","hasCurveFrom":true,"hasCurveTo":true,
         "curveMode":3,"cornerRadius":0.0},
        // Asymmetric: collinear with the vertex, unequal lengths
        {"_class":"curvePoint","point":"{0, 1}","curveFrom":"{0.2, 1}",
         "curveTo":"{-0.1, 1}","hasCurveFrom":true,"hasCurveTo":true,
         "curveMode":4,"cornerRadius":0.0}
    ]));
    let doc = {
        let mut d = kernel_doc(node.network.clone().expect("network"));
        let target = d.nodes.get_mut("n1").unwrap();
        target.bindings = node.bindings.clone();
        d
    };
    let points = exported_shape_points(&doc);
    let modes: Vec<i64> = points
        .iter()
        .map(|p| p["curveMode"].as_i64().unwrap())
        .collect();
    assert_eq!(modes, vec![1, 2, 3, 4], "modes re-derive from geometry");
    assert_eq!(points[0]["cornerRadius"], 2.0);
    assert_eq!(points[0]["hasCurveFrom"], false);
    assert_eq!(points[0]["hasCurveTo"], false);
    // mirrored and disconnected handles survive the round trip
    assert_eq!(pt(&points[1]["curveFrom"]), (1.2, 0.));
    assert_eq!(pt(&points[1]["curveTo"]), (0.8, 0.));
    assert_eq!(pt(&points[2]["curveFrom"]), (1.2, 1.1));
    assert_eq!(pt(&points[2]["curveTo"]), (0.9, 0.8));
    assert_eq!(pt(&points[3]["curveFrom"]), (0.2, 1.));
    assert_eq!(pt(&points[3]["curveTo"]), (-0.1, 1.));
}
