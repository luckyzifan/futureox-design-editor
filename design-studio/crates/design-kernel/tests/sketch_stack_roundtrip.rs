use futureox_design_kernel::{
    Engine,
    font::Fonts,
    interop::{export_sketch, import_sketch_report, read_zip_public},
    layout,
    scene::Document,
};
use serde_json::{Value, json};
use std::{io::Cursor, io::Write, path::Path};

const WRAP_NOTE: &str = "stack-wrap-omitted";
const LINE_GAP_NOTE: &str = "stack-line-gap-omitted";

fn wrapping_stack(gap: f64) -> Document {
    serde_json::from_value(json!({
        "schemaVersion": 29, "id": "d", "name": "Wrapped stack",
        "pages": [{"id": "p", "name": "Page", "background": "#ffffff", "children": ["stack"]}],
        "nodes": {
            "stack": {"id": "stack", "kind": "frame", "width": 120, "height": 100,
                "children": ["a", "b", "c"], "sizing": {"height": "hug"},
                "layout": {"mode": "horizontal", "wrap": true, "lineGap": gap,
                    "gap": 0, "padding": [0, 0, 0, 0], "justify": "start", "align": "start"}},
            "a": {"id": "a", "kind": "rectangle", "width": 50, "height": 20},
            "b": {"id": "b", "kind": "rectangle", "width": 50, "height": 20},
            "c": {"id": "c", "kind": "rectangle", "width": 50, "height": 20}
        }
    })).unwrap()
}

fn first_sketch_page(bytes: &[u8]) -> Value {
    let files = read_zip_public(bytes).unwrap();
    let (_, page) = files.iter().find(|(name, _)| name.starts_with("pages/")).unwrap();
    serde_json::from_slice(page).unwrap()
}

fn first_sketch_layer(bytes: &[u8]) -> Value {
    first_sketch_page(bytes)["layers"][0].clone()
}

fn with_first_sketch_layer(bytes: &[u8], edit: impl FnOnce(&mut Value)) -> Vec<u8> {
    let mut files = read_zip_public(bytes).unwrap();
    let (_, page) = files.iter_mut().find(|(name, _)| name.starts_with("pages/")).unwrap();
    let mut contents: Value = serde_json::from_slice(page).unwrap();
    edit(&mut contents["layers"][0]);
    *page = serde_json::to_vec(&contents).unwrap();
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, contents) in files {
        archive.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        archive.write_all(&contents).unwrap();
    }
    archive.finish().unwrap().into_inner()
}

fn layer_named<'a>(layer: &'a Value, name: &str) -> Option<&'a Value> {
    if layer["name"] == name {
        return Some(layer);
    }
    layer["layers"].as_array()?.iter().find_map(|child| layer_named(child, name))
}

fn box_at(doc: &Document, id: &str) -> [f64; 4] {
    let node = &doc.nodes[id];
    [node.transform.0[4], node.transform.0[5], node.width, node.height]
}

#[test]
fn wrap_and_cross_axis_gap_survive_sketch_without_omission_notes() {
    let fonts = Fonts::new();
    for gap in [6., 8., -8.] {
        let mut doc = wrapping_stack(gap);
        layout::resolve(&mut doc, &fonts).unwrap();
        assert_eq!(doc.nodes["c"].transform.0[5], 20. + gap);
        assert_eq!(doc.nodes["stack"].height, 40. + gap);

        let archive = export_sketch(&doc).unwrap();
        let layer = first_sketch_layer(&archive);
        assert_eq!(layer["groupLayout"]["wrappingEnabled"], true);
        assert_eq!(layer["groupLayout"]["crossAxisGutterGap"], gap);
        let notes = layer["userInfo"]["com.futureox.design-kernel"]["lossy"].as_array();
        assert!(!notes.is_some_and(|notes| notes.iter().any(|note| note == WRAP_NOTE || note == LINE_GAP_NOTE)));

        let reopened = import_sketch_report(&archive).unwrap();
        assert!(!reopened.warnings.iter().any(|warning| warning.contains(WRAP_NOTE) || warning.contains(LINE_GAP_NOTE)));
        let mut doc = reopened.document;
        let stack = doc.nodes["stack"].layout.as_ref().unwrap();
        assert!(stack.wrap);
        assert_eq!(stack.line_gap, gap);
        layout::resolve(&mut doc, &fonts).unwrap();
        assert_eq!(doc.nodes["c"].transform.0[5], 20. + gap);
        assert_eq!(doc.nodes["stack"].height, 40. + gap);
    }
}

