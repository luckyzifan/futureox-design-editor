//! Drag-pose cost for a shape image fill, an axis-aligned cropped fill, a
//! shape-masked image, and a rotated image fill.
//!
//! This is the native half of a live pointer pose: `apply_interaction_transforms`
//! (or the validated patch fallback), then `compile_gpu_packet_request` with the
//! same frame-resource acknowledgement the GPU worker sends after the first
//! packet. The sampling-field phase is the WASM coordinate upload that
//! `imageGrid` rebuilds when the device matrix changes. CPU `render_device_rect`
//! is the software raster, not an official WebGPU/Metal/Electron frame.
//!
//! `IMAGE_FILL_DRAG_CASE` selects one fixture. `IMAGE_FILL_DRAG_PHASE=packet|field|raster`
//! keeps a profiler on one stage. Hardware WebGPU, macOS, Metal and Electron
//! are not measured here.

use base64::Engine as Base64Engine;
use futureox_design_kernel::{
    editing::DocumentPatch,
    gpu::GpuScene,
    math::{Rect, Transform},
    paint::{image_sampling_axes_placed, image_sampling_grid_placed},
    renderer::{Engine, RenderOptions},
    scene::{Node, Paint},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, env, hint::black_box, time::Instant};

const SHAPE_W: f64 = 640.;
const SHAPE_H: f64 = 420.;
const IMAGE_W: u32 = 768;
const IMAGE_H: u32 = 512;
const VIEW_W: u32 = 800;
const VIEW_H: u32 = 560;

fn main() {
    let case = env::var("IMAGE_FILL_DRAG_CASE").unwrap_or_else(|_| "all".into());
    let phase = env::var("IMAGE_FILL_DRAG_PHASE").unwrap_or_else(|_| "report".into());
    let steps: usize = env::var("IMAGE_FILL_DRAG_STEPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(12);
    let names: &[&str] = if case == "all" {
        &["solid", "image-fill", "cropped", "masked", "rotated-image"]
    } else {
        &[]
    };
    let selected: Vec<&str> = if case == "all" {
        names.to_vec()
    } else {
        vec![case.as_str()]
    };
    let mut rows = Vec::new();
    for name in selected {
        rows.push(run_case(name, &phase, steps));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "arch": std::env::consts::ARCH,
            "rasterProfile": "figmaSubpixel",
            "shape": [SHAPE_W, SHAPE_H],
            "image": [IMAGE_W, IMAGE_H],
            "viewport": [VIEW_W, VIEW_H],
            "steps": steps,
            "phase": phase,
            "hardwareWebgpu": "NOT_RUN",
            "macosMetalElectron": "NOT_RUN",
            "rows": rows,
        }))
        .unwrap()
    );
}

fn run_case(name: &str, phase: &str, steps: usize) -> Value {
    let uri = if name == "solid" {
        None
    } else {
        Some(image_uri(IMAGE_W, IMAGE_H))
    };
    let fixture = fixture(name, uri.as_deref());
    let mut row = json!({"case": name, "moving": fixture.moving, "imagePngBytes": uri.as_ref().map(|u| png_bytes(u)).unwrap_or(0)});
    if phase == "report" || phase == "packet" {
        let packet = packet_phase(&fixture, steps);
        row["packet"] = packet;
    }
    if phase == "report" || phase == "field" {
        row["field"] = field_phase(&fixture, steps);
    }
    if phase == "report" || phase == "raster" {
        row["cpuRaster"] = raster_phase(&fixture);
    }
    row
}

struct Fixture {
    moving: String,
    node: Node,
    base: [f64; 6],
    paint: Paint,
    image: [u32; 2],
    document: String,
}

