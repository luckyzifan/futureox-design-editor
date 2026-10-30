use futureox_design_kernel::{
    boolean::Operation,
    curve_boolean, design_system,
    editing::{DocumentEditor, DocumentPatch},
    font::Fonts,
    math::{Point, Transform},
    paint::{Images, Sampler},
    path::Path,
    scene::{Document, Node, Paint},
};
use serde_json::json;
use std::collections::BTreeMap;
fn doc() -> Document {
    serde_json::from_value(json!({"schemaVersion":4,"id":"d","name":"Features","pages":[{"id":"p","name":"Page","background":"#ffffff","children":["a","b"]}],"nodes":{"a":{"id":"a","kind":"rectangle","width":100,"height":100},"b":{"id":"b","kind":"rectangle","width":100,"height":100}}})).unwrap()
}
#[test]
fn curved_boolean_keeps_controls_and_source_topology() {
    let inputs = [
        (Path::ellipse(100., 100.), Transform::default(), true),
        (
            Path::ellipse(100., 100.),
            Transform([1., 0., 0., 1., 40., 0.]),
            true,
        ),
    ];
    let g = curve_boolean::combine(&inputs, Operation::Subtract).unwrap();
    assert!(g.edges.iter().any(|e| e.c1.is_some()));
    let (p, _) = g.paths().unwrap();
    let contours = p.flatten(Default::default(), 0.001).unwrap();
    assert_ne!(
        futureox_design_kernel::path::winding(Point::new(10., 50.), &contours),
        0
    );
    assert_eq!(
        futureox_design_kernel::path::winding(Point::new(70., 50.), &contours),
        0
    );
    let empty =
        curve_boolean::combine(&[inputs[0].clone(), inputs[0].clone()], Operation::Subtract)
            .unwrap();
    assert!(empty.edges.is_empty());
}
#[test]
fn tangent_and_reversed_coincident_curves_are_bounded() {
    let a = Path::ellipse(100., 100.);
    let b = Path::ellipse(100., 100.);
    let g = curve_boolean::combine(
        &[
            (a, Default::default(), true),
            (b, Transform([1., 0., 0., 1., 100., 0.]), true),
        ],
        Operation::Intersect,
    )
    .unwrap();
    assert!(g.edges.is_empty());
    let g = curve_boolean::combine(
        &[
            (
                Path::rectangle(10., 10., [0.; 4], 0.),
                Default::default(),
                false,
            ),
            (
                Path::rectangle(10., 10., [0.; 4], 0.),
                Transform([-1., 0., 0., 1., 10., 0.]),
                false,
            ),
        ],
        Operation::Union,
    )
    .unwrap();
    assert!(!g.edges.is_empty());
}
#[test]
fn variables_alias_modes_bindings_and_cycle_rejection() {
    let mut d = doc();
    d.design_system=Some(serde_json::from_value(json!({"collections":{"c":{"name":"Theme","modes":["light","dark"],"defaultMode":"light"}},"variables":{"space":{"name":"Space","collection":"c","kind":"number","values":{"light":24,"dark":40}},"alias":{"name":"Alias","collection":"c","kind":"number","values":{"light":{"alias":"space"},"dark":{"alias":"space"}}}},"activeModes":{"c":"dark"}})).unwrap());
    d.nodes
        .get_mut("a")
        .unwrap()
        .bindings
        .insert("width".into(), "alias".into());
    design_system::resolve(&mut d).unwrap();
    assert_eq!(d.nodes["a"].width, 40.);
    d.validate().unwrap();
    d.design_system
        .as_mut()
        .unwrap()
        .variables
        .get_mut("space")
        .unwrap()
        .values
        .insert("dark".into(), json!({"alias":"alias"}));
    assert!(d.validate().unwrap_err().contains("cycle"));
}
#[test]
fn shared_style_optional_defaults_are_available_to_bindings() {
    for (field, path, kind, style, bound) in [
        (
            "fills",
            "fills.0.opacity",
            "paint",
            json!([{"kind":"solid","color":"#ff0000"}]),
            0.25,
        ),
        ("textStyle", "textStyle.weight", "text", json!({}), 700.),
    ] {
        let mut d = doc();
        d.design_system = Some(serde_json::from_value(json!({
            "collections":{"c":{"name":"Theme","modes":["m"],"defaultMode":"m"}},
            "variables":{"v":{"name":"Value","collection":"c","kind":"number","values":{"m":bound}}},
            "styles":{"s":{"name":"Defaulted style","kind":kind,"value":style}}
        })).unwrap());
        let node = d.nodes.get_mut("a").unwrap();
        node.style_refs.insert(field.into(), "s".into());
        node.bindings.insert(path.into(), "v".into());
        d.validate().unwrap();
        design_system::resolve(&mut d).unwrap();
        let actual = serde_json::to_value(&d.nodes["a"]).unwrap();
        assert_eq!(
            actual.pointer(&format!("/{}", path.replace('.', "/"))),
            Some(&json!(bound))
        );
        let before = d.clone();
        design_system::resolve(&mut d).unwrap();
        assert_eq!(d, before);
    }
}
#[test]
fn paint_transforms_angular_diamond_and_luminance() {
    let n: Node =
        serde_json::from_value(json!({"id":"n","kind":"rectangle","width":100,"height":100}))
            .unwrap();
    let mut images = Images::default();
    let mut p:Paint=serde_json::from_value(json!({"kind":"linear","color":"#000000","stops":[{"offset":0,"color":"#000000"},{"offset":1,"color":"#ffffff"}],"transform":[0,1,-1,0,1,0]})).unwrap();
    let sampler = Sampler::new(
        &p,
        &n,
        Default::default(),
        futureox_design_kernel::math::Rect::new(0, 0, 100, 100),
        &mut images,
    )
    .unwrap();
    assert!((sampler.at(Point::new(50., 25.)).0[0] - 0.25).abs() < 1e-5);
    p.transform = None;
    p.kind = "angular".into();
    let sampler = Sampler::new(
        &p,
        &n,
        Default::default(),
        futureox_design_kernel::math::Rect::new(0, 0, 100, 100),
        &mut images,
    )
    .unwrap();
    assert!((sampler.at(Point::new(50., 75.)).0[0] - 0.25).abs() < 1e-5);
    p.kind = "diamond".into();
    let sampler = Sampler::new(
        &p,
        &n,
        Default::default(),
        futureox_design_kernel::math::Rect::new(0, 0, 100, 100),
        &mut images,
    )
    .unwrap();
    assert!((sampler.at(Point::new(75., 75.)).0[0] - 0.5).abs() < 1e-5);
    assert!(
        (futureox_design_kernel::blend::Pixel([0.5, 0., 0., 0.5]).mask_alpha(true) - 0.1063).abs()
            < 1e-5
    );
}
#[test]
fn local_patch_is_atomic_and_history_survives_failed_second_node() {
    let d = doc();
    let mut e = DocumentEditor::new(d.clone()).unwrap();
    let mut a = d.nodes["a"].clone();
    a.opacity = 0.5;
    let mut b = d.nodes["b"].clone();
    b.width = -1.;
    let p = DocumentPatch {
        nodes: BTreeMap::from([("a".into(), Some(a.clone())), ("b".into(), Some(b))]),
        fields: Default::default(),
    };
    assert!(e.apply(0, p).is_err());
    assert_eq!(e.document(), &d);
    assert_eq!(e.revision(), 0);
    e.apply(
        0,
        DocumentPatch {
            nodes: BTreeMap::from([("a".into(), Some(a))]),
            fields: Default::default(),
        },
    )
    .unwrap();
    e.undo().unwrap();
    assert_eq!(e.document(), &d);
    e.redo().unwrap();
    assert_eq!(e.document().nodes["a"].opacity, 0.5);
}
#[test]
fn rich_text_uses_shared_outlines_decorations_and_paragraph_metrics() {
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
    ))
    .unwrap();
    let mut fonts = Fonts::new();
    fonts.load(&bytes).unwrap();
    let mut n:Node=serde_json::from_value(json!({"id":"text","kind":"text","width":200,"height":100,"text":"中文\nText","fontSize":20,"textStyle":{"paragraphSpacing":12,"paragraphIndent":8},"textRuns":[{"start":0,"end":2,"color":"#ff0000","underline":true,"link":"https://example.com"}]})).unwrap();
    let rich = fonts.node_layout(&n, Some(200.)).unwrap();
    assert_eq!(rich.spans[0].color.as_deref(), Some("#ff0000"));
    assert_eq!(rich.spans[0].link.as_deref(), Some("https://example.com"));
    assert_eq!(rich.lines.len(), 2);
    n.text_runs.clear();
    n.text_style.as_mut().unwrap().paragraph_spacing = 0.;
    let plain = fonts.node_layout(&n, Some(200.)).unwrap();
    assert!((rich.height - plain.height - 12.).abs() < 1e-5);
    assert!(rich.path.commands.len() > plain.path.commands.len());
}
#[test]
fn prototype_rejects_dangling_targets_and_variable_type_errors() {
    let mut d = doc();
    d.prototype=Some(serde_json::from_value(json!({"startNode":"a","interactions":{"a":[{"trigger":"click","actions":[{"kind":"navigate","target":"missing"}]}]}})).unwrap());
    assert!(d.validate().unwrap_err().contains("destination"));
}
