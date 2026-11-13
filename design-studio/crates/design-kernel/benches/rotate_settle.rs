//! Production rotate settle: patch admission plus the tiled refine/present
//! the CPU host uses after an edit. When `117.sketch` is a real zip rather
//! than an LFS pointer, the same path times rotation of group 23. This
//! process is not Mac/Electron/Metal.
//!
//! Each sample times `apply_document_patch_with_damage` and
//! `render_tiled_frame` with the damage that call returned. Full damage
//! passes no rects, which is the host rule in `preparation::present_cpu_frame`.
//! A fresh `Engine::render` of the settled document is the independent pixel
//! reference. Zoom is bucket-snapped so that comparison stays byte-exact.
use futureox_design_kernel::{
    Engine, RenderOptions,
    editing::DocumentPatch,
    math::Transform,
    scene::{Document, Node},
};
use std::time::Instant;

const VIEW_W: u32 = 2048;
const VIEW_H: u32 = 1536;

fn rss_kib() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|text| {
            text.lines()
                .find_map(|line| {
                    line.strip_prefix("VmRSS:")
                        .map(|rest| rest.trim().trim_end_matches(" kB").trim().parse().ok())
                })
                .flatten()
        })
        .unwrap_or(0)
}

fn hwm_kib() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|text| {
            text.lines()
                .find_map(|line| {
                    line.strip_prefix("VmHWM:")
                        .map(|rest| rest.trim().trim_end_matches(" kB").trim().parse().ok())
                })
                .flatten()
        })
        .unwrap_or(0)
}

fn rect(id: &str, x: f64, y: f64, w: f64, h: f64, color: &str) -> Node {
    serde_json::from_value(serde_json::json!({
        "id": id, "kind": "rectangle", "name": id,
        "width": w, "height": h,
        "transform": [1.0, 0.0, 0.0, 1.0, x, y],
        "fills": [{"kind": "solid", "color": color, "opacity": 1.0}]
    }))
    .unwrap()
}

fn with_blur(mut node: Node, radius: f64) -> Node {
    node.effects = serde_json::from_value(serde_json::json!([
        {"kind": "blur", "radius": radius, "visible": true, "color": "#000000"}
    ]))
    .unwrap();
    node
}

/// Twelve viewport tiles of real blur paint, plus one artboard whose nested
/// mask chain repaints only the owning subtree when a child rotates.
fn masked_artboard() -> (Document, String) {
    let mut nodes = serde_json::Map::new();
    let mut roots = Vec::new();
    for tile_y in 0..3 {
        for tile_x in 0..4 {
            let x = tile_x as f64 * 512. + 36.;
            let y = tile_y as f64 * 512. + 28.;
            for slot in 0..2 {
                let id = format!("fill-{tile_x}-{tile_y}-{slot}");
                let node = with_blur(
                    rect(
                        &id,
                        x + slot as f64 * 180.,
                        y + 40.,
                        120.,
                        90.,
                        if slot == 0 { "#3366aa" } else { "#aa6633" },
                    ),
                    14.,
                );
                nodes.insert(id.clone(), serde_json::to_value(&node).unwrap());
                roots.push(id);
            }
        }
    }
    let board = serde_json::json!({
        "id": "board", "kind": "frame", "name": "board",
        "width": 220.0, "height": 180.0,
        "transform": [1.0, 0.0, 0.0, 1.0, 48.0, 64.0],
        "fills": [{"kind": "solid", "color": "#f4f1ea", "opacity": 1.0}],
        "children": ["mask", "mover"]
    });
    let mask = serde_json::json!({
        "id": "mask", "kind": "rectangle", "name": "mask",
        "mask": true, "maskType": "shape", "maskChain": "start",
        "width": 200.0, "height": 150.0,
        "transform": [1.0, 0.0, 0.0, 1.0, 8.0, 10.0],
        "fills": [{"kind": "solid", "color": "#ffffff", "opacity": 1.0}]
    });
    let mover = serde_json::json!({
        "id": "mover", "kind": "rectangle", "name": "mover",
        "width": 70.0, "height": 36.0,
        "transform": [1.0, 0.0, 0.0, 1.0, 40.0, 48.0],
        "fills": [{"kind": "solid", "color": "#cc3344", "opacity": 1.0}]
    });
    nodes.insert("board".into(), board);
    nodes.insert("mask".into(), mask);
    nodes.insert("mover".into(), mover);
    roots.insert(0, "board".into());
    let doc: Document = serde_json::from_value(serde_json::json!({
        "schemaVersion": 4, "id": "rotate-settle", "name": "rotate-settle",
        "pages": [{"id": "page", "name": "Page", "background": "#ffffff", "children": roots}],
        "nodes": nodes
    }))
    .unwrap();
    (doc, "mover".into())
}

