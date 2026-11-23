//! Same-target CPU witness for a clipped-board drag at the 80% × DPR 2 sample
//! scale (1.6 device pixels per document unit).
//!
//! The resident compositor linearly samples an already rasterized board. This
//! test compares that resample with a fresh native raster of the same pose.
//! It is not a hardware WebGPU or desktop GUI measurement.
use futureox_design_kernel::Engine;
use serde_json::{json, Value};
use std::time::Instant;

const ZOOM: f64 = 1.6;
const WIDTH: u32 = 220;
const HEIGHT: u32 = 130;

fn scene(dx: f64, dy: f64) -> Value {
    json!({"schemaVersion":5,"id":"clipped-phase","name":"clipped-phase",
    "pages":[{"id":"p","name":"p","background":"#f4f1ea","children":["board","other"]}],
    "nodes":{
        "board":{"id":"board","kind":"frame","width":40,"height":30,"clip":true,
            "transform":[1,0,0,1,4.0+dx,4.0+dy],"children":["block","hair"],
            "fills":[{"kind":"solid","color":"#dce7ee"}]},
        "block":{"id":"block","kind":"rectangle","width":14,"height":9,
            "transform":[1,0,0,1,6.25,8.5],
            "fills":[{"kind":"solid","color":"#1a2740"}]},
        "hair":{"id":"hair","kind":"rectangle","width":28,"height":0.5,
            "transform":[1,0,0,1,3.0,18.25],
            "fills":[{"kind":"solid","color":"#111111"}]},
        "other":{"id":"other","kind":"frame","width":16,"height":16,"clip":true,
            "transform":[1,0,0,1,180,8],
            "fills":[{"kind":"solid","color":"#c4b7a6"}]}
    }})
}

fn render(document: &Value) -> (Vec<u8>, f64) {
    let mut engine = Engine::new();
    engine.load_document(&document.to_string()).unwrap();
    let options = engine
        .parse_options(json!({"pageId":"p","width":WIDTH,"height":HEIGHT,
        "view":{"x":0,"y":0,"zoom":ZOOM},"rasterProfile":"figma","transparent":false,"grid":false}))
        .unwrap();
    let started = Instant::now();
    let pixels = engine.render(&options).unwrap();
    let elapsed = started.elapsed().as_secs_f64() * 1_000.0;
    assert_eq!(pixels.len(), WIDTH as usize * HEIGHT as usize * 4);
    (pixels, elapsed)
}

fn texel(src: &[u8], x: i32, y: i32) -> [f64; 4] {
    let x = x.clamp(0, WIDTH as i32 - 1);
    let y = y.clamp(0, HEIGHT as i32 - 1);
    let i = ((y as u32 * WIDTH + x as u32) * 4) as usize;
    [
        src[i] as f64,
        src[i + 1] as f64,
        src[i + 2] as f64,
        src[i + 3] as f64,
    ]
}

/// WebGPU rgba8unorm linear sampling in texel-center coordinates: 0 is the
/// center of texel 0, clamp-to-edge. An integer coordinate copies one texel.
fn sample_linear(src: &[u8], x: f64, y: f64) -> [u8; 4] {
    let x = x.clamp(0.0, (WIDTH - 1) as f64);
    let y = y.clamp(0.0, (HEIGHT - 1) as f64);
    let x0 = x.floor();
    let y0 = y.floor();
    let fx = x - x0;
    let fy = y - y0;
    let mut out = [0u8; 4];
    for channel in 0..4 {
        let a = texel(src, x0 as i32, y0 as i32)[channel];
        let b = texel(src, x0 as i32 + 1, y0 as i32)[channel];
        let c = texel(src, x0 as i32, y0 as i32 + 1)[channel];
        let d = texel(src, x0 as i32 + 1, y0 as i32 + 1)[channel];
        let value =
            a * (1.0 - fx) * (1.0 - fy) + b * fx * (1.0 - fy) + c * (1.0 - fx) * fy + d * fx * fy;
        out[channel] = value.round().clamp(0.0, 255.0) as u8;
    }
    out
}

