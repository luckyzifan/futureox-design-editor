//! Measure analytic pan-after-shrink follow lag on real 117.sketch.
//! Not a product entry point. Run with the release profile:
//! PAN_FOLLOW_117=1 cargo run --release -p futureox-design-kernel --example pan_follow_117
use futureox_design_kernel::render_cancellation::with_probe;
use futureox_design_kernel::scene::Document;
use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn substitute_fonts(doc: &mut Document) -> usize {
    let known = ["default"];
    let present = |id: &str| id == "default" || known.contains(&id);
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

fn blur_count(doc: &Document) -> usize {
    doc.nodes.values().filter(|n| {
        n.effects.iter().any(|e| e.visible && e.kind == "background-blur")
    }).count()
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
        "width": 1024,
        "height": 768,
        "view": { "x": view_x, "y": view_y, "zoom": zoom },
        "transparent": false,
        "grid": false,
        "rasterProfile": "analytic"
    }))
    .unwrap()
}

fn diff(a: &[u8], b: &[u8]) -> (usize, u8) {
    let mut bytes = 0usize;
    let mut max = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        let d = x.abs_diff(*y);
        if d > 0 {
            bytes += 1;
            max = max.max(d);
        }
    }
    (bytes, max)
}

fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.
}

fn main() {
    if std::env::var("PAN_FOLLOW_117").ok().as_deref() != Some("1") {
        eprintln!("set PAN_FOLLOW_117=1");
        return;
    }
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../testing/fixtures/user-regression-20261109/117.sketch"
    );
    let bytes = std::fs::read(path).expect("117.sketch");
    assert!(!bytes.starts_with(b"version https://git-lfs.github.com"), "lfs pointer");
    assert_eq!(bytes.len(), 5_013_257);
    let font = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
    ))
    .expect("font");
    let imported = Instant::now();
    let mut doc = futureox_design_kernel::interop::import_sketch_report(&bytes)
        .expect("import")
        .document;
    let import_ms = ms(imported);
    let nodes = doc.nodes.len();
    let blurs = blur_count(&doc);
    let substituted = substitute_fonts(&mut doc);
    let (board, bx, by, bw, bh) = artboard(&doc);
    let page = doc.pages[0].id.clone();
    eprintln!(
        "import_ms={import_ms:.1} nodes={nodes} background_blurs={blurs} font_subs={substituted} board={board} origin=({bx},{by}) size={bw}x{bh} page={page}"
    );
    let json = serde_json::to_string(&doc).unwrap();
    check_simple_grid();
    for round in 1..=3 {
        eprintln!("-- round {round}");
        measure_round(&json, &font, &page, bx, by);
    }
}

fn check_simple_grid() {
    let doc = json!({
        "schemaVersion": 1, "id": "d", "name": "grid",
        "pages": [{"id": "p", "name": "p", "children": ["r"], "background": "#ffffff"}],
        "nodes": {"r": {"id": "r", "kind": "rectangle", "transform": [1, 0, 0, 1, 16.0, 16.0],
            "width": 640.0, "height": 640.0, "fills": [{"kind": "solid", "color": "#3366aa"}]}}
    }).to_string();
    let mut engine = Engine::new();
    engine.load_document(&doc).unwrap();
    let options = options_of("p", -512., -256., 1.);
    let tiled = engine.render_tiled_frame(&options, None).unwrap();
    let full = engine.render(&options).unwrap();
    let (bytes, max) = diff(&tiled.rgba, &full);
    eprintln!("simple_grid differ_bytes={bytes} max_channel={max} visible={}", tiled.visible_tiles);
    assert_eq!(tiled.rgba, full, "coalesced analytic tiles must match the full frame");
}

fn options_of(page: &str, view_x: f64, view_y: f64, zoom: f64) -> RenderOptions {
    options(page, view_x, view_y, zoom)
}