#[test]
fn old_omission_notes_are_filtered_only_for_restored_stack_fields() {
    let archive = export_sketch(&wrapping_stack(-8.)).unwrap();
    for restored in [true, false] {
        let archive = with_first_sketch_layer(&archive, |layer| {
            layer["userInfo"]["com.futureox.design-kernel"]["lossy"] =
                json!([WRAP_NOTE, LINE_GAP_NOTE, "stack-align-not-supported"]);
            if !restored {
                let layout = layer["groupLayout"].as_object_mut().unwrap();
                layout.remove("wrappingEnabled");
                layout.remove("crossAxisGutterGap");
            }
        });
        let report = import_sketch_report(&archive).unwrap();
        let warns = |note| report.warnings.iter().any(|warning| warning == &format!("Sketch: {note}"));
        assert_eq!(warns(WRAP_NOTE), !restored);
        assert_eq!(warns(LINE_GAP_NOTE), !restored);
        assert!(warns("stack-align-not-supported"));
    }
}

#[test]
fn authored_fill_and_hug_resize_after_sketch_reopen() {
    let mut doc: Document = serde_json::from_value(json!({
        "schemaVersion": 29, "id": "d", "name": "Stack sizing",
        "pages": [{"id": "p", "name": "Page", "background": "#ffffff", "children": ["stack"]}],
        "nodes": {
            "stack": {"id": "stack", "name": "stack", "kind": "frame", "width": 200, "height": 80,
                "children": ["fill", "hug", "fixed"], "sizing": {"height": "hug"},
                "layout": {"mode": "horizontal", "gap": 10, "lineGap": 6, "padding": [10,10,10,10],
                    "justify": "start", "align": "start", "wrap": true}},
            "fill": {"id": "fill", "name": "fill", "kind": "rectangle", "width": 10, "height": 10,
                "sizing": {"width": "fill", "height": "fill"}},
            "hug": {"id": "hug", "name": "hug", "kind": "frame", "width": 30, "height": 15,
                "children": ["content"], "sizing": {"width": "hug"},
                "layout": {"mode": "horizontal", "gap": 0, "padding": [0,0,0,0]}},
            "content": {"id": "content", "kind": "rectangle", "width": 30, "height": 15},
            "fixed": {"id": "fixed", "name": "fixed", "kind": "rectangle", "width": 25, "height": 18}
        }
    })).unwrap();
    let fonts = Fonts::new();
    layout::resolve(&mut doc, &fonts).unwrap();
    // The existing layout solver normalizes a cyclic Hug/Fill axis to Fixed.
    assert_eq!(doc.nodes["stack"].sizing_value().height, layout::SizeMode::Fixed);
    assert_eq!(box_at(&doc, "fill"), [10., 10., 105., 60.]);
    let mut resized = doc.clone();
    resized.nodes.get_mut("stack").unwrap().width = 260.;
    layout::resolve(&mut resized, &fonts).unwrap();
    assert_eq!(box_at(&resized, "fill"), [10., 10., 165., 60.]);

    let archive = export_sketch(&doc).unwrap();
    let layer = first_sketch_layer(&archive);
    for (name, x, y) in [("stack", 0, 0), ("fill", 2, 2), ("hug", 1, 0), ("fixed", 0, 0)] {
        let layer = layer_named(&layer, name).unwrap();
        assert_eq!(layer["horizontalSizing"], x, "{name} horizontal sizing");
        assert_eq!(layer["verticalSizing"], y, "{name} vertical sizing");
    }
    let mut reopened = import_sketch_report(&archive).unwrap().document;
    assert_eq!(reopened.nodes["fill"].sizing_value().height, layout::SizeMode::Fill);
    assert_eq!(reopened.nodes["hug"].sizing_value().width, layout::SizeMode::Hug);
    reopened.nodes.get_mut("stack").unwrap().width = 260.;
    layout::resolve(&mut reopened, &fonts).unwrap();
    for id in ["stack", "fill", "hug", "fixed"] {
        assert_eq!(box_at(&reopened, id), box_at(&resized, id));
    }
}

