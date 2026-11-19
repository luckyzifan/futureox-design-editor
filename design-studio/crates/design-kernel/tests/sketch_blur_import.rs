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
    // The native 2× PNG resolves the stripe to two pixels with alpha 253
    // after the last motion stage.
    let alpha = (255..259).map(|x| image.get_pixel(x, 192).0[3]).collect::<Vec<_>>();
    assert_eq!(alpha[0], 0);
    assert_eq!(alpha[3], 0);
    assert_eq!(alpha[1..3], [253, 253]);
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
                let hidden = matches!(kind, 1 | 2) && [json!(false), json!(0)].contains(&blur["isEnabled"]);
                let effects = &report.document.nodes["frosted"].effects;
                assert_eq!(effects.len(), usize::from(enabled || hidden),
                    "modern={modern} kind={kind} flag={}", blur["isEnabled"]);
                if let Some(effect) = effects.first() {
                    assert_eq!(effect.visible, enabled);
                }
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
    source["isProgressive"] = json!(true);
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
    let gradient = effect.gradient_blur.as_ref().expect("linear two-end ramp");
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
    uniform.as_object_mut().unwrap().remove("isProgressive");
    uniform.as_object_mut().unwrap().remove("gradient");
    let uniform = render(&interop::import_sketch_report(&archive(&uniform)).unwrap().document);
    let red = |pixels: &[u8], x: usize, y: usize| pixels[(y * 64 + x) * 4] as i16;
    let contrast = |pixels: &[u8], x: usize| (red(pixels, x, 20) - red(pixels, x + 4, 20)).abs();
    assert!(contrast(&progressive, 20) > contrast(&progressive, 40), "the start stays sharper than the end");
    assert!(contrast(&progressive, 20) > contrast(&uniform, 20), "uniform blurs the sharp end");
    assert_ne!(progressive, uniform);
}

