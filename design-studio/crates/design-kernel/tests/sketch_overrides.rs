//! Integration tests for the Sketch symbol override tree
//! (Sketch JSON dictionary §5, P1-12):
//! `overrideName` path syntax, nested-instance symbolID resourcing, the
//! color/image/layerStyle value families and the master's
//! `overrideProperties` (canOverride) inventory.
use futureox_design_kernel::interop::{export_sketch, import_sketch};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read as _, Write as _};

/// 1x1 transparent PNG.
const PNG: [u8; 67] = [
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

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
        out.insert(String::from_utf8_lossy(file.name_raw()).into_owned(), data);
    }
    out
}

/// A native-flavored bundle: one symbolMaster with an overrideProperties
/// inventory and one symbolInstance whose overrideValues exercise every value
/// family from 22 号字典 §5.
fn native_bundle() -> Vec<u8> {
    let master = json!({
        "_class": "symbolMaster",
        "do_objectID": "MASTER-1",
        "name": "Button",
        "symbolID": "SYM-1",
        "frame": {"_class": "rect", "x": 0., "y": 0., "width": 120., "height": 40.},
        "overrideProperties": [
            {"_class": "MSImmutableOverrideProperty", "canOverride": false,
             "overrideName": "L-TEXT_stringValue"},
            {"_class": "MSImmutableOverrideProperty", "canOverride": true,
             "overrideName": "L-FILL_color:fill-0"}
        ]
    });
    let instance = json!({
        "_class": "symbolInstance",
        "do_objectID": "INST-1",
        "name": "Button instance",
        "symbolID": "SYM-1",
        "frame": {"_class": "rect", "x": 10., "y": 20., "width": 120., "height": 40.},
        "overrideValues": [
            // multi-level path: container/nested text layer
            {"_class": "overrideValue", "overrideName": "A/B/C_stringValue", "value": "Live"},
            // nested instance resourcing = override a symbolID value
            {"_class": "overrideValue", "overrideName": "A/B/NEST_symbolID", "value": "SYM-OTHER"},
            // color families
            {"_class": "overrideValue", "overrideName": "A/B/FILL_color:fill-0",
             "value": {"_class": "color", "red": 1., "green": 0.5, "blue": 0., "alpha": 1.}},
            {"_class": "overrideValue", "overrideName": "A/B/SH_color:shadow-1",
             "value": {"_class": "color", "red": 0., "green": 0., "blue": 0., "alpha": 0.5}},
            // image override: file reference into the bundle's blobs
            {"_class": "overrideValue", "overrideName": "A/B/IMG_image",
             "value": {"_class": "MSJSONFileReference", "_ref_class": "MSImageData",
                       "_ref": "imgblob1"}},
            // layerStyle override: a native style dict
            {"_class": "overrideValue", "overrideName": "A/B/ST_layerStyle",
             "value": {"_class": "style", "do_objectID": "STYLE-1", "fills": []}},
            // bare name without a path segment imports under the "self" key
            {"_class": "overrideValue", "overrideName": "INST_horizontalSizing", "value": 1}
        ]
    });
    let page = json!({"_class": "page", "name": "P", "layers": [master, instance]});
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
        ("images/imgblob1", PNG.to_vec()),
    ])
}

fn exported_page(bytes: &[u8]) -> Value {
    let files = unpack(bytes);
    let name = files
        .keys()
        .find(|k| k.starts_with("pages/"))
        .expect("page part")
        .clone();
    serde_json::from_slice(&files[&name]).unwrap()
}

fn override_value<'a>(layer: &'a Value, name: &str) -> Option<&'a Value> {
    layer["overrideValues"].as_array()?.iter().find_map(|ov| {
        (ov["overrideName"].as_str()? == name).then(|| &ov["value"])
    })
}

#[test]
fn override_tree_imports_into_path_field_maps() {
    let doc = import_sketch(&native_bundle()).unwrap();
    let master = doc.nodes.get("MASTER-1").expect("master");
    assert_eq!(
        master.bindings.get("symbolID").map(String::as_str),
        Some("SYM-1")
    );
    let properties = master
        .bindings
        .get("sketchOverrideProperties")
        .expect("overrideProperties inventory rides bindings");
    assert!(properties.contains("L-TEXT_stringValue"));
    assert!(properties.contains("\"canOverride\":false"));

    let instance = doc.nodes.get("INST-1").expect("instance");
    let inst = instance.instance.as_ref().expect("instance payload");
    assert_eq!(inst.component_id, "SYM-1");
    let nested = inst.overrides.get("A/B").expect("multi-level path");
    assert_eq!(nested.get("C_stringValue"), Some(&json!("Live")));
    assert_eq!(nested.get("NEST_symbolID"), Some(&json!("SYM-OTHER")));
    // color dicts stay verbatim native payloads
    assert_eq!(
        nested.get("FILL_color:fill-0").and_then(|v| v.get("green")),
        Some(&json!(0.5))
    );
    assert_eq!(
        nested.get("SH_color:shadow-1").and_then(|v| v.get("alpha")),
        Some(&json!(0.5))
    );
    assert_eq!(
        nested.get("ST_layerStyle").and_then(|v| v.get("_class")),
        Some(&json!("style"))
    );
    // image overrides resolve to a self-contained data URI
    let image = nested.get("IMG_image").and_then(Value::as_str).unwrap();
    assert!(image.starts_with("data:image/png;base64,"), "{image}");
    assert_eq!(
        inst.overrides.get("self").and_then(|f| f.get("INST_horizontalSizing")),
        Some(&json!(1))
    );
}

