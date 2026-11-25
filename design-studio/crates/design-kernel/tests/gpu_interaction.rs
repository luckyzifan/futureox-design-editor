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

fn clipped_board(dx: f64, dy: f64) -> Value {
    let mut nodes = serde_json::Map::new();
    let mut children = Vec::new();
    nodes.insert("board".into(), json!({"id":"board","kind":"frame","width":1440,"height":1030,"clip":true,
        "transform":[1,0,0,1,dx,dy],"fills":[{"kind":"solid","color":"#f4f1ea"}],"children":[]}));
    for i in 0..24 {
        let id = format!("shape-{i:02}");
        children.push(id.clone());
        let x = (i % 6) as f64 * 220.0 + 8.0;
        let y = (i / 6) as f64 * 240.0 + 12.0;
        // Ellipses cross the clipped viewport and sit fully inside it. Rectangles
        // cover the analytic fast path. One shape is deliberately past the edge.
        if i % 2 == 0 {
            nodes.insert(id.clone(), json!({"id":id,"kind":"ellipse","width":86,"height":54,
                "transform":[1,0,0,1,x,y],"fills":[{"kind":"solid","color":"#315c8a"}],
                "strokes":[{"width":1.25,"paint":{"kind":"solid","color":"#102033"}}]}));
        } else {
            nodes.insert(id.clone(), json!({"id":id,"kind":"rectangle","width":70,"height":40,
                "transform":[1,0,0,1,x,y],"fills":[{"kind":"solid","color":"#c4552a"}]}));
        }
    }
    nodes.get_mut("board").unwrap()["children"] = json!(children);
    json!({"schemaVersion":1,"id":"clipped-board","name":"Clipped board","pages":[{"id":"p","name":"Page","children":["board"],"background":"#ffffff"}],"nodes":nodes})
}

fn clipped_request() -> String {
    // 80% zoom at device pixel ratio 2. 514 device pixels show about 321
    // world units of the 1440×1030 board, so the board stays clipped.
    json!({"pageId":"p","width":514,"height":514,"view":{"x":18.0,"y":-12.0,"zoom":1.6},
        "rasterProfile":"figmaSubpixel"}).to_string()
}

#[test]
fn integer_device_translation_reuses_scanline_programs_and_matches_a_fresh_scene() {
    let request = clipped_request();
    let mut warm = Engine::new();
    warm.load_document(&clipped_board(0.0, 0.0).to_string()).unwrap();
    let first = warm.compile_gpu_packet_request(&request).unwrap();
    assert!(first.len() > 1000, "clipped board must produce a real scene packet");
    // 1.25 world units * 1.6 = exactly 2 device pixels. -0.625 * 1.6 = -1.
    let moved = futureox_design_kernel::math::Transform([1.0, 0.0, 0.0, 1.0, 1.25, -0.625]);
    assert!(warm.apply_interaction_transforms(&[("board".into(), moved)].into_iter().collect()).unwrap());
    let shifted = warm.compile_gpu_packet_request(&request).unwrap();
    let stats = warm.gpu_compile_cache_stats();
    assert!(stats["programShifts"].as_u64().unwrap_or(0) > 0, "interior shapes must shift, stats={stats}");
    let mut fresh = Engine::new();
    fresh.load_document(&clipped_board(1.25, -0.625).to_string()).unwrap();
    let expected = fresh.compile_gpu_packet_request(&request).unwrap();
    assert_eq!(shifted, expected, "integer device shift must match an independent compile");

    let mut fractional = Engine::new();
    fractional.load_document(&clipped_board(0.0, 0.0).to_string()).unwrap();
    fractional.compile_gpu_packet_request(&request).unwrap();
    let partial = futureox_design_kernel::math::Transform([1.0, 0.0, 0.0, 1.0, 0.2, 0.0]);
    assert!(fractional.apply_interaction_transforms(&[("board".into(), partial)].into_iter().collect()).unwrap());
    let actual = fractional.compile_gpu_packet_request(&request).unwrap();
    assert_eq!(fractional.gpu_compile_cache_stats()["programShifts"].as_u64().unwrap_or(0), 0);
    let mut oracle = Engine::new();
    oracle.load_document(&clipped_board(0.2, 0.0).to_string()).unwrap();
    assert_eq!(actual, oracle.compile_gpu_packet_request(&request).unwrap(), "a fractional phase still matches a fresh compile");
}