fn fixture(name: &str, uri: Option<&str>) -> Fixture {
    let paint = match name {
        "solid" => json!({"kind": "solid", "color": "#c4553a"}),
        "cropped" => {
            json!({"kind": "image", "color": "#ffffff", "fit": "stretch", "image": uri.unwrap(),
            "transform": [2.0, 0.0, 0.0, 2.0, -0.45, -0.3]})
        }
        "rotated-image" | "image-fill" | "masked" => {
            json!({"kind": "image", "color": "#ffffff", "fit": "stretch", "image": uri.unwrap()})
        }
        other => panic!("unknown case {other}"),
    };
    let (origin_x, origin_y, linear) = if name == "rotated-image" {
        let (c, s) = (8f64.to_radians().cos(), 8f64.to_radians().sin());
        let (cx, cy) = (400., 280.);
        let tx = cx - (c * SHAPE_W / 2. - s * SHAPE_H / 2.);
        let ty = cy - (s * SHAPE_W / 2. + c * SHAPE_H / 2.);
        (tx, ty, [c, s, -s, c])
    } else if name == "masked" {
        (40., 20., [1., 0., 0., 1.])
    } else {
        (48., 36., [1., 0., 0., 1.])
    };
    let moving = json!({"id": "mover", "kind": "rectangle", "name": "Image fill", "width": SHAPE_W, "height": SHAPE_H,
        "transform": [linear[0], linear[1], linear[2], linear[3], origin_x, origin_y], "fills": [paint.clone()]});
    let document = if name == "masked" {
        json!({"schemaVersion": 5, "id": "drag", "name": name,
        "pages": [{"id": "p", "name": "p", "background": "#f7f4ee", "children": ["board"]}],
        "nodes": {
            "board": {"id": "board", "kind": "frame", "name": "Board", "width": 760, "height": 520, "clip": true,
                "fills": [{"kind": "solid", "color": "#efe8dc"}], "children": ["caption", "group"]},
            "caption": {"id": "caption", "kind": "rectangle", "width": 120, "height": 18, "transform": [1, 0, 0, 1, 16, 12],
                "fills": [{"kind": "solid", "color": "#203040"}]},
            "group": {"id": "group", "kind": "group", "name": "Mask group", "width": 700, "height": 480,
                "transform": [1, 0, 0, 1, 20, 16], "children": ["mask", "mover"]},
            "mask": {"id": "mask", "kind": "rectangle", "name": "Mask", "width": 280, "height": 180,
                "transform": [1, 0, 0, 1, 80, 70], "mask": true, "maskType": "shape",
                "fills": [{"kind": "solid", "color": "#000000"}]},
            "mover": moving
        }})
    } else {
        json!({"schemaVersion": 5, "id": "drag", "name": name,
        "pages": [{"id": "p", "name": "p", "background": "#f7f4ee", "children": ["board"]}],
        "nodes": {
            "board": {"id": "board", "kind": "frame", "name": "Board", "width": 760, "height": 520, "clip": true,
                "fills": [{"kind": "solid", "color": "#efe8dc"}], "children": ["caption", "chip", "mover"]},
            "caption": {"id": "caption", "kind": "rectangle", "width": 120, "height": 18, "transform": [1, 0, 0, 1, 16, 12],
                "fills": [{"kind": "solid", "color": "#203040"}]},
            "chip": {"id": "chip", "kind": "rectangle", "width": 36, "height": 36, "transform": [1, 0, 0, 1, 700, 460],
                "fills": [{"kind": "solid", "color": "#2f6f4e"}]},
            "mover": moving
        }})
    };
    let document = document.to_string();
    let node: Node = serde_json::from_str(&serde_json::to_string(&moving).unwrap()).unwrap();
    Fixture {
        base: node.transform.0,
        moving: "mover".into(),
        node,
        paint: serde_json::from_value(paint).unwrap(),
        image: if name == "solid" {
            [1, 1]
        } else {
            [IMAGE_W, IMAGE_H]
        },
        document,
    }
}

