//! Stage split for an integer pan on the CPU display path.
//!
//! `render_unretained` repaints the viewport. `render` and `render_tiled_frame`
//! keep world-anchored tiles and assemble them. The bench reports wall time,
//! newly rasterised tiles, and whether those bytes match the unretained frame.
//! `PAN_PROFILE=display|full` repeats one path for a sampler.
use futureox_design_kernel::fidelity::RasterProfile;
use futureox_design_kernel::tiled_renderer::RenderFeatureFlags;
use futureox_design_kernel::{Engine, RenderOptions, View};
use std::hint::black_box;
use std::time::Instant;

fn document(count: usize) -> String {
    let mut nodes = serde_json::Map::new();
    let mut roots = Vec::new();
    for i in 0..count {
        let id = format!("n{i}");
        roots.push(id.clone());
        nodes.insert(
            id.clone(),
            serde_json::json!({
                "id": id,
                "kind": "ellipse",
                "transform": [1, 0, 0, 1, (i % 16) as f64 * 72. + 8., (i / 16) as f64 * 64. + 8.],
                "width": 58. + (i % 5) as f64 * 6.,
                "height": 42. + (i % 4) as f64 * 5.,
                "fills": [{"kind": "solid", "color": "#5b6ee1", "opacity": 1}],
            }),
        );
    }
    serde_json::json!({
        "schemaVersion": 1,
        "id": "pan-residency",
        "name": "pan-residency",
        "pages": [{"id": "p", "name": "p", "background": "#ffffff", "children": roots}],
        "nodes": nodes,
    })
    .to_string()
}

fn options(profile: RasterProfile, view: View, grid: bool, checkerboard: bool) -> RenderOptions {
    RenderOptions {
        page_id: "p".into(),
        width: 960,
        height: 540,
        view,
        transparent: false,
        grid,
        pixel_preview: None,
        animation: None,
        raster_profile: profile,
        interactive_effects: false,
        checkerboard,
    }
}

fn percentile(samples: &[f64], q: f64) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[(q * (sorted.len() - 1) as f64).round() as usize]
}

fn engine() -> Engine {
    let mut engine = Engine::new();
    engine.load_document(&document(64)).expect("document");
    engine
}

/// Integer pans of 24 device pixels, then one pan that crosses a 512px tile.
fn views() -> Vec<View> {
    let mut views = Vec::new();
    for step in 0..8 {
        views.push(View { x: -(step as f64) * 24., y: -12., zoom: 1. });
    }
    views.push(View { x: -520., y: -12., zoom: 1. });
    views
}

fn time_full(profile: RasterProfile) -> Vec<f64> {
    let mut engine = engine();
    let mut samples = Vec::new();
    for view in views() {
        let options = options(profile, view, false, false);
        let started = Instant::now();
        black_box(engine.render_unretained(&options).expect("full render"));
        samples.push(started.elapsed().as_secs_f64() * 1000.);
    }
    samples
}

fn time_tiled(profile: RasterProfile, parallel: bool) -> (Vec<f64>, Vec<u64>) {
    let mut engine = engine();
    if !parallel {
        engine.tiled_renderer_mut().set_flags(RenderFeatureFlags {
            rasterize_concurrently: false,
            single_threaded_content_rendering: true,
            worker_limit: Some(1),
        });
    }
    let mut samples = Vec::new();
    let mut rasters = Vec::new();
    let mut previous = 0u64;
    for view in views() {
        let options = options(profile, view, false, false);
        let started = Instant::now();
        let frame = engine.render_tiled_frame(&options, None).expect("tiled frame");
        samples.push(started.elapsed().as_secs_f64() * 1000.);
        let count = frame.telemetry.rasterisation_count;
        rasters.push(count.saturating_sub(previous));
        previous = count;
        black_box(frame.rgba);
    }
    (samples, rasters)
}

