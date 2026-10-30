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

// A2 receipt tests. Source drafts only until the matching kernel is built/run.
fn retained_receipt_bytes(engine: &Engine) -> Option<usize> {
    engine.source_doc.as_ref().and_then(|source|
        engine.retained_source_size.as_ref().and_then(|receipt| receipt.bytes_for(source)))
}
fn retained_painted_engine(original: Document) -> Engine {
    let mut engine = Engine::new();
    engine.install_document(original.clone()).unwrap();
    engine.render(&options()).unwrap();
    let mut painted = original.clone();
    painted.nodes.get_mut("child").unwrap().opacity = 0.625;
    let patch = crate::editing::DocumentPatch::between(&original, &painted).unwrap();
    assert!(engine.retainable_paint_changes(&patch).is_some());
    engine.apply_document_patch_with_damage(&patch).unwrap();
    assert_eq!(engine.source_doc_bytes, None, "receipt storage cannot grant legacy eligibility");
    assert_eq!(retained_receipt_bytes(&engine), Some(serde_json::to_vec(&painted).unwrap().len()));
    engine
}
fn assert_retained_receipt_matches_fresh(engine: &mut Engine) {
    let mut fresh = Engine::new();
    fresh.install_document(engine.source_doc.clone().unwrap()).unwrap();
    assert_eq!(engine.compile_gpu(&options()).unwrap().into_packet().unwrap(),
        fresh.compile_gpu(&options()).unwrap().into_packet().unwrap());
    assert_eq!(engine.render(&options()).unwrap(), fresh.render(&options()).unwrap());
}

#[test]
fn retained_patch_direct_interaction_avoids_whole_document_recount() {
    // This exact test uses only legacy Engine APIs/fields plus the identical
    // cfg(test) counter seam. It is also supplied as the old-red control.
    for seed in ["paint", "nested-translation"] {
        let original = source();
        let mut engine = Engine::new();
        engine.install_document(original.clone()).unwrap();
        engine.render(&options()).unwrap();
        let mut next = original.clone();
        if seed == "paint" { next.nodes.get_mut("child").unwrap().opacity = 0.625; }
        else { next.nodes.get_mut("child").unwrap().transform.0[4] = -1234.875; }
        engine.apply_document_patch(&crate::editing::DocumentPatch::between(&original, &next).unwrap()).unwrap();
        assert_eq!(engine.source_doc_bytes, None);
        let mut transform = next.nodes["child"].transform;
        transform.0[4] = 11.125;
        let before_count = crate::editing::document_size_count_calls();
        assert!(engine.apply_interaction_transforms(&[("child".into(), transform)].into()).unwrap());
        assert_eq!(crate::editing::document_size_count_calls() - before_count, 0,
            "old baseline recounts once after {seed}; A2 reuses the checked receipt");
        next.nodes.get_mut("child").unwrap().transform = transform;
        assert_eq!(engine.source_doc_bytes, Some(serde_json::to_vec(&next).unwrap().len()));
        let mut fresh = Engine::new();
        fresh.install_document(next).unwrap();
        assert_eq!(engine.render(&options()).unwrap(), fresh.render(&options()).unwrap());
    }
}

#[test]
fn missing_private_receipt_retains_legacy_recount_fallback() {
    let mut engine = retained_painted_engine(source());
    engine.retained_source_size = None; // Deliberate cache-miss injection.
    let mut transform = engine.source_doc.as_ref().unwrap().nodes["child"].transform;
    transform.0[4] = 12.375;
    let before_count = crate::editing::document_size_count_calls();
    assert!(engine.apply_interaction_transforms(&[("child".into(), transform)].into()).unwrap());
    assert_eq!(crate::editing::document_size_count_calls() - before_count, 1);
    assert!(engine.retained_source_size.is_none());
    assert_eq!(engine.source_doc_bytes, Some(serde_json::to_vec(engine.source_doc.as_ref().unwrap()).unwrap().len()));
    assert_retained_receipt_matches_fresh(&mut engine);
}

