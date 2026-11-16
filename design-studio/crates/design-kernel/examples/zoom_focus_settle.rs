//! CPU phases of the #479 zoom-focus settle on real `117.sketch`.
//!
//! Pointer-up in the canvas worker admits the edit, compiles the current
//! revision, then the GPU draws and the host presents. This process times
//! admission, scene compilation, packet encoding and the zoom coordinate
//! table. It does not run Electron, WebGPU, Metal or a display present.
//!
//! The default viewport is one capture, matching the worker. `ZOOM_FOCUS_SPLIT=1`
//! restores the previous four-cell grid. Sketch uses the 52px toolbar, 231px
//! layers and 240px inspector in a 1440×960 window at device pixel ratio 2.
//! Figma uses the 38px toolbar, 231px layers and 241px inspector. Optional tab
//! strips are not subtracted. Zoom is 15060% CSS, so the device scale is 301.2.
use futureox_design_kernel::{
    editing::DocumentPatch,
    math::{Point, Rect, Transform},
    scene::{Document, Effect},
    zoom_blur, Engine,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{hint::black_box, time::Instant};

const CSS_ZOOM: f64 = 150.6;
const DPR: u32 = 2;
const DEVICE_ZOOM: f64 = CSS_ZOOM * DPR as f64;
const LAYERS_CSS: u32 = 231;
const WINDOW: (u32, u32) = (1440, 960);

fn main() {
    let started = Instant::now();
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../testing/fixtures/user-regression-20261109/117.sketch"
    );
    let bytes = std::fs::read(path).expect("117.sketch");
    if bytes.starts_with(b"version https://git-lfs.github.com") {
        println!(
            "{}",
            json!({"status":"BLOCKED","reason":"117.sketch is an LFS pointer","gpuCompletion":"NOT_RUN","present":"NOT_RUN"})
        );
        return;
    }
    let font = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
    ))
    .expect("default font");
    let imported = Instant::now();
    let mut doc = futureox_design_kernel::interop::import_sketch_report(&bytes)
        .expect("import 117")
        .document;
    let import_ms = imported.elapsed().as_secs_f64() * 1000.0;
    let substituted = substitute_unembedded_fonts(&mut doc);
    let id = doc
        .nodes
        .iter()
        .find(|(_, node)| node.name == "椭圆 66" && node.width == 5. && node.height == 5.)
        .map(|(id, _)| id.clone())
        .expect("椭圆 66");
    let world = world_transform(&doc, &id);
    let local = &doc.nodes[&id];
    let center = world.point(Point::new(local.width / 2., local.height / 2.));
    if doc.schema_version < 19 {
        doc.schema_version = 19;
    }
    let effect: Effect = serde_json::from_value(json!({
        "kind": "zoom-blur", "radius": 0, "color": "#000000", "visible": true,
        "zoomBlur": {"amount": 10, "center": [0.5, 0.5]}
    }))
    .unwrap();
    doc.nodes.get_mut(&id).unwrap().effects.push(effect);
    println!(
        "{}",
        json!({
            "event": "setup",
            "profile": if cfg!(debug_assertions) { "debug" } else { "optimized" },
            "fixture": "testing/fixtures/user-regression-20261109/117.sketch",
            "fixtureSha256": hex(&Sha256::digest(&bytes)),
            "fixtureBytes": bytes.len(),
            "importMs": import_ms,
            "nodes": doc.nodes.len(),
            "schema": doc.schema_version,
            "rasterProfile": doc.raster_profile,
            "colorManaged": doc.color_management.is_some(),
            "fontSubstitutions": substituted,
            "nodeId": id,
            "worldCenter": [center.x, center.y],
            "cssZoom": CSS_ZOOM,
            "dpr": DPR,
            "deviceZoom": DEVICE_ZOOM,
            "gpuCompletion": "NOT_RUN",
            "present": "NOT_RUN",
            "host": "cpu",
        })
    );
    for (name, inspector, chrome) in [("sketch", 240u32, 52u32), ("figma", 241, 38)] {
        measure_layout(&doc, &id, center, name, inspector, chrome, &font);
    }
    println!("{}", json!({"event":"done","elapsedS": started.elapsed().as_secs_f64()}));
}

