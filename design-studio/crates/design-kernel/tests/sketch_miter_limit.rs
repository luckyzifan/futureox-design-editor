//! Sketch stores `miterLimit` on the style. Import must keep that number and
//! use it when expanding a miter join. A missing field stays at 4. The
//! historical exporter constant on `borderOptions` is not an authored value.
use futureox_design_kernel::interop::{export_sketch, import_sketch_report, read_zip_public};
use futureox_design_kernel::math::Transform;
use futureox_design_kernel::sketch::preview::display_snapshot;
use futureox_design_kernel::sketch::{Document as SketchDocument, Session};
use futureox_design_kernel::{Engine, RenderOptions, stroke};
use serde_json::{Value, json};
use std::io::{Cursor, Write};

const SEMANTIC: &[u8] = include_bytes!(
    "../../../../testing/fixtures/sketch-public-20261105/semantic-ui-kit-for-sketch/semantic-ui-kit.sketch"
);

fn archive(document: Value, layers: Value) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for (name, value) in [
        ("meta.json", json!({"version": 144, "appVersion": "2025.1"})),
        ("document.json", document),
        (
            "pages/p.json",
            json!({
                "_class": "page",
                "do_objectID": "p",
                "name": "Native",
                "booleanOperation": -1,
                "exportOptions": {},
                "horizontalRulerData": {},
                "layers": layers
            }),
        ),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn document(extra: Value) -> Value {
    let mut root = json!({
        "_class": "document",
        "do_objectID": "DOC",
        "colorSpace": 1,
        "pages": [{"_class": "MSJSONFileReference", "_ref": "pages/p"}]
    });
    if let (Some(root), Some(extra)) = (root.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            root.insert(key.clone(), value.clone());
        }
    }
    root
}

fn border() -> Value {
    json!({
        "_class": "border",
        "isEnabled": true,
        "fillType": 0,
        "thickness": 8,
        "position": 0,
        "color": {"_class": "color", "red": 0, "green": 0, "blue": 0, "alpha": 1}
    })
}

fn layer(
    id: &str,
    points: &[&str],
    closed: bool,
    miter: Option<Value>,
    border_miter: Option<Value>,
) -> Value {
    let mut options = json!({
        "_class": "borderOptions",
        "isEnabled": true,
        "dashPattern": [],
        "lineCapStyle": 0,
        "lineJoinStyle": 0
    });
    if let Some(value) = border_miter {
        options["miterLimit"] = value;
    }
    let mut style = json!({
        "_class": "style",
        "fills": [],
        "borders": [border()],
        "borderOptions": options
    });
    if let Some(value) = miter {
        style["miterLimit"] = value;
    }
    json!({
        "_class": "shapePath",
        "do_objectID": id,
        "name": id,
        "frame": {"_class": "rect", "x": 20, "y": 20, "width": 40, "height": 40},
        "isClosed": closed,
        "points": points.iter().map(|point| json!({
            "_class": "curvePoint",
            "point": point,
            "curveMode": 1,
            "hasCurveFrom": false,
            "hasCurveTo": false
        })).collect::<Vec<_>>(),
        "style": style
    })
}

/// Open 15° corner. 1/sin(7.5°) is about 7.66, so limit 4 bevels and 10 does not.
fn sharp(id: &str, miter: Option<Value>) -> Value {
    layer(
        id,
        &[
            "{0.5, 0}",
            "{0, 0}",
            "{0.48296291314453415, 0.1294095225512604}",
        ],
        false,
        miter,
        None,
    )
}

fn square(id: &str, miter: Option<Value>) -> Value {
    layer(
        id,
        &["{0, 0}", "{1, 0}", "{1, 1}", "{0, 1}"],
        true,
        miter,
        None,
    )
}

fn lossy(doc: &futureox_design_kernel::scene::Document, id: &str) -> Vec<String> {
    doc.design_system
        .as_ref()
        .and_then(|system| system.sketch_containers.get("nodeMetadata"))
        .and_then(|metadata| metadata.get(id))
        .and_then(|entry| entry.pointer("/bindings/sketchImportLossy"))
        .and_then(Value::as_str)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default()
}

fn render(doc: &futureox_design_kernel::scene::Document) -> Vec<u8> {
    let mut engine = Engine::new();
    engine
        .load_document(&serde_json::to_string(doc).unwrap())
        .unwrap();
    let options: RenderOptions = serde_json::from_value(json!({
        "pageId": doc.pages[0].id,
        "width": 96,
        "height": 96,
        "view": {"x": -16, "y": -16, "zoom": 1},
        "transparent": true,
        "checkerboard": false,
        "grid": false,
        "rasterProfile": "analytic"
    }))
    .unwrap();
    engine.render(&options).unwrap()
}

