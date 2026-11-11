//! Issue #296. Native Sketch stores curvePoint coordinates as frame-normalized
//! strings. This file checks that encoding against the published point-string
//! schema and `sketch::CurveContour`, which is not the kernel importer.
//!
//! The schema pattern is copied from
//! `sketch-hq/sketch-document` `packages/file-format/schema/utils/point-string.schema.yaml`
//! (`^{-?\d+(.\d+)?(e-\d+)?, -?\d+(.\d+)?(e-\d+)?}$`). The published `.` is any
//! character; strings below also match a real decimal point.
//! Native Sketch 2025 was not available in this environment.

use futureox_design_kernel::{
    Engine, RenderOptions, View,
    fidelity::RasterProfile,
    freehand::{Request, Sample, fit_samples},
    interop::{export_sketch, read_zip_public},
    math::Point,
    path::Command,
    scene::{Document, Edge, Network, Vertex},
    sketch::{CurveContour, Document as SketchDocument},
    vector_brush::{VectorBrush, paths},
};
use serde_json::{Value, json};

const TRIANGLE: &str = "11111111-1111-4111-8111-111111111111";
const LINE: &str = "22222222-2222-4222-8222-222222222222";
const CURVE: &str = "33333333-3333-4333-8333-333333333333";
const RECT: &str = "44444444-4444-4444-8444-444444444444";
const OVAL: &str = "55555555-5555-4555-8555-555555555555";

fn official_point_string(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.first() != Some(&b'{') || bytes.last() != Some(&b'}') {
        return false;
    }
    let inner = &text[1..text.len() - 1];
    let Some((x, y)) = inner.split_once(", ") else {
        return false;
    };
    unit_token(x) && unit_token(y)
}

fn unit_token(text: &str) -> bool {
    let rest = text.strip_prefix('-').unwrap_or(text);
    let (mantissa, exponent) = match rest.split_once('e') {
        Some((mantissa, exponent)) => {
            if !exponent.starts_with('-')
                || exponent.len() < 2
                || !exponent[1..].bytes().all(|byte| byte.is_ascii_digit())
            {
                return false;
            }
            (mantissa, true)
        }
        None => (rest, false),
    };
    let _ = exponent;
    let (whole, fraction) = match mantissa.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (mantissa, None),
    };
    !whole.is_empty()
        && whole.bytes().all(|byte| byte.is_ascii_digit())
        && fraction.is_none_or(|fraction| {
            !fraction.is_empty() && fraction.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn document(nodes: Vec<Value>) -> Document {
    let children: Vec<_> = nodes
        .iter()
        .map(|node| node["id"].as_str().unwrap().to_string())
        .collect();
    let mut map = serde_json::Map::new();
    for node in nodes {
        map.insert(node["id"].as_str().unwrap().to_string(), node);
    }
    serde_json::from_value(json!({
        "schemaVersion": 16,
        "id": "d",
        "name": "CurvePoints",
        "pages": [{"id": "p", "name": "Page", "background": "#ffffff", "children": children}],
        "nodes": map
    }))
    .unwrap()
}

fn ring(points: &[(f64, f64)], closed: bool) -> Network {
    let mut vertices = Vec::new();
    let mut edges = Vec::new();
    for (index, (x, y)) in points.iter().enumerate() {
        vertices.push(Vertex {
            id: format!("v{index}"),
            x: *x,
            y: *y,
        });
    }
    let count = points.len();
    let edges_len = if closed { count } else { count - 1 };
    for index in 0..edges_len {
        edges.push(Edge {
            id: format!("e{index}"),
            from: format!("v{index}"),
            to: format!("v{}", (index + 1) % count),
            c1: None,
            c2: None,
        });
    }
    Network {
        filled_faces: None,
        vertices,
        edges,
        fill_rule: "nonzero".into(),
    }
}

fn vector_node(id: &str, width: f64, height: f64, network: Network, open: bool) -> Value {
    let mut node = json!({
        "id": id,
        "kind": "vector",
        "name": id,
        "width": width,
        "height": height,
        "network": network,
        "fills": [{"kind": "solid", "color": "#224488"}]
    });
    if open {
        node["bindings"] = json!({"sketchOpenPath": "true"});
    }
    node
}

fn page_layers(bytes: &[u8]) -> Vec<Value> {
    let files = read_zip_public(bytes).unwrap();
    let page = files
        .iter()
        .find(|(name, _)| name.starts_with("pages/") && name.ends_with(".json"))
        .unwrap();
    let page: Value = serde_json::from_slice(page.1).unwrap();
    page["layers"].as_array().unwrap().clone()
}

fn layer_by_id<'a>(layers: &'a [Value], id: &str) -> &'a Value {
    layers
        .iter()
        .find(|layer| layer["do_objectID"] == id)
        .unwrap_or_else(|| panic!("missing layer {id}"))
}

