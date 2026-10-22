//! CPU packet/dependency checks only; independent actual GPU pixels are a
//! separate gate. No shader, coefficient, capture origin or authored edit changes.
use futureox_design_kernel::{Engine, color::ColorSettings, gpu::GpuScene};
use serde_json::{Value,json};
use base64::Engine as _;

fn document() -> Value {
    json!({"schemaVersion":9,"id":"capture-read-proof","name":"capture read proof",
        "colorManagement":ColorSettings::default(),
        "pages":[{"id":"p","name":"p","background":"#123456","children":["source","bg"]}],
        "nodes":{
            "source":{"id":"source","kind":"rectangle","width":512,"height":512,
                "transform":[1,0,0,1,-256,-256],"fills":[{"kind":"solid","color":"#c87845","opacity":0.5}],
                "effects":[{"kind":"blur","color":"#000000","radius":9.125}]},
            "bg":{"id":"bg","kind":"rectangle","width":256,"height":128,
                "transform":[1,0,0,1,0.125,32.25],"fills":[{"kind":"solid","color":"#abcdef","opacity":0.2}],
                "effects":[{"kind":"background-blur","color":"#000000","radius":64.25}]}
        }})
}
fn request() -> Value {
    json!({"pageId":"p","width":64,"height":64,"view":{"x":0,"y":0,"zoom":1},
        "rasterProfile":"figmaSubpixel","interactiveEffects":false,
        "gpuViewport":{"x":0,"y":0,"w":64,"h":64},"gpuPainterSupport":true})
}
fn compile(doc: &Value, phase_four: bool) -> GpuScene {
    let mut engine = Engine::new(); engine.load_document(&doc.to_string()).unwrap();
    let mut r = request(); r["gpuPainterCaptureReads"] = json!(phase_four);
    engine.compile_gpu_request(&r.to_string()).unwrap()
}
fn bits(a: [f64;4]) -> [u64;4] { a.map(f64::to_bits) }
fn paint_policy(node: &futureox_design_kernel::gpu::GpuNode) -> Value {
    let paints = serde_json::to_value(&node.fills).unwrap();
    json!(paints.as_array().unwrap().iter().map(|p|json!({"kind":p["kind"],"image":p["image"],
        "transform":p["transform"],"opacity":p["opacity"],"color":p["color"]})).collect::<Vec<_>>())
}
fn image_uri() -> String {
    let image = image::RgbaImage::from_pixel(2,2,image::Rgba([127,85,51,255]));
    let mut output = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image).write_to(&mut output,image::ImageFormat::Png).unwrap();
    format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(output.into_inner()))
}
fn verify_boxes(previous: &GpuScene, next: &GpuScene) {
    for (id, node) in &next.nodes {
        if node.effects.iter().any(|e|e.visible&&e.kind=="background-blur") {
            assert_eq!(bits(node.backdrop_box),bits(previous.nodes[id].backdrop_box));
        }
        let old = &previous.nodes[id];
        assert_eq!(node.matrix,old.matrix);
        assert_eq!(paint_policy(node),paint_policy(old));
        assert_eq!(serde_json::to_value(&node.effects).unwrap(),serde_json::to_value(&old.effects).unwrap());
    }
}

#[test]
fn painter_capture_reads_box_bits_stay_fixed_while_prefix_and_earlier_filter_source_shrink() {
    let doc = document(); let old = compile(&doc,false); let tight = compile(&doc,true);
    verify_boxes(&old,&tight);
    let a = old.root_input_box.unwrap(); let b = tight.root_input_box.unwrap();
    assert!(b[2]*b[3] < a[2]*a[3],"old={a:?},new={b:?}");
    assert!(tight.nodes["source"].rect.pixels() < old.nodes["source"].rect.pixels());
    assert!(tight.extent.pixels() <= old.extent.pixels());
    assert!(tight.extent.pixels() <= 16_777_216);
    assert_eq!(tight.output,old.output);
}

#[test]
fn painter_capture_reads_multiple_backdrops_freeze_each_original_logical_capture_and_keep_output() {
    let mut d = document(); let mut later = d["nodes"]["bg"].clone(); later["id"] = json!("later");
    later["transform"] = json!([1,0,0,1,-10.125,40.25]);
    later["effects"][0]["radius"] = json!(11.375);
    d["nodes"]["later"] = later; d["pages"][0]["children"] = json!(["source","bg","later"]);
    let old = compile(&d,false); let tight = compile(&d,true); verify_boxes(&old,&tight);
    assert_eq!(tight.nodes["later"].post_composite_box,old.nodes["later"].post_composite_box);
    assert!(tight.root_input_box.unwrap()[2]*tight.root_input_box.unwrap()[3] <= old.root_input_box.unwrap()[2]*old.root_input_box.unwrap()[3]);
}

