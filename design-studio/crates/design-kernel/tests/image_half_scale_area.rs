//! Issue #83 measurement: half-scale bitmap sampling versus an independent
//! coverage-weighted area filter. The oracle is not the renderer. The screen
//! threshold is the existing RGB channel delta of 16, not a new limit.
use base64::Engine as _;
use futureox_design_kernel::{Engine, RenderOptions, View, fidelity::RasterProfile};
use serde_json::json;

fn png(width: u32, height: u32, pixels: &[u8]) -> String {
    let image = image::RgbaImage::from_raw(width, height, pixels.to_vec()).unwrap();
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
    )
}

/// Procedural bitmap. One-pixel horizontal bars make a non-integer half frame
/// disagree between a centre bilinear tap and a coverage-weighted area filter.
/// Not a copy of any design file. Opaque, so premultiplication does not change
/// the bytes.
fn procedural(width: u32, height: u32) -> Vec<u8> {
    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            let v = if y % 2 == 0 { 0 } else { 255 };
            pixels.extend([v, 255 - v, (x.wrapping_mul(3).wrapping_add(y)) as u8, 255]);
        }
    }
    pixels
}

fn document(uri: &str, width: f64, height: f64, fit: &str) -> String {
    json!({
        "schemaVersion": 5,
        "id": "d",
        "name": "half-scale",
        "pages": [{ "id": "p", "name": "p", "children": ["n"], "background": "#ffffff" }],
        "nodes": {
            "n": {
                "id": "n",
                "kind": "rectangle",
                "transform": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                "width": width,
                "height": height,
                "fills": [{ "kind": "image", "color": "#ffffff", "fit": fit, "image": uri }]
            }
        }
    })
    .to_string()
}

fn render(doc: &str, width: u32, height: u32, zoom: f64, profile: RasterProfile) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(doc).unwrap();
    engine
        .render(&RenderOptions {
            page_id: "p".into(),
            width,
            height,
            view: View { x: 0., y: 0., zoom },
            transparent: true,
            grid: false,
            pixel_preview: None,
            animation: None,
            raster_profile: profile,
            interactive_effects: false,
            checkerboard: false,
        })
        .unwrap()
}

fn source_at(src: &[u8], sw: u32, sh: u32, x: i32, y: i32) -> [f64; 4] {
    if x < 0 || y < 0 || x >= sw as i32 || y >= sh as i32 {
        return [0.; 4];
    }
    let i = ((y as u32 * sw + x as u32) * 4) as usize;
    std::array::from_fn(|c| f64::from(src[i + c]))
}

/// Independent stretch footprint. Device pixel `[x, x+1) × [y, y+1)` maps by
/// `device * image / frame` (zoom is folded into the frame passed by the
/// caller). This is the pixel rectangle, not a centre tap and not the renderer.
fn area_stretch(
    src: &[u8],
    sw: u32,
    sh: u32,
    frame_w: f64,
    frame_h: f64,
    x: u32,
    y: u32,
    linear: bool,
) -> [u8; 4] {
    let x0 = f64::from(x) * f64::from(sw) / frame_w;
    let x1 = f64::from(x + 1) * f64::from(sw) / frame_w;
    let y0 = f64::from(y) * f64::from(sh) / frame_h;
    let y1 = f64::from(y + 1) * f64::from(sh) / frame_h;
    let mut sum = [0f64; 4];
    let mut weight = 0f64;
    let y_start = y0.floor().max(0.) as i32;
    let y_end = y1.ceil().min(f64::from(sh)) as i32;
    let x_start = x0.floor().max(0.) as i32;
    let x_end = x1.ceil().min(f64::from(sw)) as i32;
    for ty in y_start..y_end {
        let yb = f64::from(ty);
        let wy = y1.min(yb + 1.) - y0.max(yb);
        if wy <= 0. {
            continue;
        }
        for tx in x_start..x_end {
            let xb = f64::from(tx);
            let wx = x1.min(xb + 1.) - x0.max(xb);
            if wx <= 0. {
                continue;
            }
            let w = wx * wy;
            let texel = source_at(src, sw, sh, tx, ty);
            for c in 0..4 {
                let sample = if linear && c < 3 {
                    decode_byte(texel[c]) * 255.
                } else {
                    texel[c]
                };
                sum[c] += sample * w;
            }
            weight += w;
        }
    }
    if weight <= 0. {
        return [0; 4];
    }
    std::array::from_fn(|c| {
        let value = sum[c] / weight;
        let encoded = if linear && c < 3 {
            encode_unit(value / 255.) * 255.
        } else {
            value
        };
        encoded.round().clamp(0., 255.) as u8
    })
}

fn decode_byte(byte: f64) -> f64 {
    let e = byte / 255.;
    if e <= 0.04045 {
        e / 12.92
    } else {
        ((e + 0.055) / 1.055).powf(2.4)
    }
}

fn encode_unit(linear: f64) -> f64 {
    if linear <= 0.0031308 {
        12.92 * linear
    } else {
        1.055 * linear.powf(1. / 2.4) - 0.055
    }
}

