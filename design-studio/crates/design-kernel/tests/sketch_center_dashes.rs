//! Sketch `borderOptions.centerDashes` ("在拐角居中") for the 83×51 control
//! paths: read, render, edit/undo, and write the switch back.
use futureox_design_kernel::editing::{DocumentEditor, DocumentPatch};
use futureox_design_kernel::interop::{export_sketch, import_sketch_report, read_zip_public};
use futureox_design_kernel::math::{Point, Rect, Transform};
use futureox_design_kernel::path::Path;
use futureox_design_kernel::raster::rasterize;
use futureox_design_kernel::scene::Stroke;
use futureox_design_kernel::stroke;
use serde_json::{json, Value};
use std::io::Write;

fn archive(layers: Value) -> Vec<u8> {
    let page = json!({
        "_class": "page",
        "do_objectID": "PAGE",
        "name": "Page",
        "layers": layers
    });
    let mut cursor = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut cursor);
    let options = zip::write::SimpleFileOptions::default();
    for (name, bytes) in [
        (
            "meta.json",
            serde_json::to_vec(&json!({"version": 180})).unwrap(),
        ),
        (
            "document.json",
            serde_json::to_vec(&json!({
                "_class": "document",
                "colorSpace": 1,
                "pages": [{"_class": "MSJSONFileReference", "_ref": "pages/PAGE"}]
            }))
            .unwrap(),
        ),
        ("pages/PAGE.json", serde_json::to_vec(&page).unwrap()),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap();
    cursor.into_inner()
}

fn layer(id: &str, closed: bool, center: Option<Value>) -> Value {
    let mut options = json!({
        "_class": "borderOptions",
        "isEnabled": true,
        "dashPattern": [8, 5],
        "lineCapStyle": 0,
        "lineJoinStyle": 0
    });
    if let Some(value) = center {
        options["centerDashes"] = value;
    }
    let points: Vec<Value> = if closed {
        ["{0, 0}", "{1, 0}", "{1, 1}", "{0, 1}"]
            .into_iter()
            .map(|point| json!({"_class": "curvePoint", "point": point, "curveMode": 1}))
            .collect()
    } else {
        ["{0, 0}", "{1, 0}", "{1, 1}"]
            .into_iter()
            .map(|point| json!({"_class": "curvePoint", "point": point, "curveMode": 1}))
            .collect()
    };
    json!({
        "_class": "shapePath",
        "do_objectID": id,
        "name": id,
        "frame": {"_class": "rect", "x": 0, "y": 0, "width": 83, "height": 51},
        "isClosed": closed,
        "points": points,
        "style": {
            "_class": "style",
            "fills": [],
            "borders": [{
                "_class": "border",
                "isEnabled": true,
                "fillType": 0,
                "thickness": 2,
                "position": 0,
                "color": {"_class": "color", "red": 0, "green": 0, "blue": 0, "alpha": 1}
            }],
            "borderOptions": options
        }
    })
}

fn coverage(doc: &futureox_design_kernel::scene::Document, id: &str) -> Vec<f32> {
    let node = &doc.nodes[id];
    let lines = node
        .paths()
        .unwrap()
        .1
        .flatten(Transform::default(), 0.25)
        .unwrap();
    let outline = stroke::expand(&lines, &node.strokes[0], 0.25, 0.).unwrap();
    rasterize(&outline, Rect::new(-2, -2, 88, 56), false).data
}

fn differing_pixels(a: &[f32], b: &[f32]) -> usize {
    a.iter()
        .zip(b)
        .filter(|(p, q)| (*p - *q).abs() > 0.01)
        .count()
}

fn stroke_of(cap: &str, join: &str, center: bool) -> Stroke {
    serde_json::from_value(json!({
        "paint": {"kind": "solid", "color": "#000000"},
        "width": 2,
        "cap": cap,
        "join": join,
        "dash": "8 5",
        "centerDashes": center
    }))
    .unwrap()
}

fn mask_at(stroke: &Stroke, points: &[Point], limit: Rect, x: i32, y: i32) -> f32 {
    let path = Path::polygon(points, false);
    let lines = path.flatten(Transform::default(), 0.05).unwrap();
    let outline = stroke::expand(&lines, stroke, 0.05, 0.).unwrap();
    rasterize(&outline, limit, false).at(x, y)
}

