//! P0-4: MSAdaptableColor 深浅适配色 + updatableColors 保真(05-style.md §3、
//! 24-c1-c11-completion.md C9:无独立 resolvedColor,由 updatableColors 驱动)。
//! 双值原文进 bindings(light 值进 Paint/文本颜色路径),导出按 slot 还原。
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

fn read_page(bytes: &[u8]) -> Value {
    let files = read_zip_public(bytes).unwrap();
    let name = files
        .keys()
        .find(|n| n.starts_with("pages/"))
        .unwrap()
        .clone();
    serde_json::from_slice(&files[&name]).unwrap()
}

fn adaptable_fill_color() -> Value {
    json!({
        "_class": "MSAdaptableColor",
        "swatchID": "SW-UUID-1",
        "light": {"_class": "color", "red": 1.0, "green": 0.0, "blue": 0.0, "alpha": 1.0},
        "dark": {"_class": "color", "red": 0.0, "green": 0.0, "blue": 1.0, "alpha": 0.8}
    })
}

fn rect_layer_with_adaptable_fill() -> Value {
    json!({
        "_class": "rectangle",
        "do_objectID": "LAYER-1",
        "name": "Adaptive Card",
        "frame": {"_class": "rect", "x": 0.0, "y": 0.0, "width": 100.0, "height": 60.0},
        "updatableColors": [{"_class": "color", "red": 1.0, "green": 0.0, "blue": 0.0, "alpha": 1.0}],
        "style": {
            "_class": "style",
            "updatableColors": [{"_class": "color", "red": 0.0, "green": 0.0, "blue": 1.0, "alpha": 0.8}],
            "fills": [{"_class": "fill", "isEnabled": true, "fillType": 0,
                       "color": adaptable_fill_color()}],
            "borders": [],
            "shadows": [],
            "contextSettings": {"_class": "graphicsContextSettings", "blendMode": 0, "opacity": 1.0}
        }
    })
}

#[test]
fn adaptable_fill_imports_light_value_and_keeps_raw_dual_values() {
    let bytes = sketch_zip(
        document_json(vec![]),
        page_json(vec![rect_layer_with_adaptable_fill()]),
    );
    let doc = import_sketch(&bytes).unwrap();
    let node = doc.nodes.get("LAYER-1").expect("layer imported");

    // 默认外观(light 值)进入现有 Paint.color 路径
    assert_eq!(node.fills.len(), 1);
    assert_eq!(node.fills[0].kind, "solid");
    assert_eq!(node.fills[0].color, "#ff0000");
    assert!((node.fills[0].opacity - 1.0).abs() < 1e-9);

    // 双值原文保真进 bindings,swatchID 引用保留
    let raw = node
        .bindings
        .get("sketchAdaptableColor.fill.0")
        .expect("adaptable raw kept");
    let raw: Value = serde_json::from_str(raw).unwrap();
    assert_eq!(raw, adaptable_fill_color());
    assert_eq!(
        raw["dark"]["blue"], 1.0,
        "dark appearance value survives verbatim"
    );
    assert_eq!(
        node.bindings.get("sketchSwatchID.fill.0").map(String::as_str),
        Some("SW-UUID-1")
    );

    // 图层与样式上的 updatableColors 同样保真保留
    assert!(node.bindings.contains_key("sketchAdaptableColor.updatableColors"));
    assert!(
        node.bindings
            .contains_key("sketchAdaptableColor.styleUpdatableColors")
    );

    // 深色值不参与内核渲染:显式降级记录,不静默
    let lossy = node
        .bindings
        .get("sketchImportLossy")
        .expect("degradation reported");
    assert!(lossy.contains("adaptable-color"), "{lossy}");
}

#[test]
fn adaptable_fill_round_trips_verbatim() {
    let bytes = sketch_zip(
        document_json(vec![]),
        page_json(vec![rect_layer_with_adaptable_fill()]),
    );
    let doc = import_sketch(&bytes).unwrap();
    let out = export_sketch(&doc).unwrap();
    let page = read_page(&out);
    let layer = &page["layers"][0];

    // 适配色原文回到 fill color 槽位(含 dark 值)
    assert_eq!(layer["style"]["fills"][0]["color"], adaptable_fill_color());
    // 图层/样式上的 updatableColors 还原
    assert_eq!(
        layer["updatableColors"],
        json!([{"_class": "color", "red": 1.0, "green": 0.0, "blue": 0.0, "alpha": 1.0}])
    );
    assert_eq!(
        layer["style"]["updatableColors"],
        json!([{"_class": "color", "red": 0.0, "green": 0.0, "blue": 1.0, "alpha": 0.8}])
    );
}