#[test]
fn integer_step_after_a_fractional_pose_matches_a_fresh_scene() {
    // Enough curves to take the parallel pose compile. A whole-pixel step
    // after a fractional phase must not reuse curved scanline words.
    let request = clipped_request();
    let mut nodes = serde_json::Map::new();
    let mut children = Vec::new();
    for i in 0..60 {
        let id = format!("shape-{i:02}");
        children.push(id.clone());
        let x = (i % 10) as f64 * 120.0 + 8.0;
        let y = (i / 10) as f64 * 90.0 + 12.0;
        if i % 3 == 0 {
            nodes.insert(id.clone(), json!({"id":id,"kind":"rectangle","width":40,"height":24,
                "transform":[1,0,0,1,x,y],"fills":[{"kind":"solid","color":"#c4552a"}]}));
        } else {
            nodes.insert(id.clone(), json!({"id":id,"kind":"ellipse","width":70,"height":36,
                "transform":[1,0,0,1,x,y],"fills":[{"kind":"solid","color":"#315c8a"}],
                "strokes":[{"width":1.25,"paint":{"kind":"solid","color":"#102033"}}]}));
        }
    }
    nodes.insert("board".into(), json!({"id":"board","kind":"frame","width":1440,"height":1030,"clip":true,
        "transform":[1,0,0,1,0,0],"fills":[{"kind":"solid","color":"#f4f1ea"}],"children":children}));
    let document = json!({"schemaVersion":1,"id":"phase","name":"phase","pages":[{"id":"p","name":"Page","children":["board"],"background":"#ffffff"}],"nodes":nodes});
    let moved = |dx: f64, dy: f64| {
        let mut value = document.clone();
        value["nodes"]["board"]["transform"] = json!([1.0, 0.0, 0.0, 1.0, dx, dy]);
        value
    };
    let mut warm = Engine::new();
    warm.load_document(&document.to_string()).unwrap();
    warm.compile_gpu_packet_request(&request).unwrap();
    let partial = futureox_design_kernel::math::Transform([1.0, 0.0, 0.0, 1.0, 0.2, 0.0]);
    assert!(warm.apply_interaction_transforms(&[("board".into(), partial)].into_iter().collect()).unwrap());
    let fractional = warm.compile_gpu_packet_request(&request).unwrap();
    let mut fractional_oracle = Engine::new();
    fractional_oracle.load_document(&moved(0.2, 0.0).to_string()).unwrap();
    assert_eq!(fractional, fractional_oracle.compile_gpu_packet_request(&request).unwrap());
    // 1.25 world units * zoom 1.6 = 2 device pixels. -0.625 * 1.6 = -1.
    let step = futureox_design_kernel::math::Transform([1.0, 0.0, 0.0, 1.0, 1.45, -0.625]);
    assert!(warm.apply_interaction_transforms(&[("board".into(), step)].into_iter().collect()).unwrap());
    let shifted = warm.compile_gpu_packet_request(&request).unwrap();
    assert!(warm.gpu_compile_cache_stats()["programShifts"].as_u64().unwrap_or(0) > 0, "rectangles still shift");
    let mut fresh = Engine::new();
    fresh.load_document(&moved(1.45, -0.625).to_string()).unwrap();
    assert_eq!(shifted, fresh.compile_gpu_packet_request(&request).unwrap(), "integer step after a fractional pose must match an independent compile");
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
