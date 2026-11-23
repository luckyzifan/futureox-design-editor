//! Clipped artboard-title drag on the native pose path.
//!
//! This is the CPU half of the 80% camera path: a 1440×1030 board does not fit
//! the viewport, so each pose is `apply_interaction_transforms` plus
//! `compile_gpu_packet`. Packet bytes stand in for the preparation IPC payload.
//! GPU encode, queue wait and presentation are not measured here; a machine
//! without a wgpu adapter cannot time them.
//!
//! `CLIP_DRAG_PROFILE=1` repeats the fractional pose so a sampler can attach.
//! Otherwise the process prints one JSON summary and exits.

use futureox_design_kernel::{math::Transform, Engine};
use serde_json::{json, Map, Value};
use std::hint::black_box;
use std::time::Instant;

fn board(count: usize, dx: f64, dy: f64) -> Value {
    let mut nodes = Map::new();
    let mut children = Vec::new();
    // Keep every shape inside the clipped 1280×800 device window (about 800×500
    // world units at zoom 1.6) so the pose compiles them instead of culling them.
    let columns = 16usize;
    for i in 0..count {
        let id = format!("shape-{i:04}");
        children.push(id.clone());
        let x = (i % columns) as f64 * 42.0 + 8.0;
        let y = (i / columns) as f64 * 36.0 + 8.0;
        nodes.insert(id.clone(), json!({"id":id,"kind":"ellipse","width":70,"height":48,
            "transform":[1,0,0,1,x,y],"fills":[{"kind":"solid","color":"#315c8a"}],
            "strokes":[{"width":1.5,"paint":{"kind":"solid","color":"#102033"}}]}));
    }
    nodes.insert("board".into(), json!({"id":"board","kind":"frame","width":1440,"height":1030,"clip":true,
        "transform":[1,0,0,1,dx,dy],"fills":[{"kind":"solid","color":"#f7f4ee"}],"children":children}));
    json!({"schemaVersion":1,"id":"clipped-drag","name":"Clipped drag",
        "pages":[{"id":"p","name":"Page","children":["board"],"background":"#ffffff"}],"nodes":nodes})
}

fn request() -> String {
    // 80% zoom × DPR 2. Viewport is smaller than the 2304×1648 device board.
    json!({"pageId":"p","width":1280,"height":800,"view":{"x":24.0,"y":16.0,"zoom":1.6},
        "rasterProfile":"figmaSubpixel","captureViewport":{"x":0,"y":0,"w":1280,"h":800}}).to_string()
}

struct Sample {
    pose_ms: f64,
    scene_ms: f64,
    packet_ms: f64,
    packet_bytes: usize,
    copy_ms: f64,
    shifts: u64,
    builds: u64,
}

