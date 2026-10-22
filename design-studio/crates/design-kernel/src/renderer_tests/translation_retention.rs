use super::*;
use serde_json::json;

fn source() -> Document {
    serde_json::from_value(json!({"schemaVersion":2,"id":"d","name":"translation",
        "pages":[{"id":"p","name":"p","children":["frame"],"background":"#eeeeee"}],
        "nodes":{"frame":{"id":"frame","kind":"frame","width":80,"height":60,"clip":true,
            "transform":[1,0,0,1,5,8],"fills":[{"kind":"solid","color":"#ffffff"}],"children":["child"]},
        "child":{"id":"child","kind":"rectangle","width":16,"height":20,
            "transform":[1,0,0,1,10,10],"fills":[{"kind":"solid","color":"#cc3366"}]}}})).unwrap()
}

#[test]
fn glass_translations_keep_fast_updates_without_narrowing_unknown_paint_damage() {
    let mut original=source();original.schema_version=5;
    let frame=original.nodes.get_mut("frame").unwrap();
    frame.fills[0].opacity=0.2;
    frame.effects=vec![serde_json::from_value(json!({"kind":"glass","visible":true,"radius":4,"color":"#000000","opacity":0.5,"amount":14,
        "glass":{"depth":8,"refraction":0.5,"dispersion":0.3,"lightAngle":45,"lightIntensity":0.5}})).unwrap()];
    let mut engine=Engine::new();engine.install_document(original.clone()).unwrap();
    engine.compile_gpu(&options()).unwrap();
    let path=engine.paths["child"].clone();
    for (id,x) in [("frame",18.375),("frame",-9.125),("frame",25.),("child",13.125)] {
        let mut next=engine.source_doc.as_ref().unwrap().clone();next.nodes.get_mut(id).unwrap().transform.0[4]=x;
        let patch=crate::editing::DocumentPatch::between(engine.source_doc.as_ref().unwrap(),&next).unwrap();
        let damage=engine.apply_document_patch_with_damage(&patch).unwrap();
        assert!(damage.full);assert_eq!(damage.translation_only,Some(true));
        assert!(!engine.layout_dirty);assert!(Arc::ptr_eq(&path,&engine.paths["child"]));
        assert_eq!(engine.source_doc_bytes,Some(serde_json::to_vec(&next).unwrap().len()));
        let mut fresh=Engine::new();fresh.install_document(next).unwrap();
        assert_eq!(engine.compile_gpu(&options()).unwrap().into_packet().unwrap(),fresh.compile_gpu(&options()).unwrap().into_packet().unwrap());
        assert_eq!(engine.render(&options()).unwrap(),fresh.render(&options()).unwrap());
    }
}
fn options() -> RenderOptions {
    serde_json::from_value(json!({"pageId":"p","width":128,"height":128,
        "view":{"x":0.25,"y":0.5,"zoom":1.2},"transparent":false,"grid":false})).unwrap()
}
#[test]
fn native_interaction_reuses_full_capture_prepare_and_rebuilds_exact_fractional_coverage() {
    let original = source();
    let mut engine = Engine::new(); engine.install_document(original.clone()).unwrap();
    let first = engine.compile_gpu(&options()).unwrap().into_packet().unwrap();
    let prepared = engine.camera_prepare.as_ref().unwrap().prepared.clone();
    assert_eq!(first, engine.compile_gpu(&options()).unwrap().into_packet().unwrap());
    assert!(Arc::ptr_eq(&prepared, &engine.camera_prepare.as_ref().unwrap().prepared));
    for x in [10.125, 33.375, -0.25, 10.] {
        let transforms = [("child".into(), Transform([1.,0.,0.,1.,x,10.25]))].into_iter().collect();
        assert!(engine.apply_interaction_transforms(&transforms).unwrap());
        let next = engine.source_doc.as_ref().unwrap().clone();
        let mut fresh = Engine::new(); fresh.install_document(next).unwrap();
        assert_eq!(engine.compile_gpu(&options()).unwrap().into_packet().unwrap(),
            fresh.compile_gpu(&options()).unwrap().into_packet().unwrap(), "fractional pose {x}");
    }
    let before = serde_json::to_string(engine.source_doc.as_ref().unwrap()).unwrap();
    let invalid = [("child".into(),Transform([1.,0.,0.,1.,25.,10.])),
        ("missing".into(),Transform::default())].into_iter().collect();
    assert!(engine.apply_interaction_transforms(&invalid).is_err());
    assert_eq!(before,serde_json::to_string(engine.source_doc.as_ref().unwrap()).unwrap());
    // Affine interaction transforms (rotation/scale) are retained since the
    // affine camera-metadata rebuild; the recompiled capture must still match
    // a fresh engine exactly.
    let scale = [("child".into(),Transform([2.,0.,0.,1.,25.,10.]))].into_iter().collect();
    assert!(engine.apply_interaction_transforms(&scale).unwrap());
    let mut fresh = Engine::new(); fresh.install_document(engine.source_doc.as_ref().unwrap().clone()).unwrap();
    assert_eq!(engine.compile_gpu(&options()).unwrap().into_packet().unwrap(),
        fresh.compile_gpu(&options()).unwrap().into_packet().unwrap(), "affine pose");
    assert_eq!(engine.render(&options()).unwrap(), fresh.render(&options()).unwrap(), "affine pose");
}

