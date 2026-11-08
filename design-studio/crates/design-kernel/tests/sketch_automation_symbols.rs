use futureox_design_kernel::{components, interop};
use serde_json::{Value, json};
use std::io::Write;

fn archive(layers: Vec<Value>) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, value) in [
        ("meta.json", json!({"version":144,"appVersion":"original-synthetic"})),
        ("document.json", json!({"_class":"document","pages":[{"_ref":"pages/page"}]})),
        ("pages/page.json", json!({"_class":"page","do_objectID":"page","layers":layers})),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
fn layer(id: &str, class: &str) -> Value {
    json!({"_class":class,"do_objectID":id,"name":id,"frame":{"x":10,"y":20,"width":140,"height":40}})
}
fn native_symbols() -> Vec<Value> {
    let mut text = layer("label", "text");
    text["textBehaviour"] = json!(2);
    text["attributedString"] = json!({"_class":"attributedString","string":"Original","attributes":[]});
    let mut main = layer("main", "symbolMaster");
    main["symbolID"] = json!("SYMBOL-A"); main["layers"] = json!([text]);
    let mut alternate = layer("alternate", "symbolMaster");
    alternate["symbolID"] = json!("SYMBOL-B");
    let mut nested = layer("nested", "symbolInstance"); nested["symbolID"] = json!("SYMBOL-A");
    let mut wrapper = layer("wrapper", "symbolMaster");
    wrapper["symbolID"] = json!("SYMBOL-WRAPPER"); wrapper["layers"] = json!([nested]);
    let mut instance = layer("instance", "symbolInstance");
    instance["symbolID"] = json!("SYMBOL-WRAPPER");
    instance["overrideValues"] = json!([{"overrideName":"nested/label_stringValue","value":"Native override"}]);
    let mut swapped = layer("swapped", "symbolInstance");
    swapped["symbolID"] = json!("SYMBOL-WRAPPER");
    swapped["overrideValues"] = json!([{"overrideName":"nested_symbolID","value":"SYMBOL-B"}]);
    vec![main, alternate, wrapper, instance, swapped]
}

#[test]
fn native_symbols_admit_real_master_ids_and_nested_text_and_swap_overrides() {
    let report = interop::import_sketch_report(&archive(native_symbols())).expect("native symbol admission");
    let mut doc = report.document;
    assert!(doc.nodes["main"].component.is_some());
    assert!(doc.nodes["alternate"].component.is_some());
    assert_eq!(doc.nodes["nested"].instance.as_ref().unwrap().component_id, "main");
    assert_eq!(doc.nodes["instance"].instance.as_ref().unwrap().component_id, "wrapper");
    assert_eq!(doc.nodes["instance"].instance.as_ref().unwrap().overrides["nested/label"]["text"], "Native override");
    assert_eq!(doc.nodes["swapped"].instance.as_ref().unwrap().overrides["nested"]["swapComponent"], "alternate");
    doc.validate().unwrap();
    components::resolve(&mut doc).unwrap();
    assert!(doc.nodes.values().any(|node| node.text == "Native override"));
}

#[test]
fn canonical_components_keys_properties_variants_and_overrides_survive_real_zip_roundtrip() {
    let mut doc = interop::import_sketch_report(&archive(native_symbols())).unwrap().document;
    doc.nodes.get_mut("main").unwrap().component.as_mut().unwrap().variants.insert("State".into(), "Default".into());
    doc.nodes.get_mut("main").unwrap().component.as_mut().unwrap().properties.insert("title".into(), components::Property {
        name: "Title".into(), kind: components::PropertyKind::Text, target_key: "label".into(), also_targets: Vec::new(), unbound: false, default_value: json!("Original"),
    });
    doc.nodes.get_mut("nested").unwrap().instance.as_mut().unwrap().property_values.insert("title".into(), json!("Property value"));
    let bytes = interop::export_sketch(&doc).unwrap();
    assert_eq!(&bytes[..4], b"PK\x03\x04");
    let files = interop::read_zip_public(&bytes).unwrap();
    let page: Value = serde_json::from_slice(files.iter().find(|(name, _)| name.starts_with("pages/")).unwrap().1).unwrap();
    let layers = page["layers"].as_array().unwrap();
    let find = |name: &str| layers.iter().find(|layer| layer["name"] == name).unwrap();
    assert_eq!(find("instance")["symbolID"], find("wrapper")["symbolID"]);
    assert_eq!(find("wrapper")["layers"][0]["symbolID"], find("main")["symbolID"]);
    assert_eq!(find("instance")["overrideValues"][0]["overrideName"], format!("{}/{}_stringValue",
        find("wrapper")["layers"][0]["do_objectID"].as_str().unwrap(),
        find("main")["layers"][0]["do_objectID"].as_str().unwrap()));
    assert_eq!(find("swapped")["overrideValues"][0]["value"], find("alternate")["symbolID"]);
    let mut reopened = interop::import_sketch_report(&bytes).expect("real exported archive admission").document;
    assert_eq!(reopened.nodes["main"].component, doc.nodes["main"].component);
    assert_eq!(reopened.nodes["label"].component_key, doc.nodes["label"].component_key);
    for id in ["instance", "nested", "swapped"] {
        assert_eq!(reopened.nodes[id].instance, doc.nodes[id].instance, "{id}");
    }
    reopened.validate().unwrap();
    components::resolve(&mut reopened).unwrap();
    assert!(reopened.nodes.values().any(|node| node.text == "Native override"));
}

#[test]
fn missing_and_ambiguous_symbols_and_unmapped_overrides_fail_explicitly() {
    let mut layers = native_symbols();
    layers[1]["symbolID"] = json!("SYMBOL-A");
    assert!(interop::import_sketch_report(&archive(layers)).err().unwrap().to_string().contains("ambiguous"));
    let mut layers = native_symbols();
    layers[3]["symbolID"] = json!("REMOTE-UNAVAILABLE");
    assert!(interop::import_sketch_report(&archive(layers)).err().unwrap().to_string().contains("embedded symbol master"));
    let mut layers = native_symbols();
    layers[3]["overrideValues"] = json!([{"overrideName":"nested/label_textStyle","value":{}}]);
    assert!(interop::import_sketch_report(&archive(layers)).err().unwrap().to_string().contains("no supported editable mapping"));
}

#[test]
fn a_symbol_definition_without_instances_is_still_an_editable_component() {
    let doc = interop::import_sketch_report(&archive(vec![native_symbols().remove(1)])).unwrap().document;
    assert!(doc.nodes["alternate"].component.is_some());
    assert!(doc.schema_version >= 4);
    doc.validate().unwrap();
}

#[test]
fn authored_rigid_transform_roundtrips_without_source_metadata_but_shear_is_refused() {
    let mut doc = interop::import_sketch_report(&archive(vec![layer("shape", "rectangle")])).unwrap().document;
    let (s, c) = 0.47_f64.sin_cos();
    let expected = [c, s, s, -c, 333.25, -77.5];
    doc.nodes.get_mut("shape").unwrap().transform.0 = expected;
    let reopened = interop::import_sketch_report(&interop::export_sketch(&doc).unwrap()).unwrap().document;
    for (actual, expected) in reopened.nodes["shape"].transform.0.into_iter().zip(expected) {
        assert!((actual - expected).abs() < 1e-12);
    }
    doc.nodes.get_mut("shape").unwrap().transform.0 = [1., 0., 0.25, 1., 10., 20.];
    assert!(interop::export_sketch(&doc).err().unwrap().to_string().contains("scaled or sheared"));
}

#[test]
fn emitted_symbol_and_override_references_work_without_futureox_private_metadata() {
    let doc = interop::import_sketch_report(&archive(native_symbols())).unwrap().document;
    let files = interop::read_zip_public(&interop::export_sketch(&doc).unwrap()).unwrap();
    let mut page: Value = serde_json::from_slice(files.iter().find(|(name, _)| name.starts_with("pages/")).unwrap().1).unwrap();
    fn strip(value: &mut Value) {
        match value {
            Value::Object(map) => { map.remove("userInfo"); for value in map.values_mut() { strip(value); } }
            Value::Array(values) => { for value in values { strip(value); } }
            _ => {}
        }
    }
    strip(&mut page);
    let mut native = interop::import_sketch_report(&archive(page["layers"].as_array().unwrap().clone())).unwrap().document;
    let alternate = native.nodes.values().find(|node| node.name == "alternate").unwrap().id.clone();
    let swapped = native.nodes.values().find(|node| node.name == "swapped").unwrap();
    assert!(swapped.instance.as_ref().unwrap().overrides.values().any(|fields| fields.get("swapComponent") == Some(&json!(alternate))));
    components::resolve(&mut native).unwrap();
    assert!(native.nodes.values().any(|node| node.text == "Native override"));
}

#[test]
fn fixed_box_text_override_keeps_geometry_after_export_import_and_layout() {
    use futureox_design_kernel::{font::Fonts, layout};
    let mut doc = interop::import_sketch_report(&archive(native_symbols())).unwrap().document;
    let label = doc.nodes.get_mut("label").unwrap();
    label.sizing = None;
    label.text_style.as_mut().unwrap().wrap = false;
    let bytes = interop::export_sketch(&doc).unwrap();
    let mut reopened = interop::import_sketch_report(&bytes).unwrap().document;
    components::resolve(&mut reopened).unwrap();
    let mut fonts = Fonts::new();
    fonts.load(&std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../frontend/design-client/public/fonts/NotoSansSC.ttf")).unwrap()).unwrap();
    layout::resolve(&mut reopened, &fonts).unwrap();
    let overridden = reopened.nodes.values().find(|node| node.text == "Native override").unwrap();
    assert_eq!((overridden.width, overridden.height), (140., 40.));
    assert!(!overridden.text_style.as_ref().unwrap().wrap);
}
