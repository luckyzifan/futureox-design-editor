//! Profile the clipped whole-board drag. The slow path recompiles a GPU scene
//! packet on every sample. The retained path translates pixels rasterized once.
//! A worker thread can keep compiling while the present thread does not wait.
//! This is native CPU time. It is not a hardware WebGPU, Metal, or GUI result.
use futureox_design_kernel::{math::Transform, renderer::RenderOptions, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{hint::black_box, sync::mpsc, thread, time::Instant};

fn document(count: usize, board_x: f64) -> Value {
    let mut nodes = serde_json::Map::new();
    let mut children = Vec::new();
    for i in 0..count {
        let id = format!("cell-{i:04}");
        children.push(id.clone());
        nodes.insert(id.clone(), json!({
            "id": id, "kind": "rectangle", "width": 4, "height": 3,
            "transform": [1, 0, 0, 1, 4 + (i % 40) * 10, 4 + (i / 40) * 7],
            "fills": [{"kind": "solid", "color": if i % 2 == 0 { "#224466" } else { "#88aa66" } }]
        }));
    }
    nodes.insert("board".into(), json!({
        "id": "board", "kind": "frame", "width": 420, "height": 180, "clip": true,
        "transform": [1, 0, 0, 1, board_x, 8],
        "fills": [{"kind": "solid", "color": "#dbe8f0"}], "children": children
    }));
    for (id, x) in [("left", -200.0), ("right", 900.0), ("below", 8.0)] {
        nodes.insert(id.into(), json!({
            "id": id, "kind": "frame", "width": 40, "height": 30, "clip": true,
            "transform": [1, 0, 0, 1, x, if id == "below" { 220.0 } else { 8.0 }],
            "fills": [{"kind": "solid", "color": "#333333"}]
        }));
    }
    json!({
        "schemaVersion": 2, "id": "clipped-bench", "name": "clipped",
        "pages": [{"id": "p", "name": "p", "children": ["left", "board", "right", "below"], "background": "#e8e8e8"}],
        "nodes": nodes
    })
}

fn options(width: u32, height: u32) -> RenderOptions {
    serde_json::from_value(json!({
        "pageId": "p", "width": width, "height": height,
        "view": {"x": 0.0, "y": 0.0, "zoom": 1.0}, "transparent": false, "grid": false,
        "rasterProfile": "analytic"
    })).unwrap()
}

fn pixel(buf: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * width + x) * 4) as usize;
    buf[i..i + 4].try_into().unwrap()
}
fn put(buf: &mut [u8], width: u32, x: u32, y: u32, px: [u8; 4]) {
    let i = ((y * width + x) * 4) as usize;
    buf[i..i + 4].copy_from_slice(&px);
}
fn translate_board(cache: &[u8], cache_width: u32, view_width: u32, view_height: u32,
    board: (i32, i32, i32, i32), shift: (i32, i32), background: [u8; 4]) -> Vec<u8> {
    let mut out = vec![0u8; (view_width * view_height * 4) as usize];
    for y in 0..view_height {
        let row = (y * cache_width * 4) as usize;
        let dest = (y * view_width * 4) as usize;
        let bytes = (view_width * 4) as usize;
        out[dest..dest + bytes].copy_from_slice(&cache[row..row + bytes]);
    }
    let (bx, by, bw, bh) = board;
    for row in by..by + bh {
        for col in bx..bx + bw {
            if col >= 0 && row >= 0 && (col as u32) < view_width && (row as u32) < view_height {
                put(&mut out, view_width, col as u32, row as u32, background);
            }
        }
    }
    let (dx, dy) = shift;
    for y in 0..bh {
        for x in 0..bw {
            let sx = bx + x;
            let sy = by + y;
            let tx = sx + dx;
            let ty = sy + dy;
            if sx < 0 || sy < 0 || tx < 0 || ty < 0 { continue; }
            if sx as u32 >= cache_width || sy as u32 >= view_height || tx as u32 >= view_width || ty as u32 >= view_height {
                continue;
            }
            put(&mut out, view_width, tx as u32, ty as u32, pixel(cache, cache_width, sx as u32, sy as u32));
        }
    }
    out
}

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn pose(engine: &mut Engine, x: f64) {
    assert!(engine.apply_interaction_transforms(&[("board".into(), Transform([1., 0., 0., 1., x, 8.]))].into()).unwrap());
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    let steps: usize = std::env::var("DRAG_STEPS").ok().and_then(|v| v.parse().ok()).unwrap_or(8);
    let repeats: usize = std::env::var("DRAG_REPEAT").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
    let nodes = 1000usize;
    let view_w = 256u32;
    let view_h = 144u32;
    let wide = 448u32;
    let doc = document(nodes, 8.);
    let doc_json = doc.to_string();
    let mut engine = Engine::new();
    engine.load_document(&doc_json).unwrap();
    let fill_started = Instant::now();
    let cache = engine.render_device_rect(&options(wide, view_h), 0, 0, wide, view_h).unwrap();
    let fill_ms = fill_started.elapsed().as_secs_f64() * 1000.;
    let background = pixel(&cache, wide, 0, 0);
    let board = (8i32, 8, 420, 180);
    // One revealing drag: move the board left so content from outside the
    // 256px viewport enters. Compare the blit with a fresh narrow render.
    let reveal = -32i32;
    let preview = translate_board(&cache, wide, view_w, view_h, board, (reveal, 0), background);
    let fresh = {
        let mut oracle = Engine::new();
        oracle.load_document(&document(nodes, 8. + reveal as f64).to_string()).unwrap();
        oracle.render_device_rect(&options(view_w, view_h), 0, 0, view_w, view_h).unwrap()
    };
    let pixels_match = preview == fresh;
    let fractional = {
        let mut engine = Engine::new();
        engine.load_document(&document(nodes, 8.5).to_string()).unwrap();
        engine.render_device_rect(&options(view_w, view_h), 0, 0, view_w, view_h).unwrap()
    };
    let unshifted = {
        let mut engine = Engine::new();
        engine.load_document(&doc_json).unwrap();
        engine.render_device_rect(&options(view_w, view_h), 0, 0, view_w, view_h).unwrap()
    };
    let nearest = {
        let mut engine = Engine::new();
        engine.load_document(&document(nodes, 9.).to_string()).unwrap();
        engine.render_device_rect(&options(view_w, view_h), 0, 0, view_w, view_h).unwrap()
    };
    let fractional_matches_unshifted = fractional == unshifted;
    let fractional_matches_nearest_integer = fractional == nearest;
    if !pixels_match && mode != "slow" && mode != "threads" {
        eprintln!("retained preview bytes differ from a fresh viewport render");
        std::process::exit(1);
    }

    let mut slow_follow = Vec::new();
    let mut slow_compile = Vec::new();
    let mut slow_packet = Vec::new();
    let mut slow_raster = Vec::new();
    let mut packet_bytes = 0usize;
    if mode == "all" || mode == "slow" {
        for repeat in 0..repeats {
            let mut slow = Engine::new();
            slow.load_document(&doc_json).unwrap();
            let _ = slow.compile_gpu(&options(view_w, view_h)).unwrap().into_packet().unwrap();
            let _ = slow.render_device_rect(&options(view_w, view_h), 0, 0, view_w, view_h).unwrap();
            for step in 0..steps {
                let x = 8. - 16. * (step + 1) as f64;
                let started = Instant::now();
                pose(&mut slow, x);
                let posed = Instant::now();
                let packet = slow.compile_gpu(&options(view_w, view_h)).unwrap().into_packet().unwrap();
                let compiled = Instant::now();
                packet_bytes = packet.len();
                // A same-process channel moves the Vec pointer. Cross-thread
                // publication of this scene copies the bytes; time that copy.
                let (tx, rx) = mpsc::channel::<Vec<u8>>();
                let reader = thread::spawn(move || {
                    let got = rx.recv().unwrap();
                    let sum = got.iter().fold(0u64, |acc, byte| acc + *byte as u64);
                    black_box(sum)
                });
                let sent = Instant::now();
                tx.send(packet.clone()).unwrap();
                black_box(reader.join().unwrap());
                let copied = Instant::now();
                let pixels = slow.render_device_rect(&options(view_w, view_h), 0, 0, view_w, view_h).unwrap();
                black_box(pixels.len());
                let done = Instant::now();
                if repeat + 1 == repeats {
                    slow_follow.push((done - started).as_secs_f64() * 1000.);
                    slow_compile.push((compiled - posed).as_secs_f64() * 1000.);
                    slow_packet.push((copied - sent).as_secs_f64() * 1000.);
                    slow_raster.push((done - copied).as_secs_f64() * 1000.);
                }
            }
        }
    }

    let mut retained_follow = Vec::new();
    if mode == "all" || mode == "retained" {
        for _ in 0..repeats {
            for step in 0..steps {
                let shift = -16 * (step as i32 + 1);
                let started = Instant::now();
                let frame = translate_board(&cache, wide, view_w, view_h, board, (shift, 0), background);
                black_box(frame.len());
                retained_follow.push((Instant::now() - started).as_secs_f64() * 1000.);
            }
        }
        retained_follow.truncate(steps);
    }

    let mut thread_report = None;
    if mode == "all" || mode == "threads" {
        let (tx, rx) = mpsc::sync_channel::<f64>(1);
        let (ready_tx, ready_rx) = mpsc::channel::<()>();
        let worker_doc = doc_json.clone();
        let worker = thread::spawn(move || {
            let mut engine = Engine::new();
            engine.load_document(&worker_doc).unwrap();
            let _ = engine.compile_gpu(&options(view_w, view_h)).unwrap();
            ready_tx.send(()).unwrap();
            let mut busy = 0.0;
            let mut accepted = 0usize;
            let mut bytes = 0usize;
            let started = Instant::now();
            while let Ok(x) = rx.recv() {
                let sample = Instant::now();
                pose(&mut engine, x);
                let packet = engine.compile_gpu(&options(view_w, view_h)).unwrap().into_packet().unwrap();
                bytes += packet.len();
                black_box(packet);
                busy += sample.elapsed().as_secs_f64();
                accepted += 1;
            }
            (busy, accepted, bytes, started.elapsed().as_secs_f64())
        });
        ready_rx.recv().unwrap();
        let mut follow = Vec::new();
        let mut queued = 0usize;
        let mut dropped = 0usize;
        let wall = Instant::now();
        for step in 0..steps * repeats.max(1) {
            let x = 8. - 16. * ((step % steps) + 1) as f64;
            let started = Instant::now();
            let frame = translate_board(&cache, wide, view_w, view_h, board, (-16 * ((step % steps) as i32 + 1), 0), background);
            black_box(frame.len());
            follow.push((Instant::now() - started).as_secs_f64() * 1000.);
            match tx.try_send(x) {
                Ok(()) => queued += 1,
                Err(mpsc::TrySendError::Full(_)) => dropped += 1,
                Err(mpsc::TrySendError::Disconnected(_)) => break,
            }
        }
        drop(tx);
        let present_wall = wall.elapsed().as_secs_f64();
        let (busy, accepted, bytes, worker_wall) = worker.join().unwrap();
        let mut follow_sorted = follow.clone();
        follow_sorted.sort_by(f64::total_cmp);
        thread_report = Some(json!({
            "presentSamples": follow.len(),
            "presentP50Ms": follow_sorted[follow_sorted.len() / 2],
            "presentMaxMs": follow_sorted.last().copied().unwrap_or(0.),
            "posesQueued": queued,
            "posesDroppedWhileWorkerBusy": dropped,
            "workerAccepted": accepted,
            "workerBusyS": busy,
            "workerWallS": worker_wall,
            "presentWallS": present_wall,
            "workerOccupancy": if worker_wall > 0. { busy / worker_wall } else { 0. },
            "packetBytesAccepted": bytes,
            "note": "Present does not wait for compile. The worker keeps one queued pose. Dropped poses are the samples a full redraw could not start."
        }));
    }

    let med = |values: &[f64]| {
        if values.is_empty() { return 0.; }
        let mut copy = values.to_vec();
        copy.sort_by(f64::total_cmp);
        copy[copy.len() / 2]
    };
    println!("{}", serde_json::to_string_pretty(&json!({
        "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "arch": std::env::consts::ARCH,
        "nodes": nodes + 1,
        "viewport": [view_w, view_h],
        "board": [420, 180],
        "mode": mode,
        "steps": steps,
        "repeats": repeats,
        "pixelsMatchFreshRender": pixels_match,
        "fractionalHalfPixelMatchesUnshifted": fractional_matches_unshifted,
        "fractionalHalfPixelMatchesNearestInteger": fractional_matches_nearest_integer,
        "previewSha256": hash(&preview),
        "freshSha256": hash(&fresh),
        "oneTimeWideRasterMs": fill_ms,
        "slowFollowP50Ms": med(&slow_follow),
        "slowCompileP50Ms": med(&slow_compile),
        "slowPacketHandoffP50Ms": med(&slow_packet),
        "slowRasterP50Ms": med(&slow_raster),
        "packetBytes": packet_bytes,
        "retainedFollowP50Ms": med(&retained_follow),
        "threads": thread_report,
        "scope": "Native CPU. No hardware WebGPU, Metal, Electron, or screen capture."
    })).unwrap());
}
