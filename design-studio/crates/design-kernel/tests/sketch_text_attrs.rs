//! Integration tests for the Sketch rich-text attribute keys
//! (Sketch JSON dictionary §4, P0-2): the 8-key
//! run attribute set plus the layer-level `textBehaviour` /
//! `lineSpacingBehaviour`, including the bindings round-trip for the keys the
//! kernel TextStyle cannot model.
use futureox_design_kernel::interop::{export_sketch, import_sketch};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read as _, Write as _};

fn pack(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut sink = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut sink);
        let options = zip::write::SimpleFileOptions::default();
        for (name, data) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }
    sink.into_inner()
}

fn unpack(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut out = BTreeMap::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).unwrap();
        let mut data = Vec::new();
        file.read_to_end(&mut data).unwrap();
        out.insert(file.name().to_string(), data);
    }
    out
}

fn bundle(page: Value) -> Vec<u8> {
    pack(&[
        ("meta.json", serde_json::to_vec(&json!({"appVersion": 93})).unwrap()),
        (
            "document.json",
            serde_json::to_vec(&json!({
                "_class": "document",
                "pages": [{"_class": "MSJSONFileReference",
                           "_ref_class": "MSImmutablePage", "_ref": "pages/PAGE1"}]
            }))
            .unwrap(),
        ),
        ("pages/PAGE1.json", serde_json::to_vec(&page).unwrap()),
    ])
}

/// First (and only) page JSON inside an exported `.sketch` bundle.
fn exported_page(bytes: &[u8]) -> Value {
    let files = unpack(bytes);
    let name = files
        .keys()
        .find(|k| k.starts_with("pages/"))
        .expect("page part")
        .clone();
    serde_json::from_slice(&files[&name]).unwrap()
}

fn text_layer(behaviour: i64, spacing: i64, runs: Value) -> Value {
    json!({
        "_class": "text",
        "do_objectID": "TEXT-1",
        "name": "Caption",
        "frame": {"_class": "rect", "x": 0., "y": 0., "width": 200., "height": 50.},
        "textBehaviour": behaviour,
        "lineSpacingBehaviour": spacing,
        "attributedString": {
            "_class": "attributedString",
            "string": "A😀b",
            "attributes": runs
        }
    })
}

/// Full 8-key run attributes (22 号字典 §4): font descriptor, color, kerning,
/// vertical alignment, text transform, underline, strikethrough and the
/// paragraph style (with a real min/max line-height range and tightening
/// enabled). "A😀b" is 4 UTF-16 code units; run 0 spans the surrogate pair.
fn full_key_runs() -> Value {
    json!([
        {"_class": "stringAttribute", "location": 0, "length": 3,
         "attributes": {
            "MSAttributedStringFontAttribute": {"_class": "fontDescriptor",
                "attributes": {"name": "Inter-SemiBold", "size": 20.}},
            "MSAttributedStringColorAttribute": {"_class": "color",
                "red": 1., "green": 0., "blue": 0., "alpha": 1.},
            "kerning": 0.909,
            "textStyleVerticalAlignmentKey": 1,
            "MSAttributedStringTextTransformAttribute": 1,
            "underlineStyle": 1,
            "strikethroughStyle": 0,
            "paragraphStyle": {"_class": "paragraphStyle", "alignment": 2,
                "minimumLineHeight": 30., "maximumLineHeight": 34.,
                "paragraphSpacing": 6.,
                "allowsDefaultTighteningForTruncation": true}
         }},
        {"_class": "stringAttribute", "location": 3, "length": 1,
         "attributes": {
            "MSAttributedStringFontAttribute": {"_class": "fontDescriptor",
                "attributes": {"name": "HelveticaNeue", "size": 12.}},
            "MSAttributedStringColorAttribute": {"_class": "color",
                "red": 0., "green": 0., "blue": 1., "alpha": 1.},
            "underlineStyle": 0,
            "strikethroughStyle": 1
         }}
    ])
}

fn import_lossy(node: &futureox_design_kernel::scene::Node) -> Vec<String> {
    node.bindings
        .get("sketchImportLossy")
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default()
}