fn assert_curve_point_schema(point: &Value) {
    assert_eq!(point["_class"], "curvePoint");
    assert!(
        point["curveMode"]
            .as_i64()
            .is_some_and(|mode| (0..=4).contains(&mode))
    );
    assert!(point["hasCurveFrom"].is_boolean());
    assert!(point["hasCurveTo"].is_boolean());
    assert!(point["cornerRadius"].is_number());
    for key in ["point", "curveFrom", "curveTo"] {
        let value = &point[key];
        assert!(
            value.is_string(),
            "{key} must be a frame-normalized string, got {value}"
        );
        let text = value.as_str().unwrap();
        assert!(
            official_point_string(text),
            "{key} {text} is outside the Sketch point-string schema"
        );
        assert!(value.get("x").is_none() && value.get("_class").is_none());
    }
}

fn contour_of(bytes: &[u8], id: &str) -> CurveContour {
    let sketch = SketchDocument::from_sketch(bytes).expect("independent sketch archive");
    CurveContour::from_layer(sketch.layer(id).expect("layer")).expect("independent curve parser")
}

fn recovered_matches_division(local: f64, extent: f64, recovered: f64) {
    let expected = if extent == 0. {
        assert_eq!(local, 0.);
        0.
    } else {
        (local / extent) * extent
    };
    assert_eq!(
        recovered.to_bits(),
        expected.to_bits(),
        "local {local:?} extent {extent:?} recovered {recovered:?} expected {expected:?}"
    );
}

fn opaque_pixels(doc: &Document, width: u32, height: u32) -> usize {
    let mut engine = Engine::new();
    engine
        .load_document(&serde_json::to_string(doc).unwrap())
        .unwrap();
    let pixels = engine
        .render(&RenderOptions {
            page_id: "p".into(),
            width,
            height,
            view: View {
                x: 0.,
                y: 0.,
                zoom: 1.,
            },
            transparent: true,
            grid: false,
            pixel_preview: None,
            animation: None,
            raster_profile: RasterProfile::FigmaSoftware,
            interactive_effects: false,
            checkerboard: false,
        })
        .unwrap();
    pixels.chunks_exact(4).filter(|pixel| pixel[3] > 0).count()
}

fn object_encoding_misreads_the_frame(width: f64, height: f64, local: (f64, f64)) -> (f64, f64) {
    // The previous writer stored local pixels as point objects. CurveContour
    // treats every curve coordinate as a fraction of the frame, so those
    // objects land `frame` times too far away.
    (local.0 * width, local.1 * height)
}