#[test]
fn control_pair_reads_renders_and_writes_center_dashes() {
    let bytes = archive(json!([
        layer("open-off", false, Some(json!(false))),
        layer("open-on", false, Some(json!(true))),
        layer("closed-off", true, Some(json!(false))),
        layer("closed-on", true, Some(json!(true))),
        layer("open-one", false, Some(json!(1))),
        layer("open-missing", false, None)
    ]));
    let doc = import_sketch_report(&bytes).unwrap().document;
    let open_off = &doc.nodes["open-off"].strokes[0];
    let open_on = &doc.nodes["open-on"].strokes[0];
    assert!(!open_off.center_dashes);
    assert!(open_on.center_dashes);
    assert!(doc.nodes["open-one"].strokes[0].center_dashes);
    assert!(!doc.nodes["open-missing"].strokes[0].center_dashes);
    assert!(!doc.nodes["closed-off"].strokes[0].center_dashes);
    assert!(doc.nodes["closed-on"].strokes[0].center_dashes);
    for id in [
        "open-off",
        "open-on",
        "closed-off",
        "closed-on",
        "open-one",
        "open-missing",
    ] {
        let stroke = &doc.nodes[id].strokes[0];
        assert_eq!(stroke.dash, "8,5", "{id}");
        assert_eq!(stroke.cap, "butt", "{id}");
        assert_eq!(stroke.join, "miter", "{id}");
        assert!((stroke.width - 2.).abs() < 1e-9, "{id}");
        assert_eq!(stroke.dash_offset, 0., "{id}");
    }
    let xs: Vec<f64> = doc.nodes["open-on"]
        .network
        .as_ref()
        .unwrap()
        .vertices
        .iter()
        .map(|vertex| vertex.x)
        .collect();
    assert!(
        xs.iter().any(|x| (*x - 83.).abs() < 1e-6),
        "pixel geometry {xs:?}"
    );

    let open_pixels = differing_pixels(&coverage(&doc, "open-off"), &coverage(&doc, "open-on"));
    let closed_pixels =
        differing_pixels(&coverage(&doc, "closed-off"), &coverage(&doc, "closed-on"));
    // Kernel coverage raster of the 83×51 control pair at thickness 2.
    // These are not native Sketch PNG counts.
    assert_eq!(open_pixels, 38);
    assert_eq!(closed_pixels, 216);

    let exported = export_sketch(&doc).unwrap();
    let files = read_zip_public(&exported).unwrap();
    let page: Value = serde_json::from_slice(
        files
            .iter()
            .find(|(name, _)| name.starts_with("pages/"))
            .unwrap()
            .1,
    )
    .unwrap();
    let mut seen = 0;
    for layer in page["layers"].as_array().unwrap() {
        let name = layer["name"].as_str().unwrap();
        let options = &layer["style"]["borderOptions"];
        let centered = matches!(name, "open-on" | "closed-on" | "open-one");
        assert_eq!(options["centerDashes"], json!(centered), "{name}");
        assert_eq!(options["dashPattern"], json!([8.0, 5.0]), "{name}");
        assert_eq!(options["lineCapStyle"], json!(0), "{name}");
        assert_eq!(options["lineJoinStyle"], json!(0), "{name}");
        seen += 1;
    }
    assert_eq!(seen, 6);

    let mut editor = DocumentEditor::new(doc).unwrap();
    let before = editor.document().clone();
    let mut node = editor.document().nodes["open-off"].clone();
    node.strokes[0].center_dashes = true;
    editor
        .apply(
            editor.revision(),
            DocumentPatch {
                nodes: [("open-off".into(), Some(node))].into(),
                ..Default::default()
            },
        )
        .unwrap();
    let edited = editor.document().nodes["open-off"].strokes[0].clone();
    assert!(edited.center_dashes);
    assert_eq!(edited.dash, before.nodes["open-off"].strokes[0].dash);
    assert_eq!(edited.cap, "butt");
    assert_eq!(edited.join, "miter");
    editor.undo().unwrap();
    assert_eq!(editor.document(), &before);
    editor.redo().unwrap();
    assert!(editor.document().nodes["open-off"].strokes[0].center_dashes);
    let rewritten = export_sketch(editor.document()).unwrap();
    let files = read_zip_public(&rewritten).unwrap();
    let page: Value = serde_json::from_slice(
        files
            .iter()
            .find(|(name, _)| name.starts_with("pages/"))
            .unwrap()
            .1,
    )
    .unwrap();
    let flipped = page["layers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|layer| layer["name"] == "open-off")
        .unwrap();
    assert_eq!(
        flipped["style"]["borderOptions"]["centerDashes"],
        json!(true)
    );
    assert_eq!(
        flipped["style"]["borderOptions"]["dashPattern"],
        json!([8.0, 5.0])
    );
}

#[test]
fn sharp_corner_dash_is_centered_without_changing_plain_dashes_caps_or_joins() {
    let points = [
        Point::new(0., 0.),
        Point::new(10., 0.),
        Point::new(10., 20.),
    ];
    let limit = Rect::new(-2, -2, 16, 26);
    let off = stroke_of("butt", "miter", false);
    let on = stroke_of("butt", "miter", true);
    // Distance 10 sits in the gap of dash 8 / gap 5. Centering puts a dash of
    // length 8 on that corner, four units along each side. Samples sit inside
    // pixels, not on a butt-cap boundary.
    assert!(
        mask_at(&off, &points, limit, 4, 0) > 0.5,
        "uncentered dash should cover x=4"
    );
    assert!(
        mask_at(&off, &points, limit, 9, 0) < 0.05,
        "uncentered gap should miss the corner"
    );
    assert!(
        mask_at(&on, &points, limit, 4, 0) < 0.05,
        "centered gap should miss x=4"
    );
    assert!(
        mask_at(&on, &points, limit, 9, 0) > 0.5,
        "centered dash should cover the corner"
    );
    assert!(
        mask_at(&on, &points, limit, 10, 2) > 0.5,
        "centered dash should continue past the corner"
    );
    assert!(
        mask_at(&off, &points, limit, 10, 2) < 0.05,
        "uncentered gap should miss the corner"
    );

    let straight = [Point::new(0., 0.), Point::new(40., 0.)];
    let straight_limit = Rect::new(-2, -2, 46, 8);
    let plain = mask_at(&off, &straight, straight_limit, 4, 0);
    let flagged = mask_at(&on, &straight, straight_limit, 4, 0);
    assert!((plain - flagged).abs() < 1e-6);
    let path = Path::polygon(&straight, false);
    let lines = path.flatten(Transform::default(), 0.05).unwrap();
    let a = stroke::expand(&lines, &off, 0.05, 0.).unwrap();
    let b = stroke::expand(&lines, &on, 0.05, 0.).unwrap();
    let words = |contours: &[futureox_design_kernel::path::Contour]| {
        contours
            .iter()
            .flat_map(|contour| {
                std::iter::once(u64::from(contour.closed)).chain(
                    contour
                        .points
                        .iter()
                        .flat_map(|point| [point.x.to_bits(), point.y.to_bits()]),
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(words(&a), words(&b));

    let miter = stroke_of("butt", "miter", true);
    let bevel = stroke_of("butt", "bevel", true);
    let square = stroke_of("square", "miter", true);
    let corner = Path::polygon(&points, false)
        .flatten(Transform::default(), 0.05)
        .unwrap();
    let miter_mask = rasterize(
        &stroke::expand(&corner, &miter, 0.05, 0.).unwrap(),
        limit,
        false,
    );
    let bevel_mask = rasterize(
        &stroke::expand(&corner, &bevel, 0.05, 0.).unwrap(),
        limit,
        false,
    );
    let square_mask = rasterize(
        &stroke::expand(&corner, &square, 0.05, 0.).unwrap(),
        limit,
        false,
    );
    assert_ne!(miter_mask.data, bevel_mask.data);
    assert_ne!(miter_mask.data, square_mask.data);

    let mut profiled = on.clone();
    profiled.width_profile = vec![
        futureox_design_kernel::stroke::WidthPoint {
            position: 0.,
            left: 1.,
            right: 1.,
        },
        futureox_design_kernel::stroke::WidthPoint {
            position: 1.,
            left: 0.5,
            right: 0.5,
        },
    ];
    let mut plain_profile = profiled.clone();
    plain_profile.center_dashes = false;
    let profiled_on = stroke::expand(&corner, &profiled, 0.05, 0.).unwrap();
    let profiled_off = stroke::expand(&corner, &plain_profile, 0.05, 0.).unwrap();
    assert_ne!(words(&profiled_on), words(&profiled_off));
}
