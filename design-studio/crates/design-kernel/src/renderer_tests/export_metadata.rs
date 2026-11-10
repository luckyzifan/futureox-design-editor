use super::*;
use serde_json::json;

fn document() -> Document {
    serde_json::from_value(json!({
        "schemaVersion": 8, "id": "d", "name": "export",
        "pages": [{"id": "p", "name": "p", "children": ["a"], "background": "#ffffff"}],
        "nodes": {"a": {"id": "a", "kind": "rectangle", "width": 40, "height": 30,
            "fills": [{"kind": "solid", "color": "#336699"}]}}
    })).unwrap()
}
fn options() -> RenderOptions {
    serde_json::from_value(json!({"pageId":"p","width":64,"height":48,"view":{"x":0,"y":0,"zoom":1}})).unwrap()
}
fn settings(scale: f64, suffix: &str) -> serde_json::Value {
    json!([{"id": "png", "format": "png", "scale": scale, "suffix": suffix}])
}

#[test]
fn export_scale_and_suffix_keep_the_same_pixels_and_revision() {
    let mut engine = Engine::new();
    engine.install_document(document()).unwrap();
    let opts = options();
    let before = engine.render(&opts).unwrap();
    engine.compile_gpu(&opts).unwrap();
    let revision = engine.geo_revision;
    let index = engine.render_index.clone().unwrap();
    let path = engine.paths.get("a").cloned();
    assert!(path.is_some(), "render should retain the rectangle path");
    for (scale, suffix) in [(2., "@2x"), (3., "@3x"), (1., "")] {
        let mut next = engine.source_doc.as_ref().unwrap().clone();
        next.nodes.get_mut("a").unwrap().export_settings =
            serde_json::from_value(settings(scale, suffix)).unwrap();
        let patch = crate::editing::DocumentPatch::between(engine.source_doc.as_ref().unwrap(), &next).unwrap();
        let damage = engine.apply_document_patch_with_damage(&patch).unwrap();
        assert!(!damage.full && damage.bounds.is_none(), "full={} bounds={:?}", damage.full, damage.bounds);
        assert!(damage.rects.as_ref().is_some_and(|rects| rects.is_empty()));
        assert_eq!(engine.geo_revision, revision);
        assert!(!engine.layout_dirty);
        assert!(Arc::ptr_eq(&index, engine.render_index.as_ref().unwrap()));
        assert!(Arc::ptr_eq(path.as_ref().unwrap(), &engine.paths["a"]));
        assert_eq!(engine.source_doc.as_ref().unwrap().nodes["a"].export_settings[0].scale, scale);
        assert_eq!(engine.source_doc.as_ref().unwrap().nodes["a"].export_settings[0].suffix, suffix);
        assert_eq!(engine.render(&opts).unwrap(), before);
        assert_eq!(engine.compile_gpu(&opts).unwrap().into_packet().unwrap(), engine.compile_gpu(&opts).unwrap().into_packet().unwrap());
        let mut fresh = Engine::new();
        fresh.install_document(next).unwrap();
        assert_eq!(fresh.render(&opts).unwrap(), before);
    }
    let patch = crate::editing::DocumentPatch::between(engine.source_doc.as_ref().unwrap(), &document()).unwrap();
    let damage = engine.apply_document_patch_with_damage(&patch).unwrap();
    assert!(damage.bounds.is_none() && !damage.full);
    assert_eq!(engine.geo_revision, revision);
    assert!(engine.source_doc.as_ref().unwrap().nodes["a"].export_settings.is_empty());
    assert_eq!(engine.render(&opts).unwrap(), before);

    let mut colored = engine.source_doc.as_ref().unwrap().clone();
    colored.nodes.get_mut("a").unwrap().fills[0].color = "#cc2255".into();
    let patch = crate::editing::DocumentPatch::between(engine.source_doc.as_ref().unwrap(), &colored).unwrap();
    let damage = engine.apply_document_patch_with_damage(&patch).unwrap();
    assert!(damage.full || damage.bounds.is_some(), "a fill change must still repaint");
    assert_ne!(engine.geo_revision, revision);
    assert_ne!(engine.render(&opts).unwrap(), before);
    let mut fresh = Engine::new();
    fresh.install_document(colored).unwrap();
    assert_eq!(engine.render(&opts).unwrap(), fresh.render(&opts).unwrap());
}

#[test]
fn invalid_export_metadata_does_not_change_the_scene() {
    let mut engine = Engine::new();
    engine.install_document(document()).unwrap();
    let opts = options();
    let before = engine.render(&opts).unwrap();
    let revision = engine.geo_revision;
    let mut next = document();
    next.nodes.get_mut("a").unwrap().export_settings =
        serde_json::from_value(json!([{"id":"png","format":"png","scale":2,"suffix":"a/b"}])).unwrap();
    let patch = crate::editing::DocumentPatch::between(&document(), &next).unwrap();
    assert!(engine.apply_document_patch_with_damage(&patch).is_err());
    assert_eq!(engine.geo_revision, revision);
    assert!(engine.source_doc.as_ref().unwrap().nodes["a"].export_settings.is_empty());
    assert_eq!(engine.render(&opts).unwrap(), before);
}

#[test]
fn adding_export_settings_may_raise_schema_without_repainting() {
    let mut older = document();
    older.schema_version = 7;
    let mut engine = Engine::new();
    engine.install_document(older).unwrap();
    let opts = options();
    let before = engine.render(&opts).unwrap();
    let revision = engine.geo_revision;
    let mut next = engine.source_doc.as_ref().unwrap().clone();
    next.schema_version = 8;
    next.nodes.get_mut("a").unwrap().export_settings =
        serde_json::from_value(settings(2., "@2x")).unwrap();
    let patch = crate::editing::DocumentPatch::between(engine.source_doc.as_ref().unwrap(), &next).unwrap();
    assert!(patch.fields.contains_key("schemaVersion"));
    let damage = engine.apply_document_patch_with_damage(&patch).unwrap();
    assert!(!damage.full && damage.bounds.is_none());
    assert_eq!(engine.geo_revision, revision);
    assert_eq!(engine.source_doc.as_ref().unwrap().schema_version, 8);
    assert_eq!(engine.doc.as_ref().unwrap().schema_version, 8);
    assert_eq!(engine.render(&opts).unwrap(), before);
}
