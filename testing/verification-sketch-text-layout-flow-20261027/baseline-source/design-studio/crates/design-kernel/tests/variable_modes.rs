use futureox_design_kernel::{
    components, design_system,
    editing::{DocumentEditor, DocumentPatch},
    font::Fonts,
    scene::Document,
};
use serde_json::{Value, json};

fn fixture() -> Document {
    serde_json::from_value(json!({
        "schemaVersion":6,"id":"d","name":"Node modes",
        "pages":[{"id":"p","name":"Page","background":"#ffffff","children":["main","light","dark"]}],
        "designSystem":{
            "collections":{"theme":{"name":"Theme","modes":["light","dark"],"defaultMode":"light"},
                "density":{"name":"Density","modes":["light","dark"],"defaultMode":"light"}},
            "variables":{
                "width":{"name":"Width","collection":"theme","kind":"number","values":{"light":20,"dark":80}},
                "alias":{"name":"Alias","collection":"density","kind":"number","values":{"light":{"alias":"width"},"dark":{"alias":"width"}}},
                "color":{"name":"Color","collection":"theme","kind":"color","values":{"light":"#ff0000","dark":"#0000ff"}},
                "visible":{"name":"Visible","collection":"theme","kind":"boolean","values":{"light":true,"dark":false}}
            },
            "styles":{"paint":{"name":"Paint","kind":"paint","value":[{"kind":"solid","color":"#ffffff"}]}}
        },
        "nodes":{
            "main":{"id":"main","kind":"frame","width":100,"height":100,"children":["leaf"],"component":{}},
            "leaf":{"id":"leaf","kind":"rectangle","width":10,"height":10,"bindings":{"width":"alias","fills.0.color":"color"},"styleRefs":{"fills":"paint"}},
            "light":{"id":"light","kind":"frame","width":100,"height":100,"children":["a"]},
            "dark":{"id":"dark","kind":"frame","width":100,"height":100,"children":["b"],"variableModes":{"theme":"dark"}},
            "a":{"id":"a","kind":"frame","width":100,"height":100,"instance":{"componentId":"main"}},
            "b":{"id":"b","kind":"frame","width":100,"height":100,"instance":{"componentId":"main"}}
        }
    })).unwrap()
}
fn resolved(source: &Document) -> Document {
    let changes: Value = serde_json::from_str(
        &components::changes(&serde_json::to_string(source).unwrap(), &Fonts::new()).unwrap(),
    )
    .unwrap();
    let mut result = source.clone();
    for id in changes["removed"].as_array().unwrap() {
        result.nodes.remove(id.as_str().unwrap());
    }
    for (id, n) in changes["nodes"].as_object().unwrap() {
        result
            .nodes
            .insert(id.clone(), serde_json::from_value(n.clone()).unwrap());
    }
    result.validate().unwrap();
    result
}
fn child<'a>(d: &'a Document, owner: &str, path: &str) -> &'a futureox_design_kernel::scene::Node {
    d.nodes
        .values()
        .find(|n| {
            n.instance_origin
                .as_ref()
                .is_some_and(|o| o.owner == owner && o.key == path)
        })
        .unwrap()
}
fn set_mode(d: &mut Document, id: &str, mode: &str) {
    d.nodes
        .get_mut(id)
        .unwrap()
        .variable_modes
        .insert("theme".into(), mode.into());
}
fn overrides(d: &mut Document, owner: &str, key: &str, fields: Value) {
    d.nodes
        .get_mut(owner)
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .overrides
        .insert(key.into(), serde_json::from_value(fields).unwrap());
}