fn shifted_board(source: &[u8], shift_x: f64, shift_y: f64) -> (Vec<u8>, f64) {
    let started = Instant::now();
    let mut out = source.to_vec();
    let left = (4.0 + shift_x / ZOOM) * ZOOM;
    let top = (4.0 + shift_y / ZOOM) * ZOOM;
    let right = left + 40.0 * ZOOM;
    let bottom = top + 30.0 * ZOOM;
    for y in 0..HEIGHT as i32 {
        for x in 0..WIDTH as i32 {
            let cx = x as f64 + 0.5;
            let cy = y as f64 + 0.5;
            if cx < left || cy < top || cx >= right || cy >= bottom {
                continue;
            }
            let sample = sample_linear(source, x as f64 - shift_x, y as f64 - shift_y);
            let i = ((y as u32 * WIDTH + x as u32) * 4) as usize;
            out[i..i + 4].copy_from_slice(&sample);
        }
    }
    // The old board rectangle is no longer covered by the shifted texture.
    // Page background shows through, matching the retained-board clip.
    let old_left = 4.0 * ZOOM;
    let old_top = 4.0 * ZOOM;
    let old_right = old_left + 40.0 * ZOOM;
    let old_bottom = old_top + 30.0 * ZOOM;
    let background = source[0..4].to_vec();
    for y in 0..HEIGHT as i32 {
        for x in 0..WIDTH as i32 {
            let cx = x as f64 + 0.5;
            let cy = y as f64 + 0.5;
            let in_old = cx >= old_left && cy >= old_top && cx < old_right && cy < old_bottom;
            let in_new = cx >= left && cy >= top && cx < right && cy < bottom;
            if in_old && !in_new {
                let i = ((y as u32 * WIDTH + x as u32) * 4) as usize;
                out[i..i + 4].copy_from_slice(&background);
            }
        }
    }
    (out, started.elapsed().as_secs_f64() * 1_000.0)
}

fn diff_box(
    actual: &[u8],
    expected: &[u8],
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
) -> (u32, u32, u8) {
    let mut compared = 0u32;
    let mut mismatched = 0u32;
    let mut max = 0u8;
    for y in 0..HEIGHT as i32 {
        for x in 0..WIDTH as i32 {
            let cx = x as f64 + 0.5;
            let cy = y as f64 + 0.5;
            if cx < left + 1.5 || cy < top + 1.5 || cx >= right - 1.5 || cy >= bottom - 1.5 {
                continue;
            }
            compared += 1;
            let i = ((y as u32 * WIDTH + x as u32) * 4) as usize;
            let mut pixel = false;
            for channel in 0..4 {
                let delta = actual[i + channel].abs_diff(expected[i + channel]);
                if delta > max {
                    max = delta
                }
                if delta != 0 {
                    pixel = true
                }
            }
            if pixel {
                mismatched += 1
            }
        }
    }
    (compared, mismatched, max)
}

#[test]
fn fractional_physical_board_shift_mismatches_native_and_integer_shift_matches() {
    let (source, source_ms) = render(&scene(0.0, 0.0));
    // (+28, +7) document units → (44.8, 11.2) device pixels at this scale.
    let fractional_shift = (28.0 * ZOOM, 7.0 * ZOOM);
    let (fractional_native, fractional_native_ms) = render(&scene(28.0, 7.0));
    let (fractional_retained, fractional_resample_ms) =
        shifted_board(&source, fractional_shift.0, fractional_shift.1);
    let frac_box = (
        4.0 * ZOOM + fractional_shift.0,
        4.0 * ZOOM + fractional_shift.1,
        44.0 * ZOOM + fractional_shift.0,
        34.0 * ZOOM + fractional_shift.1,
    );
    let (frac_compared, frac_mismatch, frac_max) = diff_box(
        &fractional_retained,
        &fractional_native,
        frac_box.0,
        frac_box.1,
        frac_box.2,
        frac_box.3,
    );
    assert!(
        frac_compared > 1000,
        "fractional interior was empty: {frac_compared}"
    );
    assert!(
        frac_mismatch > 0,
        "fractional retained shift unexpectedly matched native"
    );
    assert!(
        frac_max > 1,
        "fractional channel error was only quantization: {frac_max}"
    );

    // (+80, +20) → (128, 32), whole physical pixels on both axes.
    let integer_shift = (80.0 * ZOOM, 20.0 * ZOOM);
    assert_eq!(integer_shift, (128.0, 32.0));
    let (integer_native, integer_native_ms) = render(&scene(80.0, 20.0));
    let (integer_retained, integer_resample_ms) =
        shifted_board(&source, integer_shift.0, integer_shift.1);
    let int_box = (
        4.0 * ZOOM + integer_shift.0,
        4.0 * ZOOM + integer_shift.1,
        44.0 * ZOOM + integer_shift.0,
        34.0 * ZOOM + integer_shift.1,
    );
    let (int_compared, int_mismatch, int_max) = diff_box(
        &integer_retained,
        &integer_native,
        int_box.0,
        int_box.1,
        int_box.2,
        int_box.3,
    );
    assert!(
        int_compared > 1000,
        "integer interior was empty: {int_compared}"
    );
    assert_eq!(
        (int_mismatch, int_max),
        (0, 0),
        "integer physical shift diverged from native"
    );

    eprintln!(
        "[issue-818] cpu-native figma zoom={ZOOM} viewport={WIDTH}x{HEIGHT} \
         source_ms={source_ms:.3} fractional_native_ms={fractional_native_ms:.3} \
         fractional_resample_ms={fractional_resample_ms:.3} integer_native_ms={integer_native_ms:.3} \
         integer_resample_ms={integer_resample_ms:.3} fractional_compared={frac_compared} \
         fractional_mismatch={frac_mismatch} fractional_max_channel={frac_max} \
         integer_compared={int_compared} integer_mismatch={int_mismatch}"
    );
}
