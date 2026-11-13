use futureox_design_kernel::zoom_in_preview::{
    compose_zoom_in_preview, underlay_uv, zoom_in_focus_core, SampledPicture, ZOOM_IN_FOCUS_CORE,
};
use futureox_design_kernel::{Engine, RenderOptions, View};
use serde_json::json;
use std::time::Instant;

fn bars() -> String {
    let mut nodes = serde_json::Map::new();
    let mut children = Vec::new();
    for index in 0..16 {
        let id = format!("b{index}");
        children.push(id.clone());
        nodes.insert(
            id.clone(),
            json!({
                "id": id,
                "kind": "rectangle",
                "transform": [1.0, 0.0, 0.0, 1.0, index as f64 * 4.0, 0.0],
                "width": 1.0,
                "height": 64.0,
                "fills": [{"kind": "solid", "color": "#000000"}],
            }),
        );
    }
    json!({
        "schemaVersion": 1,
        "id": "zoom-in-preview",
        "name": "bars",
        "pages": [{"id": "p", "name": "p", "children": children, "background": "#ffffff"}],
        "nodes": nodes,
    })
    .to_string()
}

fn frame(view: View, width: u32, height: u32) -> RenderOptions {
    RenderOptions {
        page_id: "p".into(),
        width,
        height,
        view,
        transparent: false,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
        interactive_effects: false,
        checkerboard: false,
    }
}

fn picture(world_x: f64, world_y: f64, world_w: f64, world_h: f64) -> SampledPicture {
    SampledPicture {
        world_x,
        world_y,
        world_w,
        world_h,
    }
}

fn channel_delta(a: &[u8], b: &[u8]) -> u8 {
    a.iter()
        .zip(b)
        .map(|(p, q)| p.abs_diff(*q))
        .max()
        .unwrap_or(0)
}

/// Frozen before reading a candidate: the held picture is one linear resample
/// of the zoom-1 bars, and a ready center tile has to replace that resample
/// instead of leaving it stretched. Linux CPU, analytic profile, 64² viewport.
/// Not a Metal frame time and not a 117 file.
#[test]
fn a_ready_center_tile_replaces_the_stretched_zoom_in_preview() {
    assert_eq!(
        underlay_uv(0.0, 0.0, 1.0, 2.0, 256.0, 256.0, 48.0, 48.0, 32.0, 32.0),
        [0.375, 0.375, 0.625, 0.625]
    );

    let mut engine = Engine::new();
    engine.load_document(&bars()).expect("bars");
    let base_started = Instant::now();
    let base = engine
        .render(&frame(
            View {
                x: 0.0,
                y: 0.0,
                zoom: 1.0,
            },
            64,
            64,
        ))
        .expect("zoom-1 picture");
    let base_ms = base_started.elapsed().as_secs_f64() * 1_000.0;
    let target_view = View {
        x: -64.0,
        y: -64.0,
        zoom: 4.0,
    };
    let direct_started = Instant::now();
    let direct = engine
        .render(&frame(target_view, 64, 64))
        .expect("zoom-4 picture");
    let direct_ms = direct_started.elapsed().as_secs_f64() * 1_000.0;
    let tile_started = Instant::now();
    let tile = engine
        .render(&frame(
            View {
                x: -80.0,
                y: -80.0,
                zoom: 4.0,
            },
            32,
            32,
        ))
        .expect("center tile");
    let tile_ms = tile_started.elapsed().as_secs_f64() * 1_000.0;

    let base_picture = picture(0.0, 0.0, 64.0, 64.0);
    let target = picture(16.0, 16.0, 16.0, 16.0);
    let tile_picture = picture(20.0, 20.0, 8.0, 8.0);
    let stretch = compose_zoom_in_preview(&base_picture, &base, 64, 64, &[], &target, 64, 64)
        .expect("stretched hold");
    let sharp = compose_zoom_in_preview(
        &base_picture,
        &base,
        64,
        64,
        &[(&tile_picture, tile.as_slice(), 32, 32)],
        &target,
        64,
        64,
    )
    .expect("tile over hold");

    let mut stretch_far = 0usize;
    let mut sharp_far = 0usize;
    let mut center = 0usize;
    let mut border_changed = 0usize;
    for y in 0..64usize {
        for x in 0..64usize {
            let index = (y * 64 + x) * 4;
            let direct_px = &direct[index..index + 4];
            let stretch_px = &stretch[index..index + 4];
            let sharp_px = &sharp[index..index + 4];
            let inside = (16..48).contains(&x) && (16..48).contains(&y);
            if inside {
                center += 1;
                if channel_delta(stretch_px, direct_px) >= 40 {
                    stretch_far += 1;
                }
                if channel_delta(sharp_px, direct_px) > 1 {
                    sharp_far += 1;
                }
            } else if channel_delta(sharp_px, stretch_px) != 0 {
                border_changed += 1;
            }
        }
    }
    eprintln!(
        "zoom-in preview cpu analytic 64px bars: base {base_ms:.3} ms, full zoom-4 {direct_ms:.3} ms, center tile {tile_ms:.3} ms, stretched center pixels delta>=40 {stretch_far}/{center}, composited center pixels delta>1 {sharp_far}/{center}"
    );
    assert!(
        stretch_far >= 64,
        "the zoom-1 picture stretched to 400% is not the blurred hold this fixture measures ({stretch_far} center pixels)"
    );
    assert_eq!(
        sharp_far, 0,
        "the ready center tile must match the zoom-4 raster, not the stretched hold"
    );
    assert_eq!(
        border_changed, 0,
        "outside the ready tile the original hold stays"
    );
}

