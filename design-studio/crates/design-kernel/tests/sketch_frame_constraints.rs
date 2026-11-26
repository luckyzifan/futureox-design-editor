use futureox_design_kernel::{
    components,
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

fn modern_frame(child: Value) -> Vec<u8> {
    sketch_archive(
        json!({"app": "com.bohemiancoding.sketch3", "appVersion": "2026.1.2", "version": 188}),
        json!({
            "_class": "group", "groupBehavior": 1, "do_objectID": "frame", "name": "Frame",
            "frame": {"x": 0, "y": 0, "width": 100, "height": 80}, "layers": [child]
        }),
    )
}

#[test]
fn modern_frame_relative_size_keeps_the_archived_pins_and_round_trips() {
    let fonts = Fonts::new();
    let old = Size { width: 100., height: 80. };
    let new = Size { width: 200., height: 140. };
    for (pins, expected) in [(1, [20., 30., 80., 17.5]), (0, [40., 52.5, 80., 17.5])] {
        let archive = modern_frame(json!({
            "_class": "rectangle", "do_objectID": "child", "name": "Child",
            "frame": {"x": 20, "y": 30, "width": 40, "height": 10},
            "resizingConstraint": 63,
            "horizontalPins": pins, "verticalPins": pins,
            "horizontalSizing": 3, "verticalSizing": 3,
        }));
        let mut doc = import_sketch_report(&archive).unwrap().document;
        assert_eq!(doc.nodes["child"].sizing_value().width, layout::SizeMode::Relative);
        assert_eq!(doc.nodes["child"].sizing_value().height, layout::SizeMode::Relative);
        assert_eq!(doc.nodes["child"].sizing_value().width_ratio, Some(0.4));
        assert_eq!(doc.nodes["child"].sizing_value().height_ratio, Some(0.125));
        layout::resolve(&mut doc, &fonts).unwrap();
        assert_box(&doc, "child", [20., 30., 40., 10.]);
        resize_parent(&mut doc, "frame", new, &fonts);
        assert_box(&doc, "child", expected);

        let fields = export_sketch_layer_fields(&doc, "child").unwrap();
        assert_eq!(fields["horizontalSizing"], 3);
        assert_eq!(fields["verticalSizing"], 3);
        assert_eq!(fields["horizontalPins"], pins);
        assert_eq!(fields["verticalPins"], pins);
        let mut reopened = import_sketch_report(&export_sketch(&doc).unwrap()).unwrap().document;
        layout::resolve(&mut reopened, &fonts).unwrap();
        resize_parent(&mut reopened, "frame", old, &fonts);
        assert_box(&reopened, "child", [20., 30., 40., 10.]);
    }
}

#[test]
#[ignore = "requires the original Sketch 2026.1.2 test.sketch fixture"]
fn actual_sketch_frame_infers_nonstack_ratios_from_the_saved_geometry() {
    const FRAME: &str = "71AD6CBC-2C77-467C-9C3A-CBD8F9D8BAB5";
    const CHILD: &str = "3C42BEBA-8C1C-4378-B313-C54F9ED55144";
    let fixture = std::env::var_os("FUTUREOX_TEST_RELATIVE_SKETCH").expect("provide the original test.sketch");
    let files = read_zip_public(&std::fs::read(fixture).unwrap()).unwrap();
    let meta: Value = serde_json::from_slice(&files["meta.json"]).unwrap();
    let mut frame = files.iter().filter(|(name, _)| name.starts_with("pages/")).find_map(|(_, bytes)| {
        let page: Value = serde_json::from_slice(bytes).unwrap();
        find_source_layer(&page, FRAME).cloned()
    }).unwrap();
    let mut child = find_source_layer(&frame, CHILD).unwrap().clone();
    assert!(child["percentageSize"].is_null());
    assert_eq!(child["horizontalSizing"], 3);
    assert_eq!(child["verticalSizing"], 3);
    // Retain the original two layers' layout fields and geometry. Omit the
    // unrelated descendants and resources from this frame-sizing workset.
    child["layers"] = json!([]);
    frame["layers"] = json!([child]);
    let fonts = Fonts::new();
    let mut doc = import_sketch_report(&sketch_archive(meta, frame)).unwrap().document;
    assert_eq!(doc.nodes[CHILD].sizing_value().width_ratio, Some(380. / 1920.));
    assert_eq!(doc.nodes[CHILD].sizing_value().height_ratio, Some(750. / 12084.));
    layout::resolve(&mut doc, &fonts).unwrap();
    assert_box(&doc, CHILD, [1301., 7416., 380., 750.]);
    let mut pinned = doc.clone();
    let constraints = pinned.nodes.get_mut(CHILD).unwrap().constraints.get_or_insert_with(Default::default);
    constraints.horizontal = layout::Anchor::Start;
    constraints.vertical = layout::Anchor::Start;
    layout::resolve(&mut pinned, &fonts).unwrap();
    resize_parent(&mut pinned, FRAME, Size { width: 3840., height: 24168. }, &fonts);
    assert_box(&pinned, CHILD, [1301., 7416., 760., 1500.]);
    resize_parent(&mut doc, FRAME, Size { width: 3840., height: 24168. }, &fonts);
    assert_box(&doc, CHILD, [2602., 14832., 760., 1500.]);
}

fn unpinned_fixed_frame(producer: &str, vertical_pins: u64, mask: u64) -> Vec<u8> {
    sketch_archive(
        json!({"app": producer, "appVersion": "2026.1.2", "version": 188}),
        json!({
            "_class": "group", "groupBehavior": 1, "do_objectID": "frame", "name": "Frame",
            "frame": {"x": 0, "y": 0, "width": 100, "height": 80},
            "layers": [{
                "_class": "rectangle", "do_objectID": "child", "name": "Child",
                "frame": {"x": 20, "y": 30, "width": 40, "height": 10},
                "resizingConstraint": mask,
                "horizontalPins": 0, "verticalPins": vertical_pins,
                "horizontalSizing": 0, "verticalSizing": 0
            }]
        }),
    )
}

#[test]
fn native_unpinned_fixed_frame_axes_keep_size_and_move_their_center() {
    let fonts = Fonts::new();
    let old = Size { width: 100., height: 80. };
    let new = Size { width: 200., height: 140. };
    for (vertical_pin, expected, expected_mask) in [
        (0, [60., 56.25, 40., 10.], 45),
        (4, [60., 90., 40., 10.], 37),
    ] {
        let bytes = unpinned_fixed_frame("com.bohemiancoding.sketch3", vertical_pin, 63);
        let imported = import_sketch_report(&bytes).unwrap().document;
        // Source-derived axes must survive ordinary Futureox document saves.
        let mut doc = serde_json::from_slice(&serde_json::to_vec(&imported).unwrap()).unwrap();
        layout::resolve(&mut doc, &fonts).unwrap();
        assert_box(&doc, "child", [20., 30., 40., 10.]);
        resize_parent(&mut doc, "frame", new, &fonts);
        assert_box(&doc, "child", expected);

        let fields = export_sketch_layer_fields(&doc, "child").unwrap();
        assert_eq!(fields["horizontalSizing"], 0);
        assert_eq!(fields["verticalSizing"], 0);
        assert_eq!(fields["horizontalPins"], 0);
        assert_eq!(fields["verticalPins"], vertical_pin);
        assert_eq!(fields["resizingConstraint"], expected_mask);

        let mut reopened = import_sketch_report(&export_sketch(&doc).unwrap()).unwrap().document;
        layout::resolve(&mut reopened, &fonts).unwrap();
        resize_parent(&mut reopened, "frame", old, &fonts);
        assert_box(&reopened, "child", [20., 30., 40., 10.]);
        resize_parent(&mut reopened, "frame", new, &fonts);
        assert_box(&reopened, "child", expected);
    }
}

#[test]
fn default_futureox_pins_and_a_nondefault_saved_sketch_mask_keep_their_behavior() {
    let fonts = Fonts::new();
    let new = Size { width: 200., height: 140. };
    for (producer, mask, expected) in [
        ("com.futureox.design-kernel", 63, [20., 30., 40., 10.]),
        ("", 63, [20., 30., 40., 10.]),
        ("com.bohemiancoding.sketch3", 27, [20., 30., 90., 22.]),
    ] {
        let bytes = unpinned_fixed_frame(producer, 0, mask);
        let mut doc = import_sketch_report(&bytes).unwrap().document;
        layout::resolve(&mut doc, &fonts).unwrap();
        resize_parent(&mut doc, "frame", new, &fonts);
        assert_box(&doc, "child", expected);
        assert_eq!(export_sketch_layer_fields(&doc, "child").unwrap()["resizingConstraint"], mask);
    }
}

#[test]
fn resized_native_symbol_reflows_its_fixed_master_child() {
    let native_meta = json!({"app": "com.bohemiancoding.sketch3", "appVersion": "69.2", "version": 134});
    let source = json!({
            "_class": "artboard", "do_objectID": "page-content", "name": "Content",
            "frame": {"x": 0, "y": 0, "width": 500, "height": 280},
            "layers": [{
                "_class": "symbolMaster", "do_objectID": "master", "name": "Master",
                "frame": {"x": 240, "y": 20, "width": 100, "height": 80}, "symbolID": "symbol",
                "groupLayout": {"_class": "MSImmutableFreeformGroupLayout"}, "resizesContent": true, "clippingBehavior": 1,
                "layers": [{
                    "_class": "rectangle", "do_objectID": "child", "name": "Child",
                    "frame": {"x": 20, "y": 30, "width": 40, "height": 10},
                    "resizingConstraint": 45
                }]
            }, {
                "_class": "symbolInstance", "do_objectID": "instance", "name": "Instance",
                "frame": {"x": 5, "y": 5, "width": 200, "height": 140}, "symbolID": "symbol",
                "resizingConstraint": 9, "scale": 1,
                "overrideValues": [{"_class": "overrideValue", "overrideName": "child_isVisible", "value": false}]
            }]
        });
    let archive = sketch_archive(native_meta.clone(), source.clone());
    let font = Fonts::new();
    let decoded = import_sketch_report(&archive).unwrap().document;
    assert_box(&decoded, "instance", [5., 5., 200., 140.]);
    let mut resolved = decoded.clone();
    components::resolve(&mut resolved).unwrap();
    layout::resolve(&mut resolved, &font).unwrap();
    assert_box(&resolved, "instance", [5., 5., 200., 140.]);
    assert_eq!(resolved.nodes["instance"].name, "Instance");
    assert!(resolved.nodes["instance"].clip);
    let child = resolved.nodes["instance"].children[0].clone();
    assert_box(&resolved, &child, [60., 56.25, 40., 10.]);
    assert!(!resolved.nodes[&child].visible);
    assert_eq!(resolved.nodes[&child].instance_origin.as_ref().unwrap().source, "child");
    assert_box(&resolved, "child", [20., 30., 40., 10.]);
    assert!(resolved.nodes["child"].visible);

    resize_parent(&mut resolved, "page-content", Size { width: 700., height: 440. }, &font);
    assert_box(&resolved, "instance", [5., 5., 200., 140.]);
    assert_box(&resolved, &child, [60., 56.25, 40., 10.]);

    let mut authored = decoded.clone();
    let placement = authored.nodes.get_mut("instance").unwrap();
    placement.width = 220.;
    placement.height = 160.;
    let mut edited = authored.clone();
    components::resolve(&mut edited).unwrap();
    layout::resolve(&mut edited, &font).unwrap();
    assert_box(&edited, "instance", [5., 5., 220., 160.]);
    assert_box(&edited, &edited.nodes["instance"].children[0], [68., 65., 40., 10.]);
    let fields = export_sketch_layer_fields(&authored, "instance").unwrap();
    assert_eq!(fields["_class"], "symbolInstance");
    assert_eq!(fields["resizingConstraint"], 9);
    assert!(fields.get("layers").is_none());
    // The real File menu exports the resolved editor snapshot.
    let exported = export_sketch(&edited).unwrap();
    let entries = read_zip_public(&exported).unwrap();
    let exported_page: Value = serde_json::from_slice(entries.iter()
        .find(|(name, _)| name.starts_with("pages/")).unwrap().1).unwrap();
    let wire = &exported_page["layers"][0]["layers"][1];
    assert_eq!(wire["_class"], "symbolInstance");
    assert_eq!(wire["userInfo"]["com.futureox.design-kernel"]["originalId"], "instance");
    assert!(wire.get("layers").is_none(), "generated child must not be written inside the symbol instance");
    let mut reopened = import_sketch_report(&exported).unwrap().document;
    components::resolve(&mut reopened).unwrap();
    layout::resolve(&mut reopened, &font).unwrap();
    assert_box(&reopened, "instance", [5., 5., 220., 160.]);
    let reopened_child = &reopened.nodes["instance"].children[0];
    assert_box(&reopened, reopened_child, [68., 65., 40., 10.]);
    assert!(!reopened.nodes[reopened_child].visible);
    assert!(reopened.nodes["instance"].clip);

    let mut relative_source = source.clone();
    relative_source["_class"] = json!("group");
    relative_source["groupBehavior"] = json!(1);
    relative_source["layers"][1]["horizontalSizing"] = json!(3);
    relative_source["layers"][1]["horizontalPins"] = json!(1);
    let relative = sketch_archive(native_meta.clone(), relative_source.clone());
    let mut responsive = import_sketch_report(&relative).unwrap().document;
    components::resolve(&mut responsive).unwrap();
    layout::resolve(&mut responsive, &font).unwrap();
    assert_eq!(responsive.nodes["instance"].sizing_value().width_ratio, Some(0.4));
    resize_parent(&mut responsive, "page-content", Size { width: 700., height: 280. }, &font);
    assert_box(&responsive, "instance", [5., 5., 280., 140.]);
    assert_box(&responsive, &responsive.nodes["instance"].children[0], [92., 56.25, 40., 10.]);

    relative_source["layers"][1]["rotation"] = json!(17.);
    let rotated = sketch_archive(native_meta.clone(), relative_source);
    let mut rotated = import_sketch_report(&rotated).unwrap().document;
    let placement = rotated.nodes["instance"].transform;
    assert_ne!(placement.0[1], 0.);
    components::resolve(&mut rotated).unwrap();
    assert_eq!(rotated.nodes["instance"].transform, placement);

    let mut futureox_meta = native_meta.clone();
    futureox_meta["app"] = json!("com.futureox.design-kernel");
    let mut scaled = source.clone();
    scaled["layers"][1]["scale"] = json!(2);
    for archive in [sketch_archive(futureox_meta, source), sketch_archive(native_meta, scaled)] {
        let mut other = import_sketch_report(&archive).unwrap().document;
        assert_eq!(other.nodes["instance"].kind, "group");
        components::resolve(&mut other).unwrap();
        layout::resolve(&mut other, &font).unwrap();
        assert_box(&other, "instance", [5., 5., 100., 80.]);
    }
}

#[test]
fn real_sketch_bootstrap_symbol_keeps_its_archived_instance_dimensions() {
    const SOURCE_PAGE: &str = "pages/C5F7C269-590D-4C81-A68D-E24C81A4D69E.json";
    const MASTER: &str = "53B9221E-E14E-44F7-BC18-610E2B17E57D";
    const INSTANCE: &str = "6D2F8F8A-9AF1-457B-84DE-71ED87480C51";
    const CHILD: &str = "5B699FD4-C955-4CAB-BC5E-0D29C76A1712";
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let fixture = project.join("testing/fixtures/sketch-public-20261105/free-sketch-bootstrap-ui-kit/free-sketch-bootstrap5-ui-kit.sketch");
    let files = read_zip_public(&std::fs::read(fixture).unwrap()).unwrap();
    let meta: Value = serde_json::from_slice(&files["meta.json"]).unwrap();
    let page: Value = serde_json::from_slice(&files[SOURCE_PAGE]).unwrap();
    let master = find_source_layer(&page, MASTER).unwrap();
    let instance = find_source_layer(&page, INSTANCE).unwrap();
    let archive = sketch_archive(meta, json!({
        "_class": "group", "do_objectID": "witness", "name": "Source layers",
        "frame": {"width": 2000, "height": 2000}, "layers": [master, instance]
    }));
    let native = SketchDocument::from_sketch(&archive).unwrap();
    let reduced = native.layer(CHILD).unwrap().frame_for_parent_resize(
        Size { width: 190., height: 90. }, Size { width: 97., height: 38. }).unwrap();
    assert_eq!([reduced.x, reduced.y, reduced.width, reduced.height], [0., 0., 97., 38.]);
    let mut resolved = import_sketch_report(&archive).unwrap().document;
    components::resolve(&mut resolved).unwrap();
    layout::resolve(&mut resolved, &Fonts::new()).unwrap();
    assert_box(&resolved, INSTANCE, [0., 0., 97., 38.]);
    assert_box(&resolved, &resolved.nodes[INSTANCE].children[0], [0., 0., 97., 38.]);
    assert_box(&resolved, CHILD, [0., 0., 190., 90.]);
}

#[test]
fn an_unpinned_regular_group_follows_its_native_frame_before_its_child_pins() {
    let source = json!({
        "_class": "group", "do_objectID": "frame", "name": "Frame", "groupBehavior": 1,
        "frame": {"x": 0, "y": 0, "width": 100, "height": 80},
        "layers": [{
            "_class": "group", "do_objectID": "group", "name": "Group", "groupBehavior": 0,
            "groupLayout": {"_class": "MSImmutableFreeformGroupLayout"},
            "frame": {"x": 10, "y": 10, "width": 70, "height": 50},
            "horizontalPins": 0, "verticalPins": 0, "horizontalSizing": 0, "verticalSizing": 0,
            "resizingConstraint": 63,
            "layers": [{
                "_class": "rectangle", "do_objectID": "child", "name": "Child",
                "frame": {"x": 20, "y": 8, "width": 30, "height": 12},
                "horizontalPins": 4, "verticalPins": 1, "horizontalSizing": 0, "verticalSizing": 0,
                "resizingConstraint": 12
            }]
        }]
    });
    let meta = |app| json!({"app": app, "appVersion": "2026.3.1", "version": 188});
    let decode = |producer, layer| import_sketch_report(&sketch_archive(meta(producer), layer)).unwrap().document;
    let fonts = Fonts::new();
    let original = Size { width: 100., height: 80. };
    let expanded = Size { width: 200., height: 140. };
    let mut doc = decode("com.bohemiancoding.sketch3", source.clone());
    layout::resolve(&mut doc, &fonts).unwrap();
    assert_box(&doc, "group", [10., 10., 70., 50.]);
    assert_box(&doc, "child", [20., 8., 30., 12.]);
    resize_parent(&mut doc, "frame", expanded, &fonts);
    assert_box(&doc, "group", [20., 17.5, 140., 87.5]);
    assert_box(&doc, "child", [90., 8., 30., 12.]);
    assert_eq!(doc.nodes["group"].transform.point(doc.nodes["child"].transform.point(Default::default())),
        futureox_design_kernel::math::Point::new(110., 25.5));
    let child = export_sketch_layer_fields(&doc, "child").unwrap();
    assert_eq!(child["horizontalPins"], 4);
    assert_eq!(child["verticalPins"], 1);
    assert_eq!(child["resizingConstraint"], 12);

    let mut reopened = import_sketch_report(&export_sketch(&doc).unwrap()).unwrap().document;
    layout::resolve(&mut reopened, &fonts).unwrap();
    resize_parent(&mut reopened, "frame", original, &fonts);
    assert_box(&reopened, "group", [10., 10., 70., 50.]);
    assert_box(&reopened, "child", [20., 8., 30., 12.]);
    resize_parent(&mut reopened, "frame", expanded, &fonts);
    assert_box(&reopened, "group", [20., 17.5, 140., 87.5]);
    assert_box(&reopened, "child", [90., 8., 30., 12.]);

    let mut explicitly_pinned = source.clone();
    explicitly_pinned["layers"][0]["horizontalPins"] = json!(1);
    explicitly_pinned["layers"][0]["verticalPins"] = json!(1);
    let mut controls = [
        decode("com.futureox.design-kernel", source),
        decode("com.bohemiancoding.sketch3", explicitly_pinned),
    ];
    for doc in &mut controls {
        layout::resolve(doc, &fonts).unwrap();
        resize_parent(doc, "frame", expanded, &fonts);
        assert_box(doc, "group", [10., 10., 70., 50.]);
        assert_box(doc, "child", [20., 8., 30., 12.]);
    }
}
