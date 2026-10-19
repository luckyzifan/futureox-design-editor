//! E3 image-adjust chain: identity invariance, per-axis direction, a numeric
//! cross-check against a straight-line transcription of Figma's shader_62
//! (≤ 1/255 per channel), serde defaults, document validation and the CPU
//! sampler hook. Sources: figma-wasm-analysis/shaders/shader_62.glsl and
//! shaders/wgsl_116.wgsl (imageColorAdjustPaint).
use base64::Engine as _;
use futureox_design_kernel::image_adjust::ImageAdjust;
use futureox_design_kernel::math::{Point, Rect, Transform};
use futureox_design_kernel::paint::{Images, Sampler};
use futureox_design_kernel::scene::{Document, Node, Paint};

fn adjust(
    exposure: f64,
    contrast: f64,
    temperature: f64,
    tint: f64,
    highlights: f64,
    shadows: f64,
    color: f64,
) -> ImageAdjust {
    ImageAdjust {
        exposure,
        contrast,
        temperature,
        tint,
        highlights,
        shadows,
        color,
        highlight_shadow_threshold: 0.5,
    }
}

/// Independent straight-line transcription of shader_62's `ah()` (GLSL `b e
/// w i o d`), written unrolled per channel and using GLSL's `mix(x,y,t) =
/// x*(1-t)+y*t` definition. Any factoring mistake in `image_adjust.rs`
/// (operand order, matrix orientation, branch swap) shows up here.
fn reference_ah(
    rgb: [f32; 3],
    global_tint: f32,
    global_color: f32,
    global_shadows: f32,
    global_highlights: f32,
    global_exposure: f32,
    global_temperature: f32,
    global_contrast: f32,
    threshold: f32,
) -> [f32; 3] {
    let lum = |c: [f32; 3]| 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    // b(c): c = pow(c, 2.2)
    let mut c = [rgb[0].powf(2.2), rgb[1].powf(2.2), rgb[2].powf(2.2)];
    // e(c, shadows, highlights)
    let h = lum(c) - threshold.powf(2.2);
    let pick = if h > 0.0 { global_highlights } else { -global_shadows * 0.999 };
    let delta = 0.75 * h / (1.0 + 4.0 * h * h).sqrt() * pick;
    // w(c, temperature, tint, contrast) — XYZ via the column-major mat3
    // constructors evaluated as explicit row forms.
    let mut xyz = [
        0.4124564 * c[0] + 0.3575761 * c[1] + 0.1804375 * c[2],
        0.2126729 * c[0] + 0.7151522 * c[1] + 0.072175 * c[2],
        0.0193339 * c[0] + 0.119192 * c[1] + 0.9503041 * c[2],
    ];
    xyz[0] /= 0.95047;
    xyz[2] /= 1.08883;
    let mut f = [
        xyz[0].powf(1.0 / 3.0),
        xyz[1].powf(1.0 / 3.0),
        xyz[2].powf(1.0 / 3.0),
    ];
    let mut lab = [
        116.0 * f[1] - 16.0,
        500.0 * (f[0] - f[1]),
        200.0 * (f[1] - f[2]),
    ];
    lab[1] += 30.0 * global_tint;
    lab[2] += 30.0 * global_temperature;
    let ac = threshold * 100.0;
    let ad = 30.0;
    let ae = if global_contrast < 0.0 {
        (lab[0] - ac) * 0.2 + 50.0
    } else {
        lab[0]
    };
    let af = if global_contrast < 0.0 {
        lab[0]
    } else {
        let t = ((lab[0] - (ac - ad)) / ((ac + ad) - (ac - ad))).clamp(0.0, 1.0);
        t * t * t * (t * (t * 6.0 - 15.0) + 10.0) * 100.0
    };
    let ag = if global_contrast < 0.0 {
        global_contrast + 1.0
    } else {
        global_contrast
    };
    lab[0] = ae * (1.0 - ag) + af * ag;
    f[1] = (lab[0] + 16.0) / 116.0;
    f[0] = lab[1] / 500.0 + f[1];
    f[2] = f[1] - lab[2] / 200.0;
    let mut xyz = [f[0] * f[0] * f[0], f[1] * f[1] * f[1], f[2] * f[2] * f[2]];
    xyz[0] *= 0.95047;
    xyz[2] *= 1.08883;
    c = [
        (3.2404542 * xyz[0] - 1.5371385 * xyz[1] - 0.4985314 * xyz[2]).clamp(0.0, 1.0),
        (-0.9692660 * xyz[0] + 1.8760108 * xyz[1] + 0.0415560 * xyz[2]).clamp(0.0, 1.0),
        (0.0556434 * xyz[0] - 0.2040259 * xyz[1] + 1.0572252 * xyz[2]).clamp(0.0, 1.0),
    ];
    // i(c, exposure + delta)
    let j = global_exposure + delta;
    let k = 10.0_f32.powf(2.0 * j) - 1.0;
    let l = 0.75_f32;
    let mut m = 1.0 / (1.0 - l) - 1.0;
    let mut n = lum(c);
    let min_j = j.min(0.0);
    m *= 1.0 + n * n * min_j / (0.2 - min_j);
    for ch in 0..3 {
        c[ch] = c[ch] + (n - c[ch]) * l;
    }
    if j < 0.0 {
        for ch in 0..3 {
            c[ch] *= 1.0 + j / 16.0;
        }
        n *= 1.0 + j / 16.0;
    }
    for ch in 0..3 {
        c[ch] = c[ch] * (k + 1.0) / (c[ch] * k + 1.0);
    }
    n = n * (k + 1.0) / (n * k + 1.0);
    for ch in 0..3 {
        c[ch] = c[ch] + (c[ch] - n) * m;
    }
    for ch in 0..3 {
        c[ch] = c[ch].clamp(0.0, 1.0);
    }
    // o(c, clamp(globalColor,-1,1))
    let p = global_color.clamp(-1.0, 1.0);
    n = lum(c);
    if p <= 0.0 {
        for ch in 0..3 {
            c[ch] -= (n - c[ch]) * p;
        }
    } else {
        let q = n / (n - c[0].min(c[1]).min(c[2]) + 1e-6);
        let r = (1.0 - n) / (c[0].max(c[1]).max(c[2]) - n + 1e-6);
        let k = (1.0 * (1.0 - p) + p * q.min(r)).min(2.0);
        for ch in 0..3 {
            c[ch] += (n - c[ch]) * (1.0 - k);
        }
    }
    // d(c): pow 1/2.2 — the shader leaves `o`'s epsilon overshoot unclamped.
    [c[0].powf(1.0 / 2.2), c[1].powf(1.0 / 2.2), c[2].powf(1.0 / 2.2)]
}