#[test]
fn painter_capture_reads_effect_bearing_parent_without_stages_keeps_phase_three() {
    let mut d = document(); d["pages"][0]["children"] = json!(["parent"]);
    d["nodes"]["parent"] = json!({"id":"parent","kind":"frame","width":512,"height":512,
        "children":["source","bg"],"effects":[{"kind":"blur","color":"#000000","radius":2.75}]});
    let old = compile(&d,false); let tight = compile(&d,true);
    assert!(old.root_input_box.is_none());
    assert!(old.nodes["bg"].backdrop_output_box.is_some(),"phase-three non-staged proof remains active");
    assert_eq!(serde_json::to_value(old).unwrap(),serde_json::to_value(tight).unwrap());
}

#[test]
fn painter_capture_reads_clip_and_upstream_image_keep_authored_policy_and_frozen_capture() {
    let mut d = document(); d["pages"][0]["children"] = json!(["parent"]);
    d["nodes"]["parent"] = json!({"id":"parent","kind":"frame","width":512,"height":512,
        "clip":true,"children":["source","bg"]});
    d["nodes"]["source"]["fills"][0]["kind"] = json!("image");
    d["nodes"]["source"]["fills"][0]["image"] = json!(image_uri());
    let old = compile(&d,false); let tight = compile(&d,true); verify_boxes(&old,&tight);
    assert!(old.nodes["parent"].children_input_box.is_some());
    assert!(tight.nodes["parent"].children_input_box.is_some());
    assert_eq!(tight.nodes["parent"].clip,old.nodes["parent"].clip);
    assert_eq!(tight.nodes["source"].fills[0].kind,"image");
}

#[test]
fn painter_capture_reads_strict_flag_requires_support_and_preserves_whole_or_export_paths() {
    let doc = document(); let mut engine = Engine::new(); engine.load_document(&doc.to_string()).unwrap();
    let mut r = request(); let legacy = engine.compile_gpu_request(&r.to_string()).unwrap();
    for value in [json!(1),json!("true"),Value::Null] {
        r["gpuPainterCaptureReads"] = value;
        assert!(engine.compile_gpu_request(&r.to_string()).err().unwrap().contains("capture-read policy"));
    }
    r["gpuPainterCaptureReads"] = json!(true); r["gpuPainterSupport"] = json!(false);
    assert!(engine.compile_gpu_request(&r.to_string()).err().unwrap().contains("require painter support"));
    r["gpuPainterSupport"] = json!(true); r["gpuPainterCaptureReads"] = json!(false);
    assert_eq!(serde_json::to_value(legacy).unwrap(),serde_json::to_value(engine.compile_gpu_request(&r.to_string()).unwrap()).unwrap());
    for profile in ["figmaSubpixel","figma"] {
        let mut whole = request(); whole.as_object_mut().unwrap().remove("gpuViewport"); whole["rasterProfile"] = json!(profile);
        whole["gpuPainterCaptureReads"] = json!(false);
        let old = engine.compile_gpu_request(&whole.to_string()).unwrap();
        whole["gpuPainterCaptureReads"] = json!(true);
        assert_eq!(serde_json::to_value(old).unwrap(),serde_json::to_value(engine.compile_gpu_request(&whole.to_string()).unwrap()).unwrap());
    }
    let mut export = request(); export["rasterProfile"] = json!("figma"); export["gpuPainterCaptureReads"] = json!(false);
    let old = engine.compile_gpu_request(&export.to_string()).unwrap(); export["gpuPainterCaptureReads"] = json!(true);
    assert_eq!(serde_json::to_value(old).unwrap(),serde_json::to_value(engine.compile_gpu_request(&export.to_string()).unwrap()).unwrap());
}

#[test]
fn painter_capture_reads_camera_cache_cannot_cross_policy_changes() {
    let doc = document(); let mut cached = Engine::new(); cached.load_document(&doc.to_string()).unwrap();
    for phase_four in [false,true,false,true] {
        let mut r = request(); r["gpuPainterCaptureReads"] = json!(phase_four);
        let current = cached.compile_gpu_request(&r.to_string()).unwrap();
        let fresh = compile(&doc,phase_four);
        assert_eq!(serde_json::to_value(current).unwrap(),serde_json::to_value(fresh).unwrap());
    }
}

#[test]
fn painter_capture_reads_fine_rotated_backdrop_still_rejects_entire_certificate() {
    let mut d = document(); d["nodes"]["bg"]["transform"] = json!([0.992197667,0.124674733,-0.124674733,0.992197667,14.375,15.125]);
    let mut engine = Engine::new(); engine.load_document(&d.to_string()).unwrap();
    let mut r = request(); r["view"]["zoom"] = json!(1.375); r["gpuViewport"] = json!({"x":47,"y":39,"w":64,"h":57});
    r["gpuPainterSupport"] = json!(false); let legacy = engine.compile_gpu_request(&r.to_string()).unwrap();
    r["gpuPainterSupport"] = json!(true); r["gpuPainterCaptureReads"] = json!(true);
    let candidate = engine.compile_gpu_request(&r.to_string()).unwrap();
    assert!(candidate.root_input_box.is_none());
    assert_eq!(serde_json::to_value(legacy).unwrap(),serde_json::to_value(candidate).unwrap());
}
