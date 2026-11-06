use futureox_design_kernel::interop::{self, MAX_IMPORT_WARNINGS};
use serde_json::{Value, json};
use std::io::Write;

fn render(document: &futureox_design_kernel::scene::Document, width: u32, height: u32) -> Vec<u8> {
    let mut engine = futureox_design_kernel::Engine::new();
    engine
        .load_document(&serde_json::to_string(document).unwrap())
        .unwrap();
    engine
        .render(&futureox_design_kernel::RenderOptions {
            page_id: document.pages[0].id.clone(),
            width,
            height,
            view: futureox_design_kernel::View {
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
        })
        .unwrap()
}

fn archive(document: Value, pages: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in [
        (
            "meta.json".to_owned(),
            serde_json::to_vec(&json!({"appVersion":"test"})).unwrap(),
        ),
        (
            "document.json".to_owned(),
            serde_json::to_vec(&document).unwrap(),
        ),
    ]
    .into_iter()
    .chain(
        pages
            .iter()
            .map(|(id, bytes)| (format!("pages/{id}.json"), bytes.clone())),
    ) {
        zip.start_file(name, options).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    let mut image = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(1, 1, image::Rgba([255, 0, 0, 255]))
        .write_to(&mut image, image::ImageFormat::Png)
        .unwrap();
    zip.start_file("images/pixel.png", options).unwrap();
    zip.write_all(image.get_ref()).unwrap();
    zip.finish().unwrap().into_inner()
}

fn page(id: &str, layers: Vec<Value>) -> Vec<u8> {
    serde_json::to_vec(&json!({"_class":"page","do_objectID":id,"name":id,"layers":layers}))
        .unwrap()
}

#[test]
fn native_page_order_and_missing_parts_are_respected() {
    let bytes = archive(
        json!({"pages":[{"_ref":"pages/z"},{"_ref":"pages/a"}]}),
        &[("a", page("a", vec![])), ("z", page("z", vec![]))],
    );
    let report = interop::import_sketch_report(&bytes).unwrap();
    assert_eq!(
        report
            .document
            .pages
            .iter()
            .map(|p| p.id.as_str())
            .collect::<Vec<_>>(),
        vec!["z", "a"]
    );
    let missing = archive(json!({"pages":[{"_ref":"pages/missing"}]}), &[]);
    assert!(matches!(
        interop::import_sketch_report(&missing),
        Err(interop::Error::MissingPart(_))
    ));
    let malformed = archive(
        json!({"pages":[{"_ref":"pages/a"}]}),
        &[("a", b"broken".to_vec())],
    );
    assert!(matches!(
        interop::import_sketch_report(&malformed),
        Err(interop::Error::MalformedJson(_))
    ));
}

#[test]
fn export_settings_and_unembedded_fonts_are_admitted_with_explicit_substitution() {
    let text = json!({"_class":"text","do_objectID":"t","name":"Text",
        "frame":{"x":0,"y":0,"width":200,"height":40},
        "attributedString":{"string":"Hello","attributes":[{"location":0,"length":5,
            "attributes":{"MSAttributedStringFontAttribute":{"attributes":{"name":"UnembeddedFont","size":20}}}}]},
        "exportOptions":{"exportFormats":[{"fileFormat":"png","scale":2,"name":"@2x"}]}});
    let bytes = archive(
        json!({"pages":[{"_ref":"pages/p"}]}),
        &[("p", page("p", vec![text]))],
    );
    let source = interop::import_sketch(&bytes).unwrap();
    assert_eq!(
        source.nodes["t"].text_runs[0].font_id.as_deref(),
        Some("UnembeddedFont")
    );
    let report = interop::import_sketch_report(&bytes).unwrap();
    report.document.validate().unwrap();
    assert!(report.document.schema_version >= 8);
    let node = &report.document.nodes["t"];
    assert_eq!(node.text_runs[0].font_id.as_deref(), Some("default"));
    let metadata = &report
        .document
        .design_system
        .as_ref()
        .unwrap()
        .sketch_containers["nodeMetadata"];
    assert!(
        metadata["t"]["bindings"]["sketchSourceFonts"]
            .as_str()
            .unwrap()
            .contains("UnembeddedFont")
    );
    assert!(node.bindings.is_empty());
    assert!(report.warnings.iter().any(|w| w.contains("default font")));
    let encoded = interop::export_sketch(&report.document).unwrap();
    interop::import_sketch_report(&encoded)
        .unwrap()
        .document
        .validate()
        .unwrap();
}

#[test]
fn warnings_are_deduplicated_and_bounded_for_large_documents() {
    let layers = (0..100)
        .map(|i| {
            // Known fixed sizing is now modeled; exercise an unsupported
            // source extension to keep the warning aggregation contract.
            json!({"_class":"text","do_objectID":format!("h{i}"),"textBehaviour":99,
        "name":format!("Private layer {i}"),"frame":{"x":0,"y":0,"width":20,"height":20}})
        })
        .collect();
    let bytes = archive(
        json!({"pages":[{"_ref":"pages/p"}]}),
        &[("p", page("p", layers))],
    );
    let report = interop::import_sketch_report(&bytes).unwrap();
    assert!(report.warnings.len() <= MAX_IMPORT_WARNINGS);
    assert_eq!(
        report
            .warnings
            .iter()
            .filter(|w| w.contains("textbehaviour-fixed-size-not-modeled"))
            .count(),
        1
    );
    assert!(report.warnings.iter().all(|w| !w.contains("Private layer")));
    assert_eq!(report.document.nodes.len(), 100);
}

#[test]
fn editable_report_only_emits_canonical_kinds_and_refuses_unmapped_source_layers() {
    let rectangle = json!({"_class":"rectangle","do_objectID":"r",
        "frame":{"x":0,"y":0,"width":20,"height":20}});
    let bitmap = json!({"_class":"bitmap","do_objectID":"b",
        "image":{"_ref":"images/pixel.png"},
        "frame":{"x":20,"y":0,"width":20,"height":20}});
    let bytes = archive(
        json!({"pages":[{"_ref":"pages/p"}]}),
        &[("p", page("p", vec![rectangle, bitmap]))],
    );
    let report = interop::import_sketch_report(&bytes).unwrap();
    let canonical = [
        "slice",
        "frame",
        "section",
        "group",
        "rectangle",
        "ellipse",
        "polygon",
        "star",
        "line",
        "vector",
        "text",
    ];
    assert!(
        report
            .document
            .nodes
            .values()
            .all(|node| canonical.contains(&node.kind.as_str()))
    );
    assert_eq!(report.document.nodes["r"].kind, "rectangle");
    assert_eq!(report.document.nodes["b"].kind, "rectangle");
    let image = &report.document.nodes["b"].fills[0];
    assert_eq!(image.kind, "image");
    assert!(
        image
            .image
            .as_ref()
            .unwrap()
            .starts_with("data:image/png;base64,")
    );
    let exported = interop::export_sketch(&report.document).unwrap();
    let reopened = interop::import_sketch_report(&exported).unwrap();
    assert_eq!(reopened.document.nodes["r"].kind, "rectangle");
    assert_eq!(reopened.document.nodes.len(), 2);
    assert_eq!(reopened.document.nodes["b"].fills[0].image, image.image);
    let hotspot=archive(json!({"pages":[{"_ref":"pages/p"}]}),&[("p",page("p",vec![json!({"_class":"hotspot","do_objectID":"hotspot","frame":{"x":0,"y":0,"width":20,"height":20}})]))]);
    let admitted=interop::import_sketch_report(&hotspot).unwrap();
    assert_eq!(admitted.document.nodes["hotspot"].kind,"rectangle");
    assert!(admitted.document.nodes["hotspot"].fills.is_empty());
    for class in ["futureUnknownClass"] {
        let layer = json!({"_class":class,"do_objectID":"unsupported-layer",
            "frame":{"x":0,"y":0,"width":20,"height":20}});
        let bytes = archive(
            json!({"pages":[{"_ref":"pages/p"}]}),
            &[("p", page("p", vec![layer]))],
        );
        let error = interop::import_sketch_report(&bytes).err().unwrap();
        assert!(matches!(error, interop::Error::Unsupported(_)));
        assert!(error.to_string().contains("unsupported-layer"));
        assert!(error.to_string().contains("keep the original"));
    }
}

#[test]
fn degenerate_paths_keep_world_geometry_and_source_dimensions() {
    let path = json!({"_class":"shapePath","do_objectID":"line",
        "frame":{"x":12,"y":34,"width":100,"height":0}, "isClosed":false,
        "points":[{"point":"{0, 0}"},{"point":"{1, 0}"}]});
    let bytes = archive(
        json!({"pages":[{"_ref":"pages/p"}]}),
        &[("p", page("p", vec![path]))],
    );
    let source = interop::import_sketch(&bytes).unwrap();
    let report = interop::import_sketch_report(&bytes).unwrap();
    let before = &source.nodes["line"];
    let after = &report.document.nodes["line"];
    assert_eq!(after.kind, "vector");
    assert_eq!(after.transform, before.transform);
    let mut expected = before.network.as_deref().unwrap().clone();
    for vertex in &mut expected.vertices {
        vertex.x *= before.width;
        vertex.y *= before.height;
    }
    expected.edges.pop();
    assert_eq!(after.network.as_deref(), Some(&expected));
    assert_eq!(after.width, before.width);
    assert!(after.height > 0. && after.height <= 1e-6);
    let metadata = &report
        .document
        .design_system
        .as_ref()
        .unwrap()
        .sketch_containers["nodeMetadata"];
    let original: Value = serde_json::from_str(
        metadata["line"]["bindings"]["sketchSourceZeroExtent"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(original["height"], 0.);
    assert!(
        report
            .warnings
            .iter()
            .any(|w| w.contains("minimum selection box"))
    );
}

#[test]
fn native_rotation_flips_and_open_beziers_share_one_placement_rule() {
    let path = json!({"_class":"shapePath","do_objectID":"curve",
    "frame":{"x":10,"y":20,"width":100,"height":50},
    "rotation":90,"isFlippedHorizontal":true,"isClosed":false,
    "points":[
        {"point":"{0, 0}","curveMode":3,"hasCurveFrom":true,"curveFrom":"{0.25, 0.5}"},
        {"point":"{1, 1}","curveMode":3,"hasCurveTo":true,"curveTo":"{0.75, 0.5}"}
    ]});
    let bytes = archive(
        json!({"pages":[{"_ref":"pages/p"}]}),
        &[("p", page("p", vec![path]))],
    );
    let report = interop::import_sketch_report(&bytes).unwrap();
    let node = &report.document.nodes["curve"];
    let network = node.network.as_ref().unwrap();
    assert_eq!(network.vertices[1].x, 100.);
    assert_eq!(network.vertices[1].y, 50.);
    assert_eq!(network.edges.len(), 1);
    assert_eq!(
        network.edges[0].c1,
        Some(futureox_design_kernel::math::Point::new(25., 25.))
    );
    assert_eq!(
        network.edges[0].c2,
        Some(futureox_design_kernel::math::Point::new(75., 25.))
    );
    let origin = node
        .transform
        .point(futureox_design_kernel::math::Point::new(0., 0.));
    let center = node
        .transform
        .point(futureox_design_kernel::math::Point::new(50., 25.));
    assert!((origin.x - 35.).abs() < 1e-10 && (origin.y + 5.).abs() < 1e-10);
    assert!((center.x - 60.).abs() < 1e-10 && (center.y - 45.).abs() < 1e-10);
    let reimport =
        interop::import_sketch_report(&interop::export_sketch(&report.document).unwrap()).unwrap();
    let next = &reimport.document.nodes["curve"];
    assert_eq!(node.transform, next.transform);
    assert_eq!(node.network, next.network);
}

#[test]
fn transparent_gradient_stops_render_translucent_pixels_and_export_source_alpha() {
    for color_space in [0, 1] {
    let gradient = json!({"_class":"gradient","gradientType":0,"from":"{0, 0.5}","to":"{1, 0.5}",
    "elipseLength":0,"stops":[
        {"position":0,"color":{"red":0,"green":0,"blue":1,"alpha":0}},
        {"position":1,"color":{"red":0,"green":0,"blue":1,"alpha":0.5}}
    ]});
    let rectangle = json!({"_class":"rectangle","do_objectID":"fade",
        "frame":{"x":0,"y":0,"width":20,"height":10},
        "style":{"contextSettings":{"opacity":1},"fills":[{"isEnabled":true,"fillType":1,"gradient":gradient}]}});
    let bytes = archive(
        json!({"colorSpace":color_space,"pages":[{"_ref":"pages/p"}]}),
        &[("p", page("p", vec![rectangle]))],
    );
    let report = interop::import_sketch_report(&bytes).unwrap();
    assert_eq!(report.document.color_management.is_some(), color_space == 1);
    let paint = &report.document.nodes["fade"].fills[0];
    assert_eq!(paint.kind, "linear");
    assert!(paint.stops[0].color.ends_with("/ 0)"));
    assert!(paint.stops[1].color.ends_with("/ 0.5)"));
    let pixels = render(&report.document, 20, 10);
    let alpha = |x: usize| pixels[(5 * 20 + x) * 4 + 3];
    assert!(alpha(1) < alpha(10) && alpha(10) < alpha(18));
    assert!((60..=75).contains(&alpha(10)));
    assert!(alpha(18) <= 128);
    let exported = interop::export_sketch(&report.document).unwrap();
    let files = interop::read_zip_public(&exported).unwrap();
    let page: Value = serde_json::from_slice(
        files
            .iter()
            .find(|(name, _)| name.starts_with("pages/"))
            .unwrap()
            .1,
    )
    .unwrap();
    assert_eq!(page["layers"][0]["style"]["fills"][0]["gradient"], gradient);
    let reopened = interop::import_sketch_report(&exported).unwrap();
    assert_eq!(render(&reopened.document, 20, 10), pixels);
    let mut edited = report.document.clone();
    edited.nodes.get_mut("fade").unwrap().fills[0].stops[1].color =
        "color(srgb 0 0 1 / 0.25)".into();
    let edited_export = interop::export_sketch(&edited).unwrap();
    let edited_reopened = interop::import_sketch_report(&edited_export).unwrap();
    assert!(
        edited_reopened.document.nodes["fade"].fills[0].stops[1]
            .color
            .ends_with("/ 0.25)")
    );
    }
}

fn native_rectangle_path(id: &str, x: f64, y: f64, width: f64, height: f64) -> Value {
    json!({"_class":"shapePath","do_objectID":id,"booleanOperation":1,"isClosed":true,
        "frame":{"x":x,"y":y,"width":width,"height":height},
        "points":[{"point":"{0,0}"},{"point":"{1,0}"},{"point":"{1,1}"},{"point":"{0,1}"}],
        "style":{"contextSettings":{"opacity":1},"fills":[{"isEnabled":true,"fillType":0,"color":{"red":0.77,"green":0.77,"blue":0.77,"alpha":1}}]}})
}

#[test]
fn three_native_subtract_rings_use_parent_paint_editable_operands_and_keep_source_operations() {
    let groups = (0..3).map(|index| json!({"_class":"shapeGroup","do_objectID":format!("ring{index}"),
        "booleanOperation":-1,"frame":{"x":index * 30,"y":0,"width":20,"height":20},
        "style":{"contextSettings":{"opacity":1},"fills":[{"isEnabled":true,"fillType":0,"color":{
            "red":if index == 0 {1} else {0},"green":if index == 1 {1} else {0},"blue":if index == 2 {1} else {0},"alpha":1}}]},
        "layers":[native_rectangle_path(&format!("outer{index}"),0.,0.,20.,20.),
            native_rectangle_path(&format!("inner{index}"),5.,5.,10.,10.)]})).collect();
    let bytes = archive(
        json!({"pages":[{"_ref":"pages/p"}]}),
        &[("p", page("p", groups))],
    );
    let report = interop::import_sketch_report(&bytes).unwrap();
    for index in 0..3 {
        let group = &report.document.nodes[&format!("ring{index}")];
        assert_eq!(group.kind, "vector");
        assert_eq!(
            group.boolean_operation,
            Some(futureox_design_kernel::boolean::Operation::Subtract)
        );
        assert_eq!(
            group.children,
            vec![format!("outer{index}"), format!("inner{index}")]
        );
        assert!(
            report.document.nodes[&format!("outer{index}")]
                .boolean_operation
                .is_none()
        );
    }
    let pixels = render(&report.document, 80, 20);
    for index in 0..3 {
        let at = |x: usize, y: usize| {
            &pixels[(y * 80 + index * 30 + x) * 4..(y * 80 + index * 30 + x) * 4 + 4]
        };
        assert_eq!(at(10, 10)[3], 0, "the inner operand cuts a hole");
        assert_eq!(
            at(2, 10)[index],
            255,
            "the parent supplies its colored paint"
        );
        assert_eq!(at(2, 10)[3], 255);
    }
    let exported = interop::export_sketch(&report.document).unwrap();
    let files = interop::read_zip_public(&exported).unwrap();
    let native: Value = serde_json::from_slice(
        files
            .iter()
            .find(|(name, _)| name.starts_with("pages/"))
            .unwrap()
            .1,
    )
    .unwrap();
    for group in native["layers"].as_array().unwrap() {
        assert_eq!(group["_class"], "shapeGroup");
        assert_eq!(group["booleanOperation"], -1);
        assert!(
            group["layers"]
                .as_array()
                .unwrap()
                .iter()
                .all(|child| child["booleanOperation"] == 1)
        );
    }
    let reopened = interop::import_sketch_report(&exported).unwrap();
    assert_eq!(render(&reopened.document, 80, 20), pixels);
}

#[test]
fn mixed_native_boolean_operations_follow_source_order_and_restore_original_operands() {
    let mut last = native_rectangle_path("last", 2., 2., 5., 5.);
    last["booleanOperation"] = json!(0);
    let group = json!({"_class":"shapeGroup","do_objectID":"mixed","booleanOperation":-1,
        "frame":{"x":0,"y":0,"width":20,"height":20},"style":{"fills":[{"isEnabled":true,"fillType":0,"color":{"red":1,"green":0,"blue":0,"alpha":1}}]},
        "layers":[native_rectangle_path("outer",0.,0.,20.,20.),native_rectangle_path("inner",5.,5.,10.,10.),last]});
    let bytes = archive(
        json!({"pages":[{"_ref":"pages/p"}]}),
        &[("p", page("p", vec![group]))],
    );
    let doc=interop::import_sketch_report(&bytes).unwrap().document;
    let pixels=render(&doc,20,20);
    assert_eq!(pixels[(10*20+10)*4+3],0,"subtracted centre");
    assert_eq!(pixels[(6*20+6)*4+3],255,"last operand adds its corner back");
    let exported=interop::export_sketch(&doc).unwrap();
    let files=interop::read_zip_public(&exported).unwrap();
    let page:Value=serde_json::from_slice(&files.iter().find(|(name,_)|name.starts_with("pages/")).unwrap().1).unwrap();
    let ops=page["layers"][0]["layers"].as_array().unwrap();
    assert_eq!(ops.len(),3);
    assert_eq!(ops.iter().map(|n|n["booleanOperation"].as_i64().unwrap()).collect::<Vec<_>>(),vec![1,1,0]);
    assert_eq!(render(&interop::import_sketch_report(&exported).unwrap().document,20,20),pixels);
}

#[test]
fn layer_and_paint_opacity_apply_once_and_survive_compatibility_round_trip() {
    for paint_opacity in [0.5, 1.] {
        let rectangle = json!({"_class":"rectangle","do_objectID":"opacity",
            "frame":{"x":0,"y":0,"width":10,"height":10},
            "style":{"contextSettings":{"opacity":0.48,"blendMode":0},
                "fills":[{"isEnabled":true,"fillType":0,
                    "contextSettings":{"opacity":paint_opacity,"blendMode":0},
                    "color":{"red":1,"green":0,"blue":0,"alpha":1}}]}});
        let bytes = archive(
            json!({"pages":[{"_ref":"pages/p"}]}),
            &[("p", page("p", vec![rectangle]))],
        );
        let report = interop::import_sketch_report(&bytes).unwrap();
        let node = &report.document.nodes["opacity"];
        assert_eq!(node.opacity, 0.48);
        assert_eq!(node.fills[0].opacity, paint_opacity);
        let pixels = render(&report.document, 10, 10);
        let alpha = pixels[(5 * 10 + 5) * 4 + 3] as i32;
        let expected = (255. * 0.48 * paint_opacity).round() as i32;
        assert!(
            (alpha - expected).abs() <= 1,
            "layer .48 × paint {paint_opacity}: {alpha}, expected {expected}"
        );
        let exported = interop::export_sketch(&report.document).unwrap();
        let reopened = interop::import_sketch_report(&exported).unwrap();
        assert_eq!(reopened.document.nodes["opacity"].opacity, 0.48);
        assert_eq!(
            reopened.document.nodes["opacity"].fills[0].opacity,
            paint_opacity
        );
        assert_eq!(render(&reopened.document, 10, 10), pixels);
    }
}

#[test]
fn native_text_behaviour_uses_shared_sizing_and_retains_source_text_metadata() {
    use futureox_design_kernel::layout::SizeMode;
    for (mode, width, height, wrap) in [
        (0, SizeMode::Hug, SizeMode::Hug, false),
        (1, SizeMode::Fixed, SizeMode::Hug, true),
        (2, SizeMode::Fixed, SizeMode::Fixed, true),
    ] {
        let text = json!({"_class":"text","do_objectID":"text","name":"Text sizing",
            "frame":{"x":30,"y":40,"width":200,"height":70},"textBehaviour":mode,
            "lineSpacingBehaviour":1,
            "attributedString":{"_class":"attributedString","string":"中文 AB","attributes":[{
                "_class":"stringAttribute","location":0,"length":5,"attributes":{
                    "MSAttributedStringFontAttribute":{"_class":"fontDescriptor","attributes":{"name":"Source Sans","size":20}},
                    "MSAttributedStringColorAttribute":{"_class":"color","red":1,"green":1,"blue":1,"alpha":1},
                    "textStyleVerticalAlignmentKey":1,
                    "paragraphStyle":{"_class":"paragraphStyle","alignment":2}
                }}]}});
        let bytes = archive(json!({"pages":[{"_ref":"pages/p"}]}), &[("p", page("p", vec![text]))]);
        let report = interop::import_sketch_report(&bytes).unwrap();
        let node = &report.document.nodes["text"];
        let sizing = node.sizing.as_ref().expect("TextBehaviour must admit shared text sizing");
        assert_eq!((sizing.width, sizing.height), (width, height));
        assert_eq!(node.text_style.as_ref().unwrap().wrap, wrap);
        assert_eq!((node.width, node.height), (200., 70.), "The adapter preserves the source frame before shared font measurement");
        assert!(!report.warnings.iter().any(|warning| warning.contains("textbehaviour-fixed-size-not-modeled")));
        let exported = interop::export_sketch(&report.document).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(exported)).unwrap();
        let mut json = String::new();
        use std::io::Read;
        let name = zip.file_names().filter_map(Result::ok).find(|name| name.starts_with("pages/") && name.ends_with(".json")).unwrap().into_owned();
        zip.by_name(&name).unwrap().read_to_string(&mut json).unwrap();
        let value: Value = serde_json::from_str(&json).unwrap();
        let layer = &value["layers"][0];
        assert_eq!(layer["textBehaviour"], mode);
        assert_eq!(layer["lineSpacingBehaviour"], 1);
        assert_eq!(layer["attributedString"]["attributes"][0]["attributes"]["textStyleVerticalAlignmentKey"], 1);

        // JS JSON.stringify turns integral doubles into JSON integers. The
        // opaque source signature must still compare to typed Rust fields.
        fn js_numbers(value: &mut Value) {
            match value {
                Value::Number(number) => {
                    if number.is_f64() && let Some(n) = number.as_f64()
                        && n.fract() == 0. && n.abs() <= 9_007_199_254_740_991.
                    { *value = json!(n as i64); }
                }
                Value::Array(values) => values.iter_mut().for_each(js_numbers),
                Value::Object(values) => values.values_mut().for_each(js_numbers),
                _ => {}
            }
        }
        let mut javascript = serde_json::to_value(&report.document).unwrap();
        js_numbers(&mut javascript);
        let mut measured: futureox_design_kernel::scene::Document = serde_json::from_value(javascript).unwrap();
        let mut fonts = futureox_design_kernel::font::Fonts::new();
        fonts.load(&std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf")).unwrap()).unwrap();
        futureox_design_kernel::layout::resolve(&mut measured, &fonts).unwrap();
        let exported = interop::export_sketch(&measured).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(exported)).unwrap();
        let name = zip.file_names().filter_map(Result::ok).find(|name| name.starts_with("pages/") && name.ends_with(".json")).unwrap().into_owned();
        let mut page_json = String::new();
        zip.by_name(&name).unwrap().read_to_string(&mut page_json).unwrap();
        let page: Value = serde_json::from_str(&page_json).unwrap();
        assert_eq!(page["layers"][0]["frame"], json!({"x":30,"y":40,"width":200,"height":70}));
        // A real move is an authored edit even when all text fields match.
        measured.nodes.get_mut("text").unwrap().transform.0[4] += 0.125;
        let moved = interop::export_sketch(&measured).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(moved)).unwrap();
        let mut page_json = String::new();
        zip.by_name(&name).unwrap().read_to_string(&mut page_json).unwrap();
        let page: Value = serde_json::from_str(&page_json).unwrap();
        assert_ne!(page["layers"][0]["frame"]["x"], 30);
    }
}

#[test]
fn import_any_reports_archive_limits_instead_of_marker_miss() {
    // Archive admission scales with the process memory budget; pin a small
    // one so this binary deterministically refuses the oversized entry.
    let _ = futureox_design_kernel::capacity::configure(64 * 1024 * 1024);
    let oversized = vec![b' '; 17 * 1024 * 1024];
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, body) in [
        ("meta.json", &br#"{"app":"com.bohemiancoding.sketch3","appVersion":"74.1"}"#[..]),
        ("document.json", &br#"{"_class":"document","pages":[]}"#[..]),
        ("pages/toolarge.json", oversized.as_slice()),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(body).unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    match interop::import_any(&bytes) {
        Err(interop::Error::Unsupported(message)) => {
            assert!(message.contains("archive resource limit"), "{message}");
        }
        other => panic!("expected archive resource limit, got {other:?}"),
    }
    // A non-zip payload still falls through to the generic marker message.
    match interop::import_any(b"not a design file") {
        Err(interop::Error::NotAZip(message)) => {
            assert!(message.contains("markers"), "{message}");
        }
        other => panic!("expected marker miss, got {other:?}"),
    }
}
