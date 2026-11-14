use futureox_design_kernel::{Engine, RenderOptions, View, fidelity::RasterProfile, interop};
use serde_json::{Value, json};
use std::io::Write;

#[test]
fn sketch_motion_blur_keeps_a_one_texel_stripe_two_device_pixels_wide_at_2x() {
    use futureox_design_kernel::export::{ExportBounds, RegionRequest};

    let archive = include_bytes!("../../../../testing/fixtures/design/sketch-spatial-blur-modern.sketch");
    let doc = interop::import_sketch_report(archive).unwrap().document;
    let root = doc.nodes.values().find(|n| n.name == "t1-r10-a90-stripe").unwrap();
    let bitmap = &doc.nodes[&root.children[0]];
    assert_eq!(bitmap.effects[0].kind, "motion-blur");
    let source = serde_json::to_string(&doc).unwrap();
    let roundtrip = futureox_design_kernel::binfmt::decode_authored_json(
        &futureox_design_kernel::binfmt::encode_authored_json(&source).unwrap(),
    ).unwrap();
    let mut engine = Engine::new();
    engine.load_document(&roundtrip).unwrap();
    let png = engine.render_region_png(&RegionRequest {
        page_id: doc.pages[0].id.clone(),
        bounds: ExportBounds {
            x: root.transform.0[4], y: root.transform.0[5], width: root.width, height: root.height,
        },
        scale: 2.,
        node_ids: Some(vec![root.id.clone()]),
        raster_profile: Some(RasterProfile::Analytic),
        color_output: None,
    }).unwrap();
    let image = image::load_from_memory(&png).unwrap().into_rgba8();
    // Sketch's original 2× export has no spill on the axis normal to the
    // effect. The Gaussian's along-axis quantization is a separate property.
    let alpha = (255..259).map(|x| image.get_pixel(x, 192).0[3]).collect::<Vec<_>>();
    assert_eq!(alpha[0], 0);
    assert_eq!(alpha[3], 0);
    assert!(alpha[1] > 250 && alpha[2] > 250, "{alpha:?}");
}

#[test]
fn sketch_frame_fill_can_be_visible_in_canvas_and_omitted_from_its_own_export() {
    use futureox_design_kernel::export::{ExportBounds, RegionRequest};

    let source = include_bytes!("../../../../testing/fixtures/design/sketch-spatial-blur-modern.sketch");
    let report = interop::import_sketch_report(source).unwrap();
    let doc = report.document;
    let frame = doc.nodes.values().find(|node| node.name == "t0-r1-a0-box").unwrap();
    let id = frame.id.clone();
    assert_eq!(frame.kind, "frame");
    assert!(frame.fills.iter().any(|fill| fill.visible));
    let page_id = doc.pages[0].id.clone();

    let roundtrip = |doc: &futureox_design_kernel::scene::Document| {
        let json = serde_json::to_string(doc).unwrap();
        let fd = futureox_design_kernel::binfmt::encode_authored_json(&json).unwrap();
        futureox_design_kernel::binfmt::decode_authored_json(&fd).unwrap()
    };
    let check = |json: &str| {
        let mut engine = Engine::new();
        engine.load_document(json).unwrap();
        for scale in [1., 2.] {
            for node_ids in [None, Some(vec![id.clone()])] {
                let request = RegionRequest {
                    page_id: page_id.clone(),
                    bounds: ExportBounds { x: 0., y: 0., width: 256., height: 192. },
                    scale,
                    node_ids,
                    raster_profile: Some(RasterProfile::Analytic),
                    color_output: None,
                };
                let png = engine.render_region_png(&request).unwrap();
                let image = image::load_from_memory(&png).unwrap().into_rgba8();
                // Independent Sketch 2025.1.3 exports leave the corner clear
                // while retaining the white content. The blur kernel is
                // validated separately, away from the frame background.
                assert_eq!(image.get_pixel(0, 0).0, [0; 4]);
                assert_eq!(image.get_pixel((128. * scale) as u32, (96. * scale) as u32).0, [255; 4]);
            }
        }
        let canvas = engine.parse_options(json!({
            "pageId":page_id,"width":256,"height":192,"view":{"x":0,"y":0,"zoom":1},
            "transparent":true,"rasterProfile":"analytic"
        })).unwrap();
        assert_eq!(&engine.render(&canvas).unwrap()[..4], &[255; 4], "export must restore the live frame fill");
    };
    check(&roundtrip(&doc));

    let exported = interop::export_sketch(&doc).unwrap();
    let reopened = interop::import_sketch_report(&exported).unwrap();
    check(&roundtrip(&reopened.document));

    let mut nested = doc;
    let mut outer = futureox_design_kernel::facet::sample_node("outer", "frame");
    outer.width = 256.;
    outer.height = 192.;
    outer.children = std::mem::take(&mut nested.pages[0].children);
    nested.nodes.insert(outer.id.clone(), outer);
    nested.pages[0].children = vec!["outer".into()];
    let mut engine = Engine::new();
    engine.load_document(&roundtrip(&nested)).unwrap();
    let mut request = RegionRequest {
        page_id, bounds: ExportBounds { x: 0., y: 0., width: 256., height: 192. },
        scale: 1., node_ids: Some(vec!["outer".into()]),
        raster_profile: Some(RasterProfile::Analytic), color_output: None,
    };
    let first_pixel = |png: Vec<u8>| image::load_from_memory(&png).unwrap().into_rgba8().get_pixel(0, 0).0;
    assert_eq!(first_pixel(engine.render_region_png(&request).unwrap()), [255; 4], "a nested frame's fill remains content of the outer export");
    request.node_ids = Some(vec![id]);
    assert_eq!(first_pixel(engine.render_region_png(&request).unwrap()), [0; 4]);
}

