use futureox_design_kernel::{
    font::Fonts,
    interop::{export_sketch, export_sketch_layer_fields, import_sketch_report},
    layout::{self, SizeMode},
    scene::Document,
};
use serde_json::json;

fn stack() -> Document {
    serde_json::from_value(json!({
        "schemaVersion": 29, "id": "d", "name": "Relative sizing",
        "pages": [{"id": "p", "name": "Page", "background": "#ffffff", "children": ["stack"]}],
        "nodes": {
            "stack": {
                "id": "stack", "kind": "frame", "width": 400, "height": 260,
                "children": ["fill", "quarter", "half", "fixed"],
                "layout": {"mode": "horizontal", "padding": [10,30,20,20], "gap": 10}
            },
            "fill": {
                "id": "fill", "kind": "rectangle", "width": 40, "height": 35,
                "sizing": {"width": "fill", "height": "fill"}
            },
            "quarter": {
                "id": "quarter", "kind": "rectangle", "width": 35, "height": 50,
                "sizing": {"width": "relative", "widthRatio": 0.25, "height": "relative", "heightRatio": 0.5}
            },
            "half": {
                "id": "half", "kind": "rectangle", "width": 40, "height": 35,
                "sizing": {"width": "relative", "widthRatio": 0.5, "height": "relative", "heightRatio": 0.4}
            },
            "fixed": {"id": "fixed", "kind": "rectangle", "width": 50, "height": 80}
        }
    })).unwrap()
}

fn assert_box(doc: &Document, id: &str, expected: [f64; 4]) {
    let node = &doc.nodes[id];
    let actual = [node.transform.0[4], node.transform.0[5], node.width, node.height];
    for (a, b) in actual.into_iter().zip(expected) {
        assert!((a - b).abs() < 1e-8, "{id}: {actual:?} != {expected:?}");
    }
}

#[test]
fn relative_items_use_inner_size_and_fill_consumes_slack() {
    let mut doc = stack();
    doc.validate().unwrap();
    let fonts = Fonts::new();
    layout::resolve(&mut doc, &fonts).unwrap();
    // Native Sketch 2026.3.1 detached stack, with 50pt fixed and three 10pt gaps.
    assert_box(&doc, "fill", [20., 10., 7.5, 230.]);
    assert_box(&doc, "quarter", [37.5, 10., 87.5, 115.]);
    assert_box(&doc, "half", [135., 10., 175., 92.]);
    assert_box(&doc, "fixed", [320., 10., 50., 80.]);
    let before = doc.clone();
    layout::resolve(&mut doc, &fonts).unwrap();
    assert_eq!(doc.nodes, before.nodes);

    let parent = doc.nodes.get_mut("stack").unwrap();
    parent.width = 300.;
    parent.height = 200.;
    layout::resolve(&mut doc, &fonts).unwrap();
    assert_box(&doc, "fill", [20., 10., 0.01, 170.]);
    assert_box(&doc, "quarter", [30.01, 10., 169.99 / 3., 85.]);
    assert_box(&doc, "half", [40.01 + 169.99 / 3., 10., 169.99 * 2. / 3., 68.]);
    assert_box(&doc, "fixed", [220., 10., 50., 80.]);
    assert_eq!(doc.nodes["half"].sizing_value().width_ratio, Some(0.5));
}

#[test]
fn wrapped_vertical_relative_items_keep_their_percentage_and_minimum() {
    let mut doc = stack();
    doc.nodes.remove("fill");
    let parent = doc.nodes.get_mut("stack").unwrap();
    parent.children.remove(0);
    parent.layout.as_mut().unwrap().mode = layout::Flow::Vertical;
    parent.layout.as_mut().unwrap().wrap = true;
    doc.nodes.get_mut("quarter").unwrap().sizing.as_mut().unwrap().min_height = 100.;
    let fonts = Fonts::new();
    layout::resolve(&mut doc, &fonts).unwrap();
    assert_box(&doc, "quarter", [20., 10., 87.5, 115.]);
    assert_box(&doc, "half", [20., 135., 175., 92.]);
    assert_box(&doc, "fixed", [203., 10., 50., 80.]);
    doc.nodes.get_mut("stack").unwrap().height = 190.;
    layout::resolve(&mut doc, &fonts).unwrap();
    assert_box(&doc, "quarter", [20., 10., 87.5, 100.]);
    assert_box(&doc, "half", [115.5, 10., 175., 64.]);
    assert_box(&doc, "fixed", [115.5, 84., 50., 80.]);
}

