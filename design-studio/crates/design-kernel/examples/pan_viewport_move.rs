//! Release profile of a warm hand-pan on a real Sketch board.
//! Not a product entry point.
//! PAN_VIEWPORT=1 cargo run --release -p futureox-design-kernel --example pan_viewport_move
use futureox_design_kernel::scene::Document;
use futureox_design_kernel::tiled_renderer::UpdateStatus;
use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::json;
use std::time::Instant;

fn main() {
    if std::env::var("PAN_VIEWPORT").ok().as_deref() != Some("1") {
        eprintln!("set PAN_VIEWPORT=1");
        return;
    }
    let path = std::env::var("PAN_VIEWPORT_FILE").unwrap_or_else(|_| {
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../testing/fixtures/sketch-public-20261105/ui-design-kit/[Legacy] WFP UI Kit.sketch"
        )
        .to_owned()
    });
    let bytes = std::fs::read(&path).expect("sketch");
    assert!(!bytes.starts_with(b"version https://git-lfs.github.com"), "lfs pointer");
    let font = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
    ))
    .expect("font");
    let imported = Instant::now();
    let mut doc = futureox_design_kernel::interop::import_sketch_report(&bytes)
        .expect("import")
        .document;
    substitute_fonts(&mut doc);
    let import_ms = imported.elapsed().as_secs_f64() * 1000.0;
    let (board, bx, by, bw, bh) = artboard(&doc);
    let page = doc.pages[0].id.clone();
    eprintln!(
        "file={path} import_ms={import_ms:.1} nodes={} board={board} origin=({bx},{by}) size={bw}x{bh}",
        doc.nodes.len()
    );
    let json = serde_json::to_string(&doc).unwrap();
    // 432 inputs over 3.59s is the owner's hand-pan script: about 2.4 CSS px
    // per sample at 120 Hz. Keep that step on a warm viewport.
    let steps = 432usize;
    let dx = 2.4f64;
    let rounds = std::env::var("PAN_VIEWPORT_ROUNDS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1);
    pan_loop(&json, &font, &page, bx, by, steps, dx, rounds);
}

fn substitute_fonts(doc: &mut Document) {
    let present = |id: &str| id == "default";
    for node in doc.nodes.values_mut() {
        if let Some(style) = node.text_style.as_mut() {
            if !present(&style.font_id) {
                style.font_id = "default".into();
            }
            style.fallbacks.retain(|id| present(id));
        }
        for run in &mut node.text_runs {
            if run.font_id.as_deref().is_some_and(|id| !present(id)) {
                run.font_id = Some("default".into());
            }
        }
    }
}

fn artboard(doc: &Document) -> (String, f64, f64, f64, f64) {
    let page = &doc.pages[0];
    let mut best: Option<(&str, f64, f64, f64, f64, f64)> = None;
    for id in &page.children {
        let n = &doc.nodes[id];
        let area = n.width * n.height;
        if best.as_ref().is_none_or(|b| area > b.5) {
            best = Some((id.as_str(), n.transform.0[4], n.transform.0[5], n.width, n.height, area));
        }
    }
    let (id, x, y, w, h, _) = best.expect("page child");
    (id.to_owned(), x, y, w, h)
}

fn options(page: &str, view_x: f64, view_y: f64, zoom: f64) -> RenderOptions {
    serde_json::from_value(json!({
        "pageId": page,
        "width": 1440,
        "height": 900,
        "view": { "x": view_x, "y": view_y, "zoom": zoom },
        "transparent": false,
        "grid": false,
        "rasterProfile": "analytic"
    }))
    .unwrap()
}

fn pan_loop(json: &str, font: &[u8], page: &str, bx: f64, by: f64, steps: usize, dx: f64, rounds: usize) {
    let mut engine = Engine::new();
    engine.load_font(font).unwrap();
    engine.load_document(json).unwrap();
    engine.load_font(font).unwrap();
    let warm = options(page, -bx, -by, 1.0);
    let warmed = Instant::now();
    let first = engine.render_tiled_frame(&warm, None).expect("warm frame");
    eprintln!(
        "warm_ms={:.1} visible={} raster_count={} raster_ms={:?} rgba_bytes={}",
        warmed.elapsed().as_secs_f64() * 1000.0,
        first.visible_tiles,
        first.telemetry.rasterisation_count,
        first.telemetry.rasterisation_duration_ms,
        first.rgba.len()
    );
    let mut samples = Vec::with_capacity(steps * rounds);
    let mut unchanged = 0usize;
    for _ in 0..rounds {
        for step in 0..steps {
            let view_x = -bx + dx * step as f64;
            let frame = options(page, view_x, -by, 1.0);
            let started = Instant::now();
            let painted = engine.render_tiled_frame(&frame, None).expect("pan frame");
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            if painted.status == UpdateStatus::NoChange {
                unchanged += 1;
            }
            samples.push((ms, painted.visible_tiles));
        }
    }
    samples.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let sum: f64 = samples.iter().map(|s| s.0).sum();
    let p95 = samples[(samples.len() as f64 * 0.95) as usize].0;
    eprintln!(
        "pan_steps={} mean_ms={:.3} p95_ms={:.3} max_ms={:.3} unchanged={unchanged} visible={}",
        samples.len(),
        sum / samples.len() as f64,
        p95,
        samples.last().unwrap().0,
        samples[0].1
    );
}
