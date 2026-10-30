//! The Figma-shape compositing ledger:
//! two pools — scene-compositing peak and tile residency — summed, `>> 20`
//! for MB, f32 tile ratio; budget rejections stay observable as pressure
//! events the way `clearErrorsAndCheckForOOM` surfaces OOM.

use futureox_design_kernel::{Engine, RenderOptions, View};

fn doc() -> String {
    serde_json::json!({
        "schemaVersion": 1, "id": "l", "name": "l",
        "pages": [{"id": "p", "name": "p", "children": ["r"], "background": "#ffffff"}],
        "nodes": {"r": {
            "id": "r", "kind": "rectangle", "transform": [1, 0, 0, 1, 16., 16.],
            "width": 640., "height": 640.,
            "fills": [{"kind": "solid", "color": "#3366aa"}]
        }}
    })
    .to_string()
}

fn frame() -> RenderOptions {
    RenderOptions {
        page_id: "p".into(),
        width: 512,
        height: 512,
        view: View { x: 0., y: 0., zoom: 1. },
        transparent: false,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
        interactive_effects: false,
        checkerboard: false,
    }
}

#[test]
fn ledger_reports_pools_mb_and_ratio_in_the_figma_shape() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    engine.render(&frame()).expect("render");
    let after_scene = engine.compositing_ledger();
    assert!(after_scene.scene_peak_bytes > 0, "scene pool records the render peak");
    assert_eq!(after_scene.tile_resident_bytes, 0, "no tiles without the tiled path");

    // 512×512 @zoom 1 → one resident tile of 512×512×4 bytes.
    engine.render_tiled_frame(&frame(), None).expect("tiled frame");
    let after_tiles = engine.compositing_ledger();
    assert_eq!(after_tiles.tile_resident_bytes, 512 * 512 * 4);
    let total = after_tiles.scene_peak_bytes + after_tiles.tile_resident_bytes;
    assert_eq!(
        after_tiles.total_vram_mb as usize,
        total >> 20,
        "MB conversion follows the >> 20 shape"
    );
    assert!((after_tiles.tile_vram_ratio - (after_tiles.tile_resident_bytes as f32 / total as f32)).abs() < 1e-6);
    assert!(after_tiles.tile_vram_ratio > 0. && after_tiles.tile_vram_ratio <= 1.);
    assert_eq!(after_tiles.rendered_tile_vram_mb as usize, after_tiles.tile_resident_bytes >> 20);
    assert_eq!(after_tiles.budget_rejections, 0, "healthy renders record no pressure");
    assert!(after_tiles.last_rejection.is_none());
}

#[test]
fn ledger_is_monotonic_across_renders() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    engine.render(&frame()).expect("first");
    let first = engine.compositing_ledger().scene_peak_bytes;
    engine.render(&frame()).expect("second");
    let second = engine.compositing_ledger().scene_peak_bytes;
    assert!(second >= first, "cross-render peak never decreases");
}