/// Centre bilinear in encoded bytes. Independent stand-in for the historical
/// single-tap stretch sampler, used only to prove scales outside the half band
/// did not move.
fn bilinear_stretch(
    src: &[u8],
    sw: u32,
    sh: u32,
    frame_w: f64,
    frame_h: f64,
    x: u32,
    y: u32,
) -> [u8; 4] {
    let edge_x = (f64::from(x) + 0.5) * f64::from(sw) / frame_w;
    let edge_y = (f64::from(y) + 0.5) * f64::from(sh) / frame_h;
    let qx = (edge_x - 0.5).clamp(0., f64::from(sw) - 1.);
    let qy = (edge_y - 0.5).clamp(0., f64::from(sh) - 1.);
    let x0 = qx.floor() as i32;
    let y0 = qy.floor() as i32;
    let u = qx - f64::from(x0);
    let v = qy - f64::from(y0);
    let sample = |x, y| source_at(src, sw, sh, x, y);
    let (a, b, c, d) = (
        sample(x0, y0),
        sample(x0 + 1, y0),
        sample(x0, y0 + 1),
        sample(x0 + 1, y0 + 1),
    );
    std::array::from_fn(|ch| {
        let top = a[ch] * (1. - u) + b[ch] * u;
        let bottom = c[ch] * (1. - u) + d[ch] * u;
        (top * (1. - v) + bottom * v).round().clamp(0., 255.) as u8
    })
}

fn over_threshold(actual: &[u8], expected: &[u8]) -> (f64, u8, usize) {
    let mut bad = 0usize;
    let mut max_delta = 0u8;
    let n = actual.len() / 4;
    for i in 0..n {
        let delta = (0..3)
            .map(|c| actual[i * 4 + c].abs_diff(expected[i * 4 + c]))
            .max()
            .unwrap_or(0);
        max_delta = max_delta.max(delta);
        if delta > 16 {
            bad += 1;
        }
    }
    (bad as f64 / n as f64 * 100., max_delta, bad)
}

fn reference_frame(
    src: &[u8],
    sw: u32,
    sh: u32,
    width: u32,
    height: u32,
    frame_w: f64,
    frame_h: f64,
    linear: bool,
    bilinear: bool,
) -> Vec<u8> {
    let mut out = vec![0u8; (width * height * 4) as usize];
    for y in 0..height {
        for x in 0..width {
            let px = if bilinear {
                bilinear_stretch(src, sw, sh, frame_w, frame_h, x, y)
            } else {
                area_stretch(src, sw, sh, frame_w, frame_h, x, y, linear)
            };
            let i = ((y * width + x) * 4) as usize;
            out[i..i + 4].copy_from_slice(&px);
        }
    }
    out
}

fn report(label: &str, actual: &[u8], encoded: &[u8], linear: &[u8], bilinear: &[u8]) {
    let (area_pct, area_max, area_bad) = over_threshold(actual, encoded);
    let (linear_pct, linear_max, _) = over_threshold(actual, linear);
    let (bilinear_pct, bilinear_max, _) = over_threshold(actual, bilinear);
    println!(
        "HALF_SCALE_METRIC {label} pixels={} area_over16_pct={area_pct:.4} area_max={area_max} area_bad={area_bad} linear_over16_pct={linear_pct:.4} linear_max={linear_max} bilinear_over16_pct={bilinear_pct:.4} bilinear_max={bilinear_max}",
        actual.len() / 4
    );
}

struct Case {
    label: &'static str,
    src_w: u32,
    src_h: u32,
    frame_w: f64,
    frame_h: f64,
    out_w: u32,
    out_h: u32,
    zoom: f64,
    fit: &'static str,
    profile: RasterProfile,
}

fn run_case(case: &Case, src: &[u8]) -> Vec<u8> {
    // Zoom scales the frame in device pixels. The independent footprint uses
    // that device frame, which is where DPR belongs: CSS zoom 0.5 at DPR 2 is
    // device zoom 1 and must not enter the half-scale filter.
    let device_w = case.frame_w * case.zoom;
    let device_h = case.frame_h * case.zoom;
    let uri = png(case.src_w, case.src_h, src);
    let doc = document(&uri, case.frame_w, case.frame_h, case.fit);
    let actual = render(&doc, case.out_w, case.out_h, case.zoom, case.profile);
    let encoded = reference_frame(
        src, case.src_w, case.src_h, case.out_w, case.out_h, device_w, device_h, false, false,
    );
    let linear = reference_frame(
        src, case.src_w, case.src_h, case.out_w, case.out_h, device_w, device_h, true, false,
    );
    let bilinear = reference_frame(
        src, case.src_w, case.src_h, case.out_w, case.out_h, device_w, device_h, false, true,
    );
    report(case.label, &actual, &encoded, &linear, &bilinear);
    actual
}

