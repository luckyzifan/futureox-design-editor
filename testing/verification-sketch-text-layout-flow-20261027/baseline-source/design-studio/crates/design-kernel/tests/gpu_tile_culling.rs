use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::{Value, json};

#[test]
fn exact_whole_viewport_uses_regional_packet_admission_without_simplifying_effects() {
    let mut nodes = serde_json::Map::new();
    let mut roots = Vec::new();
    for i in 0..160 {
        let id = format!("e{i}"); roots.push(id.clone());
        nodes.insert(id.clone(), json!({"id":id,"kind":"ellipse","width":900,"height":750,
            "transform":[1,0,0,1,i as f64 / 1024.,0.125],
            "fills":[{"kind":"solid","color":"#334455","opacity":0.2}]}));
    }
    let doc = json!({"schemaVersion":1,"id":"d","name":"large exact packet",
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":roots}],"nodes":nodes});
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":900,"height":750,
        "view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figmaSubpixel","interactiveEffects":false})).unwrap();
    let mut engine = Engine::new(); engine.load_document(&doc.to_string()).unwrap();
    let full = engine.compile_gpu(&options).unwrap();
    assert!(full.curves.len() > 2_000_000, "fixture must exceed small tile admission");
    assert!(full.curves.len() <= 8_000_000, "existing aggregate ceiling remains bounded");
    let regional = engine.compile_gpu_request(&json!({"pageId":"p","width":900,"height":750,
        "view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figmaSubpixel","interactiveEffects":false,
        "captureViewport":{"x":0,"y":0,"w":900,"h":750}}).to_string()).unwrap();
    assert_eq!(full.curves.iter().map(|f|f.to_bits()).collect::<Vec<_>>(),
        regional.curves.iter().map(|f|f.to_bits()).collect::<Vec<_>>());
    assert_eq!(full.nodes.len(), regional.nodes.len());
}
fn document() -> Value {
    json!({"schemaVersion":2,"id":"d","name":"opaque tile","pages":[{"id":"p","name":"p","children":["r"],"background":"#334455"}],
      "nodes":{"r":{"id":"r","kind":"frame","width":1000,"height":1000,"radii":[24,24,24,24],"clip":true,
      "fills":[{"kind":"solid","color":"#ffffff"}],"effects":[{"kind":"shadow","radius":8,"y":8,"color":"#000000","opacity":0.5}]}}})
}
fn compile(doc: Value, x: f64) -> futureox_design_kernel::gpu::GpuScene {
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    let options: RenderOptions=serde_json::from_value(json!({"pageId":"p","width":128,"height":128,
      "view":{"x":x,"y":x,"zoom":1},"transparent":false,"grid":false,"rasterProfile":"figmaSubpixel"})).unwrap();
    engine.compile_gpu(&options).unwrap()
}
#[test]
fn opaque_interior_omits_only_invisible_outer_shadow() {
    let interior = compile(document(), -400.);
    assert!(interior.nodes["r"].opaque_coverage);
    assert!(interior.nodes["r"].effects.is_empty());
    let boundary = compile(document(), 0.);
    assert!(!boundary.nodes["r"].opaque_coverage);
    assert_eq!(boundary.nodes["r"].effects.len(), 1);
}

#[test]
fn opaque_clip_hint_contains_only_whole_device_pixels() {
    // This metadata may remove a redundant ancestor clip. Fractional boundary
    // pixels must never enter the proof, at either sign of the translation.
    for phase in [-5.875, -0.125, 0., 0.125, 0.999] {
        let mut d = document();
        d["nodes"]["r"]["radii"] = json!([0,0,0,0]);
        d["nodes"]["r"]["effects"] = json!([]);
        d["nodes"]["r"]["width"] = json!(43.375);
        d["nodes"]["r"]["height"] = json!(37.625);
        let scene = compile(d, phase);
        let hint = scene.nodes["r"].fill.opaque_rect.unwrap();
        for y in hint.y..hint.bottom() {
            for x in hint.x..hint.right() {
                assert!(f64::from(x) >= phase && f64::from(x + 1) <= phase + 43.375);
                assert!(f64::from(y) >= phase && f64::from(y + 1) <= phase + 37.625);
            }
        }
    }
    assert!(compile(document(), 0.125).nodes["r"].fill.opaque_rect.is_none());
}

