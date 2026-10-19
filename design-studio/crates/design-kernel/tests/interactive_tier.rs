//! Normal managed display preserves full sampling/effects regardless of the
//! legacy interactive flag. Explicit reference APIs retain their tier option.

use futureox_design_kernel::render_instruction::render_trait;
use futureox_design_kernel::{Engine, RenderOptions, View};

fn doc(blur_radius: f64) -> String {
    serde_json::json!({
        "schemaVersion": 3,
        "colorManagement": {"documentSpace": "srgb", "referenceWhiteNits": 203, "peakLuminanceNits": 1000},
        "id": "tier", "name": "tier",
        "pages": [{"id": "p", "name": "p", "children": ["f"], "background": "#ffffff"}],
        "nodes": {
            "f": {"id": "f", "kind": "frame", "width": 96., "height": 72., "children": ["r"],
                  "fills": [{"kind": "solid", "color": "#ffffff"}]},
            "r": {"id": "r", "kind": "rectangle", "transform": [1, 0, 0, 1, 16., 12.],
                  "width": 64., "height": 48.,
                  "fills": [{"kind": "solid", "color": "#3366aa"}],
                  "effects": [{"kind": "blur", "radius": blur_radius, "visible": true, "color": "#000000"}]}
        }
    })
    .to_string()
}

fn frame_managed(interactive: bool) -> RenderOptions {
    RenderOptions {
        page_id: "p".into(),
        width: 96,
        height: 72,
        view: View { x: 0., y: 0., zoom: 1. },
        transparent: false,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: futureox_design_kernel::fidelity::RasterProfile::Figma,
        interactive_effects: interactive,
        checkerboard: false,
    }
}

fn render(document: &str, interactive: bool) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(document).expect("document");
    engine.render(&frame_managed(interactive)).expect("render")
}

#[test]
fn normal_managed_display_preserves_sub_threshold_blur() {
    let small = render(&doc(0.3), false);
    let small_tier = render(&doc(0.3), true);
    assert_eq!(small, small_tier, "normal display must preserve the 0.3px blur");

    let large = render(&doc(2.0), false);
    let large_tier = render(&doc(2.0), true);
    assert_eq!(large, large_tier, "above-threshold blur keeps full math");
}

#[test]
fn normal_managed_display_propagates_errors_without_populating_degraded_tiles() {
    let mut engine = Engine::new();
    engine.load_document(&doc(0.3)).unwrap();
    let mut options = frame_managed(true);
    options.width = 8193;
    let error = engine.render(&options).unwrap_err();
    options.interactive_effects = false;
    assert_eq!(error, engine.render(&options).unwrap_err());
    assert_eq!(engine.linear_tile_cache_len(), 0);
    // A repeated failure must not memoise a lower-quality future route.
    options.interactive_effects = true;
    assert_eq!(error, engine.render(&options).unwrap_err());
    assert_eq!(engine.linear_tile_cache_len(), 0);
}

#[test]
fn tier_leaves_non_managed_bytes_untouched() {
    let raw = serde_json::json!({
        "schemaVersion": 1,
        "id": "plain", "name": "plain",
        "pages": [{"id": "p", "name": "p", "children": ["r"], "background": "#ffffff"}],
        "nodes": {
            "r": {"id": "r", "kind": "rectangle", "transform": [1, 0, 0, 1, 16., 12.],
                  "width": 64., "height": 48.,
                  "fills": [{"kind": "solid", "color": "#3366aa"}],
                  "effects": [{"kind": "blur", "radius": 0.3, "visible": true, "color": "#000000"}]}
        }
    })
    .to_string();
    assert_eq!(render(&raw, false), render(&raw, true));
}

#[test]
fn instructions_separate_tiers_through_the_options_bit() {
    let mut engine = Engine::new();
    engine.load_document(&doc(0.3)).expect("document");
    let exact = engine.render_instruction_for(&frame_managed(false)).expect("instruction");
    let tiered = engine.render_instruction_for(&frame_managed(true)).expect("instruction");
    assert!(exact.traits_differing(&tiered) & render_trait::OPTIONS != 0);
    assert_eq!(exact.traits_differing(&exact), 0);
}
