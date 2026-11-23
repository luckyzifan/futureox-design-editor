use super::*;
use serde_json::json;

fn options() -> RenderOptions {
    serde_json::from_value(json!({"pageId":"page","width":180,"height":140,
        "view":{"x":0,"y":0,"zoom":1},"transparent":false,"grid":false,"rasterProfile":"analytic"})).unwrap()
}

fn symbol(extra: serde_json::Value) -> serde_json::Value {
    let mut nodes = json!({
        "board":{"id":"board","kind":"frame","width":360,"height":220,"clip":true,"children":["instance","other"]},
        "master":{"id":"master","kind":"frame","width":80,"height":48,"children":["mark","nested"],"component":{}},
        "mark":{"id":"mark","kind":"rectangle","width":28,"height":16,"transform":[1,0,0,1,6,8],
            "fills":[{"kind":"solid","color":"#336699"}],
            "effects":[{"kind":"shadow","radius":4,"x":2,"y":3,"spread":0,"color":"#204060","opacity":0.8}]},
        "icon":{"id":"icon","kind":"frame","width":12,"height":12,"children":["icon-shape"],"component":{}},
        "icon-shape":{"id":"icon-shape","kind":"ellipse","width":12,"height":12,"fills":[{"kind":"solid","color":"#d45500"}]},
        "nested":{"id":"nested","kind":"frame","width":12,"height":12,"transform":[1,0,0,1,40,8],"instance":{"componentId":"icon"}},
        "instance":{"id":"instance","kind":"frame","width":80,"height":48,"clip":true,"transform":[1,0,0,1,24,30],
            "instance":{"componentId":"master","overrides":{"mark":{"fills":[{"kind":"solid","color":"#11aa55"}]}},"propertyValues":{}}},
        "other":{"id":"other","kind":"frame","width":80,"height":48,"transform":[1,0,0,1,150,36],"instance":{"componentId":"master"}}
    });
    if let Some(object) = extra.as_object() {
        for (id, node) in object {
            nodes[id] = node.clone();
        }
    }
    json!({"schemaVersion":21,"id":"instance-drag","name":"instance drag",
        "pages":[{"id":"page","name":"page","background":"#ffffff","children":["board","master","icon"]}],
        "nodes":nodes})
}

fn load(value: &serde_json::Value) -> Engine {
    let mut engine = Engine::new();
    engine.load_document(&value.to_string()).unwrap();
    engine
}

fn prove(label: &str, mut engine: Engine, poses: &[Transform]) {
    let options = options();
    // Resolve once, then publish that expanded instance the way the editor does.
    engine.compile_gpu(&options).unwrap();
    let published = (&**engine.doc.as_ref().unwrap()).clone();
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(&published).unwrap()).unwrap();
    engine.compile_gpu(&options).unwrap();
    let other = engine.doc.as_ref().unwrap().nodes["other"].clone();
    for (index, transform) in poses.iter().enumerate() {
        assert!(engine.apply_interaction_transforms(&[("instance".into(), *transform)].into()).unwrap(), "{label} step {index}");
        let authored = (&**engine.source_doc.as_ref().unwrap()).clone();
        let mut fresh = Engine::new();
        fresh.load_document(&serde_json::to_string(&authored).unwrap()).unwrap();
        let pose_packet = engine.compile_gpu(&options).unwrap().into_packet().unwrap();
        let fresh_packet = fresh.compile_gpu(&options).unwrap().into_packet().unwrap();
        assert_eq!(pose_packet, fresh_packet, "{label} packet step {index}");
        assert_eq!(&**engine.doc.as_ref().unwrap(), &**fresh.doc.as_ref().unwrap(), "{label} resolved step {index}");
        assert_eq!(engine.render(&options).unwrap(), fresh.render(&options).unwrap(), "{label} pixels step {index}");
        assert_eq!(engine.doc.as_ref().unwrap().nodes["other"], other, "{label} other instance step {index}");
    }
}

#[test]
fn dragging_a_top_level_instance_keeps_resolved_children_and_matches_a_fresh_compile() {
    let engine = load(&symbol(json!({})));
    prove("plain", engine, &[
        Transform([1., 0., 0., 1., 51.25, 18.5]),
        Transform([0.6, 0.8, -0.8, 0.6, 36., 28.]),
        Transform([1.25, 0., 0., 0.75, 18., 22.]),
        Transform([1., 0., 0., 1., 24., 30.]),
    ]);
}