fn differing_pixels(a: &[u8], b: &[u8]) -> usize {
    a.chunks(4).zip(b.chunks(4)).filter(|(p, q)| p != q).count()
}

fn outline_bits(doc: &futureox_design_kernel::scene::Document, id: &str) -> Vec<(u64, u64)> {
    let node = &doc.nodes[id];
    let lines = node
        .paths()
        .unwrap()
        .1
        .flatten(Transform::default(), 0.05)
        .unwrap();
    stroke::expand(&lines, &node.strokes[0], 0.05, 0.)
        .unwrap()
        .into_iter()
        .flat_map(|contour| {
            contour
                .points
                .into_iter()
                .map(|point| (point.x.to_bits(), point.y.to_bits()))
        })
        .collect()
}

fn page_json(bytes: &[u8]) -> Value {
    let files = read_zip_public(bytes).unwrap();
    serde_json::from_slice(
        files
            .iter()
            .find(|(name, _)| name.starts_with("pages/"))
            .unwrap()
            .1,
    )
    .unwrap()
}

#[test]
fn authored_style_miter_limit_changes_the_sharp_corner_and_round_trips() {
    let bytes = archive(
        document(json!({
            "layerStyles": {
                "_class": "sharedStyleContainer",
                "objects": [{
                    "_class": "sharedStyle",
                    "do_objectID": "11111111-1111-4111-8111-111111111111",
                    "name": "Sharp",
                    "value": {
                        "_class": "style",
                        "miterLimit": 2,
                        "fills": [{
                            "_class": "fill", "isEnabled": true, "fillType": 0,
                            "color": {"_class": "color", "red": 0, "green": 0, "blue": 0, "alpha": 1}
                        }],
                        "borders": [border()],
                        "borderOptions": {
                            "_class": "borderOptions",
                            "isEnabled": true,
                            "dashPattern": [],
                            "lineCapStyle": 0,
                            "lineJoinStyle": 0
                        }
                    }
                }]
            }
        })),
        json!([
            sharp("ten", Some(json!(10))),
            sharp("four", Some(json!(4))),
            sharp("absent", None),
            sharp("tight", Some(json!(1.25))),
            sharp("bad", Some(json!(-1))),
            square("square-ten", Some(json!(10))),
            square("square-four", Some(json!(4))),
            square("square-tight", Some(json!(1.25))),
            layer(
                "options-only",
                &[
                    "{0.5, 0}",
                    "{0, 0}",
                    "{0.48296291314453415, 0.1294095225512604}"
                ],
                false,
                None,
                Some(json!(10)),
            )
        ]),
    );
    let report = import_sketch_report(&bytes).unwrap();
    let doc = &report.document;
    let limit = |id: &str| doc.nodes[id].strokes[0].miter_limit;
    let sharp_ten = render(
        &import_sketch_report(&archive(
            document(json!({})),
            json!([sharp("ten", Some(json!(10)))]),
        ))
        .unwrap()
        .document,
    );
    let sharp_four = render(
        &import_sketch_report(&archive(
            document(json!({})),
            json!([sharp("four", Some(json!(4)))]),
        ))
        .unwrap()
        .document,
    );
    let sharp_absent = render(
        &import_sketch_report(&archive(
            document(json!({})),
            json!([sharp("absent", None)]),
        ))
        .unwrap()
        .document,
    );
    let square_ten = render(
        &import_sketch_report(&archive(
            document(json!({})),
            json!([square("square-ten", Some(json!(10)))]),
        ))
        .unwrap()
        .document,
    );
    let square_four = render(
        &import_sketch_report(&archive(
            document(json!({})),
            json!([square("square-four", Some(json!(4)))]),
        ))
        .unwrap()
        .document,
    );
    let square_tight = render(
        &import_sketch_report(&archive(
            document(json!({})),
            json!([square("square-tight", Some(json!(1.25)))]),
        ))
        .unwrap()
        .document,
    );
    let diff = differing_pixels(&sharp_ten, &sharp_four);
    let square_diff = differing_pixels(&square_tight, &square_four);
    assert!((limit("ten") - 10.).abs() < 1e-12);
    assert!((limit("four") - 4.).abs() < 1e-12);
    assert!((limit("absent") - 4.).abs() < 1e-12);
    assert!((limit("tight") - 1.25).abs() < 1e-12);
    assert!((limit("bad") - 4.).abs() < 1e-12);
    assert!((limit("square-ten") - 10.).abs() < 1e-12);
    // borderOptions.miterLimit is the historical exporter constant, not Sketch's field.
    assert!((limit("options-only") - 4.).abs() < 1e-12);
    assert!(lossy(doc, "ten").is_empty(), "{:?}", lossy(doc, "ten"));
    assert!(
        lossy(doc, "bad")
            .iter()
            .any(|note| note.contains("miterLimit")),
        "{:?}",
        lossy(doc, "bad")
    );
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("miterLimit"))
    );
    let stored = serde_json::to_value(&doc.nodes["ten"].strokes[0]).unwrap();
    assert!((stored["miterLimit"].as_f64().unwrap() - 10.).abs() < 1e-12);
    assert!(
        serde_json::to_value(&doc.nodes["absent"].strokes[0])
            .unwrap()
            .get("miterLimit")
            .is_none()
    );

    assert_ne!(outline_bits(&doc, "ten"), outline_bits(&doc, "four"));
    assert_eq!(outline_bits(&doc, "four"), outline_bits(&doc, "absent"));
    // 1/sin(45°) is about 1.414, so 1.25 bevels a right angle and 4 does not.
    assert_ne!(
        outline_bits(&doc, "square-tight"),
        outline_bits(&doc, "square-four")
    );
    assert_ne!(sharp_ten, sharp_four);
    assert_eq!(sharp_four, sharp_absent);
    assert_eq!(square_ten, square_four);
    assert_ne!(square_tight, square_four);
    assert!(diff > 0);
    assert!(square_diff > 0);

    let shared = doc
        .design_system
        .as_ref()
        .unwrap()
        .styles
        .get("11111111-1111-4111-8111-111111111111")
        .unwrap();
    assert!((shared.strokes[0].miter_limit - 2.).abs() < 1e-12);

    let session = Session::new(
        SketchDocument::from_sketch(&bytes).unwrap(),
        "a531a01d-6bd7-42c4-a30c-8d0d9145df82".into(),
        1,
    )
    .unwrap();
    let preview = display_snapshot(&session, "p").unwrap();
    assert!((preview.document.nodes["ten"].strokes[0].miter_limit - limit("ten")).abs() < 1e-12);
    assert!(
        preview
            .warnings
            .iter()
            .any(|note| note.contains("miterLimit"))
    );

    let exported = export_sketch(&doc).unwrap();
    let page = page_json(&exported);
    let exported_limit = |id: &str| {
        page["layers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|layer| layer["name"] == id)
            .unwrap_or_else(|| panic!("missing exported layer {id}"))["style"]["miterLimit"]
            .clone()
    };
    let near = |value: Value, expected: f64| {
        let actual = value
            .as_f64()
            .unwrap_or_else(|| panic!("not a number: {value}"));
        assert!((actual - expected).abs() < 1e-9, "{actual} != {expected}");
    };
    near(exported_limit("ten"), 10.);
    near(exported_limit("tight"), 1.25);
    near(exported_limit("absent"), 4.);
    near(exported_limit("options-only"), 4.);
    let files = read_zip_public(&exported).unwrap();
    let document: Value = serde_json::from_slice(&files["document.json"]).unwrap();
    let shared_style = document["layerStyles"]["objects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|style| style["name"] == "Sharp")
        .expect("shared style")
        .get("value")
        .unwrap();
    assert!((shared_style["miterLimit"].as_f64().unwrap() - 2.).abs() < 1e-9);
    assert!(shared_style["borderOptions"].get("miterLimit").is_none());
    let reopened = import_sketch_report(&exported).unwrap().document;
    assert!((reopened.nodes["ten"].strokes[0].miter_limit - 10.).abs() < 1e-12);
    assert!((reopened.nodes["tight"].strokes[0].miter_limit - 1.25).abs() < 1e-12);
    assert!((reopened.nodes["absent"].strokes[0].miter_limit - 4.).abs() < 1e-12);
    assert!((reopened.nodes["options-only"].strokes[0].miter_limit - 4.).abs() < 1e-12);
}

#[test]
fn semantic_ui_kit_keeps_the_authored_miter_limit() {
    let doc = import_sketch_report(SEMANTIC).unwrap().document;
    let strokes: Vec<_> = doc.nodes.values().flat_map(|node| &node.strokes).collect();
    assert!(!strokes.is_empty());
    assert!(
        strokes
            .iter()
            .all(|stroke| (stroke.miter_limit - 10.).abs() < 1e-9)
    );
}