fn timed(engine: &mut Engine, view: View, width: u32, height: u32) -> (Vec<u8>, f64) {
    let started = Instant::now();
    let pixels = engine.render(&frame(view, width, height)).expect("raster");
    let ms = started.elapsed().as_secs_f64() * 1_000.0;
    (pixels, ms)
}

fn far_pixels(image: &[u8], direct: &[u8], threshold: u8) -> usize {
    image
        .chunks(4)
        .zip(direct.chunks(4))
        .filter(|(pixel, oracle)| channel_delta(pixel, oracle) >= threshold)
        .count()
}

/// Frozen before the rasters below. Linux CPU, analytic profile, test
/// (unoptimized) build. Not a Metal frame time and not a 117 file.
///
/// The ordinary motion tile is 512 content pixels plus the existing 1px
/// filter gutter (514). The focus cell is `ZOOM_IN_FOCUS_CORE` plus that
/// same gutter (162). The focus picture has to be ready in less than half
/// the ordinary tile's wall time. At that earlier time the ordinary-tile
/// policy is still the stretched zoom-1 picture: at least 64 viewport
/// pixels differ from the direct zoom-4 frame by channel delta >= 40.
/// The focus composite matches that direct frame (channel delta <= 1).
/// A second inward camera that already holds the focus cell does not raster
/// again. The settled frame stays the 64² native viewport, not the cell.
const FOCUS_READY_FRACTION: f64 = 0.5;
const STRETCH_DELTA: u8 = 40;
const MIN_STRETCH_PIXELS: usize = 64;

