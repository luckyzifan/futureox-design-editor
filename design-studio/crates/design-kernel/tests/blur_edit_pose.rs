//! Settled pixels after the same endpoint and focus writes the canvas editor commits.
//! A patched engine must match a fresh load, including a later child-fill change.
use futureox_design_kernel::{editing::DocumentPatch, scene::Node, Engine, RenderOptions};
use serde_json::{json, Value};
use std::time::Instant;

fn pose(effect: Value) -> Value {
    json!({
        "schemaVersion": 19,
        "id": "blur-pose",
        "name": "blur pose",
        "pages": [{ "id": "p", "name": "p", "background": "#ffffff", "children": ["flip"] }],
        "nodes": {
            "flip": {
                "id": "flip", "kind": "group", "width": 200, "height": 160,
                "transform": [-1.0, 0.0, 0.0, 1.0, 220.0, 8.0],
                "children": ["turn"]
            },
            "turn": {
                "id": "turn", "kind": "group", "width": 120, "height": 90,
                "transform": [0.0, 1.0, -1.0, 0.0, 24.0, 12.0],
                "children": ["shape"]
            },
            "shape": {
                "id": "shape", "kind": "group", "width": 72, "height": 40,
                "transform": [1.0, 0.0, 0.0, 1.0, 6.0, 4.0],
                "children": ["left", "right"],
                "effects": [effect]
            },
            "left": {
                "id": "left", "kind": "rectangle", "width": 36, "height": 40,
                "fills": [{ "kind": "solid", "color": "#e02020" }]
            },
            "right": {
                "id": "right", "kind": "rectangle", "width": 36, "height": 40,
                "transform": [1.0, 0.0, 0.0, 1.0, 36.0, 0.0],
                "fills": [{ "kind": "solid", "color": "#2040e0" }]
            }
        }
    })
}

fn gradient() -> Value {
    json!({
        "kind": "blur", "radius": 4, "color": "#000000", "visible": true,
        "gradientBlur": {
            "start": [0.0, 20.0], "end": [72.0, 20.0],
            "startCount": 0.0, "endCount": 6.0, "smooth": true
        }
    })
}

fn zoom(center: [f64; 2]) -> Value {
    json!({
        "kind": "zoom-blur", "radius": 0, "color": "#000000", "visible": true,
        "zoomBlur": { "amount": 24, "center": center }
    })
}

fn options() -> RenderOptions {
    serde_json::from_value(json!({
        "pageId": "p", "width": 256, "height": 128,
        "view": { "x": 0, "y": 0, "zoom": 1 },
        "transparent": true, "rasterProfile": "figmaSubpixel"
    }))
    .unwrap()
}

fn load(document: &Value) -> Engine {
    let mut engine = Engine::new();
    engine.load_document(&document.to_string()).unwrap();
    engine
}

fn pixels(engine: &mut Engine) -> Vec<u8> {
    engine.render(&options()).unwrap()
}

fn png(engine: &mut Engine) -> Vec<u8> {
    engine.render_png(&options()).unwrap()
}

fn patch_node(document: &Value, id: &str) -> DocumentPatch {
    let node: Node = serde_json::from_value(document["nodes"][id].clone()).unwrap();
    DocumentPatch { nodes: [(id.to_string(), Some(node))].into(), ..Default::default() }
}

fn assert_same_target(label: &str, document: &Value) {
    let mut patched = load(document);
    let before = pixels(&mut patched);
    let mut moved = document.clone();
    if moved["nodes"]["shape"]["effects"][0]["gradientBlur"].is_object() {
        moved["nodes"]["shape"]["effects"][0]["gradientBlur"]["end"] = json!([18.0, 6.0]);
    } else {
        moved["nodes"]["shape"]["effects"][0]["zoomBlur"]["center"] = json!([0.8, 0.15]);
    }
    patched.apply_document_patch(&patch_node(&moved, "shape")).unwrap();
    let settled = pixels(&mut patched);
    let settled_png = png(&mut patched);
    assert_ne!(before, settled, "{label}: moving the axis must change pixels");
    let mut fresh = load(&moved);
    assert_eq!(pixels(&mut fresh), settled, "{label}: patched pixels differ from a fresh load");
    assert_eq!(png(&mut fresh), settled_png, "{label}: patched PNG differs from a fresh load");
    assert_eq!(png(&mut fresh), settled_png, "{label}: PNG encode is not stable");

    moved["nodes"]["left"]["fills"][0]["color"] = json!("#20c060");
    patched.apply_document_patch(&patch_node(&moved, "left")).unwrap();
    let recolored = pixels(&mut patched);
    let mut fresh_color = load(&moved);
    assert_ne!(recolored, settled, "{label}: a child fill change must not reuse the previous picture");
    assert_eq!(pixels(&mut fresh_color), recolored, "{label}: child fill patch differs from a fresh load");
    assert_eq!(png(&mut patched), png(&mut fresh_color), "{label}: child fill PNG differs from a fresh load");
}

#[test]
fn nested_flip_rotate_gradient_and_zoom_match_a_fresh_png() {
    assert_same_target("gradient", &pose(gradient()));
    assert_same_target("zoom", &pose(zoom([0.2, 0.75])));
}

#[test]
fn repeated_endpoint_patches_stay_on_the_fresh_picture() {
    let mut document = pose(gradient());
    let mut engine = load(&document);
    let mut samples = Vec::new();
    for step in 1..=6 {
        let end = [72.0 - step as f64 * 8.0, 20.0 - step as f64 * 2.0];
        document["nodes"]["shape"]["effects"][0]["gradientBlur"]["end"] = json!(end);
        let started = Instant::now();
        engine.apply_document_patch(&patch_node(&document, "shape")).unwrap();
        let frame = pixels(&mut engine);
        let png_bytes = png(&mut engine);
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
        let mut fresh = load(&document);
        assert_eq!(pixels(&mut fresh), frame, "step {step} pixels");
        assert_eq!(png(&mut fresh), png_bytes, "step {step} png");
    }
    eprintln!("gradient endpoint patch+render+png ms: {samples:?}");
}
