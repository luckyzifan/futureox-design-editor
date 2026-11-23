//! Per-sample wall time for steady pan, zoom, and drag.
//!
//! This is native CPU time of the production compile/pose entry points.
//! It is not input-to-photon, scanout, or a GPU frame time.
//! Hardware WebGPU, macOS, Metal, Electron, and official desktop apps are not
//! measured here.
//!
//! Release:
//!   cargo run --release -p futureox-design-kernel --example interaction_pace
use futureox_design_kernel::{math::Transform, Engine};
use serde_json::{json, Map, Value};
use std::time::Instant;

fn rect(id: &str, x: f64, y: f64) -> Value {
    json!({
        "id": id, "kind": "rectangle", "width": 28.0, "height": 18.0,
        "transform": [1, 0, 0, 1, x, y],
        "fills": [{"kind": "solid", "color": "#3d6cb5"}],
        "strokes": [{"width": 0.5, "paint": {"kind": "solid", "color": "#1c2836"}}]
    })
}

fn flat_document(count: usize) -> Value {
    let mut nodes = Map::new();
    let mut children = Vec::with_capacity(count);
    for i in 0..count {
        let id = format!("n{i:05}");
        children.push(id.clone());
        nodes.insert(id.clone(), rect(&id, (i % 40) as f64 * 36.0, (i / 40) as f64 * 28.0));
    }
    json!({
        "schemaVersion": 5, "id": "pace-flat", "name": "pace",
        "pages": [{"id": "p", "name": "Page", "children": children, "background": "#f4f5f7"}],
        "nodes": nodes
    })
}

/// One framed cluster plus many untouched siblings. Dragging the frame moves
/// every child; the siblings stay put.
fn framed_document(siblings: usize, children: usize) -> Value {
    let mut nodes = Map::new();
    let mut page = Vec::new();
    for i in 0..siblings {
        let id = format!("s{i:05}");
        page.push(id.clone());
        nodes.insert(id.clone(), rect(&id, 900.0 + (i % 40) as f64 * 36.0, (i / 40) as f64 * 28.0));
    }
    let mut inside = Vec::new();
    for i in 0..children {
        let id = format!("c{i:05}");
        inside.push(id.clone());
        nodes.insert(id.clone(), rect(&id, (i % 20) as f64 * 30.0, (i / 20) as f64 * 24.0));
    }
    nodes.insert("frame".into(), json!({
        "id": "frame", "kind": "frame", "width": 640.0, "height": 480.0,
        "clip": true, "transform": [1, 0, 0, 1, 40.0, 30.0], "children": inside,
        "fills": [{"kind": "solid", "color": "#ffffff"}]
    }));
    page.insert(0, "frame".into());
    json!({
        "schemaVersion": 5, "id": "pace-frame", "name": "pace",
        "pages": [{"id": "p", "name": "Page", "children": page, "background": "#f4f5f7"}],
        "nodes": nodes
    })
}

fn summarize(label: &str, samples: &[f64], extra: Value) -> Value {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let n = sorted.len().max(1);
    let mean = samples.iter().sum::<f64>() / n as f64;
    let var = samples.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / n as f64;
    let median = sorted[n / 2];
    let p95 = sorted[((n.saturating_sub(1) as f64) * 0.95).round() as usize];
    let max = *sorted.last().unwrap_or(&0.0);
    // A hitch is a sample that blows the steady pace, not a uniformly slow path.
    let limit = (median * 2.0).max(median + 8.0);
    let hitches: Vec<Value> = samples
        .iter()
        .enumerate()
        .filter(|(_, ms)| **ms > limit)
        .map(|(i, ms)| json!({"index": i, "ms": ms}))
        .collect();
    json!({
        "label": label,
        "samples": samples.len(),
        "meanMs": mean,
        "stdevMs": var.sqrt(),
        "minMs": sorted.first().copied().unwrap_or(0.0),
        "medianMs": median,
        "p95Ms": p95,
        "maxMs": max,
        "hitchAboveMs": limit,
        "hitchCount": hitches.len(),
        "hitches": hitches,
        "samplesMs": samples,
        "extra": extra,
    })
}

fn engine(document: &Value) -> Engine {
    let mut engine = Engine::new();
    engine.bind_frame_scene_scope("pace-owner").expect("scope");
    engine.load_document(&document.to_string()).expect("load");
    engine
}

fn request(x: f64, y: f64, zoom: f64) -> String {
    json!({
        "pageId": "p", "width": 640, "height": 480,
        "view": {"x": x, "y": y, "zoom": zoom},
        "transparent": false, "grid": false,
        "rasterProfile": "figmaSubpixel"
    })
    .to_string()
}

