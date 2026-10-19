//! Dirty-region editing benchmark: full-frame repaint vs dirty-tile repaint.
//!
//! Quantifies the editing-latency contract at a 1080p viewport for two
//! typical ops — moving one node and changing one fill. For each op it
//! reports:
//!
//! * `full`   — patch + whole-viewport re-render (today's behaviour);
//! * `dirty`  — patch + `dirty_region` derivation + re-render of only the
//!   dirty tiles, on the renderer's own 512 px stitching grid (a full render
//!   is itself stitched from those tiles, so the bytes coincide);
//! * `derive` — the dirty-region derivation alone.
//!
//! Fill edits have no dedicated op verb in the op log (patch application
//! replaces the whole node), so the fill scenario targets the node with a
//! representative op; the derivation dirties the target's footprint in both
//! revisions regardless of verb. Numbers are host-dependent; run release.
use futureox_design_kernel::{
    Engine, RenderOptions,
    dirty_region::{TileGrid, dirty_region},
    editing::DocumentPatch,
    ops::Op,
    scene::{Document, Node},
};
use std::{collections::BTreeMap, time::Instant};

/// Renderer's own stitching grid for byte-identical partial repaints.
const TILE: u32 = 512;

fn document(count: usize) -> Document {
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
    serde_json::from_value(serde_json::json!({
        "schemaVersion": 2, "id": "dirty-bench", "name": "dirty-bench",
        "nodes": nodes,
        "pages": [{"id": "page", "name": "Page", "background": "#ffffff",
                   "children": (0..count).map(|i| i.to_string()).collect::<Vec<_>>()}],
    }))
    .unwrap()
}

fn options(width: u32, height: u32) -> RenderOptions {
    serde_json::from_value(serde_json::json!({
        "pageId": "page", "width": width, "height": height,
        "view": {"x": 0, "y": 0, "zoom": 1}, "transparent": false, "grid": false,
        "rasterProfile": "figma",
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

fn run(label: &str, count: usize, width: u32, height: u32, iterations: usize, mutate_fill: bool) {
    let mut engine = Engine::new();
    let mut doc = document(count);
    engine
        .load_document(&serde_json::to_string(&doc).unwrap())
        .unwrap();
    let options = options(width, height);
    let grid = TileGrid::new(1., [0., 0.], 4096);
    let viewport = [0., 0., f64::from(width), f64::from(height)];

    let mut full_samples = Vec::with_capacity(iterations);
    let mut dirty_samples = Vec::with_capacity(iterations);
    let mut derive_samples = Vec::with_capacity(iterations);
    let mut dirty_tile_counts = Vec::with_capacity(iterations);
    let mut node: Node = serde_json::from_value(serde_json::json!({
        "id": "0", "kind": "rectangle", "width": 64, "height": 46,
        "transform": [1, 0, 0, 1, 24., 24.],
        "fills": [{"kind": "solid", "color": "#4477dd", "opacity": 1}],
    }))
    .unwrap();

    for i in 0..iterations {
        // One typical edit: move the node, or change its fill colour.
        if mutate_fill {
            node.fills[0].color = if i % 2 == 0 {
                "#dd4477".into()
            } else {
                "#4477dd".into()
            };
        } else {
            node.transform.0[4] = 24. + (i % 12) as f64 * 7.;
        }
        let before = doc.clone();
        doc.nodes.insert("0".into(), node.clone());
        let after = doc.clone();
        // The derivation needs a target op; any op naming the edited node
        // produces the same footprint union of both revisions.
        let op = Op::SetTransform {
            id: "0".into(),
            matrix: node.transform.0,
        };
        let patch = DocumentPatch {
            nodes: BTreeMap::from([("0".to_string(), Some(node.clone()))]),
            fields: Default::default(),
        };

        // Full-frame path: patch + whole-viewport render.
        let started = Instant::now();
        engine.apply_document_patch(&patch).unwrap();
        let _full_frame = engine.render(&options).unwrap();
        if i >= 3 {
            full_samples.push(started.elapsed().as_secs_f64() * 1000.);
        }

        // Dirty path on the same edit: derive, repaint only dirty tiles.
        let derive_started = Instant::now();
        let region = dirty_region(&before, &after, std::slice::from_ref(&op), &grid, viewport);
        let derive_ms = derive_started.elapsed().as_secs_f64() * 1000.;
        assert!(!region.full, "derivation must bound these edits");
        let mut dirty_ms = derive_ms;
        let mut tiles_touched = 0usize;
        if !region.tiles.is_empty() {
            let repaint = Instant::now();
            let bounds = region.world_bounds.expect("bounded region carries bounds");
            let x0 = (bounds[0].max(0.).floor() as u32 / TILE) * TILE;
            let y0 = (bounds[1].max(0.).floor() as u32 / TILE) * TILE;
            let x1 = (bounds[0] + bounds[2]).ceil().max(0.) as u32;
            let y1 = (bounds[1] + bounds[3]).ceil().max(0.) as u32;
            let mut ty = y0;
            while ty < y1.min(options.height) {
                let mut tx = x0;
                while tx < x1.min(options.width) {
                    let w = TILE.min(options.width - tx);
                    let h = TILE.min(options.height - ty);
                    let _ = engine.render_device_rect(&options, tx, ty, w, h).unwrap();
                    tiles_touched += 1;
                    tx += TILE;
                }
                ty += TILE;
            }
            dirty_ms += repaint.elapsed().as_secs_f64() * 1000.;
        }
        if i >= 3 {
            derive_samples.push(derive_ms);
            dirty_samples.push(dirty_ms);
            dirty_tile_counts.push(tiles_touched);
        }
    }
    let all_tiles = (width.div_ceil(TILE) * height.div_ceil(TILE)) as usize;
    println!(
        "{label}: nodes={count} viewport={width}x{height} dirty_512tiles={}/{} (viewport grid)",
        dirty_tile_counts.iter().sum::<usize>() / dirty_tile_counts.len().max(1),
        all_tiles,
    );
    report(&format!("{label} full  "), &full_samples);
    report(&format!("{label} dirty "), &dirty_samples);
    report(&format!("{label} derive"), &derive_samples);
}

fn main() {
    run("move-node", 500, 1920, 1080, 30, false);
    run("fill-change", 500, 1920, 1080, 30, true);
    run("move-node", 1500, 1920, 1080, 20, false);
    run("fill-change", 1500, 1920, 1080, 20, true);
}
