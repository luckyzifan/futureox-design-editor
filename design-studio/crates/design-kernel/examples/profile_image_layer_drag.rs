//! CPU profile of one large bitmap image layer while its translation changes.
//!
//! Stages match the native compositor: upload (decode), atlas admission,
//! retain (decoded image plus interaction pose), reproject (dense grid versus
//! compact axes), and present (CPU viewport raster). Hardware WebGPU, Metal,
//! Electron, and official desktop frame timing are not measured here.
use futureox_design_kernel::{
    Engine,
    export::encode_rgba,
    math::Transform,
    paint::{image_sampling_field_with_sketch_sampling, image_sampling_grid_with_sketch_sampling},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{hint::black_box, sync::Arc, time::Instant};

const ATLAS_MAX_IMAGE: u32 = 512;
const WIDTH: u32 = 1280;
const HEIGHT: u32 = 720;

fn ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.
}
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn percentile(samples: &mut [f64], p: usize) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[(samples.len() * p / 100).min(samples.len() - 1)]
}
fn base64(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    let mut index = 0;
    while index + 3 <= data.len() {
        let n = (u32::from(data[index]) << 16)
            | (u32::from(data[index + 1]) << 8)
            | u32::from(data[index + 2]);
        for shift in [18, 12, 6, 0] {
            out.push(TABLE[((n >> shift) & 63) as usize] as char);
        }
        index += 3;
    }
    if index < data.len() {
        let mut n = u32::from(data[index]) << 16;
        if index + 1 < data.len() {
            n |= u32::from(data[index + 1]) << 8;
        }
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if index + 1 < data.len() {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
            out.push('=');
        } else {
            out.push('=');
            out.push('=');
        }
    }
    out
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut rgba = vec![0u8; WIDTH as usize * HEIGHT as usize * 4];
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let i = ((y * WIDTH + x) * 4) as usize;
            rgba[i] = (x % 251) as u8;
            rgba[i + 1] = (y % 251) as u8;
            rgba[i + 2] = ((x.wrapping_mul(3) + y) % 251) as u8;
            rgba[i + 3] = 255;
        }
    }
    let encoded = encode_rgba(WIDTH, HEIGHT, &rgba)?;
    let uri = format!("data:image/png;base64,{}", base64(&encoded));
    let document = json!({
        "schemaVersion": 1,
        "id": "large-bitmap-drag",
        "name": "Large bitmap drag",
        "pages": [{"id": "p", "name": "p", "background": "#202020", "children": ["photo"]}],
        "nodes": {"photo": {
            "id": "photo", "kind": "rectangle", "width": WIDTH, "height": HEIGHT,
            "transform": [1, 0, 0, 1, 0, 0],
            "fills": [{"kind": "image", "color": "#ffffff", "image": uri, "fit": "stretch"}]
        }}
    });
    let document_json = document.to_string();
    let mut engine = Engine::new();
    engine.load_document(&document_json)?;
    let upload_started = Instant::now();
    let decoded = engine.image_data(
        document["nodes"]["photo"]["fills"][0]["image"]
            .as_str()
            .unwrap(),
    )?;
    let upload_ms = ms(upload_started);
    let retain_started = Instant::now();
    let retained = engine.image_data(
        document["nodes"]["photo"]["fills"][0]["image"]
            .as_str()
            .unwrap(),
    )?;
    let retain_decode_ms = ms(retain_started);
    assert!(Arc::ptr_eq(&decoded, &retained));
    let atlas = decoded.rect.w <= ATLAS_MAX_IMAGE && decoded.rect.h <= ATLAS_MAX_IMAGE;

    let options = json!({
        "pageId": "p", "width": WIDTH, "height": HEIGHT,
        "view": {"x": 0, "y": 0, "zoom": 1}, "transparent": true, "grid": false
    });
    let options_text = options.to_string();
    engine.bind_frame_scene_scope("large-bitmap-drag")?;
    let compile_started = Instant::now();
    let scene = engine.compile_gpu_request(&options_text)?;
    let compile_ms = ms(compile_started);
    let node = scene.nodes.get("photo").expect("bitmap layer");
    let paint = node.fills[0].paint.clone();
    let dims = [decoded.rect.w, decoded.rect.h];
    let mut drag_rows = Vec::new();
    let mut pose_ms = Vec::new();
    let mut dense_ms = Vec::new();
    let mut compact_ms = Vec::new();
    let mut packet_ms = Vec::new();
    let mut present_ms = Vec::new();
    let mut packet_bytes = Vec::new();
    let mut present_hash = String::new();
    for step in 0..6 {
        let dx = step as f64 * 1.25;
        let dy = step as f64 * 0.75;
        let mut transforms = std::collections::BTreeMap::new();
        transforms.insert("photo".to_owned(), Transform([1., 0., 0., 1., dx, dy]));
        let started = Instant::now();
        assert!(engine.apply_interaction_transforms(&transforms)?);
        pose_ms.push(ms(started));
        let request = json!({
            "pageId": "p", "width": WIDTH, "height": HEIGHT,
            "view": {"x": 0, "y": 0, "zoom": 1}, "transparent": true, "grid": false
        })
        .to_string();
        let started = Instant::now();
        let packet = engine.compile_gpu_packet_request(&request)?;
        packet_ms.push(ms(started));
        packet_bytes.push(packet.len());
        let scene = engine.compile_gpu_request(&request)?;
        let node = scene.nodes.get("photo").unwrap();
        let rect = node.rect;
        let matrix = node.matrix;
        let size = node.size;
        let sketch = node.fills[0].sketch_bitmap_sampling;
        let motion = node.sketch_motion_phase_axis;
        let started = Instant::now();
        let dense = image_sampling_grid_with_sketch_sampling(
            rect,
            matrix,
            size,
            dims,
            &paint,
            Some(0),
            0,
            [0, 0],
            sketch,
            motion,
        )?;
        dense_ms.push(ms(started));
        let started = Instant::now();
        let compact = image_sampling_field_with_sketch_sampling(
            rect,
            matrix,
            size,
            dims,
            &paint,
            Some(0),
            0,
            [0, 0],
            sketch,
            motion,
        )?;
        compact_ms.push(ms(started));
        black_box(&dense);
        black_box(&compact);
        assert_eq!(compact.get(3), Some(&-1.));
        assert!(compact.len() < dense.len());
        let render_options = engine.parse_options(serde_json::from_str(&request)?)?;
        let started = Instant::now();
        let pixels = engine.render(&render_options)?;
        present_ms.push(ms(started));
        present_hash = hash(&pixels);
        drag_rows.push(json!({
            "step": step,
            "translation": [dx, dy],
            "deviceRect": [rect.x, rect.y, rect.w, rect.h],
            "denseFloats": dense.len(),
            "compactFloats": compact.len(),
            "denseBytes": dense.len() * 4,
            "compactBytes": compact.len() * 4,
        }));
    }
    let summary = |samples: &mut [f64]| {
        json!({
            "p50Ms": percentile(samples, 50),
            "p95Ms": percentile(samples, 95),
            "samplesMs": samples,
        })
    };
    let report = json!({
        "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "arch": std::env::consts::ARCH,
        "image": {"width": WIDTH, "height": HEIGHT, "pngBytes": encoded.len(), "decodedBytes": decoded.pixels.len() * 16},
        "stages": {
            "upload": {"ms": upload_ms, "bytes": decoded.pixels.len() * 16, "note": "CPU decode into the resident image. GPU writeTexture is NOT_RUN"},
            "atlas": {"admitted": atlas, "maxImage": ATLAS_MAX_IMAGE, "bytes": if atlas { decoded.pixels.len() * 16 } else { 0 }},
            "retain": {"decodeHitMs": retain_decode_ms, "sameAllocation": true, "pose": summary(&mut pose_ms)},
            "reproject": {"dense": summary(&mut dense_ms), "compactField": summary(&mut compact_ms)},
            "interchange": {
                "compileMs": compile_ms,
                "packet": summary(&mut packet_ms),
                "packetBytes": packet_bytes,
                "note": "These requests send no frameResources acknowledgement, so each packet repeats the PNG data URI. A live worker ACK can omit that payload."
            },
            "present": {"cpuRaster": summary(&mut present_ms), "gpu": "NOT_RUN", "hardwareWebGPU": "NOT_RUN", "metal": "NOT_RUN", "electron": "NOT_RUN"}
        },
        "drag": drag_rows,
        "finalPresentSha256": present_hash,
        "documentSha256": hash(document_json.as_bytes()),
    });
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