fn source_blur(kind: i64) -> Value {
    json!({"_class":"blur","isEnabled":true,"type":kind,"radius":4,
        "saturation":1,"center":"{0.25, 0.75}","motionAngle":37,
        "sourceExtension":{"keep":"verbatim"}})
}

fn rectangle(id: &str, frame: [usize; 4], value: f64, alpha: f64) -> Value {
    json!({"_class":"rectangle","do_objectID":id,"name":id,
        "frame":{"x":frame[0],"y":frame[1],"width":frame[2],"height":frame[3]},
        "style":{"contextSettings":{"opacity":1},"fills":[{
            "isEnabled":true,"fillType":0,"color":{"red":value,"green":value,"blue":value,"alpha":alpha}
        }]}})
}

fn archive(blur: &Value) -> Vec<u8> {
    archive_style(blur, false)
}
fn archive_style(blur: &Value, modern: bool) -> Vec<u8> {
    let mut layers = Vec::new();
    for y in 0..6 {
        for x in 0..8 {
            layers.push(rectangle(&format!("cell-{x}-{y}"), [x * 8, y * 8, 8, 8],
                ((x + y) % 2) as f64, 1.));
        }
    }
    let mut frosted = rectangle("frosted", [16, 8, 32, 32], 1., 0.1);
    if modern { frosted["style"]["blurs"] = json!([blur]); }
    else { frosted["style"]["blur"] = blur.clone(); }
    layers.push(frosted);
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, value) in [
        ("meta.json", json!({"appVersion":"test"})),
        ("document.json", json!({"colorSpace":1,"pages":[{"_ref":"pages/p"}]})),
        ("pages/p.json", json!({"_class":"page","do_objectID":"p","name":"p","layers":layers})),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

#[test]
fn topology_numeric_blur_enable_flags_render_and_preserve_the_source_value() {
    // The user's topology archive stores modern blur.isEnabled as JSON 1.
    // Only the two native boolean encodings are accepted, not truthy values.
    for modern in [false, true] {
        for kind in 0..=3 {
            for (flag, enabled) in [(json!(1), true), (json!(0), false), (json!(true), true),
                (json!(false), false), (json!(2), false), (json!(-1), false), (json!("1"), false)] {
                let mut blur = source_blur(kind); blur["isEnabled"] = flag;
                let report = interop::import_sketch_report(&archive_style(&blur, modern)).unwrap();
                assert_eq!(report.document.nodes["frosted"].effects.len(), usize::from(enabled),
                    "modern={modern} kind={kind} flag={}", blur["isEnabled"]);
                assert_eq!(exported_blur(&report.document), blur);
            }
        }
    }
}

fn exported_blur(document: &futureox_design_kernel::scene::Document) -> Value {
    let exported = interop::export_sketch(document).unwrap();
    let files = interop::read_zip_public(&exported).unwrap();
    let page: Value = serde_json::from_slice(files.iter()
        .find(|(name, _)| name.starts_with("pages/")).unwrap().1).unwrap();
    page["layers"].as_array().unwrap().iter()
        .find(|layer| layer["name"] == "frosted").unwrap()["style"]["blur"].clone()
}

fn render(document: &futureox_design_kernel::scene::Document) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(document).unwrap()).unwrap();
    engine.render(&RenderOptions {
        page_id: document.pages[0].id.clone(), width: 64, height: 48,
        view: View { x: 0., y: 0., zoom: 1. }, transparent: true, grid: false,
        pixel_preview: None, animation: None, raster_profile: RasterProfile::Analytic, interactive_effects: false,
        checkerboard: false,
    }).unwrap()
}