#[test]
fn local_strokes_survive_camera_pan_and_fractional_drag_with_identical_packets() {
    let mut doc=source();doc.nodes.get_mut("child").unwrap().strokes=serde_json::from_value(json!([
        {"width":3,"paint":{"kind":"solid","color":"#3377bb"},"dash":"3 2","cap":"round","join":"round"}
    ])).unwrap();
    let mut engine=Engine::new();engine.install_document(doc.clone()).unwrap();
    let mut o=options();engine.compile_gpu(&o).unwrap();
    for step in 1..6 {
        o.view.x=step as f64*0.125;
        let transforms=[("child".into(),Transform([1.,0.,0.,1.,10.+step as f64*0.375,10.]))].into_iter().collect();
        assert!(engine.apply_interaction_transforms(&transforms).unwrap());
        let mut fresh=Engine::new();fresh.install_document(engine.source_doc.clone().unwrap()).unwrap();
        assert_eq!(engine.compile_gpu(&o).unwrap().into_packet().unwrap(),fresh.compile_gpu(&o).unwrap().into_packet().unwrap());
    }
    let stats=engine.gpu_compile_cache_stats();
    assert_eq!(stats["residentStrokes"]["builds"],1);assert_eq!(stats["residentStrokes"]["hits"],5);
}
#[test]
fn native_capture_uses_the_tile_camera_contract_without_expanding_tile_limits() {
    let mut engine=Engine::new();engine.install_document(source()).unwrap();
    let options=options();let region=Rect::new(-16,-16,128,128);
    let tile=engine.compile_gpu_region(&options,region,Some(region)).unwrap().into_packet().unwrap();
    let mut request=serde_json::to_value(&options).unwrap();request["captureViewport"]=json!({"x":-16,"y":-16,"w":128,"h":128});
    assert_eq!(tile,engine.compile_gpu_request(&request.to_string()).unwrap().into_packet().unwrap());
    request["width"]=json!(1024);request["height"]=json!(512);
    request["captureViewport"]=json!({"x":-16,"y":-16,"w":1024,"h":512});
    let capture=engine.compile_gpu_request(&request.to_string()).unwrap();
    assert_eq!(capture.output,Some(Rect::new(-16,-16,1024,512)));
    assert!(engine.compile_gpu_region(&options,Rect::new(0,0,1024,512),None).is_err());
    request["gpuViewport"]=json!({"x":0,"y":0,"w":32,"h":32});
    assert!(engine.compile_gpu_request(&request.to_string()).is_err());
}
#[test]
fn pure_root_move_retains_layout_and_matches_fresh_render() {
    let original = source();
    let mut engine = Engine::new(); engine.install_document(original.clone()).unwrap();
    engine.render(&options()).unwrap();
    let count = engine.paths.len();
    for dx in [10., 10.25, -20.] {
        let mut next = original.clone(); next.nodes.get_mut("frame").unwrap().transform.0[4] = dx;
        let patch = crate::editing::DocumentPatch::between(engine.source_doc.as_ref().unwrap(), &next).unwrap();
        assert!(engine.can_retain_translation(&patch));
        let damage = engine.apply_document_patch_with_damage(&patch).unwrap();
        assert!(!damage.full);
        assert!(!engine.layout_dirty);
        assert_eq!(engine.paths.len(), count);
        assert_eq!(engine.source_doc_bytes, Some(serde_json::to_vec(engine.source_doc.as_ref().unwrap()).unwrap().len()));
        let mut fresh = Engine::new(); fresh.install_document(next).unwrap();
        assert_eq!(engine.render(&options()).unwrap(), fresh.render(&options()).unwrap());
    }
}
#[test]
fn derived_or_non_translation_edits_keep_normal_invalidation() {
    for field in ["width", "opacity", "transform"] {
        let original = source(); let mut next = original.clone();
        match field {
            "width" => next.nodes.get_mut("frame").unwrap().width += 1.,
            "opacity" => next.nodes.get_mut("frame").unwrap().opacity = 0.5,
            "transform" => next.nodes.get_mut("frame").unwrap().transform.0[0] = 2.,
            _ => next.nodes.get_mut("child").unwrap().transform.0[4] += 2.,
        }
        let mut engine = Engine::new(); engine.install_document(original.clone()).unwrap();
        engine.render(&options()).unwrap();
        let patch = crate::editing::DocumentPatch::between(&original, &next).unwrap();
        assert!(!engine.can_retain_translation(&patch));
        engine.apply_document_patch_with_damage(&patch).unwrap();
        assert_eq!(engine.layout_dirty, field != "opacity");
        let mut fresh = Engine::new(); fresh.install_document(next).unwrap();
        assert_eq!(engine.render(&options()).unwrap(), fresh.render(&options()).unwrap());
    }
}

