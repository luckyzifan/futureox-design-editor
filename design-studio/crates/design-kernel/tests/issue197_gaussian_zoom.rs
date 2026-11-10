//! Issue 197: real 117.sketch at device zoom 64 (3200% × DPR 2).
//! The artboard image keeps its authored Gaussian radius. The effective pixel
//! sigma is above the whole-surface cap and uses the existing regional plan.
use futureox_design_kernel::{interop, color::ColorSettings, effects, Engine, RenderOptions, math::Rect};
use serde_json::json;

fn sketch_document() -> futureox_design_kernel::scene::Document {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../testing/fixtures/user-regression-20261109/117.sketch"
    );
    let bytes = std::fs::read(path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    let report = interop::import_sketch_report(&bytes).expect("import 117.sketch");
    assert!(report.document.color_management.is_none(), "encoded sRGB sketch stays unmanaged");
    report.document
}

fn open_engine(doc: &futureox_design_kernel::scene::Document) -> Engine {
    let font = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../frontend/design-client/public/fonts/dejavu/DejaVuSans.ttf"
    ))
    .expect("font");
    let mut engine = Engine::new();
    engine.load_font(&font).unwrap();
    engine.load_document(&serde_json::to_string(doc).unwrap()).unwrap();
    engine
}

fn ellipse_camera(zoom: f64, side: u32) -> (f64, f64) {
    // World origin of 椭圆 11, from the imported parent chain.
    let (x, y) = (-295.302_f64, 1229.984_f64);
    let margin = f64::from(side) / 4.;
    (margin - zoom * x, margin - zoom * y)
}

#[test]
fn real_117_device_3200_uses_regional_gaussian_without_raising_the_cap() {
    let doc = sketch_document();
    let image = doc.nodes.values().find(|node| node.name == "Image").expect("image");
    let authored = image.effects.iter().find(|effect| effect.visible && effect.kind == "gaussian-blur").expect("authored gaussian");
    assert_eq!(authored.radius.to_bits(), 9.564871788024902_f64.to_bits());
    let sigma = authored.radius * 64.;
    assert!((sigma - 612.1517944335938).abs() < 1e-9, "effective pixel sigma {sigma}");
    assert!(effects::gaussian_box_radii(sigma).is_err(), "whole-surface cap stays 512");
    assert!(effects::gaussian_box_radii(authored.radius * 32.).is_ok(), "100% device zoom 32 still fits");

    let mut engine = open_engine(&doc);
    let page = doc.pages[0].id.clone();
    let (x, y) = ellipse_camera(64., 514);
    let options: RenderOptions = serde_json::from_value(json!({
        "pageId": page,
        "width": 514,
        "height": 514,
        "view": {"x": x, "y": y, "zoom": 64.0},
        "rasterProfile": "analytic"
    }))
    .unwrap();
    let scene = engine.compile_gpu_region(&options, Rect::new(0, 0, 514, 514), None)
        .expect("514 tile at device zoom 64");
    assert!(u64::from(scene.extent.w) * u64::from(scene.extent.h) <= 16_777_216);
    let planned = scene.nodes.values().find(|node| node.gaussian_region.is_some()).expect("regional plan");
    let effect = planned.effects.iter().find(|effect| effect.kind == "gaussian-blur").expect("effect retained");
    assert_eq!(effect.radius.to_bits(), authored.radius.to_bits());
    let plan = planned.gaussian_region.as_ref().unwrap();
    assert!(plan.factor.is_none(), "full output density");
    assert!(plan.radii.iter().any(|radius| *radius > 512), "regional radii {:?}", plan.radii);
    assert!(plan.radii.iter().all(|radius| *radius <= 1024));
    let effective = effect.radius * planned.matrix.max_scale();
    assert_eq!(effective.to_bits(), sigma.to_bits());

    let (x, y) = ellipse_camera(32., 514);
    let mild: RenderOptions = serde_json::from_value(json!({
        "pageId": page,
        "width": 514,
        "height": 514,
        "view": {"x": x, "y": y, "zoom": 32.0},
        "rasterProfile": "analytic"
    }))
    .unwrap();
    let mild_scene = engine.compile_gpu_region(&mild, Rect::new(0, 0, 514, 514), None).unwrap();
    assert!(mild_scene.nodes.values().all(|node| node.gaussian_region.is_none()));

    let mut managed = doc.clone();
    managed.color_management = Some(ColorSettings::default());
    let mut managed_engine = open_engine(&managed);
    let request = json!({
        "pageId": page,
        "width": 514,
        "height": 514,
        "view": {"x": x, "y": y, "zoom": 64.0},
        "rasterProfile": "figmaSubpixel",
        "gpuViewport": {"x": 0, "y": 0, "w": 514, "h": 514}
    });
    // The (x, y) above is the zoom-32 camera. Rebuild the zoom-64 camera.
    let (x, y) = ellipse_camera(64., 514);
    let mut request = request;
    request["view"]["x"] = json!(x);
    request["view"]["y"] = json!(y);
    assert!(managed_engine.compile_gpu_request(&request.to_string()).is_err(), "managed admission stays opt-in");
    request["gpuGaussianRegions"] = json!(true);
    let managed_scene = managed_engine.compile_gpu_request(&request.to_string()).unwrap();
    assert!(managed_scene.nodes.values().any(|node| node.gaussian_region.is_some()));
}
