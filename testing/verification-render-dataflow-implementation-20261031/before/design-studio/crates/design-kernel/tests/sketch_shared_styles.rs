//! P1-13: 共享样式容器 / sharedSwatches 色板 / foreignSymbols 外部符号
//! (22-sketch-json-dictionary.md §6、sketchmodel.md MSImmutableForeignSymbol 族)。
use futureox_design_kernel::interop::{export_sketch, import_sketch, read_zip_public};
use serde_json::{Value, json};
use std::io::Write;

fn sketch_zip(document: Value, page: Value) -> Vec<u8> {
    let mut sink = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut sink);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, value) in [
            ("meta.json".to_string(), json!({"appVersion": "99.1"})),
            ("document.json".to_string(), document),
            ("pages/PAGE-1.json".to_string(), page),
        ] {
            zip.start_file(name, options).unwrap();
            zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
        }
        zip.finish().unwrap();
    }
    sink.into_inner()
}

fn document_json(extra: Vec<(&str, Value)>) -> Value {
    let mut doc = json!({
        "_class": "document",
        "do_objectID": "DOC-1",
        "colorSpace": 1,
        "pages": [{"_class": "MSJSONFileReference", "_ref_class": "MSImmutablePage",
                   "_ref": "pages/PAGE-1"}]
    });
    for (key, value) in extra {
        doc[key] = value;
    }
    doc
}

fn page_json(layers: Vec<Value>) -> Value {
    json!({"_class": "page", "do_objectID": "PAGE-1", "name": "Page 1", "layers": layers})
}

fn exported_document(bytes: &[u8]) -> Value {
    let files = read_zip_public(bytes).unwrap();
    serde_json::from_slice(&files["document.json"]).unwrap()
}

#[test]
fn shared_swatches_round_trip_verbatim() {
    // 22 号字典 §6:sharedSwatches{objects:[swatch]},swatch 实样
    // {_class:swatch, name, value:{_class:color,rgba}}。design_system 无
    // 色板概念 → document 级保真往返存储。
    let swatches = json!({
        "_class": "swatchContainer",
        "do_objectID": "SWATCH-CONTAINER-1",
        "objects": [
            {"_class": "swatch", "do_objectID": "SW-UUID-1", "name": "1。殷红",
             "value": {"_class": "color", "red": 0.8, "green": 0.1, "blue": 0.2, "alpha": 1.0}},
            {"_class": "swatch", "do_objectID": "SW-UUID-2", "name": "Accent",
             "value": {"_class": "color", "red": 0.0, "green": 0.5, "blue": 0.9, "alpha": 0.7}}
        ]
    });
    let bytes = sketch_zip(
        document_json(vec![("sharedSwatches", swatches.clone())]),
        page_json(vec![]),
    );
    let doc = import_sketch(&bytes).unwrap();
    let system = doc.design_system.as_ref().expect("design system");
    assert_eq!(system.sketch_containers["sharedSwatches"], swatches);

    let out = export_sketch(&doc).unwrap();
    let document = exported_document(&out);
    assert_eq!(document["sharedSwatches"], swatches);
}

fn foreign_symbol_entry() -> Value {
    json!({
        "_class": "MSImmutableForeignSymbol",
        "do_objectID": "FS-1",
        "libraryID": "LIB-UUID-9",
        "sourceLibraryName": "Shared Kit",
        "symbolPrivate": false,
        "missingLibraryFontAcknowledged": false,
        "remoteToLocalIDMap": {"REMOTE-1": "LOCAL-1"},
        "originalMaster": {
            "_class": "symbolMaster",
            "do_objectID": "ORIG-MASTER-1",
            "symbolID": "SYM-UUID-1",
            "name": "Button",
            "frame": {"_class": "rect", "x": 0.0, "y": 0.0, "width": 80.0, "height": 32.0},
            "layers": []
        },
        "symbolMaster": {
            "_class": "symbolMaster",
            "do_objectID": "EMBEDDED-MASTER-1",
            "symbolID": "SYM-UUID-1",
            "name": "Button",
            "frame": {"_class": "rect", "x": 0.0, "y": 0.0, "width": 80.0, "height": 32.0},
            "layers": [{
                "_class": "rectangle",
                "do_objectID": "EMBEDDED-RECT-1",
                "name": "bg",
                "frame": {"_class": "rect", "x": 0.0, "y": 0.0, "width": 80.0, "height": 32.0},
                "style": {"_class": "style", "fills": [], "borders": [], "shadows": []}
            }]
        }
    })
}

