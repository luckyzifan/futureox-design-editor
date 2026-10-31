use futureox_design_kernel::{
    Engine, RenderOptions, View, components, font::Fonts, scene::Document,
};
use serde_json::{Value, json};
fn shape(id: &str, kind: &str) -> Value {
    json!({"id":id,"name":id,"kind":kind,"width":100,"height":40,"transform":[1,0,0,1,0,0],"fills":[{"kind":"solid","color":"#8899cc"}]})
}
fn main_node(id: &str, children: &[&str]) -> Value {
    let mut n = shape(id, "frame");
    n["children"] = json!(children);
    n["component"] = json!({});
    n
}
fn instance(id: &str, component: &str) -> Value {
    let mut n = shape(id, "frame");
    n["instance"] = json!({"componentId":component});
    n
}
fn doc(nodes: Vec<Value>, roots: &[&str]) -> Document {
    let nodes: serde_json::Map<_, _> = nodes
        .into_iter()
        .map(|n| (n["id"].as_str().unwrap().to_owned(), n))
        .collect();
    serde_json::from_value(json!({"schemaVersion":1,"id":"d","name":"components","pages":[{"id":"page","name":"page","background":"#ffffff","children":roots}],"nodes":nodes})).unwrap()
}
fn basic() -> Document {
    let mut label = shape("label", "text");
    label["text"] = json!("Default");
    doc(
        vec![main_node("main", &["label"]), label, instance("i", "main")],
        &["main", "i"],
    )
}
fn resolve(d: &mut Document) {
    d.validate().unwrap();
    components::resolve(d).unwrap();
    d.validate().unwrap()
}
fn generated(d: &Document, owner: &str, key: &str) -> String {
    d.nodes
        .values()
        .find(|n| {
            n.instance_origin
                .as_ref()
                .is_some_and(|o| o.owner == owner && o.key == key)
        })
        .unwrap()
        .id
        .clone()
}
#[test]
fn stable_ids_master_updates_and_local_placement() {
    let mut d = basic();
    d.nodes.get_mut("i").unwrap().transform.0[4] = 350.;
    resolve(&mut d);
    let id = generated(&d, "i", "label");
    d.nodes.get_mut("label").unwrap().text = "Changed".into();
    d.nodes.get_mut("label").unwrap().name = "Renamed".into();
    d.nodes.get_mut("main").unwrap().width = 220.;
    d.nodes.get_mut("main").unwrap().transform.0[4] = 800.;
    resolve(&mut d);
    assert_eq!(id, generated(&d, "i", "label"));
    assert_eq!(d.nodes[&id].text, "Changed");
    assert_eq!(d.nodes["i"].width, 220.);
    assert_eq!(d.nodes["i"].transform.0[4], 350.);
}
#[test]
fn overrides_survive_updates_and_reset() {
    let mut d = basic();
    let i = d.nodes.get_mut("i").unwrap().instance.as_mut().unwrap();
    i.overrides.insert(
        "label".into(),
        serde_json::from_value(json!({"text":"Local","opacity":0.6})).unwrap(),
    );
    i.overrides.insert(
        "$root".into(),
        serde_json::from_value(json!({"width":240})).unwrap(),
    );
    resolve(&mut d);
    d.nodes.get_mut("label").unwrap().text = "Master edit".into();
    d.nodes.get_mut("main").unwrap().width = 300.;
    resolve(&mut d);
    assert_eq!(d.nodes[&generated(&d, "i", "label")].text, "Local");
    assert_eq!(d.nodes["i"].width, 240.);
    d.nodes
        .get_mut("i")
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .overrides
        .clear();
    resolve(&mut d);
    assert_eq!(d.nodes[&generated(&d, "i", "label")].text, "Master edit");
    assert_eq!(d.nodes["i"].width, 300.);
}
#[test]
fn master_structure_rebuilds_instances_without_orphans() {
    let mut d = basic();
    resolve(&mut d);
    let old = generated(&d, "i", "label");
    d.nodes.insert(
        "icon".into(),
        serde_json::from_value(shape("icon", "ellipse")).unwrap(),
    );
    d.nodes.get_mut("main").unwrap().children = vec!["icon".into()];
    d.nodes.remove("label");
    resolve(&mut d);
    assert!(!d.nodes.contains_key(&old));
    assert_eq!(d.nodes["i"].children.len(), 1);
    assert_eq!(d.nodes[&generated(&d, "i", "icon")].kind, "ellipse");
}
#[test]
fn typed_text_and_boolean_defaults_and_values() {
    let mut d = basic();
    d.nodes.get_mut("main").unwrap().component.as_mut().unwrap().properties=serde_json::from_value(json!({"title":{"name":"Title","kind":"text","targetKey":"label","defaultValue":"Default property"},"show":{"name":"Show","kind":"boolean","targetKey":"label","defaultValue":true}})).unwrap();
    let i = d.nodes.get_mut("i").unwrap().instance.as_mut().unwrap();
    i.property_values
        .insert("title".into(), json!("Instance title"));
    i.property_values.insert("show".into(), json!(false));
    resolve(&mut d);
    assert_eq!(d.nodes["label"].text, "Default property");
    assert_eq!(d.nodes[&generated(&d, "i", "label")].text, "Instance title");
    assert!(!d.nodes[&generated(&d, "i", "label")].visible);
    d.nodes
        .get_mut("i")
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .property_values
        .insert("show".into(), json!("bad"));
    assert!(d.validate().is_err());
}
fn nested() -> Document {
    let mut mark = shape("mark", "text");
    mark["text"] = json!("Icon label");
    let mut slot = instance("slot", "icon");
    slot["componentKey"] = json!("iconSlot");
    doc(
        vec![
            main_node("icon", &["mark"]),
            mark,
            main_node("button", &["slot"]),
            slot,
            instance("buttonInstance", "button"),
            main_node("other", &["otherMark"]),
            shape("otherMark", "ellipse"),
        ],
        &["icon", "button", "buttonInstance", "other"],
    )
}
#[test]
fn nested_instances_use_qualified_override_paths() {
    let mut d = nested();
    d.nodes
        .get_mut("buttonInstance")
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .overrides
        .insert(
            "iconSlot/mark".into(),
            serde_json::from_value(json!({"text":"Nested override"})).unwrap(),
        );
    resolve(&mut d);
    assert_eq!(
        d.nodes[&generated(&d, "buttonInstance", "iconSlot/mark")].text,
        "Nested override"
    );
    assert_eq!(d.nodes[&generated(&d, "slot", "mark")].text, "Icon label");
    let before = d.clone();
    resolve(&mut d);
    assert_eq!(d, before);
}
#[test]
fn nested_swap_property_updates_the_referenced_component() {
    let mut d = nested();
    d.nodes.get_mut("button").unwrap().component.as_mut().unwrap().properties=serde_json::from_value(json!({"icon":{"name":"Icon","kind":"instance-swap","targetKey":"iconSlot","defaultValue":"icon"}})).unwrap();
    d.nodes
        .get_mut("buttonInstance")
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .property_values
        .insert("icon".into(), json!("other"));
    resolve(&mut d);
    let nested = &d.nodes[&generated(&d, "buttonInstance", "iconSlot")];
    assert_eq!(nested.instance.as_ref().unwrap().component_id, "other");
    assert_eq!(
        d.nodes[&generated(&d, "buttonInstance", "iconSlot/otherMark")].kind,
        "ellipse"
    );
}
#[test]
fn reference_cycles_and_dynamic_swaps_are_rejected() {
    let mut d = nested();
    d.nodes
        .get_mut("slot")
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .component_id = "button".into();
    assert!(d.validate().is_err());
    let mut d = nested();
    d.nodes
        .get_mut("buttonInstance")
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .overrides
        .insert(
            "iconSlot".into(),
            serde_json::from_value(json!({"swapComponent":"button"})).unwrap(),
        );
    assert!(components::resolve(&mut d).is_err());
}
#[test]
fn variant_combinations_must_be_unique() {
    let mut set = shape("set", "section");
    set["componentSet"] = json!(true);
    set["children"] = json!(["a", "b"]);
    let mut a = main_node("a", &[]);
    let mut b = main_node("b", &[]);
    a["component"]["variants"] = json!({"State":"Default"});
    b["component"]["variants"] = json!({"State":"Default"});
    let mut d = doc(vec![set, a, b], &["set"]);
    assert!(d.validate().is_err());
    d.nodes
        .get_mut("b")
        .unwrap()
        .component
        .as_mut()
        .unwrap()
        .variants
        .insert("State".into(), "Disabled".into());
    resolve(&mut d);
}
#[test]
fn structural_overrides_and_missing_definitions_are_rejected() {
    let mut d = basic();
    d.nodes
        .get_mut("i")
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .overrides
        .insert(
            "label".into(),
            serde_json::from_value(json!({"children":[]})).unwrap(),
        );
    assert!(d.validate().is_err());
    let mut d = basic();
    d.nodes
        .get_mut("i")
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .component_id = "missing".into();
    assert!(d.validate().is_err());
}
#[test]
fn generated_id_collisions_fail_without_modifying_the_input() {
    let mut d = basic();
    resolve(&mut d);
    let id = generated(&d, "i", "label");
    d.nodes.remove(&id);
    d.nodes.get_mut("i").unwrap().children.clear();
    d.nodes.insert(
        id.clone(),
        serde_json::from_value(shape(&id, "rectangle")).unwrap(),
    );
    d.pages[0].children.push(id);
    let before = d.clone();
    assert!(components::resolve(&mut d).is_err());
    assert_eq!(d, before);
}
#[test]
fn exponential_instance_expansion_is_bounded() {
    // Keep the hostile expansion test independent of host RAM and the removed
    // 20k quota. Only this child owns a small trusted admission policy.
    const CHILD: &str = "CORE_COMPONENT_EXPANSION_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "exponential_instance_expansion_is_bounded", "--nocapture"])
            .env(CHILD, "1")
            .env("CORE_DOCUMENT_MEMORY_BYTES", (64 * 1024 * 1024).to_string())
            .output().unwrap();
        assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        return;
    }
    let mut nodes = vec![];
    let mut roots = vec![];
    // Fully materializing this graph would require tens of millions of nodes.
    // Builder::insert charges each node before inserting it into staging.
    let levels = 26;
    for depth in 0..levels {
        let id = format!("c{depth}");
        roots.push(id.clone());
        let children = if depth < levels - 1 {
            vec![format!("s{depth}a"), format!("s{depth}b")]
        } else {
            vec![]
        };
        nodes.push(main_node(
            &id,
            &children.iter().map(String::as_str).collect::<Vec<_>>(),
        ));
        for child in children {
            nodes.push(instance(&child, &format!("c{}", depth + 1)))
        }
    }
    nodes.push(instance("top", "c0"));
    roots.push("top".into());
    let mut d = doc(nodes, &roots.iter().map(String::as_str).collect::<Vec<_>>());
    let before = d.clone();
    assert!(serde_json::to_vec(&d).unwrap().len() < futureox_design_kernel::capacity::document_byte_limit());
    d.validate().unwrap();
    for _ in 0..2 {
        let error = components::resolve(&mut d).unwrap_err();
        assert!(error.contains("resource allowance"), "{error}");
        assert_eq!(d, before, "failed expansion must not publish any derived nodes");
    }
    let mut valid = basic();
    resolve(&mut valid);
    assert!(!valid.nodes["i"].children.is_empty(), "a later valid resolution remains usable");
}
#[test]
fn native_renderer_and_gpu_compiler_resolve_instances() {
    let mut main = main_node("main", &["box"]);
    main["fills"] = json!([]);
    let mut box_node = shape("box", "rectangle");
    box_node["width"] = json!(20);
    box_node["height"] = json!(20);
    let mut i = instance("i", "main");
    i["transform"] = json!([1, 0, 0, 1, 30, 0]);
    let d = doc(vec![main, box_node, i], &["main", "i"]);
    let mut e = Engine::new();
    e.load_document(&serde_json::to_string(&d).unwrap())
        .unwrap();
    let options = RenderOptions {
        page_id: "page".into(),
        width: 100,
        height: 80,
        view: View {
            x: 0.,
            y: 0.,
            zoom: 1.,
        },
        transparent: true,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
        interactive_effects: false,
        checkerboard: false,
    };
    let plan = e.compile_gpu(&options).unwrap();
    assert_eq!(plan.nodes.len(), 4);
    let pixels = e.render(&options).unwrap();
    assert_eq!(
        &pixels[(5 * 100 + 5) * 4..(5 * 100 + 5) * 4 + 4],
        &pixels[(5 * 100 + 35) * 4..(5 * 100 + 35) * 4 + 4]
    );
}