fn measure_layout(source: &Document, id: &str, center: Point, layout: &str, inspector: u32, chrome: u32, font: &[u8]) {
    let css_w = WINDOW.0 - LAYERS_CSS - inspector;
    let css_h = WINDOW.1 - chrome;
    let width = css_w * DPR;
    let height = css_h * DPR;
    let plan = focus_regions(width, height, center);
    let mut doc = source.clone();
    let mut engine = Engine::new();
    engine.load_font(font).unwrap();
    let loaded = Instant::now();
    engine.load_document(&serde_json::to_string(&doc).unwrap()).expect("load");
    engine.load_font(font).unwrap();
    let load_ms = loaded.elapsed().as_secs_f64() * 1000.0;
    let warm = settle(&mut engine, &mut doc, id, &plan, width, height, [0.5, 0.5]);
    let axis_w = doc.nodes[id].width;
    let axis_h = doc.nodes[id].height;
    let dx = 18. / CSS_ZOOM / axis_w;
    let dy = 7. / CSS_ZOOM / axis_h;
    let landings = [
        [0.5 + dx, 0.5],
        [0.5, 0.5],
        [0.5, 0.5 + dy],
        [0.5, 0.5],
        [0.5 + dx, 0.5 + dy],
        [0.5 - dx, 0.5 - dy],
    ];
    let mut samples = Vec::new();
    for landing in landings {
        samples.push(settle(&mut engine, &mut doc, id, &plan, width, height, landing));
    }
    let mut fresh = Engine::new();
    fresh.load_font(font).unwrap();
    fresh.load_document(&serde_json::to_string(&doc).unwrap()).unwrap();
    fresh.load_font(font).unwrap();
    let oracle = compile_regions(&mut fresh, &doc, &plan, width, height);
    let mismatch = samples.last().unwrap().packet_sha256 != oracle.packet_sha256;
    let mut cpu: Vec<f64> = samples.iter().map(|s| s.apply_ms + s.compile_ms + s.encode_ms + s.coordinate_ms).collect();
    println!(
        "{}",
        json!({
            "layout": layout,
            "cssCanvas": [css_w, css_h],
            "deviceCanvas": [width, height],
            "regions": plan.regions.len(),
            "regionPixels": plan.regions.iter().map(|r| u64::from(r.w) * u64::from(r.h)).collect::<Vec<_>>(),
            "prepare": {"x": plan.prepare.x, "y": plan.prepare.y, "w": plan.prepare.w, "h": plan.prepare.h},
            "loadMs": load_ms,
            "warmup": summary(&warm),
            "samples": samples.iter().map(summary).collect::<Vec<_>>(),
            "cpuSettleMedianMs": median(&mut cpu),
            "applyMedianMs": median(&mut samples.iter().map(|s| s.apply_ms).collect::<Vec<_>>()),
            "compileMedianMs": median(&mut samples.iter().map(|s| s.compile_ms).collect::<Vec<_>>()),
            "encodeMedianMs": median(&mut samples.iter().map(|s| s.encode_ms).collect::<Vec<_>>()),
            "coordinateMedianMs": median(&mut samples.iter().map(|s| s.coordinate_ms).collect::<Vec<_>>()),
            "oracleMismatch": mismatch,
            "gpuCompletion": "NOT_RUN",
            "present": "NOT_RUN",
        })
    );
    assert!(!mismatch, "{layout} packets diverged from an independent engine");
}