#[test]
fn eight_key_runs_import_into_model_and_bindings() {
    let page = json!({"_class": "page", "name": "P",
                      "layers": [text_layer(2, 3, full_key_runs())]});
    let doc = import_sketch(&bundle(page)).unwrap();
    let node = doc.nodes.get("TEXT-1").expect("text node");
    assert_eq!(node.text, "A😀b");
    // UTF-16 run boundaries: the surrogate pair stays inside run 0.
    assert_eq!(node.text_runs.len(), 2);
    assert_eq!((node.text_runs[0].start, node.text_runs[0].end), (0, 3));
    assert_eq!((node.text_runs[1].start, node.text_runs[1].end), (3, 4));
    assert!(node.text_runs[0].underline);
    assert!(!node.text_runs[0].strikethrough);
    assert_eq!(node.text_runs[0].color.as_deref(), Some("#ff0000"));
    assert_eq!(node.text_runs[0].font_id.as_deref(), Some("Inter-SemiBold"));
    assert_eq!(node.text_runs[0].font_size, Some(20.));
    assert!(node.text_runs[1].strikethrough);
    assert_eq!(node.text_runs[1].color.as_deref(), Some("#0000ff"));
    // First run fills the node-level defaults.
    assert_eq!(node.font_size, 20.);
    let style = node.text_style.as_ref().expect("text style");
    assert!(style.wrap, "textBehaviour 2 (固定宽高) wraps");
    assert_eq!(style.align, "center");
    assert!((style.line_height - 30. / 20.).abs() < 1e-9);
    assert!((style.letter_spacing - 0.909).abs() < 1e-9);
    assert!((style.paragraph_spacing - 6.).abs() < 1e-9);
    // Source modes ride bindings; FixedWidthAndHeight is also modeled by sizing.
    assert_eq!(
        node.bindings.get("sketchTextBehaviour").map(String::as_str),
        Some("2")
    );
    assert_eq!(style.vertical_align, "center");
    assert_eq!(
        node.bindings
            .get("sketchTextTransform")
            .map(String::as_str),
        Some("1")
    );
    assert_eq!(
        node.bindings
            .get("sketchTextAllowsTightening")
            .map(String::as_str),
        Some("1")
    );
    // …and the gaps are reported, not silently absorbed. lineSpacingBehaviour
    // 3 matches what the custom line height re-derives, so no binding/note.
    assert!(!node.bindings.contains_key("sketchLineSpacingBehaviour"));
    let notes = import_lossy(node);
    assert_eq!(node.text_runs[0].text_case, Some(futureox_design_kernel::font::TextCase::Upper));
    let paragraph=node.text_runs[0].paragraph.as_ref().unwrap();
    assert_eq!((paragraph.minimum_line_height,paragraph.maximum_line_height),(30.,34.));
    assert!(!notes.iter().any(|n|n=="paragraph-line-height-range-collapsed"));
    let sizing = node.sizing.as_ref().expect("fixed source sizing");
    assert!(matches!(sizing.width, futureox_design_kernel::layout::SizeMode::Fixed));
    assert!(matches!(sizing.height, futureox_design_kernel::layout::SizeMode::Fixed));
    assert!(!notes.iter().any(|n| n == "textbehaviour-fixed-size-not-modeled"));
    for expected in [
        "paragraph-tightening-not-modeled",
    ] {
        assert!(notes.iter().any(|n| n == expected), "missing {expected}: {notes:?}");
    }
}

#[test]
fn full_key_set_round_trips_back_to_sketch_json() {
    let page = json!({"_class": "page", "name": "P",
                      "layers": [text_layer(2, 3, full_key_runs())]});
    let doc = import_sketch(&bundle(page)).unwrap();
    let re = export_sketch(&doc).unwrap();
    let page = exported_page(&re);
    let layer = &page["layers"][0];
    assert_eq!(layer["_class"], "text");
    assert_eq!(layer["textBehaviour"], 2, "binding wins on re-export");
    assert_eq!(
        layer["lineSpacingBehaviour"], 3,
        "custom line height derives 自定义"
    );
    let attrs = layer["attributedString"]["attributes"].as_array().unwrap();
    assert_eq!(attrs.len(), 2);
    for run in attrs {
        assert_eq!(run["attributes"]["textStyleVerticalAlignmentKey"], 1);
        assert_eq!(run["attributes"]["MSAttributedStringTextTransformAttribute"], 1);
        let para = &run["attributes"]["paragraphStyle"];
        assert_eq!(para["alignment"], 2);
        assert_eq!(para["allowsDefaultTighteningForTruncation"], true);
        assert_eq!(para["paragraphSpacing"], 6.);
    }
    assert_eq!(attrs[0]["location"], 0);
    assert_eq!(attrs[0]["length"], 3, "UTF-16 length spans the emoji");
    assert_eq!(attrs[0]["attributes"]["kerning"], 0.909);
    assert_eq!(attrs[0]["attributes"]["underlineStyle"], 1);
    assert_eq!(attrs[1]["attributes"]["strikethroughStyle"], 1);
    // Per-segment line height: line_height ratio × the segment font size.
    assert_eq!(
        attrs[0]["attributes"]["paragraphStyle"]["minimumLineHeight"],
        30.
    );
    assert_eq!(
        attrs[1]["attributes"]["paragraphStyle"]["minimumLineHeight"],
        18.
    );
    // A second import sees the same bindings: the round trip is stable.
    let again = import_sketch(&re).unwrap();
    let node = again.nodes.get("TEXT-1").expect("text node");
    assert_eq!(
        node.bindings.get("sketchTextBehaviour").map(String::as_str),
        Some("2")
    );
    assert_eq!(
        node.bindings
            .get("sketchTextAllowsTightening")
            .map(String::as_str),
        Some("1")
    );
}

