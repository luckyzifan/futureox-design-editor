//! Same-host native preparation benchmark. No GPU/presentation performance claim.
//! Fixture setup, byte hashing, and fresh-engine correctness checks are untimed.
use futureox_design_kernel::{Engine, math::Transform};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{hint::black_box, time::Instant};

fn fixture(count: usize) -> Value {
    let mut nodes = serde_json::Map::new();
    let mut children = Vec::new();
    for i in 0..count {
        let id = format!("node-{i:05}"); children.push(id.clone());
        nodes.insert(id.clone(), json!({"id":id,"kind":"rectangle","width":5,"height":5,
            "transform":[1,0,0,1,(i%80)*8,(i/80)*8],
            "fills":[{"kind":"solid","color":"#527acc"}],
            "strokes":[{"width":0.5,"paint":{"kind":"solid","color":"#203040"}}]}));
    }
    json!({"schemaVersion":1,"id":"prepare-reuse","name":"Prepare reuse",
        "pages":[{"id":"p","name":"Page","children":children,"background":"#ffffff"}],"nodes":nodes})
}
fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut rows = Vec::new();
    for count in [3500, 10000] {
        let mut document = fixture(count); let input = document.to_string();
        let mut engine = Engine::new(); engine.load_document(&input)?;
        let request = json!({"pageId":"p","width":514,"height":514,"view":{"x":0.125,"y":0.375,"zoom":1.25},
            "rasterProfile":"figmaSubpixel","gpuViewport":{"x":-1,"y":-1,"w":514,"h":514},
            "prepareViewport":{"x":-1,"y":-1,"w":1100,"h":1800}}).to_string();
        engine.compile_gpu_request(&request)?;
        let mut samples = Vec::new(); let mut phase = 0;
        for sample in 0..36 {
            let start = Instant::now();
            for _ in 0..4 {
                phase += 1;
                let transform = Transform([1.,0.,0.,1.,(phase%3) as f64 * 0.375,0.125]);
                assert!(engine.apply_interaction_transforms(&[("node-00000".into(),transform)].into_iter().collect())?);
                black_box(engine.compile_gpu_request(&request)?);
            }
            if sample >= 5 { samples.push(start.elapsed().as_secs_f64()*1000./4.); }
        }
        document["nodes"]["node-00000"]["transform"] = json!([1,0,0,1,(phase%3) as f64*0.375,0.125]);
        let actual = engine.compile_gpu_request(&request)?.into_packet()?;
        let mut fresh = Engine::new(); fresh.load_document(&document.to_string())?;
        let expected = fresh.compile_gpu_request(&request)?.into_packet()?;
        assert_eq!(actual, expected, "full packet oracle for {count} nodes");
        samples.sort_by(f64::total_cmp);
        rows.push(json!({"nodes":count,"fixtureSha256":hash(input.as_bytes()),"packetSha256":hash(&actual),
            "packetBytes":actual.len(),"p50Ms":samples[15],"p95Ms":samples[29],"samplesMs":samples,
            "cache":engine.gpu_compile_cache_stats()}));
    }
    println!("{}", serde_json::to_string_pretty(&json!({"profile":if cfg!(debug_assertions){"debug"}else{"optimized"},
        "scope":"Native CPU transform plus exact regional compilation; no GPU or presentation timings", "warmupBatches":5,"batch":4,"rows":rows}))?);
    Ok(())
}
