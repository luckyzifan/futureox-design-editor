use base64::{Engine as _, engine::general_purpose::STANDARD};
use futureox_design_kernel::{
    binfmt,
    font::{FontResource, Fonts},
    interop,
    scene::Document,
};
use serde_json::{Value, json};
use std::io::{Read, Write};

fn fixture() -> Document {
    let mut doc: Document = serde_json::from_value(json!({"schemaVersion":1,"id":"font-test","name":"Fonts","pages":[{"id":"p","name":"Page","children":["a","b","c"],"background":"#ffffff"}],"nodes":{
        "a":{"id":"a","kind":"text","text":"ABC","width":200,"height":50,"fontSize":20,"textStyle":{"fontId":"narrow"}},
        "b":{"id":"b","kind":"text","text":"ABC","width":200,"height":50,"fontSize":20,"textStyle":{"fontId":"wide"}},
        "c":{"id":"c","kind":"text","text":"中文Ω","width":200,"height":50,"fontSize":20,"textStyle":{"fontId":"unicode"}}
    }})).unwrap();
    for (id, data) in [
        (
            "narrow",
            include_bytes!("fixtures/sketch-fonts/font-0.ttf").as_slice(),
        ),
        (
            "wide",
            include_bytes!("fixtures/sketch-fonts/font-1.ttf").as_slice(),
        ),
        (
            "unicode",
            include_bytes!("fixtures/sketch-fonts/font-2.ttf").as_slice(),
        ),
    ] {
        let face = ttf_parser::Face::parse(data, 0).unwrap();
        let name = |n| {
            face.names()
                .into_iter()
                .filter(|v| v.name_id == n)
                .find_map(|v| v.to_string())
                .unwrap()
        };
        doc.fonts.insert(
            id.into(),
            FontResource {
                family: name(ttf_parser::name_id::FAMILY),
                data: STANDARD.encode(data).into(),
                index: 0,
                postscript: Some(name(ttf_parser::name_id::POST_SCRIPT_NAME)),
            },
        );
    }
    doc
}
fn archive_json(bytes: &[u8]) -> Value {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut json = String::new();
    zip.by_name("document.json")
        .unwrap()
        .read_to_string(&mut json)
        .unwrap();
    serde_json::from_str(&json).unwrap()
}
fn replace_document(bytes: &[u8], document: &Value) -> Vec<u8> {
    replace_document_with_parts(bytes, document, &[])
}
fn replace_document_with_parts(bytes: &[u8], document: &Value, parts: &[(&str, &[u8])]) -> Vec<u8> {
    let mut source = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut output = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for i in 0..source.len() {
        let mut entry = source.by_index(i).unwrap();
        let mut data = Vec::new();
        entry.read_to_end(&mut data).unwrap();
        if entry.name() == "document.json" {
            data = serde_json::to_vec(document).unwrap();
        }
        output
            .start_file(
                entry.name(),
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        output.write_all(&data).unwrap();
    }
    for (name, data) in parts {
        output.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
        output.write_all(data).unwrap();
    }
    output.finish().unwrap().into_inner()
}
fn compare_metrics(a: &Document, b: &Document) {
    let before = Fonts::new().with_resources(&a.fonts).unwrap();
    let after = Fonts::new().with_resources(&b.fonts).unwrap();
    for (id, node) in a.nodes.iter().filter(|(_, n)| n.kind == "text") {
        let target = &b.nodes[id];
        assert_eq!(
            node.text_style.as_ref().map(|s| &s.font_id),
            target.text_style.as_ref().map(|s| &s.font_id)
        );
        assert_eq!(
            before.node_path(node).unwrap().svg_data(),
            after.node_path(target).unwrap().svg_data(),
            "glyph outlines {id}"
        );
        assert_eq!(
            before.node_measure(node, Some(node.width)).unwrap().width,
            after
                .node_measure(target, Some(target.width))
                .unwrap()
                .width,
            "width {id}"
        );
    }
}
#[test]
fn official_fontrefs_preserve_three_fonts_and_distinct_glyph_metrics() {
    let original = fixture();
    let bytes = interop::export_sketch(&original).unwrap();
    let payload = archive_json(&bytes);
    assert_eq!(payload["fontReferences"].as_array().unwrap().len(), 3);
    for reference in payload["fontReferences"].as_array().unwrap() {
        assert_eq!(reference["_class"], "fontReference");
        assert_eq!(reference["fontData"]["_ref_class"], "MSFontData");
    }
    let imported = interop::import_sketch_report(&bytes).unwrap();
    assert_eq!(original.fonts, imported.document.fonts);
    assert!(
        !imported
            .warnings
            .iter()
            .any(|w| w.contains("fonts without embedded"))
    );
    compare_metrics(&original, &imported.document);
    let fonts = Fonts::new().with_resources(&original.fonts).unwrap();
    assert!(
        fonts
            .node_measure(&original.nodes["a"], None)
            .unwrap()
            .width
            < fonts
                .node_measure(&original.nodes["b"], None)
                .unwrap()
                .width
    );
    let native = binfmt::decode(&binfmt::encode(&imported.document)).unwrap();
    assert_eq!(native.fonts, original.fonts);
}
#[test]
fn external_fontrefs_work_without_private_identity_metadata() {
    let doc = fixture();
    let bytes = interop::export_sketch(&doc).unwrap();
    let mut json = archive_json(&bytes);
    json.as_object_mut().unwrap().remove("userInfo");
    let imported = interop::import_sketch_report(&replace_document(&bytes, &json)).unwrap();
    assert_eq!(imported.document.fonts.len(), 3);
    let source_fonts = Fonts::new().with_resources(&doc.fonts).unwrap();
    let imported_fonts = Fonts::new()
        .with_resources(&imported.document.fonts)
        .unwrap();
    for (id, node) in &doc.nodes {
        assert_eq!(
            source_fonts.node_path(node).unwrap().svg_data(),
            imported_fonts
                .node_path(&imported.document.nodes[id])
                .unwrap()
                .svg_data()
        );
    }
    for font in doc.fonts.values() {
        assert!(
            imported
                .document
                .fonts
                .values()
                .any(|f| f.data == font.data)
        );
    }
}
#[test]
fn font_corruption_and_embedding_restrictions_are_explicit_errors() {
    let mut doc = fixture();
    let bytes = interop::export_sketch(&doc).unwrap();
    let mut json = archive_json(&bytes);
    json["fontReferences"][0]["fontData"]["sha1"]["_data"] = json!(STANDARD.encode([0u8; 20]));
    assert!(
        interop::import_sketch(&replace_document(&bytes, &json))
            .unwrap_err()
            .to_string()
            .contains("SHA-1")
    );
    let font = doc.fonts.get_mut("narrow").unwrap();
    let mut data = STANDARD.decode(font.data.as_bytes()).unwrap();
    let tables = u16::from_be_bytes([data[4], data[5]]) as usize;
    let table = (0..tables)
        .map(|i| 12 + i * 16)
        .find(|i| &data[*i..*i + 4] == b"OS/2")
        .unwrap();
    let offset = u32::from_be_bytes(data[table + 8..table + 12].try_into().unwrap()) as usize;
    data[offset + 8..offset + 10].copy_from_slice(&2u16.to_be_bytes());
    font.data = STANDARD.encode(data).into();
    assert!(
        interop::export_sketch(&doc)
            .unwrap_err()
            .to_string()
            .contains("embedding flags")
    );
}
#[test]
fn native_hdr_document_keeps_font_bytes_when_sketch_rejects_hdr() {
    let mut doc = fixture();
    doc.color_management = Some(futureox_design_kernel::color::ColorSettings {
        document_space: futureox_design_kernel::color::ColorSpace::Pq,
        ..Default::default()
    });
    let native = binfmt::decode(&binfmt::encode(&doc)).unwrap();
    assert_eq!(native.fonts, doc.fonts);
    assert_eq!(native.color_management, doc.color_management);
    assert!(interop::export_sketch(&doc).is_err());
    assert_eq!(native.fonts, doc.fonts);
}
#[test]
fn actual_mcp_sample_noto_roundtrip() {
    let Ok(path) = std::env::var("SKETCH_FONT_SAMPLE_FD") else {
        return;
    };
    let doc = binfmt::decode(&std::fs::read(path).unwrap()).unwrap();
    assert!(!doc.fonts.is_empty());
    let bytes = interop::export_sketch(&doc).unwrap();
    let report = interop::import_sketch_report(&bytes).unwrap();
    assert_eq!(doc.fonts, report.document.fonts);
    if let Ok(dir) = std::env::var("SKETCH_FONT_EVIDENCE") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(format!("{dir}/ops-fonts.sketch"), &bytes).unwrap();
        std::fs::write(
            format!("{dir}/ops-fonts.fontrefs.json"),
            serde_json::to_vec(&archive_json(&bytes)["fontReferences"]).unwrap(),
        )
        .unwrap();
    }
    compare_metrics(&doc, &report.document);
}