#[test]
fn native_background_blur_imports_as_a_backdrop_effect_and_preserves_its_source_dictionary() {
    for (kind, expected) in [(0, "gaussian-blur"), (3, "background-blur")] {
        let source = source_blur(kind);
        let report = interop::import_sketch_report(&archive(&source)).unwrap();
        let node = &report.document.nodes["frosted"];
        assert!(node.visible);
        assert_eq!(node.effects.len(), 1);
        assert_eq!(node.effects[0].kind, expected);
        assert_eq!(node.effects[0].radius, 4.);
        assert_eq!(exported_blur(&report.document), source);
        let exported = interop::export_sketch(&report.document).unwrap();
        let reopened = interop::import_sketch_report(&exported).unwrap();
        assert_eq!(reopened.document.nodes["frosted"].effects[0].kind, expected);
        assert_eq!(render(&reopened.document), render(&report.document));
    }
}

#[test]
fn native_background_blur_changes_the_checkerboard_behind_the_layer_instead_of_its_fill() {
    // Native Sketch 2025.1.3 (203472) controls: type0 keeps checkerboard
    // contrast (22 vs255 at these two points), type3 blurs it (137 vs139).
    // Compare spatial semantics, not color interpolation between engines.
    let gaussian = render(&interop::import_sketch_report(&archive(&source_blur(0))).unwrap().document);
    let background = render(&interop::import_sketch_report(&archive(&source_blur(3))).unwrap().document);
    let red = |pixels: &[u8], x: usize, y: usize| pixels[(y * 64 + x) * 4] as i16;
    let gaussian_contrast = (red(&gaussian, 20, 20) - red(&gaussian, 24, 20)).abs();
    let background_contrast = (red(&background, 20, 20) - red(&background, 24, 20)).abs();
    assert!(gaussian_contrast > 100, "layer blur preserves the underlying checkerboard");
    assert!(background_contrast + 40 < gaussian_contrast, "background blur reduces backdrop contrast");
    assert!(red(&background, 20, 20) > red(&gaussian, 20, 20));
    assert!(red(&background, 24, 20) < red(&gaussian, 24, 20));
    assert_eq!(&background[(24 * 64 + 8) * 4..(24 * 64 + 8) * 4 + 4], &[0, 0, 0, 255], "the effect stays inside its layer shape");
    assert_ne!(background, gaussian);
}

