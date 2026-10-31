use futureox_design_kernel::Engine;
use serde_json::{json, Map, Value};

fn document(count: usize) -> Value {
    let mut nodes = Map::new();
    let mut children = Vec::new();
    for i in 0..count {
        let id = format!("rect-{i}");
        let angle = (i as f64 + 1.) * 0.0001;
        nodes.insert(id.clone(), json!({"id":id,"kind":"rectangle","width":512,"height":512,
            "transform":[angle.cos(),angle.sin(),-angle.sin(),angle.cos(),30.,20.],
            "fills":[{"kind":"solid","color":"#123456"}]}));
        children.push(id);
    }
    json!({"schemaVersion":3,"id":"program-budget","name":"program budget","rasterProfile":"figma",
        "colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":children}],"nodes":nodes})
}

#[test]
fn viewport_scene_budget_is_separate_from_path_and_exact_budgets() {
    let mut engine = Engine::new();
    engine.load_document(&document(100).to_string()).unwrap();
    let mut options = json!({"pageId":"p","width":514,"height":514,
        "view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figmaSubpixel"});
    assert!(engine.compile_gpu_request(&options.to_string()).err().unwrap().contains("interval program budget"));
    // Full-viewport scenes have their own aggregate budget even when effects
    // stay exact. Only tile-sized requests retain the smaller aggregate limit.
    options["width"] = json!(600);
    options["height"] = json!(600);
    let exact = engine.compile_gpu_request(&options.to_string()).unwrap();
    options["interactiveEffects"] = json!(true);
    let scene = engine.compile_gpu_request(&options.to_string()).unwrap();
    assert_eq!(exact.curves, scene.curves);
    assert!(scene.curves.len() > 2_000_000);
    assert!(scene.curves.len() <= 8_000_000);
    assert!(!scene.coherent_samples);
    engine.load_document(&document(400).to_string()).unwrap();
    assert!(engine.compile_gpu_request(&options.to_string()).err().unwrap().contains("interval program budget"));
}