fn clipped_group() -> (Document, String) {
    let (mut doc, _) = masked_artboard();
    let board = doc.nodes.get_mut("board").unwrap();
    board.clip = true;
    board.children = vec!["mover".into()];
    doc.nodes.remove("mask");
    (doc, "board".into())
}

fn plain_group() -> (Document, String) {
    let (mut doc, _) = clipped_group();
    doc.nodes.get_mut("board").unwrap().clip = false;
    (doc, "board".into())
}

fn options() -> RenderOptions {
    serde_json::from_value(serde_json::json!({
        "pageId": "page", "width": VIEW_W, "height": VIEW_H,
        "view": {"x": 0.0, "y": 0.0, "zoom": 1.0},
        "transparent": false, "grid": false,
        "rasterProfile": "analytic"
    }))
    .unwrap()
}

fn turn(node: &Node, quarter: bool) -> Transform {
    if quarter {
        Transform([0., 1., -1., 0., node.transform.0[4], node.transform.0[5]])
    } else {
        Transform([1., 0., 0., 1., node.transform.0[4], node.transform.0[5]])
    }
}

fn patch_turning(doc: &Document, id: &str, quarter: bool) -> DocumentPatch {
    let mut next = doc.clone();
    let node = next.nodes.get_mut(id).unwrap();
    node.transform = turn(node, quarter);
    DocumentPatch::between(doc, &next).unwrap()
}

fn present(
    engine: &mut Engine,
    options: &RenderOptions,
    damage: &futureox_design_kernel::dirty_region::PatchDamage,
) -> (f64, usize, u64) {
    let rects;
    let passed: Option<&[[f64; 4]]> = if damage.full {
        None
    } else if let Some(rects_owned) = damage.rects.as_deref() {
        rects = rects_owned.to_vec();
        Some(rects.as_slice())
    } else if let Some(bounds) = damage.bounds {
        rects = vec![bounds];
        Some(rects.as_slice())
    } else {
        rects = Vec::new();
        Some(rects.as_slice())
    };
    let started = Instant::now();
    let frame = engine.render_tiled_frame(options, passed).unwrap();
    let ms = started.elapsed().as_secs_f64() * 1000.;
    let tiles = engine
        .tiled_renderer()
        .map(|r| r.last_committed().len())
        .unwrap_or(0);
    let pixels = frame.telemetry.rasterisation_pixel_count;
    let _ = frame;
    (ms, tiles, pixels)
}

struct Sample {
    apply_ms: f64,
    present_ms: f64,
    tiles: usize,
    full: bool,
    reason: Option<String>,
    bounds_area: f64,
}

fn settle_once(
    engine: &mut Engine,
    options: &RenderOptions,
    patch: &DocumentPatch,
    before_pixels: u64,
) -> Sample {
    let started = Instant::now();
    let damage = engine.apply_document_patch_with_damage(patch).unwrap();
    let apply_ms = started.elapsed().as_secs_f64() * 1000.;
    let (present_ms, tiles, pixels_after) = present(engine, options, &damage);
    let _ = pixels_after.saturating_sub(before_pixels);
    let bounds_area = damage.bounds.map(|b| b[2] * b[3]).unwrap_or(f64::INFINITY);
    Sample {
        apply_ms,
        present_ms,
        tiles,
        full: damage.full,
        reason: damage.reason.map(str::to_string),
        bounds_area,
    }
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[mid - 1] + values[mid]) / 2.
    } else {
        values[mid]
    }
}

