use futureox_design_kernel::{Engine, RenderOptions, View, fidelity::RasterProfile, interop};
use serde_json::{Value, json};
use std::io::Write;

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
    let mut layers = Vec::new();
    for y in 0..6 {
        for x in 0..8 {
            layers.push(rectangle(&format!("cell-{x}-{y}"), [x * 8, y * 8, 8, 8],
                ((x + y) % 2) as f64, 1.));
        }
    }
    let mut frosted = rectangle("frosted", [16, 8, 32, 32], 1., 0.1);
    frosted["style"]["blur"] = blur.clone();
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
    // Shared background filtering remains a tent kernel, so this certifies
    // backdrop semantics; native Gaussian blur strength is a separate gap.
    assert!(background_contrast + 40 < gaussian_contrast, "background blur reduces backdrop contrast");
    assert!(red(&background, 20, 20) > red(&gaussian, 20, 20));
    assert!(red(&background, 24, 20) < red(&gaussian, 24, 20));
    assert_eq!(&background[(24 * 64 + 8) * 4..(24 * 64 + 8) * 4 + 4], &[0, 0, 0, 255], "the effect stays inside its layer shape");
    assert_ne!(background, gaussian);
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
