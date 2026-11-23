//! Symbol-master backgrounds are Sketch artboard colors, not style fills.
use futureox_design_kernel::interop;
use serde_json::{Value, json};
use std::io::Write;

fn archive(layers: Vec<Value>) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    let document = json!({
        "_class": "document",
        "do_objectID": "DOC",
        "colorSpace": 0,
        "currentPageIndex": 0,
        "pages": [{"_class": "MSJSONFileReference", "_ref": "pages/page"}]
    });
    let page = json!({
        "_class": "page",
        "do_objectID": "page",
        "name": "Page",
        "layers": layers
    });
    for (name, value) in [
        ("meta.json", json!({"appVersion": "99.1", "version": 136})),
        ("document.json", document),
        ("user.json", json!({})),
        ("pages/page.json", page),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn master(include_in_instance: bool) -> Value {
    json!({
        "_class": "symbolMaster",
        "do_objectID": "MASTER",
        "symbolID": "SYM",
        "name": "Master",
        "allowsOverrides": false,
        "resizesContent": true,
        "includeBackgroundColorInInstance": include_in_instance,
        "hasBackgroundColor": true,
        "backgroundColor": {"_class": "color", "red": 1, "green": 0, "blue": 0, "alpha": 1},
        "frame": {"_class": "rect", "x": 0, "y": 0, "width": 40, "height": 40},
        "layers": [{
            "_class": "rectangle",
            "do_objectID": "CHILD",
            "name": "Child",
            "frame": {"_class": "rect", "x": 4, "y": 4, "width": 8, "height": 8},
            "style": {"fills": [{"isEnabled": true, "fillType": 0, "color": {"red": 0, "green": 0, "blue": 1, "alpha": 1}}]}
        }]
    })
}

fn instance() -> Value {
    json!({
        "_class": "symbolInstance",
        "do_objectID": "INST",
        "name": "Instance",
        "symbolID": "SYM",
        "scale": 2,
        "frame": {"_class": "rect", "x": 50, "y": 0, "width": 40, "height": 40}
    })
}

fn import(bytes: &[u8]) -> futureox_design_kernel::scene::Document {
    interop::import_sketch_report(bytes).unwrap().document
}

fn pixel(document: &futureox_design_kernel::scene::Document, x: u32, y: u32) -> [u8; 4] {
    let mut engine = futureox_design_kernel::Engine::new();
    engine
        .load_document(&serde_json::to_string(document).unwrap())
        .unwrap();
    let rgba = engine
        .render(&futureox_design_kernel::RenderOptions {
            page_id: "page".into(),
            width: 100,
            height: 40,
            view: futureox_design_kernel::View {
                x: 0.,
                y: 0.,
                zoom: 1.,
            },
            transparent: true,
            grid: false,
            pixel_preview: None,
            animation: None,
            raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
            interactive_effects: false,
            checkerboard: false,
        })
        .unwrap();
    let index = ((y * 100 + x) * 4) as usize;
    rgba[index..index + 4].try_into().unwrap()
}

fn exported_master(document: &futureox_design_kernel::scene::Document) -> Value {
    let bytes = interop::export_sketch(document).unwrap();
    let files = interop::read_zip_public(&bytes).unwrap();
    let page = files
        .iter()
        .find(|(name, _)| name.starts_with("pages/"))
        .unwrap();
    let page: Value = serde_json::from_slice(page.1).unwrap();
    page["layers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|layer| layer["name"] == "Master")
        .unwrap()
        .clone()
}

#[test]
fn symbol_master_background_paints_the_master_and_stays_out_of_instances() {
    let doc = import(&archive(vec![master(false), instance()]));
    let background = doc.nodes["MASTER"]
        .fills
        .iter()
        .find(|paint| paint.id == "sketch-symbol-background")
        .unwrap();
    assert_eq!(background.color, "#ff0000");
    assert_eq!(doc.nodes["MASTER"].fills.len(), 1);
    assert_eq!(pixel(&doc, 20, 20), [255, 0, 0, 255], "master background");
    assert_eq!(pixel(&doc, 6, 6), [0, 0, 255, 255], "master child");
    assert_eq!(
        pixel(&doc, 70, 20),
        [0, 0, 0, 0],
        "instance omits the master background"
    );
    assert_eq!(
        pixel(&doc, 56, 6),
        [0, 0, 255, 255],
        "instance still draws symbol content"
    );

    let native = exported_master(&doc);
    assert_eq!(native["hasBackgroundColor"], true);
    assert_eq!(native["includeBackgroundColorInInstance"], false);
    assert_eq!(native["backgroundColor"]["red"].as_f64(), Some(1.0));
    assert_eq!(native["backgroundColor"]["green"].as_f64(), Some(0.0));
    assert_eq!(native["backgroundColor"]["blue"].as_f64(), Some(0.0));
    assert_eq!(native["backgroundColor"]["alpha"].as_f64(), Some(1.0));
    let fills = native["style"]["fills"].as_array().unwrap();
    assert!(
        fills.is_empty(),
        "background is not rewritten as a style fill: {fills:?}"
    );

    let again = import(&interop::export_sketch(&doc).unwrap());
    assert_eq!(pixel(&again, 20, 20), [255, 0, 0, 255]);
    assert_eq!(pixel(&again, 70, 20), [0, 0, 0, 0]);
}

#[test]
fn symbol_master_background_is_included_in_instances_when_requested() {
    let doc = import(&archive(vec![master(true), instance()]));
    assert_eq!(pixel(&doc, 70, 20), [255, 0, 0, 255]);
    assert_eq!(
        exported_master(&doc)["includeBackgroundColorInInstance"],
        true
    );
}
