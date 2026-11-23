//! CPU measurement of vector, stroke, and boolean-group drags.
//!
//! This binary drives the production `Engine` interaction path: retained pose
//! when the kernel accepts it, otherwise the same full patch the render worker
//! uses, then `compile_gpu` and packet encoding. It does not open WebGPU,
//! Metal, or Electron. Those targets are NOT_RUN here.
//!
//! Stage counters are opt-in on this thread and do not change geometry.

use futureox_design_kernel::{
    Engine, curve_boolean, drag_profile, editing::DocumentPatch, math::Transform,
    renderer::RenderOptions, scene::{Document, Node, Stroke},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, env, time::Instant};

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn quantiles(mut samples: Vec<f64>) -> Value {
    samples.sort_by(f64::total_cmp);
    let at = |q: usize| samples[(samples.len() * q / 100).min(samples.len() - 1)];
    json!({
        "n": samples.len(),
        "min": samples[0],
        "p50": at(50),
        "p95": at(95),
        "max": samples[samples.len() - 1],
    })
}

fn cubic_fill(count: usize, origin_x: f64, origin_y: f64) -> Value {
    let mut fill = vec![json!({"move": [origin_x, origin_y]})];
    for index in 0..count {
        let x = origin_x + index as f64 * 6.0;
        let wobble = ((index % 5) as f64) * 3.25;
        fill.push(json!({"cubic": [x + 1.0, origin_y + 36.0, x + 4.5, origin_y - 22.0, x + 6.0, origin_y + wobble]}));
    }
    fill.push(json!("close"));
    json!({"fillRule": "nonzero", "fill": fill})
}

fn vector_node(id: &str, geometry: Value, x: f64, y: f64, stroke: bool) -> Value {
    let mut node = json!({
        "id": id,
        "kind": "vector",
        "name": id,
        "width": 320.0,
        "height": 80.0,
        "transform": [1.0, 0.0, 0.0, 1.0, x, y],
        "vectorGeometry": geometry,
        "fills": [{"kind": "solid", "color": "#3355aa"}],
    });
    if stroke {
        node["strokes"] = json!([{"width": 3.5, "cap": "round", "join": "round", "paint": {"kind": "solid", "color": "#112233"}}]);
        node["fills"] = json!([]);
    }
    node
}

fn rectangle(id: &str, x: f64, y: f64, w: f64, h: f64) -> Value {
    json!({
        "id": id, "kind": "rectangle", "name": id, "width": w, "height": h,
        "transform": [1.0, 0.0, 0.0, 1.0, x, y],
        "fills": [{"kind": "solid", "color": "#88aacc"}],
    })
}

fn document(nodes: Vec<Value>, roots: Vec<String>) -> Value {
    let mut map = serde_json::Map::new();
    for node in nodes {
        map.insert(node["id"].as_str().unwrap().to_owned(), node);
    }
    json!({
        "schemaVersion": 16,
        "id": "drag-profile",
        "name": "Vector drag profile",
        "rasterProfile": "analytic",
        "pages": [{"id": "p", "name": "Page", "children": roots, "background": "#ffffff"}],
        "nodes": map,
    })
}

fn options(profile: &str) -> RenderOptions {
    serde_json::from_value(json!({
        "pageId": "p",
        "width": 960,
        "height": 420,
        "view": {"x": 0.0, "y": 0.0, "zoom": 1.0},
        "grid": false,
        "transparent": false,
        "rasterProfile": profile,
    })).expect("render options")
}

fn moved_node(doc: &Value, id: &str, x: f64, y: f64) -> Result<Node, String> {
    let mut node = doc["nodes"][id].clone();
    node["transform"] = json!([1.0, 0.0, 0.0, 1.0, x, y]);
    serde_json::from_value(node).map_err(|error| error.to_string())
}

struct DragSummary {
    retained_frames: usize,
    patched_frames: usize,
    pose_ms: Vec<f64>,
    patch_ms: Vec<f64>,
    compile_ms: Vec<f64>,
    packet_ms: Vec<f64>,
    packet_bytes: usize,
    packet_sha256: String,
    stages: Value,
    stroke_stats: Value,
    fresh_packet_match: bool,
    fresh_rgba_match: Option<bool>,
}

