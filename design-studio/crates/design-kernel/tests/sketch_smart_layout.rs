use futureox_design_kernel::{
    font::Fonts,
    interop::{export_sketch, import_sketch_report, read_zip_public},
    layout,
    scene::Document,
    Engine,
};
use serde_json::{Value, json};
use std::{io::{Cursor, Write}, path::Path};

fn sketch_archive(meta: Value, layer: Value) -> Vec<u8> {
    let document = json!({"_class": "document", "pages": [{"_ref": "pages/p"}]});
    let page = json!({"_class": "page", "do_objectID": "p", "name": "Page", "layers": [layer]});
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, value) in [("meta.json", meta), ("document.json", document), ("pages/p.json", page)] {
        zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn meta() -> Value {
    json!({"app": "com.bohemiancoding.sketch3", "appVersion": "69.2", "version": 134})
}

fn shape(id: &str, name: &str, x: f64, y: f64, width: f64, height: f64) -> Value {
    json!({
        "_class": "rectangle", "do_objectID": id, "name": name,
        "frame": {"x": x, "y": y, "width": width, "height": height},
        "isVisible": true, "resizingConstraint": 63
    })
}

fn inferred(id: &str, frame: [f64; 4], axis: u64, anchor: u64, children: Vec<Value>) -> Value {
    json!({
        "_class": "group", "do_objectID": id, "name": id,
        "frame": {"x": frame[0], "y": frame[1], "width": frame[2], "height": frame[3]},
        "groupLayout": {"_class": "MSImmutableInferredGroupLayout", "axis": axis, "layoutAnchor": anchor},
        "layers": children
    })
}

fn box_at(doc: &Document, id: &str) -> [f64; 4] {
    let node = &doc.nodes[id];
    [node.transform.0[4], node.transform.0[5], node.width, node.height]
}

#[test]
fn hiding_a_direct_child_hugs_the_group_and_keeps_the_start_edge() {
    let fonts = Fonts::new();
    let archive = sketch_archive(meta(), inferred("g", [16., 20., 213., 79.], 0, 0, vec![
        shape("g1", "Group 1", 0., 0., 86., 76.),
        shape("g2", "Group 2", 128., 3., 85., 76.),
    ]));
    let mut doc = import_sketch_report(&archive).unwrap().document;
    // A pristine import keeps every authored frame.
    layout::resolve(&mut doc, &fonts).unwrap();
    assert_eq!(box_at(&doc, "g"), [16., 20., 213., 79.]);
    assert_eq!(box_at(&doc, "g1"), [0., 0., 86., 76.]);
    assert_eq!(box_at(&doc, "g2"), [128., 3., 85., 76.]);

    doc.nodes.get_mut("g2").unwrap().visible = false;
    layout::resolve(&mut doc, &fonts).unwrap();
    // Remaining content 86 plus the authored leading/trailing gaps (0/0).
    assert_eq!(box_at(&doc, "g"), [16., 20., 86., 79.]);
    assert_eq!(box_at(&doc, "g1"), [0., 0., 86., 76.]);
    // Hidden layers keep their authored frame.
    assert_eq!(box_at(&doc, "g2"), [128., 3., 85., 76.]);

    // The hidden layer can be shown again; the archived content returns.
    doc.nodes.get_mut("g2").unwrap().visible = true;
    layout::resolve(&mut doc, &fonts).unwrap();
    assert_eq!(box_at(&doc, "g"), [16., 20., 213., 79.]);
    assert_eq!(box_at(&doc, "g1"), [0., 0., 86., 76.]);
    assert_eq!(box_at(&doc, "g2"), [128., 3., 85., 76.]);
}

#[test]
fn layout_anchors_keep_the_center_or_trailing_edge_when_a_child_hides() {
    let fonts = Fonts::new();
    for (anchor, group) in [
        (0, [0., 0., 130., 40.]),
        (1, [35., 0., 130., 40.]),
        (2, [70., 0., 130., 40.]),
    ] {
        let archive = sketch_archive(meta(), inferred("g", [0., 0., 200., 40.], 0, anchor, vec![
            shape("a", "a", 10., 5., 40., 20.),
            shape("b", "b", 70., 5., 50., 20.),
            shape("c", "c", 140., 5., 40., 20.),
        ]));
        let mut doc = import_sketch_report(&archive).unwrap().document;
        layout::resolve(&mut doc, &fonts).unwrap();
        assert_eq!(box_at(&doc, "g"), [0., 0., 200., 40.], "anchor {anchor} pristine");
        assert_eq!(box_at(&doc, "a"), [10., 5., 40., 20.], "anchor {anchor} pristine a");

        doc.nodes.get_mut("b").unwrap().visible = false;
        layout::resolve(&mut doc, &fonts).unwrap();
        assert_eq!(box_at(&doc, "g"), group, "anchor {anchor} group");
        // Children stay in group-local coordinates; the anchor moves the frame.
        assert_eq!(box_at(&doc, "a"), [10., 5., 40., 20.], "anchor {anchor} a");
        assert_eq!(box_at(&doc, "c"), [70., 5., 40., 20.], "anchor {anchor} c");
        assert_eq!(box_at(&doc, "b"), [70., 5., 50., 20.], "anchor {anchor} hidden b");
    }
}

#[test]
fn widening_a_child_keeps_the_middle_or_end_anchor_edge() {
    let fonts = Fonts::new();
    for (anchor, origin) in [(1, -5.), (2, -10.)] {
        let archive = sketch_archive(meta(), inferred("g", [0., 0., 200., 40.], 0, anchor, vec![
            shape("a", "a", 10., 5., 40., 20.),
            shape("b", "b", 70., 5., 50., 20.),
            shape("c", "c", 140., 5., 40., 20.),
        ]));
        let mut doc = import_sketch_report(&archive).unwrap().document;
        layout::resolve(&mut doc, &fonts).unwrap();
        assert_eq!(box_at(&doc, "g"), [0., 0., 200., 40.], "anchor {anchor} pristine");

        doc.nodes.get_mut("b").unwrap().width = 60.;
        layout::resolve(&mut doc, &fonts).unwrap();
        // Content 40+60+40 with 20 gaps and 10/20 padding is 210. The anchor
        // keeps the middle or trailing group edge, so the frame grows left.
        assert_eq!(box_at(&doc, "g"), [origin, 0., 210., 40.], "anchor {anchor} group");
        assert_eq!(box_at(&doc, "a"), [10., 5., 40., 20.], "anchor {anchor} a");
        assert_eq!(box_at(&doc, "b"), [70., 5., 60., 20.], "anchor {anchor} b");
        assert_eq!(box_at(&doc, "c"), [150., 5., 40., 20.], "anchor {anchor} c");
    }
}

#[test]
fn widening_a_child_reflows_and_reexports_the_inferred_layout() {
    let fonts = Fonts::new();
    let archive = sketch_archive(
        meta(),
        json!({
            "_class": "group", "do_objectID": "g", "name": "g",
            "frame": {"x": 0, "y": 0, "width": 200, "height": 40},
            "groupLayout": {"_class": "MSImmutableInferredGroupLayout", "axis": 0,
                "layoutAnchor": 0, "minSize": 240, "maxSize": 260},
            "layers": [
                {"_class": "rectangle", "do_objectID": "a", "name": "a",
                 "frame": {"x": 10, "y": 5, "width": 40, "height": 20}},
                {"_class": "rectangle", "do_objectID": "b", "name": "b",
                 "frame": {"x": 70, "y": 5, "width": 50, "height": 20}},
                {"_class": "rectangle", "do_objectID": "c", "name": "c",
                 "frame": {"x": 140, "y": 5, "width": 40, "height": 20}}
            ]
        }),
    );
    let mut doc = import_sketch_report(&archive).unwrap().document;
    layout::resolve(&mut doc, &fonts).unwrap();
    assert_eq!(box_at(&doc, "g"), [0., 0., 200., 40.]);

    doc.nodes.get_mut("b").unwrap().width = 60.;
    layout::resolve(&mut doc, &fonts).unwrap();
    // Content 40+60+40 with 20 gaps and 10/20 padding = 210, raised to min 240.
    assert_eq!(box_at(&doc, "g"), [0., 0., 240., 40.]);
    assert_eq!(box_at(&doc, "a"), [10., 5., 40., 20.]);
    assert_eq!(box_at(&doc, "b"), [70., 5., 60., 20.]);
    assert_eq!(box_at(&doc, "c"), [150., 5., 40., 20.]);

    let exported = export_sketch(&doc).unwrap();
    let files = read_zip_public(&exported).unwrap();
    let (_, page) = files.iter().find(|(name, _)| name.starts_with("pages/")).unwrap();
    let page: Value = serde_json::from_slice(page).unwrap();
    let layout = &page["layers"][0]["groupLayout"];
    assert_eq!(layout["_class"], json!("MSImmutableInferredGroupLayout"));
    assert_eq!(layout["axis"], json!(0));
    assert_eq!(layout["layoutAnchor"], json!(0));
    assert_eq!(layout["minSize"], json!(240));
    assert_eq!(layout["maxSize"], json!(260));

    let mut reopened = import_sketch_report(&exported).unwrap().document;
    layout::resolve(&mut reopened, &fonts).unwrap();
    assert_eq!(box_at(&reopened, "g"), [0., 0., 240., 40.]);
    assert_eq!(box_at(&reopened, "c"), [150., 5., 40., 20.]);
}

#[test]
fn nonuniform_authored_spacing_stays_untouched_until_content_changes() {
    let fonts = Fonts::new();
    let archive = sketch_archive(meta(), inferred("g", [0., 0., 130., 20.], 0, 0, vec![
        shape("a", "a", 0., 0., 20., 20.),
        shape("b", "b", 50., 0., 20., 20.),
        shape("c", "c", 90., 0., 20., 20.),
    ]));
    let mut doc = import_sketch_report(&archive).unwrap().document;
    layout::resolve(&mut doc, &fonts).unwrap();
    assert_eq!(box_at(&doc, "g"), [0., 0., 130., 20.]);
    assert_eq!(box_at(&doc, "a"), [0., 0., 20., 20.]);
    assert_eq!(box_at(&doc, "b"), [50., 0., 20., 20.]);
    assert_eq!(box_at(&doc, "c"), [90., 0., 20., 20.]);

    // The first authored gap (30) becomes the inferred spacing after an edit;
    // the authored trailing gap (130 - 110 = 20) stays.
    doc.nodes.get_mut("b").unwrap().visible = false;
    layout::resolve(&mut doc, &fonts).unwrap();
    assert_eq!(box_at(&doc, "g"), [0., 0., 90., 20.]);
    assert_eq!(box_at(&doc, "a"), [0., 0., 20., 20.]);
    assert_eq!(box_at(&doc, "c"), [50., 0., 20., 20.]);
}

fn find_source_layer<'a>(layer: &'a Value, id: &str) -> Option<&'a Value> {
    if layer["do_objectID"] == id {
        return Some(layer);
    }
    layer["layers"].as_array()?.iter().find_map(|child| find_source_layer(child, id))
}