#[test]
fn expanded_text_payloads_have_a_byte_budget() {
    let mut label = shape("label", "text");
    label["text"] = json!("x".repeat(300_000));
    let mut nodes = vec![main_node("main", &["label"]), label];
    let mut roots = vec!["main".to_owned()];
    let instance_count = futureox_design_kernel::capacity::document_byte_limit() / 300_000 + 2;
    for i in 0..instance_count {
        let id = format!("instance{i}");
        nodes.push(instance(&id, "main"));
        roots.push(id)
    }
    let mut d = doc(nodes, &roots.iter().map(String::as_str).collect::<Vec<_>>());
    let before = d.clone();
    let error = components::resolve(&mut d).unwrap_err();
    assert!(error.contains("resource allowance"));
    assert_eq!(d.nodes.len(), instance_count + 2);
    assert_eq!(d, before, "byte-budget failure cannot publish a partial expansion");
}

fn reference_document() -> Document {
    let mut main = main_node("main", &["box"]);
    main["fills"] = json!([]);
    let mut box_node = shape("box", "rectangle");
    box_node["width"] = json!(10);
    box_node["bindings"] = json!({"width":"a"});
    let mut i = instance("i", "main");
    i["transform"] = json!([1, 0, 0, 1, 100, 0]);
    let mut d = doc(vec![main, box_node, i], &["main", "i"]);
    d.schema_version = 4;
    d.design_system = Some(serde_json::from_value(json!({
        "collections":{"c":{"name":"Theme","modes":["m","alternate"],"defaultMode":"m"}},
        "variables":{
            "a":{"name":"A","collection":"c","kind":"number","values":{"m":20,"alternate":30}},
            "b":{"name":"B","collection":"c","kind":"number","values":{"m":80,"alternate":90}},
            "alias":{"name":"Alias","collection":"c","kind":"number","values":{"m":{"alias":"b"},"alternate":{"alias":"b"}}},
            "opacity":{"name":"Opacity","collection":"c","kind":"number","values":{"m":0.25,"alternate":0.5}},
            "text":{"name":"Text","collection":"c","kind":"string","values":{"m":"Bound","alternate":"Alternate"}}
        },
        "styles":{
            "red":{"name":"Red","kind":"paint","value":[{"kind":"solid","color":"#ff0000","opacity":1}]},
            "blue":{"name":"Blue","kind":"paint","value":[{"kind":"solid","color":"#0000ff","opacity":1}]}
        }
    })).unwrap());
    d
}
fn reference_override(d: &mut Document, owner: &str, key: &str, fields: Value) {
    d.nodes
        .get_mut(owner)
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .overrides
        .insert(key.into(), serde_json::from_value(fields).unwrap());
}
fn resolved_changes(d: &Document) -> Document {
    let changes: Value = serde_json::from_str(
        &components::changes(&serde_json::to_string(d).unwrap(), &Fonts::new()).unwrap(),
    )
    .unwrap();
    let mut result = d.clone();
    for id in changes["removed"].as_array().unwrap() {
        result.nodes.remove(id.as_str().unwrap());
    }
    for (id, node) in changes["nodes"].as_object().unwrap() {
        result
            .nodes
            .insert(id.clone(), serde_json::from_value(node.clone()).unwrap());
    }
    result.validate().unwrap();
    result
}
#[test]
fn instance_reference_overrides_resolve_new_bindings_and_active_alias_modes() {
    let mut d = reference_document();
    reference_override(&mut d, "i", "box", json!({"bindings":{"width":"b"}}));
    let resolved = resolved_changes(&d);
    let child = &resolved.nodes[&generated(&resolved, "i", "box")];
    assert_eq!(child.bindings["width"], "b");
    assert_eq!(child.width, 80.);
    assert_eq!(resolved.nodes["box"].width, 20.);
    assert_eq!(resolved_changes(&resolved), resolved);

    reference_override(&mut d, "i", "box", json!({"bindings":{"width":"alias"}}));
    d.design_system
        .as_mut()
        .unwrap()
        .active_modes
        .insert("c".into(), "alternate".into());
    let resolved = resolved_changes(&d);
    assert_eq!(resolved.nodes[&generated(&resolved, "i", "box")].width, 90.);
}
#[test]
fn instance_reference_overrides_resolve_root_and_rendered_geometry() {
    let mut d = reference_document();
    d.nodes
        .get_mut("main")
        .unwrap()
        .bindings
        .insert("width".into(), "a".into());
    reference_override(&mut d, "i", "$root", json!({"bindings":{"width":"b"}}));
    reference_override(&mut d, "i", "box", json!({"bindings":{"width":"b"}}));
    let resolved = resolved_changes(&d);
    assert_eq!(resolved.nodes["i"].width, 80.);
    let mut engine = Engine::new();
    engine
        .load_document(&serde_json::to_string(&d).unwrap())
        .unwrap();
    let options: RenderOptions = serde_json::from_value(json!({
        "pageId":"page","width":200,"height":60,"transparent":true,
        "rasterProfile":"analytic","view":{"x":0,"y":0,"zoom":1}
    }))
    .unwrap();
    let scene = engine.compile_gpu(&options).unwrap();
    let child = generated(&resolved, "i", "box");
    assert_eq!(scene.nodes[&child].size[0], 80.);
    let pixels = engine.render(&options).unwrap();
    assert_eq!(pixels[(5 * 200 + 150) * 4 + 3], 255);
    assert_eq!(pixels[(5 * 200 + 185) * 4 + 3], 0);
}
#[test]
fn instance_reference_overrides_apply_styles_before_bindings() {
    let mut d = reference_document();
    let box_node = d.nodes.get_mut("box").unwrap();
    box_node.style_refs.insert("fills".into(), "red".into());
    box_node
        .bindings
        .insert("fills.0.opacity".into(), "opacity".into());
    reference_override(&mut d, "i", "box", json!({"styleRefs":{"fills":"blue"}}));
    let resolved = resolved_changes(&d);
    let child = &resolved.nodes[&generated(&resolved, "i", "box")];
    assert_eq!(child.fills[0].color, "#0000ff");
    assert_eq!(child.fills[0].opacity, 0.25);
    assert_eq!(child.width, 20.);
    assert_eq!(resolved.nodes["box"].fills[0].color, "#ff0000");
}
#[test]
fn instance_reference_overrides_preserve_direct_values_and_property_values() {
    for replace_references in [false, true] {
        let mut d = reference_document();
        let box_node = d.nodes.get_mut("box").unwrap();
        box_node.style_refs.insert("fills".into(), "red".into());
        box_node
            .bindings
            .insert("fills.0.opacity".into(), "opacity".into());
        let mut fields =
            json!({"width":35,"fills":[{"kind":"solid","color":"#00ff00","opacity":0.75}]});
        if replace_references {
            fields["bindings"] = json!({"width":"b","fills.0.opacity":"opacity"});
            fields["styleRefs"] = json!({"fills":"blue"});
        }
        reference_override(&mut d, "i", "box", fields);
        let resolved = resolved_changes(&d);
        let child = &resolved.nodes[&generated(&resolved, "i", "box")];
        assert_eq!(child.width, 35.);
        assert_eq!(child.fills[0].color, "#00ff00");
        assert_eq!(child.fills[0].opacity, 0.75);
        assert_eq!(resolved_changes(&resolved), resolved);
    }

    let mut d = basic();
    d.design_system = reference_document().design_system;
    d.schema_version = 4;
    d.nodes.get_mut("main").unwrap().component.as_mut().unwrap().properties =
        serde_json::from_value(json!({"title":{"name":"Title","kind":"text","targetKey":"label","defaultValue":"Default"}})).unwrap();
    d.nodes
        .get_mut("i")
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .property_values
        .insert("title".into(), json!("Local title"));
    reference_override(&mut d, "i", "label", json!({"bindings":{"text":"text"}}));
    let resolved = resolved_changes(&d);
    assert_eq!(
        resolved.nodes[&generated(&resolved, "i", "label")].text,
        "Local title"
    );
}
#[test]
fn instance_reference_overrides_follow_nested_override_precedence() {
    let mut d = nested();
    d.design_system = reference_document().design_system;
    d.schema_version = 4;
    d.nodes
        .get_mut("mark")
        .unwrap()
        .bindings
        .insert("width".into(), "a".into());
    reference_override(&mut d, "slot", "mark", json!({"bindings":{"width":"b"}}));
    reference_override(
        &mut d,
        "buttonInstance",
        "iconSlot/mark",
        json!({"bindings":{"width":"alias"}}),
    );
    let resolved = resolved_changes(&d);
    assert_eq!(
        resolved.nodes[&generated(&resolved, "slot", "mark")].width,
        80.
    );
    let child = &resolved.nodes[&generated(&resolved, "buttonInstance", "iconSlot/mark")];
    assert_eq!(child.bindings["width"], "alias");
    assert_eq!(child.width, 80.);
    reference_override(
        &mut d,
        "slot",
        "mark",
        json!({"bindings":{"width":"b"},"width":45}),
    );
    let resolved = resolved_changes(&d);
    assert_eq!(
        resolved.nodes[&generated(&resolved, "buttonInstance", "iconSlot/mark")].width,
        45.
    );
    assert_eq!(resolved_changes(&resolved), resolved);
}
#[test]
fn masked_instance_binding_paths_survive_repeated_resolution_and_reload() {
    for key in ["box", "$root"] {
        for replace_binding in [false, true] {
            let mut d = reference_document();
            let source = if key == "$root" { "main" } else { "box" };
            let node = d.nodes.get_mut(source).unwrap();
            node.fills =
                serde_json::from_value(json!([{"kind":"solid","color":"#ff0000"}])).unwrap();
            node.bindings
                .insert("fills.0.opacity".into(), "opacity".into());
            let mut fields = json!({"fills":[]});
            if replace_binding {
                fields["bindings"] = json!({"width":"b","fills.0.opacity":"opacity"});
            }
            reference_override(&mut d, "i", key, fields);
            let resolved = resolved_changes(&d);
            let target = if key == "$root" {
                "i".into()
            } else {
                generated(&resolved, "i", "box")
            };
            assert!(resolved.nodes[&target].fills.is_empty());
            assert_eq!(resolved_changes(&resolved), resolved);

            let mut engine = Engine::new();
            engine
                .load_document(&serde_json::to_string(&resolved).unwrap())
                .unwrap();
            let options: RenderOptions = serde_json::from_value(json!({
                "pageId":"page","width":200,"height":60,"transparent":true,
                "rasterProfile":"analytic","view":{"x":0,"y":0,"zoom":1}
            }))
            .unwrap();
            engine.compile_gpu(&options).unwrap();
            engine.render(&options).unwrap();
        }
    }
}
#[test]
fn instance_reference_overrides_reject_missing_and_mistyped_references_and_alias_cycles() {
    for fields in [
        json!({"bindings":{"width":"missing"}}),
        json!({"bindings":{"width":"text"}}),
        json!({"styleRefs":{"fills":"missing"}}),
        json!({"styleRefs":{"textStyle":"blue"}}),
    ] {
        let mut d = reference_document();
        reference_override(&mut d, "i", "box", fields);
        assert!(components::changes(&serde_json::to_string(&d).unwrap(), &Fonts::new()).is_err());
    }
    let mut d = reference_document();
    d.design_system
        .as_mut()
        .unwrap()
        .variables
        .get_mut("b")
        .unwrap()
        .values
        .insert("m".into(), json!({"alias":"alias"}));
    reference_override(&mut d, "i", "box", json!({"bindings":{"width":"alias"}}));
    let error =
        components::changes(&serde_json::to_string(&d).unwrap(), &Fonts::new()).unwrap_err();
    assert!(error.contains("cycle"));
}

