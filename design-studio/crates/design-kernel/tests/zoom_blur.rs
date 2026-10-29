use futureox_design_kernel::{Engine, interop, scene::Document};
use serde_json::json;
fn fixture() -> Document {
    serde_json::from_value(json!({"schemaVersion":19,"id":"z","name":"zoom",
        "pages":[{"id":"p","name":"P","children":["n"],"background":"#ffffff"}],
        "nodes":{"n":{"id":"n","kind":"rectangle","width":24,"height":20,"transform":[1,0,0,1,20,20],
            "fills":[{"kind":"solid","color":"#3366b3"}],"effects":[{"kind":"zoom-blur","zoomBlur":{"amount":20,"center":[0.25,0.75]},"radius":0,"color":"#000000"}]}}})).unwrap()
}
fn pixels(doc: &Document) -> Vec<u8> {
    let mut e = Engine::new();
    e.load_document(&serde_json::to_string(doc).unwrap())
        .unwrap();
    let options=e.parse_options(json!({"pageId":"p","width":80,"height":80,"transparent":true,"view":{"x":0,"y":0,"zoom":1}})).unwrap();
    e.render(&options).unwrap()
}
#[test]
fn zoom_parameters_and_pixels_survive_native_export_and_fd_model() {
    let doc = fixture();
    let expected = pixels(&doc);
    let mut plain = doc.clone();
    plain.nodes.get_mut("n").unwrap().effects.clear();
    assert_ne!(expected, pixels(&plain));
    let back = interop::import_sketch_report(&interop::export_sketch(&doc).unwrap())
        .unwrap()
        .document;
    assert_eq!(
        back.nodes["n"].effects[0].zoom_blur,
        doc.nodes["n"].effects[0].zoom_blur
    );
    assert_eq!(back.schema_version, 19);
    assert_eq!(expected, pixels(&back));
    let mut changed = doc.clone();
    changed.nodes.get_mut("n").unwrap().effects[0]
        .zoom_blur
        .as_mut()
        .unwrap()
        .center = [0.75, 0.25];
    assert_ne!(expected, pixels(&changed));
}
#[test]
fn zoom_validation_covers_source_and_shared_effect_parameters() {
    let mut doc = fixture();
    doc.schema_version = 18;
    assert!(doc.validate().unwrap_err().contains("19"));
    doc.schema_version = 19;
    doc.nodes.get_mut("n").unwrap().effects[0].radius = 1.;
    assert!(doc.validate().is_err());
    doc.nodes.get_mut("n").unwrap().effects[0].radius = 0.;
    doc.nodes.get_mut("n").unwrap().effects[0]
        .zoom_blur
        .as_mut()
        .unwrap()
        .center[0] = f64::NAN;
    assert!(doc.validate().is_err());
}
#[test]
fn modern_native_zoom_blurs_are_executable_instead_of_omitted() {
    let doc = interop::import_sketch_report(include_bytes!(
        "../../../../testing/fixtures/design/sketch-spatial-blur-modern.sketch"
    ))
    .unwrap()
    .document;
    assert_eq!(
        doc.nodes
            .values()
            .flat_map(|n| &n.effects)
            .filter(|e| e.kind == "zoom-blur")
            .count(),
        8
    );
    assert_eq!(doc.schema_version, 19);
}

#[test]
fn zoom_sampling_reads_offscreen_content_consistently_across_crops() {
    let mut doc = fixture();
    let n = doc.nodes.get_mut("n").unwrap();
    n.width = 1000.;
    n.height = 100.;
    n.transform = futureox_design_kernel::math::Transform::default();
    n.effects[0].zoom_blur.as_mut().unwrap().center = [0.5, 0.5];
    let mut e = Engine::new();
    e.load_document(&serde_json::to_string(&doc).unwrap())
        .unwrap();
    let full=e.parse_options(json!({"pageId":"p","width":1100,"height":160,"transparent":true,"rasterProfile":"figma","view":{"x":0,"y":0,"zoom":1}})).unwrap();
    let crop=e.parse_options(json!({"pageId":"p","width":32,"height":32,"transparent":true,"rasterProfile":"figma","view":{"x":-850,"y":-30,"zoom":1}})).unwrap();
    let whole = e.render(&full).unwrap();
    let actual = e.render(&crop).unwrap();
    let expected: Vec<u8> = (30..62)
        .flat_map(|y| {
            whole[(y * 1100 + 850) * 4..(y * 1100 + 882) * 4]
                .iter()
                .copied()
        })
        .collect();
    let delta = actual
        .iter()
        .zip(&expected)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap();
    assert_eq!(delta, 0, "cropping must not erase remote source samples");
}

