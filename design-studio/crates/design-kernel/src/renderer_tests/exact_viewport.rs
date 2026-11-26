use super::*;
use serde_json::json;

fn analytic(x: f64, width: u32, height: u32) -> RenderOptions {
    RenderOptions {
        page_id: "p".into(),
        width,
        height,
        view: View { x, y: 0., zoom: 1. },
        transparent: false,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: crate::fidelity::RasterProfile::Analytic,
        interactive_effects: false,
        checkerboard: false,
    }
}

#[test]
fn exact_viewport_cache_keeps_two_recent_cameras_within_the_byte_budget() {
    let mut engine = Engine::new();
    let frame = vec![7u8; 2048 * 1024 * 4];
    for x in [0., -1., -2.] {
        engine.remember_exact_viewport(&analytic(x, 2048, 1024), &frame);
    }
    assert_eq!(engine.exact_viewports.len(), 2);
    assert_eq!(engine.exact_viewport_bytes(), 2 * frame.len());
    assert!(engine.exact_viewport_bytes() <= EXACT_VIEWPORT_BYTES);
    assert!(engine.recall_exact_viewport(&analytic(0., 2048, 1024)).is_none());
    assert!(engine.recall_exact_viewport(&analytic(-1., 2048, 1024)).is_some());
    assert!(engine.recall_exact_viewport(&analytic(-2., 2048, 1024)).is_some());
}

#[test]
fn exact_viewport_cache_evicts_before_it_can_exceed_the_byte_budget() {
    let mut engine = Engine::new();
    let large = vec![1u8; 4096 * 1536 * 4];
    engine.remember_exact_viewport(&analytic(0., 4096, 1536), &large);
    let small = vec![2u8; 3072 * 1024 * 4];
    engine.remember_exact_viewport(&analytic(-1., 3072, 1024), &small);
    assert_eq!(engine.exact_viewports.len(), 1);
    assert_eq!(engine.exact_viewport_bytes(), small.len());
    assert!(engine.recall_exact_viewport(&analytic(0., 4096, 1536)).is_none());
    assert!(engine.recall_exact_viewport(&analytic(-1., 3072, 1024)).is_some());

    // A frame at the exact byte ceiling is admitted alone; a larger frame is
    // refused and leaves the previous frame untouched.
    let ceiling = vec![3u8; 8192 * 1024 * 4];
    engine.remember_exact_viewport(&analytic(-2., 8192, 1024), &ceiling);
    assert_eq!(engine.exact_viewports.len(), 1);
    assert_eq!(engine.exact_viewport_bytes(), ceiling.len());
    let mut oversized = analytic(-3., 8192, 1024);
    oversized.height = 1025;
    engine.remember_exact_viewport(&oversized, &vec![4u8; 8192 * 1025 * 4]);
    assert_eq!(engine.exact_viewports.len(), 1);
    assert_eq!(engine.exact_viewport_bytes(), ceiling.len());
}

#[test]
fn exact_viewport_cache_rejects_a_mismatched_or_edited_frame() {
    let mut engine = Engine::new();
    let options = analytic(0., 64, 48);
    engine.remember_exact_viewport(&options, &[9u8; 10]);
    assert!(engine.exact_viewports.is_empty(), "a partial buffer is not a frame");
    let frame = vec![5u8; 64 * 48 * 4];
    engine.remember_exact_viewport(&options, &frame);
    assert!(engine.recall_exact_viewport(&options).is_some());
    engine.geo_revision += 1;
    assert!(engine.recall_exact_viewport(&options).is_none(), "an edit invalidates the camera");
    engine.set_text_quantization(true);
    assert!(engine.exact_viewports.is_empty(), "quantisation changes glyph pixels without a revision");
}

#[test]
fn exact_viewport_path_is_limited_to_integer_analytic_cameras() {
    let mut engine = Engine::new();
    engine
        .load_document(
            &json!({
                "schemaVersion": 1, "id": "d", "name": "gates",
                "pages": [{"id": "p", "name": "p", "children": ["r"], "background": "#ffffff"}],
                "nodes": {"r": {"id": "r", "kind": "rectangle",
                    "transform": [1, 0, 0, 1, 8., 8.], "width": 32., "height": 24.,
                    "fills": [{"kind": "solid", "color": "#3366aa"}]}}
            })
            .to_string(),
        )
        .unwrap();
    assert!(engine.integer_bucket_residency(&analytic(0., 128, 96)));

    let mut figma = analytic(0., 128, 96);
    figma.raster_profile = crate::fidelity::RasterProfile::FigmaSubpixel;
    engine.render_exact(&figma).unwrap();
    assert!(engine.exact_viewports.is_empty(), "Figma subpixel keeps the tiled batch");

    assert!(!engine.integer_bucket_residency(&analytic(0.5, 128, 96)));
    let mut checkerboard = analytic(0., 128, 96);
    checkerboard.checkerboard = true;
    assert!(!engine.integer_bucket_residency(&checkerboard));
    assert!(!engine.integer_bucket_residency(&analytic(0., 8192, 1025)));
    assert!(engine.integer_bucket_residency(&analytic(0., 8192, 1024)));
}

#[test]
fn an_over_budget_exact_viewport_falls_back_to_the_tiled_batch() {
    let mut engine = Engine::new();
    engine
        .load_document(
            &json!({
                "schemaVersion": 5, "id": "d", "name": "Budget topology",
                "pages": [{"id": "p", "name": "p", "background": "#ffffff", "children": ["a"]}],
                "nodes": {"a": {"id": "a", "kind": "rectangle",
                    "transform": [1, 0, 0, 1, 20., 20.], "width": 48., "height": 48.,
                    "fills": [{"kind": "solid", "color": "#cc2244"}],
                    "effects": [{"kind": "blur", "radius": 800., "color": "#000000"}]}}
            })
            .to_string(),
        )
        .unwrap();
    let options = RenderOptions {
        view: View { x: 0., y: 0., zoom: 2. },
        ..analytic(0., 256, 256)
    };
    assert!(engine.integer_bucket_residency(&options));
    // This halo cannot fit a tile either, so both routes refuse. The tiled
    // renderer must still have been opened by the exact route's fallback, and
    // no refused frame may enter the exact cache.
    let error = engine.render_exact(&options).unwrap_err();
    assert!(
        error.contains("halo exceeds") || error == "Compositing memory budget exceeded",
        "{error}"
    );
    assert!(engine.tiled_renderer().is_some(), "the exact route must try the tiled batch");
    assert!(engine.exact_viewports.is_empty(), "a fallback frame is not certified exact");
}