#[test]
fn staged_expansion_keeps_read_baseline_and_input_on_late_override_error() {
    for property_defaults in [false, true] {
        let mut d = basic();
        if property_defaults {
            d.nodes.get_mut("main").unwrap().component.as_mut().unwrap().properties =
                serde_json::from_value(json!({
                    "title":{"name":"Title","kind":"text","targetKey":"label","defaultValue":"Changed source default"}
                })).unwrap();
        }
        // The first instance expands successfully before the second fails.
        // Both the borrowed source and property-default-owned source must
        // retain the entire original document on failure.
        d.nodes.insert("z".into(), serde_json::from_value(instance("z", "main")).unwrap());
        d.pages[0].children.push("z".into());
        d.nodes.get_mut("z").unwrap().instance.as_mut().unwrap().overrides.insert(
            "label".into(), serde_json::from_value(json!({"width":"not a number"})).unwrap(),
        );
        let before = d.clone();
        assert!(components::resolve(&mut d).unwrap_err().contains("Invalid instance override"));
        assert_eq!(d, before);
    }
}

#[test]
fn escaped_instance_ids_support_add_remove_and_stable_changes() {
    let main = "main\\\"😀";
    let label = "label\\\"😀";
    let owner = "owner\\\"😀";
    let mut text = shape(label, "text");
    text["text"] = json!("A quoted \\ \" label");
    let mut d = doc(vec![main_node(main, &[label]), text, instance(owner, main)], &[main, owner]);
    resolve(&mut d);
    let old = generated(&d, owner, label);
    assert_eq!(resolved_changes(&d), d);
    d.nodes.insert("replacement".into(), serde_json::from_value(shape("replacement", "ellipse")).unwrap());
    d.nodes.get_mut(main).unwrap().children = vec!["replacement".into()];
    d.nodes.remove(label);
    let next = resolved_changes(&d);
    assert!(!next.nodes.contains_key(&old));
    let new = generated(&next, owner, "replacement");
    assert_eq!(next.nodes[&new].kind, "ellipse");
    assert_eq!(next.nodes[owner].children, [new]);
    assert_eq!(resolved_changes(&next), next);
}

#[test]
fn missing_component_reference_retains_original_document() {
    let mut d = basic();
    d.nodes.get_mut("i").unwrap().instance.as_mut().unwrap().component_id = "missing".into();
    let before = d.clone();
    assert!(components::resolve(&mut d).unwrap_err().contains("Missing main component"));
    assert_eq!(d, before);
}

#[test]
fn unrelated_payload_allocation_survives_component_resolution() {
    let mut d = basic();
    let mut unrelated = shape("unrelated", "text");
    unrelated["text"] = json!("unrelated payload ".repeat(4096));
    d.nodes.insert("unrelated".into(), serde_json::from_value(unrelated).unwrap());
    d.pages[0].children.push("unrelated".into());
    let text_allocation = d.nodes["unrelated"].text.as_ptr();
    let text = d.nodes["unrelated"].text.clone();
    for _ in 0..2 {
        resolve(&mut d);
        assert_eq!(d.nodes["unrelated"].text, text);
        assert_eq!(d.nodes["unrelated"].text.as_ptr(), text_allocation, "unrelated payload must stay borrowed through staging and retain its allocation");
    }
}
