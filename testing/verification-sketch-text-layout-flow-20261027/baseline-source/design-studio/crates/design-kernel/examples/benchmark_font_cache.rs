//! Warm text-path cache contention; wall time includes barrier/join overhead.
use futureox_design_kernel::{font::Fonts, scene::Node};
use serde_json::json;
use std::{hint::black_box, sync::{Arc, Barrier}, time::Instant};

fn main() {
    let mut fonts = Fonts::new();
    fonts.load(&std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf")).unwrap()).unwrap();
    let nodes: Vec<Node> = (0..128).map(|i| serde_json::from_value(json!({
        "id":format!("t{i}"), "kind":"text", "width":600, "height":60,
        "fontSize":20, "text":format!("中文 Cache contention {i} ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
        "textStyle":{"wrap":true,"features":["kern"]}
    })).unwrap()).collect();
    for node in &nodes { fonts.node_path_shared(node).unwrap(); }
    let fonts = Arc::new(fonts); let nodes = Arc::new(nodes); let mut rows = Vec::new();
    for workers in [1,4,8] {
        let mut samples = Vec::new();
        for _ in 0..11 {
            let barrier = Arc::new(Barrier::new(workers+1));
            let handles: Vec<_> = (0..workers).map(|offset| {
                let (fonts,nodes,barrier)=(fonts.clone(),nodes.clone(),barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    for i in 0..(80_000/workers) { black_box(fonts.node_path_shared(&nodes[(i+offset)%nodes.len()]).unwrap()); }
                })
            }).collect();
            let start=Instant::now(); barrier.wait();
            for handle in handles { handle.join().unwrap(); }
            samples.push(start.elapsed().as_secs_f64()*1000.);
        }
        let mut measured=samples[2..].to_vec(); measured.sort_by(f64::total_cmp);
        rows.push(json!({"workers":workers,"hitsPerSample":80000,"p50Ms":measured[4],"p95Ms":measured[8],"samples":samples}));
    }
    println!("{}",serde_json::to_string_pretty(&json!({"rows":rows,"stats":fonts.text_path_cache_stats()})).unwrap());
}