fn drag(doc: &Value, id: &str, profile: &str, frames: usize, check_pixels: bool) -> Result<DragSummary, String> {
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).map_err(|error| error.to_string())?;
    let options = options(profile);
    engine.compile_gpu(&options).map_err(|error| error.to_string())?;
    drag_profile::reset();
    drag_profile::set_enabled(true);
    let mut pose_ms = Vec::new();
    let mut patch_ms = Vec::new();
    let mut compile_ms = Vec::new();
    let mut packet_ms = Vec::new();
    let mut retained_frames = 0;
    let mut patched_frames = 0;
    let mut last_packet = Vec::new();
    let mut last = (0.0, 0.0);
    for step in 1..=frames {
        let x = 24.0 + step as f64 * 0.5;
        let y = 30.0 + (step % 3) as f64 * 0.25;
        last = (x, y);
        let mut transforms = BTreeMap::new();
        transforms.insert(id.to_owned(), Transform([1.0, 0.0, 0.0, 1.0, x, y]));
        let started = Instant::now();
        let retained = engine.apply_interaction_transforms(&transforms).map_err(|error| error.to_string())?;
        pose_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        let patch_started = Instant::now();
        if retained {
            retained_frames += 1;
        } else {
            let patch = DocumentPatch {
                nodes: [(id.to_owned(), Some(moved_node(doc, id, x, y)?))].into(),
                fields: Default::default(),
            };
            engine.apply_document_patch_with_damage(&patch).map_err(|error| error.to_string())?;
            patched_frames += 1;
        }
        patch_ms.push(patch_started.elapsed().as_secs_f64() * 1000.0);
        let compile_started = Instant::now();
        let scene = engine.compile_gpu(&options).map_err(|error| error.to_string())?;
        compile_ms.push(compile_started.elapsed().as_secs_f64() * 1000.0);
        let packet_started = Instant::now();
        last_packet = scene.into_packet().map_err(|error| error.to_string())?;
        packet_ms.push(packet_started.elapsed().as_secs_f64() * 1000.0);
    }
    let stages = drag_profile::snapshot();
    let stroke_stats = engine.gpu_compile_cache_stats()["residentStrokes"].clone();
    drag_profile::set_enabled(false);
    let mut fresh_doc = doc.clone();
    fresh_doc["nodes"][id]["transform"] = json!([1.0, 0.0, 0.0, 1.0, last.0, last.1]);
    let mut fresh = Engine::new();
    fresh.load_document(&fresh_doc.to_string()).map_err(|error| error.to_string())?;
    let fresh_scene = fresh.compile_gpu(&options).map_err(|error| error.to_string())?;
    let fresh_packet = fresh_scene.into_packet().map_err(|error| error.to_string())?;
    let fresh_rgba_match = if check_pixels {
        let left = engine.render(&options).map_err(|error| error.to_string())?;
        let right = fresh.render(&options).map_err(|error| error.to_string())?;
        Some(left == right)
    } else {
        None
    };
    Ok(DragSummary {
        retained_frames,
        patched_frames,
        pose_ms,
        patch_ms,
        compile_ms,
        packet_ms,
        packet_bytes: last_packet.len(),
        packet_sha256: sha256(&last_packet),
        stages,
        stroke_stats,
        fresh_packet_match: last_packet == fresh_packet,
        fresh_rgba_match,
    })
}

fn summary_row(name: &str, profile: &str, result: DragSummary) -> Value {
    json!({
        "case": name,
        "rasterProfile": profile,
        "retainedFrames": result.retained_frames,
        "patchedFrames": result.patched_frames,
        "poseMs": quantiles(result.pose_ms),
        "patchMs": quantiles(result.patch_ms),
        "compileMs": quantiles(result.compile_ms),
        "packetMs": quantiles(result.packet_ms),
        "packetBytes": result.packet_bytes,
        "packetSha256": result.packet_sha256,
        "freshPacketMatch": result.fresh_packet_match,
        "freshCpuRgbaMatch": result.fresh_rgba_match,
        "stages": result.stages,
        "residentStrokes": result.stroke_stats,
    })
}

