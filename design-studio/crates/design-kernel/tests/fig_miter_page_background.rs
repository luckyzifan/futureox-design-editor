//! FIG miterLimit and page-background opacity survive import and affect pixels.
use futureox_design_kernel::math::Point;
use futureox_design_kernel::path::Contour;
use futureox_design_kernel::{Engine, RenderOptions, fig, stroke};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn guid(session: u64, local: u64) -> Value {
    json!({"sessionID": session, "localID": local})
}

fn import(tree: Value) -> Result<futureox_design_kernel::scene::Document, fig::Error> {
    fig::document_from_canvas(&tree, BTreeMap::new(), Vec::new())
}

fn canvas(fields: Value) -> Value {
    let mut node = json!({
        "guid": guid(1, 1),
        "phase": "CREATED",
        "type": "CANVAS",
        "name": "Page",
        "parentIndex": {"guid": guid(0, 0), "position": ""},
    });
    if let (Some(obj), Some(extra)) = (node.as_object_mut(), fields.as_object()) {
        for (key, value) in extra {
            obj.insert(key.clone(), value.clone());
        }
    }
    json!({"nodeChanges": [node]})
}

fn rect(miter: Value) -> Value {
    let mut node = json!({
        "guid": guid(1, 2),
        "phase": "CREATED",
        "type": "RECTANGLE",
        "name": "Corner",
        "parentIndex": {"guid": guid(1, 1), "position": "!"},
        "size": {"x": 30, "y": 30},
        "fillPaints": [],
        "strokePaints": [{"type": "SOLID", "color": {"r": 0, "g": 0, "b": 0, "a": 1}}],
        "strokeWeight": 8,
        "strokeJoin": "MITER",
        "strokeAlign": "CENTER",
        "strokeCap": "NONE",
    });
    if !miter.is_null() {
        node["miterLimit"] = miter;
    }
    let page = json!({
        "guid": guid(1, 1),
        "phase": "CREATED",
        "type": "CANVAS",
        "name": "Page",
        "parentIndex": {"guid": guid(0, 0), "position": ""},
        "backgroundColor": {"r": 1, "g": 1, "b": 1, "a": 1},
    });
    json!({"nodeChanges": [page, node]})
}

fn render(doc: &futureox_design_kernel::scene::Document) -> Vec<u8> {
    let mut engine = Engine::new();
    engine
        .load_document(&serde_json::to_string(doc).unwrap())
        .unwrap();
    let options: RenderOptions = serde_json::from_value(json!({
        "pageId": doc.pages[0].id,
        "width": 64,
        "height": 64,
        "view": {"x": -20, "y": -20, "zoom": 1},
        "transparent": false,
        "checkerboard": false,
        "grid": false,
        "rasterProfile": "analytic",
    }))
    .unwrap();
    engine.render(&options).unwrap()
}

fn fig_note(doc: &futureox_design_kernel::scene::Document, id: &str) -> Option<String> {
    doc.design_system
        .as_ref()?
        .sketch_containers
        .get("nodeMetadata")?
        .get(id)?
        .pointer("/bindings/figUntranslated")?
        .as_str()
        .map(str::to_owned)
}

fn outline_bits(contours: &[Contour]) -> Vec<(bool, Vec<(u64, u64)>)> {
    contours
        .iter()
        .map(|contour| {
            (
                contour.closed,
                contour
                    .points
                    .iter()
                    .map(|point| (point.x.to_bits(), point.y.to_bits()))
                    .collect(),
            )
        })
        .collect()
}

fn corner() -> Contour {
    Contour {
        points: vec![Point::new(0., 30.), Point::new(0., 0.), Point::new(30., 0.)],
        closed: false,
    }
}

/// About 15° at the origin. 1/sin(7.5°) is roughly 7.66, so a limit of 4
/// bevels and a limit of 10 keeps the tip.
fn sharp() -> Contour {
    Contour {
        points: vec![
            Point::new(20., 0.),
            Point::new(0., 0.),
            Point::new(19.318516525781366, 5.176380902050416),
        ],
        closed: false,
    }
}

#[test]
fn page_background_keeps_opacity_and_the_off_switch() {
    let half = import(canvas(json!({
        "backgroundColor": {"r": 1, "g": 0, "b": 0, "a": 0.5},
        "backgroundOpacity": 0.5,
        "backgroundEnabled": true,
    })))
    .unwrap();
    let opacity_only = import(canvas(json!({
        "backgroundColor": {"r": 1, "g": 0, "b": 0, "a": 1},
        "backgroundOpacity": 0.5,
    })))
    .unwrap();
    let off = import(canvas(json!({
        "backgroundColor": {"r": 0, "g": 1, "b": 0, "a": 1},
        "backgroundEnabled": false,
    })))
    .unwrap();
    let plain = import(canvas(json!({}))).unwrap();
    let opaque = import(canvas(json!({
        "backgroundColor": {"r": 1, "g": 0, "b": 0, "a": 1},
        "backgroundEnabled": true,
    })))
    .unwrap();

    assert_eq!(half.pages[0].background, "color(srgb 1 0 0 / 0.25)");
    assert_eq!(opacity_only.pages[0].background, "color(srgb 1 0 0 / 0.5)");
    assert_eq!(off.pages[0].background, "color(srgb 0 1 0 / 0)");
    assert_eq!(plain.pages[0].background, "#ffffff");
    assert_eq!(opaque.pages[0].background, "#ff0000");

    let reopened: futureox_design_kernel::scene::Document =
        serde_json::from_str(&serde_json::to_string(&half).unwrap()).unwrap();
    assert_eq!(reopened.pages[0].background, half.pages[0].background);

    let half_px = render(&half);
    let off_px = render(&off);
    let plain_px = render(&plain);
    // Straight RGBA. 0.25 * 255 rounds to 64; the disabled page contributes no coverage.
    assert_eq!(&half_px[..4], &[255, 0, 0, 64]);
    assert_eq!(off_px[3], 0);
    assert_ne!(&off_px[..4], &[0, 255, 0, 255]);
    assert_eq!(&plain_px[..4], &[255, 255, 255, 255]);

    let bad = import(canvas(json!({"backgroundOpacity": 2})));
    assert!(bad.unwrap_err().to_string().contains("backgroundOpacity"));
}

