//! CPU-only paired allocation preflight. No private node IDs, image bytes,
//! request fields or file paths are emitted. Not GPU color/latency evidence.
//! Usage: profile_painter_capture_reads DOCUMENT FONT REQUEST_ARRAY_JSON
use futureox_design_kernel::{Engine,gpu::GpuScene};
use serde_json::{Value,json};

fn summary(scene: &GpuScene) -> Value {
    json!({"extent":scene.extent,"rootInputBox":scene.root_input_box,"pixels":scene.extent.pixels(),
        "nodeCount":scene.nodes.len(),"nodeRectPixels":scene.nodes.values().map(|n|n.rect.pixels()).sum::<usize>(),
        "childrenInputBoxes":scene.nodes.values().filter_map(|n|n.children_input_box).collect::<Vec<_>>(),
        "backdropCount":scene.nodes.values().filter(|n|n.backdrop_output_box.is_some()).count(),
        "filteredSourceSizes":scene.nodes.values().filter(|n|n.effects.iter().any(|e|e.visible&&e.kind=="blur"))
            .map(|n|json!({"width":n.rect.w,"height":n.rect.h})).collect::<Vec<_>>()})
}
fn main() -> Result<(),Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len()!=4 { return Err("Expected DOCUMENT FONT REQUEST_ARRAY_JSON".into()); }
    let document = std::fs::read_to_string(&args[1])?;
    let font = std::fs::read(&args[2])?;
    let requests: Vec<Value> = serde_json::from_slice(&std::fs::read(&args[3])?)?;
    if requests.is_empty() || requests.len()>32 { return Err("Expected 1..32 requests".into()); }
    let mut engine = Engine::new(); engine.load_font(&font)?; engine.load_document(&document)?;
    let mut rows = Vec::new();
    for (index,request) in requests.into_iter().enumerate() {
        let mut request = request; request["gpuPainterSupport"] = json!(true);
        request["gpuPainterCaptureReads"] = json!(false);
        let previous = engine.compile_gpu_request(&request.to_string())?;
        request["gpuPainterCaptureReads"] = json!(true);
        let current = engine.compile_gpu_request(&request.to_string())?;
        let mut box_changes = 0; let mut checked_boxes = 0; let mut matrix_changes = 0; let mut effect_changes = 0;
        for (id,n) in &current.nodes {
            let Some(old) = previous.nodes.get(id) else { return Err("Capture-read candidate introduced a new node".into()); };
            if n.effects.iter().any(|e|e.visible&&e.kind=="background-blur") {
                checked_boxes+=1;
                if n.backdrop_box.map(f64::to_bits)!=old.backdrop_box.map(f64::to_bits) { box_changes+=1; }
            }
            if n.matrix.0.map(f64::to_bits)!=old.matrix.0.map(f64::to_bits) { matrix_changes+=1; }
            if serde_json::to_value(&n.effects)?!=serde_json::to_value(&old.effects)? { effect_changes+=1; }
        }
        request["gpuPainterCaptureReads"] = json!(false);
        let restored = engine.compile_gpu_request(&request.to_string())?;
        let restored_equal = serde_json::to_value(&previous)?==serde_json::to_value(&restored)?;
        if box_changes!=0 || matrix_changes!=0 || effect_changes!=0 || !restored_equal {
            return Err("Capture-read crop changed frozen capture/policy or contaminated the phase-three cache".into());
        }
        rows.push(json!({"requestIndex":index,"phaseThree":summary(&previous),"captureReads":summary(&current),
            "checkedBackdropBoxes":checked_boxes,"backdropBoxBitChanges":box_changes,"matrixBitChanges":matrix_changes,
            "effectFieldChanges":effect_changes,"phaseThreeRestoredExactly":restored_equal}));
    }
    println!("{}",serde_json::to_string_pretty(&json!({"gpuExecuted":false,"rows":rows,
        "scope":"Native CPU dependency/allocation metadata only; GPU raw color and complex app acceptance remain required"}))?);
    Ok(())
}