#[test]
fn exact_camera_variants_survive_zoom_revisits_and_expire_with_document_lineage() {
    let mut doc=document();
    doc["nodes"]["r"]["strokes"]=json!([{"width":2.375,"paint":{"kind":"solid","color":"#224466"}}]);
    let mut engine=Engine::new();engine.load_document(&doc.to_string()).unwrap();
    for zoom in [0.6,1.2,2.4,0.6,1.2] {
        let options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":128,"height":128,
            "view":{"x":0.375,"y":0.625,"zoom":zoom},"rasterProfile":"figmaSubpixel"})).unwrap();
        let cached=engine.compile_gpu(&options).unwrap();
        let mut fresh=Engine::new();fresh.load_document(&doc.to_string()).unwrap();
        assert_eq!(serde_json::to_value(cached).unwrap(),serde_json::to_value(fresh.compile_gpu(&options).unwrap()).unwrap());
    }
    let stats=engine.gpu_compile_cache_stats();
    assert!(stats["cameraResidency"]["restores"].as_u64().unwrap()>=2);
    for i in 1..12 {
        let options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":128,"height":128,
            "view":{"x":0,"y":0,"zoom":i as f64/3.},"rasterProfile":"figmaSubpixel"})).unwrap();
        engine.compile_gpu(&options).unwrap();
        let stats=engine.gpu_compile_cache_stats();
        assert!(stats["cameraResidency"]["entries"].as_u64().unwrap()<=4);
        assert!(stats["cameraResidency"]["bytes"].as_u64().unwrap()<=64*1024*1024);
    }
    doc["nodes"]["r"]["radii"]=json!([7,7,7,7]);engine.load_document(&doc.to_string()).unwrap();
    let options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":128,"height":128,
        "view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figmaSubpixel"})).unwrap();
    let cached=engine.compile_gpu(&options).unwrap();let mut fresh=Engine::new();fresh.load_document(&doc.to_string()).unwrap();
    assert_eq!(serde_json::to_value(cached).unwrap(),serde_json::to_value(fresh.compile_gpu(&options).unwrap()).unwrap());
    assert_eq!(engine.gpu_compile_cache_stats()["cameraResidency"]["entries"],json!(0));
}
#[test]
fn alpha_and_nonlocal_effects_do_not_take_the_opaque_shortcut() {
    for (field, value) in [
        ("opacity", json!(0.5)),
        ("smoothing", json!(0.5)),
        ("blend", json!("multiply")),
    ] {
        let mut d = document();
        d["nodes"]["r"][field] = value;
        assert!(!compile(d, -400.).nodes["r"].opaque_coverage);
    }
    let mut d = document();
    d["nodes"]["r"]["fills"][0]["opacity"] = json!(0.5);
    assert!(!compile(d, -400.).nodes["r"].opaque_coverage);
    let mut d = document();
    d["nodes"]["r"]["effects"][0]["kind"] = json!("inner-shadow");
    assert_eq!(compile(d, -400.).nodes["r"].effects.len(), 1);
}

#[test]
fn an_offscreen_child_does_not_expand_every_parent_tile() {
    let mut d = document();
    d["nodes"]["r"]["effects"] = json!([]);
    d["nodes"]["r"]["children"] = json!(["child"]);
    d["nodes"]["child"] = json!({"id":"child","kind":"rectangle","width":30,"height":30,
        "transform":[1,0,0,1,300,300],"fills":[{"kind":"solid","color":"#ff0000"}],
        "effects":[{"kind":"shadow","radius":50,"color":"#000000","opacity":0.5}]});
    let scene = compile(d, 0.);
    assert_eq!((scene.extent.w, scene.extent.h), (128, 128));
}

