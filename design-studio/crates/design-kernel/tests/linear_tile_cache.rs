//! The interactive tier's linear-tile residency (Figma's tile reuse):
//! snapped integer cameras stitch byte-identically to the exact
//! `render_linear`; identical repeats re-raster nothing.

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
    let _ = warm;
    assert_eq!(
        engine.linear_tile_cache_len(),
        resident,
        "an identical repeat re-rasters nothing"
    );

    // Pan: only the newly exposed column joins residency.
    let mut pan = frame(true, 1.);
    pan.view.x = -512.;
    let panned = engine.render(&pan).expect("panned tier frame");
    let mut exact_pan = frame(false, 1.);
    exact_pan.view.x = -512.;
    assert_eq!(panned, engine.render(&exact_pan).expect("exact pan"));
    assert!(engine.linear_tile_cache_len() >= resident);
}
