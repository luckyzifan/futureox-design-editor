use futureox_design_kernel::{Engine, interop, scene::Document};
use serde_json::{Value, json};
use std::io::{Read, Write};

fn document(kind: &str, angle: f64) -> Document {
    serde_json::from_value(json!({"schemaVersion":18,"id":"d","name":"spatial",
        "colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},
        "pages":[{"id":"p","name":"P","background":"#ffffff","children":["n"]}],
        "nodes":{"n":{"id":"n","kind":"rectangle","width":12,"height":16,"transform":[1,0,0,1,24,24],
            "fills":[{"kind":"solid","color":"#3366b3"}],
            "effects":[{"kind":kind,"radius":3.25,"motionAngle":angle,"color":"#000000"}]}}})).unwrap()
}
fn pixels(doc: &Document) -> Vec<[u32; 4]> {
    let mut e = Engine::new();
    e.load_document(&serde_json::to_string(doc).unwrap())
        .unwrap();
    let options=e.parse_options(json!({"pageId":"p","width":72,"height":72,"transparent":true,"view":{"x":0,"y":0,"zoom":1}})).unwrap();
    e.render_linear(&options)
        .unwrap()
        .iter()
        .map(|p| p.0.map(f32::to_bits))
        .collect()
}
fn patch_native_blur(bytes: &[u8], radius: f64) -> Vec<u8> {
    let mut input = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut output = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for i in 0..input.len() {
        let mut file = input.by_index(i).unwrap();
        let name = String::from_utf8_lossy(file.name_raw()).into_owned();
        let mut data = Vec::new();
        file.read_to_end(&mut data).unwrap();
        if name.starts_with("pages/") {
            let mut page: Value = serde_json::from_slice(&data).unwrap();
            page["layers"][0]["style"]["blur"]["radius"] = json!(radius);
            page["layers"][0]["style"]["blurs"][0]["radius"] = json!(radius);
            data = serde_json::to_vec(&page).unwrap();
        }
        output
            .start_file(
                name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        output.write_all(&data).unwrap();
    }
    output.finish().unwrap().into_inner()
}
#[test]
fn native_sigma_and_motion_roundtrip_without_losing_parameters_or_pixels() {
    for (kind, angle) in [("gaussian-blur", 0.), ("motion-blur", 37.5), ("motion-blur", -37.5)] {
        let d = document(kind, angle);
        let expected = pixels(&d);
        let archive = interop::export_sketch(&d).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&archive)).unwrap();
        let page_name = zip.file_names().filter_map(Result::ok)
            .find(|name| name.starts_with("pages/")).unwrap().into_owned();
        let page: Value = serde_json::from_reader(zip.by_name(&page_name).unwrap()).unwrap();
        assert_eq!(page["layers"][0]["style"]["blurs"][0]["motionAngle"].as_f64(), Some(-angle));
        let reopened = interop::import_sketch_report(&archive)
            .unwrap()
            .document;
        assert_eq!(reopened.nodes["n"].effects[0].kind, kind);
        assert_eq!(reopened.nodes["n"].effects[0].motion_angle, angle);
        assert_eq!(expected, pixels(&reopened));
        let mut plain = d.clone();
        plain.nodes.get_mut("n").unwrap().effects.clear();
        assert_ne!(expected, pixels(&plain));
    }
}
#[test]
fn existing_blur_model_roundtrips_but_native_edits_supersede_its_receipt() {
    let mut d = document("blur", 0.);
    d.schema_version = 17;
    let expected = pixels(&d);
    let bytes = interop::export_sketch(&d).unwrap();
    let same = interop::import_sketch_report(&bytes).unwrap().document;
    assert_eq!(same.nodes["n"].effects[0].kind, "blur");
    assert_eq!(expected, pixels(&same));
    let changed = interop::import_sketch_report(&patch_native_blur(&bytes, 5.))
        .unwrap()
        .document;
    assert_eq!(changed.nodes["n"].effects[0].kind, "gaussian-blur");
    assert_eq!(changed.nodes["n"].effects[0].radius, 5.);
    assert_ne!(expected, pixels(&changed));
}
#[test]
fn directional_support_and_schema_are_authoritative() {
    let d = document("motion-blur", 0.);
    let h = pixels(&d);
    let mut v = d.clone();
    v.nodes.get_mut("n").unwrap().effects[0].motion_angle = 90.;
    assert_ne!(h, pixels(&v));
    v.schema_version = 17;
    assert!(v.validate().unwrap_err().contains("18"));
    let n = &d.nodes["n"];
    assert!(n.effect_outset(0.01) >= 2.);
    assert!(n.effect_outset(2.) >= 3. * 3.25 * 2. + 2.);
}

