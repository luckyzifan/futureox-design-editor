//! 80% clipped-board short drag and release-to-exact compile path.
//!
//! Timings are this process only: last input, CPU compile completion, and a
//! same-thread packet. They are not Electron present ACKs, Metal, or a
//! display scanout. Packet bytes are checked against a fresh engine.
use futureox_design_kernel::{render_cancellation::with_probe, Engine, math::Transform};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    hint::black_box,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const ZOOM: f64 = 0.8;
const VIEW_W: u32 = 922;
const VIEW_H: u32 = 640;

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Four top-level clipped boards. The dragged board is wider than the 80%
/// camera, so the viewport clips it. Children are rectangles plus a few curves.
fn fixture() -> Value {
    let mut nodes = serde_json::Map::new();
    let mut page_children = Vec::new();
    for board in 0..4 {
        let id = format!("board-{board}");
        page_children.push(id.clone());
        let mut children = Vec::new();
        let origin_x = board as f64 * 1600.;
        if board == 0 {
            for row in 0..32 {
                for col in 0..28 {
                    let child = format!("cell-{row:02}-{col:02}");
                    children.push(child.clone());
                    let kind = if (row + col) % 17 == 0 { "vector" } else { "rectangle" };
                    let mut node = json!({
                        "id": child,
                        "kind": kind,
                        "width": 36,
                        "height": 22,
                        "transform": [1, 0, 0, 1, 16. + col as f64 * 48., 28. + row as f64 * 30.],
                        "fills": [{"kind": "solid", "color": "#dbe8ef"}],
                        "strokes": [{"width": 1, "paint": {"kind": "solid", "color": "#5d6b75"}}]
                    });
                    if kind == "vector" {
                        node["vectorGeometry"] = json!({
                            "fillRule": "nonzero",
                            "fill": [{"move": [0, 0]}, {"line": [36, 4]}, {"line": [28, 22]}, {"line": [2, 16]}, "close"]
                        });
                    }
                    nodes.insert(child, node);
                }
            }
        }
        nodes.insert(id.clone(), json!({
            "id": id,
            "kind": "frame",
            "name": format!("Board {board}"),
            "width": 1440,
            "height": 1030,
            "clip": true,
            "transform": [1, 0, 0, 1, origin_x, 0],
            "fills": [{"kind": "solid", "color": "#dbe8ef"}],
            "children": children
        }));
    }
    json!({
        "schemaVersion": 16,
        "id": "clipped-board",
        "name": "Clipped board drag",
        "colorManagement": {"documentSpace": "srgb", "referenceWhiteNits": 203, "peakLuminanceNits": 1000},
        "pages": [{"id": "p", "name": "Page", "children": page_children, "background": "#ffffff"}],
        "nodes": nodes
    })
}

fn request() -> String {
    // 922 / 0.8 = 1152 world px across a 1440 board: the right side is clipped.
    json!({
        "pageId": "p",
        "width": VIEW_W,
        "height": VIEW_H,
        "view": {"x": 0.25, "y": 0.25, "zoom": ZOOM},
        "rasterProfile": "figma"
    })
    .to_string()
}

fn pose(x: f64, y: f64) -> std::collections::BTreeMap<String, Transform> {
    [("board-0".into(), Transform([1., 0., 0., 1., x, y]))].into()
}

fn compile(engine: &mut Engine, options: &str) -> Result<Vec<u8>, String> {
    engine.compile_gpu_request(options)?.into_packet()
}

