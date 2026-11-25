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

#[test]
fn ordinary_wide_image_does_not_spend_a_siblings_zoom_halo() {
    let mut doc = fixture();
    let bg = serde_json::from_value(json!({
        "id":"bg","kind":"rectangle","width":240,"height":240,"transform":[1.,0.,0.,1.,-100.,-100.],
        "fills":[{"kind":"image","color":"#000000","image":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGOUs4n6z8DAwMAEIkAYABksAbdASTMTAAAAAElFTkSuQmCC","fit":"stretch"}],
        "effects":[{"kind":"gaussian-blur","radius":9.564871788024902,"color":"#000000"}]
    })).unwrap();
    doc.nodes.insert("bg".into(), bg);
    doc.pages[0].children.insert(0,"bg".into());
    let n=doc.nodes.get_mut("n").unwrap();
    n.width=5.; n.height=5.;
    n.effects[0].zoom_blur.as_mut().unwrap().amount=10.;
    n.effects[0].zoom_blur.as_mut().unwrap().center=[0.5,0.5];
    let request = json!({
        "pageId":"p","width":256,"height":252,"rasterProfile":"analytic","gpuAnalyticRegions":true,
        "gpuViewport":{"x":-128,"y":-122,"w":256,"h":252},
        "view":{"x":-6630.4,"y":-6624.7,"zoom":301.2},"grid":false
    });
    let compile = |doc:&Document, request:&serde_json::Value| {
        let mut e=Engine::new();
        e.load_document(&serde_json::to_string(doc).unwrap()).unwrap();
        e.compile_gpu_request(&request.to_string()).map(|scene| serde_json::to_value(scene).unwrap())
    };
    let scene=compile(&doc,&request).unwrap();
    let b=&scene["nodes"]["bg"]["wideImageGaussian"];
    assert_eq!(b["radii"],json!([2880,2880,2881]));
    assert_eq!(b["output"],request["gpuViewport"]);
    assert!(!scene["nodes"]["n"].is_null());

    // The wider preparation guard must still emit each tile from its original
    // contours. Move the focus and compare every field to an independent engine.
    let mut windowed = request.clone();
    windowed["prepareViewport"] = json!({"x":-192,"y":-180,"w":384,"h":368});
    let mut warm = Engine::new();
    warm.load_document(&serde_json::to_string(&doc).unwrap()).unwrap();
    warm.compile_gpu_request(&windowed.to_string()).unwrap();
    let before_hits = warm.gpu_compile_cache_stats()["cameraResidency"]["cropHits"].as_u64().unwrap();
    let mut moved = doc.clone();
    moved.nodes.get_mut("n").unwrap().effects[0].zoom_blur.as_mut().unwrap().center = [0.53, 0.49];
    let patch = futureox_design_kernel::editing::DocumentPatch::between(&doc, &moved).unwrap();
    warm.apply_document_patch_with_damage(&patch).unwrap();
    let reused = serde_json::to_value(warm.compile_gpu_request(&windowed.to_string()).unwrap()).unwrap();
    assert_eq!(reused, compile(&moved, &windowed).unwrap());
    assert!(warm.gpu_compile_cache_stats()["cameraResidency"]["cropHits"].as_u64().unwrap() > before_hits);

    let mut invalid = moved.clone();
    invalid.nodes.get_mut("n").unwrap().effects[0].zoom_blur.as_mut().unwrap().center = [200., 0.49];
    let patch = futureox_design_kernel::editing::DocumentPatch::between(&moved, &invalid).unwrap();
    warm.apply_document_patch_with_damage(&patch).unwrap();
    assert!(warm.compile_gpu_request(&windowed.to_string()).err().unwrap().contains("exceeds 2048"));

    // A foreground effect on the Zoom node itself is not a separable image
    // source. The real radial dependency cap must still reject it.
    let fx=doc.nodes["bg"].effects[0].clone();
    doc.nodes.get_mut("n").unwrap().effects.insert(0,fx);
    assert!(compile(&doc,&request).unwrap_err().contains("exceeds 2048"));
    doc.nodes.get_mut("n").unwrap().effects.remove(0);

    // A reachable image edge removes full coverage and retains the original
    // admission error, as does switching off the analytic-canvas lane.
    let mut with_edge=doc.clone();
    with_edge.nodes.get_mut("bg").unwrap().transform.0[4]=20.;
    assert!(compile(&with_edge,&request).unwrap_err().contains("exceeds 2048"));
    let mut ordinary=request.clone();
    ordinary["gpuAnalyticRegions"]=json!(false);
    assert!(compile(&doc,&ordinary).unwrap_err().contains("exceeds 2048"));
}

fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3))
}