#[test]
fn ordinary_vectors_use_frame_normalized_strings_and_keep_f64_handles() {
    let mut curve = ring(&[(0., 0.), (60., 0.), (60., 30.), (0., 30.)], true);
    let precise = 49.1234567890123;
    curve.edges[0].c1 = Some(Point::new(precise, -12.5));
    curve.edges[0].c2 = Some(Point::new(42., 51.9876543210987));
    curve.edges[1].c1 = Some(Point::new(70., 10.));
    let doc = document(vec![
        vector_node(
            TRIANGLE,
            24.,
            24.,
            ring(&[(0., 24.), (12., 0.), (24., 24.)], true),
            false,
        ),
        vector_node(LINE, 80., 0., ring(&[(0., 0.), (80., 0.)], false), true),
        vector_node(CURVE, 60., 30., curve, false),
        json!({
            "id": RECT,
            "kind": "rectangle",
            "name": "Rect",
            "width": 40.,
            "height": 20.,
            "radii": [1., 2., 3., 4.],
            "fills": [{"kind": "solid", "color": "#112233"}]
        }),
        json!({
            "id": OVAL,
            "kind": "ellipse",
            "name": "Oval",
            "width": 30.,
            "height": 18.,
            "fills": [{"kind": "solid", "color": "#336699"}]
        }),
    ]);
    let bytes = export_sketch(&doc).unwrap();
    let layers = page_layers(&bytes);

    let triangle = layer_by_id(&layers, TRIANGLE);
    assert_eq!(triangle["_class"], "shapePath");
    assert_eq!(triangle["isClosed"], true);
    assert_eq!(
        triangle.pointer("/userInfo/com.futureox.design-kernel/geometryUnits"),
        Some(&json!("normalized"))
    );
    let points = triangle["points"].as_array().unwrap();
    for point in points {
        assert_curve_point_schema(point);
    }
    assert_eq!(points[0]["point"], "{0, 1}");
    assert_eq!(points[1]["point"], "{0.5, 0}");
    assert_eq!(points[2]["point"], "{1, 1}");
    let parsed = contour_of(&bytes, TRIANGLE);
    assert!(parsed.is_closed());
    let expected = [(0., 24.), (12., 0.), (24., 24.)];
    for (index, (x, y)) in expected.iter().enumerate() {
        let point = parsed.points()[index].point;
        assert_eq!(point, [*x, *y]);
        let mistaken = object_encoding_misreads_the_frame(24., 24., (*x, *y));
        assert_ne!(mistaken, (*x, *y));
    }
    let recovered: Vec<(f64, f64)> = parsed
        .points()
        .iter()
        .map(|point| (point.point[0], point.point[1]))
        .collect();
    let covered = opaque_pixels(
        &document(vec![vector_node(
            TRIANGLE,
            24.,
            24.,
            ring(&recovered, true),
            false,
        )]),
        24,
        24,
    );
    assert!(
        covered > 200,
        "the independently parsed triangle must cover the 24×24 frame, covered {covered}"
    );

    let line = layer_by_id(&layers, LINE);
    assert_eq!(line["isClosed"], false);
    let line_points = line["points"].as_array().unwrap();
    for point in line_points {
        assert_curve_point_schema(point);
    }
    assert_eq!(line_points[0]["point"], "{0, 0}");
    assert_eq!(line_points[1]["point"], "{1, 0}");
    let parsed = contour_of(&bytes, LINE);
    assert!(!parsed.is_closed());
    assert_eq!(parsed.points()[0].point, [0., 0.]);
    assert_eq!(parsed.points()[1].point, [80., 0.]);

    let curve = layer_by_id(&layers, CURVE);
    for point in curve["points"].as_array().unwrap() {
        assert_curve_point_schema(point);
    }
    assert_eq!(curve["points"][0]["hasCurveFrom"], true);
    assert_eq!(curve["points"][1]["hasCurveTo"], true);
    let parsed = contour_of(&bytes, CURVE);
    let outgoing = parsed.points()[0].outgoing.unwrap();
    let incoming = parsed.points()[1].incoming.unwrap();
    recovered_matches_division(precise, 60., outgoing[0]);
    recovered_matches_division(-12.5, 30., outgoing[1]);
    recovered_matches_division(42., 60., incoming[0]);
    recovered_matches_division(51.9876543210987, 30., incoming[1]);
    assert_eq!(outgoing[0].to_bits(), precise.to_bits());
    let outside = parsed.points()[1].outgoing.unwrap();
    recovered_matches_division(70., 60., outside[0]);
    recovered_matches_division(10., 30., outside[1]);
    assert!(
        outside[0] > 60.,
        "a handle outside the frame must not be clamped"
    );

    let rectangle = layer_by_id(&layers, RECT);
    assert_eq!(rectangle["_class"], "rectangle");
    let corners = ["{0, 0}", "{1, 0}", "{1, 1}", "{0, 1}"];
    let radii = [1., 2., 3., 4.];
    for (index, point) in rectangle["points"].as_array().unwrap().iter().enumerate() {
        assert_eq!(point["point"], corners[index]);
        assert!(point["point"].is_string());
        assert_eq!(point["cornerRadius"], radii[index]);
    }
    let oval = layer_by_id(&layers, OVAL);
    assert_eq!(oval["_class"], "oval");
    assert_eq!(oval["points"].as_array().unwrap().len(), 4);
    for point in oval["points"].as_array().unwrap() {
        assert!(official_point_string(point["point"].as_str().unwrap()));
        assert!(official_point_string(point["curveFrom"].as_str().unwrap()));
        assert!(official_point_string(point["curveTo"].as_str().unwrap()));
        assert_eq!(point["hasCurveFrom"], true);
    }
    SketchDocument::from_sketch(&bytes).unwrap();
}

#[test]
fn zero_axis_rejects_a_coordinate_it_cannot_normalize() {
    let doc = document(vec![vector_node(
        TRIANGLE,
        10.,
        0.,
        ring(&[(0., 4.), (10., 4.)], false),
        true,
    )]);
    let error = export_sketch(&doc).unwrap_err().to_string();
    assert!(error.contains("zero-size"), "{error}");
}