fn percentile(samples: &mut [f64], p: usize) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[(samples.len() * p / 100).min(samples.len() - 1)]
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let document = fixture();
    let document_json = document.to_string();
    let nodes = document["nodes"].as_object().unwrap().len();
    let options = request();
    let mut engine = Engine::new();
    engine.load_document(&document_json)?;
    let cold_at = Instant::now();
    let cold = compile(&mut engine, &options)?;
    let cold_ms = cold_at.elapsed().as_secs_f64() * 1000.;
    let checkpoints = Arc::new(AtomicUsize::new(0));
    with_probe(
        {
            let checkpoints = checkpoints.clone();
            move || {
                checkpoints.fetch_add(1, Ordering::Relaxed);
                false
            }
        },
        || compile(&mut engine, &options),
    )?;

    // Short drag: eight absolute poses, then a fractional release pose.
    let mut drag = Vec::new();
    for step in 1..=8 {
        let x = step as f64 * 3.125;
        let y = step as f64 * 1.5;
        let input_at = Instant::now();
        let accepted = engine.apply_interaction_transforms(&pose(x, y))?;
        let input_ms = input_at.elapsed().as_secs_f64() * 1000.;
        let compile_at = Instant::now();
        let packet = compile(&mut engine, &options)?;
        let compile_ms = compile_at.elapsed().as_secs_f64() * 1000.;
        drag.push(json!({
            "step": step,
            "accepted": accepted,
            "lastInputMs": input_ms,
            "compileCompleteMs": compile_ms,
            "packetBytes": packet.len(),
            "cache": engine.gpu_compile_cache_stats(),
        }));
        black_box(packet);
    }

    // Product path today finishes the in-flight absolute pose, then compiles
    // the distinct release pose. Measure that pair before the cancel path.
    let held = pose(28., 14.);
    let release = pose(28.5, 14.25);
    let held_input_at = Instant::now();
    assert!(engine.apply_interaction_transforms(&held)?);
    let held_input_ms = held_input_at.elapsed().as_secs_f64() * 1000.;
    let held_compile_at = Instant::now();
    let held_packet = compile(&mut engine, &options)?;
    let held_compile_ms = held_compile_at.elapsed().as_secs_f64() * 1000.;
    let finish_input_at = Instant::now();
    assert!(engine.apply_interaction_transforms(&release)?);
    let finish_input_ms = finish_input_at.elapsed().as_secs_f64() * 1000.;
    let finish_compile_at = Instant::now();
    let finished_terminal = compile(&mut engine, &options)?;
    let finish_compile_ms = finish_compile_at.elapsed().as_secs_f64() * 1000.;
    black_box((held_packet, &finished_terminal));

    // Release while the next absolute-move compile is in flight. The flag is
    // the other thread's view of pointer-up; compile notices it at a checkpoint.
    assert!(engine.apply_interaction_transforms(&held)?);
    let cancel_at = Arc::new(Mutex::new(None));
    let flag = Arc::new(AtomicBool::new(false));
    let armed = Arc::new(AtomicBool::new(false));
    let seen = Arc::new(AtomicUsize::new(0));
    let worker_flag = flag.clone();
    let worker_at = cancel_at.clone();
    let worker_armed = armed.clone();
    let watcher = thread::spawn(move || {
        while !worker_armed.load(Ordering::Acquire) {
            thread::yield_now();
        }
        thread::sleep(Duration::from_millis(5));
        *worker_at.lock().unwrap() = Some(Instant::now());
        worker_flag.store(true, Ordering::Release);
    });
    let obsolete_at = Instant::now();
    armed.store(true, Ordering::Release);
    let obsolete = with_probe(
        {
            let flag = flag.clone();
            let seen = seen.clone();
            move || {
                seen.fetch_add(1, Ordering::Relaxed);
                flag.load(Ordering::Acquire)
            }
        },
        || compile(&mut engine, &options),
    );
    let obsolete_ms = obsolete_at.elapsed().as_secs_f64() * 1000.;
    watcher.join().unwrap();
    let abort_ms = cancel_at
        .lock()
        .unwrap()
        .map(|at| at.elapsed().as_secs_f64() * 1000.);
    let cancelled = match &obsolete {
        Err(error) => error.contains("PREVIEW_CANCELLED") || error.contains("cancelled"),
        Ok(_) => false,
    };

    let input_at = Instant::now();
    let accepted = engine.apply_interaction_transforms(&release)?;
    let input_ms = input_at.elapsed().as_secs_f64() * 1000.;
    let compile_at = Instant::now();
    let terminal = compile(&mut engine, &options)?;
    let terminal_ms = compile_at.elapsed().as_secs_f64() * 1000.;
    let release_cpu_ms = input_ms + terminal_ms + if cancelled { abort_ms.unwrap_or(obsolete_ms) } else { 0. };

    let mut fresh = Engine::new();
    let mut released = document;
    released["nodes"]["board-0"]["transform"] = json!([1, 0, 0, 1, 28.5, 14.25]);
    fresh.load_document(&released.to_string())?;
    let oracle = compile(&mut fresh, &options)?;
    let packets_match = terminal == oracle;

    // Queue handoff versus compile occupancy. Capacity 1 matches design-prepare:
    // the reader blocks while the compute thread owns the in-flight request.
    let (sender, receiver) = mpsc::sync_channel::<Instant>(1);
    sender.send(Instant::now()).unwrap();
    let reader_blocked = Arc::new(Mutex::new(0.));
    let blocked = reader_blocked.clone();
    let reader = thread::spawn(move || {
        let want = Instant::now();
        sender.send(want).unwrap();
        *blocked.lock().unwrap() = want.elapsed().as_secs_f64() * 1000.;
    });
    let occupied_at = Instant::now();
    let occupied = compile(&mut engine, &options)?;
    let occupied_ms = occupied_at.elapsed().as_secs_f64() * 1000.;
    let queued_at = receiver.recv().unwrap();
    let after_compile_handoff_ms = queued_at.elapsed().as_secs_f64() * 1000.;
    let _ = receiver.recv().unwrap();
    reader.join().unwrap();
    black_box(occupied);

    // Empty same-thread versus cross-thread delivery, without compile work.
    let same_thread_at = Instant::now();
    let (direct_tx, direct_rx) = mpsc::sync_channel::<u32>(1);
    direct_tx.send(1).unwrap();
    assert_eq!(direct_rx.recv().unwrap(), 1);
    let same_thread_handoff_us = same_thread_at.elapsed().as_secs_f64() * 1e6;
    let cross_at = Instant::now();
    let (cross_tx, cross_rx) = mpsc::sync_channel::<u32>(1);
    let cross = thread::spawn(move || cross_tx.send(1).unwrap());
    assert_eq!(cross_rx.recv().unwrap(), 1);
    cross.join().unwrap();
    let cross_thread_handoff_us = cross_at.elapsed().as_secs_f64() * 1e6;

    let mut compile_samples: Vec<f64> = drag
        .iter()
        .filter_map(|row| row["compileCompleteMs"].as_f64())
        .collect();
    let report = json!({
        "profile": if cfg!(debug_assertions) { "debug" } else { "optimized" },
        "arch": std::env::consts::ARCH,
        "nodes": nodes,
        "zoom": ZOOM,
        "viewport": [VIEW_W, VIEW_H],
        "visibleWorld": [VIEW_W as f64 / ZOOM, VIEW_H as f64 / ZOOM],
        "board": [1440, 1030],
        "clipped": true,
        "fixtureSha256": hash(document_json.as_bytes()),
        "coldCompileMs": cold_ms,
        "coldPacketBytes": cold.len(),
        "warmCheckpoints": checkpoints.load(Ordering::Relaxed),
        "drag": drag,
        "dragCompileP50Ms": percentile(&mut compile_samples, 50),
        "release": {
            "finishObsoleteCompileMs": held_compile_ms,
            "finishObsoleteInputMs": held_input_ms,
            "finishTerminalInputMs": finish_input_ms,
            "finishTerminalCompileMs": finish_compile_ms,
            "finishThenTerminalMs": held_compile_ms + finish_input_ms + finish_compile_ms,
            "obsoleteCompileMs": obsolete_ms,
            "obsoleteCancelled": cancelled,
            "obsoleteError": obsolete.as_ref().err().map(|e| e.clone()),
            "checkpointsUntilReturn": seen.load(Ordering::Relaxed),
            "abortAfterFlagMs": abort_ms,
            "terminalInputMs": input_ms,
            "terminalCompileMs": terminal_ms,
            "terminalAccepted": accepted,
            "cpuReleaseMs": release_cpu_ms,
            "packetsMatchFreshEngine": packets_match,
            "terminalPacketSha256": hash(&terminal),
            "terminalPacketBytes": terminal.len(),
        },
        "threading": {
            "compileOccupiedMs": occupied_ms,
            "readerBlockedMs": *reader_blocked.lock().unwrap(),
            "handoffAfterCompileMs": after_compile_handoff_ms,
            "emptySameThreadHandoffUs": same_thread_handoff_us,
            "emptyCrossThreadHandoffUs": cross_thread_handoff_us,
            "note": "readerBlockedMs is time the capacity-1 sender waits while compile occupies the compute thread. It is queue wait, not GPU time.",
        },
        "present": "NOT_RUN",
        "hardwareWebGPU": "NOT_RUN",
        "scope": "Native CPU compile of the clipped absolute-move path. No GPU submit, present ACK, or scanout.",
    });
    if !packets_match {
        return Err("terminal packet diverged from a fresh engine".into());
    }
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
