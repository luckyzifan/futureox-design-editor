//! CPU compile of the documented 5×5 zoom-blur fixture at 15060% × DPR 2.
//! No GPU, Electron, Metal, or native Sketch file is involved.
use futureox_design_kernel::Engine;
use serde_json::json;
use std::time::Instant;

fn fixture() -> serde_json::Value {
    json!({
        "schemaVersion": 19,
        "id": "z",
        "name": "zoom",
        "pages": [{ "id": "p", "name": "P", "children": ["bg", "n"], "background": "#ffffff" }],
        "nodes": {
            "bg": {
                "id": "bg",
                "kind": "rectangle",
                "width": 240.0,
                "height": 240.0,
                "transform": [1.0, 0.0, 0.0, 1.0, -100.0, -100.0],
                "fills": [{
                    "kind": "image",
                    "color": "#000000",
                    "image": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGOUs4n6z8DAwMAEIkAYABksAbdASTMTAAAAAElFTkSuQmCC",
                    "fit": "stretch"
                }],
                "effects": [{ "kind": "gaussian-blur", "radius": 9.564871788024902, "color": "#000000" }]
            },
            "n": {
                "id": "n",
                "kind": "rectangle",
                "width": 5.0,
                "height": 5.0,
                "transform": [1.0, 0.0, 0.0, 1.0, 20.0, 20.0],
                "fills": [{ "kind": "solid", "color": "#3366b3" }],
                "effects": [{
                    "kind": "zoom-blur",
                    "radius": 0.0,
                    "color": "#000000",
                    "zoomBlur": { "amount": 10.0, "center": [0.5, 0.5] }
                }]
            }
        }
    })
}

fn median(mut samples: Vec<f64>) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[samples.len() / 2]
}

fn main() {
    let doc = serde_json::to_string(&fixture()).unwrap();
    let plain = json!({
        "pageId": "p",
        "width": 256,
        "height": 252,
        "rasterProfile": "analytic",
        "view": { "x": -6630.4, "y": -6624.7, "zoom": 301.2 },
        "grid": false
    });
    // Viewport-sized whole-page preview measured from the interaction renderer
    // at 15060% CSS zoom and DPR 2 (800×600 CSS px). No analytic regions.
    let preview = json!({
        "pageId": "p",
        "width": 3036,
        "height": 2636,
        "rasterProfile": "analytic",
        "view": { "x": 0.0, "y": 0.0, "zoom": 301.2 },
        "grid": false,
        "transparent": false,
        "captureViewport": { "x": -718, "y": -718, "w": 3036, "h": 2636 }
    });
    let mut exact = plain.clone();
    exact["gpuAnalyticRegions"] = json!(true);
    exact["gpuViewport"] = json!({ "x": -128, "y": -122, "w": 256, "h": 252 });
    let mut engine = Engine::new();
    let rejected = |engine: &mut Engine, request: &serde_json::Value| match engine.compile_gpu_request(&request.to_string()) {
        Err(error) => error,
        Ok(_) => panic!("rejected preview was admitted"),
    };
    engine.load_document(&doc).unwrap();
    let plain_error = rejected(&mut engine, &plain);
    engine.load_document(&doc).unwrap();
    let exact_scene = serde_json::to_value(engine.compile_gpu_request(&exact.to_string()).unwrap()).unwrap();
    let preview_error = rejected(&mut engine, &preview);
    let mut plain_ms = Vec::new();
    let mut preview_ms = Vec::new();
    let mut exact_ms = Vec::new();
    for _ in 0..5 {
        engine.load_document(&doc).unwrap();
        let started = Instant::now();
        let error = rejected(&mut engine, &plain);
        assert!(error.contains("exceeds 2048"), "{error}");
        plain_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        let started = Instant::now();
        let error = rejected(&mut engine, &preview);
        assert!(error.contains("exceeds 2048"), "{error}");
        preview_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        let started = Instant::now();
        engine.compile_gpu_request(&exact.to_string()).unwrap();
        exact_ms.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "scope": "CPU compile only. Not a GPU, Electron, Metal, or native Sketch measurement.",
            "fixture": "documented 5x5 zoom blur plus wide gaussian at zoom 301.2, matching zoom_blur::ordinary_wide_image_does_not_spend_a_siblings_zoom_halo",
            "documentedCropWithoutAnalyticRegions": { "admitted": false, "error": plain_error, "medianMs": median(plain_ms.clone()), "samplesMs": plain_ms },
            "interactionViewportPreview": { "width": 3036, "height": 2636, "admitted": false, "error": preview_error, "medianMs": median(preview_ms.clone()), "samplesMs": preview_ms },
            "exactAnalyticViewport": {
                "admitted": true,
                "nodes": exact_scene["nodes"].as_object().map(|nodes| nodes.len()).unwrap_or(0),
                "wideImageGaussian": !exact_scene["nodes"]["bg"]["wideImageGaussian"].is_null(),
                "medianMs": median(exact_ms.clone()),
                "samplesMs": exact_ms
            }
        }))
        .unwrap()
    );
}
