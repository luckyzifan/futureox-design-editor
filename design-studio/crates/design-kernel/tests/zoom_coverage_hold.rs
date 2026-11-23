//! Completed zoom frames stay covered, and the previous mip level is not cleared.
//!
//! A fine crop does not cover a zoom-out viewport. Other design tools keep that
//! crop and fill the new world from a coarser picture; they do not drop the mip
//! that still has pixels. This measures the real tiled zoom path.

use futureox_design_kernel::tile_stack::exact_bucket_scale;
use futureox_design_kernel::tiled_renderer::level_index_for_scale;
use futureox_design_kernel::{Engine, RenderOptions, View};
use std::time::Instant;

fn document() -> String {
    serde_json::json!({
        "schemaVersion": 1,
        "id": "zoom-coverage",
        "name": "zoom-coverage",
        "pages": [{"id": "p", "name": "p", "children": ["board"], "background": "#ffffff"}],
        "nodes": {"board": {
            "id": "board",
            "kind": "rectangle",
            "transform": [1, 0, 0, 1, -4000.0, -4000.0],
            "width": 8000.0,
            "height": 8000.0,
            "fills": [{"kind": "solid", "color": "#3366aa"}]
        }}
    })
    .to_string()
}

fn frame(zoom: f64) -> RenderOptions {
    RenderOptions {
        page_id: "p".into(),
        width: 512,
        height: 384,
        view: View { x: 64.0, y: 32.0, zoom },
        transparent: false,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
        interactive_effects: false,
        checkerboard: false,
    }
}

fn uncovered(rgba: &[u8]) -> usize {
    rgba.chunks_exact(4).filter(|pixel| pixel[3] == 0).count()
}

#[test]
fn zoom_frames_stay_covered_and_keep_the_previous_mip() {
    let mut engine = Engine::new();
    engine.load_document(&document()).expect("document");
    let pixels = 512 * 384;
    let mut previous_bucket: Option<f64> = None;
    for zoom in [1.0, 1.4, 2.0, 0.7, 4.0, 1.0] {
        let started = Instant::now();
        let frame = engine
            .render_tiled_frame(&frame(zoom), None)
            .expect("zoom frame");
        let wall_ms = started.elapsed().as_secs_f64() * 1000.0;
        let holes = uncovered(&frame.rgba);
        let bucket = exact_bucket_scale(zoom);
        let renderer = engine.tiled_renderer().expect("tiled renderer");
        let level = level_index_for_scale(bucket);
        let resident = renderer.level(level).map(|level| level.tile_count()).unwrap_or(0);
        let previous = renderer.previous_level();
        let previous_tiles = previous
            .and_then(|index| renderer.level(index))
            .map(|level| level.tile_count())
            .unwrap_or(0);
        eprintln!(
            "zoom={zoom} bucket={bucket} holes={holes}/{pixels} visible={} previous={previous:?} previous_tiles={previous_tiles} raster_ms={:?} wall_ms={wall_ms:.3} raster_count={}",
            frame.visible_tiles,
            frame.telemetry.rasterisation_duration_ms,
            frame.telemetry.rasterisation_count,
        );
        assert_eq!(frame.rgba.len(), pixels * 4);
        assert_eq!(holes, 0, "zoom {zoom} assembled a blank texel");
        assert!(resident > 0, "zoom {zoom} published a level with no tiles");
        if let Some(old_bucket) = previous_bucket {
            if (old_bucket - bucket).abs() > f64::EPSILON {
                assert!(
                    previous_tiles > 0,
                    "crossing {old_bucket} -> {bucket} cleared the previous mip"
                );
            }
        }
        previous_bucket = Some(bucket);
    }

    // The 4× crop's world is one sixteenth of the 1× viewport. Keeping that
    // mip does not by itself cover a zoom-out; clearing it would also drop
    // the only pixels already drawn. The completed 1× frame above is covered
    // because the new level was painted without discarding this one.
    let renderer = engine.tiled_renderer().expect("renderer");
    let fine = renderer
        .level(level_index_for_scale(4.0))
        .expect("4× mip survives the return to 1×");
    assert!(fine.tile_count() > 0);
}