#[test]
fn half_scale_bitmap_against_independent_area_filter() {
    // 48×31 stands in for an odd source such as 500×749. A 24×16 frame is the
    // rounded half-size placement (31/2 = 15.5 → 16). Stretch is the Sketch
    // bitmap fit. Profiles: analytic centre sample, and the four-sample
    // screen profile. GPU/Metal is not executed here.
    let src = procedural(48, 31);
    let native = Case {
        label: "analytic-native-1x",
        src_w: 48,
        src_h: 31,
        frame_w: 48.,
        frame_h: 31.,
        out_w: 48,
        out_h: 31,
        zoom: 1.,
        fit: "stretch",
        profile: RasterProfile::Analytic,
    };
    let actual = run_case(&native, &src);
    assert_eq!(actual, src, "original size must stay byte-identical");

    let half = Case {
        label: "analytic-half-frame",
        src_w: 48,
        src_h: 31,
        frame_w: 24.,
        frame_h: 16.,
        out_w: 24,
        out_h: 16,
        zoom: 1.,
        fit: "stretch",
        profile: RasterProfile::Analytic,
    };
    let half_pixels = run_case(&half, &src);
    let encoded = reference_frame(&src, 48, 31, 24, 16, 24., 16., false, false);
    let linear = reference_frame(&src, 48, 31, 24, 16, 24., 16., true, false);
    let (area_pct, area_max, _) = over_threshold(&half_pixels, &encoded);
    let (linear_pct, _, _) = over_threshold(&half_pixels, &linear);

    // Device zoom 1 is the DPR 2 reading of a CSS half-scale view. It must
    // remain the original bytes, not a second downsample.
    let dpr = Case {
        label: "analytic-device-1x-dpr",
        src_w: 48,
        src_h: 31,
        frame_w: 48.,
        frame_h: 31.,
        out_w: 48,
        out_h: 31,
        zoom: 1.,
        fit: "stretch",
        profile: RasterProfile::Analytic,
    };
    assert_eq!(run_case(&dpr, &src), src);

    let screen = Case {
        label: "subpixel-half-frame",
        src_w: 48,
        src_h: 31,
        frame_w: 24.,
        frame_h: 16.,
        out_w: 24,
        out_h: 16,
        zoom: 1.,
        fit: "stretch",
        profile: RasterProfile::FigmaSubpixel,
    };
    let screen_pixels = run_case(&screen, &src);
    let (screen_pct, screen_max, _) = over_threshold(&screen_pixels, &encoded);
    let (screen_linear, _, _) = over_threshold(&screen_pixels, &linear);

    // Exact 2× device scale (even source, zoom 0.5) stays on the area/bilinear
    // fixed point. Quarter, three-quarter and 2× magnification must keep the
    // historical centre bilinear tap.
    let even = procedural(32, 24);
    let exact = Case {
        label: "analytic-exact-half-zoom",
        src_w: 32,
        src_h: 24,
        frame_w: 32.,
        frame_h: 24.,
        out_w: 16,
        out_h: 12,
        zoom: 0.5,
        fit: "stretch",
        profile: RasterProfile::Analytic,
    };
    let exact_pixels = run_case(&exact, &even);
    let exact_area = reference_frame(&even, 32, 24, 16, 12, 16., 12., false, false);
    let (exact_pct, exact_max, _) = over_threshold(&exact_pixels, &exact_area);
    assert!(
        exact_pct == 0. && exact_max <= 1,
        "exact half zoom moved off the area filter: {exact_pct:.4}% max {exact_max}"
    );

    for (label, zoom, out_w, out_h) in [
        ("analytic-zoom-0.75", 0.75, 24u32, 18u32),
        ("analytic-zoom-0.25", 0.25, 8, 6),
        ("analytic-zoom-2", 2., 64, 48),
    ] {
        let case = Case {
            label,
            src_w: 32,
            src_h: 24,
            frame_w: 32.,
            frame_h: 24.,
            out_w,
            out_h,
            zoom,
            fit: "stretch",
            profile: RasterProfile::Analytic,
        };
        let actual = run_case(&case, &even);
        let device_w = 32. * zoom;
        let device_h = 24. * zoom;
        let expected = reference_frame(&even, 32, 24, out_w, out_h, device_w, device_h, false, true);
        let (pct, max_delta, _) = over_threshold(&actual, &expected);
        assert!(
            pct == 0. && max_delta <= 1,
            "{label} left the historical bilinear tap: {pct:.4}% max {max_delta}"
        );
    }

    assert!(
        area_pct <= 1.0 && area_max <= 1,
        "half-scale analytic still exceeds the area oracle: {area_pct:.4}% max {area_max}"
    );
    assert!(
        linear_pct > 1.0,
        "half-scale collapsed onto linear-light filtering ({linear_pct:.4}% over 16)"
    );
    assert!(
        screen_pct <= 1.0 && screen_max <= 1,
        "half-scale screen profile still exceeds the area oracle: {screen_pct:.4}% max {screen_max}"
    );
    assert!(
        screen_linear > 1.0,
        "screen half-scale collapsed onto linear-light filtering ({screen_linear:.4}%)"
    );
}