fn foreign_symbols_document() -> Vec<u8> {
    // 第二个条目没有内嵌 symbolMaster(库缺失):必须显式保真,不静默丢
    let unresolved = json!({
        "_class": "MSImmutableForeignSymbol",
        "do_objectID": "FS-2",
        "libraryID": "LIB-GONE",
        "symbolPrivate": true,
        "originalMaster": {
            "_class": "symbolMaster",
            "do_objectID": "ORIG-MASTER-2",
            "symbolID": "SYM-UUID-2",
            "name": "Ghost",
            "frame": {"_class": "rect", "x": 0.0, "y": 0.0, "width": 10.0, "height": 10.0},
            "layers": []
        }
    });
    let instance = json!({
        "_class": "symbolInstance",
        "do_objectID": "INST-1",
        "name": "Button instance",
        "symbolID": "SYM-UUID-1",
        "overrideValues": [],
        "frame": {"_class": "rect", "x": 10.0, "y": 10.0, "width": 80.0, "height": 32.0}
    });
    sketch_zip(
        document_json(vec![(
            "foreignSymbols",
            json!([foreign_symbol_entry(), unresolved]),
        )]),
        page_json(vec![instance]),
    )
}

#[test]
fn foreign_symbol_embedded_master_becomes_local_master() {
    let doc = import_sketch(&foreign_symbols_document()).unwrap();

    // 内嵌 symbolMaster 副本建为本地 master,bindings 标记库来源
    let master = doc.nodes.get("EMBEDDED-MASTER-1").expect("local master");
    assert_eq!(master.kind, "frame");
    assert_eq!(master.name, "Button");
    assert_eq!(
        master.bindings.get("symbolID").map(String::as_str),
        Some("SYM-UUID-1")
    );
    assert_eq!(
        master
            .bindings
            .get("sketchForeignLibraryID")
            .map(String::as_str),
        Some("LIB-UUID-9")
    );
    // 库链接是静态的:显式 interopLimited,不伪装成可更新引用
    let limited = master
        .bindings
        .get("interopLimited")
        .expect("limited mapping noted");
    assert!(limited.contains("foreign-symbol"), "{limited}");

    // originalMaster 原始保留
    let raw: Value = serde_json::from_str(
        master
            .bindings
            .get("sketchForeignSymbolRaw")
            .expect("raw foreign entry"),
    )
    .unwrap();
    assert_eq!(raw["originalMaster"]["do_objectID"], "ORIG-MASTER-1");
    assert_eq!(raw["remoteToLocalIDMap"]["REMOTE-1"], "LOCAL-1");

    // Instance 照常引用(embedded 副本的 symbolID)
    let instance = doc.nodes.get("INST-1").expect("instance");
    let inst = instance.instance.as_ref().expect("instance payload");
    assert_eq!(inst.component_id, "SYM-UUID-1");

    // 无内嵌副本的条目进 document 级保真存储
    let system = doc.design_system.as_ref().expect("design system");
    let unresolved = system.sketch_containers["foreignSymbolsUnresolved"]
        .as_array()
        .expect("unresolved entries kept");
    assert_eq!(unresolved.len(), 1);
    assert_eq!(unresolved[0]["do_objectID"], "FS-2");
}

#[test]
fn foreign_symbols_round_trip_rebuilds_entries() {
    let doc = import_sketch(&foreign_symbols_document()).unwrap();
    let out = export_sketch(&doc).unwrap();
    let document = exported_document(&out);
    let entries = document["foreignSymbols"].as_array().expect("foreignSymbols");
    assert_eq!(entries.len(), 2);

    // 可导入条目:embedded 副本从活节点重新导出,originalMaster 原文保留
    let entry = entries
        .iter()
        .find(|e| e["libraryID"] == "LIB-UUID-9")
        .expect("resolved entry");
    assert_eq!(entry["_class"], "MSImmutableForeignSymbol");
    assert_eq!(entry["sourceLibraryName"], "Shared Kit");
    assert_eq!(entry["originalMaster"], foreign_symbol_entry()["originalMaster"]);
    assert_eq!(
        entry["remoteToLocalIDMap"],
        json!({"REMOTE-1": "LOCAL-1"})
    );
    assert_eq!(entry["symbolMaster"]["_class"], "symbolMaster");
    assert_eq!(entry["symbolMaster"]["symbolID"], "SYM-UUID-1");
    assert_eq!(entry["symbolMaster"]["name"], "Button");

    // 无内嵌副本的条目原文回写
    let ghost = entries
        .iter()
        .find(|e| e["libraryID"] == "LIB-GONE")
        .expect("unresolved entry");
    assert_eq!(ghost["do_objectID"], "FS-2");
    assert_eq!(ghost["originalMaster"]["do_objectID"], "ORIG-MASTER-2");
    assert_eq!(ghost["symbolPrivate"], true);
    assert!(ghost.get("symbolMaster").is_none());
}