fn sample_pixels() -> Vec<[f32; 3]> {
    let mut out = Vec::new();
    for r in 0..=16 {
        for g in 0..=16 {
            for b in 0..=16 {
                out.push([r as f32 / 16., g as f32 / 16., b as f32 / 16.]);
            }
        }
    }
    out
}

#[test]
fn identity_adjust_is_exact_zero_diff() {
    let identity = ImageAdjust::default();
    assert!(identity.is_identity());
    // Default deserialization is the identity with the 0.5 midpoint.
    let parsed: ImageAdjust = serde_json::from_str("{}").unwrap();
    assert_eq!(parsed, adjust(0., 0., 0., 0., 0., 0., 0.));
    assert_eq!(parsed.highlight_shadow_threshold, 0.5);
    for rgb in sample_pixels() {
        assert_eq!(identity.apply_srgb(rgb), rgb, "srgb identity moved {rgb:?}");
        assert_eq!(identity.apply_linear(rgb), rgb, "linear identity moved {rgb:?}");
    }
}

#[test]
fn identity_gate_covers_every_single_axis() {
    for a in [
        adjust(0.1, 0., 0., 0., 0., 0., 0.),
        adjust(0., -0.4, 0., 0., 0., 0., 0.),
        adjust(0., 0., 1.0, 0., 0., 0., 0.),
        adjust(0., 0., 0., -1.0, 0., 0., 0.),
        adjust(0., 0., 0., 0., 0.25, 0., 0.),
        adjust(0., 0., 0., 0., 0., 0.75, 0.),
        adjust(0., 0., 0., 0., 0., 0., -0.6),
    ] {
        assert!(!a.is_identity(), "{a:?}");
    }
    // A threshold alone never activates the math.
    let mut threshold_only = ImageAdjust::default();
    threshold_only.highlight_shadow_threshold = 0.8;
    assert!(threshold_only.is_identity());
}