#[test]
fn radial_multistop_and_layer_progression_round_trip_and_filter_pixels() {
    let mut radial = source_blur(3);
    radial["isProgressive"] = json!(true);
    radial["gradient"] = json!({"gradientType":1,"elipseLength":0.65,"from":"{0.5, 0.5}","to":"{1, 0.5}","stops":[
        {"position":0,"color":{"alpha":0}},{"position":0.4,"color":{"alpha":1}},{"position":1,"color":{"alpha":0.2}}
    ]});
    let mut linear = radial.clone();
    linear["gradient"]["gradientType"] = json!(0);
    let mut layer = radial.clone();
    layer["type"] = json!(0);
    for blur in [radial, linear, layer] {
        let report = interop::import_sketch_report(&archive(&blur)).unwrap();
        let mut doc = report.document;
        let effect = &doc.nodes["frosted"].effects[0];
        let gradient = effect.gradient_blur.as_ref().unwrap();
        let ramp = gradient.sketch.as_ref().unwrap();
        assert_eq!(gradient.start, [16., 16.]);
        assert_eq!(gradient.end, [32., 16.]);
        assert_eq!(ramp.ellipse, 0.65);
        assert_eq!(ramp.stops[1].offset, 0.4);
        assert_eq!(exported_blur(&doc), blur);
        let before = render(&doc);
        let mut clear = doc.clone();
        clear.nodes.get_mut("frosted").unwrap().effects.clear();
        assert_ne!(before, render(&clear));
        let effect = &mut doc.nodes.get_mut("frosted").unwrap().effects[0];
        effect.gradient_blur.as_mut().unwrap().sketch.as_mut().unwrap().stops[1].strength = 0.35;
        assert_ne!(before, render(&doc));
        let out = interop::export_sketch(&doc).unwrap();
        let reopened = interop::import_sketch_report(&out).unwrap().document;
        assert_eq!(doc.nodes["frosted"].effects, reopened.nodes["frosted"].effects);
        assert_eq!(render(&doc), render(&reopened));
        let value = serde_json::to_string(&doc).unwrap();
        let fd = futureox_design_kernel::binfmt::encode_authored_json(&value).unwrap();
        let bytes = futureox_design_kernel::binfmt::decode_authored_json(&fd).unwrap();
        assert_eq!(render(&doc), render(&serde_json::from_str(&bytes).unwrap()));
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
    let native = exported_blur(&report.document);
    assert_eq!(native["isProgressive"], true);
    assert_eq!(native["gradient"]["from"], "{0, 0.5}");
    let exported = interop::export_sketch(&report.document).unwrap();
    let reopened = interop::import_sketch_report(&exported).unwrap();
    let effect = &reopened.document.nodes["frosted"].effects[0];
    assert_eq!(effect.radius, 2.);
    assert_eq!(effect.gradient_blur.as_ref().unwrap().end_count, 6.);
    assert!(!effect.gradient_blur.as_ref().unwrap().smooth);
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


#[test]
fn sketch_gaussian_radius1_corner_matches_the_published_native_alpha() {
    use futureox_design_kernel::blend::{Pixel, Surface};
    use futureox_design_kernel::effects::gaussian_surface;
    use futureox_design_kernel::export::{ExportBounds, RegionRequest};
    use futureox_design_kernel::math::Rect;

    // Hard 64×64 white rect, the fixture bitmap. Sigma 1 is the radius-1
    // kernel; the inset corner is the published native sample.
    let mut kernel = Surface::new(Rect::new(0, 0, 64, 64)).unwrap();
    kernel.pixels.fill(Pixel([1., 1., 1., 1.]));
    let blurred = gaussian_surface(&kernel, 1., false).unwrap();
    let byte = |x, y| (blurred.at(x, y).0[3] * 255.).round_ties_even() as u8;
    assert_eq!(byte(1, 1), 210);
    // Sigma 5 stays on the unscaled three-box path.
    let wide = gaussian_surface(&kernel, 5., false).unwrap();
    assert_eq!((wide.at(1, 1).0[3] * 255.).round_ties_even() as u8, 56);

    let source = include_bytes!("../../../../testing/fixtures/design/sketch-spatial-blur-modern.sketch");
    let doc = interop::import_sketch_report(source).unwrap().document;
    let page_id = doc.pages[0].id.clone();
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(&doc).unwrap()).unwrap();
    let render = |engine: &mut Engine, name: &str, scale: f64| {
        let frame = doc.nodes.values().find(|node| node.name == name).unwrap();
        let png = engine.render_region_png(&RegionRequest {
            page_id: page_id.clone(),
            bounds: ExportBounds {
                x: frame.transform.0[4], y: frame.transform.0[5],
                width: frame.width, height: frame.height,
            },
            scale,
            node_ids: Some(vec![frame.id.clone()]),
            raster_profile: Some(RasterProfile::Analytic),
            color_output: None,
        }).unwrap();
        image::load_from_memory(&png).unwrap().into_rgba8()
    };
    let row = |image: &image::RgbaImage, scale: f64| -> Vec<u8> {
        let y = (65. * scale) as u32;
        (90..=110).map(|x| image.get_pixel((x as f64 * scale) as u32, y).0[3]).collect()
    };
    // Frame export omits the group white fill, which is the diagnostic that
    // exposes edge alpha. Black-backdrop source-over of straight white equals
    // this alpha row. White-backdrop source-over stays white because RGB is 255.
    let r1 = render(&mut engine, "t0-r1-a0-box", 1.);
    assert_eq!(r1.get_pixel(97, 65).0, [255, 255, 255, 210]);
    assert_eq!(
        row(&r1, 1.),
        [0, 0, 0, 3, 21, 76, 155, 210, 228, 231, 232, 232, 232, 232, 232, 232, 232, 232, 232, 232, 232]
    );
    let r1_2x = render(&mut engine, "t0-r1-a0-box", 2.);
    assert_eq!(r1_2x.get_pixel(194, 130).0, [255, 255, 255, 191]);
    assert_eq!(
        row(&r1_2x, 2.),
        [0, 0, 0, 2, 13, 56, 130, 191, 216, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221]
    );
    // Radii 5/10/20 were measured on main 678fe3c0 before this kernel change.
    let unchanged = [
        ("t0-r5-a0-box", 1., [21, 29, 38, 49, 60, 72, 84, 96, 108, 118, 128, 136, 142, 147, 151, 153, 155, 156, 157, 157, 157]),
        ("t0-r5-a0-box", 2., [19, 27, 35, 45, 56, 67, 79, 90, 101, 112, 121, 129, 135, 140, 144, 147, 149, 151, 151, 152, 152]),
        ("t0-r10-a0-box", 1., [42, 47, 52, 58, 63, 68, 74, 79, 84, 90, 95, 100, 105, 109, 113, 117, 121, 124, 127, 129, 132]),
        ("t0-r10-a0-box", 2., [41, 45, 50, 55, 61, 66, 71, 76, 82, 87, 92, 97, 101, 106, 110, 114, 117, 121, 124, 126, 128]),
        ("t0-r20-a0-box", 1., [53, 56, 58, 61, 64, 66, 69, 71, 74, 76, 79, 81, 84, 86, 89, 91, 93, 95, 98, 100, 102]),
        ("t0-r20-a0-box", 2., [52, 55, 57, 60, 62, 65, 67, 70, 72, 75, 77, 80, 82, 85, 87, 89, 92, 94, 96, 98, 100]),
    ];
    for (name, scale, expected) in unchanged {
        let image = render(&mut engine, name, scale);
        assert_eq!(row(&image, scale), expected, "{name} {scale}x");
        assert_eq!(image.get_pixel(0, 0).0, [0, 0, 0, 0], "{name} keeps the clear corner");
    }
}

#[test]
fn sketch_motion_and_zoom_keep_the_other_modes_angle_or_origin_on_export() {
    for (kind, angle, center) in [(1, -45., [0.2, 0.75]), (2, -34., [0.8, 0.42])] {
        let mut source = source_blur(kind);
        source["motionAngle"] = json!(angle);
        source["center"] = json!({"x": center[0], "y": center[1]});
        let mut report = interop::import_sketch_report(&archive(&source)).unwrap();
        let effect = &mut report.document.nodes.get_mut("frosted").unwrap().effects[0];
        assert_eq!(effect.motion_angle, -angle);
        assert_eq!(effect.zoom_blur.map(|zoom| zoom.center).or(effect.motion_zoom_origin), Some(center));
        let expected_center = format!("{{{}, {}}}", center[0], center[1]);
        // Change supported data so the writer builds a new native dictionary.
        if let Some(zoom) = &mut effect.zoom_blur { zoom.amount = 12.; }
        else { effect.radius = 12.; }
        effect.visible = false;
        let native = exported_blur(&report.document);
        assert_eq!(native["isEnabled"], false);
        assert_eq!(native["motionAngle"], angle);
        assert_eq!(native["center"], expected_center);
        assert_eq!(native["radius"], 12.);
        let export = interop::export_sketch(&report.document).unwrap();
        let reopened = interop::import_sketch_report(&export).unwrap();
        assert_eq!(reopened.document.nodes["frosted"].effects[0], report.document.nodes["frosted"].effects[0]);
    }
}
