//! Issue 483: at 15060% (device scale 301.2) a whole-viewport interactive
//! preview of a 5×5 zoom-blur ellipse walks a neighboring filter whose device
//! halo exceeds 2048. The same engine admits a 514-pixel exact tile on the
//! ellipse. Timings are printed for the measured run; assertions are the
//! admission split, not a fixed millisecond budget.
use futureox_design_kernel::Engine;
use serde_json::{json, Value};
use std::time::Instant;

const DEVICE_ZOOM: f64 = 150.60 * 2.0;

fn effect_zoom(center: [f64; 2]) -> Value {
    json!({
        "kind": "zoom-blur",
        "radius": 0,
        "color": "#000000",
        "visible": true,
        "zoomBlur": { "amount": 24, "center": center }
    })
}

fn document(center: [f64; 2], fillers: usize) -> Value {
    let mut nodes = serde_json::Map::new();
    nodes.insert("ellipse".into(), json!({
        "id": "ellipse",
        "kind": "ellipse",
        "name": "椭圆 66",
        "width": 5.0,
        "height": 5.0,
        "fills": [{ "kind": "solid", "color": "#3366b3" }],
        "effects": [effect_zoom(center)]
    }));
    nodes.insert("neighbor".into(), json!({
        "id": "neighbor",
        "kind": "rectangle",
        "name": "邻近高斯",
        "width": 1.5,
        "height": 1.5,
        "transform": [1.0, 0.0, 0.0, 1.0, 10.0, 0.2],
        "fills": [{ "kind": "solid", "color": "#c04040" }],
        "effects": [{ "kind": "gaussian-blur", "radius": 2.5, "color": "#000000", "visible": true }]
    }));
    let mut children = vec!["ellipse".to_string(), "neighbor".to_string()];
    for index in 0..fillers {
        let id = format!("far-{index}");
        nodes.insert(id.clone(), json!({
            "id": id,
            "kind": "rectangle",
            "width": 4.0,
            "height": 4.0,
            "transform": [1.0, 0.0, 0.0, 1.0, 10_000.0 + index as f64, 10_000.0],
            "fills": [{ "kind": "solid", "color": "#888888" }]
        }));
        children.push(id);
    }
    json!({
        "schemaVersion": 19,
        "id": "zoom-focus-preview",
        "name": "zoom focus preview",
        "pages": [{ "id": "p", "name": "p", "background": "#ffffff", "children": children }],
        "nodes": nodes
    })
}

fn engine(document: &Value) -> (Engine, usize) {
    let text = serde_json::to_string(document).unwrap();
    let bytes = text.len();
    let mut engine = Engine::new();
    engine.load_document(&text).unwrap();
    (engine, bytes)
}

fn whole_frame(engine: &mut Engine) -> Result<(), String> {
    engine.compile_gpu_request(&json!({
        "pageId": "p",
        "width": 2410,
        "height": 904,
        "view": { "x": 0.0, "y": 0.0, "zoom": DEVICE_ZOOM },
        "rasterProfile": "analytic",
        "transparent": false,
        "grid": false
    }).to_string())
    .map(|_| ())
}

fn exact_tile(engine: &mut Engine) -> Result<(), String> {
    engine.compile_gpu_request(&json!({
        "pageId": "p",
        "width": 514,
        "height": 514,
        "view": { "x": 0.0, "y": 0.0, "zoom": DEVICE_ZOOM },
        "rasterProfile": "analytic",
        "transparent": false,
        "grid": false,
        "gpuViewport": { "x": 0, "y": 0, "w": 514, "h": 514 }
    }).to_string())
    .map(|_| ())
}

fn time<T>(label: &str, work: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let value = work();
    eprintln!(
        "{label}: {:.3} ms",
        started.elapsed().as_secs_f64() * 1000.0
    );
    value
}

#[test]
fn whole_viewport_preview_rejects_halo_while_ellipse_tile_compiles() {
    let (mut preview, bytes) = engine(&document([0.5, 0.5], 0));
    eprintln!("document bytes without fillers: {bytes}");
    let rejected = time("whole-frame compile", || whole_frame(&mut preview));
    let message = rejected.expect_err("whole viewport must hit the zoom source halo guard");
    assert!(
        message.contains("Zoom source filter halo exceeds 2048 device pixels"),
        "{message}"
    );
    let moved = time("whole-frame after focus move", || {
        let (mut engine, _) = engine(&document([0.82, 0.2], 0));
        whole_frame(&mut engine)
    });
    assert_eq!(
        moved.expect_err("focus position does not admit the same viewport"),
        message
    );

    let (mut tile, _) = engine(&document([0.82, 0.2], 0));
    time("exact 514 tile", || exact_tile(&mut tile)).expect("ellipse tile must compile");

    let (mut cold, filler_bytes) = time("load 752-node document", || engine(&document([0.5, 0.5], 750)));
    eprintln!("document bytes with 750 offscreen rectangles: {filler_bytes}");
    let heavy = time("whole-frame compile after 752-node load", || whole_frame(&mut cold));
    assert!(
        heavy.expect_err("offscreen nodes do not remove the in-view halo").contains("Zoom source filter halo exceeds 2048 device pixels")
    );
    time("exact tile after rejected whole frame", || exact_tile(&mut cold)).expect("tile still compiles on the same engine");

    let (mut wide, wide_bytes) = time("load 4000-offscreen-node document", || engine(&document([0.5, 0.5], 4000)));
    eprintln!("document bytes with 4000 offscreen rectangles: {wide_bytes}");
    let wide_rejected = time("whole-frame compile after 4000-node load", || whole_frame(&mut wide));
    assert!(wide_rejected.expect_err("larger document keeps the same halo rejection").contains("Zoom source filter halo exceeds 2048 device pixels"));
    time("exact tile on the loaded 4000-node engine", || exact_tile(&mut wide)).expect("tile compiles without repeating the rejected viewport");
}