fn packet_phase(fixture: &Fixture, steps: usize) -> Value {
    let mut engine = Engine::new();
    engine.load_document(&fixture.document).expect("load");
    engine
        .bind_frame_scene_scope("image-fill-drag")
        .expect("scope");
    let options = options_json();
    let mut request: Value = serde_json::from_str(&options).unwrap();
    // The loaded document is the pointer-down pose. Its first packet still
    // carries the image resource; later poses acknowledge that resource.
    let first_at = Instant::now();
    let first = engine
        .compile_gpu_packet_request(&request.to_string())
        .expect("first packet");
    let first_ms = elapsed_ms(first_at);
    let first_parts = packet_parts_json(&first);
    request["frameResources"] = json!({"scope": "image-fill-drag", "ranges": [[1, u32::MAX]]});
    let acked = request.to_string();
    let mut apply_ms = Vec::new();
    let mut packet_ms = Vec::new();
    let mut payloads = Vec::new();
    let mut totals = Vec::new();
    let mut retained = 0usize;
    let mut patched = 0usize;
    for step in 1..=steps {
        let apply_at = Instant::now();
        let kind = pose(&mut engine, fixture, step).expect("pose");
        apply_ms.push(elapsed_ms(apply_at));
        match kind {
            PoseKind::Retained => retained += 1,
            PoseKind::Patched => patched += 1,
        }
        let packet_at = Instant::now();
        let bytes = engine
            .compile_gpu_packet_request(&acked)
            .expect("acked packet");
        packet_ms.push(elapsed_ms(packet_at));
        let parts = packet_parts(&bytes);
        payloads.push(parts.payload);
        totals.push(parts.total);
        black_box(bytes);
    }
    let stats = engine.gpu_compile_cache_stats();
    json!({
        "firstPacketMs": first_ms,
        "firstPacket": first_parts,
        "apply": summary(&apply_ms),
        "steadyPacket": summary(&packet_ms),
        "steadyPayloadBytes": summary_u64(&payloads),
        "steadyTotalBytes": summary_u64(&totals),
        "retainedPoses": retained,
        "patchedPoses": patched,
        "frameScene": stats.get("frameScene").cloned().unwrap_or(Value::Null),
    })
}

fn field_phase(fixture: &Fixture, steps: usize) -> Value {
    let mut engine = Engine::new();
    engine.load_document(&fixture.document).expect("load");
    let options: RenderOptions = serde_json::from_str(&options_json()).unwrap();
    for _ in 0..2 {
        pose(&mut engine, fixture, 0).expect("warm pose");
        black_box(engine.compile_gpu(&options).expect("warm compile"));
    }
    let mut compile_ms = Vec::new();
    let mut field_ms = Vec::new();
    let mut field_bytes = Vec::new();
    let mut kinds = Vec::new();
    let mut rects = Vec::new();
    for step in 1..=steps {
        pose(&mut engine, fixture, step).expect("pose");
        let compile_at = Instant::now();
        let scene = engine.compile_gpu(&options).expect("compile");
        compile_ms.push(elapsed_ms(compile_at));
        let node = moving_node(&scene, &fixture.moving);
        rects.push(json!([node.rect.x, node.rect.y, node.rect.w, node.rect.h]));
        if fixture.paint.kind != "image" {
            kinds.push("solid");
            field_ms.push(0.);
            field_bytes.push(0);
            continue;
        }
        let field_at = Instant::now();
        let built = build_field(node.rect, node.matrix, node.size, fixture);
        field_ms.push(elapsed_ms(field_at));
        field_bytes.push(built.bytes);
        kinds.push(built.kind);
        black_box(field_checksum(&built.values));
    }
    json!({
        "compile": summary(&compile_ms),
        "field": summary(&field_ms),
        "fieldBytes": summary_u64(&field_bytes),
        "fieldKind": kinds.first().copied().unwrap_or("none"),
        "rect": rects.first().cloned().unwrap_or(Value::Null),
        "rectChanges": rects.windows(2).filter(|w| w[0] != w[1]).count(),
    })
}

fn raster_phase(fixture: &Fixture) -> Value {
    let mut engine = Engine::new();
    engine.load_document(&fixture.document).expect("load");
    let options: RenderOptions = serde_json::from_str(&options_json()).unwrap();
    pose(&mut engine, fixture, 4).expect("pose");
    for _ in 0..1 {
        black_box(
            engine
                .render_device_rect(&options, 0, 0, VIEW_W, VIEW_H)
                .expect("warm raster"),
        );
    }
    let mut times = Vec::new();
    let mut pixels = Vec::new();
    for _ in 0..3 {
        let at = Instant::now();
        pixels = engine
            .render_device_rect(&options, 0, 0, VIEW_W, VIEW_H)
            .expect("raster");
        times.push(elapsed_ms(at));
    }
    let digest = Sha256::digest(&pixels);
    json!({
        "samples": summary(&times),
        "bytes": pixels.len(),
        "sha256": hex(&digest),
        "backend": "cpu-figmaSubpixel",
        "officialWebgpu": "NOT_RUN",
    })
}

struct FieldBuild {
    kind: &'static str,
    bytes: u64,
    values: Vec<f32>,
}