#[test]
fn freehand_open_curve_round_trips_through_the_independent_parser() {
    let fitted = fit_samples(Request {
        samples: vec![
            Sample {
                x: 0.,
                y: 0.,
                pressure: 0.5,
            },
            Sample {
                x: 12.,
                y: 30.,
                pressure: 0.5,
            },
            Sample {
                x: 40.,
                y: 26.,
                pressure: 0.5,
            },
            Sample {
                x: 70.,
                y: 4.,
                pressure: 0.5,
            },
        ],
        tolerance: 2.,
        pressure_tolerance: 0.2,
    })
    .unwrap();
    assert!(fitted.network.edges.iter().any(|edge| edge.c1.is_some()));
    let doc = document(vec![vector_node(
        CURVE,
        fitted.width,
        fitted.height,
        fitted.network.clone(),
        false,
    )]);
    let bytes = export_sketch(&doc).unwrap();
    let layer = &page_layers(&bytes)[0];
    assert_eq!(layer["isClosed"], false);
    for point in layer["points"].as_array().unwrap() {
        assert_curve_point_schema(point);
    }
    assert!(
        layer
            .pointer("/userInfo/com.futureox.design-kernel/lossy")
            .is_none(),
        "an open freehand chain is a shapePath, not a flattened ring"
    );
    let parsed = contour_of(&bytes, CURVE);
    assert!(!parsed.is_closed());
    assert_eq!(parsed.points().len(), fitted.network.vertices.len());
    for (vertex, point) in fitted.network.vertices.iter().zip(parsed.points()) {
        recovered_matches_division(vertex.x, fitted.width, point.point[0]);
        recovered_matches_division(vertex.y, fitted.height, point.point[1]);
    }
    for (index, edge) in fitted.network.edges.iter().enumerate() {
        if let Some(handle) = edge.c1 {
            let outgoing = parsed.points()[index].outgoing.unwrap();
            recovered_matches_division(handle.x, fitted.width, outgoing[0]);
            recovered_matches_division(handle.y, fitted.height, outgoing[1]);
        }
        if let Some(handle) = edge.c2 {
            let incoming = parsed.points()[index + 1].incoming.unwrap();
            recovered_matches_division(handle.x, fitted.width, incoming[0]);
            recovered_matches_division(handle.y, fitted.height, incoming[1]);
        }
    }
}

fn brush(source: Network, spacing: f64) -> VectorBrush {
    VectorBrush {
        source,
        mode: "scatter".into(),
        width: 8.,
        spacing,
        seed: 1,
        rotation: 0.,
        rotation_variance: 0.,
        scale_variance: 0.,
        scatter: 0.,
        follow_tangent: true,
    }
}

fn curved_guide() -> Network {
    let mut guide = ring(&[(0., 0.), (40., 0.)], false);
    guide.edges[0].c1 = Some(Point::new(0., 30.));
    guide.edges[0].c2 = Some(Point::new(40., 30.));
    guide
}

fn curved_source() -> Network {
    let mut source = ring(&[(-4., -2.), (4., -2.), (4., 2.), (-4., 2.)], true);
    source.edges[0].c1 = Some(Point::new(-2., -6.));
    source.edges[0].c2 = Some(Point::new(2., -6.));
    source
}

