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
use sha2::Digest;
use std::{collections::BTreeMap, time::Instant};

fn document(count: usize) -> String {
    document_with(count, 0)
}

/// `translucent_every` inserts translucent fills so opaque batchable leaves
/// form short runs instead of one long batch (`0` keeps every fill opaque).
fn document_with(count: usize, translucent_every: usize) -> String {
    let nodes: BTreeMap<String, Node> = (0..count)
        .map(|i| {
            let id = i.to_string();
            let opacity = if translucent_every > 0 && i % translucent_every < 2 {
                0.5
            } else {
                1.0
            };
            let node: Node = serde_json::from_value(serde_json::json!({
                "id": id, "kind": "rectangle",
                "width": 60 + (i % 7) * 4, "height": 40 + (i % 5) * 6,
                "transform": [1, 0, 0, 1, (i % 24) as f64 * 52. + 24., (i / 24) as f64 * 46. + 24.],
                "fills": [{"kind": "solid", "color": "#4477dd", "opacity": opacity}],
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

/// Cold-frame draw submissions for a scene whose opaque leaves form short
/// runs, so batch admission (not the shader) decides the draw count.
fn batched(gpu: &mut NativeGpu, label: &str, count: usize, translucent_every: usize) -> Result<(), String> {
    let mut engine = Engine::new();
    engine.load_document(&document_with(count, translucent_every)).unwrap();
    let options = options();
    let mut cache = TileCache::new();
    let warm = cache.render(gpu, &mut engine, &options)?;
    let digest: String = sha2::Sha256::digest(&warm.rgba)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    println!(
        "{label}: nodes={count} cold frame render_ms={:.2} tiles={} draw_calls={} compiles={} pixels={}",
        warm.render_ms,
        cache.stats.tiles_total,
        warm.draw_calls,
        cache.stats.scene_compiles + cache.stats.tile_compiles,
        &digest[..16],
    );
    Ok(())
}

/// Repeated identical frames (progressive tiles, pointer jitter): the retained
/// scene should answer them without another full-document compile.
fn repeated(gpu: &mut NativeGpu, label: &str, count: usize, iterations: usize) -> Result<(), String> {
    let mut engine = Engine::new();
    engine.load_document(&document(count)).unwrap();
    let options = options();
    let mut cache = TileCache::new();
    cache.render(gpu, &mut engine, &options)?;
    let mut samples = Vec::new();
    let (mut compiles, mut nodes, mut draws) = (0usize, 0usize, 0usize);
    for _ in 0..iterations {
        let started = Instant::now();
        let frame = cache.render(gpu, &mut engine, &options)?;
        samples.push(started.elapsed().as_secs_f64() * 1000.);
        compiles += cache.stats.scene_compiles + cache.stats.tile_compiles;
        nodes += cache.stats.compiled_nodes;
        draws += frame.draw_calls;
    }
    println!(
        "{label}: identical frames={iterations} compiles={compiles} compiled_nodes={nodes} draw_calls={draws} tiles_rendered={} tiles_cached={}",
        cache.stats.tiles_rendered, cache.stats.tiles_cached,
    );
    report(label, &samples);
    Ok(())
}

/// One edit touching leaves spread across the viewport: every tile is stale.
fn spread_edit(gpu: &mut NativeGpu, label: &str, count: usize, iterations: usize) -> Result<(), String> {
    let mut engine = Engine::new();
    engine.load_document(&document(count)).unwrap();
    let options = options();
    let mut cache = TileCache::new();
    cache.render(gpu, &mut engine, &options)?;
    let mut samples = Vec::new();
    let (mut compiles, mut nodes, mut draws, mut tiles) = (0usize, 0usize, 0usize, 0usize);
    for i in 0..iterations {
        let color = if i % 2 == 0 { "#dd4477" } else { "#4477dd" };
        let mut patch = BTreeMap::new();
        for id in (0..count).step_by(2) {
            let node: Node = serde_json::from_value(serde_json::json!({
                "id": id.to_string(), "kind": "rectangle",
                "width": 60 + (id % 7) * 4, "height": 40 + (id % 5) * 6,
                "transform": [1, 0, 0, 1, (id % 24) as f64 * 52. + 24., (id / 24) as f64 * 46. + 24.],
                "fills": [{"kind": "solid", "color": color, "opacity": 1}],
            }))
            .unwrap();
            patch.insert(id.to_string(), Some(node));
        }
        engine
            .apply_document_patch(&DocumentPatch { nodes: patch, fields: Default::default() })
            .unwrap();
        let started = Instant::now();
        let frame = cache.render(gpu, &mut engine, &options)?;
        samples.push(started.elapsed().as_secs_f64() * 1000.);
        compiles += cache.stats.scene_compiles + cache.stats.tile_compiles;
        nodes += cache.stats.compiled_nodes;
        draws += frame.draw_calls;
        tiles += cache.stats.tiles_rendered;
    }
    println!(
        "{label}: spread edits={iterations} compiles={compiles} compiled_nodes={nodes} tiles_rendered={tiles} draw_calls={draws}",
    );
    report(label, &samples);
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
    batched(&mut gpu, "batch-runs-3", 500, 5).unwrap();
    batched(&mut gpu, "batch-runs-3", 1500, 5).unwrap();
    repeated(&mut gpu, "repeated-frame", 1500, 10).unwrap();
    spread_edit(&mut gpu, "spread-edit", 1500, 6).unwrap();
}
