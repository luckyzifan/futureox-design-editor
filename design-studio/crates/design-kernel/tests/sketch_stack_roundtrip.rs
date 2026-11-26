use futureox_design_kernel::{
    font::Fonts,
    interop::{export_sketch, import_sketch_report, read_zip_public},
    layout,
    scene::Document,
};
use serde_json::{Value, json};
use std::{io::Cursor, io::Write};

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

fn first_sketch_layer(bytes: &[u8]) -> Value {
    let files = read_zip_public(bytes).unwrap();
    let (_, page) = files.iter().find(|(name, _)| name.starts_with("pages/")).unwrap();
    serde_json::from_slice::<Value>(page).unwrap()["layers"][0].clone()
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