fn measure_round(json: &str, font: &[u8], page: &str, bx: f64, by: f64) {
    let mut engine = Engine::new();
    engine.load_font(font).unwrap();
    engine.load_document(json).unwrap();
    engine.load_font(font).unwrap();

    // Top-left of the artboard at the viewport origin.
    let zoom4 = options(&page, -bx * 4., -by * 4., 4.);
    let zoom1 = options(&page, -bx, -by, 1.);
    let pan = options(&page, -bx - 768., -by - 384., 1.);

    let t = Instant::now();
    let z4 = engine.render_tiled_frame(&zoom4, None).unwrap();
    eprintln!(
        "zoom4_ms={:.1} tiles={} visible={} raster_count={} raster_ms={:?}",
        ms(t),
        z4.visible_tiles,
        z4.visible_tiles,
        z4.telemetry.rasterisation_count,
        z4.telemetry.rasterisation_duration_ms
    );

    let t = Instant::now();
    let z1 = engine.render_tiled_frame(&zoom1, None).unwrap();
    eprintln!(
        "zoom1_ms={:.1} visible={} raster_count={} raster_ms={:?}",
        ms(t),
        z1.visible_tiles,
        z1.telemetry.rasterisation_count,
        z1.telemetry.rasterisation_duration_ms
    );

    let t = Instant::now();
    let panned = engine.render_tiled_frame(&pan, None).unwrap();
    eprintln!(
        "pan_ms={:.1} visible={} raster_count={} raster_ms={:?}",
        ms(t),
        panned.visible_tiles,
        panned.telemetry.rasterisation_count,
        panned.telemetry.rasterisation_duration_ms
    );
    let t = Instant::now();
    let again = engine.render_tiled_frame(&pan, None).unwrap();
    eprintln!("pan_repeat_ms={:.1} visible={} raster_count={}", ms(t), again.visible_tiles, again.telemetry.rasterisation_count);

    let t = Instant::now();
    let mut fresh = Engine::new();
    fresh.load_font(&font).unwrap();
    fresh.load_document(&json).unwrap();
    fresh.load_font(&font).unwrap();
    let reference = fresh.render(&pan).unwrap();
    let (bytes, max) = diff(&panned.rgba, &reference);
    eprintln!("full_reference_ms={:.1} differ_bytes={bytes} max_channel={max} rgba={} ref={}", ms(t), panned.rgba.len(), reference.len());

    // Interrupt the zoom-out. A second thread raises the existing probe.
    // Current code either returns quickly or runs the whole frame.
    let mut interrupted = Engine::new();
    interrupted.load_font(&font).unwrap();
    interrupted.load_document(&json).unwrap();
    interrupted.load_font(&font).unwrap();
    let _ = interrupted.render_tiled_frame(&zoom4, None).unwrap();
    let flag = Arc::new(AtomicBool::new(false));
    let flag2 = flag.clone();
    let started = Instant::now();
    let signalled = Arc::new(std::sync::Mutex::new(None::<Instant>));
    let mark = signalled.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        *mark.lock().unwrap() = Some(Instant::now());
        flag2.store(true, Ordering::Release);
    });
    let probe = flag.clone();
    let outcome = with_probe(
        move || probe.load(Ordering::Acquire),
        || interrupted.render_tiled_frame(&zoom1, None),
    );
    let returned = Instant::now();
    let signal = *signalled.lock().unwrap();
    let abort_ms = signal.map(|s| returned.saturating_duration_since(s).as_secs_f64() * 1000.);
    eprintln!(
        "interrupt_wall_ms={:.1} abort_after_signal_ms={abort_ms:?} result={}",
        started.elapsed().as_secs_f64() * 1000.,
        outcome.as_ref().map(|f| format!("ok visible={}", f.visible_tiles)).unwrap_or_else(|e| e.clone())
    );
    let t = Instant::now();
    let followed = interrupted.render_tiled_frame(&pan, None).unwrap();
    let follow_ms = ms(t);
    let (bytes, max) = diff(&followed.rgba, &reference);
    eprintln!(
        "follow_after_interrupt_ms={follow_ms:.1} visible={} differ_bytes={bytes} max_channel={max}",
        followed.visible_tiles
    );
}