fn isolated_compute() -> Result<Value, String> {
    let geometry = cubic_fill(48, 0.0, 0.0);
    let node = vector_node("solo", geometry, 0.0, 0.0, true);
    let node: Node = serde_json::from_value(node).map_err(|error| error.to_string())?;
    let (fill, stroke_path) = node.paths().map_err(|error| error.to_string())?;
    let stroke: Stroke = serde_json::from_value(json!({
        "width": 3.5, "cap": "round", "join": "round",
        "paint": {"kind": "solid", "color": "#112233"}
    })).map_err(|error| error.to_string())?;
    let time = |body: &mut dyn FnMut()| {
        for _ in 0..3 { body(); }
        let mut samples = Vec::new();
        for _ in 0..11 {
            let started = Instant::now();
            body();
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        samples
    };
    let mut tight = Vec::new();
    let tight_ms = time(&mut || { tight = fill.flatten(Transform::default(), 0.0001220703125).unwrap(); });
    let mut coarse = Vec::new();
    let coarse_ms = time(&mut || { coarse = fill.flatten(Transform::default(), 0.015625).unwrap(); });
    let local = stroke_path.flatten(Transform::default(), 0.125).map_err(|error| error.to_string())?;
    let mut expanded = Vec::new();
    let expand_ms = time(&mut || { expanded = futureox_design_kernel::stroke::expand(&local, &stroke, 0.125, 0.0).unwrap(); });
    let points = |contours: &[futureox_design_kernel::path::Contour]| contours.iter().map(|c| c.points.len()).sum::<usize>();
    let mut boolean_doc = boolean_curve_document(12, false, 0);
    boolean_doc["nodes"]["a"]["transform"] = json!([1.0, 0.0, 0.0, 1.0, 1000.0, 1000.0]);
    boolean_doc["nodes"]["b"]["transform"] = json!([1.0, 0.0, 0.0, 1.0, 1036.0, 1012.0]);
    let mut cold: Document = serde_json::from_value(boolean_doc).map_err(|error| error.to_string())?;
    drag_profile::reset();
    drag_profile::set_enabled(true);
    let started = Instant::now();
    curve_boolean::resolve(&mut cold).map_err(|error| error.to_string())?;
    let cold_ms = started.elapsed().as_secs_f64() * 1000.0;
    let cold_stages = drag_profile::snapshot();
    drag_profile::reset();
    let started = Instant::now();
    curve_boolean::resolve(&mut cold).map_err(|error| error.to_string())?;
    let warm_ms = started.elapsed().as_secs_f64() * 1000.0;
    let warm_stages = drag_profile::snapshot();
    let mut miss_ms = Vec::new();
    drag_profile::reset();
    for step in 1..=6 {
        cold.nodes.get_mut("b").unwrap().transform.0[4] = 1036.0 + step as f64 * 3.0;
        let started = Instant::now();
        curve_boolean::resolve(&mut cold).map_err(|error| error.to_string())?;
        miss_ms.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    let miss_stages = drag_profile::snapshot();
    drag_profile::set_enabled(false);
    Ok(json!({
        "flattenTightMs": quantiles(tight_ms),
        "flattenTightPoints": points(&tight),
        "flattenCoarseMs": quantiles(coarse_ms),
        "flattenCoarsePoints": points(&coarse),
        "strokeExpandMs": quantiles(expand_ms),
        "strokeExpandPoints": points(&expanded),
        "booleanColdMs": cold_ms,
        "booleanColdStages": cold_stages,
        "booleanWarmMs": warm_ms,
        "booleanWarmStages": warm_stages,
        "booleanOperandMissMs": quantiles(miss_ms),
        "booleanOperandMissStages": miss_stages,
    }))
}

fn boolean_curve_document(cubics: usize, stroke_group: bool, fillers: usize) -> Value {
    let mut nodes = vec![
        vector_node("a", cubic_fill(cubics, 0.0, 0.0), 40.0, 40.0, false),
        vector_node("b", cubic_fill(cubics, 0.0, 0.0), 70.0, 52.0, false),
    ];
    let mut union = json!({
        "id": "union",
        "kind": "vector",
        "name": "union",
        "width": 360.0,
        "height": 120.0,
        "transform": [1.0, 0.0, 0.0, 1.0, 24.0, 30.0],
        "booleanOperation": "union",
        "children": ["a", "b"],
        "fills": [{"kind": "solid", "color": "#cc4466"}],
    });
    if stroke_group {
        union["strokes"] = json!([{"width": 2.5, "cap": "round", "join": "round", "paint": {"kind": "solid", "color": "#221100"}}]);
    }
    nodes.push(union);
    let mut roots = vec!["union".to_owned()];
    for index in 0..fillers {
        let id = format!("r{index}");
        let column = index % 12;
        let row = index / 12;
        nodes.push(rectangle(&id, 20.0 + column as f64 * 28.0, 180.0 + row as f64 * 22.0, 20.0, 14.0));
        roots.push(id);
    }
    document(nodes, roots)
}

fn vector_document(cubics: usize, stroke: bool) -> Value {
    document(vec![vector_node("path", cubic_fill(cubics, 0.0, 0.0), 24.0, 30.0, stroke)], vec!["path".into()])
}

fn rectangle_boolean_document() -> Value {
    let union = json!({
        "id": "union", "kind": "vector", "width": 180.0, "height": 80.0,
        "transform": [1.0, 0.0, 0.0, 1.0, 24.0, 30.0],
        "booleanOperation": "union", "children": ["a", "b"],
        "fills": [{"kind": "solid", "color": "#cc4466"}],
    });
    document(vec![rectangle("a", 0.0, 0.0, 90.0, 50.0), rectangle("b", 40.0, 16.0, 90.0, 50.0), union], vec!["union".into()])
}

fn run_case(name: &str, profile: &str, frames: usize, pixels: bool) -> Result<Value, String> {
    let (doc, id) = match name {
        "vector" => (vector_document(48, false), "path"),
        "stroke" => (vector_document(32, true), "path"),
        "boolean-rects" => (rectangle_boolean_document(), "union"),
        "boolean-curves" => (boolean_curve_document(16, false, 0), "union"),
        "boolean-stroked" => (boolean_curve_document(16, true, 0), "union"),
        "boolean-scene" => (boolean_curve_document(16, false, 36), "union"),
        "boolean-operand" => (boolean_curve_document(8, false, 0), "b"),
        other => return Err(format!("unknown case {other}")),
    };
    let result = drag(&doc, id, profile, frames, pixels)?;
    if !result.fresh_packet_match || result.fresh_rgba_match == Some(false) {
        return Err(format!("{name}/{profile} drifted from a fresh engine"));
    }
    Ok(summary_row(name, profile, result))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    let perf = args.iter().any(|arg| arg == "--perf");
    let case = args.iter().position(|arg| arg == "--case").and_then(|index| args.get(index + 1)).map(String::as_str).unwrap_or(if perf { "boolean-curves" } else { "all" });
    let profile = args.iter().position(|arg| arg == "--profile").and_then(|index| args.get(index + 1)).map(String::as_str).unwrap_or("figmaSubpixel");
    let frames: usize = args.iter().position(|arg| arg == "--frames").and_then(|index| args.get(index + 1)).and_then(|value| value.parse().ok()).unwrap_or(if perf { 1 } else { 8 });
    if perf {
        let row = run_case(case, profile, 2, true)?;
        let (sample_doc, sample_id) = match case {
            "vector" => (vector_document(48, false), "path"),
            "stroke" => (vector_document(32, true), "path"),
            "boolean-rects" => (rectangle_boolean_document(), "union"),
            "boolean-stroked" => (boolean_curve_document(16, true, 0), "union"),
            "boolean-scene" => (boolean_curve_document(16, false, 36), "union"),
            "boolean-operand" => (boolean_curve_document(8, false, 0), "b"),
            _ => (boolean_curve_document(16, false, 0), "union"),
        };
        drag_profile::set_enabled(true);
        drag_profile::reset();
        let started = Instant::now();
        let mut loops = 0usize;
        while started.elapsed().as_secs_f64() < 8.0 {
            let _ = drag(&sample_doc, sample_id, profile, frames.max(1), false)?;
            loops += 1;
        }
        let stages = drag_profile::snapshot();
        drag_profile::set_enabled(false);
        println!("{}", serde_json::to_string_pretty(&json!({
            "mode": "perf",
            "case": case,
            "rasterProfile": profile,
            "loops": loops,
            "wallMs": started.elapsed().as_secs_f64() * 1000.0,
            "check": row,
            "stages": stages,
            "gpu": "NOT_RUN",
            "hardwareWebGPU": "NOT_RUN",
            "metal": "NOT_RUN",
            "electron": "NOT_RUN",
            "swiftshader": "NOT_RUN",
        }))?);
        return Ok(());
    }
    let isolated = isolated_compute()?;
    let names: &[_] = if case == "all" {
        &["vector", "stroke", "boolean-rects", "boolean-curves", "boolean-stroked", "boolean-scene", "boolean-operand"]
    } else {
        &[case]
    };
    let mut rows = Vec::new();
    for name in names {
        let profiles: &[_] = if *name == "vector" { &["figmaSubpixel", "analytic"] } else { &[profile] };
        for profile in profiles {
            rows.push(run_case(name, profile, frames, true)?);
        }
    }
    println!("{}", serde_json::to_string_pretty(&json!({
        "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "optLevelNote": "Build profile is whatever Cargo used. desktop-dev is opt-level 1 and is not a production timing claim.",
        "arch": std::env::consts::ARCH,
        "os": std::env::consts::OS,
        "isolated": isolated,
        "drags": rows,
        "observation": "CPU production Engine only. hardware WebGPU, macOS, Metal, Electron, and official desktop FPS are NOT_RUN. SwiftShader was not used.",
    }))?);
    Ok(())
}