fn differs(a: &[u8], b: &[u8]) -> usize {
    a.chunks_exact(4).zip(b.chunks_exact(4)).filter(|(p, q)| p != q).count()
}

fn parity(label: &str, profile: RasterProfile, view: View, grid: bool, checkerboard: bool) {
    let options = options(profile, view, grid, checkerboard);
    let mut full = engine();
    let mut tiled = engine();
    let a = full.render(&options).expect("oracle");
    let b = tiled.render_tiled_frame(&options, None).expect("tiled").rgba;
    let pixels = differs(&a, &b);
    println!(
        "parity {label}: bytes={} different_pixels={} match={}",
        a.len(),
        pixels,
        pixels == 0
    );
}

fn report(label: &str, samples: &[f64]) {
    println!(
        "{label}: n={} median_ms={:.3} p95_ms={:.3} max_ms={:.3} samples={:?}",
        samples.len(),
        percentile(samples, 0.5),
        percentile(samples, 0.95),
        samples.iter().copied().fold(0_f64, f64::max),
        samples.iter().map(|v| format!("{v:.3}")).collect::<Vec<_>>(),
    );
}

fn repeat(kind: &str, times: usize) {
    let profile = RasterProfile::Analytic;
    let mut engine = engine();
    let cycle = views();
    for i in 0..times {
        let view = cycle[i % cycle.len()];
        let options = options(profile, view, false, false);
        let frame = if kind == "display" {
            engine.render(&options).expect("display")
        } else {
            engine.render_unretained(&options).expect("full")
        };
        black_box(frame);
    }
}

fn main() {
    if let Ok(kind) = std::env::var("PAN_PROFILE") {
        let times: usize = std::env::var("PAN_TIMES").ok().and_then(|v| v.parse().ok()).unwrap_or(40);
        repeat(&kind, times);
        return;
    }
    let profile = RasterProfile::Analytic;
    parity("analytic-origin", profile, View { x: 0., y: 0., zoom: 1. }, false, false);
    parity("analytic-mid-tile", profile, View { x: -48., y: -20., zoom: 1. }, false, false);
    parity("analytic-grid", profile, View { x: -48., y: -20., zoom: 1. }, true, false);
    parity("analytic-checker", profile, View { x: -48., y: -20., zoom: 1. }, false, true);
    parity("analytic-fraction", profile, View { x: -48.25, y: -20.5, zoom: 1. }, false, false);
    parity("figma-subpixel", RasterProfile::FigmaSubpixel, View { x: -48., y: -20., zoom: 1. }, false, false);
    parity("figma", RasterProfile::Figma, View { x: -48., y: -20., zoom: 1. }, false, false);

    let full = time_full(profile);
    let (single, single_rasters) = time_tiled(profile, false);
    let (parallel, parallel_rasters) = time_tiled(profile, true);
    let mut display_engine = engine();
    let mut display = Vec::new();
    for view in views() {
        let options = options(profile, view, false, false);
        let started = Instant::now();
        black_box(display_engine.render(&options).expect("display"));
        display.push(started.elapsed().as_secs_f64() * 1000.);
    }
    println!(
        "views={}",
        views()
            .iter()
            .map(|view| format!("({:.2},{:.2},{:.2})", view.x, view.y, view.zoom))
            .collect::<Vec<_>>()
            .join(" ")
    );
    report("full-render", &full);
    report("tiled-single", &single);
    println!("tiled-single new_rasters={single_rasters:?}");
    report("tiled-parallel", &parallel);
    println!("tiled-parallel new_rasters={parallel_rasters:?}");
    // Sub-tile pans are samples 1..7 (sample 0 is cold, sample 8 crosses a tile).
    report("display-render", &display);
    report("full-render-subtile", &full[1..8]);
    report("tiled-single-subtile", &single[1..8]);
    report("tiled-parallel-subtile", &parallel[1..8]);
    report("display-render-subtile", &display[1..8]);
}