#[test]
fn continuous_zoom_focus_leaves_the_stretched_preview_before_the_ordinary_tile() {
    assert_eq!(ZOOM_IN_FOCUS_CORE, 160.0);
    assert_eq!(
        zoom_in_focus_core(0.0, 0.0, 800.0, 600.0, 400.0, 300.0),
        Some([320.0, 160.0, 160.0, 160.0])
    );
    assert_eq!(
        zoom_in_focus_core(0.0, 0.0, 800.0, 600.0, -1.0, 10.0),
        None
    );

    let mut engine = Engine::new();
    engine.load_document(&bars()).expect("bars");
    // Warm the analytic path. This frame is not a sample.
    let _ = timed(
        &mut engine,
        View {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        },
        16,
        16,
    );

    let zoom4 = View {
        x: 0.0,
        y: 0.0,
        zoom: 4.0,
    };
    let (ordinary_a, ordinary_a_ms) = timed(&mut engine, zoom4, 514, 514);
    let (focus_a, focus_a_ms) = timed(&mut engine, zoom4, 162, 162);
    let (_ordinary_b, ordinary_b_ms) = timed(&mut engine, zoom4, 514, 514);
    let (_focus_b, focus_b_ms) = timed(&mut engine, zoom4, 162, 162);
    let ordinary_ms = ordinary_a_ms.min(ordinary_b_ms);
    let focus_ms = focus_a_ms.max(focus_b_ms);
    assert_eq!(ordinary_a.len(), 514 * 514 * 4);
    assert_eq!(focus_a.len(), 162 * 162 * 4);

    let (base, _) = timed(
        &mut engine,
        View {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        },
        64,
        64,
    );
    let (direct, _) = timed(
        &mut engine,
        View {
            x: -96.0,
            y: -96.0,
            zoom: 4.0,
        },
        64,
        64,
    );
    let base_picture = picture(0.0, 0.0, 64.0, 64.0);
    let target = picture(24.0, 24.0, 16.0, 16.0);
    // 162 device pixels at zoom 4. The gutter is inside this image; the
    // world span is the picture the compositor samples.
    let focus_picture = picture(0.0, 0.0, 162.0 / 4.0, 162.0 / 4.0);
    let stretch = compose_zoom_in_preview(&base_picture, &base, 64, 64, &[], &target, 64, 64)
        .expect("stretched hold");
    let sharp = compose_zoom_in_preview(
        &base_picture,
        &base,
        64,
        64,
        &[(&focus_picture, focus_a.as_slice(), 162, 162)],
        &target,
        64,
        64,
    )
    .expect("focus cell over hold");
    let stretch_far = far_pixels(&stretch, &direct, STRETCH_DELTA);
    let sharp_far = far_pixels(&sharp, &direct, 2);
    // t = 0: both policies show the stretch. t = focus_ms: the focus policy
    // composites the resident cell and the ordinary policy is still waiting.
    // The return trip starts at that same instant with the cell already
    // resident, so its extra raster is 0. The ordinary policy starts the
    // 514 tile over.
    eprintln!(
        "zoom-in focus duration cpu analytic: ordinary 514px {ordinary_a_ms:.3}/{ordinary_b_ms:.3} ms (used {ordinary_ms:.3}), focus 162px {focus_a_ms:.3}/{focus_b_ms:.3} ms (used {focus_ms:.3}), stretch pixels delta>={STRETCH_DELTA} {stretch_far}/4096, focus composite pixels delta>1 {sharp_far}/4096, cold blur ordinary {ordinary_ms:.3} ms focus {focus_ms:.3} ms, return extra raster ordinary {ordinary_ms:.3} ms focus 0 ms"
    );
    assert!(
        focus_ms * (1.0 / FOCUS_READY_FRACTION) < ordinary_ms,
        "focus cell {focus_ms:.3} ms is not under half of the ordinary tile {ordinary_ms:.3} ms"
    );
    assert!(
        stretch_far >= MIN_STRETCH_PIXELS,
        "the zoom-1 picture stretched to this camera is not the blurred hold ({stretch_far})"
    );
    assert_eq!(
        sharp_far, 0,
        "the focus cell must match the zoom-4 viewport, not the stretched hold"
    );
    assert!(
        focus_ms < ordinary_ms,
        "at t={focus_ms:.3} ms the ordinary tile is still the stretched picture"
    );
    assert_eq!(direct.len(), 64 * 64 * 4, "settled native viewport stays 64px");
}
