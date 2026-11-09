
use futureox_design_kernel::{Engine, RenderOptions, View};

fn doc() -> String {
    serde_json::json!({
        "schemaVersion": 3,
        "colorManagement": {"documentSpace": "srgb", "referenceWhiteNits": 203, "peakLuminanceNits": 1000},
        "id": "lt", "name": "lt",
        "pages": [{"id": "p", "name": "p", "children": ["r"], "background": "#ffffff"}],
        "nodes": {"r": {
            "id": "r", "kind": "rectangle", "transform": [1, 0, 0, 1, 16., 16.],
            "width": 700., "height": 700.,
            "fills": [{"kind": "solid", "color": "#3366aa"}]
        }}
    })
    .to_string()
}

fn frame(interactive: bool, zoom: f64) -> RenderOptions {
    RenderOptions {
        page_id: "p".into(),
        width: 1024,
        height: 768,
        view: View { x: 0., y: 0., zoom },
        transparent: false,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: futureox_design_kernel::fidelity::RasterProfile::Figma,
        interactive_effects: interactive,
        checkerboard: false,
    }
}

#[test]
fn snapped_interactive_stitch_is_byte_identical_and_reuses_tiles() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    // 自适应:小场景精确渲染能装下 → 直接全质量,不触碰降级缓存。
    let exact = engine.render(&frame(false, 1.)).expect("exact");
    let adaptive = engine.render(&frame(true, 1.)).expect("adaptive tier frame");
    assert_eq!(adaptive, exact, "quality-first: coherent render when it fits");
    assert_eq!(engine.linear_tile_cache_len(), 0);

    // 复用路径(压力降级后的直连入口):吸附档像素与精确 render_linear 逐位一致。
    let cold = engine.render_linear_reused(&frame(true, 1.)).expect("cold reused frame");
    // 参照必须同为单平面:tier 旗标直呼 render_linear(不经 render() 的
    // 自适应路由),与复用路径逐瓦片同数学。
    let exact_px = engine.render_linear(&frame(true, 1.)).expect("single-plane exact pixels");
    assert_eq!(cold, exact_px, "snapped integer camera stitches byte-identically");
    let resident = engine.linear_tile_cache_len();
    assert!(resident > 0, "the cold frame populated residency");

    let warm = engine.render_linear_reused(&frame(true, 1.)).expect("warm reused frame");
    assert_eq!(warm, cold, "warm reuse preserves every pixel");
    assert_eq!(
        engine.linear_tile_cache_len(),
        resident,
        "an identical repeat re-rasters nothing"
    );

    // Pan: only the newly exposed column joins residency.
    let mut pan = frame(true, 1.);
    pan.view.x = -512.;
    let panned = engine.render_linear_reused(&pan).expect("panned reused frame");
    assert_eq!(panned, engine.render_linear(&pan).expect("exact pan"));
    assert!(engine.linear_tile_cache_len() >= resident);
}

#[test]
fn left_and_top_clipped_tiles_match_exact_integer_camera_pixels() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).unwrap();
    let mut options = frame(true, 1.);
    options.width = 96;
    options.height = 48;
    options.raster_profile = futureox_design_kernel::fidelity::RasterProfile::Analytic;
    for (x, y) in [(-17., -7.), (-511., -13.), (17., 7.)] {
        options.view.x = x;
        options.view.y = y;
        let reused = engine.render_linear_reused(&options).unwrap();
        assert_eq!(reused, engine.render_linear(&options).unwrap(), "camera {x},{y}");
    }
}

#[test]
fn fractional_cameras_keep_exact_translucent_coverage_without_tile_resampling() {
    let mut document: serde_json::Value = serde_json::from_str(&doc()).unwrap();
    document["nodes"]["r"]["width"] = serde_json::json!(31.25);
    document["nodes"]["r"]["opacity"] = serde_json::json!(0.5);
    let mut engine = Engine::new();
    engine.load_document(&document.to_string()).unwrap();
    let mut options = frame(true, 1.);
    options.width = 64;
    options.height = 48;
    options.transparent = true;
    options.raster_profile = futureox_design_kernel::fidelity::RasterProfile::Analytic;
    for (zoom, x, y) in [(1., 0.375, 0.25), (1.3, 0., 0.), (0.75, -0.5, 0.125)] {
        options.view = View { x, y, zoom };
        let reused = engine.render_linear_reused(&options).unwrap();
        assert_eq!(reused, engine.render_linear(&options).unwrap(), "camera {zoom},{x},{y}");
        assert!(reused.iter().any(|p| p.0[3] > 0. && p.0[3] < 1.));
        assert!(reused.iter().all(|p| p.0[..3].iter().all(|v| *v <= p.0[3])));
    }
    assert_eq!(engine.linear_tile_cache_len(), 0, "fractional cameras rasterise exact coverage");
}

#[test]
fn switching_pages_does_not_reuse_another_pages_pixels() {
    let mut document: serde_json::Value = serde_json::from_str(&doc()).unwrap();
    document["pages"].as_array_mut().unwrap().push(serde_json::json!({
        "id": "other", "name": "other", "children": [], "background": "#000000"
    }));
    let mut engine = Engine::new();
    engine.load_document(&document.to_string()).unwrap();
    let mut options = frame(true, 1.);
    options.width = 32;
    options.height = 32;
    options.raster_profile = futureox_design_kernel::fidelity::RasterProfile::Analytic;
    let first = engine.render_linear_reused(&options).unwrap();
    options.page_id = "other".into();
    let other = engine.render_linear_reused(&options).unwrap();
    assert_ne!(first, other);
    assert_eq!(other, engine.render_linear(&options).unwrap());
    options.page_id = "p".into();
    assert_eq!(first, engine.render_linear_reused(&options).unwrap());
}