#[test]
fn shared_style_filters_preserve_old_radius_and_color_controls() {
    use futureox_design_kernel::design_system::{DesignSystem, SharedStyle};
    for kind in ["blur", "gaussian-blur", "motion-blur", "color-controls"] {
        let mut d = document("motion-blur", 37.5);
        let mut fx = d.nodes["n"].effects[0].clone();
        fx.kind = kind.into();
        fx.motion_angle = if kind == "motion-blur" { 37.5 } else { 0. };
        if kind == "color-controls" {
            fx.color_controls = Some(
                serde_json::from_value(json!({
                    "brightness":0.2,"contrast":1.4,"saturation":0.,"hue":0.7,"space":"srgb"
                }))
                .unwrap(),
            );
        }
        let mut system = DesignSystem::default();
        system.styles.insert(
            "shared".into(),
            SharedStyle {
                name: "Shared".into(),
                kind: "paint".into(),
                value: json!([{"kind":"solid","color":"#3366b3"}]),
                strokes: vec![],
                effects: vec![fx.clone()],
            },
        );
        d.design_system = Some(system);
        let reopened = interop::import_sketch_report(&interop::export_sketch(&d).unwrap())
            .unwrap()
            .document;
        let actual = &reopened.design_system.unwrap().styles["shared"].effects[0];
        assert_eq!(actual.kind, fx.kind);
        assert_eq!(actual.motion_angle, fx.motion_angle);
        if kind == "color-controls" {
            assert_eq!(actual.color_controls, fx.color_controls);
        } else {
            assert_eq!(actual.radius, fx.radius);
        }
    }
}

#[test]
fn current_sketch_blur_array_is_read_and_roundtripped() {
    let bytes =
        include_bytes!("../../../../testing/fixtures/design/sketch-spatial-blur-modern.sketch");
    let report = interop::import_sketch_report(bytes).unwrap();
    let doc = report.document;
    for (label, angle) in [
        ("t1-r10-a0-stripe-source", 0.),
        ("t1-r10-a30-stripe-source", -30.),
        ("t1-r10-a90-stripe-source", -90.),
    ] {
        let source = doc.nodes.values().find(|node| node.name == label).unwrap();
        assert_eq!(source.effects[0].motion_angle, angle);
    }
    assert_eq!(
        doc.nodes
            .values()
            .flat_map(|n| &n.effects)
            .filter(|e| e.kind == "gaussian-blur")
            .count(),
        4
    );
    assert_eq!(
        doc.nodes
            .values()
            .flat_map(|n| &n.effects)
            .filter(|e| e.kind == "motion-blur")
            .count(),
        7
    );
    let exported = interop::export_sketch(&doc).unwrap();
    let reopened = interop::import_sketch_report(&exported).unwrap().document;
    for n in doc.nodes.values().filter(|n| !n.effects.is_empty()) {
        assert_eq!(n.effects, reopened.nodes[&n.id].effects);
    }
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(exported)).unwrap();
    let name = archive
        .file_names()
        .filter_map(Result::ok)
        .find(|n| n.starts_with("pages/"))
        .map(|n| n.into_owned())
        .unwrap();
    let page: Value = serde_json::from_reader(archive.by_name(&name).unwrap()).unwrap();
    for board in page["layers"].as_array().unwrap() {
        let blurs = &board["layers"][0]["style"]["blurs"];
        assert_eq!(blurs.as_array().unwrap().len(), 1);
        assert_eq!(blurs[0]["isEnabled"], true);
    }
}