#[test]
fn paint_fields_retain_layout_and_exact_programs_but_effect_bounds_propagate() {
    for profile in ["analytic", "figma", "figmaSubpixel"] {
        let mut original = source(); original.schema_version = 5;
        original.nodes.get_mut("frame").unwrap().layout = Some(serde_json::from_value(json!({"mode":"horizontal","gap":4})).unwrap());
        let mut opts = serde_json::to_value(options()).unwrap(); opts["rasterProfile"]=json!(profile);
        let opts: RenderOptions = serde_json::from_value(opts).unwrap();
        let mut engine = Engine::new(); engine.install_document(original).unwrap();
        engine.compile_gpu(&opts).unwrap();
        let index = engine.render_index.clone().unwrap();
        let path = engine.paths["child"].clone();
        for field in ["fills", "opacity", "effects", "opacity", "effects"] {
            let mut next = engine.source_doc.as_ref().unwrap().clone();
            let child = next.nodes.get_mut("child").unwrap();
            match field {
                "fills" => child.fills[0].color = "#3299bb".into(),
                "opacity" => child.opacity = if child.opacity == 0. {0.7} else {0.},
                _ => child.effects = if child.effects.is_empty() {serde_json::from_value(json!([
                    {"kind":"background-blur","radius":3,"visible":true,"color":"#000000","opacity":1}
                ])).unwrap()} else {vec![]},
            }
            let patch = crate::editing::DocumentPatch::between(engine.source_doc.as_ref().unwrap(), &next).unwrap();
            let prepared = engine.camera_prepare.as_ref().unwrap().prepared.clone();
            engine.apply_document_patch_with_damage(&patch).unwrap();
            assert!(!engine.layout_dirty);
            assert!(Arc::ptr_eq(&index, engine.render_index.as_ref().unwrap()));
            assert!(Arc::ptr_eq(&path, &engine.paths["child"]));
            if field != "effects" { assert!(Arc::ptr_eq(&prepared, &engine.camera_prepare.as_ref().unwrap().prepared)); }
            let mut fresh = Engine::new(); fresh.install_document(next).unwrap();
            assert_eq!(engine.compile_gpu(&opts).unwrap().into_packet().unwrap(), fresh.compile_gpu(&opts).unwrap().into_packet().unwrap(), "{profile}/{field}");
            assert_eq!(engine.render(&opts).unwrap(), fresh.render(&opts).unwrap(), "{profile}/{field}");
        }
    }
}

#[test]
fn paint_retention_rejects_unknown_fields_and_is_atomic_on_invalid_values() {
    let mut engine = Engine::new(); engine.install_document(source()).unwrap(); engine.compile_gpu(&options()).unwrap();
    let old = engine.source_doc.clone().unwrap();
    let mut next = old.clone(); next.nodes.get_mut("child").unwrap().width += 2.;
    let patch = crate::editing::DocumentPatch::between(&old, &next).unwrap();
    assert!(engine.retainable_paint_changes(&patch).is_none());
    next = old.clone(); next.nodes.get_mut("child").unwrap().opacity = -1.;
    let patch = crate::editing::DocumentPatch::between(&old, &next).unwrap();
    assert!(engine.apply_document_patch_with_damage(&patch).is_err());
    assert_eq!(engine.source_doc.as_ref().unwrap(), &old);
    assert!(!engine.layout_dirty);
}

#[test]
fn backdrop_translation_keeps_dependency_invalidation_and_matches_fresh_pixels() {
    let mut original = source();
    original.nodes.get_mut("frame").unwrap().effects = serde_json::from_value(json!([
        {"kind":"background-blur","radius":3,"visible":true,"color":"#000000","opacity":1}
    ])).unwrap();
    let mut engine = Engine::new(); engine.install_document(original.clone()).unwrap();
    engine.render(&options()).unwrap();
    let mut next = original.clone(); next.nodes.get_mut("frame").unwrap().transform.0[4] += 7.25;
    let patch = crate::editing::DocumentPatch::between(&original, &next).unwrap();
    assert!(!engine.apply_document_patch_with_damage(&patch).unwrap().full);
    assert!(!engine.layout_dirty);
    let mut fresh = Engine::new(); fresh.install_document(next).unwrap();
    assert_eq!(engine.render(&options()).unwrap(), fresh.render(&options()).unwrap());
}