#[test]
fn cropped_gpu_commands_preserve_camera_and_composed_matrix_bits() {
    use futureox_design_kernel::math::Rect;
    let mut d = document();
    d["nodes"]["r"]["transform"] = json!([1., 0., 0., 1., 40.3, 35.7]);
    let mut engine = Engine::new();
    engine.load_document(&d.to_string()).unwrap();
    for profile in ["analytic", "figmaSubpixel", "figma"] {
        let options: RenderOptions = serde_json::from_value(json!({
            "pageId":"p", "width":385, "height":337,
            "view":{"x":160.375,"y":180.625,"zoom":0.2},
            "transparent":false,"grid":false,"rasterProfile":profile
        }))
        .unwrap();
        let full = engine.compile_gpu(&options).unwrap();
        let region = Rect::new(159, 179, 258, 258);
        let tile = engine.compile_gpu_region(&options, region, None).unwrap();
        assert_eq!(tile.version, 8);
        assert_eq!(tile.output.unwrap(), region);
        assert_eq!(full.view.x.to_bits(), tile.view.x.to_bits());
        assert_eq!(full.view.y.to_bits(), tile.view.y.to_bits());
        assert_eq!(
            full.nodes["r"].matrix.0.map(f64::to_bits),
            tile.nodes["r"].matrix.0.map(f64::to_bits)
        );
        assert_eq!(
            full.nodes["r"].inverse.0.map(f64::to_bits),
            tile.nodes["r"].inverse.0.map(f64::to_bits)
        );
    }
}

#[test]
fn foreground_halo_stays_on_its_branch_and_backdrop_keeps_global_support() {
    use futureox_design_kernel::{color::ColorSettings, math::Rect};
    let mut d = document();
    d["schemaVersion"] = json!(5);
    d["colorManagement"] = json!(ColorSettings::default());
    d["nodes"]["r"]["effects"] = json!([]);
    d["nodes"]["r"]["children"] = json!(["child"]);
    d["nodes"]["child"] = json!({"id":"child","kind":"rectangle","width":1000,"height":1000,
        "fills":[{"kind":"solid","color":"#8899aa"}],
        "effects":[{"kind":"inner-shadow","radius":83,"spread":132,"color":"#000000","opacity":0.5}]});
    let options: RenderOptions =
        serde_json::from_value(json!({"pageId":"p","width":128,"height":128,
        "view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figmaSubpixel"}))
        .unwrap();
    let crop = Rect::new(100, 100, 64, 64);
    let mut engine = Engine::new();
    engine.load_document(&d.to_string()).unwrap();
    let scene = engine.compile_gpu_region(&options, crop, None).unwrap();
    assert_eq!(scene.extent, crop.expand(2));
    assert_eq!(scene.nodes["r"].rect, crop.expand(2));
    assert!(scene.nodes["child"].rect.w > scene.nodes["r"].rect.w + 200);

    // A backdrop may read earlier siblings: the branch-local proof cannot apply.
    d["nodes"]["child"]["effects"][0]["kind"] = json!("background-blur");
    // Keep that read observable: a fully opaque fill hides its own backdrop.
    d["nodes"]["child"]["fills"][0]["opacity"] = json!(0.5);
    engine.load_document(&d.to_string()).unwrap();
    let scene = engine.compile_gpu_region(&options, crop, None).unwrap();
    assert!(scene.extent.w > crop.w + 200, "public native region keeps its established default");
    assert!(scene.nodes["child"].backdrop_output_box.is_none());
    let mut request = serde_json::to_value(&options).unwrap();
    request["gpuViewport"] = serde_json::to_value(crop).unwrap();
    request["gpuPainterSupport"] = json!(true);
    let candidate = engine.compile_gpu_request(&request.to_string()).unwrap();
    // The opt-in managed tent keeps all real taps while excluding the stale
    // inner-shadow spread field from a background-blur allocation.
    assert!(candidate.extent.w >= crop.w + 2*83);
    assert!(candidate.nodes["child"].effects.iter().any(|e|e.kind=="background-blur"));
    assert!(candidate.nodes["child"].backdrop_output_box.is_some());
}

#[test]
fn offscreen_clipped_board_does_not_emit_unreachable_children() {
    let mut d = document();
    d["nodes"]["r"]["effects"] = json!([]);
    d["nodes"]["r"]["transform"] = json!([1, 0, 0, 1, 2000, 2000]);
    d["nodes"]["r"]["children"] = json!(["overflow"]);
    d["nodes"]["overflow"] = json!({"id":"overflow","kind":"rectangle","width":64,"height":64,
        "transform":[1,0,0,1,-2000,-2000],"fills":[{"kind":"solid","color":"#ff0000"}]});
    for profile in ["analytic", "figmaSubpixel", "figma"] {
        let mut engine = Engine::new();
        let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":128,"height":128,
            "view":{"x":0,"y":0,"zoom":1},"rasterProfile":profile})).unwrap();
        engine.load_document(&d.to_string()).unwrap();
        let scene = engine.compile_gpu(&options).unwrap();
        assert!(!scene.nodes.contains_key("r"));
        assert!(!scene.nodes.contains_key("overflow"));
        let mut open = d.clone();
        open["nodes"]["r"]["clip"] = json!(false);
        engine.load_document(&open.to_string()).unwrap();
        assert!(engine.compile_gpu(&options).unwrap().nodes.contains_key("overflow"));
    }
}