#[test]
fn native_uniform_blur_reads_within_the_shape_and_matches_the_wide_step_response() {
    let mut files = interop::read_zip_public(&archive(&source_blur(3))).unwrap();
    let mut page: Value = serde_json::from_slice(&files["pages/p.json"]).unwrap();
    let radius = 8.;
    let mut blur = source_blur(3);
    blur["radius"] = json!(radius);
    let mut foreground = rectangle("frosted", [16, 8, 32, 32], 1., 0.05);
    foreground["style"]["blur"] = blur;
    page["layers"] = json!([
        rectangle("white", [0, 0, 64, 48], 1., 1.),
        rectangle("black", [0, 0, 24, 48], 0., 1.),
        foreground,
    ]);
    files.insert("pages/p.json".into(), serde_json::to_vec(&page).unwrap());
    let document = interop::import_sketch_source_window(&files).unwrap().document;
    let pixels = render(&document);
    let red = |x: usize| i16::from(pixels[(24 * 64 + x) * 4]);
    // On the same native step/radius, blur already brightens the left edge
    // of the capture well before the transition. The old radius-8 tent
    // leaves this pixel close to the 5% foreground fill (red=13).
    assert!(red(16) >= 95 && red(16) <= 120, "capture left edge: {}", red(16));
    assert_eq!(red(15), 0);
    assert_eq!(red(48), 255);
    assert_eq!(exported_blur(&document)["radius"], radius);
}

#[test]
fn edited_background_blur_exports_native_type_three_instead_of_gaussian() {
    let mut report = interop::import_sketch_report(&archive(&source_blur(3))).unwrap();
    report.document.nodes.get_mut("frosted").unwrap().effects[0].radius = 6.;
    let blur = exported_blur(&report.document);
    assert_eq!(blur["type"], 3);
    assert_eq!(blur["radius"], 6.);
}

#[test]
fn linear_progressive_background_blur_imports_two_strengths_and_keeps_saturation() {
    let mut source = source_blur(3);
    source["progressive"] = json!(true);
    source["saturation"] = json!(0.25);
    source["radius"] = json!(8);
    source["gradient"] = json!({
        "_class":"gradient","gradientType":0,"elipseLength":0,
        "from":"{0, 0.5}","to":"{1, 0.5}",
        "stops":[
            {"_class":"gradientStop","position":0,"color":{"red":0,"green":0,"blue":0,"alpha":0}},
            {"_class":"gradientStop","position":1,"alpha":1,"color":{"red":0,"green":0,"blue":0,"alpha":1}}
        ]
    });
    let report = interop::import_sketch_report(&archive(&source)).unwrap();
    let effect = &report.document.nodes["frosted"].effects[0];
    assert_eq!(effect.kind, "background-blur");
    assert_eq!(effect.radius, 1.);
    let gradient = effect.gradient_blur.expect("linear two-end ramp");
    assert_eq!(gradient.start, [0., 16.]);
    assert_eq!(gradient.end, [32., 16.]);
    assert_eq!((gradient.start_count, gradient.end_count, gradient.smooth), (0., 8., true));
    assert_eq!(effect.color_controls.unwrap().saturation, 0.25);
    assert!(report.document.schema_version >= 17);
    assert!(report.document.validate().is_ok());
    assert_eq!(exported_blur(&report.document), source);
    let lossy = report.document.design_system.as_ref()
        .and_then(|system| system.sketch_containers.get("nodeMetadata"))
        .and_then(|metadata| metadata.pointer("/frosted/bindings/sketchImportLossy"))
        .and_then(Value::as_str)
        .unwrap_or("");
    assert!(!lossy.contains("progressive-background"), "{lossy}");

    let progressive = render(&report.document);
    let mut uniform = source.clone();
    uniform.as_object_mut().unwrap().remove("progressive");
    uniform.as_object_mut().unwrap().remove("gradient");
    let uniform = render(&interop::import_sketch_report(&archive(&uniform)).unwrap().document);
    let red = |pixels: &[u8], x: usize, y: usize| pixels[(y * 64 + x) * 4] as i16;
    let contrast = |pixels: &[u8], x: usize| (red(pixels, x, 20) - red(pixels, x + 4, 20)).abs();
    assert!(contrast(&progressive, 20) > contrast(&progressive, 40), "the start stays sharper than the end");
    assert!(contrast(&progressive, 20) > contrast(&uniform, 20), "uniform blurs the sharp end");
    assert_ne!(progressive, uniform);
}

