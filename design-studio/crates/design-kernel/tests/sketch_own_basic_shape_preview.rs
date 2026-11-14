//! Product export of a rectangle and an oval, then the native read-only projection.
//! The legacy analytic compiler stays narrow; admission is the display projection.
use futureox_design_kernel::interop::{export_sketch, import_sketch_report, read_zip_public};
use futureox_design_kernel::scene::Document;
use futureox_design_kernel::sketch::preview::{PreviewRequest, compile_preview, display_snapshot};
use futureox_design_kernel::sketch::{Document as SketchDocument, Error, Layer, Session};
use serde_json::{Value, json};
use std::io::{Cursor, Write};

fn basic_shapes() -> Document {
    serde_json::from_value(json!({
        "schemaVersion": 2,
        "rasterProfile": "analytic",
        "id": "doc-basic",
        "name": "选区",
        "pages": [{
            "id": "page-1",
            "name": "页面 1",
            "background": "#f5f5f5",
            "children": ["alpha", "beta"]
        }],
        "nodes": {
            "alpha": {
                "id": "alpha",
                "kind": "rectangle",
                "name": "Alpha",
                "transform": [1, 0, 0, 1, 20, 20],
                "width": 160,
                "height": 100,
                "points": 3,
                "fills": [{"kind": "solid", "color": "#DB3344", "opacity": 1}]
            },
            "beta": {
                "id": "beta",
                "kind": "ellipse",
                "name": "Beta",
                "transform": [1, 0, 0, 1, 100, 70],
                "width": 140,
                "height": 100,
                "points": 3,
                "innerRadius": 0.45,
                "fills": [{"kind": "solid", "color": "#3366DD", "opacity": 0.7}]
            }
        }
    }))
    .unwrap()
}

fn open_exported(bytes: &[u8]) -> Session {
    Session::new(
        SketchDocument::from_sketch(bytes).unwrap(),
        "native-basic-shapes".into(),
        1,
    )
    .unwrap()
}

fn page_json(bytes: &[u8]) -> Value {
    let files = read_zip_public(bytes).unwrap();
    let page = files
        .iter()
        .find(|(name, _)| name.starts_with("pages/") && name.ends_with(".json"))
        .unwrap();
    serde_json::from_slice(page.1).unwrap()
}

fn layer_count(layer: &Layer) -> usize {
    1 + layer.children().iter().map(layer_count).sum::<usize>()
}

fn channels(color: &str) -> [f64; 4] {
    let inner = color
        .strip_prefix("color(srgb ")
        .and_then(|value| value.strip_suffix(')'))
        .unwrap_or_else(|| panic!("srgb color {color}"));
    let (rgb, alpha) = inner.split_once(" / ").unwrap();
    let mut parts = rgb
        .split_whitespace()
        .map(|part| part.parse::<f64>().unwrap());
    [
        parts.next().unwrap(),
        parts.next().unwrap(),
        parts.next().unwrap(),
        alpha.parse().unwrap(),
    ]
}

fn close(actual: [f64; 4], expected: [f64; 4]) {
    for (got, want) in actual.into_iter().zip(expected) {
        assert!((got - want).abs() < 1e-9, "{actual:?} != {expected:?}");
    }
}

