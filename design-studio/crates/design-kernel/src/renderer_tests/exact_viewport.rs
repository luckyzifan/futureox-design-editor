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
        engine.remember_exact_viewport(&analytic(x, 2048, 1024), &frame).unwrap();
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
    engine.remember_exact_viewport(&analytic(0., 4096, 1536), &large).unwrap();
    let small = vec![2u8; 3072 * 1024 * 4];
    engine.remember_exact_viewport(&analytic(-1., 3072, 1024), &small).unwrap();
    assert_eq!(engine.exact_viewports.len(), 1);
    assert_eq!(engine.exact_viewport_bytes(), small.len());
    assert!(engine.recall_exact_viewport(&analytic(0., 4096, 1536)).is_none());
    assert!(engine.recall_exact_viewport(&analytic(-1., 3072, 1024)).is_some());

    // A frame at the exact byte ceiling is admitted alone; a larger frame is
    // refused and leaves the previous frame untouched.
    let ceiling = vec![3u8; 8192 * 1024 * 4];
    engine.remember_exact_viewport(&analytic(-2., 8192, 1024), &ceiling).unwrap();
    assert_eq!(engine.exact_viewports.len(), 1);
    assert_eq!(engine.exact_viewport_bytes(), ceiling.len());
    let mut oversized = analytic(-3., 8192, 1024);
    oversized.height = 1025;
    engine.remember_exact_viewport(&oversized, &vec![4u8; 8192 * 1025 * 4]).unwrap();
    assert_eq!(engine.exact_viewports.len(), 1);
    assert_eq!(engine.exact_viewport_bytes(), ceiling.len());
}

#[test]
fn exact_viewport_cache_rejects_a_mismatched_or_edited_frame() {
    let mut engine = Engine::new();
    let options = analytic(0., 64, 48);
    engine.remember_exact_viewport(&options, &[9u8; 10]).unwrap();
    assert!(engine.exact_viewports.is_empty(), "a partial buffer is not a frame");
    let frame = vec![5u8; 64 * 48 * 4];
    engine.remember_exact_viewport(&options, &frame).unwrap();
    assert!(engine.recall_exact_viewport(&options).is_some());
    engine.geo_revision += 1;
    assert!(engine.recall_exact_viewport(&options).is_none(), "an edit invalidates the camera");
    engine.set_text_quantization(true);
    assert!(engine.exact_viewports.is_empty(), "quantisation changes glyph pixels without a revision");
}

fn viewport_engine() -> Engine {
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
    engine
}

#[test]
fn exact_viewport_path_is_limited_to_integer_analytic_cameras() {
    let mut engine = viewport_engine();
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
fn cancelled_exact_cache_hits_keep_the_last_valid_viewport() {
    use crate::render_cancellation::with_probe;
    use std::{cell::Cell, rc::Rc};

    let mut engine = viewport_engine();
    let camera = analytic(0., 64, 64);
    let expected = engine.render(&camera).unwrap();
    assert_eq!(expected.len(), 64 * 64 * 4);
    assert_eq!(engine.exact_viewports.len(), 1);

    for cancel_at in [1, 2] {
        // The second check is after copying the already-rendered bytes.
        let count = Rc::new(Cell::new(0));
        let reply = with_probe(
            {
                let count = Rc::clone(&count);
                move || {
                    let previous = count.get();
                    count.set(previous + 1);
                    previous + 1 >= cancel_at
                }
            },
            || engine.render(&camera),
        );
        assert_eq!(reply.err().as_deref(), Some("PREVIEW_CANCELLED"));
        assert_eq!(count.get(), cancel_at);
        assert_eq!(engine.exact_viewports.len(), 1);
        assert_eq!(engine.exact_viewports[0].bytes, expected);
        assert_eq!(engine.render(&camera).unwrap(), expected);
    }
}

#[test]
fn cancelling_a_cold_exact_viewport_does_not_publish_or_evict() {
    use crate::render_cancellation::with_probe;
    use std::{cell::Cell, rc::Rc};

    // A third successful camera would evict the oldest live viewport. Measure
    // checkpoints for the same unretained raster on a separate warmed engine,
    // so the fixture reaches the late phases without a sleep or thread race.
    let first = analytic(0., 64, 64);
    let second = analytic(-4., 64, 64);
    let cold = analytic(-8., 64, 64);
    let mut oracle = viewport_engine();
    let first_pixels = oracle.render(&first).unwrap();
    let second_pixels = oracle.render(&second).unwrap();
    let raster_checks = Rc::new(Cell::new(0));
    let cold_pixels = with_probe(
        {
            let raster_checks = Rc::clone(&raster_checks);
            move || {
                raster_checks.set(raster_checks.get() + 1);
                false
            }
        },
        || oracle.render_unretained(&cold),
    )
    .unwrap();
    assert_ne!(first_pixels, second_pixels);
    assert_ne!(second_pixels, cold_pixels);

    for (phase, cancel_at) in [
        ("before raster", 1),
        ("after raster", raster_checks.get() + 2),
        ("before publishing staged bytes", raster_checks.get() + 3),
    ] {
        let mut engine = viewport_engine();
        assert_eq!(engine.render(&first).unwrap(), first_pixels);
        assert_eq!(engine.render(&second).unwrap(), second_pixels);
        assert_eq!(engine.exact_viewports.len(), 2);
        let steps = Rc::new(Cell::new(0));
        let reply = with_probe(
            {
                let steps = Rc::clone(&steps);
                move || {
                    steps.set(steps.get() + 1);
                    steps.get() >= cancel_at
                }
            },
            || engine.render(&cold),
        );
        assert_eq!(reply.err().as_deref(), Some("PREVIEW_CANCELLED"), "{phase}");
        assert_eq!(steps.get(), cancel_at, "{phase}");
        assert_eq!(engine.exact_viewports.len(), 2, "{phase}");
        assert_eq!(engine.recall_exact_viewport(&first).as_ref(), Some(&first_pixels));
        assert_eq!(engine.recall_exact_viewport(&second).as_ref(), Some(&second_pixels));
        assert!(engine.recall_exact_viewport(&cold).is_none(), "{phase}");

        assert_eq!(engine.render(&cold).unwrap(), cold_pixels);
        assert!(engine.recall_exact_viewport(&first).is_none());
        assert_eq!(engine.recall_exact_viewport(&cold).as_ref(), Some(&cold_pixels));
    }
}

#[test]
fn cancellable_exact_cache_staging_respects_the_existing_byte_budget() {
    use crate::render_cancellation::with_probe;

    let mut engine = viewport_engine();
    let large_camera = analytic(0., 8192, 1024);
    let large_frame = vec![42; EXACT_VIEWPORT_BYTES];
    engine.remember_exact_viewport(&large_camera, &large_frame).unwrap();
    let camera = analytic(-4., 64, 64);
    let expected = viewport_engine().render_unretained(&camera).unwrap();

    let observed = with_probe(|| false, || engine.render(&camera)).unwrap();
    assert_eq!(observed, expected);
    assert_eq!(engine.exact_viewports.len(), 1);
    assert_eq!(engine.exact_viewports[0].bytes, large_frame);
    assert!(engine.recall_exact_viewport(&camera).is_none());

    assert_eq!(engine.render(&camera).unwrap(), expected);
    assert!(engine.recall_exact_viewport(&large_camera).is_none());
    assert_eq!(engine.recall_exact_viewport(&camera).as_ref(), Some(&expected));
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