#[test]
fn zoom_group_backdrop_and_nested_sources_are_crop_invariant() {
    let mut doc = fixture();
    let child = doc.nodes.get_mut("n").unwrap();
    child.width = 1000.;
    child.height = 100.;
    child.transform = futureox_design_kernel::math::Transform::default();
    child.effects.clear();
    let group:futureox_design_kernel::scene::Node=serde_json::from_value(json!({"id":"g","kind":"group","width":1000,"height":100,"children":["n"],"effects":[{"kind":"zoom-blur","zoomBlur":{"amount":20,"center":[0.5,0.5]},"radius":0,"color":"#000000"}]})).unwrap();
    doc.nodes.insert("g".into(), group);
    doc.pages[0].children = vec!["g".into()];
    for backdrop in [false, true] {
        let mut d = doc.clone();
        if backdrop {
            let background:futureox_design_kernel::scene::Node=serde_json::from_value(json!({"id":"b","kind":"rectangle","width":1000,"height":100,"fills":[{"kind":"solid","color":"#e38732"}]})).unwrap();
            d.nodes.insert("b".into(), background);
            d.pages[0].children.insert(0, "b".into());
            d.nodes.get_mut("n").unwrap().fills.clear();
            d.nodes.get_mut("g").unwrap().effects.insert(
                0,
                serde_json::from_value(
                    json!({"kind":"background-blur","radius":3,"color":"#000000"}),
                )
                .unwrap(),
            );
        }
        let mut e = Engine::new();
        e.load_document(&serde_json::to_string(&d).unwrap())
            .unwrap();
        let full=e.parse_options(json!({"pageId":"p","width":1100,"height":160,"transparent":true,"rasterProfile":"figma","view":{"x":0,"y":0,"zoom":1}})).unwrap();
        let crop=e.parse_options(json!({"pageId":"p","width":32,"height":32,"transparent":true,"rasterProfile":"figma","view":{"x":-850,"y":-30,"zoom":1}})).unwrap();
        let whole = e.render(&full).unwrap();
        let actual = e.render(&crop).unwrap();
        let expected: Vec<u8> = (30..62)
            .flat_map(|y| {
                whole[(y * 1100 + 850) * 4..(y * 1100 + 882) * 4]
                    .iter()
                    .copied()
            })
            .collect();
        assert_eq!(
            actual
                .iter()
                .zip(expected)
                .map(|(a, b)| a.abs_diff(b))
                .max(),
            Some(0),
            "backdrop={backdrop}"
        );
    }
}

#[test]
fn zoom_child_edit_invalidates_its_filtered_group_but_not_the_page() {
    use futureox_design_kernel::editing::DocumentPatch;
    let mut before = fixture();
    before.nodes.get_mut("n").unwrap().effects.clear();
    let group:futureox_design_kernel::scene::Node=serde_json::from_value(json!({"id":"g","kind":"group","width":120,"height":80,"children":["n"],"effects":[{"kind":"zoom-blur","radius":0,"color":"#000000","zoomBlur":{"amount":20,"center":[0.5,0.5]}}]})).unwrap();
    let far:futureox_design_kernel::scene::Node=serde_json::from_value(json!({"id":"far","kind":"rectangle","width":80,"height":80,"transform":[1,0,0,1,400,0],"fills":[{"kind":"solid","color":"#00ff00"}]})).unwrap();
    before.nodes.insert("g".into(), group);
    before.nodes.insert("far".into(), far);
    before.pages[0].children = vec!["g".into(), "far".into()];
    let mut after = before.clone();
    after.nodes.get_mut("n").unwrap().fills[0].color = "#e33844".into();
    let mut e = Engine::new();
    e.load_document(&serde_json::to_string(&before).unwrap())
        .unwrap();
    let options=e.parse_options(json!({"pageId":"p","width":512,"height":160,"transparent":true,"rasterProfile":"figma","view":{"x":0,"y":0,"zoom":1}})).unwrap();
    let old = e.render(&options).unwrap();
    let damage = e
        .apply_document_patch_with_damage(&DocumentPatch::between(&before, &after).unwrap())
        .unwrap();
    assert!(!damage.full);
    let bounds = damage.bounds.unwrap();
    assert!(bounds[0] + bounds[2] < 400.);
    let actual = e.render(&options).unwrap();
    let mut fresh = Engine::new();
    fresh
        .load_document(&serde_json::to_string(&after).unwrap())
        .unwrap();
    assert_eq!(actual, fresh.render(&options).unwrap());
    assert_ne!(actual, old);
}

#[test]
fn clipped_offscreen_zoom_does_not_reject_unrelated_visible_content() {
    let mut doc = fixture();
    doc.nodes.get_mut("n").unwrap().effects.clear();
    let frame:futureox_design_kernel::scene::Node=serde_json::from_value(json!({"id":"f","kind":"frame","width":160,"height":160,"clip":true,"transform":[1,0,0,1,500,0],"children":["z"]})).unwrap();
    let child:futureox_design_kernel::scene::Node=serde_json::from_value(json!({"id":"z","kind":"rectangle","width":80,"height":80,"fills":[{"kind":"solid","color":"#ff0000"}],"effects":[{"kind":"zoom-blur","radius":0,"color":"#000000","zoomBlur":{"amount":1000,"center":[0.5,0.5]}}]})).unwrap();
    let expected = pixels(&doc);
    doc.nodes.insert("f".into(), frame);
    doc.nodes.insert("z".into(), child);
    doc.pages[0].children.push("f".into());
    assert_eq!(pixels(&doc), expected);
}