fn build_field(rect: Rect, matrix: Transform, size: [f64; 2], fixture: &Fixture) -> FieldBuild {
    let axes = image_sampling_axes_placed(
        rect,
        matrix,
        size,
        fixture.image,
        &fixture.paint,
        None,
        0,
        [0, 0],
    )
    .expect("axes");
    let (kind, values) = if axes.is_empty() {
        (
            "dense-grid",
            image_sampling_grid_placed(
                rect,
                matrix,
                size,
                fixture.image,
                &fixture.paint,
                None,
                0,
                [0, 0],
            )
            .expect("grid"),
        )
    } else {
        ("compact-axes", axes)
    };
    let bytes = values.len() as u64 * 4;
    FieldBuild {
        kind,
        bytes,
        values,
    }
}

fn field_checksum(values: &[f32]) -> u64 {
    let mut checksum = 0u64;
    for (i, value) in values.iter().enumerate() {
        checksum ^= value.to_bits() as u64;
        checksum = checksum
            .wrapping_mul(0x9E3779B185EBCA87)
            .wrapping_add(i as u64);
    }
    checksum
}

fn moving_node<'a>(scene: &'a GpuScene, id: &str) -> &'a futureox_design_kernel::gpu::GpuNode {
    scene.nodes.get(id).unwrap_or_else(|| {
        scene
            .nodes
            .values()
            .find(|node| node.id == id)
            .expect("moving node in compiled scene")
    })
}

enum PoseKind {
    Retained,
    Patched,
}

fn pose(engine: &mut Engine, fixture: &Fixture, step: usize) -> Result<PoseKind, String> {
    let dx = step as f64 * 2.35;
    let dy = step as f64 * 1.15;
    let mut linear = fixture.base;
    linear[4] += dx;
    linear[5] += dy;
    let next = Transform(linear);
    let map = BTreeMap::from([(fixture.moving.clone(), next)]);
    if engine.apply_interaction_transforms(&map)? {
        return Ok(PoseKind::Retained);
    }
    let mut node = fixture.node.clone();
    node.transform = next;
    let patch = DocumentPatch {
        nodes: BTreeMap::from([(fixture.moving.clone(), Some(node))]),
        fields: BTreeMap::new(),
    };
    engine.apply_document_patch(&patch)?;
    Ok(PoseKind::Patched)
}

struct PacketParts {
    total: u64,
    payload: u64,
    metadata: u64,
}

fn packet_parts(bytes: &[u8]) -> PacketParts {
    assert!(bytes.starts_with(b"FGSC") && bytes.len() >= 24);
    let metadata = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as u64;
    let payload = u32::from_le_bytes(bytes[20..24].try_into().unwrap()) as u64;
    PacketParts {
        total: bytes.len() as u64,
        payload,
        metadata,
    }
}

fn packet_parts_json(bytes: &[u8]) -> Value {
    let parts = packet_parts(bytes);
    json!({"total": parts.total, "payload": parts.payload, "metadata": parts.metadata})
}

fn options_json() -> String {
    json!({"pageId": "p", "width": VIEW_W, "height": VIEW_H, "view": {"x": 0, "y": 0, "zoom": 1},
        "grid": false, "transparent": false, "rasterProfile": "figmaSubpixel"})
    .to_string()
}

fn image_uri(w: u32, h: u32) -> String {
    let mut raw = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let band = ((x / 32) ^ (y / 32)) & 1;
            raw.extend_from_slice(&[
                (x * 255 / w.max(1)) as u8,
                (y * 255 / h.max(1)) as u8,
                if band == 0 { 40 } else { 210 },
                255,
            ]);
        }
    }
    let mut png_bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut png_bytes, w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(&raw)
        .unwrap();
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png_bytes)
    )
}

fn png_bytes(uri: &str) -> u64 {
    let encoded = uri.split_once(',').unwrap().1;
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap()
        .len() as u64
}

fn summary(values: &[f64]) -> Value {
    if values.is_empty() {
        return json!({});
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let sum: f64 = sorted.iter().sum();
    json!({"n": sorted.len(), "minMs": sorted[0], "p50Ms": sorted[sorted.len() / 2], "maxMs": sorted[sorted.len() - 1], "meanMs": sum / sorted.len() as f64})
}

fn summary_u64(values: &[u64]) -> Value {
    if values.is_empty() {
        return json!({});
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    json!({"n": sorted.len(), "min": sorted[0], "p50": sorted[sorted.len() / 2], "max": sorted[sorted.len() - 1]})
}

fn elapsed_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
