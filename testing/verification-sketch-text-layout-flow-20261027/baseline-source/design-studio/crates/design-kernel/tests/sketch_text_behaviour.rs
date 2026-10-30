//! Official TextBehaviour contract:
//! https://github.com/sketch-hq/sketch-document/blob/main/packages/file-format/schema/enums/text-behaviour.schema.yaml
//! 0 Flexible, 1 Fixed, 2 FixedWidthAndHeight. No pixel goldens are changed.
use futureox_design_kernel::{font::Fonts, interop, scene::Document};
use serde_json::{Value, json};
use std::io::{Cursor, Write};

fn source(behaviour: Option<i64>, text: &str, width: f64) -> Vec<u8> {
    let mut layer = json!({"_class":"text","do_objectID":"caption","name":"Caption",
        "frame":{"x":0,"y":0,"width":width,"height":200},
        "style":{"contextSettings":{"opacity":1}},
        "attributedString":{"string":text,"attributes":[{"location":0,"length":text.encode_utf16().count(),
            "attributes":{"MSAttributedStringFontAttribute":{"attributes":{"size":24}}}}]}});
    if let Some(behaviour) = behaviour {
        layer["textBehaviour"] = json!(behaviour);
    }
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, value) in [
        ("meta.json", json!({"appVersion":"93"})),
        ("document.json", json!({"pages":[{"_ref":"pages/p"}]})),
        (
            "pages/p.json",
            json!({"_class":"page","do_objectID":"p","name":"Page","layers":[layer]}),
        ),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn import(behaviour: Option<i64>, text: &str, width: f64) -> Document {
    interop::import_sketch_report(&source(behaviour, text, width))
        .unwrap()
        .document
}

fn exported_text(document: &Document) -> Value {
    let bytes = interop::export_sketch(document).unwrap();
    let files = interop::read_zip_public(&bytes).unwrap();
    let page = files
        .iter()
        .find(|(name, _)| name.starts_with("pages/"))
        .unwrap()
        .1;
    serde_json::from_slice::<Value>(page).unwrap()["layers"][0].clone()
}

fn fonts() -> Fonts {
    let bytes = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../frontend/design-client/public/fonts/NotoSansSC.ttf"),
    )
    .unwrap();
    let mut fonts = Fonts::new();
    fonts.load(&bytes).unwrap();
    fonts
}

#[test]
fn official_modes_and_missing_value_map_to_the_correct_wrap_contract_and_export_codes() {
    for (behaviour, wrap, exported) in [
        (Some(0), false, 0),
        (Some(1), true, 1),
        (Some(2), true, 2),
        (None, false, 0),
    ] {
        let document = import(behaviour, "14:37:30", 36.);
        assert_eq!(
            document.nodes["caption"].text_style.as_ref().unwrap().wrap,
            wrap,
            "mode {behaviour:?}"
        );
        assert_eq!(exported_text(&document)["textBehaviour"], exported);
        let bytes = interop::export_sketch(&document).unwrap();
        let reopened = interop::import_sketch_report(&bytes).unwrap().document;
        assert_eq!(
            reopened.nodes["caption"].text_style.as_ref().unwrap().wrap,
            wrap
        );
        assert_eq!(reopened.nodes["caption"].text, "14:37:30");
    }
}

#[test]
fn real_font_layout_keeps_flexible_text_on_one_line_and_wraps_fixed_modes() {
    let fonts = fonts();
    for behaviour in [Some(0), Some(1), Some(2), None] {
        let document = import(behaviour, "14:37:30", 36.);
        let node = &document.nodes["caption"];
        let layout = fonts.node_layout(node, Some(node.width)).unwrap();
        if matches!(behaviour, Some(0) | None) {
            assert_eq!(
                layout.lines.len(),
                1,
                "Flexible must not soft-wrap at the archived frame width"
            );
            assert!(
                layout.lines[0].width > node.width,
                "the fixture must actually exceed its frame width"
            );
        } else {
            assert!(
                layout.lines.len() > 1,
                "Fixed modes must use the archived width"
            );
        }
        assert_eq!(
            layout.glyphs.len(),
            8,
            "wrapping must not drop any clock characters"
        );
    }
}

#[test]
fn explicit_and_trailing_newlines_survive_all_modes_and_round_trip() {
    let fonts = fonts();
    let text = "AB\nCD\n";
    for behaviour in [Some(0), Some(1), Some(2), None] {
        let document = import(behaviour, text, 200.);
        let node = &document.nodes["caption"];
        let layout = fonts.node_layout(node, Some(node.width)).unwrap();
        assert_eq!(
            layout.lines.len(),
            3,
            "mode {behaviour:?} must retain explicit paragraph breaks"
        );
        assert_eq!(layout.glyphs.len(), 4);
        assert_eq!(exported_text(&document)["attributedString"]["string"], text);
        let reopened = interop::import_sketch_report(&interop::export_sketch(&document).unwrap())
            .unwrap()
            .document;
        let layout = fonts
            .node_layout(&reopened.nodes["caption"], Some(200.))
            .unwrap();
        assert_eq!(reopened.nodes["caption"].text, text);
        assert_eq!(layout.lines.len(), 3);
    }
}

