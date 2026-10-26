use futureox_design_kernel::Engine;
use serde_json::{json, Value};
#[path="support/frame_scene.rs"] mod frame_scene;

fn engine() -> Engine {
    let mut engine = Engine::new();
    engine.load_document(&json!({"schemaVersion":3,"id":"gpu","name":"gpu",
        "colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},
        "pages":[{"id":"p","name":"p","children":["near","far"],"background":"#ffffff"}],
        "nodes":{
            "near":{"id":"near","kind":"rectangle","width":30,"height":30,
                "fills":[{"kind":"solid","color":"#123456"}]},
            "far":{"id":"far","kind":"rectangle","width":100,"height":100,
                "transform":[1,0,0,1,100000,100000],"fills":[{"kind":"solid","color":"#abcdef"}],
                "effects":[{"kind":"blur","radius":100,"visible":true,"color":"#000000"}]}
        }}).to_string()).unwrap();
    engine
}
fn options(zoom: f64) -> Value {
    json!({"pageId":"p","width":64,"height":64,"view":{"x":0,"y":0,"zoom":zoom},
        "rasterProfile":"figma","gpuViewport":{"x":0,"y":0,"w":64,"h":64}})
}

#[test]
fn offscreen_large_effect_does_not_block_high_zoom_tiles() {
    let scene = engine().compile_gpu_request(&options(16.).to_string()).unwrap();
    assert!(scene.nodes.contains_key("near"));
    assert!(!scene.nodes.contains_key("far"));
    assert!(scene.extent.pixels() < 128 * 128 * 2);
}

#[test]
fn only_explicit_interactive_tier_reduces_correlated_planes() {
    let mut engine = engine();
    let mut request = options(1.);
    assert!(engine.compile_gpu_request(&request.to_string()).unwrap().coherent_samples);
    request["interactiveEffects"] = json!(true);
    assert!(!engine.compile_gpu_request(&request.to_string()).unwrap().coherent_samples);
    request["interactiveEffects"] = json!(false);
    assert!(engine.compile_gpu_request(&request.to_string()).unwrap().coherent_samples);
}

#[test]
fn binary_packet_preserves_every_geometry_word_and_scene_field() {
    let mut engine = engine();
    let mut request = options(0.75);
    request["prepareViewport"] = json!({"x":-100,"y":-100,"w":1024,"h":768});
    let scene = engine.compile_gpu_request(&request.to_string()).unwrap();
    let expected_vertices = scene.vertices.clone();
    let expected_curves = scene.curves.clone();
    let mut metadata: Value = serde_json::from_str(&serde_json::to_string(&scene).unwrap()).unwrap();
    metadata["vertices"] = json!([]); metadata["curves"] = json!([]);
    let packet = scene.into_packet().unwrap();
    let word = |offset| u32::from_le_bytes(packet[offset..offset+4].try_into().unwrap()) as usize;
    assert_eq!(&packet[..4], b"FGSC"); assert_eq!(word(4), 1);
    assert_eq!(word(12), expected_vertices.len()); assert_eq!(word(16), expected_curves.len());
    frame_scene::assert_fields(&frame_scene::scene(&packet),&metadata);
    let actual=frame_scene::geometry_words(&packet);
    let expected: Vec<_> = expected_vertices.iter().chain(&expected_curves).map(|v| v.to_bits()).collect();
    assert_eq!(actual, expected);
}

#[test]
fn shared_prepare_does_not_change_export_profile_tile_geometry() {
    let mut engine = engine();
    let request = options(1.);
    let alone = serde_json::to_value(engine.compile_gpu_request(&request.to_string()).unwrap()).unwrap();
    let mut shared = request;
    shared["prepareViewport"] = json!({"x":-100,"y":-100,"w":1024,"h":768});
    let prepared = serde_json::to_value(engine.compile_gpu_request(&shared.to_string()).unwrap()).unwrap();
    assert_eq!(alone, prepared);
}

#[test]
fn offscreen_backdrop_input_halo_does_not_reject_maximum_zoom() {
    let mut engine = Engine::new();
    engine.load_document(&json!({"schemaVersion":5,"id":"max","name":"max",
      "pages":[{"id":"p","name":"p","children":["board"],"background":"#ffffff"}],
      "nodes":{
        "board":{"id":"board","kind":"frame","width":700,"height":570,"clip":true,
          "children":["shape","glass"],"fills":[{"kind":"solid","color":"#ffffff"}],
          "effects":[{"kind":"shadow","radius":8,"y":8,"color":"#000000"}]},
        "shape":{"id":"shape","kind":"rectangle","width":600,"height":245,
          "transform":[1,0,0,1,42,180],"fills":[{"kind":"solid","color":"#6677cc"}]},
        "glass":{"id":"glass","kind":"rectangle","width":235,"height":100,
          "transform":[1,0,0,1,380,290],"radii":[18,18,18,18],
          "effects":[{"kind":"glass","radius":12,"color":"#000000","glass":{
            "depth":8,"refraction":0.5,"dispersion":0.3,"lightAngle":45,"lightIntensity":0.5}}]}
      }}).to_string()).unwrap();
    let request = json!({"pageId":"p","width":128,"height":128,"rasterProfile":"analytic",
      "view":{"x":0,"y":0,"zoom":64},"gpuViewport":{"x":28000,"y":17000,"w":128,"h":128}});
    let scene=engine.compile_gpu_request(&request.to_string()).unwrap();
    assert!(scene.nodes.contains_key("shape"));
    assert!(!scene.nodes.contains_key("glass"));
    assert_eq!(scene.extent.w,128);
    assert!(scene.nodes["board"].effects.is_empty());
}
