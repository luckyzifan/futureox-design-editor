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
        "schemaVersion": 2, "id": "editing-latency", "name": "editing-latency",
        "nodes": nodes,
        "pages": [{"id": "page", "name": "Page", "background": "#ffffff",
                   "children": (0..count).map(|i| i.to_string()).collect::<Vec<_>>()}],
    }))
    .unwrap()
}

fn p99(mut samples: Vec<f64>) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[samples.len() - 1]
}

fn gated(count: usize, width: u32, height: u32, iterations: usize, bound_ms: f64) {
    let mut engine = Engine::new();
    engine
        .load_document(&serde_json::to_string(&document(count)).unwrap())
        .unwrap();
    let options = serde_json::from_value(serde_json::json!({
        "pageId": "page", "width": width, "height": height,
        "view": {"x": 0, "y": 0, "zoom": 1}, "transparent": false, "grid": false,
    }))
    .unwrap();
    let template: Node = serde_json::from_value(serde_json::json!({
        "id": "0", "kind": "rectangle", "width": 60, "height": 40,
        "transform": [1, 0, 0, 1, 24., 24.],
        "fills": [{"kind": "solid", "color": "#4477dd", "opacity": 1}],
    }))
    .unwrap();
    let mut samples = Vec::with_capacity(iterations);
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
        if i >= 2 {
            samples.push(started.elapsed().as_secs_f64() * 1000.);
        }
    }
    let worst = p99(samples);
    assert!(
        worst <= bound_ms,
        "edit+full-frame latency regressed: nodes={count} viewport={width}x{height} p99={worst:.1}ms bound={bound_ms}ms"
    );
}

#[test]
fn editing_full_frame_latency_stays_within_regression_bounds() {
    gated(300, 800, 500, 8, 700.);
}