fn rewrite_page(bytes: &[u8], mut mutate: impl FnMut(&mut Value)) -> Vec<u8> {
    let files = read_zip_public(bytes).unwrap();
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, value) in files {
        let bytes = if name.starts_with("pages/") && name.ends_with(".json") {
            let mut page: Value = serde_json::from_slice(&value).unwrap();
            mutate(&mut page);
            serde_json::to_vec(&page).unwrap()
        } else {
            value
        };
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

#[test]
fn own_rectangle_and_oval_export_admits_in_native_display_preview() {
    let source = basic_shapes();
    source.validate().unwrap();
    let bytes = export_sketch(&source).unwrap();
    let page = page_json(&bytes);
    assert_eq!(page["_class"], "page");
    assert_eq!(page["booleanOperation"], -1);
    assert_eq!(page["isFlippedHorizontal"], false);
    assert_eq!(page["isFlippedVertical"], false);
    assert!(page.get("rotation").is_none() || page["rotation"] == 0);
    assert!(page.get("transform").is_none());
    assert!(page.get("affineTransform").is_none());
    let layers = page["layers"].as_array().unwrap();
    assert_eq!(layers.len(), 2);
    assert_eq!(layers[0]["_class"], "rectangle");
    assert_eq!(layers[1]["_class"], "oval");
    assert!(layers.iter().all(|layer| layer["booleanOperation"] == -1));
    assert_eq!(layers[0]["name"], "Alpha");
    assert_eq!(layers[1]["name"], "Beta");
    close(
        [
            layers[0]["style"]["fills"][0]["color"]["red"]
                .as_f64()
                .unwrap(),
            layers[0]["style"]["fills"][0]["color"]["green"]
                .as_f64()
                .unwrap(),
            layers[0]["style"]["fills"][0]["color"]["blue"]
                .as_f64()
                .unwrap(),
            layers[0]["style"]["fills"][0]["color"]["alpha"]
                .as_f64()
                .unwrap(),
        ],
        [
            0xDB as f64 / 255.,
            0x33 as f64 / 255.,
            0x44 as f64 / 255.,
            1.,
        ],
    );
    assert_eq!(
        layers[1]["style"]["fills"][0]["color"]["alpha"],
        0.7
    );

    let imported = import_sketch_report(&bytes).unwrap().document;
    let imported_alpha = imported
        .nodes
        .values()
        .find(|node| node.name == "Alpha")
        .unwrap();
    let imported_beta = imported
        .nodes
        .values()
        .find(|node| node.name == "Beta")
        .unwrap();
    assert_eq!(imported_alpha.kind, "rectangle");
    assert_eq!((imported_alpha.width, imported_alpha.height), (160., 100.));
    assert_eq!(
        (imported_alpha.transform.0[4], imported_alpha.transform.0[5]),
        (20., 20.)
    );
    assert_eq!(
        imported_alpha.fills[0].color.to_ascii_lowercase(),
        "#db3344"
    );
    assert_eq!(imported_alpha.fills[0].opacity, 1.);
    assert_eq!(imported_beta.kind, "ellipse");
    assert_eq!((imported_beta.width, imported_beta.height), (140., 100.));
    assert_eq!(
        (imported_beta.transform.0[4], imported_beta.transform.0[5]),
        (100., 70.)
    );
    close(
        channels(&imported_beta.fills[0].color),
        [0x33 as f64 / 255., 0x66 as f64 / 255., 0xDD as f64 / 255., 1.],
    );
    assert_eq!(imported_beta.fills[0].opacity, 0.7);
    assert!(imported_alpha.boolean_operation.is_none());
    assert!(imported_beta.boolean_operation.is_none());

    let session = open_exported(&bytes);
    assert_eq!(session.document().pages().len(), 1);
    assert_eq!(layer_count(session.document().pages()[0].root()), 3);
    let page_id = session.document().pages()[0].root().id().to_owned();
    let before = session.document().to_sketch().unwrap();
    let snapshot =
        display_snapshot(&session, &page_id).expect("identity page flags are not a page transform");
    assert_eq!(session.document().to_sketch().unwrap(), before);
    assert_eq!(snapshot.revision, session.revision());
    assert_eq!(snapshot.page_id, page_id);
    assert!(snapshot.artboards.is_empty());
    assert_eq!(snapshot.document.schema_version, 11);
    assert_eq!(snapshot.document.pages[0].children.len(), 2);

    let alpha = snapshot
        .document
        .nodes
        .values()
        .find(|node| node.name == "Alpha")
        .unwrap();
    let beta = snapshot
        .document
        .nodes
        .values()
        .find(|node| node.name == "Beta")
        .unwrap();
    assert_eq!(alpha.transform.0, [1., 0., 0., 1., 20., 20.]);
    assert_eq!((alpha.width, alpha.height), (160., 100.));
    assert!(alpha.boolean_operation.is_none());
    assert!(alpha.children.is_empty());
    close(
        channels(&alpha.fills[0].color),
        [
            0xDB as f64 / 255.,
            0x33 as f64 / 255.,
            0x44 as f64 / 255.,
            1.,
        ],
    );
    assert_eq!(alpha.fills[0].opacity, 1.);
    let corners = &alpha.network.as_ref().unwrap().vertices;
    assert_eq!(corners.len(), 4);
    for (vertex, expected) in corners
        .iter()
        .zip([(0., 0.), (160., 0.), (160., 100.), (0., 100.)])
    {
        assert!((vertex.x - expected.0).abs() < 1e-9 && (vertex.y - expected.1).abs() < 1e-9);
    }
    assert!(
        alpha
            .network
            .as_ref()
            .unwrap()
            .edges
            .iter()
            .all(|edge| edge.c1.is_none() && edge.c2.is_none())
    );

    assert_eq!(beta.transform.0, [1., 0., 0., 1., 100., 70.]);
    assert_eq!((beta.width, beta.height), (140., 100.));
    assert!(beta.boolean_operation.is_none());
    assert!(beta.children.is_empty());
    close(
        channels(&beta.fills[0].color),
        [
            0x33 as f64 / 255.,
            0x66 as f64 / 255.,
            0xDD as f64 / 255.,
            0.7,
        ],
    );
    assert_eq!(beta.fills[0].opacity, 1.);
    let oval = beta.network.as_ref().unwrap();
    assert_eq!(oval.vertices.len(), 4);
    assert!(
        oval.edges
            .iter()
            .any(|edge| edge.c1.is_some() && edge.c2.is_some())
    );
    assert!(
        oval.vertices
            .iter()
            .any(|vertex| (vertex.x - 140.).abs() < 1e-9 && (vertex.y - 50.).abs() < 1e-9)
    );

    let legacy = compile_preview(
        &session,
        &PreviewRequest {
            owner: session.owner().clone(),
            expected_revision: session.revision(),
            page_id,
            width: 512,
            height: 384,
        },
    );
    if let Ok(frame) = legacy {
        assert_eq!(
            frame.scene.nodes.len(),
            2,
            "a successful legacy frame must keep both shapes"
        );
    }
}

#[test]
fn non_identity_page_placement_and_rounded_corners_stay_rejected() {
    let bytes = export_sketch(&basic_shapes()).unwrap();
    for (key, value) in [
        ("rotation", json!(30)),
        ("isFlippedHorizontal", json!(true)),
        ("isFlippedVertical", json!(true)),
        ("transform", json!({"_class": "transform"})),
        ("affineTransform", json!("{1, 0, 0, 1, 0, 0}")),
    ] {
        let session = open_exported(&rewrite_page(&bytes, |page| {
            page[key] = value.clone();
        }));
        let page_id = session.document().pages()[0].root().id();
        let before = session.document().to_sketch().unwrap();
        let error = match display_snapshot(&session, page_id) {
            Ok(_) => panic!("{key} was admitted"),
            Err(error) => error,
        };
        assert!(
            matches!(error, Error::Unsupported(ref reason) if reason == "Sketch page transforms"),
            "{key} produced {error}"
        );
        assert_eq!(session.document().to_sketch().unwrap(), before);
    }
    let invalid = open_exported(&rewrite_page(&bytes, |page| {
        page["rotation"] = json!("0");
    }));
    let error = match display_snapshot(&invalid, invalid.document().pages()[0].root().id()) {
        Ok(_) => panic!("non-numeric page rotation was admitted"),
        Err(error) => error,
    };
    assert!(matches!(error, Error::Invalid(_)), "{error}");

    let mut rounded = basic_shapes();
    rounded.nodes.get_mut("alpha").unwrap().radii = [8., 8., 8., 8.];
    let session = open_exported(&export_sketch(&rounded).unwrap());
    let error = match display_snapshot(&session, session.document().pages()[0].root().id()) {
        Ok(_) => panic!("rounded rectangle corners were admitted"),
        Err(error) => error,
    };
    assert!(
        matches!(error, Error::Unsupported(ref reason) if reason.contains("corner radius")),
        "{error}"
    );
}