#[test]
fn progressive_background_scope_is_explicit_for_radial_multistop_and_layer_blur() {
    let mut radial = source_blur(3);
    radial["progressive"] = json!(true);
    radial["gradient"] = json!({"gradientType":1,"from":"{0.5, 0.5}","to":"{1, 0.5}","stops":[
        {"position":0,"color":{"alpha":0}},{"position":1,"color":{"alpha":1}}
    ]});
    let mut stops = radial.clone();
    stops["gradient"]["gradientType"] = json!(0);
    stops["gradient"]["stops"] = json!([
        {"position":0,"color":{"alpha":0}},
        {"position":0.5,"color":{"alpha":0.5}},
        {"position":1,"color":{"alpha":1}}
    ]);
    let mut layer = source_blur(0);
    layer["progressive"] = json!(true);
    layer["gradient"] = radial["gradient"].clone();
    layer["gradient"]["gradientType"] = json!(0);
    for (blur, note) in [
        (radial, "progressive-background-blur-radial-not-modeled"),
        (stops, "progressive-background-blur-stops-not-two-ended"),
        (layer, "progressive-blur-outside-background-scope"),
    ] {
        let report = interop::import_sketch_report(&archive(&blur)).unwrap();
        assert!(report.document.nodes["frosted"].effects[0].gradient_blur.is_none());
        let lossy = report.document.design_system.as_ref()
            .and_then(|system| system.sketch_containers.get("nodeMetadata"))
            .and_then(|metadata| metadata.pointer("/frosted/bindings/sketchImportLossy"))
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(lossy.contains(note), "{lossy} missing {note}");
        assert_eq!(exported_blur(&report.document), blur);
    }
}

#[test]
fn edited_progressive_background_blur_reopens_through_the_fd_receipt() {
    let mut source = source_blur(3);
    source["progressive"] = json!(true);
    source["radius"] = json!(4);
    source["gradient"] = json!({"gradientType":0,"from":"{0, 0.5}","to":"{1, 0.5}","stops":[
        {"position":0,"color":{"alpha":0}},{"position":1,"color":{"alpha":1}}
    ]});
    let mut report = interop::import_sketch_report(&archive(&source)).unwrap();
    let effect = &mut report.document.nodes.get_mut("frosted").unwrap().effects[0];
    effect.radius = 2.;
    effect.gradient_blur.as_mut().unwrap().end_count = 6.;
    effect.gradient_blur.as_mut().unwrap().smooth = false;
    let exported = interop::export_sketch(&report.document).unwrap();
    let reopened = interop::import_sketch_report(&exported).unwrap();
    let effect = &reopened.document.nodes["frosted"].effects[0];
    assert_eq!(effect.radius, 2.);
    assert_eq!(effect.gradient_blur.unwrap().end_count, 6.);
    assert!(!effect.gradient_blur.unwrap().smooth);
    assert_eq!(render(&reopened.document), render(&report.document));
}

#[test]
fn motion_and_zoom_blurs_keep_distinct_executable_kinds_and_native_source() {
    for (kind, expected) in [(1, "motion-blur"), (2, "zoom-blur")] {
        let source = source_blur(kind);
        let report = interop::import_sketch_report(&archive(&source)).unwrap();
        assert_eq!(report.document.nodes["frosted"].effects.len(),1);
        assert_eq!(report.document.nodes["frosted"].effects[0].kind,expected);
        assert!(!report.warnings.iter().any(|value| value.contains(&format!("{expected}-not-modeled"))));
        assert_eq!(exported_blur(&report.document), source);
    }
}