#[test]
fn adaptable_text_run_color_imports_and_round_trips() {
    // 0.2/0.4/0.6 → 0x33/0x66/0x99,hex 路径精确
    let run_color = json!({
        "_class": "MSAdaptableColor",
        "light": {"_class": "color", "red": 0.2, "green": 0.4, "blue": 0.6, "alpha": 1.0},
        "dark": {"_class": "color", "red": 0.9, "green": 0.9, "blue": 0.95, "alpha": 1.0}
    });
    let text_layer = json!({
        "_class": "text",
        "do_objectID": "TEXT-1",
        "name": "Caption",
        "frame": {"_class": "rect", "x": 0.0, "y": 0.0, "width": 200.0, "height": 24.0},
        "attributedString": {
            "_class": "attributedString",
            "string": "Hello",
            "attributes": [{
                "_class": "stringAttribute", "location": 0, "length": 5,
                "attributes": {
                    "MSAttributedStringFontAttribute": {"_class": "fontDescriptor",
                        "attributes": {"name": "HelveticaNeue", "size": 20.0}},
                    "MSAttributedStringColorAttribute": run_color
                }
            }]
        }
    });
    let bytes = sketch_zip(document_json(vec![]), page_json(vec![text_layer]));
    let doc = import_sketch(&bytes).unwrap();
    let node = doc.nodes.get("TEXT-1").expect("text imported");

    // light 值进入文本颜色路径(run 颜色 + 首 run 默认 fill)
    assert_eq!(node.text_runs.len(), 1);
    assert_eq!(node.text_runs[0].color.as_deref(), Some("#336699"));
    assert_eq!(node.fills[0].color, "#336699");
    let raw: Value = serde_json::from_str(
        node.bindings
            .get("sketchAdaptableColor.run.0")
            .expect("run color raw kept"),
    )
    .unwrap();
    assert_eq!(raw, run_color);

    let out = export_sketch(&doc).unwrap();
    let page = read_page(&out);
    assert_eq!(
        page["layers"][0]["attributedString"]["attributes"][0]["attributes"]
            ["MSAttributedStringColorAttribute"],
        run_color
    );
}

#[test]
fn shared_style_adaptable_colors_ride_container_fidelity() {
    // document.json layerStyles 容器内的共享样式同样可能携带适配色与
    // updatableColors;槽位按 style id 存进 sketch_containers。
    let style_color = adaptable_fill_color();
    let bytes = sketch_zip(
        document_json(vec![(
            "layerStyles",
            json!({"_class": "sharedStyleContainer", "objects": [{
                "do_objectID": "STYLE-1",
                "name": "Brand Fill",
                "style": {
                    "_class": "style",
                    "updatableColors": [{"_class": "color", "red": 1.0, "green": 0.0,
                                         "blue": 0.0, "alpha": 1.0}],
                    "fills": [{"_class": "fill", "isEnabled": true, "fillType": 0,
                               "color": style_color}],
                    "borders": [], "shadows": []
                }
            }]}),
        )]),
        page_json(vec![rect_layer_with_adaptable_fill()]),
    );
    let doc = import_sketch(&bytes).unwrap();
    let system = doc.design_system.as_ref().expect("design system");
    let shared = system.styles.get("STYLE-1").expect("shared style");
    // light 值进入样式 value 的 Paint 路径
    assert_eq!(shared.value[0]["color"], "#ff0000");
    // 原文按 style id 存档
    let fidelity = &system.sketch_containers["sharedStyleFidelity"]["STYLE-1"];
    assert_eq!(fidelity["colors"]["fill.0"], style_color);
    assert_eq!(fidelity["swatchID"]["fill.0"], "SW-UUID-1");
    assert_eq!(
        fidelity["updatableColors"],
        json!([{"_class": "color", "red": 1.0, "green": 0.0, "blue": 0.0, "alpha": 1.0}])
    );

    let out = export_sketch(&doc).unwrap();
    let files = read_zip_public(&out).unwrap();
    let document: Value = serde_json::from_slice(&files["document.json"]).unwrap();
    let style = &document["layerStyles"]["objects"][0]["value"];
    assert_eq!(style["fills"][0]["color"], style_color);
    assert_eq!(
        style["updatableColors"],
        json!([{"_class": "color", "red": 1.0, "green": 0.0, "blue": 0.0, "alpha": 1.0}])
    );
}
