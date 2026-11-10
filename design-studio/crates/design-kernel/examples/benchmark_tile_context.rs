//! Confirm multi-tile compile wall after contour reuse.
//! CPU packets only: no GPU, GUI, or private topology bytes.
//! Independent reference is a fresh engine with no shared prepare viewport.
use futureox_design_kernel::Engine;
use serde_json::json;
use std::{hint::black_box, time::Instant};

fn rss_kib() -> u64 {
    std::fs::read_to_string("/proc/self/status").ok().and_then(|text| {
        text.lines().find_map(|line| {
            line.strip_prefix("VmRSS:").map(|rest| rest.split_whitespace().next().unwrap_or("0").parse().unwrap_or(0))
        })
    }).unwrap_or(0)
}
fn document(side: usize) -> String {
    let mut nodes = serde_json::Map::new();
    let mut children = Vec::new();
    for y in 0..side {
        for x in 0..side {
            let frame = format!("f{x}_{y}");
            children.push(frame.clone());
            let mut kids = Vec::new();
            for k in 0..3 {
                let id = format!("v{x}_{y}_{k}");
                kids.push(id.clone());
                nodes.insert(id.clone(), json!({
                    "id": id, "kind": "vector", "width": 18, "height": 18,
                    "transform": [1, 0, 0, 1, k as f64 * 6., 2.0],
                    "fills": [{"kind": "solid", "color": "#527acc"}],
                    "strokes": [{"width": 0.75, "paint": {"kind": "solid", "color": "#203040"}}],
                    "vectorGeometry": {"fillRule": "nonzero", "fill": [
                        {"move": [1.0, 1.0]},
                        {"cubic": [4.0 + k as f64, 16.0, 14.0, -3.0 - (x % 5) as f64, 16.0, 12.0 + (y % 7) as f64]},
                        {"line": [2.0, 16.0]},
                        "close"
                    ]}
                }));
            }
            nodes.insert(frame.clone(), json!({
                "id": frame, "kind": "frame", "width": 28, "height": 28, "clip": true,
                "transform": [1, 0, 0, 1, x as f64 * 32., y as f64 * 32.],
                "fills": [{"kind": "solid", "color": "#f4f1ea"}],
                "children": kids
            }));
        }
    }
    json!({
        "schemaVersion": 20, "id": "tile-context", "name": "tile-context",
        "colorManagement": {"documentSpace": "srgb", "referenceWhiteNits": 203.0, "peakLuminanceNits": 1000.0},
        "pages": [{"id": "p", "name": "Page", "background": "#ffffff", "children": children}],
        "nodes": nodes
    }).to_string()
}
fn request(view_x: f64, view_y: f64, tile_x: i32, tile_y: i32, prepare: bool) -> String {
    let mut value = json!({
        "pageId": "p", "width": 514, "height": 514,
        "view": {"x": view_x, "y": view_y, "zoom": 1.0},
        "rasterProfile": "figmaSubpixel",
        "gpuViewport": {"x": tile_x, "y": tile_y, "w": 514, "h": 514}
    });
    if prepare {
        value["prepareViewport"] = json!({"x": view_x as i32, "y": view_y as i32, "w": 1538, "h": 1538});
    }
    value.to_string()
}
fn tiles(view_x: f64, view_y: f64, prepare: bool) -> Vec<String> {
    let mut out = Vec::new();
    for ty in 0..3 {
        for tx in 0..3 {
            out.push(request(view_x, view_y, view_x as i32 + tx * 512, view_y as i32 + ty * 512, prepare));
        }
    }
    out
}
fn compile_all(document: &str, requests: &[String]) -> Result<(f64, usize, serde_json::Value), String> {
    let mut engine = Engine::new();
    engine.load_document(document)?;
    engine.bind_frame_scene_scope("tile-context")?;
    let started = Instant::now();
    let mut bytes = 0;
    for request in requests {
        let packet = engine.compile_gpu_packet_request(request)?;
        bytes += packet.len();
        black_box(&packet);
    }
    Ok((started.elapsed().as_secs_f64() * 1000., bytes, engine.gpu_compile_cache_stats()))
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let side: usize = std::env::args().nth(1).unwrap_or_else(|| "24".into()).parse()?;
    let samples: usize = std::env::args().nth(2).unwrap_or_else(|| "5".into()).parse()?;
    let document = document(side);
    let cold = tiles(0., 0., true);
    let adjacent = tiles(-512., -32., true);
    let direct_cold: Vec<_> = tiles(0., 0., false);
    let direct_adjacent: Vec<_> = tiles(-512., -32., false);
    let mut shared_oracle = Engine::new();
    shared_oracle.load_document(&document)?;
    for (shared, direct) in cold.iter().zip(&direct_cold) {
        let shared_packet = shared_oracle.compile_gpu_packet_request(shared)?;
        let mut direct_engine = Engine::new();
        direct_engine.load_document(&document)?;
        let direct_packet = direct_engine.compile_gpu_packet_request(direct)?;
        if shared_packet != direct_packet {
            return Err("shared prepare packet differs from the direct tile".into());
        }
    }
    let mut shared_adjacent = Engine::new();
    shared_adjacent.load_document(&document)?;
    for (shared, direct) in adjacent.iter().zip(&direct_adjacent) {
        let shared_packet = shared_adjacent.compile_gpu_packet_request(shared)?;
        let mut direct_engine = Engine::new();
        direct_engine.load_document(&document)?;
        if shared_packet != direct_engine.compile_gpu_packet_request(direct)? {
            return Err("adjacent shared prepare packet differs from the direct tile".into());
        }
    }
    let mut cold_ms = Vec::new();
    let mut adjacent_ms = Vec::new();
    let mut stats = None;
    let mut cold_bytes = 0;
    for sample in 0..samples {
        let (ms, bytes, sample_stats) = compile_all(&document, &cold)?;
        cold_bytes = bytes;
        cold_ms.push(ms);
        let (adj_ms, _, _) = compile_all(&document, &adjacent)?;
        adjacent_ms.push(adj_ms);
        stats = Some(sample_stats);
        eprintln!("sample {sample} cold={ms:.1} adjacent={adj_ms:.1} rss={}", rss_kib());
    }
    let mut cold_sorted = cold_ms.clone();
    let mut adj_sorted = adjacent_ms.clone();
    cold_sorted.sort_by(f64::total_cmp);
    adj_sorted.sort_by(f64::total_cmp);
    println!("{}", serde_json::to_string_pretty(&json!({
        "scope": "Shipping native CPU compile of 9 fixed-viewport tiles, then 9 adjacent-pan tiles. Packets match a fresh engine with no shared prepare. Not GPU draws, GUI completion, or the private topology file.",
        "nodes": side * side * 4,
        "coldMs": cold_ms,
        "coldMedianMs": cold_sorted[cold_sorted.len()/2],
        "adjacentMs": adjacent_ms,
        "adjacentMedianMs": adj_sorted[adj_sorted.len()/2],
        "coldPacketBytes": cold_bytes,
        "rssKib": rss_kib(),
        "stats": stats,
        "packetIdenticalToDirectTile": true
    }))?);
    Ok(())
}
