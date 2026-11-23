use super::*;
use serde_json::json;

fn options() -> RenderOptions {
    serde_json::from_value(json!({"pageId":"p","width":160,"height":96,
        "view":{"x":0.25,"y":0.5,"zoom":1},"transparent":false,"grid":false}))
    .unwrap()
}

fn resolved() -> Document {
    let mut doc: Document = serde_json::from_value(json!({"schemaVersion":21,"id":"nested-render","name":"nested render",
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":["badge","icon","button-set","card","card-instance"]}],
        "nodes":{
            "mark":{"id":"mark","kind":"rectangle","width":8,"height":8,"fills":[{"kind":"solid","color":"#336699"}]},
            "badge":{"id":"badge","kind":"frame","width":16,"height":12,"children":["mark"],"component":{"variants":{},"properties":{}}},
            "badge-slot":{"id":"badge-slot","kind":"frame","width":16,"height":12,"componentKey":"badgeSlot","instance":{"componentId":"badge","overrides":{},"propertyValues":{}}},
            "swatch":{"id":"swatch","kind":"rectangle","width":10,"height":10,"transform":[1,0,0,1,12,0],"fills":[{"kind":"solid","color":"#336699"}]},
            "icon":{"id":"icon","kind":"frame","width":28,"height":16,"children":["badge-slot","swatch"],"component":{"variants":{},"properties":{}}},
            "icon-slot":{"id":"icon-slot","kind":"frame","width":28,"height":16,"componentKey":"iconSlot","instance":{"componentId":"icon","overrides":{},"propertyValues":{}}},
            "button-default":{"id":"button-default","kind":"frame","width":80,"height":24,"children":["icon-slot"],"component":{"variants":{"状态":"默认"},"properties":{}}},
            "button-hover-icon":{"id":"button-hover-icon","kind":"frame","width":28,"height":16,"componentKey":"iconSlot","instance":{"componentId":"icon","overrides":{},"propertyValues":{}}},
            "button-hover":{"id":"button-hover","kind":"frame","width":80,"height":24,"children":["button-hover-icon"],"component":{"variants":{"状态":"悬停"},"properties":{}}},
            "button-set":{"id":"button-set","kind":"section","width":200,"height":40,"componentSet":true,"children":["button-default","button-hover"]},
            "action":{"id":"action","kind":"frame","width":80,"height":24,"componentKey":"action","instance":{"componentId":"button-default","overrides":{},"propertyValues":{}}},
            "card":{"id":"card","kind":"frame","width":120,"height":48,"children":["action"],"component":{"variants":{},"properties":{}}},
            "card-instance":{"id":"card-instance","kind":"frame","width":120,"height":48,"transform":[1,0,0,1,12,18],
                "instance":{"componentId":"card","overrides":{"action/iconSlot/swatch":{"fills":[{"kind":"solid","color":"#c4552a"}]}},"propertyValues":{}}}
        }})).unwrap();
    let fonts = crate::font::Fonts::new();
    crate::components::resolve(&mut doc).unwrap();
    crate::layout::resolve(&mut doc, &fonts).unwrap();
    crate::curve_boolean::resolve(&mut doc).unwrap();
    doc
}

fn generated(doc: &Document, key: &str) -> String {
    doc.nodes
        .values()
        .find(|n| {
            n.instance_origin
                .as_ref()
                .is_some_and(|o| o.owner == "card-instance" && o.key == key)
        })
        .unwrap()
        .id
        .clone()
}

fn translate(doc: &Document) -> Document {
    let mut next = doc.clone();
    let id = generated(&next, "action");
    next.nodes.get_mut(&id).unwrap().transform.0[4] += 14.25;
    let transform = serde_json::to_value(next.nodes[&id].transform).unwrap();
    next.nodes
        .get_mut("card-instance")
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .overrides
        .entry("action".into())
        .or_default()
        .insert("transform".into(), transform);
    next
}

#[test]
fn nested_instance_drag_repaints_the_moved_instance_without_reexpansion() {
    let base = resolved();
    let moved = generated(&base, "action");
    assert!(base.nodes[&moved].instance.is_some());
    let mut engine = Engine::new();
    engine.install_document(base.clone()).unwrap();
    let before = engine.render(&options()).unwrap();
    let next = translate(engine.source_doc.as_ref().unwrap());
    let patch =
        crate::editing::DocumentPatch::between(engine.source_doc.as_ref().unwrap(), &next).unwrap();
    let fast = crate::component_updates::nested_drag::fast_redraw_count();
    let damage = engine.apply_document_patch_with_damage(&patch).unwrap();
    assert_eq!(
        crate::component_updates::nested_drag::fast_redraw_count(),
        fast + 1
    );
    assert!(!damage.full);
    assert_eq!(damage.translation_only, Some(true));
    assert!(!engine.layout_dirty);
    assert_eq!(
        engine.source_doc_bytes,
        Some(
            serde_json::to_vec(engine.source_doc.as_ref().unwrap())
                .unwrap()
                .len()
        )
    );
    let mut fresh = Engine::new();
    fresh.install_document(next).unwrap();
    assert_ne!(
        engine.render(&options()).unwrap(),
        before,
        "the nested instance must move"
    );
    assert_eq!(
        engine
            .compile_gpu(&options())
            .unwrap()
            .into_packet()
            .unwrap(),
        fresh
            .compile_gpu(&options())
            .unwrap()
            .into_packet()
            .unwrap()
    );
    assert_eq!(
        engine.render(&options()).unwrap(),
        fresh.render(&options()).unwrap()
    );
}

#[test]
fn nested_variant_swap_keeps_the_authoritative_rebuild() {
    let base = resolved();
    let mut engine = Engine::new();
    engine.install_document(base).unwrap();
    engine.compile_gpu(&options()).unwrap();
    let mut next = engine.source_doc.as_ref().unwrap().clone();
    next.nodes
        .get_mut("card-instance")
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .overrides
        .entry("action".into())
        .or_default()
        .insert("swapComponent".into(), json!("button-hover"));
    let mut oracle = next.clone();
    let fonts = crate::font::Fonts::new();
    crate::components::resolve(&mut oracle).unwrap();
    crate::layout::resolve(&mut oracle, &fonts).unwrap();
    crate::curve_boolean::resolve(&mut oracle).unwrap();
    let patch =
        crate::editing::DocumentPatch::between(engine.source_doc.as_ref().unwrap(), &next).unwrap();
    let fast = crate::component_updates::nested_drag::fast_redraw_count();
    engine.apply_document_patch_with_damage(&patch).unwrap();
    assert_eq!(
        crate::component_updates::nested_drag::fast_redraw_count(),
        fast
    );
    let mut fresh = Engine::new();
    fresh.install_document(oracle).unwrap();
    assert_eq!(
        engine.render(&options()).unwrap(),
        fresh.render(&options()).unwrap()
    );
    let moved = generated(engine.doc.as_ref().unwrap(), "action");
    assert_eq!(
        engine.doc.as_ref().unwrap().nodes[&moved]
            .instance
            .as_ref()
            .unwrap()
            .component_id,
        "button-hover"
    );
}