#[test]
fn resource_without_cached_postscript_resolves_real_font_name() {
    let mut doc = fixture();
    for resource in doc.fonts.values_mut() {
        resource.postscript = None;
    }
    let bytes = interop::export_sketch(&doc).unwrap();
    let imported = interop::import_sketch_report(&bytes).unwrap();
    assert_eq!(doc.fonts, imported.document.fonts);
    compare_metrics(&doc, &imported.document);
}

#[test]
fn nonembedded_native_declarations_preserve_names_and_report_substitution() {
    let bytes = interop::export_sketch(&fixture()).unwrap();
    let mut source = archive_json(&bytes);
    for reference in source["fontReferences"].as_array_mut().unwrap() {
        reference.as_object_mut().unwrap().remove("fontData");
    }
    let report = interop::import_sketch_report(&replace_document(&bytes, &source)).unwrap();
    assert!(report.document.fonts.is_empty());
    assert_eq!(report.document.design_system.as_ref().unwrap().sketch_containers["nonEmbeddedFontReferences"], source["fontReferences"]);
    assert!(report.warnings.iter().any(|w| w.contains("fonts without embedded resources")));
    for node in report.document.nodes.values().filter(|n| n.kind == "text") {
        assert_eq!(node.text_style.as_ref().unwrap().font_id, "default");
    }
    // Explicit data (even null), a wrong class or malformed declaration is
    // never reclassified as an installed-font fallback.
    for invalid in [json!(null), json!({}), json!({"_class":"MSJSONOriginalDataReference","_ref_class":"MSFontData"})] {
        let mut corrupt = source.clone(); corrupt["fontReferences"][0]["fontData"] = invalid;
        assert!(interop::import_sketch_report(&replace_document(&bytes, &corrupt)).is_err());
    }
    for (field, value) in [("_class", json!("other")), ("postscriptNames", json!([])), ("postscriptNames", json!([42])), ("fontFamilyName", json!(""))] {
        let mut corrupt = source.clone(); corrupt["fontReferences"][0][field] = value;
        assert!(interop::import_sketch_report(&replace_document(&bytes, &corrupt)).is_err());
    }
}