#[test]
fn override_tree_round_trips_all_value_families() {
    let doc = import_sketch(&native_bundle()).unwrap();
    let re = export_sketch(&doc).unwrap();
    let files = unpack(&re);
    let page = exported_page(&re);
    let layers = page["layers"].as_array().unwrap();
    let master = layers
        .iter()
        .find(|l| l["_class"] == "symbolMaster")
        .expect("master stays a symbolMaster");
    assert_eq!(master["symbolID"], "SYM-1");
    let properties = master["overrideProperties"].as_array().unwrap();
    assert_eq!(properties.len(), 2, "canOverride inventory restored");
    assert_eq!(properties[0]["overrideName"], "L-TEXT_stringValue");
    assert_eq!(properties[0]["canOverride"], false);

    let instance = layers
        .iter()
        .find(|l| l["_class"] == "symbolInstance")
        .expect("instance stays a symbolInstance");
    assert_eq!(instance["symbolID"], "SYM-1");
    assert_eq!(
        override_value(instance, "A/B/C_stringValue"),
        Some(&json!("Live"))
    );
    assert_eq!(
        override_value(instance, "A/B/NEST_symbolID"),
        Some(&json!("SYM-OTHER")),
        "nested resourcing survives the round trip"
    );
    let fill = override_value(instance, "A/B/FILL_color:fill-0").unwrap();
    assert_eq!(fill["_class"], "color");
    assert_eq!(fill["green"], 0.5);
    let shadow = override_value(instance, "A/B/SH_color:shadow-1").unwrap();
    assert_eq!(shadow["alpha"], 0.5);
    let style = override_value(instance, "A/B/ST_layerStyle").unwrap();
    assert_eq!(style["_class"], "style", "layerStyle dict passes through");
    assert_eq!(
        override_value(instance, "INST_horizontalSizing"),
        Some(&json!(1))
    );
    // The image override re-archives as a file reference whose blob exists.
    let image = override_value(instance, "A/B/IMG_image").unwrap();
    assert_eq!(image["_class"], "MSJSONFileReference");
    let reference = image["_ref"].as_str().unwrap();
    assert!(reference.starts_with("images/"));
    assert_eq!(
        files.get(reference).map(Vec::as_slice),
        Some(PNG.as_slice()),
        "referenced image blob is in the bundle"
    );
    // Nothing was dropped on the way out.
    let lossy = &instance["userInfo"]["com.futureox.design-kernel"]["lossy"];
    assert!(lossy.is_null() || lossy.as_array().is_some_and(Vec::is_empty));

    // And the re-export imports back to the same model shape.
    let again = import_sketch(&re).unwrap();
    let inst = again.nodes["INST-1"].instance.as_ref().unwrap();
    assert_eq!(
        inst.overrides.get("A/B").and_then(|f| f.get("NEST_symbolID")),
        Some(&json!("SYM-OTHER"))
    );
    assert!(
        again.nodes["MASTER-1"]
            .bindings
            .contains_key("sketchOverrideProperties")
    );
}

#[test]
fn kernel_authored_overrides_export_and_unsupported_values_are_reported() {
    let mut doc = import_sketch(&native_bundle()).unwrap();
    {
        let node = doc.nodes.get_mut("INST-1").unwrap();
        let inst = node.instance.as_mut().unwrap();
        let fields = inst.overrides.entry("A/B".into()).or_default();
        // Kernel paint object (fig-style) becomes a Sketch color override.
        fields.insert(
            "PAINT_color:fill-1".into(),
            json!({"kind": "solid", "color": "#112233", "opacity": 0.5}),
        );
        // A kernel image paint object archives its blob + a file reference.
        let uri = format!(
            "data:image/png;base64,{}",
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, PNG)
        );
        fields.insert("NEWIMG_image".into(), json!({"kind": "image", "image": uri}));
        // Arrays have no archived override form: dropped with a report.
        fields.insert("BROKEN_stringValue".into(), json!([1, 2]));
    }
    let re = export_sketch(&doc).unwrap();
    let files = unpack(&re);
    let page = exported_page(&re);
    let layers = page["layers"].as_array().unwrap();
    let instance = layers
        .iter()
        .find(|l| l["_class"] == "symbolInstance")
        .unwrap();
    let color = override_value(instance, "A/B/PAINT_color:fill-1").unwrap();
    assert_eq!(color["_class"], "color");
    assert!((color["red"].as_f64().unwrap() - 0x11 as f64 / 255.).abs() < 1e-9);
    assert_eq!(color["alpha"], 0.5);
    let image = override_value(instance, "A/B/NEWIMG_image").unwrap();
    assert_eq!(image["_class"], "MSJSONFileReference");
    let reference = image["_ref"].as_str().unwrap();
    assert!(reference.starts_with("images/"));
    assert_eq!(
        files.get(reference).map(Vec::as_slice),
        Some(PNG.as_slice())
    );
    assert!(
        override_value(instance, "A/B/BROKEN_stringValue").is_none(),
        "array values cannot archive"
    );
    let lossy = instance["userInfo"]["com.futureox.design-kernel"]["lossy"]
        .as_array()
        .expect("dropped override reported");
    assert!(
        lossy.iter().any(|n| n.as_str().is_some_and(|s| s.contains("BROKEN_stringValue"))),
        "{lossy:?}"
    );
    // The report survives re-import as an honest round-trip warning.
    let back = import_sketch(&re).unwrap();
    let note = back.nodes["INST-1"]
        .bindings
        .get("sketchExportLossy")
        .expect("lossy list round-trips");
    assert!(note.contains("BROKEN_stringValue"), "{note}");
}