#[test]
fn materialized_instances_resolve_aliases_from_distinct_ancestors() {
    let source = fixture();
    let original = serde_json::to_string(&source).unwrap();
    let mut d = resolved(&source);
    assert_eq!(child(&d, "a", "leaf").width, 20.);
    assert_eq!(child(&d, "b", "leaf").width, 80.);
    assert_eq!(child(&d, "a", "leaf").fills[0].color, "#ff0000");
    assert_eq!(child(&d, "b", "leaf").fills[0].color, "#0000ff");
    assert_eq!(serde_json::to_string(&source).unwrap(), original);
    d.design_system
        .as_mut()
        .unwrap()
        .active_modes
        .insert("theme".into(), "dark".into());
    d = resolved(&d);
    assert_eq!(child(&d, "a", "leaf").width, 80.);
    set_mode(&mut d, "light", "light");
    assert_eq!(child(&resolved(&d), "a", "leaf").width, 20.);
}
#[test]
fn nearest_local_modes_and_explicit_properties_keep_precedence() {
    let mut d = fixture();
    set_mode(&mut d, "leaf", "light");
    assert_eq!(child(&resolved(&d), "b", "leaf").width, 20.);
    overrides(
        &mut d,
        "b",
        "leaf",
        json!({"variableModes":{"theme":"dark"},"width":37,"fills":[]}),
    );
    let d = resolved(&d);
    assert_eq!(child(&d, "b", "leaf").width, 37.);
    assert!(child(&d, "b", "leaf").fills.is_empty());
    assert_eq!(resolved(&d), d);
}
#[test]
fn cleared_root_override_and_reparent_restore_inheritance_after_reload() {
    let mut d = fixture();
    overrides(
        &mut d,
        "a",
        "$root",
        json!({"variableModes":{"theme":"dark"}}),
    );
    d = resolved(&d);
    assert_eq!(child(&d, "a", "leaf").width, 80.);
    assert!(d.nodes["a"].variable_modes.is_empty());
    d = serde_json::from_str(&serde_json::to_string(&d).unwrap()).unwrap();
    d.nodes
        .get_mut("a")
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .overrides
        .clear();
    d = resolved(&d);
    assert_eq!(child(&d, "a", "leaf").width, 20.);
    d.nodes.get_mut("light").unwrap().children.clear();
    d.nodes.get_mut("dark").unwrap().children.push("a".into());
    d = resolved(&d);
    assert_eq!(child(&d, "a", "leaf").width, 80.);
    assert!(d.nodes["a"].variable_modes.is_empty());
}
#[test]
fn template_root_modes_are_live_defaults_and_never_become_placement_modes() {
    let mut d = fixture();
    set_mode(&mut d, "main", "dark");
    d = resolved(&d);
    assert_eq!(child(&d, "a", "leaf").width, 80.);
    assert!(d.nodes["a"].variable_modes.is_empty());
    d.nodes.get_mut("main").unwrap().variable_modes.clear();
    d = resolved(&d);
    assert_eq!(child(&d, "a", "leaf").width, 20.);
    set_mode(&mut d, "a", "light");
    assert_eq!(child(&resolved(&d), "a", "leaf").width, 20.);
    set_mode(&mut d, "main", "dark");
    assert_eq!(child(&resolved(&d), "a", "leaf").width, 20.);
}
#[test]
fn nested_instances_use_materialized_ancestry_and_outer_mode_overrides() {
    let mut d = fixture();
    let mut inner = d.nodes["main"].clone();
    inner.id = "inner".into();
    inner.children = vec!["leaf".into()];
    d.nodes.insert("inner".into(), inner);
    d.pages[0].children.push("inner".into());
    let mut slot = d.nodes["a"].clone();
    slot.id = "slot".into();
    slot.instance.as_mut().unwrap().component_id = "inner".into();
    d.nodes.insert("slot".into(), slot);
    d.nodes.get_mut("main").unwrap().children = vec!["slot".into()];
    let r = resolved(&d);
    assert_eq!(child(&r, "a", "slot/leaf").width, 20.);
    assert_eq!(child(&r, "b", "slot/leaf").width, 80.);
    overrides(
        &mut d,
        "b",
        "slot",
        json!({"variableModes":{"theme":"light"}}),
    );
    let r = resolved(&d);
    assert_eq!(child(&r, "b", "slot/leaf").width, 20.);
    assert_eq!(resolved(&r), r);
}
#[test]
fn node_mode_schema_gate_preserves_old_documents_and_rejects_lossy_versions() {
    for version in 1..=5 {
        let mut d = fixture();
        d.schema_version = version;
        d.design_system = None;
        for n in d.nodes.values_mut() {
            n.bindings.clear();
            n.style_refs.clear();
            n.variable_modes.clear();
        }
        d.validate().unwrap();
        set_mode(&mut d, "dark", "dark");
        assert!(d.validate().unwrap_err().contains("schema 6"));
        d.nodes.get_mut("dark").unwrap().variable_modes.clear();
        overrides(&mut d, "a", "$root", json!({"variableModes":{}}));
        assert!(d.validate().unwrap_err().contains("schema 6"));
    }
    let d = fixture();
    assert_eq!(
        serde_json::from_str::<Document>(&serde_json::to_string(&d).unwrap()).unwrap(),
        d
    );
}
#[test]
fn invalid_unused_modes_are_atomic_and_mode_patches_are_undoable() {
    let d = fixture();
    let mut editor = DocumentEditor::new(d.clone()).unwrap();
    let mut candidate = d.clone();
    set_mode(&mut candidate, "light", "missing");
    let p = DocumentPatch::between(&d, &candidate).unwrap();
    assert!(editor.apply(0, p).is_err());
    assert_eq!(editor.document(), &d);
    assert_eq!(editor.revision(), 0);
    for fields in [
        json!({"variableModes":{"missing":"light"}}),
        json!({"variableModes":{"theme":"missing"}}),
        json!({"variableModes":null}),
    ] {
        let mut invalid = d.clone();
        overrides(&mut invalid, "a", "unused", fields);
        assert!(invalid.validate().is_err());
    }
    set_mode(&mut candidate, "light", "dark");
    editor
        .apply(0, DocumentPatch::between(&d, &candidate).unwrap())
        .unwrap();
    assert_eq!(child(&resolved(editor.document()), "a", "leaf").width, 80.);
    editor.undo().unwrap();
    assert_eq!(editor.document(), &d);
    editor.redo().unwrap();
    assert_eq!(child(&resolved(editor.document()), "a", "leaf").width, 80.);
}
#[test]
fn plain_nodes_resolve_document_and_ancestor_modes_without_components() {
    let mut d = fixture();
    d.nodes
        .retain(|id, _| ["light", "dark", "leaf"].contains(&id.as_str()));
    d.pages[0].children = vec!["light".into(), "dark".into()];
    d.nodes.get_mut("light").unwrap().children = vec!["leaf".into()];
    d.nodes.get_mut("dark").unwrap().children.clear();
    design_system::resolve(&mut d).unwrap();
    assert_eq!(d.nodes["leaf"].width, 20.);
    set_mode(&mut d, "light", "dark");
    design_system::resolve(&mut d).unwrap();
    assert_eq!(d.nodes["leaf"].width, 80.);
    set_mode(&mut d, "leaf", "light");
    design_system::resolve(&mut d).unwrap();
    assert_eq!(d.nodes["leaf"].width, 20.);
}

