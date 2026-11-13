use base64::{Engine as _, engine::general_purpose::STANDARD};
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
fn native_mixed_archive_preserves_utf16_ranges_and_run_styles() {
    // NSKeyedArchiver output from AppKit. The first range includes an emoji
    // and requires more than one byte in NSAttributeInfo's range length.
    let archived =
        include_bytes!("../../../../testing/fixtures/design/sketch-legacy-mixed-text.bplist");
    let source = serde_json::json!({
        "_class":"page","do_objectID":"page","name":"Mixed archived text","layers":[{
            "_class":"text","do_objectID":"text","name":"Text","textBehaviour":2,
            "frame":{"x":0,"y":0,"width":400,"height":100},
            "attributedString":{"archivedAttributedString":{"_archive":STANDARD.encode(archived)}}
        }]
    });
    let import = |page: &Value| {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("document.json", options).unwrap();
        zip.write_all(br#"{"_class":"document","pages":[{"_ref":"pages/page"}]}"#)
            .unwrap();
        zip.start_file("meta.json", options).unwrap();
        zip.write_all(b"{}").unwrap();
        zip.start_file("pages/page.json", options).unwrap();
        zip.write_all(page.to_string().as_bytes()).unwrap();
        interop::import_sketch_report(&zip.finish().unwrap().into_inner()).unwrap()
    };
    let report = import(&source);
    let doc = report.document;
    let node = &doc.nodes["text"];
    assert_eq!(node.text, format!("{}😀\nTwo", "A".repeat(128)));
    assert_eq!(node.text_runs.len(), 2);
    let first = &node.text_runs[0];
    let second = &node.text_runs[1];
    assert_eq!((first.start, first.end), (0, 131));
    assert_eq!((second.start, second.end), (131, 134));
    assert_eq!(first.font_size, Some(15.));
    assert_eq!(
        first.color.as_deref(),
        Some("color(srgb 0.2 0.4 0.6 / 0.8)")
    );
    assert_eq!(second.font_size, Some(19.));
    assert_eq!(second.color.as_deref(), Some("#996633"));
    assert_eq!(second.letter_spacing, Some(1.5));
    let paragraph = second.paragraph.as_ref().unwrap();
    assert_eq!(paragraph.align, "end");
    assert_eq!(paragraph.minimum_line_height, 16.);
    assert_eq!(paragraph.maximum_line_height, 19.);
    assert_eq!(paragraph.spacing, 4.);
    let meta = &doc.design_system.as_ref().unwrap().sketch_containers["nodeMetadata"];
    let names: Value = serde_json::from_str(
        meta["text"]["bindings"]["sketchSourceFonts"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(names["runs"]["0"], "Menlo-Regular");
    assert_eq!(names["runs"]["1"], "Menlo-Bold");

    let fd = reopen_fd(&doc);
    assert_eq!(fd.nodes["text"].text_runs, node.text_runs);
    let reimport = interop::import_sketch_report(&interop::export_sketch(&fd).unwrap()).unwrap();
    let reimported = &reimport.document.nodes["text"];
    assert_eq!(reimported.text, node.text);
    assert_eq!(reimported.text_runs[1].letter_spacing, Some(1.5));
    assert_eq!(reimported.text_runs[1].paragraph.as_ref(), Some(paragraph));

    // A length that bisects the emoji must not build a malformed kernel run.
    let mut damaged = plist::Value::from_reader(Cursor::new(archived)).unwrap();
    let objects = damaged
        .as_dictionary_mut()
        .unwrap()
        .get_mut("$objects")
        .unwrap()
        .as_array_mut()
        .unwrap();
    let info = objects[1].as_dictionary().unwrap()["NSAttributeInfo"]
        .as_uid()
        .unwrap()
        .get();
    objects[info as usize]
        .as_dictionary_mut()
        .unwrap()
        .insert("NS.data".into(), plist::Value::Data(vec![129, 1, 0, 5, 1]));
    let mut binary = Vec::new();
    damaged.to_writer_binary(&mut binary).unwrap();
    let mut broken = source;
    broken["layers"][0]["attributedString"]["archivedAttributedString"]["_archive"] =
        Value::String(STANDARD.encode(binary));
    let degraded = import(&broken);
    assert_eq!(degraded.document.nodes["text"].text, node.text);
    assert!(degraded.document.nodes["text"].text_runs.is_empty());
    assert!(
        degraded
            .warnings
            .iter()
            .any(|warning| warning.contains("sketch-archived-text-attributes-partially-supported"))
    );
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
    fn check_paths(layer: &Value, doc: &Document) -> usize {
        let mut count = 0;
        if layer["_class"] == "shapePath" {
            let id = layer["do_objectID"].as_str().unwrap();
            let path = &layer["path"];
            let points = path["points"].as_array().unwrap();
            let network = doc.nodes[id].network.as_ref().unwrap();
            let closed = path["isClosed"].as_bool().unwrap();
            assert_eq!(network.vertices.len(), points.len(), "{id}");
            assert_eq!(
                network.edges.len(),
                points.len() - usize::from(!closed),
                "{id}"
            );
            for (index, edge) in network.edges.iter().enumerate() {
                assert_eq!(
                    edge.c1.is_some(),
                    points[index]["hasCurveFrom"] == true,
                    "{id}"
                );
                assert_eq!(
                    edge.c2.is_some(),
                    points[(index + 1) % points.len()]["hasCurveTo"] == true,
                    "{id}"
                );
            }
            count = 1;
        }
        if let Some(children) = layer["layers"].as_array() {
            count += children
                .iter()
                .map(|child| check_paths(child, doc))
                .sum::<usize>();
        }
        count
    }
    let old_paths = interop::read_zip_public(SEMANTIC)
        .unwrap()
        .iter()
        .filter(|(path, _)| path.starts_with("pages/") && path.ends_with(".json"))
        .map(|(_, bytes)| check_paths(&serde_json::from_slice(bytes).unwrap(), &doc))
        .sum::<usize>();
    assert_eq!(old_paths, 18);
    let mut resolved = doc.clone();
    futureox_design_kernel::curve_boolean::resolve(&mut resolved).unwrap();
    let cart_artboard = &resolved.nodes["EF561AA7-97E5-4662-93FD-B509DE974519"];
    let cart_outline = &resolved.nodes[&cart_artboard.children[0]];
    assert!(!cart_outline.paths().unwrap().0.commands.is_empty());
    assert_eq!(reopen_fd(&doc).nodes[CART].network, doc.nodes[CART].network);
    let sketch = interop::import_sketch_report(&interop::export_sketch(&doc).unwrap()).unwrap();
    assert_eq!(sketch.document.nodes[CART].network, doc.nodes[CART].network);

    let mut editor = DocumentEditor::new(doc.clone()).unwrap();
    let mut edited = doc.clone();
    let network = edited
        .nodes
        .get_mut(CART)
        .unwrap()
        .network
        .as_mut()
        .unwrap();
    std::sync::Arc::make_mut(network).vertices[0].x += 0.5;
    editor
        .apply(
            editor.revision(),
            DocumentPatch::between(&doc, &edited).unwrap(),
        )
        .unwrap();
    assert_eq!(
        editor.document().nodes[CART].network,
        edited.nodes[CART].network
    );
    editor.undo().unwrap();
    assert_eq!(
        editor.document().nodes[CART].network,
        doc.nodes[CART].network
    );
    editor.redo().unwrap();
    assert_eq!(
        editor.document().nodes[CART].network,
        edited.nodes[CART].network
    );
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