#[test]
fn independent_stack_hug_axis_still_fits_edited_content_after_reopen() {
    let fonts = Fonts::new();
    let mut doc = wrapping_stack(6.);
    layout::resolve(&mut doc, &fonts).unwrap();
    assert_eq!(doc.nodes["stack"].height, 46.);
    let archive = export_sketch(&doc).unwrap();
    assert_eq!(first_sketch_layer(&archive)["verticalSizing"], 1);
    let mut reopened = import_sketch_report(&archive).unwrap().document;
    assert_eq!(reopened.nodes["stack"].sizing_value().height, layout::SizeMode::Hug);
    reopened.nodes.get_mut("c").unwrap().height = 24.;
    layout::resolve(&mut reopened, &fonts).unwrap();
    assert_eq!(reopened.nodes["stack"].height, 50.);
}

#[test]
fn imported_sketch_fixture_fill_resizes_and_exports_with_its_existing_code() {
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let fixture = std::fs::read(project.join("testing/fixtures/regression/sketch-text-layout-flow.sketch")).unwrap();
    let mut doc = import_sketch_report(&fixture).unwrap().document;
    let mut engine = Engine::new();
    engine.load_font(&std::fs::read(project.join("frontend/design-client/public/fonts/NotoSansSC.ttf")).unwrap()).unwrap();
    engine.load_document(&serde_json::to_string(&doc).unwrap()).unwrap();
    let id = doc.nodes.values().find(|node| node.name == "stack-32").unwrap().id.clone();
    let parent = doc.nodes.values().find(|node| node.children.contains(&id)).unwrap().id.clone();
    assert_eq!(doc.nodes[&id].sizing_value().width, layout::SizeMode::Fill);
    assert_eq!(doc.nodes[&parent].width, 240.);
    layout::resolve(&mut doc, &engine.fonts).unwrap();
    assert_eq!(box_at(&doc, &id), [66., 16., 158., 40.]);
    doc.nodes.get_mut(&parent).unwrap().width = 300.;
    layout::resolve(&mut doc, &engine.fonts).unwrap();
    assert_eq!(box_at(&doc, &id), [66., 16., 218., 40.]);
    let archive = export_sketch(&doc).unwrap();
    let page = first_sketch_page(&archive);
    let layer = layer_named(&page, "stack-32").unwrap();
    assert_eq!(layer["horizontalSizing"], 2);
    assert_eq!(layer["frame"]["width"], 218.);

    let mut reopened = import_sketch_report(&archive).unwrap().document;
    layout::resolve(&mut reopened, &engine.fonts).unwrap();
    assert_eq!(reopened.nodes[&id].sizing_value().width, layout::SizeMode::Fill);
    assert_eq!(box_at(&reopened, &id), [66., 16., 218., 40.]);
}

fn frame_with_pins(pins: Option<[&str; 2]>) -> Document {
    let constraints = pins.map(|[horizontal, vertical]| json!({"horizontal":horizontal,"vertical":vertical}));
    serde_json::from_value(json!({
        "schemaVersion": 29, "id": "d", "name": "Frame pins",
        "pages": [{"id":"p","name":"Page","background":"#ffffff","children":["frame"]}],
        "nodes": {
            "frame": {"id":"frame","kind":"frame","width":300,"height":200,"children":["child"]},
            "child": {"id":"child","kind":"rectangle","width":40,"height":50,
                "transform":[1,0,0,1,20,30],"constraints":constraints}
        }
    })).unwrap()
}

#[test]
fn authored_sketch_pins_write_modern_fields_and_resize_after_reopen() {
    let fonts = Fonts::new();
    for (pins, horizontal, vertical, legacy, resized) in [
        (None, 0, 0, 63, None),
        (Some(["start", "start"]), 1, 1, 9, Some([20.,30.,40.,50.])),
        (Some(["end", "end"]), 4, 4, 36, Some([120.,130.,40.,50.])),
        (Some(["stretch", "stretch"]), 5, 5, 18, Some([20.,30.,140.,150.])),
        (Some(["end", "center"]), 4, 0, 60, None),
    ] {
        let mut doc = frame_with_pins(pins);
        layout::resolve(&mut doc, &fonts).unwrap();
        let archive = export_sketch(&doc).unwrap();
        let child = first_sketch_layer(&archive)["layers"][0].clone();
        assert_eq!(child["horizontalPins"], horizontal, "{pins:?}");
        assert_eq!(child["verticalPins"], vertical, "{pins:?}");
        assert_eq!(child["resizingConstraint"], legacy, "{pins:?}");
        let report = import_sketch_report(&archive).unwrap();
        if pins == Some(["end", "center"]) {
            assert!(report.warnings.iter().any(|note| note.contains("constraint-center->scale")));
        }
        let mut doc = report.document;
        if pins.is_none() {
            assert!(doc.nodes["child"].constraints.is_none());
        }
        if let Some(resized) = resized {
            layout::resolve(&mut doc, &fonts).unwrap();
            let parent = doc.nodes.get_mut("frame").unwrap();
            parent.width = 400.;
            parent.height = 300.;
            layout::resolve(&mut doc, &fonts).unwrap();
            assert_eq!(box_at(&doc, "child"), resized, "{pins:?}");
        }
    }
}