#[test]
fn retained_patch_does_not_advance_clipped_root_eligibility() {
    for seed in ["paint", "nested-translation"] {
        let original = source();
        let mut engine = Engine::new();
        engine.install_document(original.clone()).unwrap();
        engine.render(&options()).unwrap();
        let mut next = original.clone();
        if seed == "paint" { next.nodes.get_mut("child").unwrap().opacity = 0.625; }
        else { next.nodes.get_mut("child").unwrap().transform.0[4] += 0.375; }
        engine.apply_document_patch(&crate::editing::DocumentPatch::between(&original, &next).unwrap()).unwrap();
        for dx in [13.375, -9.125] {
            assert_eq!(engine.source_doc_bytes, None);
            let before = engine.source_doc.clone().unwrap();
            let mut moved = before.clone();
            moved.nodes.get_mut("frame").unwrap().transform.0[4] += dx;
            let patch = crate::editing::DocumentPatch::between(&before, &moved).unwrap();
            assert!(engine.can_retain_translation(&patch));
            assert!(engine.apply_clipped_root_translation(&patch).unwrap().is_none(),
                "the private receipt must not authorize the root fast lane");
            let mut expected = crate::dirty_region::patch_damage_with_fonts(&before, &moved, &patch, &engine.fonts);
            expected.translation_only = Some(true);
            let before_count = crate::editing::document_size_count_calls();
            let actual = engine.apply_document_patch_with_damage(&patch).unwrap();
            assert_eq!(crate::editing::document_size_count_calls() - before_count, 1,
                "generic apply, including validation and its count, still runs");
            assert_eq!(serde_json::to_value(actual).unwrap(), serde_json::to_value(expected).unwrap());
            assert_eq!(engine.source_doc_bytes, None);
            assert_eq!(retained_receipt_bytes(&engine), Some(serde_json::to_vec(&moved).unwrap().len()));
            assert_retained_receipt_matches_fresh(&mut engine);
        }
        // Exactly the old transition: a successful explicit interaction can
        // set source_doc_bytes and authorize a later root fast lane.
        let mut transform = engine.source_doc.as_ref().unwrap().nodes["child"].transform;
        transform.0[4] += 0.25;
        assert!(engine.apply_interaction_transforms(&[("child".into(), transform)].into()).unwrap());
        assert!(engine.retained_source_size.is_none());
        let before = engine.source_doc.clone().unwrap();
        let mut moved = before.clone();
        moved.nodes.get_mut("frame").unwrap().transform.0[4] += 2.125;
        let patch = crate::editing::DocumentPatch::between(&before, &moved).unwrap();
        let before_count = crate::editing::document_size_count_calls();
        engine.apply_document_patch_with_damage(&patch).unwrap();
        assert_eq!(crate::editing::document_size_count_calls() - before_count, 0);
        assert!(engine.source_doc_bytes.is_some());
        assert!(engine.retained_source_size.is_none());
        assert_retained_receipt_matches_fresh(&mut engine);
    }
}

#[test]
fn retained_paint_does_not_advance_glass_eligibility() {
    let mut original = source();
    original.schema_version = 5;
    let frame = original.nodes.get_mut("frame").unwrap();
    frame.fills[0].opacity = 0.2;
    frame.effects = vec![serde_json::from_value(json!({
        "kind":"glass","visible":true,"radius":4,"color":"#000000","opacity":0.5,"amount":14,
        "glass":{"depth":8,"refraction":0.5,"dispersion":0.3,"lightAngle":45,"lightIntensity":0.5}
    })).unwrap()];
    let mut engine = retained_painted_engine(original);
    for id in ["frame", "child", "frame"] {
        let before = engine.source_doc.clone().unwrap();
        let mut moved = before.clone();
        moved.nodes.get_mut(id).unwrap().transform.0[4] += 3.375;
        let patch = crate::editing::DocumentPatch::between(&before, &moved).unwrap();
        let before_count = crate::editing::document_size_count_calls();
        let damage = engine.apply_document_patch_with_damage(&patch).unwrap();
        assert_eq!(crate::editing::document_size_count_calls() - before_count, 1);
        assert!(damage.full);
        assert_eq!(damage.reason, Some("glass-effect"));
        assert_eq!(damage.translation_only, Some(true));
        assert_eq!(engine.source_doc_bytes, None);
        assert_eq!(retained_receipt_bytes(&engine), Some(serde_json::to_vec(&moved).unwrap().len()));
        assert_retained_receipt_matches_fresh(&mut engine);
    }
    let mut transform = engine.source_doc.as_ref().unwrap().nodes["child"].transform;
    transform.0[4] += 0.25;
    let before_count = crate::editing::document_size_count_calls();
    assert!(engine.apply_interaction_transforms(&[("child".into(), transform)].into()).unwrap());
    assert_eq!(crate::editing::document_size_count_calls() - before_count, 0);
    assert!(engine.retained_source_size.is_none());
    let before = engine.source_doc.clone().unwrap();
    let mut moved = before.clone();
    moved.nodes.get_mut("frame").unwrap().transform.0[4] += 2.125;
    let patch = crate::editing::DocumentPatch::between(&before, &moved).unwrap();
    let before_count = crate::editing::document_size_count_calls();
    assert!(engine.apply_document_patch_with_damage(&patch).unwrap().full);
    assert_eq!(crate::editing::document_size_count_calls() - before_count, 0);
    assert!(engine.source_doc_bytes.is_some());
    assert!(engine.retained_source_size.is_none());
    assert_retained_receipt_matches_fresh(&mut engine);
}