#[test]
fn sketch_round_trip_persists_relative_modes_and_fd_admission_checks_ratios() {
    let mut doc = stack();
    let fields = export_sketch_layer_fields(&doc, "half").unwrap();
    assert_eq!(fields["horizontalSizing"], json!(3));
    assert_eq!(fields["verticalSizing"], json!(3));
    assert_eq!(fields["percentageSize"], json!("{0.5, 0.4}"));
    let reopened = import_sketch_report(&export_sketch(&doc).unwrap()).unwrap().document;
    assert_eq!(reopened.schema_version, 29);
    assert_eq!(reopened.nodes["half"].sizing, doc.nodes["half"].sizing);

    doc.schema_version = 28;
    assert!(doc.validate().is_err());
    doc.schema_version = 29;
    let sizing = doc.nodes.get_mut("half").unwrap().sizing.as_mut().unwrap();
    sizing.width_ratio = Some(1.01);
    assert!(doc.validate().is_err());
    let sizing = doc.nodes.get_mut("half").unwrap().sizing.as_mut().unwrap();
    sizing.width = SizeMode::Fixed;
    sizing.width_ratio = None;
    assert!(doc.validate().is_ok());
}

#[test]
fn relative_stack_border_option_counts_the_largest_protruding_border_and_round_trips() {
    let mut doc: Document = serde_json::from_value(json!({
        "schemaVersion": 30, "id": "d", "name": "Stack border geometry",
        "pages": [{"id":"p","name":"Page","background":"#ffffff","children":["stack"]}],
        "nodes": {
            "stack": {
                "id":"stack","kind":"frame","width":300,"height":200,
                "children":["outside","center","inside"],
                "layout":{"mode":"horizontal","padding":[10,30,20,20],"gap":10}
            },
            "outside": {
                "id":"outside","kind":"rectangle","width":50,"height":60,
                "strokes":[{"width":10,"align":"outside","paint":{"kind":"solid","color":"#222222"}}]
            },
            "center": {
                "id":"center","kind":"rectangle","width":50,"height":60,
                "sizing":{"width":"relative","widthRatio":0.5,"height":"relative","heightRatio":0.5},
                "strokes":[
                    {"width":10,"align":"center","paint":{"kind":"solid","color":"#222222"}},
                    {"width":3,"align":"outside","paint":{"kind":"solid","color":"#333333"}},
                    {"width":90,"align":"outside","visible":false,"paint":{"kind":"solid","color":"#555555"}}
                ]
            },
            "inside": {
                "id":"inside","kind":"rectangle","width":50,"height":60,
                "strokes":[{"width":10,"align":"inside","paint":{"kind":"solid","color":"#222222"}}]
            }
        }
    })).unwrap();
    doc.validate().unwrap();
    let fonts = Fonts::new();
    layout::resolve(&mut doc, &fonts).unwrap();
    assert_box(&doc, "outside", [20., 10., 50., 60.]);
    assert_box(&doc, "center", [80., 10., 125., 85.]);
    assert_box(&doc, "inside", [215., 10., 50., 60.]);

    doc.nodes.get_mut("stack").unwrap().layout.as_mut().unwrap().borders_affect_layout = true;
    layout::resolve(&mut doc, &fonts).unwrap();
    // Detached native Sketch 2026.3.1, with a 10pt outside/center/inside border.
    assert_box(&doc, "outside", [30., 20., 50., 60.]);
    assert_box(&doc, "center", [105., 15., 100., 75.]);
    assert_box(&doc, "inside", [220., 10., 50., 60.]);
    let fields = export_sketch_layer_fields(&doc, "stack").unwrap();
    assert_eq!(fields["groupLayout"]["bordersAffectLayout"], true);
    let reopened = import_sketch_report(&export_sketch(&doc).unwrap()).unwrap().document;
    assert!(reopened.nodes["stack"].layout.as_ref().unwrap().borders_affect_layout);
    assert_eq!(reopened.schema_version, 30);
    doc.schema_version = 29;
    assert!(doc.validate().is_err());
}
