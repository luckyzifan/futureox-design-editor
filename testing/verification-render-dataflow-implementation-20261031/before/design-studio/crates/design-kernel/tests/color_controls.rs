use futureox_design_kernel::{Engine, interop, scene::Document};
use serde_json::json;

fn fixture() -> Document {
    interop::import_sketch_report(include_bytes!("../../../../testing/fixtures/design/sketch-color-controls.sketch"))
        .unwrap().document
}
fn render(doc:&Document, board:&str) -> Vec<u8> {
    let root=doc.nodes.values().find(|n|n.name==board).unwrap();
    let mut engine=Engine::new();engine.load_document(&serde_json::to_string(doc).unwrap()).unwrap();
    let options=engine.parse_options(json!({"pageId":doc.pages[0].id,"width":128,"height":128,
        "view":{"x":-root.transform.0[4],"y":-root.transform.0[5],"zoom":1}})).unwrap();
    engine.render(&options).unwrap()
}
#[test]
fn sketch_bitmap_colors_match_native_reference_and_roundtrip_edits() {
    let mut doc=fixture();
    assert_eq!(doc.schema_version,17);
    // Measured from Sketch 2025.1.3 PNG exports, before candidate rendering.
    for (name,rgb) in [("neutral",[51,102,179]),("saturation0",[97,97,97]),
                      ("contrast14",[84,141,228]),("hue07",[115,82,189])] {
        let bytes=render(&doc,name);
        let index=(64*128+64)*4;
        assert_eq!(&bytes[index..index+4],&[rgb[0],rgb[1],rgb[2],255]);
    }
    let id=doc.nodes.values().find(|n|n.name=="saturation0-shape").unwrap().id.clone();
    let original=render(&doc,"saturation0");
    doc.nodes.get_mut(&id).unwrap().effects.iter_mut().find(|e|e.kind=="color-controls").unwrap()
        .color_controls.as_mut().unwrap().saturation=1.;
    let edited=render(&doc,"saturation0");assert_ne!(original,edited);
    let encoded=interop::export_sketch(&doc).unwrap();
    // Native Sketch resolves _ref literally relative to the ZIP root. Our
    // importer also accepts old basename-only refs, so a self-roundtrip alone
    // cannot catch a missing images/ prefix or a lost native bitmap class.
    let mut archive=zip::ZipArchive::new(std::io::Cursor::new(&encoded)).unwrap();
    let page=archive.file_names().find(|n|n.starts_with("pages/") && n.ends_with(".json")).unwrap().to_owned();
    let value:serde_json::Value=serde_json::from_reader(archive.by_name(&page).unwrap()).unwrap();
    for board in value["layers"].as_array().unwrap() {
        let bitmap=&board["layers"][0];
        assert_eq!(bitmap["_class"],"bitmap");
        assert_eq!(bitmap["style"]["fills"],json!([]));
        let reference=bitmap["image"]["_ref"].as_str().unwrap();
        assert!(reference.starts_with("images/"));
        assert!(archive.by_name(reference).is_ok());
    }
    let reopened=interop::import_sketch_report(&encoded).unwrap().document;
    assert_eq!(edited,render(&reopened,"saturation0"));
    doc.nodes.get_mut(&id).unwrap().effects.clear();
    let reopened=interop::import_sketch_report(&interop::export_sketch(&doc).unwrap()).unwrap().document;
    assert!(reopened.nodes[&id].effects.iter().all(|e|e.kind!="color-controls"),"source payload must not resurrect deleted effect");
}
#[test]
fn older_schema_cannot_silently_accept_active_color_controls() {
    let mut doc=fixture();doc.schema_version=16;
    assert!(doc.validate().unwrap_err().contains("schema 17"));
}
#[test]
fn zero_radius_background_saturation_is_still_an_active_backdrop() {
    let effect=serde_json::from_value(json!({"kind":"background-blur","radius":0,"color":"#000000",
        "colorControls":{"brightness":0,"contrast":1,"saturation":0,"hue":0}})).unwrap();
    assert!(futureox_design_kernel::scene::selected_backdrop(&[effect]).is_some());
}