#[test]
fn reexport_preserves_legacy_pins_and_the_native_spelling_of_modeled_fields() {
    let fonts = Fonts::new();
    let empty = export_sketch(&frame_with_pins(None)).unwrap();
    let legacy = with_first_sketch_layer(&empty, |layer| {
        layer["layers"][0]["resizingConstraint"] = json!(9);
    });
    let mut doc = import_sketch_report(&legacy).unwrap().document;
    // Resolving establishes reference sizes without editing the authored pins.
    layout::resolve(&mut doc, &fonts).unwrap();
    let child = first_sketch_layer(&export_sketch(&doc).unwrap())["layers"][0].clone();
    assert_eq!(child["resizingConstraint"], 9);
    assert_eq!(child["horizontalPins"], 0);
    assert_eq!(child["verticalPins"], 0);

    let modern = with_first_sketch_layer(&empty, |layer| {
        layer["layers"][0]["__horizontalPins"] = json!(4);
        layer["layers"][0]["__verticalPins"] = json!(6);
    });
    let mut doc = import_sketch_report(&modern).unwrap().document;
    let constraints = doc.nodes.get_mut("child").unwrap().constraints.as_mut().unwrap();
    assert_eq!(constraints.horizontal, layout::Anchor::End);
    constraints.horizontal = layout::Anchor::Stretch;
    let child = first_sketch_layer(&export_sketch(&doc).unwrap())["layers"][0].clone();
    assert_eq!(child["__horizontalPins"], 5);
    assert_eq!(child["__verticalPins"], 6);
    assert_eq!(child["horizontalPins"], 0);
    assert_eq!(child["verticalPins"], 0);
}

#[test]
fn clearing_imported_modeled_pins_clears_the_native_aliases() {
    let empty = export_sketch(&frame_with_pins(None)).unwrap();
    let native = with_first_sketch_layer(&empty, |layer| {
        layer["layers"][0]["__horizontalPins"] = json!(4);
        layer["layers"][0]["__verticalPins"] = json!(1);
    });
    let mut doc = import_sketch_report(&native).unwrap().document;
    doc.nodes.get_mut("child").unwrap().constraints = None;
    let archive = export_sketch(&doc).unwrap();
    let child = first_sketch_layer(&archive)["layers"][0].clone();
    assert_eq!(child["__horizontalPins"], 0);
    assert_eq!(child["__verticalPins"], 0);
    assert_eq!(child["resizingConstraint"], 63);
    let reopened = import_sketch_report(&archive).unwrap().document;
    assert!(reopened.nodes["child"].constraints.is_none());
}

#[test]
fn native_single_axis_pin_leaves_the_other_axis_unpinned() {
    let empty = export_sketch(&frame_with_pins(None)).unwrap();
    let native = with_first_sketch_layer(&empty, |layer| {
        layer["layers"][0]["__horizontalPins"] = json!(4);
    });
    let doc = import_sketch_report(&native).unwrap().document;
    let pins = doc.nodes["child"].constraints.as_ref().unwrap();
    assert_eq!(pins.horizontal, layout::Anchor::End);
    assert_eq!(pins.vertical, layout::Anchor::Scale);
    let child = first_sketch_layer(&export_sketch(&doc).unwrap())["layers"][0].clone();
    assert_eq!(child["__horizontalPins"], 4);
    assert_eq!(child["verticalPins"], 0);
}

fn aligned_stack(align: &str, justify: &str, wrap: bool) -> Document {
    serde_json::from_value(json!({
        "schemaVersion": 29, "id": "d", "name": "Stack alignment",
        "pages": [{"id":"p","name":"Page","background":"#ffffff","children":["stack"]}],
        "nodes": {
            "stack": {"id":"stack","kind":"frame","width":200,"height":80, "children":["a","b"],
                "layout":{"mode":"horizontal","gap":10,"lineGap":6,"padding":[0,0,0,0],
                    "justify":justify,"align":align,"wrap":wrap}},
            "a": {"id":"a","kind":"rectangle","width":40,"height":20},
            "b": {"id":"b","kind":"rectangle","width":30,"height":50}
        }
    })).unwrap()
}