fn commands_to_network(commands: &[Command]) -> (Network, f64, f64) {
    let mut samples = Vec::new();
    for command in commands {
        match *command {
            Command::Move(point) | Command::Line(point) => samples.push(point),
            Command::Cubic(a, b, point) => samples.extend([a, b, point]),
            Command::Quad(control, point) => samples.extend([control, point]),
            Command::Close => {}
            _ => panic!("brush outline used an unsupported command"),
        }
    }
    let min_x = samples
        .iter()
        .map(|point| point.x)
        .fold(f64::INFINITY, f64::min);
    let min_y = samples
        .iter()
        .map(|point| point.y)
        .fold(f64::INFINITY, f64::min);
    let max_x = samples
        .iter()
        .map(|point| point.x)
        .fold(f64::NEG_INFINITY, f64::max);
    let max_y = samples
        .iter()
        .map(|point| point.y)
        .fold(f64::NEG_INFINITY, f64::max);
    let shift = |point: Point| Point::new(point.x - min_x, point.y - min_y);
    let mut vertices = Vec::new();
    let mut edges = Vec::new();
    let mut start = None;
    let mut previous = None;
    for command in commands {
        match *command {
            Command::Move(point) => {
                let id = format!("v{}", vertices.len());
                let point = shift(point);
                vertices.push(Vertex {
                    id: id.clone(),
                    x: point.x,
                    y: point.y,
                });
                start = Some(vertices.len() - 1);
                previous = Some(vertices.len() - 1);
            }
            Command::Line(point) | Command::Cubic(_, _, point) | Command::Quad(_, point) => {
                let from = previous.expect("contour");
                let end = shift(point);
                let id = format!("v{}", vertices.len());
                vertices.push(Vertex {
                    id,
                    x: end.x,
                    y: end.y,
                });
                let to = vertices.len() - 1;
                let (c1, c2) = match *command {
                    Command::Cubic(a, b, _) => (Some(shift(a)), Some(shift(b))),
                    _ => (None, None),
                };
                edges.push(Edge {
                    id: format!("e{}", edges.len()),
                    from: format!("v{from}"),
                    to: format!("v{to}"),
                    c1,
                    c2,
                });
                previous = Some(to);
            }
            Command::Close => {
                let from = previous.expect("contour");
                let to = start.expect("start");
                if from != to {
                    edges.push(Edge {
                        id: format!("e{}", edges.len()),
                        from: format!("v{from}"),
                        to: format!("v{to}"),
                        c1: None,
                        c2: None,
                    });
                }
                previous = None;
            }
            _ => unreachable!(),
        }
    }
    (
        Network {
            filled_faces: None,
            vertices,
            edges,
            fill_rule: "nonzero".into(),
        },
        (max_x - min_x).max(0.),
        (max_y - min_y).max(0.),
    )
}

#[test]
fn expanded_curved_scatter_stamp_keeps_its_cubic_and_a_multi_stamp_is_reported() {
    let single = paths(&curved_guide(), &brush(curved_source(), 1_000.)).unwrap();
    assert_eq!(
        single
            .commands
            .iter()
            .filter(|command| matches!(command, Command::Move(_)))
            .count(),
        1,
        "one stamp is one contour"
    );
    assert!(
        single
            .commands
            .iter()
            .any(|command| matches!(command, Command::Cubic(..)))
    );
    let (network, width, height) = commands_to_network(&single.commands);
    assert!(network.edges.iter().any(|edge| edge.c1.is_some()));
    let doc = document(vec![vector_node(
        CURVE,
        width,
        height,
        network.clone(),
        false,
    )]);
    let bytes = export_sketch(&doc).unwrap();
    let layer = &page_layers(&bytes)[0];
    assert!(
        layer
            .pointer("/userInfo/com.futureox.design-kernel/lossy")
            .is_none()
    );
    for point in layer["points"].as_array().unwrap() {
        assert_curve_point_schema(point);
    }
    let parsed = contour_of(&bytes, CURVE);
    assert!(parsed.is_closed());
    for (index, edge) in network.edges.iter().enumerate() {
        if let Some(handle) = edge.c1 {
            let outgoing = parsed.points()[index].outgoing.unwrap();
            recovered_matches_division(handle.x, width, outgoing[0]);
            recovered_matches_division(handle.y, height, outgoing[1]);
        }
    }

    let many = paths(&curved_guide(), &brush(curved_source(), 20.)).unwrap();
    let stamps = many
        .commands
        .iter()
        .filter(|command| matches!(command, Command::Move(_)))
        .count();
    assert!(stamps > 1, "a curved scatter expands to several contours");
    let (network, width, height) = commands_to_network(&many.commands);
    let doc = document(vec![vector_node(CURVE, width, height, network, false)]);
    let bytes = export_sketch(&doc).unwrap();
    let layer = &page_layers(&bytes)[0];
    for point in layer["points"].as_array().unwrap() {
        assert_curve_point_schema(point);
    }
    let lossy = layer
        .pointer("/userInfo/com.futureox.design-kernel/lossy")
        .and_then(Value::as_array)
        .unwrap();
    assert!(
        lossy
            .iter()
            .any(|note| note.as_str().unwrap().contains("network-topology")),
        "separate scatter stamps are not one shapePath; the loss is reported, got {lossy:?}"
    );
    // The archive is still a legal shapePath. It is not the compound outline.
    let parsed = contour_of(&bytes, CURVE);
    assert_eq!(
        parsed.points().len(),
        layer["points"].as_array().unwrap().len()
    );
}