#[test]
fn rejected_edits_preserve_private_receipt_and_render_state() {
    let mut engine = retained_painted_engine(source());
    engine.compile_gpu(&options()).unwrap();
    let original = engine.source_doc.clone().unwrap();
    let source_bytes = serde_json::to_vec(&original).unwrap();
    let derived_bytes = serde_json::to_vec(engine.doc.as_ref().unwrap()).unwrap();
    let exact = retained_receipt_bytes(&engine);
    let revision = engine.geo_revision;
    let prepared = engine.camera_prepare.as_ref().unwrap().prepared.clone();
    let index = engine.render_index.clone().unwrap();
    let mut invalid = original.nodes["child"].clone();
    invalid.transform.0[4] = f64::NAN;
    let patches = [
        crate::editing::DocumentPatch { nodes: [("child".into(), Some(invalid))].into(), fields: Default::default() },
        crate::editing::DocumentPatch { nodes: Default::default(), fields: [("fonts".into(), json!({"bad": {"family":"Broken","data":"!"}}))].into() },
        crate::editing::DocumentPatch { nodes: Default::default(), fields: [("schemaVersion".into(), json!(0))].into() },
    ];
    for patch in patches {
        let expected = patch.apply(&original).unwrap_err().to_string();
        assert_eq!(engine.apply_document_patch_with_damage(&patch).err().unwrap(), expected);
        assert_eq!(serde_json::to_vec(engine.source_doc.as_ref().unwrap()).unwrap(), source_bytes);
        assert_eq!(serde_json::to_vec(engine.doc.as_ref().unwrap()).unwrap(), derived_bytes);
        assert_eq!(engine.source_doc_bytes, None);
        assert_eq!(retained_receipt_bytes(&engine), exact);
        assert_eq!(engine.geo_revision, revision);
        assert!(Arc::ptr_eq(&prepared, &engine.camera_prepare.as_ref().unwrap().prepared));
        assert!(Arc::ptr_eq(&index, engine.render_index.as_ref().unwrap()));
    }
    for transforms in [
        [("child".into(), Transform([1.,0.,0.,1.,f64::NAN,10.]))].into(),
        [("missing".into(), Transform::default())].into(),
        std::collections::BTreeMap::new(),
    ] {
        let before_count = crate::editing::document_size_count_calls();
        assert!(engine.apply_interaction_transforms(&transforms).is_err());
        assert_eq!(crate::editing::document_size_count_calls(), before_count);
        assert_eq!(serde_json::to_vec(engine.source_doc.as_ref().unwrap()).unwrap(), source_bytes);
        assert_eq!(engine.source_doc_bytes, None);
        assert_eq!(retained_receipt_bytes(&engine), exact);
        assert_eq!(engine.geo_revision, revision);
    }
    assert_retained_receipt_matches_fresh(&mut engine);
}

#[test]
fn generic_install_and_load_replace_receipt_without_changing_old_accounting() {
    for (field, value) in [
        ("name", json!("changed name")),
        ("schemaVersion", json!(16)),
        ("rasterProfile", json!("figma")),
        ("fonts", json!({})),
    ] {
        let mut engine = retained_painted_engine(source());
        let patch = crate::editing::DocumentPatch { nodes: Default::default(), fields: [(field.into(), value)].into() };
        let before_count = crate::editing::document_size_count_calls();
        engine.apply_document_patch_with_damage(&patch).unwrap();
        assert_eq!(crate::editing::document_size_count_calls() - before_count, 2,
            "generic apply plus install still recount; this candidate does not change that path");
        assert!(engine.retained_source_size.is_none());
        assert_eq!(engine.source_doc_bytes, Some(serde_json::to_vec(engine.source_doc.as_ref().unwrap()).unwrap().len()));
        assert_retained_receipt_matches_fresh(&mut engine);
    }
    let mut engine = retained_painted_engine(source());
    let mut replacement = source();
    replacement.id = "new-document".into();
    replacement.name = "loaded separately".into();
    engine.load_document(&serde_json::to_string(&replacement).unwrap()).unwrap();
    assert!(engine.retained_source_size.is_none());
    assert_eq!(engine.source_doc.as_deref(), Some(&replacement));
    assert_eq!(engine.source_doc_bytes, Some(serde_json::to_vec(&replacement).unwrap().len()));
    assert_retained_receipt_matches_fresh(&mut engine);
}