#[test]
fn an_auto_layout_symbol_and_an_internal_boolean_follow_the_same_pose() {
    let mut layout = symbol(json!({}));
    layout["nodes"]["master"]["layout"] = json!({"mode":"horizontal"});
    prove("layout", load(&layout), &[Transform([1., 0., 0., 1., 40.5, 16.])]);
    let boolean = symbol(json!({
        "cut":{"id":"cut","kind":"vector","width":30,"height":24,"booleanOperation":"union","children":["cut-a","cut-b"],"fills":[{"kind":"solid","color":"#8064d2"}]},
        "cut-a":{"id":"cut-a","kind":"rectangle","width":20,"height":16,"fills":[{"kind":"solid","color":"#8064d2"}]},
        "cut-b":{"id":"cut-b","kind":"rectangle","width":16,"height":16,"transform":[1,0,0,1,10,8],"fills":[{"kind":"solid","color":"#8064d2"}]}
    }));
    let mut boolean = boolean;
    boolean["nodes"]["master"]["children"].as_array_mut().unwrap().push(json!("cut"));
    prove("boolean", load(&boolean), &[Transform([1., 0., 0., 1., 33., 12.5])]);
}

#[test]
fn generated_layers_layout_parents_width_mismatch_and_connectors_stay_on_the_full_path() {
    let mut seeded = load(&symbol(json!({})));
    seeded.compile_gpu(&options()).unwrap();
    let published = (&**seeded.doc.as_ref().unwrap()).clone();
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(&published).unwrap()).unwrap();
    engine.compile_gpu(&options()).unwrap();
    let before_source = serde_json::to_vec(&**engine.source_doc.as_ref().unwrap()).unwrap();
    let before_resolved = serde_json::to_vec(&**engine.doc.as_ref().unwrap()).unwrap();
    let generated = engine.doc.as_ref().unwrap().nodes.values()
        .find(|node| node.instance_origin.as_ref().is_some_and(|origin| origin.owner == "instance"))
        .unwrap().id.clone();
    assert_eq!(engine.apply_interaction_transforms(&[(generated, Transform([1., 0., 0., 1., 4., 4.]))].into()).unwrap(), false);
    assert_eq!(serde_json::to_vec(&**engine.source_doc.as_ref().unwrap()).unwrap(), before_source);
    assert_eq!(serde_json::to_vec(&**engine.doc.as_ref().unwrap()).unwrap(), before_resolved);

    let mut flowed = symbol(json!({}));
    flowed["nodes"]["board"]["layout"] = json!({"mode":"horizontal"});
    let mut engine = load(&flowed);
    engine.compile_gpu(&options()).unwrap();
    assert!(!engine.apply_interaction_transforms(&[("instance".into(), Transform([1., 0., 0., 1., 70., 30.]))].into()).unwrap());

    let mut mismatched = symbol(json!({}));
    mismatched["nodes"]["instance"]["width"] = json!(140);
    mismatched["nodes"]["instance"]["height"] = json!(90);
    let mut engine = load(&mismatched);
    engine.compile_gpu(&options()).unwrap();
    assert_ne!(engine.source_doc.as_ref().unwrap().nodes["instance"].width, engine.doc.as_ref().unwrap().nodes["instance"].width);
    assert!(!engine.apply_interaction_transforms(&[("instance".into(), Transform([1., 0., 0., 1., 48., 20.]))].into()).unwrap());

    let mut wired = symbol(json!({
        "wire":{"id":"wire","kind":"vector","width":40,"height":8,"transform":[1,0,0,1,0,200],
            "connector":{"from":{"point":{"x":0,"y":0},"nodeId":"instance","anchor":{"x":0.5,"y":0.5}},"to":{"point":{"x":80,"y":0}},"style":"straight"}}
    }));
    wired["pages"][0]["children"].as_array_mut().unwrap().push(json!("wire"));
    let mut engine = load(&wired);
    engine.compile_gpu(&options()).unwrap();
    assert!(!engine.apply_interaction_transforms(&[("instance".into(), Transform([1., 0., 0., 1., 48., 20.]))].into()).unwrap());
}

#[test]
fn a_pose_then_a_sibling_edit_still_matches_full_resolution() {
    let options = options();
    let mut engine = load(&symbol(json!({})));
    engine.compile_gpu(&options).unwrap();
    assert!(engine.apply_interaction_transforms(&[("instance".into(), Transform([1., 0., 0., 1., 60., 24.]))].into()).unwrap());
    let mut authored = (&**engine.source_doc.as_ref().unwrap()).clone();
    authored.nodes.get_mut("other").unwrap().opacity = 0.4;
    let patch = crate::editing::DocumentPatch::between(engine.source_doc.as_ref().unwrap(), &authored).unwrap();
    engine.apply_document_patch_with_damage(&patch).unwrap();
    let mut fresh = Engine::new();
    fresh.load_document(&serde_json::to_string(&authored).unwrap()).unwrap();
    fresh.compile_gpu(&options).unwrap();
    engine.compile_gpu(&options).unwrap();
    assert_eq!(&**engine.doc.as_ref().unwrap(), &**fresh.doc.as_ref().unwrap());
    assert_eq!(engine.render(&options).unwrap(), fresh.render(&options).unwrap());
}