fn run(label: &str, doc: Document, id: &str) {
    let options = options();
    let mut engine = Engine::new();
    engine
        .load_document(&serde_json::to_string(&doc).unwrap())
        .unwrap();
    let cold = Instant::now();
    let _ = engine.render_tiled_frame(&options, None).unwrap();
    let cold_ms = cold.elapsed().as_secs_f64() * 1000.;
    let forward = patch_turning(&doc, id, true);
    let mut turned = doc.clone();
    turned.nodes.get_mut(id).unwrap().transform = turn(&doc.nodes[id], true);
    let back = DocumentPatch::between(&turned, &doc).unwrap();
    // One untimed round trip so the first measured sample is not a cold cache.
    let _ = settle_once(&mut engine, &options, &forward, 0);
    let _ = settle_once(&mut engine, &options, &back, 0);
    let mut samples = Vec::new();
    for _ in 0..5 {
        samples.push(settle_once(&mut engine, &options, &forward, 0));
        samples.push(settle_once(&mut engine, &options, &back, 0));
    }
    // The measured loop ends on the reverse pose, so residency is the original
    // document. A second engine renders that same source with no damage hint.
    let presented = engine.render_tiled_frame(&options, None).unwrap().rgba;
    let mut fresh = Engine::new();
    fresh
        .load_document(&serde_json::to_string(&doc).unwrap())
        .unwrap();
    let reference = fresh.render(&options).unwrap();
    let mut mismatch = 0u64;
    let mut max_delta = 0u8;
    for (a, b) in presented.iter().zip(reference.iter()) {
        let d = a.abs_diff(*b);
        if d > 0 {
            mismatch += 1;
            max_delta = max_delta.max(d);
        }
    }
    let mut e2e: Vec<f64> = samples.iter().map(|s| s.apply_ms + s.present_ms).collect();
    let mut apply: Vec<f64> = samples.iter().map(|s| s.apply_ms).collect();
    let mut present_ms: Vec<f64> = samples.iter().map(|s| s.present_ms).collect();
    let tiles: Vec<_> = samples.iter().map(|s| s.tiles).collect();
    let full = samples.iter().all(|s| s.full);
    let reason = samples.iter().find_map(|s| s.reason.clone());
    println!(
        "{{\"scenario\":{label:?},\"cold_ms\":{cold_ms:.3},\"samples\":{},\"e2e_median_ms\":{:.3},\"apply_median_ms\":{:.3},\"present_median_ms\":{:.3},\"e2e_min_ms\":{:.3},\"e2e_max_ms\":{:.3},\"tiles\":{tiles:?},\"damage_full\":{full},\"damage_reason\":{reason:?},\"bounds_area\":{:.1},\"viewport_area\":{},\"pixel_mismatch\":{mismatch},\"pixel_max_delta\":{max_delta},\"presented_bytes\":{},\"reference_bytes\":{},\"rss_kib\":{},\"hwm_kib\":{}}}",
        samples.len(),
        median(&mut e2e),
        median(&mut apply),
        median(&mut present_ms),
        e2e.iter().copied().fold(f64::INFINITY, f64::min),
        e2e.iter().copied().fold(0., f64::max),
        samples[0].bounds_area,
        VIEW_W * VIEW_H,
        presented.len(),
        reference.len(),
        rss_kib(),
        hwm_kib(),
    );
    assert_eq!(
        mismatch, 0,
        "{label} presented pixels diverged from an independent full render"
    );
    assert_eq!(max_delta, 0);
}

fn invalid_scene_nodes(doc: &Document) -> Vec<String> {
    let mut found = Vec::new();
    for (id, node) in &doc.nodes {
        let bad_dim = [node.width, node.height, node.font_size]
            .iter()
            .any(|value| !value.is_finite() || *value <= 0. || *value > 1e7);
        let bad_transform = node.transform.0.iter().any(|value| !value.is_finite() || value.abs() > 1e7)
            || node.transform.inverse().is_err();
        if id != &node.id || bad_dim || bad_transform || !node.opacity.is_finite()
            || node.opacity < 0. || node.opacity > 1.
            || node.fills.len() > 16 || node.strokes.len() > 16 || node.effects.len() > 16
        {
            found.push(format!(
                "{id} kind={} w={} h={} font={} opacity={} fills={} strokes={} effects={} transform={:?}",
                node.kind, node.width, node.height, node.font_size, node.opacity,
                node.fills.len(), node.strokes.len(), node.effects.len(), node.transform.0
            ));
            if found.len() == 8 { break; }
        }
    }
    found
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
            style.fallbacks.retain(|id| present(id));
            replaced += before - style.fallbacks.len();
        }
        for run in &mut node.text_runs {
            if run.font_id.as_deref().is_some_and(|id| !present(id)) {
                run.font_id = Some("default".into());
                replaced += 1;
            }
        }
    }
    replaced
}