#[test]
fn every_axis_moves_color_in_its_documented_direction() {
    let mid_gray = [0.5, 0.5, 0.5];
    let dark = [0.15, 0.15, 0.17];
    let bright = [0.85, 0.84, 0.82];
    // Headroom below 1.0 matters: the shader's max-channel factor
    // r=(1-n)/(max-n) is ~1 when a channel already sits at 1.0, so fully
    // clamped inputs barely saturate further (internal gamut guard, not a
    // porting bug).
    let red_green = [0.7_f32, 0.45, 0.25];
    let lum = |c: [f32; 3]| 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    // exposure + brightens, - darkens
    let up = adjust(0.5, 0., 0., 0., 0., 0., 0.).apply_srgb(mid_gray);
    let down = adjust(-0.5, 0., 0., 0., 0., 0., 0.).apply_srgb(mid_gray);
    assert!(lum(up) > lum(mid_gray) && lum(down) < lum(mid_gray));
    // shadows + lifts darks (below the 0.5 threshold), barely touches brights
    let lifted = adjust(0., 0., 0., 0., 0., 0.8, 0.).apply_srgb(dark);
    let untouched_bright = adjust(0., 0., 0., 0., 0., 0.8, 0.).apply_srgb(bright);
    assert!(lum(lifted) > lum(dark));
    assert!((lum(untouched_bright) - lum(bright)).abs() < 1. / 255.);
    // highlights + lifts brights, barely touches darks
    let hl = adjust(0., 0., 0., 0., 0.8, 0., 0.).apply_srgb(bright);
    let untouched_dark = adjust(0., 0., 0., 0., 0.8, 0., 0.).apply_srgb(dark);
    assert!(lum(hl) > lum(bright));
    assert!((lum(untouched_dark) - lum(dark)).abs() < 1. / 255.);
    // contrast + spreads: darks down, brights up around the midpoint
    let dark_c = adjust(0., 0.8, 0., 0., 0., 0., 0.).apply_srgb(dark);
    let bright_c = adjust(0., 0.8, 0., 0., 0., 0., 0.).apply_srgb(bright);
    assert!(lum(dark_c) < lum(dark) && lum(bright_c) > lum(bright));
    // contrast − compresses both towards the middle
    let dark_f = adjust(0., -0.8, 0., 0., 0., 0., 0.).apply_srgb(dark);
    let bright_f = adjust(0., -0.8, 0., 0., 0., 0., 0.).apply_srgb(bright);
    assert!(lum(dark_f) > lum(dark) && lum(bright_f) < lum(bright));
    // temperature + warms (Lab b+ → yellow: blue falls), − cools (blue rises)
    let warm = adjust(0., 0., 0.6, 0., 0., 0., 0.).apply_srgb(mid_gray);
    let cool = adjust(0., 0., -0.6, 0., 0., 0., 0.).apply_srgb(mid_gray);
    assert!(warm[2] < mid_gray[2] && cool[2] > mid_gray[2], "{warm:?} {cool:?}");
    // tint + is Lab a+ (magenta: green falls relative to red/blue), − green
    let magenta = adjust(0., 0., 0., 0.6, 0., 0., 0.).apply_srgb(mid_gray);
    let green = adjust(0., 0., 0., -0.6, 0., 0., 0.).apply_srgb(mid_gray);
    assert!(magenta[1] < mid_gray[1] && green[1] > mid_gray[1], "{magenta:?} {green:?}");
    // color + saturates (channels spread), − desaturates (towards luminance)
    let saturated = adjust(0., 0., 0., 0., 0., 0., 0.8).apply_srgb(red_green);
    let desaturated = adjust(0., 0., 0., 0., 0., 0., -0.8).apply_srgb(red_green);
    let spread = |c: [f32; 3]| c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2]);
    assert!(spread(saturated) > spread(red_green));
    assert!(spread(desaturated) < spread(red_green));
}