#[test]
fn invalid_translation_does_not_mutate_document_or_byte_accounting() {
    let original = source();
    let mut engine = Engine::new(); engine.install_document(original.clone()).unwrap();
    engine.render(&options()).unwrap();
    let bytes = engine.source_doc_bytes;
    let mut changed = original.nodes["frame"].clone(); changed.transform.0[4] = f64::NAN;
    let patch = crate::editing::DocumentPatch { nodes: [("frame".into(), Some(changed))].into(), fields: Default::default() };
    assert!(engine.apply_document_patch_with_damage(&patch).is_err());
    assert_eq!(engine.source_doc.as_deref(), Some(&original));
    assert_eq!(engine.source_doc_bytes, bytes);
}

#[test]
fn nested_translation_retains_derived_layout_and_matches_fresh_pixels() {
    let original = source(); let mut next = original.clone();
    next.nodes.get_mut("child").unwrap().transform.0[4] += 2.375;
    let mut engine = Engine::new(); engine.install_document(original.clone()).unwrap();
    engine.render(&options()).unwrap();
    let paths = engine.paths["child"].clone();
    let patch = crate::editing::DocumentPatch::between(&original,&next).unwrap();
    assert!(engine.can_retain_translation(&patch));
    engine.apply_document_patch_with_damage(&patch).unwrap();
    assert!(!engine.layout_dirty);
    assert!(Arc::ptr_eq(&paths,&engine.paths["child"]));
    let mut fresh = Engine::new(); fresh.install_document(next).unwrap();
    assert_eq!(engine.render(&options()).unwrap(),fresh.render(&options()).unwrap());
}

#[test]
fn bounded_root_damage_contains_pixels_through_overlapping_background_blur() {
    let mut original=source();
    original.nodes.insert("glass-board".into(),serde_json::from_value(json!({"id":"glass-board","kind":"frame","clip":true,
        "width":55,"height":65,"transform":[1,0,0,1,61,15],"blend":"multiply","opacity":0.8,
        "fills":[{"kind":"solid","color":"#88aacc","opacity":0.1}],
        "effects":[{"kind":"background-blur","radius":6,"color":"#000000","visible":true}]})).unwrap());
    original.pages[0].children.push("glass-board".into());
    let mut engine=Engine::new();engine.install_document(original.clone()).unwrap();
    let options=options();let before=engine.render(&options).unwrap();
    let mut next=original.clone();next.nodes.get_mut("frame").unwrap().transform.0[4]+=13.375;
    let patch=crate::editing::DocumentPatch::between(&original,&next).unwrap();
    let damage=engine.apply_document_patch_with_damage(&patch).unwrap();assert!(!damage.full);
    let after=engine.render(&options).unwrap();let mut fresh=Engine::new();fresh.install_document(next).unwrap();
    assert_eq!(after,fresh.render(&options).unwrap());
    let regions=damage.rects.unwrap();let mut changed=0;
    for (index,(a,b)) in before.chunks_exact(4).zip(after.chunks_exact(4)).enumerate(){
        if a==b {continue}changed+=1;
        let x=((index%options.width as usize) as f64+0.5-options.view.x)/options.view.zoom;
        let y=((index/options.width as usize) as f64+0.5-options.view.y)/options.view.zoom;
        assert!(regions.iter().any(|r|x>=r[0]&&y>=r[1]&&x<=r[0]+r[2]&&y<=r[1]+r[3]),"unreported changed pixel {x},{y}");
    }
    assert!(changed>100);
}
#[test]
fn worker_snapshots_detach_on_edits_and_preserve_owner_pixels() {
    let mut owner = Engine::new();
    owner.install_document(source()).unwrap();
    let before = owner.render(&options()).unwrap();
    let mut worker = owner.snapshot_worker();
    let worker_source = worker.source_doc.clone().unwrap();
    let mut changed = worker_source.clone();
    let id = changed.pages[0].children[0].clone();
    changed.nodes.get_mut(&id).unwrap().transform.0[4] += 7.375;
    let patch = crate::editing::DocumentPatch::between(&worker_source, &changed).unwrap();
    worker.apply_document_patch(&patch).unwrap();
    let mut reference = Engine::new(); reference.install_document(changed).unwrap();
    assert_eq!(worker.render(&options()).unwrap(), reference.render(&options()).unwrap());
    assert_eq!(owner.render(&options()).unwrap(), before);
    // Drop the original owner; the worker still owns all render inputs.
    drop(owner);
    assert_eq!(worker.render(&options()).unwrap(), reference.render(&options()).unwrap());
}
