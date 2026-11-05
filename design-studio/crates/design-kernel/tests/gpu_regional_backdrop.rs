use futureox_design_kernel::{Engine, RenderOptions, color::ColorSettings, math::Rect};
use serde_json::{json, Value};

fn document() -> Value {
    json!({"schemaVersion":5,"id":"regional-backdrop","name":"regional backdrop",
        "colorManagement":ColorSettings::default(),
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":["root"]}],
        "nodes":{
            "root":{"id":"root","kind":"frame","width":1920,"height":1080,
                "clip":true,"children":["blur","backdrop","backdrop2"]},
            "blur":{"id":"blur","kind":"rectangle","width":1920,"height":1080,
                "fills":[{"kind":"solid","color":"#456789"}],
                "effects":[{"kind":"blur","color":"#000000","radius":9.564871788024902}]},
            "backdrop":{"id":"backdrop","kind":"rectangle","width":100,"height":50,
                "transform":[1,0,0,1,1400,40],
                "fills":[{"kind":"solid","color":"#ffffff","opacity":0.2}],
                "effects":[{"kind":"background-blur","color":"#000000","radius":18.39398384094238}]},
            "backdrop2":{"id":"backdrop2","kind":"rectangle","width":100,"height":50,
                "transform":[1,0,0,1,1400,900],
                "effects":[{"kind":"background-blur","color":"#000000","radius":18.39398384094238}]}
        }})
}

#[test]
fn unrelated_backdrops_do_not_expand_a_3200_percent_foreground_tile() {
    let mut engine = Engine::new();
    engine.load_document(&document().to_string()).unwrap();
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":258,"height":258,
        "view":{"x":-35000,"y":-35000,"zoom":64},"rasterProfile":"figma"})).unwrap();
    let region = Rect::new(0, 0, 258, 258);
    let scene = engine.compile_gpu_region(&options, region, None).unwrap();
    assert_eq!(scene.extent, Rect::new(-2, -2, 520, 520));
    assert!(!scene.nodes.contains_key("backdrop"));
    assert!(!scene.nodes.contains_key("backdrop2"));
    assert_eq!(scene.nodes["blur"].effects[0].radius, 9.564871788024902);
    assert!(scene.nodes["blur"].rect.w > scene.extent.w + 2000);
}

#[test]
fn intersecting_backdrops_retain_their_dependency_neighbourhood() {
    let mut doc = document();
    doc["nodes"]["backdrop"]["transform"] = json!([1,0,0,1,0,0]);
    doc["nodes"]["blur"]["effects"][0]["radius"] = json!(2);
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":64,"height":64,
        "view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figmaSubpixel"})).unwrap();
    let scene = engine.compile_gpu_region(&options, Rect::new(0, 0, 64, 64), None).unwrap();
    assert!(scene.nodes.contains_key("backdrop"));
    assert!(scene.extent.w > 68);
}

#[test]
fn a_backdrops_input_halo_is_not_visible_output() {
    let mut doc = document();
    doc["nodes"]["backdrop"]["transform"] = json!([1,0,0,1,10,10]);
    doc["nodes"]["backdrop"]["width"] = json!(30);
    doc["nodes"]["backdrop"]["height"] = json!(30);
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":16,"height":16,
        "view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figmaSubpixel"})).unwrap();
    // The backdrop's 37-pixel input halo reaches this crop. Its actual output
    // stops at y=40, so it cannot affect the foreground at y=60.
    let scene = engine.compile_gpu_region(&options, Rect::new(10, 60, 16, 16), None).unwrap();
    assert_eq!(scene.extent, Rect::new(8, 58, 20, 20));
    assert!(!scene.nodes.contains_key("backdrop"));
    assert!(scene.nodes.contains_key("blur"));
}

#[test]
fn an_opaque_fill_makes_its_interior_backdrop_unobservable() {
    let mut doc = document();
    doc["nodes"]["backdrop"]["kind"] = json!("rectangle");
    doc["nodes"]["backdrop"]["transform"] = json!([1,0,0,1,0,0]);
    doc["nodes"]["backdrop"]["width"] = json!(1000);
    doc["nodes"]["backdrop"]["height"] = json!(1000);
    doc["nodes"]["backdrop"]["fills"][0]["opacity"] = json!(1);
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":64,"height":64,
        "view":{"x":-35000,"y":-35000,"zoom":64},"rasterProfile":"figma"})).unwrap();
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    let scene = engine.compile_gpu_region(&options, Rect::new(0, 0, 64, 64), None).unwrap();
    assert_eq!(scene.extent, Rect::new(-2, -2, 132, 132));
    assert!(scene.nodes["backdrop"].effects.is_empty());
    // Transparency retains the dependency and its existing admission limit.
    doc["nodes"]["backdrop"]["fills"][0]["opacity"] = json!(0.5);
    engine.load_document(&doc.to_string()).unwrap();
    assert!(engine.compile_gpu_region(&options, Rect::new(0, 0, 64, 64), None).is_err());
}

#[test]
fn continuous_coverage_edges_and_layer_opacity_keep_their_backdrops() {
    let mut doc = document();
    doc["nodes"]["backdrop"]["transform"] = json!([1,0,0,1,0,0]);
    doc["nodes"]["backdrop"]["fills"][0]["opacity"] = json!(1);
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":16,"height":16,
        "view":{"x":0,"y":0,"zoom":1},"rasterProfile":"analytic"})).unwrap();
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    let edge = engine.compile_gpu_region(&options, Rect::new(-4, 10, 16, 16), None).unwrap();
    assert!(!edge.nodes["backdrop"].effects.is_empty());
    doc["nodes"]["backdrop"]["opacity"] = json!(0.5);
    engine.load_document(&doc.to_string()).unwrap();
    let interior = engine.compile_gpu_region(&options, Rect::new(10, 10, 16, 16), None).unwrap();
    assert!(!interior.nodes["backdrop"].effects.is_empty());
}

#[test]
fn source_motion_blur_keeps_its_own_support_without_a_scene_wide_halo() {
    let mut doc = document();
    doc["schemaVersion"] = json!(18);
    doc["nodes"]["blur"]["effects"] = json!([
        {"kind":"inner-shadow","radius":16,"spread":2,"color":"#203040","x":2,"y":1},
        {"kind":"motion-blur","radius":3.5,"motionAngle":27,"color":"#000000"}
    ]);
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    let mut request = json!({"pageId":"p","width":48,"height":40,
        "view":{"x":0,"y":0,"zoom":4},"rasterProfile":"figmaSubpixel",
        "gpuViewport":{"x":128,"y":128,"w":48,"h":40},"gpuGaussianRegions":true});
    let original = engine.compile_gpu_request(&request.to_string()).unwrap();
    request["gpuSourceFilterFields"] = json!(true);
    let local = engine.compile_gpu_request(&request.to_string()).unwrap();
    assert_eq!(local.extent, Rect::new(126,126,52,44));
    assert!(original.extent.pixels() > local.extent.pixels());
    let node = &local.nodes["blur"];
    assert_eq!(node.effects[1].kind, "motion-blur");
    assert!(node.rect.w > local.extent.w && node.rect.h > local.extent.h);
}