#[test]
fn thirty_four_declarations_with_file_fonts_preserve_bytes_and_installed_metadata() {
    let original = fixture();
    let bytes = interop::export_sketch(&original).unwrap();
    let mut source = archive_json(&bytes);
    let references = source["fontReferences"].as_array_mut().unwrap();
    let contents = STANDARD.decode(references[0]["fontData"]["data"]["_data"].as_str().unwrap()).unwrap();
    let part = "fonts/external-archive-id";
    references[0]["fontData"] = json!({"_class":"MSJSONFileReference","_ref_class":"MSFontData","_ref":part});
    let installed: Vec<_> = (0..31).map(|n| json!({"_class":"fontReference","fontFamilyName":"External",
        "postscriptNames":[format!("External-{n}")]})).collect();
    references.extend(installed.clone());
    let parse = |d: &Value| interop::import_sketch_report(&replace_document_with_parts(&bytes, d, &[(part,&contents)]));
    let imported = parse(&source).unwrap().document;
    assert_eq!(imported.fonts, original.fonts);
    assert_eq!(imported.design_system.as_ref().unwrap().sketch_containers["nonEmbeddedFontReferences"], json!(installed));
    let exported = archive_json(&interop::export_sketch(&imported).unwrap());
    assert_eq!(&exported["fontReferences"].as_array().unwrap()[3..], installed);
    for bad in [json!({"_ref":"fonts/missing"}),json!({"_ref":"../fonts/wrong"}),
        json!({"sha1":{"_data":"AA=="}}),json!({"data":{"_data":""}})] {
        let mut corrupt = source.clone();
        corrupt["fontReferences"][0]["fontData"].as_object_mut().unwrap().extend(bad.as_object().unwrap().clone());
        assert!(parse(&corrupt).is_err());
    }
    let mut too_many = source;
    too_many["fontReferences"] = json!(vec![too_many["fontReferences"][0].clone();33]);
    assert!(parse(&too_many).err().unwrap().to_string().contains("32 embedded"));
}
