//! GPU dirty-region tile cache benchmark at a 1080p viewport.
//!
//! For a typical edit (move one node / change one fill) it compares:
//!
//! * `full`   — `compile_gpu` + whole-frame `NativeGpu::render` (the current
//!   architecture: every edit recomposites the entire viewport);
//! * `cached` — `TileCache::render`, which fingerprints per-tile scene inputs
//!   and recomposites only tiles whose key changed;
//!
//! and checks the two paths produce identical bytes on every frame — the
//! bench doubles as a live parity gate. Run on a GPU host, release build.
use futureox_design_gpu::{Backends, NativeGpu, TileCache};
use futureox_design_kernel::{Engine, RenderOptions, editing::DocumentPatch, scene::Node};
use std::{collections::BTreeMap, time::Instant};

fn document(count: usize) -> String {
    let nodes: BTreeMap<String, Node> = (0..count)
        .map(|i| {
            let id = i.to_string();
            let node: Node = serde_json::from_value(serde_json::json!({
                "id": id, "kind": "rectangle",
                "width": 60 + (i % 7) * 4, "height": 40 + (i % 5) * 6,
                "transform": [1, 0, 0, 1, (i % 24) as f64 * 52. + 24., (i / 24) as f64 * 46. + 24.],
                "fills": [{"kind": "solid", "color": "#4477dd", "opacity": 1}],
            }))
            .unwrap();
            (id, node)
        })
        .collect();
    serde_json::json!({
        "schemaVersion": 2, "id": "gpu-dirty-bench", "name": "gpu-dirty-bench",
        "nodes": nodes,
        "pages": [{"id": "page", "name": "Page", "background": "#ffffff",
                   "children": (0..count).map(|i| i.to_string()).collect::<Vec<_>>()}],
    })
    .to_string()
}

fn options() -> RenderOptions {
    serde_json::from_value(serde_json::json!({
        "pageId": "page", "width": 1920, "height": 1080,
        "view": {"x": 0, "y": 0, "zoom": 1}, "transparent": false, "grid": false,
        "rasterProfile": "figmaSubpixel",
    }))
    .unwrap()
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    sorted[(q * (sorted.len() - 1) as f64).round() as usize]
}

fn report(label: &str, samples: &[f64]) {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    println!(
        "{label}: median_ms={:.2} p99_ms={:.2} max_ms={:.2} samples={}",
        percentile(&sorted, 0.5),
        percentile(&sorted, 0.99),
        sorted[sorted.len() - 1],
        sorted.len(),
    );
}

fn run(
    gpu: &mut NativeGpu,
    label: &str,
    count: usize,
    iterations: usize,
    mutate_fill: bool,
) -> Result<(), String> {
    let mut engine = Engine::new();
    engine.load_document(&document(count)).unwrap();
    let options = options();
    let mut cache = TileCache::new();
    let mut node: Node = serde_json::from_value(serde_json::json!({
        "id": "0", "kind": "rectangle", "width": 64, "height": 46,
        "transform": [1, 0, 0, 1, 24., 24.],
        "fills": [{"kind": "solid", "color": "#4477dd", "opacity": 1}],
    }))
    .unwrap();

    let mut full_samples = Vec::with_capacity(iterations);
    let mut cached_samples = Vec::with_capacity(iterations);
    // Warm the cache with one cold frame before measuring steady-state edits.
    let warm = cache.render(gpu, &mut engine, &options)?;
    println!(
        "{label}: nodes={count} cold frame render_ms={:.2} tiles={} draw_calls={} (full composition seeds the cache)",
        warm.render_ms, cache.stats.tiles_total, warm.draw_calls,
    );

    for i in 0..iterations {
        if mutate_fill {
            node.fills[0].color = if i % 2 == 0 {
                "#dd4477".into()
            } else {
                "#4477dd".into()
            };
        } else {
            node.transform.0[4] = 24. + (i % 12) as f64 * 7.;
        }
        let patch = DocumentPatch {
            nodes: BTreeMap::from([("0".to_string(), Some(node.clone()))]),
            fields: Default::default(),
        };
        engine.apply_document_patch(&patch).unwrap();

        let started = Instant::now();
        let scene = engine.compile_gpu(&options)?;
        let full = gpu.render(&scene)?;
        let full_ms = started.elapsed().as_secs_f64() * 1000.;

        let started = Instant::now();
        let cached = cache.render(gpu, &mut engine, &options)?;
        let cached_ms = started.elapsed().as_secs_f64() * 1000.;
        if full.rgba != cached.rgba {
            return Err(format!(
                "{label}: byte mismatch at iteration {i} ({} differing bytes)",
                full.rgba
                    .iter()
                    .zip(&cached.rgba)
                    .filter(|(a, b)| a != b)
                    .count()
            ));
        }
        if i >= 3 {
            full_samples.push(full_ms);
            cached_samples.push(cached_ms);
        }
    }
    println!(
        "{label}: steady-state cached render tiles_cached={} tiles_rendered={} key_ms={:.2} compile_ms={:.2}",
        cache.stats.tiles_cached,
        cache.stats.tiles_rendered,
        cache.stats.key_ms,
        cache.stats.compile_ms,
    );
    report(&format!("{label} full  "), &full_samples);
    report(&format!("{label} cached"), &cached_samples);
    Ok(())
}

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime for adapter discovery");
    let mut gpu = runtime
        .block_on(NativeGpu::new(Backends::PRIMARY))
        .expect("native GPU adapter");
    println!("adapter: {:?}", gpu.description());
    run(&mut gpu, "move-node", 500, 25, false).unwrap();
    run(&mut gpu, "fill-change", 500, 25, true).unwrap();
    run(&mut gpu, "move-node", 1500, 15, false).unwrap();
    run(&mut gpu, "fill-change", 1500, 15, true).unwrap();
}
