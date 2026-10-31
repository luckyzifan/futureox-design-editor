use futureox_design_kernel::{Engine, components, font::Fonts, scene::Document};
use serde_json::{Value, json};
fn fixture(name: &str) -> Document {
    let text = match name {
        "vector" => include_str!("fixtures/mutation/bound-vector-width.json"),
        "text" => include_str!("fixtures/mutation/bound-rich-text.json"),
        "component" => include_str!("fixtures/mutation/component-rich-text.json"),
        _ => include_str!("fixtures/mutation/huge-effect.json"),
    };
    serde_json::from_str(text).unwrap()
}
fn resolve(d: &Document) -> Document {
    let changes: Value = serde_json::from_str(
        &components::changes(&serde_json::to_string(d).unwrap(), &Fonts::new()).unwrap(),
    )
    .unwrap();
    let mut result = d.clone();
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
#[test]
fn bound_vector_dimensions_resize_geometry_and_curves_across_modes_reload() {
    let mut d = fixture("vector");
    d.nodes
        .get_mut("n")
        .unwrap()
        .network
        .as_mut()
        .unwrap()
        .edges[0]
        .c1 = Some(serde_json::from_value(json!({"x":3,"y":0})).unwrap());
    d.nodes
        .get_mut("n")
        .unwrap()
        .network
        .as_mut()
        .unwrap()
        .edges[0]
        .c2 = Some(serde_json::from_value(json!({"x":7,"y":0})).unwrap());
    let s = d.design_system.as_mut().unwrap();
    s.collections
        .get_mut("c")
        .unwrap()
        .modes
        .push("small".into());
    s.variables
        .get_mut("v")
        .unwrap()
        .values
        .insert("small".into(), json!(5));
    for (mode, width) in [("m", 20.), ("small", 5.), ("m", 20.)] {
        d.design_system
            .as_mut()
            .unwrap()
            .active_modes
            .insert("c".into(), mode.into());
        d = resolve(&d);
        let n = &d.nodes["n"];
        let g = n.network.as_ref().unwrap();
        assert_eq!(n.width, width);
        assert_eq!(g.vertices[1].x, width);
        assert!((g.edges[0].c1.unwrap().x - width * 0.3).abs() < 1e-9);
        assert_eq!(resolve(&d), d);
        d = serde_json::from_str(&serde_json::to_string(&d).unwrap()).unwrap();
    }
}
#[test]
fn text_bindings_keep_valid_inherited_styles_for_unicode_replacement() {
    for text in ["Hi", "😀e\u{301}", "A longer localized greeting", ""] {
        let mut d = fixture("text");
        d.design_system
            .as_mut()
            .unwrap()
            .variables
            .get_mut("v")
            .unwrap()
            .values
            .insert("m".into(), json!(text));
        let d = resolve(&d);
        let n = &d.nodes["n"];
        assert_eq!(n.text, text);
        assert_eq!(
            n.text_runs.last().map(|r| r.end).unwrap_or(0),
            text.encode_utf16().count()
        );
        assert!(n.text_runs.iter().all(|r| r.weight == Some(700.)));
        assert_eq!(
            resolve(&serde_json::from_str(&serde_json::to_string(&d).unwrap()).unwrap()),
            d
        );
    }
}
#[test]
fn component_text_properties_reconcile_default_and_override_ranges() {
    let mut d = fixture("component");
    d.nodes
        .get_mut("main")
        .unwrap()
        .component
        .as_mut()
        .unwrap()
        .properties
        .get_mut("title")
        .unwrap()
        .default_value = json!("😀e\u{301}");
    let d = resolve(&d);
    let n = d
        .nodes
        .values()
        .find(|n| n.instance_origin.as_ref().is_some_and(|o| o.owner == "i"))
        .unwrap();
    assert_eq!(n.text, "Hi");
    assert_eq!(n.text_runs.last().unwrap().end, 2);
    assert_eq!(d.nodes["label"].text_runs.last().unwrap().end, 4);
}
#[test]
fn oversized_effect_returns_budget_error_without_debug_panic() {
    let mut engine = Engine::new();
    engine
        .load_document(&serde_json::to_string(&fixture("effect")).unwrap())
        .unwrap();
    let options = serde_json::from_value(json!({"pageId":"p","width":128,"height":128,"transparent":true,"view":{"x":0,"y":0,"zoom":1}})).unwrap();
    assert!(
        engine
            .render(&options)
            .unwrap_err()
            .contains("Effect expansion exceeds")
    );
}

#[test]
fn vector_instance_and_live_boolean_resize_survive_mode_undo_and_reload() {
    use futureox_design_kernel::editing::{DocumentEditor, DocumentPatch};
    for boolean in [false, true] {
        let mut d = fixture("vector");
        if boolean {
            let operand = serde_json::from_value(
                json!({"id":"operand","kind":"rectangle","width":10,"height":10}),
            )
            .unwrap();
            d.nodes.insert("operand".into(), operand);
            let n = d.nodes.get_mut("n").unwrap();
            n.boolean_operation = Some(futureox_design_kernel::boolean::Operation::Union);
            n.children = vec!["operand".into()];
        }
        d.nodes.insert("main".into(),serde_json::from_value(json!({"id":"main","kind":"frame","width":100,"height":100,"children":["n"],"component":{}})).unwrap());
        d.nodes.insert("i".into(),serde_json::from_value(json!({"id":"i","kind":"frame","width":100,"height":100,"instance":{"componentId":"main"}})).unwrap());
        d.pages[0].children = vec!["main".into(), "i".into()];
        let s = d.design_system.as_mut().unwrap();
        s.collections
            .get_mut("c")
            .unwrap()
            .modes
            .push("small".into());
        s.variables
            .get_mut("v")
            .unwrap()
            .values
            .insert("small".into(), json!(5));
        d = resolve(&d);
        let check = |d: &Document, width: f64| {
            for n in d.nodes.values().filter(|n| {
                n.id == "n"
                    || n.instance_origin
                        .as_ref()
                        .is_some_and(|o| o.owner == "i" && o.source == "n")
            }) {
                assert_eq!(n.width, width);
                let max = n
                    .network
                    .as_ref()
                    .unwrap()
                    .vertices
                    .iter()
                    .map(|p| p.x)
                    .fold(0., f64::max);
                assert!(
                    (max - width).abs() < 1e-6,
                    "boolean={boolean}, node={}, max={max}, expected={width}",
                    n.id
                );
            }
        };
        check(&d, 20.);
        let mut small = d.clone();
        small
            .nodes
            .get_mut("i")
            .unwrap()
            .variable_modes
            .insert("c".into(), "small".into());
        let local = resolve(&small);
        let instance = local
            .nodes
            .values()
            .find(|n| {
                n.instance_origin
                    .as_ref()
                    .is_some_and(|o| o.owner == "i" && o.source == "n")
            })
            .unwrap();
        assert_eq!(instance.width, 5.);
        assert!(
            (instance
                .network
                .as_ref()
                .unwrap()
                .vertices
                .iter()
                .map(|p| p.x)
                .fold(0., f64::max)
                - 5.)
                .abs()
                < 1e-6
        );
        small = d.clone();
        small
            .design_system
            .as_mut()
            .unwrap()
            .active_modes
            .insert("c".into(), "small".into());
        let small = resolve(&small);
        check(&small, 5.);
        let mut editor = DocumentEditor::new(d.clone()).unwrap();
        editor
            .apply(0, DocumentPatch::between(&d, &small).unwrap())
            .unwrap();
        check(&resolve(editor.document()), 5.);
        editor.undo().unwrap();
        check(&resolve(editor.document()), 20.);
        editor.redo().unwrap();
        check(&resolve(editor.document()), 5.);
        let loaded =
            serde_json::from_str(&serde_json::to_string(editor.document()).unwrap()).unwrap();
        check(&resolve(&loaded), 5.);
    }
}
#[test]
fn unicode_edit_preserves_unedited_suffix_and_explicit_override_ranges() {
    let mut d = fixture("component");
    let n = d.nodes.get_mut("label").unwrap();
    n.text = "eX suffix".into();
    n.text_runs = serde_json::from_value(
        json!([{"start":0,"end":1,"weight":700},{"start":3,"end":9,"weight":500}]),
    )
    .unwrap();
    d.nodes
        .get_mut("main")
        .unwrap()
        .component
        .as_mut()
        .unwrap()
        .properties
        .get_mut("title")
        .unwrap()
        .default_value = json!("eX suffix");
    d.nodes
        .get_mut("i")
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .property_values
        .insert("title".into(), json!("e\u{301}😀 suffix"));
    let resolved = resolve(&d);
    let n = resolved
        .nodes
        .values()
        .find(|n| n.instance_origin.as_ref().is_some_and(|o| o.owner == "i"))
        .unwrap();
    assert_eq!(n.text_runs[0].start, 0);
    assert_eq!(n.text_runs[0].end, 4);
    assert_eq!(n.text_runs[1].start, 5);
    assert_eq!(n.text_runs[1].end, 11);
    d.nodes
        .get_mut("i")
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .overrides
        .insert(
            "label".into(),
            serde_json::from_value(
                json!({"text":"😀", "textRuns":[{"start":0,"end":2,"weight":300}]}),
            )
            .unwrap(),
        );
    let d = resolve(&d);
    let n = d
        .nodes
        .values()
        .find(|n| n.instance_origin.as_ref().is_some_and(|o| o.owner == "i"))
        .unwrap();
    assert_eq!(n.text_runs[0].weight, Some(300.));
}
