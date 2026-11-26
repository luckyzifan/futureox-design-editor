use futureox_design_kernel::{
    font::Fonts,
    interop::{export_sketch, export_sketch_layer_fields, import_sketch_report, read_zip_public},
    layout,
    scene::Document,
    sketch::{Document as SketchDocument, Size},
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

fn legacy_frame(mask: u64) -> Vec<u8> {
    sketch_archive(
        json!({"app": "com.bohemiancoding.sketch3", "appVersion": "69.2", "version": 134}),
        json!({
            "_class": "artboard", "do_objectID": "frame", "name": "Frame",
            "frame": {"x": 0, "y": 0, "width": 100, "height": 80},
            "layers": [{
                "_class": "rectangle", "do_objectID": "child", "name": "Child",
                "frame": {"x": 20, "y": 30, "width": 40, "height": 10},
                "resizingConstraint": mask
            }]
        }),
    )
}

fn assert_box(doc: &Document, id: &str, expected: [f64; 4]) {
    let node = &doc.nodes[id];
    let actual = [node.transform.0[4], node.transform.0[5], node.width, node.height];
    for (actual_axis, expected_axis) in actual.into_iter().zip(expected) {
        assert!((actual_axis - expected_axis).abs() < 1e-9, "{id}: {actual:?} != {expected:?}");
    }
}

fn resize_parent(doc: &mut Document, id: &str, size: Size, fonts: &Fonts) {
    let parent = doc.nodes.get_mut(id).unwrap();
    parent.width = size.width;
    parent.height = size.height;
    layout::resolve(doc, fonts).unwrap();
}

#[test]
fn legacy_fixed_and_flexible_axes_match_native_and_retain_the_mask() {
    let fonts = Fonts::new();
    let old = Size { width: 100., height: 80. };
    let new = Size { width: 200., height: 140. };
    for (mask, expected) in [
        (45, [60., 56.25, 40., 10.]),
        (47, [40., 56.25, 80., 10.]),
        (27, [20., 30., 90., 22.]),
        (11, [20., 30., 90., 10.]),
        (54, [160. / 3., 75., 320. / 3., 25.]),
    ] {
        let archive = legacy_frame(mask);
        let native = SketchDocument::from_sketch(&archive).unwrap();
        let proposal = native.layer("child").unwrap().frame_for_parent_resize(old, new).unwrap();
        let native_frame = [proposal.x, proposal.y, proposal.width, proposal.height];
        for (actual, expected) in native_frame.into_iter().zip(expected) {
            assert!((actual - expected).abs() < 1e-9);
        }
        let mut document = import_sketch_report(&archive).unwrap().document;
        layout::resolve(&mut document, &fonts).unwrap();
        assert_box(&document, "child", [20., 30., 40., 10.]);
        resize_parent(&mut document, "frame", new, &fonts);
        assert_box(&document, "child", expected);
        assert_eq!(export_sketch_layer_fields(&document, "child").unwrap()["resizingConstraint"], mask);

        let mut reopened = import_sketch_report(&export_sketch(&document).unwrap()).unwrap().document;
        layout::resolve(&mut reopened, &fonts).unwrap();
        resize_parent(&mut reopened, "frame", old, &fonts);
        assert_box(&reopened, "child", [20., 30., 40., 10.]);
    }
}

#[test]
fn editing_one_pin_keeps_the_other_imported_legacy_axis() {
    let fonts = Fonts::new();
    let mut doc = import_sketch_report(&legacy_frame(27)).unwrap().document;
    layout::resolve(&mut doc, &fonts).unwrap();
    doc.nodes.get_mut("child").unwrap().constraints.as_mut().unwrap().horizontal = layout::Anchor::End;
    resize_parent(&mut doc, "frame", Size { width: 200., height: 140. }, &fonts);
    assert_box(&doc, "child", [120., 30., 40., 22.]);
    let fields = export_sketch_layer_fields(&doc, "child").unwrap();
    assert_eq!(fields["resizingConstraint"], 28);
    assert_eq!(fields["horizontalPins"], 4);
}

fn find_source_layer<'a>(layer: &'a Value, id: &str) -> Option<&'a Value> {
    if layer["do_objectID"] == id {
        return Some(layer);
    }
    layer["layers"].as_array()?.iter().find_map(|child| find_source_layer(child, id))
}

#[test]
fn real_wfp_checkbox_retains_its_fixed_size_when_the_master_grows() {
    const MASTER: &str = "CC3A07A3-603B-4397-8F50-D00A98F4C886";
    const CHILD: &str = "7264DD81-48ED-4FC3-98F4-F3B9D4136FC1";
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let fixture = project.join("testing/fixtures/sketch-public-20261105/ui-design-kit/[Legacy] WFP UI Kit.sketch");
    let files = read_zip_public(&std::fs::read(fixture).unwrap()).unwrap();
    let meta: Value = serde_json::from_slice(&files["meta.json"]).unwrap();
    let layer = files.iter().filter(|(name, _)| name.starts_with("pages/")).find_map(|(_, bytes)| {
        let page: Value = serde_json::from_slice(bytes).unwrap();
        find_source_layer(&page, MASTER).cloned()
    }).unwrap();
    let archive = sketch_archive(meta, layer);
    let native = SketchDocument::from_sketch(&archive).unwrap();
    let new = Size { width: 44., height: 44. };
    let proposal = native.layer(CHILD).unwrap().frame_for_parent_resize(Size { width: 22., height: 22. }, new).unwrap();
    assert_eq!([proposal.x, proposal.y, proposal.width, proposal.height], [13., 13., 18., 18.]);
    let fonts = Fonts::new();
    let mut doc = import_sketch_report(&archive).unwrap().document;
    layout::resolve(&mut doc, &fonts).unwrap();
    assert_box(&doc, CHILD, [2., 2., 18., 18.]);
    resize_parent(&mut doc, MASTER, new, &fonts);
    assert_box(&doc, CHILD, [13., 13., 18., 18.]);
    assert_eq!(export_sketch_layer_fields(&doc, CHILD).unwrap()["resizingConstraint"], 45);
}