/// Real 117.sketch group "组合 23", the editable chart group named by the
/// existing sketch performance entry. The archive stays an LFS pointer in
/// git; this only runs when the working tree has the zip bytes.
fn run_real_117() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../testing/fixtures/user-regression-20261109/117.sketch"
    );
    let Ok(bytes) = std::fs::read(path) else {
        println!("{{\"scenario\":\"real-117-group-23\",\"status\":\"BLOCKED\",\"reason\":\"fixture missing\"}}");
        return;
    };
    if bytes.starts_with(b"version https://git-lfs.github.com") {
        println!("{{\"scenario\":\"real-117-group-23\",\"status\":\"BLOCKED\",\"reason\":\"lfs pointer\"}}");
        return;
    }
    let font_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
    );
    let font = std::fs::read(font_path).expect("default font");
    let imported = Instant::now();
    let doc = futureox_design_kernel::interop::import_sketch_report(&bytes)
        .expect("import 117")
        .document;
    let import_ms = imported.elapsed().as_secs_f64() * 1000.;
    let id = doc
        .nodes
        .iter()
        .find(|(_, node)| node.name == "组合 23" && node.kind == "group")
        .map(|(id, _)| id.clone())
        .expect("group 23");
    let mut cursor = id.as_str();
    let mut chain = vec![cursor];
    for _ in 0..doc.nodes.len() {
        let parent = doc.nodes.iter().find(|(_, node)| node.children.iter().any(|child| child == cursor));
        match parent {
            Some((parent, _)) => {
                cursor = parent.as_str();
                chain.push(cursor);
            }
            None => break,
        }
    }
    let board = &doc.nodes[*chain.last().unwrap()];
    let width = board.width.ceil().clamp(1., 4096.) as u32;
    let height = board.height.ceil().clamp(1., 4096.) as u32;
    let options = serde_json::from_value(serde_json::json!({
        "pageId": doc.pages[0].id, "width": width, "height": height,
        "view": {"x": -board.transform.0[4], "y": -board.transform.0[5], "zoom": 1.0},
        "transparent": false, "grid": false,
        "rasterProfile": "analytic"
    }))
    .unwrap();
    let mut loaded = doc.clone();
    let substituted = substitute_unembedded_fonts(&mut loaded);
    let mut engine = Engine::new();
    engine.load_font(&font).unwrap();
    let json = serde_json::to_string(&loaded).unwrap();
    if let Err(error) = engine.load_document(&json) {
        let direct = loaded.validate().err().map(|err| err.to_string());
        let parsed: Document = serde_json::from_str(&json).unwrap();
        let parsed_error = parsed.validate().err().map(|err| err.to_string());
        let offenders = invalid_scene_nodes(&parsed);
        println!(
            "{{\"scenario\":\"real-117-group-23\",\"status\":\"BLOCKED\",\"load_error\":{error:?},\"direct_error\":{direct:?},\"parsed_error\":{parsed_error:?},\"font_substitutions\":{substituted},\"invalid_nodes\":{offenders:?}}}"
        );
        return;
    }
    engine.load_font(&font).unwrap();
    let cold = Instant::now();
    let _ = engine.render_tiled_frame(&options, None).unwrap();
    let cold_ms = cold.elapsed().as_secs_f64() * 1000.;
    let forward = patch_turning(&loaded, &id, true);
    let mut turned = loaded.clone();
    turned.nodes.get_mut(&id).unwrap().transform = turn(&loaded.nodes[&id], true);
    let back = DocumentPatch::between(&turned, &loaded).unwrap();
    let _ = settle_once(&mut engine, &options, &forward, 0);
    let _ = settle_once(&mut engine, &options, &back, 0);
    let rounds = std::env::var("ROTATE_SETTLE_ROUNDS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=5).contains(value))
        .unwrap_or(5);
    let mut samples = Vec::new();
    for _ in 0..rounds {
        samples.push(settle_once(&mut engine, &options, &forward, 0));
        samples.push(settle_once(&mut engine, &options, &back, 0));
    }
    let presented = engine.render_tiled_frame(&options, None).unwrap().rgba;
    let mut fresh = Engine::new();
    fresh.load_font(&font).unwrap();
    fresh
        .load_document(&serde_json::to_string(&loaded).unwrap())
        .unwrap();
    fresh.load_font(&font).unwrap();
    let reference = fresh.render(&options).unwrap();
    let mut mismatch = 0u64;
    let mut max_delta = 0u8;
    for (a, b) in presented.iter().zip(reference.iter()) {
        let d = a.abs_diff(*b);
        if d > 0 {
            mismatch += 1;
            max_delta = max_delta.max(d);
        }
    }
    let mut e2e: Vec<f64> = samples.iter().map(|s| s.apply_ms + s.present_ms).collect();
    let mut apply: Vec<f64> = samples.iter().map(|s| s.apply_ms).collect();
    let mut present_ms: Vec<f64> = samples.iter().map(|s| s.present_ms).collect();
    let tiles: Vec<_> = samples.iter().map(|s| s.tiles).collect();
    let full = samples.iter().all(|s| s.full);
    let reason = samples.iter().find_map(|s| s.reason.clone());
    let blurs = doc.nodes.values().filter(|node| node.effects.iter().any(|effect| effect.visible && effect.kind == "background-blur")).count();
    println!(
        "{{\"scenario\":\"real-117-group-23\",\"status\":\"measured\",\"import_ms\":{import_ms:.3},\"nodes\":{},\"font_substitutions\":{substituted},\"background_blurs\":{blurs},\"view_w\":{width},\"view_h\":{height},\"cold_ms\":{cold_ms:.3},\"samples\":{},\"e2e_median_ms\":{:.3},\"apply_median_ms\":{:.3},\"present_median_ms\":{:.3},\"e2e_min_ms\":{:.3},\"e2e_max_ms\":{:.3},\"tiles\":{tiles:?},\"damage_full\":{full},\"damage_reason\":{reason:?},\"bounds_area\":{:.1},\"pixel_mismatch\":{mismatch},\"pixel_max_delta\":{max_delta},\"rss_kib\":{},\"hwm_kib\":{}}}",
        loaded.nodes.len(),
        samples.len(),
        median(&mut e2e),
        median(&mut apply),
        median(&mut present_ms),
        e2e.iter().copied().fold(f64::INFINITY, f64::min),
        e2e.iter().copied().fold(0., f64::max),
        samples[0].bounds_area,
        rss_kib(),
        hwm_kib(),
    );
    assert_eq!(mismatch, 0, "real 117 presented pixels diverged from an independent full render");
    assert_eq!(max_delta, 0);
    let turned_doc = {
        let mut turned = loaded.clone();
        turned.nodes.get_mut(&id).unwrap().transform = turn(&loaded.nodes[&id], true);
        turned
    };
    let turned_damage = engine.apply_document_patch_with_damage(&forward).unwrap();
    let turned_present = Instant::now();
    let turned_frame = {
        let rects;
        let passed: Option<&[[f64; 4]]> = if turned_damage.full {
            None
        } else if let Some(rects_owned) = turned_damage.rects.as_deref() {
            rects = rects_owned.to_vec();
            Some(rects.as_slice())
        } else if let Some(bounds) = turned_damage.bounds {
            rects = vec![bounds];
            Some(rects.as_slice())
        } else {
            rects = Vec::new();
            Some(rects.as_slice())
        };
        engine.render_tiled_frame(&options, passed).unwrap()
    };
    let turned_present_ms = turned_present.elapsed().as_secs_f64() * 1000.;
    let mut fresh_turned = Engine::new();
    fresh_turned.load_font(&font).unwrap();
    fresh_turned
        .load_document(&serde_json::to_string(&turned_doc).unwrap())
        .unwrap();
    fresh_turned.load_font(&font).unwrap();
    let turned_reference = fresh_turned.render(&options).unwrap();
    let mut turned_mismatch = 0u64;
    for (a, b) in turned_frame.rgba.iter().zip(turned_reference.iter()) {
        if a != b { turned_mismatch += 1; }
    }
    println!(
        "{{\"scenario\":\"real-117-group-23-rotated\",\"present_ms\":{turned_present_ms:.3},\"damage_full\":{},\"tiles\":{},\"pixel_mismatch\":{turned_mismatch}}}",
        turned_damage.full,
        engine.tiled_renderer().map(|r| r.last_committed().len()).unwrap_or(0),
    );
    assert_eq!(turned_mismatch, 0, "rotated 117 pixels diverged from an independent full render");
}

fn main() {
    let started = Instant::now();
    println!(
        "{{\"event\":\"start\",\"rss_kib\":{},\"hwm_kib\":{}}}",
        rss_kib(),
        hwm_kib()
    );
    if std::env::var("ROTATE_SETTLE_ONLY").ok().as_deref() != Some("117") {
        let (doc, id) = plain_group();
        run("plain-group", doc, &id);
        let (doc, id) = clipped_group();
        run("clipped-group", doc, &id);
        let (doc, id) = masked_artboard();
        run("masked-artboard", doc, &id);
    }
    run_real_117();
    println!(
        "{{\"event\":\"done\",\"elapsed_s\":{:.3}}}",
        started.elapsed().as_secs_f64()
    );
}