struct Sample {
    apply_ms: f64,
    compile_ms: f64,
    encode_ms: f64,
    coordinate_ms: f64,
    packet_bytes: usize,
    packet_sha256: String,
    nodes: usize,
    zoom_rects: Vec<Value>,
    extent_pixels: u64,
    wide_gaussians: usize,
    cache: Value,
}

fn summary(sample: &Sample) -> Value {
    json!({
        "applyMs": sample.apply_ms,
        "compileMs": sample.compile_ms,
        "encodeMs": sample.encode_ms,
        "coordinateMs": sample.coordinate_ms,
        "cpuMs": sample.apply_ms + sample.compile_ms + sample.encode_ms + sample.coordinate_ms,
        "packetBytes": sample.packet_bytes,
        "packetSha256": sample.packet_sha256,
        "sceneNodes": sample.nodes,
        "zoomRects": sample.zoom_rects,
        "extentPixels": sample.extent_pixels,
        "wideGaussians": sample.wide_gaussians,
        "cache": sample.cache,
    })
}

fn settle(engine: &mut Engine, doc: &mut Document, id: &str, plan: &FocusPlan, width: u32, height: u32, center: [f64; 2]) -> Sample {
    let mut next = doc.clone();
    let slot = next.nodes[id].effects.iter().position(|effect| effect.kind == "zoom-blur").unwrap();
    next.nodes.get_mut(id).unwrap().effects[slot].zoom_blur.as_mut().unwrap().center = center;
    let patch = DocumentPatch::between(doc, &next).unwrap();
    let apply_at = Instant::now();
    engine.apply_document_patch_with_damage(&patch).unwrap();
    let apply_ms = apply_at.elapsed().as_secs_f64() * 1000.0;
    *doc = next;
    let mut compiled = compile_regions(engine, doc, plan, width, height);
    compiled.apply_ms = apply_ms;
    compiled
}

fn compile_regions(engine: &mut Engine, doc: &Document, plan: &FocusPlan, width: u32, height: u32) -> Sample {
    let mut compile_ms = 0.0;
    let mut encode_ms = 0.0;
    let mut coordinate_ms = 0.0;
    let mut packet_bytes = 0usize;
    let mut hasher = Sha256::new();
    let mut nodes = 0usize;
    let mut zoom_rects = Vec::new();
    let mut extent_pixels = 0u64;
    let mut wide_gaussians = 0usize;
    for region in &plan.regions {
        let request = json!({
            "pageId": doc.pages[0].id,
            "width": width,
            "height": height,
            "view": {"x": 0.0, "y": 0.0, "zoom": DEVICE_ZOOM},
            "rasterProfile": "analytic",
            "gpuAnalyticRegions": true,
            "transparent": false,
            "grid": false,
            "captureViewport": {"x": region.x, "y": region.y, "w": region.w, "h": region.h},
            "prepareViewport": {"x": plan.prepare.x, "y": plan.prepare.y, "w": plan.prepare.w, "h": plan.prepare.h},
        })
        .to_string();
        let at = Instant::now();
        let scene = engine.compile_gpu_request(&request).unwrap_or_else(|error| panic!("compile failed: {error}"));
        compile_ms += at.elapsed().as_secs_f64() * 1000.0;
        nodes = nodes.max(scene.nodes.len());
        extent_pixels = extent_pixels.max(u64::from(scene.extent.w) * u64::from(scene.extent.h));
        wide_gaussians = wide_gaussians.max(scene.nodes.values().filter(|node| node.wide_image_gaussian.is_some()).count());
        let zooms: Vec<_> = scene
            .nodes
            .values()
            .filter(|node| node.effects.iter().any(|effect| effect.zoom_blur.is_some()))
            .map(|node| (node.matrix, node.size, node.rect, node.effects.clone()))
            .collect();
        if zoom_rects.is_empty() {
            zoom_rects = zooms
                .iter()
                .map(|(_, _, rect, _)| json!({"x": rect.x, "y": rect.y, "w": rect.w, "h": rect.h}))
                .collect();
        }
        let coord_at = Instant::now();
        for (matrix, size, rect, effects) in &zooms {
            for effect in effects {
                if let Some(blur) = effect.zoom_blur {
                    black_box(zoom_blur::coordinates(blur, *matrix, *size, *rect).expect("coordinates"));
                }
            }
        }
        coordinate_ms += coord_at.elapsed().as_secs_f64() * 1000.0;
        let encode_at = Instant::now();
        let packet = scene.into_packet().expect("packet");
        encode_ms += encode_at.elapsed().as_secs_f64() * 1000.0;
        packet_bytes += packet.len();
        hasher.update(&packet);
    }
    Sample {
        apply_ms: 0.0,
        compile_ms,
        encode_ms,
        coordinate_ms,
        packet_bytes,
        packet_sha256: hex(&hasher.finalize()),
        nodes,
        zoom_rects,
        extent_pixels,
        wide_gaussians,
        cache: engine.gpu_compile_cache_stats(),
    }
}

