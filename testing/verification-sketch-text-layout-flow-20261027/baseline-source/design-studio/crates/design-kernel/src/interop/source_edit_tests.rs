//! Source-save integrity tests. These exercise the production Sketch codec;
//! they do not assert native Sketch visual fidelity for unsupported properties.
use super::*;

const RECT: &str = "10000000-0000-4000-8000-000000000001";
const ELLIPSE: &str = "10000000-0000-4000-8000-000000000002";
const FRAME: &str = "10000000-0000-4000-8000-000000000003";
const POLYGON: &str = "10000000-0000-4000-8000-000000000004";

fn modeled_sketch() -> Document {
    let layers = [
        (RECT, "rectangle"),
        (ELLIPSE, "oval"),
        (FRAME, "artboard"),
        (POLYGON, "polygon"),
    ]
    .into_iter()
    .map(|(id, class)| {
        let mut layer = json!({"_class":class,"do_objectID":id,"name":class,
                "frame":{"x":5,"y":10,"width":100,"height":80},
                "fixedRadius":0,"numberOfPoints":5,"innerRadius":0.5});
        if class == "artboard" {
            layer["groupLayout"] =
                json!({"_class":"MSImmutableFlexGroupLayout","flexDirection":0,"allGuttersGap":2});
            layer["layers"] = json!([]);
        }
        layer
    })
    .collect::<Vec<_>>();
    let files = BTreeMap::from([
        ("meta.json".into(), br#"{"version":136}"#.to_vec()),
        (
            "document.json".into(),
            br#"{"colorSpace":1,"pages":[{"_ref":"pages/p"}]}"#.to_vec(),
        ),
        (
            "pages/p.json".into(),
            serde_json::to_vec(&json!({"_class":"page","do_objectID":"p","layers":layers}))
                .unwrap(),
        ),
    ]);
    let mut document = import_sketch_source_window(&files).unwrap().document;
    document.schema_version = document.schema_version.max(8);
    document.validate().unwrap();
    document
}

#[test]
fn unsupported_authored_fields_are_rejected_even_beside_a_supported_change() {
    let baseline = modeled_sketch();
    for (id, field, value) in [
        (RECT, "smoothing", json!(0.6)),
        (FRAME, "clip", json!(true)),
        (FRAME, "radii", json!([1., 2., 3., 4.])),
        (
            ELLIPSE,
            "arc",
            json!({"startAngle":0.25,"sweepAngle":1.5,"innerRadius":0.25}),
        ),
        (POLYGON, "cornerRadius", json!(4.)),
        (
            RECT,
            "exportSettings",
            json!([{"id":"sketch-export-0","format":"png","scale":2.,"suffix":"@2x"}]),
        ),
    ] {
        for mixed in [false, true] {
            let mut edited = baseline.clone();
            let mut node = serde_json::to_value(&edited.nodes[id]).unwrap();
            node[field] = value.clone();
            if mixed {
                node["name"] = json!("supported sibling change");
            }
            edited
                .nodes
                .insert(id.into(), serde_json::from_value(node).unwrap());
            edited.validate().unwrap();
            let error = export_sketch_layer_edit(&baseline, &edited, id)
                .unwrap_err()
                .to_string();
            assert!(error.contains(&format!("Source field {field}")), "{error}");
        }
    }
}

#[test]
fn admitted_native_properties_save_and_reopen_without_unrelated_field_comparison() {
    let baseline = modeled_sketch();
    let mut edited = baseline.clone();
    let node = edited.nodes.get_mut(RECT).unwrap();
    node.name = "saved rectangle".into();
    node.visible = false;
    node.locked = true;
    node.opacity = 0.5;
    node.radii = [1., 2., 3., 4.];
    node.width = 125.;
    node.height = 75.;
    node.transform.0[4] = 13.5;
    node.constrain_proportions = true;
    edited.validate().unwrap();
    export_sketch_layer_edit(&baseline, &edited, RECT).unwrap();
    let roundtrip = import_sketch_report(&export_sketch(&edited).unwrap())
        .unwrap()
        .document;
    let expected = serde_json::to_value(&edited.nodes[RECT]).unwrap();
    let actual = serde_json::to_value(&roundtrip.nodes[RECT]).unwrap();
    for key in [
        "name",
        "visible",
        "locked",
        "opacity",
        "radii",
        "width",
        "height",
        "transform",
        "constrainProportions",
    ] {
        assert_eq!(actual.get(key), expected.get(key), "{key}");
    }
}

#[test]
fn actual_ui_fill_stroke_and_shadow_defaults_keep_the_existing_codec_path() {
    // frontend/design-client/src/model.ts paint(), stroke(), effect('shadow')
    // at f03197e. Keep their transient IDs and inactive defaults in the input;
    // a sample_node-only fixture would miss ordinary UI insertion regressions.
    let baseline = modeled_sketch();
    let mut edited = baseline.clone();
    let paint = |id: &str, color: &str| {
        json!({"id":id,"kind":"solid","color":color,
        "opacity":1,"visible":true,"angle":90,"stops":[
            {"offset":0,"color":color},{"offset":1,"color":"#f5b8dc"}],
        "fit":"cover","blend":"normal"})
    };
    let node = edited.nodes.get_mut(RECT).unwrap();
    node.fills
        .push(serde_json::from_value(paint("ui-fill", "#818cf8")).unwrap());
    node.strokes.push(
        serde_json::from_value(json!({"id":"ui-stroke",
        "paint":paint("ui-stroke-paint", "#303344"),"width":2,"align":"center",
        "cap":"round","join":"round","dash":"","visible":true}))
        .unwrap(),
    );
    node.effects.push(
        serde_json::from_value(json!({"id":"ui-shadow","kind":"shadow",
        "visible":true,"radius":8,"x":0,"y":8,"spread":0,"color":"#172033",
        "opacity":0.25,"amount":0.65}))
        .unwrap(),
    );
    edited.validate().unwrap();
    export_sketch_layer_edit(&baseline, &edited, RECT).unwrap();
    let reopened = import_sketch_report(&export_sketch(&edited).unwrap())
        .unwrap()
        .document;
    let node = &reopened.nodes[RECT];
    assert_eq!(node.fills.len(), 1);
    assert_eq!(node.fills[0].color, "#818cf8");
    assert_eq!(node.strokes.len(), 1);
    assert_eq!(node.strokes[0].paint.color, "#303344");
    assert_eq!(node.strokes[0].width, 2.);
    assert_eq!(node.effects.len(), 1);
    assert_eq!(node.effects[0].kind, "shadow");
    assert_eq!(
        (
            node.effects[0].radius,
            node.effects[0].y,
            node.effects[0].opacity
        ),
        (8., 8., 0.25)
    );
    // This regression is native active-field preservation, not a claim that
    // transient IDs or all dormant UI values persist through foreign formats.
}

#[test]
fn new_source_layer_rejects_each_proven_omission_with_a_fixed_error() {
    for (kind, field, value) in [
        ("rectangle", "smoothing", json!(0.6)),
        ("rect", "smoothing", json!(0.6)),
        ("frame", "smoothing", json!(0.6)),
        ("section", "smoothing", json!(0.6)),
        ("slice", "smoothing", json!(0.6)),
        ("frame", "clip", json!(true)),
        ("group", "clip", json!(true)),
        ("rectangle", "clip", json!(true)),
        (
            "ellipse",
            "arc",
            json!({"startAngle":0.25,"sweepAngle":1.5,"innerRadius":0.25}),
        ),
        (
            "ellipse",
            "arc",
            json!({"startAngle":0.,"sweepAngle":std::f64::consts::TAU,"innerRadius":0.}),
        ),
        (
            "ellipse",
            "arc",
            json!({"startAngle":0.,"sweepAngle":0.,"innerRadius":0.}),
        ),
        ("polygon", "cornerRadius", json!(4.)),
        ("star", "cornerRadius", json!(4.)),
        ("frame", "radii", json!([1., 2., 3., 4.])),
        ("section", "radii", json!([1., 2., 3., 4.])),
        ("slice", "radii", json!([1., 2., 3., 4.])),
        (
            "rectangle",
            "exportSettings",
            json!([{"id":"export","format":"png","scale":2.,"suffix":"@2x"}]),
        ),
        (
            "slice",
            "exportSettings",
            json!([{"id":"export","format":"pdf","scale":1.,"suffix":""}]),
        ),
    ] {
        for visible in [true, false] {
            let mut value_node =
                serde_json::to_value(crate::facet::sample_node("new", kind)).unwrap();
            value_node[field] = value.clone();
            value_node["visible"] = json!(visible);
            // No children/paint, and zero radii for smoothing, still retain
            // authored state. Current visible pixels are not an admission rule.
            let node: Node = serde_json::from_value(value_node).unwrap();
            let before = node.clone();
            let error = validate_sketch_new_layer_for_source_save(&node).unwrap_err();
            assert_eq!(
                error.to_string(),
                format!(
                    "unsupported lossless conversion: Source field {field} is not supported by the Sketch save codec; keep the draft or save a native document"
                )
            );
            assert_eq!(node, before);
        }
    }
}

#[test]
fn new_source_layer_allows_zero_defaults_and_supported_rectangle_radii() {
    for kind in [
        "rectangle",
        "rect",
        "ellipse",
        "frame",
        "section",
        "slice",
        "polygon",
        "star",
        "group",
    ] {
        let mut node = crate::facet::sample_node("new", kind);
        // These are UI dormant defaults, not import-canonicalized replacements.
        node.points = if kind == "star" { 5 } else { 3 };
        node.inner_radius = 0.45;
        node.text = "双击编辑文字".into();
        for zero in [0., -0.] {
            node.smoothing = zero;
            node.corner_radius = zero;
            node.radii = [zero; 4];
            validate_sketch_new_layer_for_source_save(&node).unwrap();
        }
        if matches!(kind, "rectangle" | "rect") {
            node.radii = [1., 2., 3., 4.];
            validate_sketch_new_layer_for_source_save(&node).unwrap();
        }
    }
    // Helper admission is deliberately not a claim that section kind or star
    // innerRadius (known separate codec gaps) survive foreign interchange.
}

#[test]
fn new_source_guard_stays_kind_scoped_not_a_generic_leaf_oracle() {
    let mut ellipse = crate::facet::sample_node("new", "ellipse");
    // These rectangle-only controls are dormant on an ordinary no-arc ellipse.
    ellipse.smoothing = 0.6;
    ellipse.radii = [8.; 4];
    validate_sketch_new_layer_for_source_save(&ellipse).unwrap();
    let mut group = crate::facet::sample_node("new", "group");
    group.smoothing = 0.6;
    group.radii = [8.; 4];
    validate_sketch_new_layer_for_source_save(&group).unwrap();
}

#[test]
fn new_source_guard_retains_fixed_field_precedence() {
    let mut frame = crate::facet::sample_node("new", "frame");
    frame.smoothing = 0.6;
    frame.clip = true;
    frame.radii = [8.; 4];
    frame.export_settings =
        serde_json::from_value(json!([{"id":"export","format":"png","scale":1.,"suffix":""}]))
            .unwrap();
    for expected in ["smoothing", "clip", "radii", "exportSettings"] {
        let error = validate_sketch_new_layer_for_source_save(&frame).unwrap_err();
        assert_eq!(
            error.to_string(),
            format!(
                "unsupported lossless conversion: Source field {expected} is not supported by the Sketch save codec; keep the draft or save a native document"
            )
        );
        match expected {
            "smoothing" => frame.smoothing = 0.,
            "clip" => frame.clip = false,
            "radii" => frame.radii = [0.; 4],
            _ => frame.export_settings.clear(),
        }
    }
    validate_sketch_new_layer_for_source_save(&frame).unwrap();
}
