use futureox_design_kernel::zoom_in_preview::{
    compose_zoom_in_preview, underlay_uv, SampledPicture,
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