#[test]
fn distant_zoom_blur_does_not_retarget_figma_export_samples() {
    use futureox_design_kernel::export::RegionRequest;
    fn page(zoom_at: Option<f64>) -> Document {
        let mut doc = fixture();
        let shape = doc.nodes.get_mut("n").unwrap();
        shape.effects.clear();
        shape.transform = futureox_design_kernel::math::Transform([0.92, 0.28, -0.28, 0.96, 10.5, 6.25]);
        shape.width = 24.;
        shape.height = 20.;
        if let Some(x) = zoom_at {
            let far = serde_json::from_value(json!({
                "id":"z","kind":"rectangle","width":40,"height":30,"transform":[1,0,0,1,x,0],
                "fills":[{"kind":"solid","color":"#e07020"}],
                "effects":[{"kind":"zoom-blur","radius":0,"color":"#000000","zoomBlur":{"amount":40,"center":[0.2,0.8]}}]
            })).unwrap();
            doc.nodes.insert("z".into(), far);
            doc.pages[0].children.push("z".into());
        }
        doc
    }
    let bounds = json!({"x":0,"y":0,"width":48,"height":40});
    let export = |doc: &Document, profile: &str| {
        let mut engine = Engine::new();
        engine.load_document(&serde_json::to_string(doc).unwrap()).unwrap();
        engine.render_region_png(&RegionRequest {
            page_id: "p".into(), bounds: serde_json::from_value(bounds.clone()).unwrap(), scale: 2.,
            node_ids: None, raster_profile: Some(serde_json::from_value(json!(profile)).unwrap()), color_output: None,
        }).unwrap()
    };
    let alone = page(None);
    let distant = page(Some(400.));
    let near = page(Some(100.));
    let alone_png = export(&alone, "figma");
    assert_eq!(export(&distant, "figma"), alone_png, "a zoom blur outside the export hull changed unrelated coverage");
    let mut grouped = distant.clone();
    let zoom = std::mem::take(&mut grouped.nodes.get_mut("z").unwrap().effects);
    grouped.pages[0].children.retain(|id| id != "z");
    grouped.nodes.insert("g".into(), serde_json::from_value(json!({"id":"g","kind":"group","width":40,"height":30,"children":["z"],"effects":zoom})).unwrap());
    grouped.pages[0].children.push("g".into());
    assert_eq!(export(&grouped, "figma"), alone_png, "a grouped zoom blur outside the export hull changed unrelated coverage");
    assert_ne!(export(&near, "figma"), alone_png, "a zoom blur whose hull meets the export must keep the existing sample graph");
    let mut view_engine = Engine::new();
    view_engine.load_document(&serde_json::to_string(&alone).unwrap()).unwrap();
    let view = view_engine.parse_options(json!({"pageId":"p","width":96,"height":80,"transparent":true,"rasterProfile":"figma","view":{"x":0,"y":0,"zoom":2}})).unwrap();
    let alone_view = view_engine.render(&view).unwrap();
    view_engine.load_document(&serde_json::to_string(&distant).unwrap()).unwrap();
    assert_eq!(view_engine.render(&view).unwrap(), alone_view);
    let mut inside = fixture();
    inside.nodes.get_mut("n").unwrap().transform = futureox_design_kernel::math::Transform([0.92, 0.28, -0.28, 0.96, 10.5, 6.25]);
    let inside_png = export(&inside, "figma");
    assert_eq!(inside_png.len(), 6740);
    assert_eq!(fnv(&inside_png), 0x5d8025f11895b508, "in-bounds zoom blur export changed sample graph");
}

fn scaled_zoom_document(neighbor: serde_json::Value, children: Vec<&str>) -> serde_json::Value {
    let mut nodes = serde_json::Map::new();
    nodes.insert("ellipse".into(), json!({
        "id": "ellipse", "kind": "ellipse", "width": 5.0, "height": 5.0,
        "transform": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        "fills": [{ "kind": "solid", "color": "#3366b3" }],
        "effects": [{ "kind": "zoom-blur", "radius": 0.0, "color": "#000000", "visible": true,
            "zoomBlur": { "amount": 24.0, "center": [0.5, 0.5] } }]
    }));
    nodes.insert(neighbor["id"].as_str().unwrap().to_string(), neighbor);
    json!({
        "schemaVersion": 19, "id": "scaled-zoom", "name": "scaled zoom",
        "pages": [{ "id": "p", "name": "p", "background": "#ffffff", "children": children }],
        "nodes": nodes
    })
}

