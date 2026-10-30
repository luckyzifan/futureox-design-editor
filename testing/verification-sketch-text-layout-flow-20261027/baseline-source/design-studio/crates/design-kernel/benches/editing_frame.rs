//! End-to-end editing latency: patch apply + full-frame re-render.
//!
//! Measures the interactive-editing cost contract for the editor client:
//! one small document patch followed by one whole-viewport re-render, the
//! current worst case (no dirty-region reuse yet). Reports median and P99
//! per viewport so tile-cache work has a stable baseline. Run with
//! `cargo bench`-style release builds; numbers are host-dependent.
use futureox_design_kernel::{Engine, editing::DocumentPatch, scene::Node};
use std::{collections::BTreeMap, time::Instant};

fn document(count: usize) -> futureox_design_kernel::scene::Document {
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
        "schemaVersion": 2, "id": "editing-frame-bench", "name": "editing-frame-bench",
        "nodes": nodes,
        "pages": [{"id": "page", "name": "Page", "background": "#ffffff",
                   "children": (0..count).map(|i| i.to_string()).collect::<Vec<_>>()}],
    }))
    .unwrap()
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    sorted[(q * (sorted.len() - 1) as f64).round() as usize]
}

fn run(label: &str, count: usize, width: u32, height: u32, iterations: usize) {
    let mut engine = Engine::new();
    engine
        .load_document(&serde_json::to_string(&document(count)).unwrap())
        .unwrap();
    let options = serde_json::from_value(serde_json::json!({
        "pageId": "page", "width": width, "height": height,
        "view": {"x": 0, "y": 0, "zoom": 1}, "transparent": false, "grid": false,
    }))
    .unwrap();
    let mut samples: Vec<f64> = Vec::with_capacity(iterations);
    let template: Node = serde_json::from_value(serde_json::json!({
        "id": "0", "kind": "rectangle", "width": 60, "height": 40,
        "transform": [1, 0, 0, 1, 24., 24.],
        "fills": [{"kind": "solid", "color": "#4477dd", "opacity": 1}],
    }))
    .unwrap();
    for i in 0..iterations {
        let mut node = template.clone();
        node.transform.0[4] = 24. + (i % 8) as f64 * 3.;
        let patch = DocumentPatch {
            nodes: BTreeMap::from([("0".to_string(), Some(node))]),
            fields: Default::default(),
        };
        let started = Instant::now();
        engine.apply_document_patch(&patch).unwrap();
        engine.render(&options).unwrap();
        if i >= 3 {
            samples.push(started.elapsed().as_secs_f64() * 1000.);
        }
    }
    samples.sort_by(f64::total_cmp);
    println!(
        "{label}: nodes={count} viewport={width}x{height} median_ms={:.2} p99_ms={:.2} max_ms={:.2} samples={}",
        percentile(&samples, 0.5),
        percentile(&samples, 0.99),
        samples[samples.len() - 1],
        samples.len(),
    );
}

fn main() {
    run("edit+render", 200, 1280, 800, 40);
    run("edit+render", 500, 1920, 1080, 40);
    run("edit+render", 1500, 1920, 1080, 20);
}
