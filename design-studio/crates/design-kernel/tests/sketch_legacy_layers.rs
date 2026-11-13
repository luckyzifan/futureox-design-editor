use futureox_design_kernel::{
    binfmt, components,
    editing::{DocumentEditor, DocumentPatch},
    font::Fonts,
    interop,
    scene::Document,
};
use serde_json::Value;
use std::io::{Cursor, Write};

const SEMANTIC: &[u8] = include_bytes!(
    "../../../../testing/fixtures/sketch-public-20261105/semantic-ui-kit-for-sketch/semantic-ui-kit.sketch"
);
const WIREFRAME: &[u8] = include_bytes!(
    "../../../../testing/fixtures/sketch-public-20261105/Simple-Sketch-Wireframe-Kit/wireframe_kit_chevalier.sketch"
);
const BUTTON: &str = "6F12C3D0-C82F-4114-85ED-1D0F233062DD";
const CART: &str = "F35AEC69-0FCB-4D09-91F8-4DAC8F24FD16";
const FIXED_TEXT: &str = "BE47B985-D10B-4A7F-9E2C-CD3F988BF749";

fn reopen_fd(doc: &Document) -> Document {
    let json = serde_json::to_string(doc).unwrap();
    let fd = binfmt::encode_authored_json(&json).unwrap();
    serde_json::from_str(&binfmt::decode_authored_json(&fd).unwrap()).unwrap()
}

