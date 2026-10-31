use futureox_design_kernel::{Engine, RenderOptions, View, fidelity::RasterProfile, interop, math::Point};
use serde_json::{Value, json};
use std::io::Write;

fn archive(gradient: &Value, size: [f64; 2]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let files = [
        ("meta.json", json!({"appVersion":"test"})),
        ("document.json", json!({"colorSpace":1,"pages":[{"_ref":"pages/p"}]})),
        ("pages/p.json", json!({"_class":"page","do_objectID":"p","name":"p","layers":[{
            "_class":"rectangle","do_objectID":"r","name":"radial",
            "frame":{"x":0,"y":0,"width":size[0],"height":size[1]},
            "style":{"contextSettings":{"opacity":1},"fills":[{
                "isEnabled":true,"fillType":1,"gradient":gradient
            }]}
        }]})),
    ];
    for (name, value) in files {
        zip.start_file(name, options).unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn gradient(from: [f64; 2], to: [f64; 2], ellipse: f64) -> Value {
    json!({"_class":"gradient","gradientType":1,
        "from":format!("{{{}, {}}}",from[0],from[1]),
        "to":format!("{{{}, {}}}",to[0],to[1]),
        "elipseLength":ellipse,"sourceExtension":{"keep":"verbatim"},
        "stops":[
            {"position":0,"color":{"red":1,"green":0,"blue":0,"alpha":1}},
            {"position":1,"color":{"red":1,"green":0,"blue":0,"alpha":0}}
        ]})
}

fn close(point: Point, expected: Point) {
    assert!((point.x - expected.x).abs() < 1e-10, "x: {} != {}", point.x, expected.x);
    assert!((point.y - expected.y).abs() < 1e-10, "y: {} != {}", point.y, expected.y);
}

fn render(document: &futureox_design_kernel::scene::Document) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(document).unwrap()).unwrap();
    engine.render(&RenderOptions {
        page_id: document.pages[0].id.clone(), width: 160, height: 120,
        view: View { x: 0., y: 0., zoom: 1. }, transparent: true, grid: false,
        pixel_preview: None, animation: None, raster_profile: RasterProfile::Analytic, interactive_effects: false,
        checkerboard: false,
    }).unwrap()
}

#[test]
fn radial_from_is_the_center_and_to_is_a_radius_endpoint_on_non_square_layers() {
    // Coordinates independently checked using Sketch 2025.1.3 (203472)
    // exports of 160×120 circle/flat/tall/rotated native gradient fixtures.
    for (from, to, ellipse) in [
        ([0.5, 0.5], [0.75, 0.5], 1.),
        ([0.5, 0.5], [0.75, 0.5], 0.5),
        ([0.5, 0.5], [0.75, 0.5], 2.),
        ([0.4, 0.45], [0.6, 0.65], 1.7),
        ([0.5, 0.5], [0.5, 0.913462], 1.474072217941284),
    ] {
        let size = [160., 120.];
        let report = interop::import_sketch_report(&archive(&gradient(from, to, ellipse), size)).unwrap();
        let transform = report.document.nodes["r"].fills[0].transform.unwrap();
        close(transform.point(Point::new(0.5, 0.5)), Point::new(from[0], from[1]));
        close(transform.point(Point::new(1., 0.5)), Point::new(to[0], to[1]));
        let cross = transform.point(Point::new(0.5, 1.));
        let primary = Point::new((to[0] - from[0]) * size[0], (to[1] - from[1]) * size[1]);
        let perpendicular = Point::new((cross.x - from[0]) * size[0], (cross.y - from[1]) * size[1]);
        assert!((primary.x * perpendicular.x + primary.y * perpendicular.y).abs() < 1e-8);
        assert!((perpendicular.length() / primary.length() - ellipse).abs() < 1e-10);
        assert!(!report.warnings.iter().any(|warning| warning.contains("radial-gradient-ellipse-transform-approximate")));
    }
}