#[test]
fn absent_kernel_text_style_exports_flexible_instead_of_enabling_soft_wrap() {
    let mut document = import(None, "Long caption", 36.);
    document.nodes.get_mut("caption").unwrap().text_style = None;
    assert_eq!(exported_text(&document)["textBehaviour"], 0);
}

#[test]
fn live_no_wrap_edit_preserves_fixed_height_native_sizing() {
    let mut document = import(Some(2), "14:37:30", 36.);
    assert_eq!(
        exported_text(&document)["textBehaviour"],
        2,
        "untouched source mode survives"
    );
    document
        .nodes
        .get_mut("caption")
        .unwrap()
        .text_style
        .as_mut()
        .unwrap()
        .wrap = false;
    let exported = interop::export_sketch(&document).unwrap();
    assert_eq!(
        exported_text(&document)["textBehaviour"],
        2,
        "wrap edits do not erase authored fixed extents"
    );
    let reopened = interop::import_sketch_report(&exported).unwrap().document;
    let node = &reopened.nodes["caption"];
    assert!(!node.text_style.as_ref().unwrap().wrap);
    assert_eq!(
        fonts()
            .node_layout(node, Some(node.width))
            .unwrap()
            .lines
            .len(),
        1
    );
}

#[test]
fn authored_fixed_boxes_preserve_geometry_after_real_layout_with_or_without_own_metadata() {
    use futureox_design_kernel::layout::{self, Sizing};
    let fonts = fonts();
    for sizing in [None, Some(Sizing::default())] {
        for text in ["F", "A long overflowing caption that exceeds its box", "AB\nCD\n"] {
            for wrap in [false, true] {
                let mut document = import(Some(2), text, 20.);
                let node = document.nodes.get_mut("caption").unwrap();
                node.sizing = sizing.clone();
                node.height = 33.6;
                node.text_style.as_mut().unwrap().wrap = wrap;
                // A source-layout signature must not conceal authored dimensions.
                document.design_system = None;
                let layer = exported_text(&document);
                assert_eq!(layer["textBehaviour"], 2, "fixed extents cannot export Flexible");
                let exported = interop::export_sketch(&document).unwrap();
                let report = interop::import_sketch_report(&exported).unwrap();
                assert_eq!(report.warnings.iter().any(|warning|
                    warning.contains("text-wrap-in-userInfo-native-sketch-may-wrap-differently")), !wrap);
                for strip_metadata in [false, true] {
                    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
                    for (name, bytes) in interop::read_zip_public(&exported).unwrap() {
                        let bytes = if strip_metadata && name.starts_with("pages/") {
                            let mut page: Value = serde_json::from_slice(&bytes).unwrap();
                            page["layers"][0].as_object_mut().unwrap().remove("userInfo");
                            serde_json::to_vec(&page).unwrap()
                        } else { bytes };
                        archive.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
                        archive.write_all(&bytes).unwrap();
                    }
                    let mut reopened = interop::import_sketch_report(&archive.finish().unwrap().into_inner()).unwrap().document;
                    layout::resolve(&mut reopened, &fonts).unwrap();
                    let node = reopened.nodes.values().find(|n| n.kind == "text").unwrap();
                    assert_eq!((node.width, node.height), (20., 33.6));
                    assert_eq!(node.text_style.as_ref().unwrap().wrap, if strip_metadata { true } else { wrap });
                    assert_eq!(node.text, text);
                }
            }
        }
    }
}

#[test]
fn live_sizing_edits_choose_native_modes_independently_of_wrap() {
    use futureox_design_kernel::layout::{SizeMode, Sizing};
    for (width, height, code) in [
        (SizeMode::Hug, SizeMode::Hug, 0),
        (SizeMode::Fixed, SizeMode::Hug, 1),
        (SizeMode::Fixed, SizeMode::Fixed, 2),
    ] {
        for wrap in [false, true] {
            let mut document = import(Some(2), "AB\nCD", 80.);
            let node = document.nodes.get_mut("caption").unwrap();
            node.sizing = Some(Sizing { width, height, ..Default::default() });
            node.text_style.as_mut().unwrap().wrap = wrap;
            assert_eq!(exported_text(&document)["textBehaviour"], code);
            let reopened = interop::import_sketch_report(&interop::export_sketch(&document).unwrap()).unwrap().document;
            let node = &reopened.nodes["caption"];
            let sizing = node.sizing.as_ref().unwrap();
            assert_eq!((sizing.width, sizing.height), (width, height));
            assert_eq!(node.text_style.as_ref().unwrap().wrap, wrap);
        }
    }
}