fn compile_packet(engine: &mut Engine, x: f64, y: f64, zoom: f64) -> (f64, f64, usize) {
    let request = request(x, y, zoom);
    let parse_started = Instant::now();
    let _: Value = serde_json::from_str(&request).expect("options");
    let parse_ms = parse_started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    let bytes = engine.compile_gpu_packet_request(&request).expect("packet");
    let compile_ms = started.elapsed().as_secs_f64() * 1000.0;
    (parse_ms, compile_ms, bytes.len())
}

fn pan(count: usize, frames: usize) -> Value {
    let mut engine = engine(&flat_document(count));
    let mut samples = Vec::new();
    let mut parse = Vec::new();
    let mut bytes = 0usize;
    for frame in 0..frames + 3 {
        let (parse_ms, compile_ms, len) = compile_packet(&mut engine, frame as f64 * 24.0, 12.0, 1.0);
        if frame >= 3 {
            samples.push(compile_ms);
            parse.push(parse_ms);
            bytes = len;
        }
    }
    summarize(
        "pan-same-zoom",
        &samples,
        json!({
            "nodes": count,
            "stepPx": 24.0,
            "parseMeanMs": parse.iter().sum::<f64>() / parse.len() as f64,
            "packetBytes": bytes,
            "cache": engine.gpu_compile_cache_stats(),
        }),
    )
}

fn zoom(count: usize, frames: usize) -> Value {
    let mut engine = engine(&flat_document(count));
    let mut samples = Vec::new();
    let mut zoom = 0.5_f64;
    for frame in 0..frames + 3 {
        zoom *= 1.04;
        let (_, compile_ms, bytes) = compile_packet(&mut engine, 80.0, 40.0, zoom);
        if frame >= 3 {
            samples.push(compile_ms);
            if frame + 1 == frames + 3 {
                return summarize(
                    "zoom-geometric",
                    &samples,
                    json!({"nodes": count, "finalZoom": zoom, "packetBytes": bytes}),
                );
            }
        }
    }
    unreachable!("zoom loop")
}

fn drag(label: &str, document: Value, id: &str, base_x: f64, base_y: f64, frames: usize) -> Value {
    let mut engine = engine(&document);
    // Warm the world index once, the same way a settled canvas does before a grab.
    let _ = compile_packet(&mut engine, 0.0, 0.0, 1.0);
    let mut pose_samples = Vec::new();
    let mut compile_samples = Vec::new();
    let mut total = Vec::new();
    let mut retained = true;
    let mut bytes = 0usize;
    for frame in 0..frames + 2 {
        let transform = Transform([1.0, 0.0, 0.0, 1.0, base_x + frame as f64 * 6.0, base_y + frame as f64 * 3.0]);
        let pose_started = Instant::now();
        retained &= engine
            .apply_interaction_transforms(&[(id.to_owned(), transform)].into_iter().collect())
            .expect("pose");
        let pose_ms = pose_started.elapsed().as_secs_f64() * 1000.0;
        let (_, compile_ms, len) = compile_packet(&mut engine, 0.0, 0.0, 1.0);
        if frame >= 2 {
            pose_samples.push(pose_ms);
            compile_samples.push(compile_ms);
            total.push(pose_ms + compile_ms);
            bytes = len;
        }
    }
    let pose = summarize(&format!("{label}-pose"), &pose_samples, json!({"retained": retained}));
    let compile = summarize(&format!("{label}-compile"), &compile_samples, json!({"packetBytes": bytes}));
    let both = summarize(&format!("{label}-pose-plus-compile"), &total, json!({
        "retained": retained,
        "pose": pose,
        "compile": compile,
        "cache": engine.gpu_compile_cache_stats(),
    }));
    both
}

fn main() {
    let frames: usize = std::env::var("PACE_FRAMES").ok().and_then(|v| v.parse().ok()).unwrap_or(16);
    let nodes: usize = std::env::var("PACE_NODES").ok().and_then(|v| v.parse().ok()).unwrap_or(600);
    let rows = vec![
        pan(nodes, frames),
        zoom(nodes.min(400), frames.min(12)),
        drag("drag-leaf", flat_document(nodes), "n00000", 0.0, 0.0, frames),
        drag("drag-frame", framed_document(nodes, nodes / 3), "frame", 40.0, 30.0, frames),
    ];
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "profile": if cfg!(debug_assertions) { "debug" } else { "optimized" },
            "cargoProfile": std::env::var("PACE_CARGO_PROFILE").unwrap_or_else(|_| "unspecified".into()),
            "optNote": "desktop-dev is opt-level 1 without LTO; release is thin LTO and one codegen unit",
            "arch": std::env::consts::ARCH,
            "scope": "Native CPU per-sample wall time of compile_gpu_packet_request and apply_interaction_transforms. Not input-to-photon, not GPU, not Electron, not official Figma/Sketch.",
            "notRun": ["hardware-webgpu", "macos", "metal", "electron", "official-figma-desktop", "official-sketch-desktop"],
            "warmupExcluded": "pan and zoom drop the first 3 samples; drag drops the first 2 after one settled compile",
            "rows": rows,
        }))
        .unwrap()
    );
}