struct FocusPlan {
    regions: Vec<Rect>,
    prepare: Rect,
}

fn focus_regions(width: u32, height: u32, center: Point) -> FocusPlan {
    let origin_x = (center.x * DEVICE_ZOOM - f64::from(width) / 2.).round() as i32;
    let origin_y = (center.y * DEVICE_ZOOM - f64::from(height) / 2.).round() as i32;
    let prepare = Rect::new(origin_x, origin_y, width, height);
    let mut regions = vec![prepare];
    if std::env::var("ZOOM_FOCUS_SPLIT").ok().as_deref() == Some("1")
        && u64::from(width) * u64::from(height) > 524_288 {
        let columns = width.div_ceil(1024);
        let cell_w = width.div_ceil(columns);
        let rows = (u64::from(cell_w) * u64::from(height)).div_ceil(960_000).max(1) as u32;
        let cell_h = height.div_ceil(rows);
        regions.clear();
        let mut dy = 0u32;
        while dy < height {
            let mut dx = 0u32;
            let h = cell_h.min(height - dy);
            while dx < width {
                let w = cell_w.min(width - dx);
                regions.push(Rect::new(origin_x + dx as i32, origin_y + dy as i32, w, h));
                dx += cell_w;
            }
            dy += cell_h;
        }
    }
    FocusPlan { regions, prepare }
}

fn world_transform(doc: &Document, id: &str) -> Transform {
    let mut chain = vec![id.to_string()];
    let mut cursor = id.to_string();
    for _ in 0..doc.nodes.len() {
        let parent = doc.nodes.iter().find(|(_, node)| node.children.iter().any(|child| child == &cursor));
        match parent {
            Some((parent, _)) => {
                cursor = parent.clone();
                chain.push(parent.clone());
            }
            None => break,
        }
    }
    let mut matrix = Transform::default();
    for id in chain.iter().rev() {
        matrix = matrix.concat(doc.nodes[id].transform);
    }
    matrix
}

fn substitute_unembedded_fonts(doc: &mut Document) -> usize {
    let known: std::collections::BTreeSet<String> = doc.fonts.keys().cloned().collect();
    let present = |id: &str| id == "default" || known.contains(id);
    let mut replaced = 0usize;
    for node in doc.nodes.values_mut() {
        if let Some(style) = node.text_style.as_mut() {
            if !present(&style.font_id) {
                style.font_id = "default".into();
                replaced += 1;
            }
            let before = style.fallbacks.len();
            style.fallbacks.retain(|font| present(font));
            replaced += before - style.fallbacks.len();
        }
        for run in &mut node.text_runs {
            if run.font_id.as_deref().is_some_and(|font| !present(font)) {
                run.font_id = Some("default".into());
                replaced += 1;
            }
        }
    }
    replaced
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    if values.len() % 2 == 0 { (values[mid - 1] + values[mid]) / 2. } else { values[mid] }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