#[test]
fn nearby_board_remains_available_to_backdrop_and_blend_dependencies() {
    let mut d = document();
    d["nodes"]["r"]["effects"] = json!([]);
    d["nodes"]["r"]["width"] = json!(20);
    d["nodes"]["r"]["height"] = json!(128);
    d["nodes"]["r"]["transform"] = json!([1, 0, 0, 1, -24, 0]);
    d["pages"][0]["children"] = json!(["r", "lens"]);
    d["nodes"]["lens"] = json!({"id":"lens","kind":"rectangle","width":128,"height":128,
        "blend":"multiply","fills":[{"kind":"solid","color":"#8899aa","opacity":0.5}],
        "effects":[{"kind":"background-blur","radius":12,"color":"#000000"}]});
    let scene = compile(d, 0.);
    assert!(scene.extent.x < -4);
    assert!(scene.nodes.contains_key("r"), "offscreen source is inside the blur dependency halo");
    assert!(scene.nodes.contains_key("lens"));
}

#[test]
fn clipped_offscreen_subtrees_are_not_prepared_until_the_camera_exposes_them() {
    use futureox_design_kernel::math::Rect;
    let mut d = document();
    d["nodes"]["r"]["effects"] = json!([]);
    d["nodes"]["r"]["transform"] = json!([1,0,0,1,2000,2000]);
    d["nodes"]["r"]["children"] = json!(["child"]);
    d["nodes"]["child"] = json!({"id":"child","kind":"rectangle","width":64,"height":64,
        "fills":[{"kind":"solid","color":"#ff0000"}]});
    let mut engine = Engine::new(); engine.load_document(&d.to_string()).unwrap();
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":128,"height":128,
        "view":{"x":0,"y":0,"zoom":1},"rasterProfile":"analytic"})).unwrap();
    let crop = Rect::new(0,0,128,128);
    let scene = engine.compile_gpu_region(&options,crop,Some(crop)).unwrap();
    assert!(scene.nodes.is_empty());
    assert_eq!(engine.gpu_compile_cache_stats()["preparedNodes"],1);
    assert_eq!(engine.gpu_compile_cache_stats()["pathNodes"],0);
    let crop = Rect::new(2000,2000,128,128);
    let scene = engine.compile_gpu_region(&options,crop,Some(crop)).unwrap();
    assert!(scene.nodes.contains_key("child"));
    assert_eq!(engine.gpu_compile_cache_stats()["preparedNodes"],2);
}

#[test]
fn camera_metadata_reuse_preserves_effect_support_across_guard_changes_and_patches() {
    let mut d = document();
    d["schemaVersion"] = json!(5);
    d["colorManagement"] = json!(futureox_design_kernel::color::ColorSettings::default());
    let mut engine = Engine::new();
    engine.load_document(&d.to_string()).unwrap();
    for kind in ["shadow", "background-blur", "inner-shadow"] {
        d["nodes"]["r"]["effects"][0]["kind"] = json!(kind);
        let patch = serde_json::from_value(json!({"nodes":{"r":d["nodes"]["r"]},"fields":{}})).unwrap();
        engine.apply_document_patch(&patch).unwrap();
        for zoom in [1., 2.] {
            for guard in [512, 1024] {
                let request = json!({"pageId":"p","width":128,"height":128,
                    "view":{"x":0.25,"y":0.75,"zoom":zoom},"rasterProfile":"figmaSubpixel",
                    "gpuViewport":{"x":0,"y":0,"w":128,"h":128},
                    "prepareViewport":{"x":-64,"y":-64,"w":guard,"h":guard}});
                let cached = engine.compile_gpu_request(&request.to_string()).unwrap().into_packet().unwrap();
                let mut fresh = Engine::new(); fresh.load_document(&d.to_string()).unwrap();
                let exact = fresh.compile_gpu_request(&request.to_string()).unwrap().into_packet().unwrap();
                assert_eq!(cached, exact, "kind={kind}, zoom={zoom}, guard={guard}");
            }
        }
    }
}
