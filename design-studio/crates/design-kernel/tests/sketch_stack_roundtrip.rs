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