#[test]
fn corrupt_legacy_text_is_reported_and_modern_text_takes_precedence() {
    let mut files = interop::read_zip_public(SEMANTIC).unwrap();
    fn replace(layer: &mut Value, modern: bool) -> bool {
        if layer["do_objectID"] == BUTTON {
            layer["attributedString"]["archivedAttributedString"]["_archive"] =
                serde_json::json!("damaged");
            if modern {
                layer["attributedString"]["string"] = serde_json::json!("Modern");
            }
            return true;
        }
        layer["layers"]
            .as_array_mut()
            .is_some_and(|children| children.iter_mut().any(|child| replace(child, modern)))
    }
    for modern in [false, true] {
        assert!(files.iter_mut().any(|(path, data)| {
            if !path.starts_with("pages/") {
                return false;
            }
            let mut page: Value = serde_json::from_slice(data).unwrap();
            if replace(&mut page, modern) {
                *data = serde_json::to_vec(&page).unwrap();
                true
            } else {
                false
            }
        }));
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (path, data) in &files {
            zip.start_file(path, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(data).unwrap();
        }
        let report = interop::import_sketch_report(&zip.finish().unwrap().into_inner()).unwrap();
        assert_eq!(
            report.document.nodes[BUTTON].text,
            if modern { "Modern" } else { "" }
        );
        assert_eq!(
            report
                .warnings
                .iter()
                .any(|warning| warning.contains("invalid archived Sketch attributed string")),
            !modern
        );
    }
}

#[test]
fn legacy_semantic_ui_archives_restore_editable_text_and_style() {
    let imported = interop::import_sketch_report(SEMANTIC).unwrap();
    let doc = imported.document;
    let texts = doc
        .nodes
        .values()
        .filter(|node| node.kind == "text")
        .collect::<Vec<_>>();
    assert_eq!(texts.len(), 31);
    assert!(texts.iter().all(|node| !node.text.is_empty()));
    let button = &doc.nodes[BUTTON];
    assert_eq!(button.text, "Button");
    assert_eq!(button.font_size, 18.);
    assert_eq!(button.text_runs[0].end, 6);
    assert_eq!(button.text_runs[0].color.as_deref(), Some("#4183c4"));
    let source = &doc.design_system.as_ref().unwrap().sketch_containers["nodeMetadata"];
    let fonts: Value = serde_json::from_str(
        source[BUTTON]["bindings"]["sketchSourceFonts"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(fonts["runs"]["0"], "Lato-Bold");
    assert!(
        texts.iter().any(|node| node.text == "Add to Cart"
            && node.text_style.as_ref().unwrap().align == "center")
    );

    let mut editor = DocumentEditor::new(reopen_fd(&doc)).unwrap();
    let before = editor.document().clone();
    let mut edited = before.clone();
    edited.nodes.get_mut(BUTTON).unwrap().text = "Buttons".into();
    editor
        .apply(
            editor.revision(),
            DocumentPatch::between(&before, &edited).unwrap(),
        )
        .unwrap();
    editor.undo().unwrap();
    assert_eq!(editor.document().nodes[BUTTON].text, "Button");
    editor.redo().unwrap();
    assert_eq!(editor.document().nodes[BUTTON].text, "Buttons");
    let restored =
        interop::import_sketch_report(&interop::export_sketch(editor.document()).unwrap()).unwrap();
    assert_eq!(restored.document.nodes[BUTTON].text, "Buttons");
    assert_eq!(
        restored.document.nodes[BUTTON].text_runs[0]
            .color
            .as_deref(),
        Some("#4183c4")
    );
}

#[test]
fn old_nested_shape_paths_preserve_cubic_handles_and_editable_geometry() {
    let doc = interop::import_sketch_report(SEMANTIC).unwrap().document;
    let cart = doc.nodes[CART]
        .network
        .as_ref()
        .expect("old Sketch cart curve");
    assert_eq!(cart.vertices.len(), 21);
    assert!(
        cart.edges
            .iter()
            .any(|edge| edge.c1.is_some() != edge.c2.is_some())
    );
    assert!(
        cart.edges
            .iter()
            .any(|edge| edge.c1.is_some() && edge.c2.is_some())
    );
    let old_paths = doc
        .nodes
        .values()
        .filter(|node| node.kind == "vector" && node.network.is_some())
        .count();
    assert!(
        old_paths >= 18,
        "all nested source paths must reach the geometry model"
    );
    assert_eq!(reopen_fd(&doc).nodes[CART].network, doc.nodes[CART].network);
    let sketch = interop::import_sketch_report(&interop::export_sketch(&doc).unwrap()).unwrap();
    assert_eq!(sketch.document.nodes[CART].network, doc.nodes[CART].network);
}

#[test]
fn sketch_shared_typography_keeps_layer_owned_wrap_and_fixed_baseline() {
    let doc = interop::import_sketch_report(WIREFRAME).unwrap().document;
    let source = &doc.nodes[FIXED_TEXT];
    assert_eq!(source.text.encode_utf16().count(), 815);
    assert_eq!((source.width, source.height), (260., 356.));
    let mut fonts = Fonts::new();
    fonts
        .load(include_bytes!(
            "../../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
        ))
        .unwrap();
    let resolve = |doc: &Document| {
        let changes: Value = serde_json::from_str(
            &components::changes(&serde_json::to_string(doc).unwrap(), &fonts).unwrap(),
        )
        .unwrap();
        changes["nodes"]
            .get(FIXED_TEXT)
            .map(|node| {
                serde_json::from_value::<futureox_design_kernel::scene::Node>(node.clone()).unwrap()
            })
            .unwrap_or_else(|| doc.nodes[FIXED_TEXT].clone())
    };
    let actual = resolve(&doc);
    let style = actual.text_style.as_ref().unwrap();
    assert!(style.wrap);
    assert_eq!(style.line_box_baseline, "nearest-point");
    assert_eq!((actual.width, actual.height), (source.width, source.height));
    assert_eq!(actual.text, source.text);
    assert_eq!(actual.style_refs, source.style_refs);

    let mut local = reopen_fd(&doc);
    local
        .nodes
        .get_mut(FIXED_TEXT)
        .unwrap()
        .text_style
        .as_mut()
        .unwrap()
        .wrap = false;
    let style_id = source.style_refs["textStyle"].clone();
    local
        .design_system
        .as_mut()
        .unwrap()
        .styles
        .get_mut(&style_id)
        .unwrap()
        .value["letterSpacing"] = serde_json::json!(3.0);
    let updated = resolve(&local);
    let updated = updated.text_style.unwrap();
    assert!(!updated.wrap);
    assert_eq!(updated.line_box_baseline, "nearest-point");
    assert_eq!(updated.letter_spacing, 3.);
}
