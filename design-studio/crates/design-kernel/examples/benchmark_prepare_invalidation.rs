//! Isolated native CPU cache-invalidation benchmark. No GPU/presentation claim.
//! Setup and packet oracles are outside all measured windows.
use futureox_design_kernel::{Engine, math::Transform};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{hint::black_box, time::Instant};

fn fixture(count: usize) -> Value {
    let mut nodes = serde_json::Map::new();
    let mut children = Vec::new();
    for i in 0..count {
        let id = format!("node-{i:05}");
        children.push(id.clone());
        nodes.insert(id.clone(), json!({"id":id,"kind":"rectangle","width":5,"height":5,
            "transform":[1,0,0,1,(i%80)*8,(i/80)*8],
            "fills":[{"kind":"solid","color":"#527acc"}],
            "strokes":[{"width":0.5,"paint":{"kind":"solid","color":"#203040"}}]}));
    }
    json!({"schemaVersion":1,"id":"prepare-invalidation","name":"Prepare invalidation",
        "pages":[{"id":"p","name":"Page","children":children,"background":"#ffffff"}],"nodes":nodes})
}

fn request(x: f64) -> String {
    json!({"pageId":"p","width":514,"height":514,
        "view":{"x":x,"y":0.375,"zoom":1.25},"rasterProfile":"figmaSubpixel",
        "gpuViewport":{"x":-1,"y":-1,"w":514,"h":514},
        "prepareViewport":{"x":-1,"y":-1,"w":1100,"h":1800}}).to_string()
}

fn stats(mut values: Vec<f64>) -> Value {
    values.sort_by(f64::total_cmp);
    json!({"p50Ms":values[values.len()/2],"p95Ms":values[(values.len()-1)*95/100],"samplesMs":values})
}

fn hash(bytes: &[u8]) -> String { (Sha256::digest(bytes)).iter().map(|b| format!("{b:02x}")).collect::<String>() }

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut rows = Vec::new();
    for count in [3000, 10000] {
        let mut document = fixture(count);
        let input = document.to_string();
        let request = request(0.125);
        let mut loads = Vec::new();
        let mut initial = Vec::new();
        for sample in 0..15 {
            let mut fresh = Engine::new();
            let start = Instant::now();
            fresh.load_document(&input)?;
            let loaded = start.elapsed().as_secs_f64()*1000.;
            let start = Instant::now();
            black_box(fresh.compile_gpu_request(&request)?);
            let compiled = start.elapsed().as_secs_f64()*1000.;
            if sample >= 4 { loads.push(loaded); initial.push(compiled); }
        }
        let mut engine = Engine::new();
        engine.load_document(&input)?;
        engine.compile_gpu_request(&request)?;
        let mut changes = Vec::new();
        let mut compiles = Vec::new();
        let mut total = Vec::new();
        let mut last = Transform::default();
        for sample in 0..36 {
            let mut change_ms = 0.;
            let mut compile_ms = 0.;
            for j in 0..4 {
                last = Transform([1.,0.,0.,1.,((sample*4+j)%3) as f64*0.375,0.125]);
                let transforms = [("node-00000".into(),last)].into_iter().collect();
                let start = Instant::now();
                assert!(engine.apply_interaction_transforms(&transforms)?);
                change_ms += start.elapsed().as_secs_f64()*1000.;
                let start = Instant::now();
                black_box(engine.compile_gpu_request(&request)?);
                compile_ms += start.elapsed().as_secs_f64()*1000.;
            }
            if sample >= 5 {
                changes.push(change_ms/4.);
                compiles.push(compile_ms/4.);
                total.push((change_ms+compile_ms)/4.);
            }
        }
        document["nodes"]["node-00000"]["transform"] = json!(last);
        let actual = engine.compile_gpu_request(&request)?.into_packet()?;
        let mut fresh = Engine::new();
        fresh.load_document(&document.to_string())?;
        assert_eq!(actual, fresh.compile_gpu_request(&request)?.into_packet()?);
        let camera_requests: Vec<_> = (0..4).map(|i| self::request(0.125-i as f64*32.)).collect();
        let mut cameras = Vec::new();
        for sample in 0..36 {
            let start = Instant::now();
            for request in &camera_requests { black_box(engine.compile_gpu_request(request)?); }
            if sample >= 5 { cameras.push(start.elapsed().as_secs_f64()*1000./4.); }
        }
        for request in &camera_requests {
            let mut reference = Engine::new();
            reference.load_document(&document.to_string())?;
            assert_eq!(engine.compile_gpu_request(request)?.into_packet()?, reference.compile_gpu_request(request)?.into_packet()?);
        }
        rows.push(json!({"nodes":count,"fixtureSha256":hash(input.as_bytes()),
            "packetSha256":hash(&actual),"packetBytes":actual.len(),
            "load":stats(loads),"firstCompile":stats(initial),"transform":stats(changes),
            "compileAfterTransform":stats(compiles),"transformAndCompile":stats(total),
            "rapidCameraCycle":stats(cameras),"cache":engine.gpu_compile_cache_stats()}));
    }
    println!("{}",serde_json::to_string_pretty(&json!({"profile":if cfg!(debug_assertions){"debug"}else{"optimized"},
        "scope":"Native CPU preparation only; packet equality with fresh engines; no GPU or presentation timing", "rows":rows}))?);
    Ok(())
}
