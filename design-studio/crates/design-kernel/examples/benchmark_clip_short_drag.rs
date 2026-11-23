//! Native CPU stages of an 80% clipped board drag. No GPU, present, or desktop frame times.
//!
//! Stages: last valid input, scene compile, packet encode, pipe IPC, and a
//! reader-thread handoff matching `design-prepare`. GPU completion and present
//! ACK are outside this process.
use futureox_design_kernel::{Engine, math::Transform};
use serde_json::{json, Value};
use std::{
    hint::black_box,
    io::{Read, Write},
    os::unix::net::UnixStream,
    sync::mpsc,
    thread,
    time::Instant,
};

fn board(children: usize) -> Value {
    let mut nodes = serde_json::Map::new();
    let mut ids = Vec::with_capacity(children);
    for i in 0..children {
        let id = format!("n{i:04}");
        ids.push(id.clone());
        let col = (i % 40) as f64;
        let row = (i / 40) as f64;
        nodes.insert(id.clone(), json!({
            "id": id, "kind": "rectangle", "width": 28, "height": 18,
            "transform": [1, 0, 0, 1, 12.0 + col * 34.0, 16.0 + row * 28.0],
            "fills": [{"kind": "solid", "color": "#dbe8f0"}],
            "strokes": [{"width": 0.5, "paint": {"kind": "solid", "color": "#203040"}}]
        }));
    }
    nodes.insert("board".into(), json!({
        "id": "board", "kind": "frame", "name": "Products", "clip": true,
        "width": 1440, "height": 1030,
        "fills": [{"kind": "solid", "color": "#dbe8f0"}],
        "children": ids
    }));
    json!({
        "schemaVersion": 1, "id": "clip-short-drag", "name": "Clipped short drag",
        "pages": [{"id": "p", "name": "Page", "children": ["board"], "background": "#ffffff"}],
        "nodes": nodes
    })
}

fn options(zoom: f64) -> String {
    // 1143×999 CSS at DPR 2. Zoom is device pixels per world unit (CSS zoom × DPR).
    json!({
        "pageId": "p", "width": 2286, "height": 1998,
        "view": {"x": 8.0, "y": 6.0, "zoom": zoom},
        "rasterProfile": "analytic"
    })
    .to_string()
}

fn pose(dx: f64, dy: f64) -> std::collections::BTreeMap<String, Transform> {
    std::collections::BTreeMap::from([("board".into(), Transform([1., 0., 0., 1., dx, dy]))])
}

fn median(samples: &mut [f64]) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[samples.len() / 2]
}

struct Stage {
    apply_ms: f64,
    compile_ms: f64,
    encode_ms: f64,
    packet_bytes: usize,
}

fn one_pose(engine: &mut Engine, request: &str, dx: f64, dy: f64) -> Result<Stage, String> {
    let at = Instant::now();
    let applied = engine.apply_interaction_transforms(&pose(dx, dy))?;
    let apply_ms = at.elapsed().as_secs_f64() * 1000.;
    if !applied {
        return Err("clipped board pose was not retained".into());
    }
    let at = Instant::now();
    let scene = engine.compile_gpu_request(request)?;
    let compile_ms = at.elapsed().as_secs_f64() * 1000.;
    let at = Instant::now();
    let packet = scene.into_packet()?;
    let encode_ms = at.elapsed().as_secs_f64() * 1000.;
    let packet_bytes = packet.len();
    black_box(&packet);
    Ok(Stage { apply_ms, compile_ms, encode_ms, packet_bytes })
}

fn pipe_copy_ms(bytes: usize) -> f64 {
    let (mut read, mut write) = UnixStream::pair().expect("socket pair");
    let payload = vec![0xA5u8; bytes];
    let at = Instant::now();
    let sender = thread::spawn(move || {
        write.write_all(&payload).unwrap();
    });
    let mut got = vec![0u8; bytes];
    read.read_exact(&mut got).unwrap();
    sender.join().unwrap();
    black_box(got);
    at.elapsed().as_secs_f64() * 1000.
}