#[test]
fn placement_visibility_binding_stays_live_across_modes_and_reload() {
    let mut d = fixture();
    for id in ["a", "b"] {
        d.nodes
            .get_mut(id)
            .unwrap()
            .bindings
            .insert("visible".into(), "visible".into());
    }
    d = resolved(&d);
    assert!(d.nodes["a"].visible);
    assert!(!d.nodes["b"].visible);
    assert_eq!(d.nodes["b"].bindings["visible"], "visible");
    d = serde_json::from_str(&serde_json::to_string(&d).unwrap()).unwrap();
    set_mode(&mut d, "dark", "light");
    d = resolved(&d);
    assert!(d.nodes["b"].visible);
    assert_eq!(resolved(&d), d);
}

#[test]
fn ancestor_mode_patch_rebuilds_native_render_geometry() {
    let mut source = fixture();
    source.nodes.get_mut("main").unwrap().visible = false;
    source.nodes.get_mut("light").unwrap().visible = false;
    // Load a previously resolved scene so a mode-only patch cannot accidentally
    // rely on raw/resolved width differences to invalidate a cached path.
    let d = resolved(&source);
    let id = child(&d, "b", "leaf").id.clone();
    let mut engine = futureox_design_kernel::Engine::new();
    engine
        .load_document(&serde_json::to_string(&d).unwrap())
        .unwrap();
    let options = serde_json::from_value(json!({
        "pageId":"p","width":200,"height":120,"transparent":true,
        "rasterProfile":"analytic","view":{"x":0,"y":0,"zoom":1}
    }))
    .unwrap();
    assert_eq!(
        engine.compile_gpu(&options).unwrap().nodes[&id].size[0],
        80.
    );
    assert_eq!(
        engine.render(&options).unwrap()[(5 * 200 + 60) * 4 + 3],
        255
    );
    let mut next = d.clone();
    next.nodes.get_mut("dark").unwrap().variable_modes.clear();
    engine
        .apply_document_patch(&DocumentPatch::between(&d, &next).unwrap())
        .unwrap();
    assert_eq!(
        engine.compile_gpu(&options).unwrap().nodes[&id].size[0],
        20.
    );
    let pixels = engine.render(&options).unwrap();
    assert_eq!(pixels[(5 * 200 + 10) * 4 + 3], 255);
    assert_eq!(pixels[(5 * 200 + 60) * 4 + 3], 0);
}

#[test]
fn inherited_cross_collection_alias_cycle_rejects_resolution() {
    let mut d = fixture();
    let s = d.design_system.as_mut().unwrap();
    s.variables
        .get_mut("alias")
        .unwrap()
        .values
        .insert("light".into(), json!(30));
    s.variables
        .get_mut("width")
        .unwrap()
        .values
        .insert("dark".into(), json!({"alias":"alias"}));
    // Each document-default single-collection mode is valid. Their combination
    // selected on an ancestor forms a cycle and must not use stale template data.
    d.validate().unwrap();
    d.nodes
        .get_mut("dark")
        .unwrap()
        .variable_modes
        .insert("density".into(), "dark".into());
    let before = d.clone();
    let err = components::changes(&serde_json::to_string(&d).unwrap(), &Fonts::new()).unwrap_err();
    assert!(err.contains("cycle"));
    assert_eq!(d, before);
}