#[test]
fn private_receipt_is_bound_to_allocation_not_document_equality() {
    for change_content in [false, true] {
        let mut engine = retained_painted_engine(source());
        let previous_receipt = engine.retained_source_size.as_ref().unwrap().clone();
        if change_content {
            // Defense-in-depth fault injection, not a production mutation:
            // even sole-owner COW detaches while this Weak receipt exists.
            engine.source_doc.as_mut().unwrap().name.push_str(" changed");
        } else {
            let equal_document: Document = (**engine.source_doc.as_ref().unwrap()).clone();
            engine.source_doc = Some(equal_document.into());
        }
        assert!(previous_receipt.bytes_for(engine.source_doc.as_ref().unwrap()).is_none());
        assert_eq!(retained_receipt_bytes(&engine), None);
        let mut transform = engine.source_doc.as_ref().unwrap().nodes["child"].transform;
        transform.0[4] += 0.375;
        let before_count = crate::editing::document_size_count_calls();
        assert!(engine.apply_interaction_transforms(&[("child".into(), transform)].into()).unwrap());
        assert_eq!(crate::editing::document_size_count_calls() - before_count, 1,
            "a mismatched receipt must take the existing exact recount fallback");
        assert_eq!(engine.source_doc_bytes, Some(serde_json::to_vec(engine.source_doc.as_ref().unwrap()).unwrap().len()));
        assert!(engine.retained_source_size.is_none());
    }
}

#[test]
fn retained_receipts_follow_shared_snapshot_identity_and_detach_independently() {
    let mut owner = retained_painted_engine(source());
    let mut worker = owner.snapshot_worker();
    let original = serde_json::to_vec(worker.source_doc.as_ref().unwrap()).unwrap();
    assert_eq!(retained_receipt_bytes(&owner), retained_receipt_bytes(&worker));
    assert!(worker.retained_source_size.as_ref().unwrap().bytes_for(owner.source_doc.as_ref().unwrap()).is_some());
    let mut owner_transform = owner.source_doc.as_ref().unwrap().nodes["child"].transform;
    owner_transform.0[4] = -1234.875;
    let before_count = crate::editing::document_size_count_calls();
    assert!(owner.apply_interaction_transforms(&[("child".into(), owner_transform)].into()).unwrap());
    assert_eq!(crate::editing::document_size_count_calls() - before_count, 0);
    assert!(owner.retained_source_size.is_none());
    assert_eq!(worker.source_doc_bytes, None);
    assert_eq!(retained_receipt_bytes(&worker), Some(original.len()));
    assert_eq!(serde_json::to_vec(worker.source_doc.as_ref().unwrap()).unwrap(), original);
    let mut worker_transform = worker.source_doc.as_ref().unwrap().nodes["child"].transform;
    worker_transform.0[4] = 22.125;
    let before_count = crate::editing::document_size_count_calls();
    assert!(worker.apply_interaction_transforms(&[("child".into(), worker_transform)].into()).unwrap());
    assert_eq!(crate::editing::document_size_count_calls() - before_count, 0);
    assert_eq!(owner.source_doc.as_ref().unwrap().nodes["child"].transform.0[4].to_bits(), (-1234.875f64).to_bits());
    assert!(worker.retained_source_size.is_none());
    assert_retained_receipt_matches_fresh(&mut owner);
    drop(owner);
    assert_retained_receipt_matches_fresh(&mut worker);
}