#[test]
fn ported_math_matches_shader62_reference_within_one_255th() {
    let pixels = sample_pixels();
    let mut worst: f32 = 0.;
    let mut cases = 0;
    let mut check = |a: ImageAdjust, threshold: f32| {
        for &rgb in &pixels {
            let ours = ImageAdjust {
                highlight_shadow_threshold: threshold as f64,
                ..a
            }
            .apply_srgb(rgb);
            let reference = reference_ah(
                rgb,
                a.tint as f32,
                a.color as f32,
                a.shadows as f32,
                a.highlights as f32,
                a.exposure as f32,
                a.temperature as f32,
                a.contrast as f32,
                threshold as f32,
            );
            for ch in 0..3 {
                let diff = (ours[ch] - reference[ch]).abs();
                assert!(
                    diff <= 1.0 / 255.0 + 1e-6,
                    "channel {ch} off by {diff} for {rgb:?} with {a:?} t={threshold}"
                );
                worst = worst.max(diff);
            }
            cases += 1;
        }
    };
    // Each axis alone, positive and negative.
    for v in [1.0_f64, 0.6, 0.3, -0.3, -0.6, -1.0] {
        check(adjust(v, 0., 0., 0., 0., 0., 0.), 0.5);
        check(adjust(0., v, 0., 0., 0., 0., 0.), 0.5);
        check(adjust(0., 0., v, 0., 0., 0., 0.), 0.5);
        check(adjust(0., 0., 0., v, 0., 0., 0.), 0.5);
        check(adjust(0., 0., 0., 0., v, 0., 0.), 0.5);
        check(adjust(0., 0., 0., 0., 0., v, 0.), 0.5);
        check(adjust(0., 0., 0., 0., 0., 0., v), 0.5);
    }
    // Combined poses and non-default thresholds.
    for threshold in [0.2, 0.5, 0.8] {
        check(adjust(0.4, -0.35, 0.3, -0.2, 0.45, 0.6, -0.25), threshold);
        check(adjust(-0.5, 0.7, -0.45, 0.5, -0.3, -0.4, 0.85), threshold);
        check(adjust(1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0), threshold);
        check(adjust(-1.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0), threshold);
    }
    eprintln!("shader_62 cross-check: {cases} pixels, worst |Δ| = {worst:.8}");
    assert!(cases > 100_000);
}

#[test]
fn linear_core_equals_srgb_pipeline_between_the_gammas() {
    // Running the sRGB pipeline on x must equal running the linear core on
    // pow(x,2.2) then re-encoding — that is the managed-domain equivalence.
    for rgb in sample_pixels().into_iter().step_by(97) {
        let a = adjust(0.35, -0.5, 0.4, 0.2, 0.6, -0.3, 0.45);
        let srgb = a.apply_srgb(rgb);
        let relinear = a.apply_linear(rgb.map(|v| v.powf(2.2)));
        for ch in 0..3 {
            assert!(
                (srgb[ch] - relinear[ch].powf(1.0 / 2.2)).abs() <= 1. / 255.,
                "domain split diverged for {rgb:?}"
            );
        }
    }
}

fn gradient_png(w: u32, h: u32) -> String {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut data = Vec::new();
        for y in 0..h {
            for x in 0..w {
                data.extend([
                    (x * 255 / w.max(1)) as u8,
                    (y * 255 / h.max(1)) as u8,
                    96,
                    255,
                ]);
            }
        }
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&data)
            .unwrap();
    }
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn image_node(uri: &str, adjust: Option<ImageAdjust>) -> (Document, Paint, Node) {
    let doc: Document = serde_json::from_value(serde_json::json!({
        "schemaVersion":13,"id":"0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b","name":"a",
        "pages":[{"id":"p","name":"p","children":["n"],"background":"#ffffff"}],
        "nodes":{"n":{"id":"n","kind":"rectangle","width":8,"height":8,
            "fills":[{"kind":"image","color":"#000000","image":uri,"adjust":adjust}]}}
    }))
    .unwrap();
    let node = doc.nodes["n"].clone();
    (doc, node.fills[0].clone(), node)
}