#[test]
fn miter_limit_is_imported_and_changes_the_corner() {
    let sharp_doc = import(rect(json!(1.25))).unwrap();
    let normal = import(rect(json!(4.0))).unwrap();
    let absent = import(rect(Value::Null)).unwrap();
    let wider = import(rect(json!(10.0))).unwrap();
    let invalid = import(rect(json!(-1))).unwrap();

    let stroke = &sharp_doc.nodes["fig-1-2"].strokes[0];
    assert_eq!(stroke.join, "miter");
    assert!((stroke.miter_limit - 1.25).abs() < 1e-12);
    assert!(fig_note(&sharp_doc, "fig-1-2").is_none());
    assert_eq!(normal.nodes["fig-1-2"].strokes[0].miter_limit, 4.);
    assert_eq!(absent.nodes["fig-1-2"].strokes[0].miter_limit, 4.);
    assert_eq!(wider.nodes["fig-1-2"].strokes[0].miter_limit, 10.);
    assert_eq!(invalid.nodes["fig-1-2"].strokes[0].miter_limit, 4.);
    let note = fig_note(&invalid, "fig-1-2").unwrap();
    assert!(note.contains("miterLimit"), "{note}");

    let stored = serde_json::to_value(&sharp_doc.nodes["fig-1-2"].strokes[0]).unwrap();
    assert_eq!(stored["miterLimit"], json!(1.25));
    let omitted = serde_json::to_value(&absent.nodes["fig-1-2"].strokes[0]).unwrap();
    assert!(omitted.get("miterLimit").is_none());
    let reopened: futureox_design_kernel::scene::Document =
        serde_json::from_str(&serde_json::to_string(&sharp_doc).unwrap()).unwrap();
    assert_eq!(reopened.nodes["fig-1-2"].strokes[0].miter_limit, 1.25);

    let tight = stroke::expand(
        &[corner()],
        &sharp_doc.nodes["fig-1-2"].strokes[0],
        0.05,
        0.,
    )
    .unwrap();
    let capped =
        stroke::expand(&[corner()], &normal.nodes["fig-1-2"].strokes[0], 0.05, 0.).unwrap();
    let omitted_outline =
        stroke::expand(&[corner()], &absent.nodes["fig-1-2"].strokes[0], 0.05, 0.).unwrap();
    assert_ne!(outline_bits(&tight), outline_bits(&capped));
    assert_eq!(outline_bits(&capped), outline_bits(&omitted_outline));

    let mut profiled = wider.nodes["fig-1-2"].strokes[0].clone();
    profiled.width_profile = vec![
        stroke::WidthPoint {
            position: 0.,
            left: 1.,
            right: 1.,
        },
        stroke::WidthPoint {
            position: 1.,
            left: 1.,
            right: 1.,
        },
    ];
    let mut profiled_cap = profiled.clone();
    profiled_cap.miter_limit = 4.;
    let sharp_path = sharp();
    let long = stroke::expand(&[sharp_path.clone()], &profiled, 0.05, 0.).unwrap();
    let bevel = stroke::expand(&[sharp_path], &profiled_cap, 0.05, 0.).unwrap();
    assert_ne!(
        outline_bits(&long),
        outline_bits(&bevel),
        "a 15° corner is past the fixed cap of 4 and inside 10"
    );

    let sharp_px = render(&sharp_doc);
    let normal_px = render(&normal);
    let absent_px = render(&absent);
    assert_ne!(sharp_px, normal_px);
    assert_eq!(normal_px, absent_px);
    let dark = |bytes: &[u8]| {
        bytes
            .chunks(4)
            .filter(|px| px[0] < 16 && px[3] > 200)
            .count()
    };
    assert!(dark(&normal_px) > dark(&sharp_px));
    assert_eq!(
        stroke::allowance_scale(&normal.nodes["fig-1-2"].strokes[0]),
        4.
    );
    assert_eq!(
        stroke::allowance_scale(&wider.nodes["fig-1-2"].strokes[0]),
        10.
    );

    let page = sharp_doc.pages[0].id.clone();
    let svg_sharp = futureox_design_kernel::svg_export::export_svg(&sharp_doc, &page).unwrap();
    assert!(
        svg_sharp.contains("stroke-miterlimit=\"1.25\""),
        "{svg_sharp}"
    );
    let svg_default =
        futureox_design_kernel::svg_export::export_svg(&absent, &absent.pages[0].id).unwrap();
    assert!(svg_default.contains("stroke-linejoin=\"miter\""));
    assert!(!svg_default.contains("stroke-miterlimit"), "{svg_default}");
}
