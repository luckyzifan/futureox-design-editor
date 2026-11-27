//! Pose scene-packet cost: generated geometry versus bytes that cross a thread
//! boundary. This is a native CPU measurement of compile, encode, and a
//! two-thread pipe. It does not claim GUI, hardware GPU, or physical scanout.
//!
//! `POSE_PACKET_COUNT` sets ellipses per board (default 400). Four boards, one
//! clipped by the viewport. `POSE_PACKET_PROFILE=1` repeats the drag compile
//! so a sampler can see encode versus pipe copies.
use futureox_design_kernel::{Engine, math::Transform};
use serde_json::{Value, json};
use std::{
    env,
    hint::black_box,
    io::{Read, Write},
    os::unix::net::UnixStream,
    thread,
    time::Instant,
};

fn count() -> usize {
    env::var("POSE_PACKET_COUNT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(400)
        .clamp(4, 8000)
}

fn fixture(per_board: usize) -> (Value, Value) {
    let mut nodes = serde_json::Map::new();
    let mut boards = Vec::new();
    for board_index in 0..4 {
        let board = format!("board-{board_index}");
        boards.push(board.clone());
        let mut children = Vec::new();
        for index in 0..per_board {
            let id = format!("shape-{board_index}-{index}");
            children.push(id.clone());
            nodes.insert(
                id.clone(),
                json!({"id":id,"kind":"ellipse","width":28,"height":16,
                "transform":[1,0,0,1,(index%40)*36,(index/40)*32],
                "fills":[{"kind":"solid","color":"#2244bb"}],
                "strokes":[{"width":1.25,"paint":{"kind":"solid","color":"#102030"}}]}),
            );
        }
        nodes.insert(
            board.clone(),
            json!({"id":board,"kind":"frame","width":900,"height":700,"clip":true,
            "blend":"pass-through","transform":[1,0,0,1,board_index*760,40],"children":children}),
        );
    }
    let doc = json!({"schemaVersion":20,"id":"pose-packet","name":"pose-packet",
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":boards}],"nodes":nodes});
    // 80% zoom, viewport smaller than the dragged board, fractional camera.
    // Whole-frame compile. A gpuViewport is a tile crop and rejects anything
    // wider than one tile; the pose packet for this window is the full view.
    let options = json!({"pageId":"p","width":1440,"height":1030,"view":{"x":0.25,"y":0.125,"zoom":0.8},
        "rasterProfile":"figmaSubpixel"});
    (doc, options)
}

fn request(options: &Value, lz4: bool, curves: bool, ack: Option<u32>) -> String {
    let mut value = options.clone();
    let mut resources = json!({"scope":"pose-packet","ranges":[]});
    if lz4 {
        resources["sceneLz4"] = json!(true);
    }
    if curves {
        resources["curvePrograms"] = json!(true);
    }
    if let Some(end) = ack {
        resources["ranges"] = json!([[1, end]]);
    }
    value["frameResources"] = resources;
    value.to_string()
}

fn open_packet(packet: &[u8]) -> Vec<u8> {
    if packet.starts_with(b"FGSZ") {
        lz4_flex::decompress_size_prepended(&packet[8..]).expect("pose packet lz4")
    } else {
        packet.to_vec()
    }
}

fn word(packet: &[u8], at: usize) -> usize {
    u32::from_le_bytes(packet[at..at + 4].try_into().unwrap()) as usize
}

fn max_resource_id(packet: &[u8]) -> u32 {
    let packet = open_packet(packet);
    let mut at = (24 + word(&packet, 8) + 3) & !3;
    at += (word(&packet, 12) + word(&packet, 16)) * 4;
    let mut max = 0u32;
    while at < packet.len() {
        max = max.max(u32::from_le_bytes(packet[at..at + 4].try_into().unwrap()));
        at += 9 + word(&packet, at + 5);
    }
    max
}

fn pipe_ms(packet: &[u8]) -> f64 {
    let (mut writer, mut reader) = UnixStream::pair().unwrap();
    let n = packet.len();
    let reader = thread::spawn(move || {
        let mut buf = vec![0u8; n];
        reader.read_exact(&mut buf).unwrap();
        black_box(buf);
    });
    let started = Instant::now();
    writer.write_all(packet).unwrap();
    drop(writer);
    reader.join().unwrap();
    started.elapsed().as_secs_f64() * 1000.
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    values[values.len() / 2]
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let per_board = count();
    let (doc, options) = fixture(per_board);
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string())?;
    engine.bind_frame_scene_scope("pose-packet")?;
    let profile = env::var("POSE_PACKET_PROFILE").ok().as_deref() == Some("1");
    let mut pixel_options = options.clone();
    pixel_options["width"] = json!(160);
    pixel_options["height"] = json!(120);
    let parsed = engine.parse_options(pixel_options)?;
    let png_before = if profile {
        Vec::new()
    } else {
        engine.render_png(&parsed)?
    };

    let raw_started = Instant::now();
    let raw = engine.compile_gpu_packet_request(&request(&options, false, false, None))?;
    let raw_request_ms = raw_started.elapsed().as_secs_f64() * 1000.;
    let raw_stats = engine.gpu_compile_cache_stats()["frameScene"]["packet"].clone();
    let inline_lz4 = engine.compile_gpu_packet_request(&request(&options, true, false, None))?;
    let inline_stats = engine.gpu_compile_cache_stats()["frameScene"]["packet"].clone();
    assert_eq!(open_packet(&inline_lz4), raw);
    let curves = engine.compile_gpu_packet_request(&request(&options, true, true, None))?;
    let ack = max_resource_id(&curves);
    assert!(engine.apply_interaction_transforms(
        &[("board-0".into(), Transform([1., 0., 0., 1., 2.4, 40.35]))].into()
    )?);
    let png_hold = if profile {
        Vec::new()
    } else {
        engine.render_png(&parsed)?
    };
    if !profile {
        assert_ne!(png_hold, png_before);
    }
    let release = engine.compile_gpu_packet_request(&request(&options, true, false, None))?;
    let release_stats = engine.gpu_compile_cache_stats()["frameScene"]["packet"].clone();
    let posed = engine.compile_gpu_packet_request(&request(&options, false, false, None))?;
    assert_eq!(
        open_packet(&release),
        posed,
        "release compression is lossless"
    );
    let dragged = engine.compile_gpu_packet_request(&request(&options, true, true, Some(ack)))?;
    let drag_stats = engine.gpu_compile_cache_stats()["frameScene"]["packet"].clone();
    assert!(engine.apply_interaction_transforms(
        &[("board-0".into(), Transform([1., 0., 0., 1., 0., 40.]))].into()
    )?);
    if !profile {
        assert_eq!(engine.render_png(&parsed)?, png_before);
    }

    // Warm the pipe, then take the median. The reader thread is the stand-in
    // for the host copying the stdout body into an owned buffer.
    let _ = pipe_ms(&raw);
    let _ = pipe_ms(&dragged);
    let raw_pipe = median((0..5).map(|_| pipe_ms(&raw)).collect());
    let drag_pipe = median((0..5).map(|_| pipe_ms(&dragged)).collect());
    let release_pipe = median((0..5).map(|_| pipe_ms(&release)).collect());
    let started = Instant::now();
    black_box(raw.to_vec());
    let raw_clone_ms = started.elapsed().as_secs_f64() * 1000.;

    let repeats = if env::var("POSE_PACKET_PROFILE").ok().as_deref() == Some("1") {
        24
    } else {
        7
    };
    let mut drag_ms = Vec::new();
    let mut drag_compile = Vec::new();
    let mut drag_encode = Vec::new();
    for step in 0..repeats {
        let y = 40. + (step as f64) * 0.35;
        assert!(engine.apply_interaction_transforms(
            &[("board-0".into(), Transform([1., 0., 0., 1., 2.4, y]))].into()
        )?);
        let started = Instant::now();
        let packet =
            engine.compile_gpu_packet_request(&request(&options, true, true, Some(ack)))?;
        drag_ms.push(started.elapsed().as_secs_f64() * 1000.);
        let sample = engine.gpu_compile_cache_stats()["frameScene"]["packet"].clone();
        drag_compile.push(sample["compileMs"].as_f64().unwrap_or(0.));
        drag_encode.push(sample["encodeMs"].as_f64().unwrap_or(0.));
        black_box(packet);
    }
    drag_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let report = json!({
        "perBoard": per_board,
        "nodes": per_board * 4 + 4,
        "rawBytes": raw.len(),
        "rawRequestMs": raw_request_ms,
        "rawCompileMs": raw_stats["compileMs"],
        "rawEncodeMs": raw_stats["encodeMs"],
        "inlineLz4Bytes": inline_lz4.len(),
        "inlineCompileMs": inline_stats["compileMs"],
        "inlineEncodeMs": inline_stats["encodeMs"],
        "curveBytes": curves.len(),
        "releaseBytes": release.len(),
        "releaseCompileMs": release_stats["compileMs"],
        "releaseEncodeMs": release_stats["encodeMs"],
        "releaseSceneBytes": release_stats["sceneBytes"],
        "ackedDragBytes": dragged.len(),
        "generatedGeometryBytes": drag_stats["geometryBytes"],
        "wireGeometryBytes": drag_stats["wireGeometryBytes"],
        "vertexBytes": drag_stats["vertexBytes"],
        "dragCurveResourceBytes": drag_stats["curveResourceBytes"],
        "dragNodeResourceBytes": drag_stats["nodeResourceBytes"],
        "dragImageResourceBytes": drag_stats["imageResourceBytes"],
        "dragPlanResourceBytes": drag_stats["planResourceBytes"],
        "dragResourceBytes": drag_stats["resourceBytes"],
        "curveOmittedBytes": drag_stats["curveOmittedBytes"],
        "dragCompileMs": drag_stats["compileMs"],
        "dragEncodeMs": drag_stats["encodeMs"],
        "dragStageCompileMedianMs": median(drag_compile),
        "dragStageEncodeMedianMs": median(drag_encode),
        "dragSceneBytes": drag_stats["sceneBytes"],
        "rawPipeMs": raw_pipe,
        "releasePipeMs": release_pipe,
        "ackedDragPipeMs": drag_pipe,
        "rawSameThreadCopyMs": raw_clone_ms,
        "dragCompileMedianMs": drag_ms[drag_ms.len() / 2],
        "pngHoldDiffers": !profile && png_hold != png_before,
        "pngUndoMatches": !profile,
    });
    println!("{report}");
    if env::var("POSE_PACKET_DUMP").ok().as_deref() == Some("1") {
        std::fs::write("/tmp/pose-raw.bin", &raw)?;
        std::fs::write("/tmp/pose-lz4.bin", &inline_lz4)?;
    }
    Ok(())
}
