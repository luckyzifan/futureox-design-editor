//! Integration coverage for 22 号字典 §1 (P0-1): Sketch `curveMode` 0–4 ↔
//! kernel network c1/c2 handles, plus per-point `cornerRadius` round-tripping
//! through `bindings["sketchPointCornerRadii"]`.

use futureox_design_kernel::{
    facet::sample_node,
    interop::{export_sketch, import_sketch, import_sketch_report, read_zip_public},
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
        nodes: Default::default(),
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
    path.network = Some(net.into());
    doc.nodes.insert("p1".into(), page);
    doc.nodes.insert("n1".into(), path);
    doc
}

/// Minimal but structurally real native .sketch container: meta.json +
/// document.json + one page holding a single shapePath with the given
/// curvePoint dicts (22 号字典 §1 string coordinates).
fn native_sketch(points: Value) -> Vec<u8> {
    native_sketch_path(points, [0., 0., 100., 100.], true, 0., [false, false])
}

fn native_sketch_path(points: Value, frame: [f64; 4], closed: bool, rotation: f64, flip: [bool; 2]) -> Vec<u8> {
    let page_ref = "AAAAAAAA-0000-0000-0000-000000000001";
    let page = json!({
        "_class": "page", "name": "Page 1",
        "layers": [{
            "_class": "shapePath", "name": "Path",
            "do_objectID": "BBBBBBBB-0000-0000-0000-000000000002",
            "frame": {"_class": "rect", "x": frame[0], "y": frame[1], "width": frame[2], "height": frame[3]},
            "isClosed": closed, "rotation": rotation,
            "isFlippedHorizontal": flip[0], "isFlippedVertical": flip[1],
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
fn import_explicit_active_handles_survive_none_straight_or_missing_edit_mode() {
    // Rendering follows the explicit flags. The editing point type must not
    // discard an active curve, including real split-circle endpoints.
    let node = import_network(json!([
        {"_class":"curvePoint","point":"{0, 0}","curveFrom":"{0.3, 0.3}",
         "curveTo":"{-0.3, -0.3}","hasCurveFrom":true,"hasCurveTo":true,
         "curveMode":0,"cornerRadius":0.0},
        // A missing editing type still cannot disable explicit geometry.
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
    for (i, (x, y)) in [(0.3, 0.3), (1.3, 0.3), (1.3, 1.3), (0.2, 1.1)].into_iter().enumerate() {
        assert_pt(net.edges[i].c1, x, y, "explicit outgoing");
    }
    assert_pt(net.edges[0].c2, 0.7, -0.3, "missing-mode incoming");
    assert_pt(net.edges[1].c2, 0.7, 0.7, "straight incoming");
    assert_pt(net.edges[3].c2, -0.3, -0.3, "none-mode incoming");
    assert_pt(net.edges[3].c1, 0.2, 1.1, "control outgoing");
    assert_pt(net.edges[2].c2, -0.2, 0.9, "control incoming");
}

#[test]
fn import_mirrored_preserves_flags_without_inventing_an_inactive_side() {
    let node = import_network(json!([
        {"_class":"curvePoint","point":"{0, 0}","curveFrom":"{0, 0}",
         "curveTo":"{0, 0}","hasCurveFrom":false,"hasCurveTo":false,
         "curveMode":1,"cornerRadius":0.0},
        // Only curveTo is active; curveFrom is explicitly inactive.
        {"_class":"curvePoint","point":"{1, 0}","curveFrom":"{1, 0}",
         "curveTo":"{0.8, 0.2}","hasCurveFrom":false,"hasCurveTo":true,
         "curveMode":2,"cornerRadius":0.0},
        // Only curveFrom is active; curveTo is explicitly inactive.
        {"_class":"curvePoint","point":"{1, 1}","curveFrom":"{1.2, 1.2}",
         "curveTo":"{1, 1}","hasCurveFrom":true,"hasCurveTo":false,
         "curveMode":2,"cornerRadius":0.0},
        {"_class":"curvePoint","point":"{0, 1}","curveFrom":"{0, 1}",
         "curveTo":"{0, 1}","hasCurveFrom":false,"hasCurveTo":false,
         "curveMode":1,"cornerRadius":0.0}
    ]));
    let net = node.network.as_ref().expect("network");
    // Point type is an editing constraint, not authority to synthesize geometry.
    assert_pt(net.edges[0].c2, 0.8, 0.2, "v1 stored curveTo");
    assert!(net.edges[1].c1.is_none());
    assert_pt(net.edges[2].c1, 1.2, 1.2, "v2 stored curveFrom");
    assert!(net.edges[1].c2.is_none());
}

#[test]
fn inactive_flags_ignore_stale_coordinates_for_every_editing_mode() {
    for mode in 0..=4 {
        let node = import_network(json!([
            {"_class":"curvePoint","point":"{0, 0}","curveFrom":"{30, -90}",
             "curveTo":"{-20, 80}","hasCurveFrom":false,"hasCurveTo":false,"curveMode":mode},
            {"_class":"curvePoint","point":"{1, 0}","curveFrom":"{50, 60}",
             "curveTo":"{-70, 80}","hasCurveFrom":false,"hasCurveTo":false,"curveMode":mode},
            {"_class":"curvePoint","point":"{1, 1}","curveFrom":"{90, 50}",
             "curveTo":"{-60, -80}","hasCurveFrom":false,"hasCurveTo":false,"curveMode":mode}
        ]));
        assert!(node.network.unwrap().edges.iter().all(|edge| edge.c1.is_none() && edge.c2.is_none()));
    }
}

fn split_circle_points() -> Value {
    // The real 117 archive repeats its first anchor at the end. The starting
    // point has Straight editing mode but an explicitly active outgoing handle.
    // These canonical cubic-circle coordinates contain no document identity.
    json!([
        {"_class":"curvePoint","point":"{0.5, 0}","curveFrom":"{0.776142, 0}",
         "curveTo":"{0, 0}","curveMode":1,"hasCurveFrom":true,"hasCurveTo":false},
        {"_class":"curvePoint","point":"{1, 0.5}","curveFrom":"{1, 0.776142}",
         "curveTo":"{1, 0.223858}","curveMode":2,"hasCurveFrom":true,"hasCurveTo":true},
        {"_class":"curvePoint","point":"{0.5, 1}","curveFrom":"{0.223858, 1}",
         "curveTo":"{0.776142, 1}","curveMode":2,"hasCurveFrom":true,"hasCurveTo":true},
        {"_class":"curvePoint","point":"{0, 0.5}","curveFrom":"{0, 0.223858}",
         "curveTo":"{0, 0.776142}","curveMode":2,"hasCurveFrom":true,"hasCurveTo":true},
        {"_class":"curvePoint","point":"{0.5, 0}","curveFrom":"{0.5, 0}",
         "curveTo":"{0.223858, 0}","curveMode":2,"hasCurveFrom":true,"hasCurveTo":true}
    ])
}

#[test]
fn real_117_split_circle_keeps_its_first_quadrant_round_under_nested_affine_placement() {
    for flip in [[false, false], [true, false], [false, true]] {
        let doc = import_sketch_report(&native_sketch_path(split_circle_points(), [3.25, -4.5, 38., 38.], true, -37., flip)).unwrap().document;
        let node = doc.nodes.values().find(|node| node.kind == "vector").unwrap();
        let net = node.network.as_ref().unwrap();
        assert_eq!(net.vertices.len(), 5); assert_eq!(net.edges.len(), 5);
        assert_pt(net.edges[0].c1, 0.776142 * 38., 0., "active first circle tangent");
        assert!(net.edges[4].c2.is_none());
        let (_, stroke) = net.paths().unwrap();
        for parent in [Transform::default(), Transform([1.6, 0.5, -0.25, 0.8, 23., -17.]),
            Transform([-0.7, 0.2, 0.6, 1.9, -41., 16.])] {
            let matrix = parent.concat(node.transform);
            let inverse = matrix.inverse().unwrap();
            let contours = stroke.flatten(matrix, 0.0001).unwrap();
            assert!(contours.iter().any(|contour| contour.closed));
            let maximum = contours.iter().flat_map(|contour| &contour.points).map(|&point| {
                let local = inverse.point(point);
                ((local - Point::new(19., 19.)).length() - 19.).abs()
            }).fold(0., f64::max);
            // The archived rounded cubic has <=0.006 px radial error at 38px.
            // Dropping its first c1 produces a measured 2.547 px inward defect.
            assert!(maximum < 0.006, "circle radial deviation {maximum}");
        }
    }
}

#[test]
fn real_117_open_arc_keeps_active_endpoint_handles_and_open_topology() {
    let points = json!([
        {"_class":"curvePoint","point":"{0.154324, 0.138924}","curveFrom":"{0.244154, 0.052894}",
         "curveTo":"{0, 0}","curveMode":1,"hasCurveFrom":true,"hasCurveTo":false},
        {"_class":"curvePoint","point":"{0.5, 0}","curveFrom":"{0.775892, 0}",
         "curveTo":"{0.365966, 0}","curveMode":2,"hasCurveFrom":true,"hasCurveTo":true},
        {"_class":"curvePoint","point":"{1, 0.5}","curveFrom":"{1, 0.775892}",
         "curveTo":"{1, 0.224108}","curveMode":2,"hasCurveFrom":true,"hasCurveTo":true}
    ]);
    let doc = import_sketch_report(&native_sketch_path(points, [0., 0., 68., 68.], false, -60., [true, false])).unwrap().document;
    let node = doc.nodes.values().find(|node| node.kind == "vector").unwrap();
    let net = node.network.as_ref().unwrap();
    assert_eq!(net.vertices.len(), 3); assert_eq!(net.edges.len(), 2);
    assert_pt(net.edges[0].c1, 0.244154 * 68., 0.052894 * 68., "open arc outgoing tangent");
    assert_pt(net.edges[0].c2, 0.365966 * 68., 0., "open arc incoming tangent");
    let (_, stroke) = net.paths().unwrap();
    let contours = stroke.flatten(node.transform, 0.0001).unwrap();
    assert_eq!(contours.len(), 1); assert!(!contours[0].closed);
    let expected = node.transform.point(Point::new(0.154324 * 68., 0.138924 * 68.));
    assert!((contours[0].points[0] - expected).length() < 1e-10);
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
        // Inactive stored handles remain ignored; the radius is kept.
        {"_class":"curvePoint","point":"{0, 0}","curveFrom":"{0.3, 0.3}",
         "curveTo":"{-0.3, -0.3}","hasCurveFrom":false,"hasCurveTo":false,
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
        let mut d = kernel_doc(node.network.as_deref().expect("network").clone());
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