#[test]
fn sampler_applies_adjustments_after_sampling_and_identity_is_bit_equal() {
    let uri = gradient_png(8, 8);
    let rect = Rect::new(0, 0, 8, 8);
    let matrix = Transform([1., 0., 0., 1., 0., 0.]);
    let (_, plain_paint, node) = image_node(&uri, None);
    let mut images = Images::default();
    let plain = Sampler::new(&plain_paint, &node, matrix, rect, &mut images).unwrap();
    // An authored identity adjust takes the exact same code path (bit-equal).
    let (_, identity_paint, node2) = image_node(&uri, Some(ImageAdjust::default()));
    let identity = Sampler::new(&identity_paint, &node2, matrix, rect, &mut images).unwrap();
    let (_, exposure_paint, node3) = image_node(&uri, Some(adjust(0.5, 0., 0., 0., 0., 0., 0.)));
    let exposure = Sampler::new(&exposure_paint, &node3, matrix, rect, &mut images).unwrap();
    let (_, warm_paint, node4) = image_node(&uri, Some(adjust(0., 0., 0.6, 0., 0., 0., 0.)));
    let warm = Sampler::new(&warm_paint, &node4, matrix, rect, &mut images).unwrap();
    for y in 0..8 {
        for x in 0..8 {
            let device = Point::new(x as f64 + 0.5, y as f64 + 0.5);
            let base = plain.at(device);
            assert_eq!(identity.at(device), base, "identity adjust changed a pixel");
            let brighter = exposure.at(device);
            assert!(
                brighter.0[0] >= base.0[0] && brighter.0[1] >= base.0[1],
                "exposure+ darkened a channel at ({x},{y})"
            );
            let warmed = warm.at(device);
            assert!(
                warmed.0[2] <= base.0[2] || base.0[2] <= 0.,
                "temperature+ raised blue at ({x},{y})"
            );
            // Byte path (SDR quantized sampling) shares the direction.
            let byte_base = plain.at_rgba8(device);
            let byte_identity = identity.at_rgba8(device);
            assert_eq!(byte_identity, byte_base);
            let byte_brighter = exposure.at_rgba8(device);
            assert!(byte_brighter.0[0] >= byte_base.0[0]);
        }
    }
    // Serialization round-trip keeps the authored values.
    let round: Paint = serde_json::from_value(serde_json::to_value(&exposure_paint).unwrap()).unwrap();
    assert_eq!(round.adjust, exposure_paint.adjust);
    // Old documents without the field deserialize to identity-absent.
    assert_eq!(plain_paint.adjust, None);
}

#[test]
fn document_validation_gates_schema_kind_and_ranges() {
    let uri = gradient_png(4, 4);
    let build = |schema: u32, kind: &str, adjust: Option<ImageAdjust>| {
        serde_json::from_value::<Document>(serde_json::json!({
            "schemaVersion":schema,"id":"0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b","name":"a",
            "pages":[{"id":"p","name":"p","children":["n"],"background":"#ffffff"}],
            "nodes":{"n":{"id":"n","kind":"rectangle","width":8,"height":8,
                "fills":[{"kind":kind,"color":"#000000","image":uri,"adjust":adjust}]}}
        }))
        .unwrap()
    };
    build(13, "image", Some(adjust(0.5, 0., 0., 0., 0., 0., 0.)))
        .validate()
        .unwrap();
    let err = build(12, "image", Some(adjust(0.5, 0., 0., 0., 0., 0., 0.)))
        .validate()
        .unwrap_err();
    assert!(err.contains("schema 13"), "{err}");
    let err = build(13, "solid", Some(adjust(0.5, 0., 0., 0., 0., 0., 0.)))
        .validate()
        .unwrap_err();
    assert!(err.contains("image paint"), "{err}");
    let mut out_of_range = adjust(0., 0., 0., 0., 0., 0., 0.);
    out_of_range.exposure = 1.5;
    let err = build(13, "image", Some(out_of_range))
        .validate()
        .unwrap_err();
    assert!(err.contains("image paint"), "{err}");
    let mut bad_threshold = adjust(0., 0., 0., 0., 0., 0., 0.);
    bad_threshold.highlight_shadow_threshold = 1.2;
    assert!(build(13, "image", Some(bad_threshold))
        .validate()
        .is_err());
    assert!(build(13, "image", None).validate().is_ok());
}
