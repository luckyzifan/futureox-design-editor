//! CPU-only supplied-document packet preflight. No GPU execution or timing claim.
//! Usage: profile_painter_support_regions DOCUMENT FONT REQUEST_ARRAY_JSON
//! Keep private documents and request/output identifiers outside source control.
use futureox_design_kernel::Engine;
use serde_json::{Value,json};
fn main() -> Result<(),Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 4 { return Err("expected DOCUMENT FONT REQUEST_ARRAY_JSON".into()); }
    let mut engine = Engine::new();
    engine.load_font(&std::fs::read(&args[2])?)?;
    engine.load_document(&std::fs::read_to_string(&args[1])?)?;
    let requests: Vec<Value> = serde_json::from_slice(&std::fs::read(&args[3])?)?;
    let mut rows = Vec::new();
    for (index,request) in requests.iter().enumerate() {
        let started = std::time::Instant::now();
        let result = engine.compile_gpu_request(&request.to_string());
        let elapsed = started.elapsed().as_secs_f64()*1000.;
        rows.push(match result {
            Ok(scene) => json!({"requestIndex":index,"success":true,"compileMs":elapsed,
                "extent":scene.extent,"output":scene.output,"pixels":scene.extent.pixels(),
                "nodeCount":scene.nodes.len(),"integratedBlur":scene.integrated_blur,
                "floatCompositing":scene.float_compositing,"coherentSamples":scene.coherent_samples,
                "filteredNodes":scene.nodes.values().filter(|n| !n.effects.is_empty()).map(|n|
                    json!({"id":n.id,"rect":n.rect,"matrix":n.matrix,
                        "backdropBox":n.backdrop_box,"backdropOutputBox":n.backdrop_output_box,
                        "shadowOutputBox":n.shadow_output_box,
                        "effects":n.effects})).collect::<Vec<_>>()}),
            Err(error) => json!({"requestIndex":index,"success":false,"error":error,"compileMs":elapsed}),
        });
    }
    println!("{}",serde_json::to_string_pretty(&json!({"gpuExecuted":false,"rows":rows}))?);
    Ok(())
}