#[test]
fn unwrapped_native_sketch_stretch_preserves_cross_axis_layout_after_reopen() {
    let fonts = Fonts::new();
    let mut doc = aligned_stack("stretch", "start", false);
    layout::resolve(&mut doc, &fonts).unwrap();
    assert_eq!(box_at(&doc, "a"), [0.,0.,40.,80.]);
    assert_eq!(box_at(&doc, "b"), [50.,0.,30.,80.]);
    let archive = export_sketch(&doc).unwrap();
    assert_eq!(first_sketch_layer(&archive)["groupLayout"]["alignItems"], 3);
    let report = import_sketch_report(&archive).unwrap();
    assert!(!report.warnings.iter().any(|warning| warning.contains("stack-align-not-supported")));
    let mut doc = report.document;
    doc.nodes.get_mut("a").unwrap().height = 20.;
    doc.nodes.get_mut("b").unwrap().height = 50.;
    layout::resolve(&mut doc, &fonts).unwrap();
    assert_eq!(box_at(&doc, "a"), [0.,0.,40.,80.]);
    assert_eq!(box_at(&doc, "b"), [50.,0.,30.,80.]);
}

#[test]
fn wrapped_stretch_retains_the_native_fallback_warning_and_wrap_settings() {
    let archive = export_sketch(&aligned_stack("stretch", "start", true)).unwrap();
    let layer = first_sketch_layer(&archive);
    assert_eq!(layer["groupLayout"]["alignItems"], 5);
    assert_eq!(layer["groupLayout"]["wrappingEnabled"], true);
    assert_eq!(layer["groupLayout"]["crossAxisGutterGap"], 6.);
    let report = import_sketch_report(&archive).unwrap();
    assert!(report.warnings.iter().any(|warning| warning.contains("stack-align-not-supported")));
    assert!(!report.warnings.iter().any(|warning| warning.contains(WRAP_NOTE) || warning.contains(LINE_GAP_NOTE)));
    let layout = report.document.nodes["stack"].layout.as_ref().unwrap();
    assert_eq!(layout.align, layout::Align::Start);
    assert!(layout.wrap);
    assert_eq!(layout.line_gap, 6.);

    let unsupported = with_first_sketch_layer(&archive, |layer| {
        layer["groupLayout"]["alignItems"] = json!(3);
    });
    let report = import_sketch_report(&unsupported).unwrap();
    let layout = report.document.nodes["stack"].layout.as_ref().unwrap();
    assert_eq!(layout.align, layout::Align::Start);
    assert!(layout.wrap);
}

#[test]
fn sketch_start_center_end_and_distribution_keep_their_geometry() {
    let fonts = Fonts::new();
    for align in ["start", "center", "end"] {
        for justify in ["start", "center", "end", "space-between", "space-around", "space-evenly"] {
            let mut before = aligned_stack(align, justify, false);
            layout::resolve(&mut before, &fonts).unwrap();
            let archive = export_sketch(&before).unwrap();
            let mut after = import_sketch_report(&archive).unwrap().document;
            layout::resolve(&mut after, &fonts).unwrap();
            for child in ["a", "b"] {
                assert_eq!(box_at(&before, child), box_at(&after, child), "{align}/{justify}/{child}");
            }
        }
    }
}

#[test]
fn native_unwrapped_archive_stretch_code_executes_without_an_export_receipt() {
    let fonts = Fonts::new();
    let archive = export_sketch(&aligned_stack("start", "start", false)).unwrap();
    let native = with_first_sketch_layer(&archive, |layer| {
        layer["groupLayout"]["alignItems"] = json!(3);
        layer["userInfo"]["com.futureox.design-kernel"].as_object_mut().unwrap().remove("stackAlignment");
    });
    let mut reopened = import_sketch_report(&native).unwrap().document;
    layout::resolve(&mut reopened, &fonts).unwrap();
    assert_eq!(box_at(&reopened, "a"), [0.,0.,40.,80.]);
    assert_eq!(box_at(&reopened, "b"), [50.,0.,30.,80.]);
}