fn pose(engine: &mut Engine, request: &str, at: usize, integer: bool) -> Result<Sample, Box<dyn std::error::Error>> {
    // Integer: 1.25 world × 1.6 = 2 device pixels. Fractional: 0.37 × 1.6 = 0.592.
    let step = if integer { 1.25 } else { 0.37 };
    let y = if integer { -0.625 } else { 0.21 };
    let moved = Transform([1.0, 0.0, 0.0, 1.0, step * at as f64, y * at as f64]);
    let pose_at = Instant::now();
    let retained = engine.apply_interaction_transforms(&[("board".into(), moved)].into_iter().collect())?;
    if !retained { return Err("artboard title pose was not retained".into()); }
    let pose_ms = pose_at.elapsed().as_secs_f64() * 1000.0;
    let scene_at = Instant::now();
    let scene = engine.compile_gpu_request(request)?;
    let scene_ms = scene_at.elapsed().as_secs_f64() * 1000.0;
    let packet_at = Instant::now();
    let packet = scene.into_packet()?;
    let packet_ms = packet_at.elapsed().as_secs_f64() * 1000.0;
    let copy_at = Instant::now();
    let copied = packet.clone();
    let copy_ms = copy_at.elapsed().as_secs_f64() * 1000.0;
    black_box(copied.len());
    let stats = engine.gpu_compile_cache_stats();
    Ok(Sample {
        pose_ms, scene_ms, packet_ms, packet_bytes: packet.len(), copy_ms,
        shifts: stats["programShifts"].as_u64().unwrap_or(0),
        builds: stats["builds"].as_u64().unwrap_or(0),
    })
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let count: usize = std::env::var("CLIP_DRAG_SHAPES").ok().and_then(|value| value.parse().ok()).unwrap_or(180);
    let profile = std::env::var("CLIP_DRAG_PROFILE").ok().as_deref() == Some("1");
    let profile_integer = std::env::var("CLIP_DRAG_INTEGER").ok().as_deref() == Some("1");
    let request = request();
    let mut engine = Engine::new();
    engine.load_document(&board(count, 0.0, 0.0).to_string())?;
    let warm = engine.compile_gpu_packet_request(&request)?;
    let warm_bytes = warm.len();
    if profile {
        let mut n = 0usize;
        let until = Instant::now() + std::time::Duration::from_secs(8);
        while Instant::now() < until {
            n += 1;
            let sample = pose(&mut engine, &request, n, profile_integer)?;
            black_box(sample.packet_bytes);
        }
        println!("{}", json!({"profile": if profile_integer {"integer"} else {"fractional"}, "iterations":n,"shapes":count}));
        return Ok(());
    }
    let mut fractional = Vec::new();
    let mut integer_engine = Engine::new();
    integer_engine.load_document(&board(count, 0.0, 0.0).to_string())?;
    integer_engine.compile_gpu_packet_request(&request)?;
    let mut integer = Vec::new();
    for at in 1..=8 {
        fractional.push(pose(&mut engine, &request, at, false)?);
        integer.push(pose(&mut integer_engine, &request, at, true)?);
    }
    let summarize = |rows: &[Sample]| {
        let mut pose_ms: Vec<f64> = rows.iter().map(|row| row.pose_ms).collect();
        let mut scene_ms: Vec<f64> = rows.iter().map(|row| row.scene_ms).collect();
        let mut packet_ms: Vec<f64> = rows.iter().map(|row| row.packet_ms).collect();
        let mut copy_ms: Vec<f64> = rows.iter().map(|row| row.copy_ms).collect();
        let pose_median = median(&mut pose_ms);
        let scene_median = median(&mut scene_ms);
        let packet_median = median(&mut packet_ms);
        let copy_median = median(&mut copy_ms);
        json!({
            "poseMsMedian": pose_median,
            "sceneMsMedian": scene_median,
            "packetEncodeMsMedian": packet_median,
            "packetCopyMsMedian": copy_median,
            "packetBytes": rows.last().map(|row| row.packet_bytes).unwrap_or(0),
            "programShifts": rows.last().map(|row| row.shifts).unwrap_or(0),
            "programBuilds": rows.last().map(|row| row.builds).unwrap_or(0),
            "serialCpuMsMedian": pose_median + scene_median + packet_median + copy_median,
        })
    };
    // The preparation engine is borrowed for the whole compile. A second
    // thread cannot compile the next pose on it. Overlapping the next compile
    // with GPU encode is only possible after this packet returns, and only if
    // the render worker does not keep the engine across the GPU wait. This
    // process does not do that handoff: encode/queue/present stay unmeasured.
    println!("{}", serde_json::to_string_pretty(&json!({
        "shapes": count,
        "warmupPacketBytes": warm_bytes,
        "camera": {"zoom": 1.6, "width": 1280, "height": 800, "board": [1440, 1030]},
        "fractionalDevicePhase": summarize(&fractional),
        "integerDevicePhase": summarize(&integer),
        "gpuEncode": "NOT_RUN",
        "present": "NOT_RUN",
        "threading": "single engine, compile then packet copy; no second compile overlapped",
    }))?);
    Ok(())
}