#[test]
fn real_wfp_links_group_reflows_after_hiding_group_2() {
    const LINKS: &str = "776004CF-9A44-4D34-93D9-08EFFB8105DE";
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let fixture = project.join("testing/fixtures/sketch-public-20261105/ui-design-kit/[Legacy] WFP UI Kit.sketch");
    let files = read_zip_public(&std::fs::read(fixture).unwrap()).unwrap();
    let meta: Value = serde_json::from_slice(&files["meta.json"]).unwrap();
    let links = files.iter().filter(|(name, _)| name.starts_with("pages/"))
        .find_map(|(_, bytes)| {
            let page: Value = serde_json::from_slice(bytes).ok()?;
            find_source_layer(&page, LINKS).cloned()
        })
        .expect("Links layer");
    let archive = sketch_archive(meta, links);
    // The WFP panel text uses Hug sizing, so resolve needs a real face.
    let mut engine = Engine::new();
    engine.load_font(&std::fs::read(project.join("frontend/design-client/public/fonts/NotoSansSC.ttf")).unwrap()).unwrap();
    let mut doc = import_sketch_report(&archive).unwrap().document;
    let links = LINKS.to_owned();
    let group_1 = "848C133C-6E43-4F01-A2B9-2C3A78AD8607".to_owned();
    let group_2 = "79862C8E-1406-4042-88F7-B4C3C05F8D29".to_owned();
    layout::resolve(&mut doc, &engine.fonts).unwrap();
    assert_eq!(box_at(&doc, &links), [16., 20., 213., 79.]);
    assert_eq!(box_at(&doc, &group_1), [0., 0., 86., 76.]);

    doc.nodes.get_mut(&group_2).unwrap().visible = false;
    layout::resolve(&mut doc, &engine.fonts).unwrap();
    assert_eq!(box_at(&doc, &links), [16., 20., 86., 79.]);
    assert_eq!(box_at(&doc, &group_1), [0., 0., 86., 76.]);
    assert_eq!(box_at(&doc, &group_2), [128., 3., 85., 76.]);
}