#[test]
fn behaviour_keys_derive_from_style_when_no_binding() {
    // Official TextBehaviour 0 (Flexible) is the no-wrap case; without a custom line
    // height lineSpacingBehaviour derives the v2-era default 2.
    let page = json!({"_class": "page", "name": "P", "layers": [{
        "_class": "text", "do_objectID": "TEXT-1", "name": "Auto",
        "frame": {"_class": "rect", "x": 0., "y": 0., "width": 200., "height": 50.},
        "textBehaviour": 0,
        "attributedString": {"_class": "attributedString", "string": "hi",
            "attributes": [{"_class": "stringAttribute", "location": 0, "length": 2,
                "attributes": {
                    "MSAttributedStringFontAttribute": {"_class": "fontDescriptor",
                        "attributes": {"name": "HelveticaNeue", "size": 12.}}
                }}]}
    }]});
    let doc = import_sketch(&bundle(page)).unwrap();
    let node = doc.nodes.get("TEXT-1").expect("text node");
    assert!(!node.text_style.as_ref().unwrap().wrap, "自动宽 disables wrap");
    assert!(!node.bindings.contains_key("sketchTextBehaviour"));
    let layer = exported_page(&export_sketch(&doc).unwrap())["layers"][0].clone();
    assert_eq!(layer["textBehaviour"], 0, "no-wrap derives Flexible");
    assert_eq!(layer["lineSpacingBehaviour"], 2, "default spacing derives v2");

    // A custom line height derives lineSpacingBehaviour 3 (自定义) without a
    // binding, and a stored 1 (v2 常基线) that contradicts the derivation
    // survives through its binding.
    let page = json!({"_class": "page", "name": "P", "layers": [{
        "_class": "text", "do_objectID": "TEXT-1", "name": "Custom",
        "frame": {"_class": "rect", "x": 0., "y": 0., "width": 200., "height": 50.},
        "textBehaviour": 1, "lineSpacingBehaviour": 1,
        "attributedString": {"_class": "attributedString", "string": "hi",
            "attributes": [{"_class": "stringAttribute", "location": 0, "length": 2,
                "attributes": {
                    "MSAttributedStringFontAttribute": {"_class": "fontDescriptor",
                        "attributes": {"name": "HelveticaNeue", "size": 20.}},
                    "paragraphStyle": {"_class": "paragraphStyle", "alignment": 0,
                        "minimumLineHeight": 40., "maximumLineHeight": 40.,
                        "allowsDefaultTighteningForTruncation": false}
                }}]}
    }]});
    let doc = import_sketch(&bundle(page)).unwrap();
    let node = doc.nodes.get("TEXT-1").expect("text node");
    let style = node.text_style.as_ref().unwrap();
    assert!(style.wrap, "textBehaviour 1 (Fixed) wraps");
    assert!((style.line_height - 2.).abs() < 1e-9);
    assert_eq!(
        node.bindings
            .get("sketchLineSpacingBehaviour")
            .map(String::as_str),
        Some("1"),
        "1 (常基线) contradicts the custom-height derivation and must be kept"
    );
    let layer = exported_page(&export_sketch(&doc).unwrap())["layers"][0].clone();
    assert_eq!(layer["textBehaviour"], 1);
    assert_eq!(layer["lineSpacingBehaviour"], 1, "binding wins over derivation");
}

#[test]
fn translucent_run_alpha_survives_native_export_and_reopen() {
    let mut runs=full_key_runs();runs[0]["attributes"]["MSAttributedStringColorAttribute"]["alpha"]=json!(0.25);
    let doc=import_sketch(&bundle(json!({"_class":"page","do_objectID":"PAGE1","layers":[text_layer(2,0,runs)]}))).unwrap();
    let color=doc.nodes["TEXT-1"].text_runs[0].color.as_ref().unwrap();assert!(color.ends_with("/ 0.25)"),"{color}");
    let output=export_sketch(&doc).unwrap();let page=exported_page(&output);
    assert_eq!(page["layers"][0]["attributedString"]["attributes"][0]["attributes"]["MSAttributedStringColorAttribute"]["alpha"],0.25);
    let reopened=import_sketch(&output).unwrap();assert_eq!(&reopened.nodes["TEXT-1"].text_runs[0].color, &doc.nodes["TEXT-1"].text_runs[0].color);
}