#[test]
fn retained_paint_then_generic_root_move_preserves_backdrop_damage() {
    let mut original = source();
    original.nodes.insert("backdrop".into(), serde_json::from_value(json!({
        "id":"backdrop","kind":"frame","clip":true,"width":55,"height":65,
        "transform":[1,0,0,1,61,15],"blend":"multiply","opacity":0.8,
        "fills":[{"kind":"solid","color":"#88aacc","opacity":0.1}],
        "effects":[{"kind":"background-blur","radius":6,"color":"#000000","visible":true}]
    })).unwrap());
    original.pages[0].children.push("backdrop".into());
    let mut engine = retained_painted_engine(original);
    let opts = options();
    let before_pixels = engine.render(&opts).unwrap();
    let before = engine.source_doc.clone().unwrap();
    let mut moved = before.clone();
    moved.nodes.get_mut("frame").unwrap().transform.0[4] += 13.375;
    let patch = crate::editing::DocumentPatch::between(&before, &moved).unwrap();
    let damage = engine.apply_document_patch_with_damage(&patch).unwrap();
    assert!(!damage.full);
    assert_eq!(damage.translation_only, Some(true));
    assert_eq!(engine.source_doc_bytes, None);
    let after_pixels = engine.render(&opts).unwrap();
    assert_retained_receipt_matches_fresh(&mut engine);
    let regions = damage.rects.unwrap();
    let mut changed = 0;
    for (index, (a, b)) in before_pixels.chunks_exact(4).zip(after_pixels.chunks_exact(4)).enumerate() {
        if a == b { continue; }
        changed += 1;
        let x = ((index % opts.width as usize) as f64 + 0.5 - opts.view.x) / opts.view.zoom;
        let y = ((index / opts.width as usize) as f64 + 0.5 - opts.view.y) / opts.view.zoom;
        assert!(regions.iter().any(|r| x >= r[0] && y >= r[1] && x <= r[0] + r[2] && y <= r[1] + r[3]),
            "unreported changed pixel {x},{y}");
    }
    assert!(changed > 0);
}

// Run this ignored test ALONE in a fresh process. It pins global capacity.
#[test]
#[ignore = "isolated process only: pins exact document capacity"]
fn receipt_interaction_budget_rejection_preserves_state_and_can_retry() {
    let original = source();
    let mut painted = original.clone();
    painted.nodes.get_mut("child").unwrap().opacity = 0.625;
    let mut over = painted.clone();
    over.nodes.get_mut("child").unwrap().transform.0[4] = -123456.875;
    let exact = serde_json::to_vec(&over).unwrap().len();
    let limit = exact - 1;
    assert!(serde_json::to_vec(&painted).unwrap().len() <= limit);
    crate::capacity::configure(limit as u64 * crate::capacity::REPRESENTATION_RESERVE).unwrap();
    let mut engine = retained_painted_engine(original);
    let before = serde_json::to_vec(engine.source_doc.as_ref().unwrap()).unwrap();
    let derived = serde_json::to_vec(engine.doc.as_ref().unwrap()).unwrap();
    let revision = engine.geo_revision;
    let count = crate::editing::document_size_count_calls();
    let error = engine.apply_interaction_transforms(&[("child".into(), over.nodes["child"].transform)].into()).unwrap_err();
    assert_eq!(error, crate::capacity::check_document_bytes(exact).unwrap_err());
    assert_eq!(crate::editing::document_size_count_calls(), count);
    assert_eq!(serde_json::to_vec(engine.source_doc.as_ref().unwrap()).unwrap(), before);
    assert_eq!(serde_json::to_vec(engine.doc.as_ref().unwrap()).unwrap(), derived);
    assert_eq!(engine.geo_revision, revision);
    assert_eq!(engine.source_doc_bytes, None);
    assert_eq!(retained_receipt_bytes(&engine), Some(before.len()));
    let mut retry = painted.nodes["child"].transform;
    retry.0[4] = 11.;
    assert!(engine.apply_interaction_transforms(&[("child".into(), retry)].into()).unwrap());
    assert_eq!(crate::editing::document_size_count_calls(), count);
    assert!(engine.retained_source_size.is_none());
    assert_eq!(engine.source_doc_bytes, Some(serde_json::to_vec(engine.source_doc.as_ref().unwrap()).unwrap().len()));
}

#[test]
fn retained_receipt_preserves_affine_interaction_and_exact_packets() {
    let mut engine = retained_painted_engine(source());
    engine.compile_gpu(&options()).unwrap();
    let transform = Transform([0., -1., 1., 0., 12.25, 10.375]);
    let before_count = crate::editing::document_size_count_calls();
    assert!(engine.apply_interaction_transforms(&[("child".into(), transform)].into()).unwrap());
    assert_eq!(crate::editing::document_size_count_calls() - before_count, 0);
    assert!(engine.retained_source_size.is_none());
    assert_eq!(engine.source_doc_bytes, Some(serde_json::to_vec(engine.source_doc.as_ref().unwrap()).unwrap().len()));
    assert_retained_receipt_matches_fresh(&mut engine);
}