/// Same pose as `one_pose`, but the request is read on a side thread and the
/// packet is copied back through a socket. The timed interval starts after the
/// worker has finished its own warm compile.
fn handoff_ms(document: &str, request: &str, dx: f64, dy: f64) -> Result<f64, String> {
    let (mut parent_read, mut child_write) = UnixStream::pair().expect("reply pair");
    let (mut child_read, mut parent_write) = UnixStream::pair().expect("request pair");
    let document = document.to_owned();
    let request = request.to_owned();
    let worker = thread::spawn(move || -> Result<(), String> {
        let (tx, rx) = mpsc::sync_channel::<(f64, f64)>(1);
        let reader = thread::spawn(move || -> Result<(), String> {
            let mut buf = [0u8; 16];
            child_read.read_exact(&mut buf).map_err(|e| e.to_string())?;
            let dx = f64::from_le_bytes(buf[0..8].try_into().unwrap());
            let dy = f64::from_le_bytes(buf[8..16].try_into().unwrap());
            tx.send((dx, dy)).map_err(|_| "handoff closed".to_string())
        });
        let mut engine = Engine::new();
        engine.load_document(&document)?;
        let _ = engine.compile_gpu_request(&request)?.into_packet()?;
        let _ = engine.apply_interaction_transforms(&pose(0., 0.))?;
        let _ = engine.compile_gpu_request(&request)?.into_packet()?;
        child_write.write_all(b"R").map_err(|e| e.to_string())?;
        let (dx, dy) = rx.recv().map_err(|_| "reader dropped".to_string())?;
        reader.join().map_err(|_| "reader panicked".to_string())??;
        let stage = one_pose(&mut engine, &request, dx, dy)?;
        let packet = vec![0u8; stage.packet_bytes];
        child_write.write_all(&(stage.packet_bytes as u32).to_le_bytes()).map_err(|e| e.to_string())?;
        child_write.write_all(&packet).map_err(|e| e.to_string())?;
        Ok(())
    });
    let mut ready = [0u8; 1];
    parent_read.read_exact(&mut ready).map_err(|e| e.to_string())?;
    let at = Instant::now();
    parent_write.write_all(&dx.to_le_bytes()).unwrap();
    parent_write.write_all(&dy.to_le_bytes()).unwrap();
    let mut len = [0u8; 4];
    parent_read.read_exact(&mut len).map_err(|e| e.to_string())?;
    let mut packet = vec![0u8; u32::from_le_bytes(len) as usize];
    parent_read.read_exact(&mut packet).map_err(|e| e.to_string())?;
    let ms = at.elapsed().as_secs_f64() * 1000.;
    worker.join().map_err(|_| "worker panicked".to_string())??;
    black_box(packet);
    Ok(ms)
}

fn run(zoom: f64, label: &str) -> Result<Value, String> {
    let document = board(1000);
    let text = document.to_string();
    let request = options(zoom);
    let mut engine = Engine::new();
    engine.load_document(&text)?;
    // The first compile resolves layout. A pose before that is not retained.
    let settled = engine.compile_gpu_request(&request)?.into_packet()?;
    black_box(settled);
    let cold = one_pose(&mut engine, &request, 0., 0.)?;
    let mut apply = Vec::new();
    let mut compile = Vec::new();
    let mut encode = Vec::new();
    let mut bytes = 0usize;
    let loops = if std::env::var("CLIP_PROFILE").ok().as_deref() == Some("1") { 28 } else { 12 };
    for i in 0..loops {
        let dx = (i as f64 + 1.) * 0.35;
        let stage = one_pose(&mut engine, &request, dx, 0.2)?;
        if i + 3 >= loops {
            apply.push(stage.apply_ms);
            compile.push(stage.compile_ms);
            encode.push(stage.encode_ms);
            bytes = stage.packet_bytes;
        }
    }
    let same = one_pose(&mut engine, &request, (loops as f64) * 0.35, 0.2)?;
    let ipc = pipe_copy_ms(bytes);
    let inline_last = apply.last().copied().unwrap_or(0.) + compile.last().copied().unwrap_or(0.) + encode.last().copied().unwrap_or(0.);
    let handoff = if std::env::var("CLIP_PROFILE").ok().as_deref() == Some("1") {
        None
    } else {
        Some(handoff_ms(&text, &request, 4.2, 0.2)?)
    };
    Ok(json!({
        "label": label,
        "zoom": zoom,
        "nodes": 1001,
        "coldApplyMs": cold.apply_ms,
        "coldCompileMs": cold.compile_ms,
        "coldEncodeMs": cold.encode_ms,
        "warmApplyMedianMs": median(&mut apply),
        "warmCompileMedianMs": median(&mut compile),
        "warmEncodeMedianMs": median(&mut encode),
        "warmPoseMedianMs": median(&mut apply.clone()) + median(&mut compile.clone()) + median(&mut encode.clone()),
        "samePoseApplyMs": same.apply_ms,
        "samePoseCompileMs": same.compile_ms,
        "samePoseEncodeMs": same.encode_ms,
        "packetBytes": bytes,
        "pipeIpcMs": ipc,
        "inlineLastSampleMs": inline_last,
        "threadHandoffPoseMs": handoff,
        "cache": engine.gpu_compile_cache_stats(),
    }))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let profile = if cfg!(debug_assertions) { "debug" } else { "optimized" };
    // 1.6 = 80% CSS × DPR 2. 1.5 = 75% CSS × DPR 2, board fully inside this viewport.
    let mut rows = vec![run(1.6, "clipped-80")?];
    if std::env::var("CLIP_PROFILE").ok().as_deref() != Some("1") {
        rows.push(run(1.5, "full-75")?);
    }
    println!("{}", serde_json::to_string_pretty(&json!({
        "profile": profile,
        "scope": "Native CPU only. No GPU completion, present ACK, or desktop frame time.",
        "rows": rows,
    }))?);
    Ok(())
}