#[test]
fn radial_alpha_pixels_keep_the_native_center_radius_and_ellipse_aspect() {
    let alpha = |pixels: &[u8], x: usize, y: usize| pixels[(y * 160 + x) * 4 + 3];
    let render_ellipse = |ratio| render(&interop::import_sketch_report(
        &archive(&gradient([0.5, 0.5], [0.75, 0.5], ratio), [160., 120.]),
    ).unwrap().document);
    let circle = render_ellipse(1.);
    assert!(alpha(&circle, 80, 60) >= 248, "the source center remains opaque");
    assert_eq!(alpha(&circle, 120, 60), 0, "to is the outer radius");
    assert_eq!(alpha(&circle, 80, 100), 0, "a circle stays circular in layer pixels");
    assert!((120..=130).contains(&alpha(&circle, 100, 60)));
    assert!((alpha(&circle, 100, 60) as i16 - alpha(&circle, 80, 80) as i16).abs() <= 1);

    let flat = render_ellipse(0.5);
    assert_eq!(alpha(&flat, 80, 80), 0, "the perpendicular radius is halved");
    assert!((115..=130).contains(&alpha(&flat, 80, 70)));
    let tall = render_ellipse(2.);
    assert!((120..=130).contains(&alpha(&tall, 80, 100)), "the perpendicular radius is doubled");
    assert!(alpha(&tall, 80, 80) > alpha(&circle, 80, 80));
}

#[test]
fn unchanged_radial_source_dictionary_and_cpu_pixels_survive_compatibility_export() {
    let source = gradient([0.4, 0.45], [0.6, 0.65], 1.7);
    let report = interop::import_sketch_report(&archive(&source, [160., 120.])).unwrap();
    let before = render(&report.document);
    let exported = interop::export_sketch(&report.document).unwrap();
    let files = interop::read_zip_public(&exported).unwrap();
    let page: Value = serde_json::from_slice(files.iter()
        .find(|(name, _)| name.starts_with("pages/")).unwrap().1).unwrap();
    assert_eq!(page["layers"][0]["style"]["fills"][0]["gradient"], source);
    let reopened = interop::import_sketch_report(&exported).unwrap();
    assert_eq!(reopened.document.nodes["r"].fills[0], report.document.nodes["r"].fills[0]);
    assert_eq!(render(&reopened.document), before);
}

#[test]
fn edited_radial_export_uses_center_radius_and_physical_ellipse_axes() {
    let source = gradient([0.5, 0.5], [0.75, 0.5], 1.);
    let mut report = interop::import_sketch_report(&archive(&source, [160., 120.])).unwrap();
    let transform = futureox_design_kernel::math::Transform([0.5, 0., 0., 1. / 3., 0.15, 0.4 - 1. / 6.]);
    report.document.nodes.get_mut("r").unwrap().fills[0].transform = Some(transform);
    let before = render(&report.document);
    let exported = interop::export_sketch(&report.document).unwrap();
    let reopened = interop::import_sketch_report(&exported).unwrap();
    let back = reopened.document.nodes["r"].fills[0].transform.unwrap();
    close(back.point(Point::new(0.5, 0.5)), Point::new(0.4, 0.4));
    close(back.point(Point::new(1., 0.5)), Point::new(0.65, 0.4));
    close(back.point(Point::new(0.5, 1.)), Point::new(0.4, 0.4 + 1. / 6.));
    assert_eq!(render(&reopened.document), before);
}

#[test]
fn untransformed_radial_export_preserves_the_unit_disk_and_reports_skew_approximation() {
    let mut report = interop::import_sketch_report(&archive(
        &gradient([0.5, 0.5], [0.75, 0.5], 1.), [160., 120.],
    )).unwrap();
    report.document.nodes.get_mut("r").unwrap().fills[0].transform = None;
    let before = render(&report.document);
    let exported = interop::export_sketch(&report.document).unwrap();
    let reopened = interop::import_sketch_report(&exported).unwrap();
    let transform = reopened.document.nodes["r"].fills[0].transform.unwrap();
    close(transform.point(Point::new(0.5, 0.5)), Point::new(0.5, 0.5));
    close(transform.point(Point::new(1., 0.5)), Point::new(1., 0.5));
    close(transform.point(Point::new(0.5, 1.)), Point::new(0.5, 1.));
    assert_eq!(render(&reopened.document), before);

    report.document.nodes.get_mut("r").unwrap().fills[0].transform = Some(
        futureox_design_kernel::math::Transform([1., 0., 0.3, 1., 0., 0.]),
    );
    let skewed = interop::import_sketch_report(&interop::export_sketch(&report.document).unwrap()).unwrap();
    assert!(skewed.warnings.iter().any(|warning| warning.contains("fill-radial-skew-approximated")));
}
