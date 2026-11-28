//! Draw-count and byte-parity evidence for the instanced solid batch.
//! Requires a real GPU host: `cargo test --release --features hardware-tests
//! --test instanced_area_fills`.
#![cfg(feature = "hardware-tests")]

use futureox_design_gpu::{Backends, NativeGpu};
use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::{Value, json};

fn options(width: u32, height: u32) -> RenderOptions {
    serde_json::from_value(json!({
        "pageId": "p", "width": width, "height": height, "transparent": true,
        "rasterProfile": "figma", "view": {"x": 0, "y": 0, "zoom": 1}
    }))
    .unwrap()
}
fn document(nodes: Value, roots: Value) -> String {
    json!({
        "schemaVersion": 1, "id": "d", "name": "instanced area fills",
        "pages": [{"id": "p", "name": "p", "children": roots, "background": "#ffffff"}],
        "nodes": nodes
    })
    .to_string()
}
fn solid(id: &str, x: f64, y: f64, w: f64, h: f64, color: &str) -> Value {
    json!({"id":id,"kind":"rectangle","transform":[1,0,0,1,x,y],"width":w,"height":h,
        "fills":[{"kind":"solid","color":color}]})
}
/// 500 whole-device-pixel solid leaves: the shape a design canvas spends its
/// draw budget on.
fn grid(count: usize) -> (Value, Value) {
    let mut nodes = serde_json::Map::new();
    let mut roots = Vec::new();
    for i in 0..count {
        let x = 4. + (i % 25) as f64 * 38.;
        let y = 4. + (i / 25) as f64 * 38.;
        let color = ["#336699", "#cc5533", "#228855", "#665588"][i % 4];
        let id = format!("r{i}");
        nodes.insert(id.clone(), solid(&id, x, y, 30., 22., color));
        roots.push(Value::String(id));
    }
    (Value::Object(nodes), Value::Array(roots))
}
fn render(gpu: &mut NativeGpu, document: &str, options: &RenderOptions) -> (Vec<u8>, usize) {
    let mut engine = Engine::new();
    engine.load_document(document).unwrap();
    let scene = engine.compile_gpu(options).unwrap();
    let cpu = engine.render(options).unwrap();
    let native = gpu.render(&scene).unwrap();
    let different = cpu
        .chunks_exact(4)
        .zip(native.rgba.chunks_exact(4))
        .filter(|(a, b)| a != b)
        .count();
    assert_eq!(native.rgba.len(), cpu.len());
    assert_eq!(different, 0, "native/CPU differ on {different} pixels");
    (native.rgba, native.draw_calls)
}

#[tokio::test]
async fn whole_pixel_rectangles_batch_into_few_draws_with_identical_bytes() {
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    let opts = options(1000, 800);
    let (nodes, roots) = grid(500);
    let (_, draw_calls) = render(&mut gpu, &document(nodes, roots), &opts);
    println!("500 solid rects: {draw_calls} draw calls");
    assert!(draw_calls < 100, "500 leaves still cost {draw_calls} draws");
}

#[tokio::test]
async fn mixed_leaf_kinds_stay_byte_identical() {
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    let opts = options(320, 260);
    let (sin, cos) = 0.4_f64.sin_cos();
    let mut nodes = serde_json::Map::new();
    let mut roots = Vec::new();
    let mut push = |id: &str, node: Value| {
        nodes.insert(id.to_owned(), node);
        roots.push(Value::String(id.to_owned()));
    };
    push("plain", solid("plain", 8., 8., 40., 30., "#336699"));
    push("plain2", solid("plain2", 60., 8., 40., 30., "#cc5533"));
    push("fractional", solid("fractional", 108.5, 8.25, 40., 30., "#228855"));
    let mut rounded = solid("rounded", 8., 48., 40., 30., "#665588");
    rounded["radii"] = json!([8, 8, 8, 8]);
    push("rounded", rounded);
    let mut rotated = solid("rotated", 60., 48., 40., 30., "#996633");
    rotated["transform"] = json!([cos, sin, -sin, cos, 60., 48.]);
    push("rotated", rotated);
    let mut translucent = solid("translucent", 108., 48., 40., 30., "#333333");
    translucent["fills"] = json!([{"kind":"solid","color":"#333333","opacity":0.45}]);
    push("translucent", translucent);
    let mut stroked = solid("stroked", 8., 88., 40., 30., "#336699");
    stroked["strokes"] =
        json!([{"paint": {"kind": "solid", "color": "#101010"}, "width": 3.}]);
    push("stroked", stroked);
    let mut shadowed = solid("shadowed", 60., 88., 40., 30., "#cc5533");
    shadowed["effects"] = json!([{"kind":"shadow","radius":6.,"color":"#000000"}]);
    push("shadowed", shadowed);
    let mut faded = solid("faded", 108., 88., 40., 30., "#228855");
    faded["opacity"] = json!(0.5);
    push("faded", faded);
    // Eight whole-pixel leaves inside a clipping frame take the instanced path.
    let frame = json!({"id":"frame","kind":"frame","clip":true,
        "transform":[1,0,0,1,8,128],"width":280,"height":90,
        "fills":[{"kind":"solid","color":"#ffffff"}]});
    push("frame", frame);
    for i in 0..8 {
        let id = format!("clipped{i}");
        push(&id, solid(&id, 12. + i as f64 * 34., 136., 30., 60., "#4499cc"));
    }
    let (_, draw_calls) = render(&mut gpu, &document(nodes.into(), roots.into()), &opts);
    println!("mixed leaves: {draw_calls} draw calls");
}

#[tokio::test]
async fn fractional_rectangles_keep_the_analytic_mask() {
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    let opts = options(280, 120);
    let mut nodes = serde_json::Map::new();
    let mut roots = Vec::new();
    for i in 0..10 {
        let id = format!("f{i}");
        let x = 4. + i as f64 * 26.5;
        nodes.insert(id.clone(), solid(&id, x, 20.25, 24., 60., "#336699"));
        roots.push(Value::String(id));
    }
    let (_, draw_calls) = render(&mut gpu, &document(nodes.into(), roots.into()), &opts);
    println!("10 fractional rects: {draw_calls} draw calls");
    assert!(draw_calls >= 80, "fractional leaves must keep their masks, got {draw_calls}");
}