fn gaussian(id: &str, transform: [f64; 6], width: f64, height: f64) -> serde_json::Value {
    json!({
        "id": id, "kind": "rectangle", "width": width, "height": height, "transform": transform,
        "fills": [{ "kind": "solid", "color": "#c04040" }],
        "effects": [{ "kind": "gaussian-blur", "radius": 2.5, "color": "#000000", "visible": true }]
    })
}

fn admits(document: &serde_json::Value, width: u32, height: u32, zoom: f64) -> Result<(), String> {
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(document).unwrap()).unwrap();
    engine.compile_gpu_request(&json!({
        "pageId": "p", "width": width, "height": height, "rasterProfile": "analytic",
        "view": { "x": 0.0, "y": 0.0, "zoom": zoom }, "transparent": false, "grid": false
    }).to_string()).map(|_| ())
}

#[test]
fn zoom_source_halo_follows_placed_node_scale() {
    let neighbor = gaussian("neighbor", [1.0, 0.0, 0.0, 1.0, 10.0, 0.2], 1.5, 1.5);
    let identity = scaled_zoom_document(neighbor, vec!["ellipse", "neighbor"]);
    let wide = admits(&identity, 2410, 904, 301.2).unwrap_err();
    assert!(wide.contains("Zoom source filter halo exceeds 2048"), "{wide}");
    let tile = json!({
        "pageId": "p", "width": 514, "height": 514, "rasterProfile": "analytic",
        "gpuAnalyticRegions": true, "gpuViewport": { "x": 0, "y": 0, "w": 514, "h": 514 },
        "view": { "x": 0.0, "y": 0.0, "zoom": 301.2 }, "transparent": false, "grid": false
    });
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(&identity).unwrap()).unwrap();
    engine.compile_gpu_request(&tile.to_string()).expect("exact tile stays admitted");

    let up = scaled_zoom_document(gaussian("neighbor", [2.0, 0.0, 0.0, 2.0, 10.0, 0.2], 1.5, 1.5), vec!["ellipse", "neighbor"]);
    let rejected = admits(&up, 800, 600, 150.0).unwrap_err();
    assert!(rejected.contains("Zoom source filter halo exceeds 2048"), "{rejected}");
    let flat = scaled_zoom_document(gaussian("neighbor", [1.0, 0.0, 0.0, 1.0, 10.0, 0.2], 1.5, 1.5), vec!["ellipse", "neighbor"]);
    admits(&flat, 800, 600, 150.0).expect("unscaled neighbor at zoom 150 stays inside 2048");
    let down = scaled_zoom_document(gaussian("neighbor", [0.25, 0.0, 0.0, 0.25, 10.0, 0.2], 1.5, 1.5), vec!["ellipse", "neighbor"]);
    admits(&down, 2410, 904, 301.2).expect("scaled-down neighbor at 15060% stays inside 2048");
    let mut guarded = Engine::new();
    guarded.load_document(&serde_json::to_string(&down).unwrap()).unwrap();
    guarded.compile_gpu_request(&json!({
        "pageId": "p", "width": 3680, "height": 2174, "rasterProfile": "analytic",
        "view": { "x": 0.0, "y": 0.0, "zoom": 301.2 }, "transparent": false, "grid": false,
        "captureViewport": { "x": -635, "y": -635, "w": 3680, "h": 2174 }
    }).to_string()).expect("scaled-down interaction capture stays inside 2048");

    let grouped = |scale: f64| {
        let mut document = scaled_zoom_document(gaussian("neighbor", [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], 20.0, 20.0), vec!["ellipse", "group"]);
        document["nodes"]["group"] = json!({
            "id": "group", "kind": "group", "width": 40.0, "height": 40.0,
            "transform": [scale, 0.0, 0.0, scale, 0.0, 0.0], "children": ["neighbor"]
        });
        document
    };
    let parent = admits(&grouped(2.0), 800, 600, 150.0).unwrap_err();
    assert!(parent.contains("Zoom source filter halo exceeds 2048"), "{parent}");
    admits(&grouped(1.0), 800, 600, 150.0).expect("unscaled parent stays inside 2048");

    let turn = 2.0 * std::f64::consts::FRAC_PI_6.cos();
    let rise = 2.0 * std::f64::consts::FRAC_PI_6.sin();
    let rotated = scaled_zoom_document(
        gaussian("neighbor", [turn, rise, -rise, turn, 0.0, 0.0], 20.0, 20.0),
        vec!["ellipse", "neighbor"],
    );
    let turned = admits(&rotated, 800, 600, 150.0).unwrap_err();
    assert!(turned.contains("Zoom source filter halo exceeds 2048"), "{turned}");
}
