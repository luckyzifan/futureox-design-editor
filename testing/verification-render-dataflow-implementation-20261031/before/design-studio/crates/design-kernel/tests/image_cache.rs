use base64::Engine as _;
use futureox_design_kernel::{Engine, RenderOptions, editing::DocumentPatch};
use serde_json::{Value, json};
use std::sync::Arc;

fn image(color: [u8; 4]) -> String {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 2, 2);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&color.repeat(4))
            .unwrap();
    }
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}
fn paint(uri: &str) -> Value {
    json!({"kind":"image","color":"#000000","image":uri})
}
fn doc(uri: &str) -> Value {
    json!({"schemaVersion":4,"id":"d","name":"Images",
        "pages":[{"id":"p","name":"p","children":["a"],"background":"#ffffff"}],
        "nodes":{"a":{"id":"a","kind":"rectangle","width":8,"height":8,"fills":[paint(uri)]}}
    })
}
fn options() -> RenderOptions {
    serde_json::from_value(json!({"pageId":"p","width":12,"height":12,"transparent":true,"view":{"x":0,"y":0,"zoom":1}})).unwrap()
}

#[test]
fn unrelated_patches_reuse_decoded_images_and_match_a_fresh_renderer() {
    let uri = image([190, 50, 20, 170]);
    let mut doc = doc(&uri);
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    let decoded = engine.image_data(&uri).unwrap();
    for step in 0..12 {
        doc["nodes"]["a"]["opacity"] = json!(0.5 + step as f64 / 24.);
        let patch: DocumentPatch =
            serde_json::from_value(json!({"nodes":{"a":doc["nodes"]["a"]}})).unwrap();
        engine.apply_document_patch(&patch).unwrap();
        assert!(Arc::ptr_eq(&decoded, &engine.image_data(&uri).unwrap()));
        let mut fresh = Engine::new();
        fresh.load_document(&doc.to_string()).unwrap();
        assert_eq!(
            engine.render(&options()).unwrap(),
            fresh.render(&options()).unwrap()
        );
    }
    let bad: DocumentPatch = serde_json::from_value(json!({"nodes":{"a":null}})).unwrap();
    assert!(engine.apply_document_patch(&bad).is_err());
    assert!(Arc::ptr_eq(&decoded, &engine.image_data(&uri).unwrap()));
}

#[test]
fn removed_assets_are_released_and_color_changes_invalidate_decoding() {
    let red = image([255, 0, 0, 255]);
    let blue = image([0, 0, 255, 255]);
    let mut doc = doc(&red);
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    let before = engine.image_data(&red).unwrap();
    let removed = Arc::downgrade(&before);
    drop(before);
    doc["nodes"]["a"]["fills"] = json!([paint(&blue)]);
    engine.load_document(&doc.to_string()).unwrap();
    assert!(removed.upgrade().is_none());
    let before = engine.image_data(&blue).unwrap();
    doc["colorManagement"] =
        json!({"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000});
    engine.load_document(&doc.to_string()).unwrap();
    assert!(!Arc::ptr_eq(&before, &engine.image_data(&blue).unwrap()));
}

#[test]
fn shared_style_and_component_override_assets_survive_document_updates() {
    let uri = image([40, 200, 90, 120]);
    let mut style_doc = doc(&uri);
    style_doc["nodes"]["a"]["fills"] = json!([]);
    style_doc["nodes"]["a"]["styleRefs"] = json!({"fills":"image-style"});
    style_doc["designSystem"] =
        json!({"styles":{"image-style":{"name":"Image","kind":"paint","value":[paint(&uri)]}}});
    let mut override_doc = doc(&uri);
    override_doc["pages"][0]["children"] = json!(["a", "i"]);
    override_doc["nodes"]["a"]["fills"] = json!([]);
    override_doc["nodes"]["a"]["kind"] = json!("frame");
    override_doc["nodes"]["a"]["component"] = json!({});
    override_doc["nodes"]["i"] = json!({"id":"i","kind":"frame","width":8,"height":8,
        "instance":{"componentId":"a","overrides":{"$root":{"fills":[paint(&uri)]}}}});
    for mut doc in [style_doc, override_doc] {
        let mut engine = Engine::new();
        engine.load_document(&doc.to_string()).unwrap();
        let before = engine.image_data(&uri).unwrap();
        doc["name"] = json!("Renamed");
        engine.load_document(&doc.to_string()).unwrap();
        assert!(Arc::ptr_eq(&before, &engine.image_data(&uri).unwrap()));
        let mut fresh = Engine::new();
        fresh.load_document(&doc.to_string()).unwrap();
        assert_eq!(
            engine.render(&options()).unwrap(),
            fresh.render(&options()).unwrap()
        );
    }
}

#[test]
fn stroke_and_animation_only_images_are_retained_until_their_last_reference_is_removed() {
    use futureox_design_kernel::{animation::Pose, scene::Node};
    let uri = image([50, 100, 150, 255]);
    let mut stroke_doc = doc(&uri);
    stroke_doc["nodes"]["a"]["fills"] = json!([]);
    stroke_doc["nodes"]["a"]["strokes"] = json!([{"paint":paint(&uri),"width":1}]);
    let mut animation_doc = doc(&uri);
    let node: Node = serde_json::from_value(animation_doc["nodes"]["a"].clone()).unwrap();
    let pose = Pose::from(&node);
    animation_doc["nodes"]["a"]["fills"] = json!([]);
    animation_doc["animations"] = json!([{"id":"c","name":"Image pose","pageId":"p","durationMs":100,
        "tracks":[{"nodeId":"a","keyframes":[{"timeMs":0,"value":pose}]}]}]);
    for mut doc in [stroke_doc, animation_doc] {
        let mut engine = Engine::new();
        engine.load_document(&doc.to_string()).unwrap();
        let before = engine.image_data(&uri).unwrap();
        doc["name"] = json!("Renamed");
        engine.load_document(&doc.to_string()).unwrap();
        assert!(Arc::ptr_eq(&before, &engine.image_data(&uri).unwrap()));
        let released = Arc::downgrade(&before);
        drop(before);
        doc["nodes"]["a"]["strokes"] = json!([]);
        doc["animations"] = json!([]);
        engine.load_document(&doc.to_string()).unwrap();
        assert!(released.upgrade().is_none());
    }
}
