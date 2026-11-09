//! Full-image controls, independent of the internal cross-backend gate.
//! Original Figma browser exports are compared byte for byte; no tolerance.
use futureox_design_kernel::figma_gradient::{LinearGradient, noise_at_pixel};
use futureox_design_kernel::figma_sampling::{GradientStop, encode_unorm8};

#[test]
fn valid_tiny_gradient_uses_general_coordinates_when_fixed_precision_cannot_fit() {
    use futureox_design_kernel::{fixed_gradient::FixedGradient, math::{Rect, Transform}, scene::Paint};
    let paint: Paint = serde_json::from_value(serde_json::json!({"kind":"linear","color":"#000000",
        "stops":[{"offset":0,"color":"#000000"},{"offset":1,"color":"#ffffff"}]})).unwrap();
    assert!(FixedGradient::new(&paint, Transform([1e9,0.,0.,1e9,0.,0.]), [0.01,0.01], Rect::new(0,0,512,512)).unwrap().is_none());
    assert!(FixedGradient::new(&paint, Transform::default(), [100.,100.], Rect::new(0,0,512,512)).unwrap().is_some());
}

#[test]
fn imported_stop_alpha_enters_the_measured_lookup_as_straight_rgba() {
    let paint = serde_json::from_value(serde_json::json!({"kind":"linear","color":"#000000",
        "stops":[{"offset":0,"color":"color(srgb 0.2 0.4 0.8 / 0.0001)"},
            {"offset":1,"color":"color(srgb 0.8 0.4 0.2 / 0.75)"}]})).unwrap();
    let actual = futureox_design_kernel::figma_gradient::from_paint(&paint).unwrap();
    let expected = LinearGradient::new(&[
        GradientStop { offset: 0., color: [0.2, 0.4, 0.8, 0.0001] },
        GradientStop { offset: 1., color: [0.8, 0.4, 0.2, 0.75] },
    ]).unwrap();
    assert_eq!(actual.lookup_bytes(), expected.lookup_bytes());
}

#[test]
fn normalized_axis_matrices_share_the_measured_gradient_coordinates() {
    use futureox_design_kernel::{
        figma_gradient::{Coordinates, supported},
        math::{Rect, Transform},
        scene::Paint,
    };
    let raw = serde_json::json!({"id":"axis","kind":"linear","color":"#000000","opacity":1,"visible":true,
        "angle":0,"blend":"normal","fit":"cover","stops":[{"offset":0,"color":"#000000"},{"offset":1,"color":"#ffffff"}]});
    let original: Paint = serde_json::from_value(raw).unwrap();
    for (angle, matrix) in [
        (0., [1., 0., 0., 1., 0., 0.]),
        (90., [0., 1., -1., 0., 1., 0.]),
    ] {
        let mut angle_paint = original.clone();
        angle_paint.angle = angle;
        let mut matrix_paint = original.clone();
        matrix_paint.angle = 23.;
        matrix_paint.transform = Some(Transform(matrix));
        let world = Transform([2., 0., 0., 2., 13.25, -9.5]);
        assert!(supported(&matrix_paint, world));
        for software in [false, true] {
            for sample in 0..4 {
                let rect = Rect::new(-8, 4, 24, 16);
                let a = Coordinates::with_raster(
                    rect,
                    world,
                    [71., 39.],
                    &angle_paint,
                    sample,
                    software,
                )
                .unwrap();
                let b = Coordinates::with_raster(
                    rect,
                    world,
                    [71., 39.],
                    &matrix_paint,
                    sample,
                    software,
                )
                .unwrap();
                for y in 4..20 {
                    for x in -8..16 {
                        assert_eq!(
                            a.at(x, y).unwrap().map(f32::to_bits),
                            b.at(x, y).unwrap().map(f32::to_bits)
                        );
                    }
                }
            }
        }
        assert_eq!(matrix_paint.transform, Some(Transform(matrix)));
        matrix_paint.transform.as_mut().unwrap().0[4] += 0.0001;
        assert!(
            !supported(&matrix_paint, world),
            "nearby authored transforms must keep their general sampler"
        );
    }
}

#[test]
fn dither_matches_independent_native_math_readbacks() {
    // Independent M2 Pro Metal arithmetic kernel, 2026-10-08, no image inputs.
    // Complete 512x512 validation also compares the software and native noise
    // bit patterns, rather than only their post-quantization image colors.
    let vectors = [
        ([0, 0], 0x3e380000),
        ([1, 0], 0x3ef00000),
        ([0, 1], 0x3f2a0000),
        ([1, 1], 0x3de80000),
        ([15, 17], 0x3cf00000),
        ([33, 65], 0x3e440000),
        ([127, 128], 0x3f020000),
        ([255, 255], 0x3e2f8000),
        ([256, 256], 0x3e8b8000),
        ([511, 511], 0x3e3c0000),
        ([511, 0], 0x3f7f0000),
        ([0, 511], 0x3ed20000),
        ([374, 392], 0x3f370000),
        ([97, 243], 0x3f3d8000),
        ([412, 9], 0x3ea00000),
        ([23, 478], 0x3f02c000),
    ];
    for (pixel, expected) in vectors {
        assert_eq!(
            noise_at_pixel(pixel).unwrap().to_bits(),
            expected,
            "{pixel:?}"
        );
    }
    use sha2::{Digest, Sha256};
    let mut full_grid = Sha256::new();
    for y in 0..512 {
        for x in 0..512 {
            full_grid.update(noise_at_pixel([x, y]).unwrap().to_le_bytes());
        }
    }
    // Digest of all 262144 raw native float32 values, generated without PNGs.
    assert_eq!(
        (full_grid.finalize()).iter().map(|b| format!("{b:02x}")).collect::<String>(),
        "2caf992618c5684f762ad7fc376ba4ff1076e5cead5c7066ae80d5864987ac62"
    );
}

#[test]
fn invalid_source_inputs_are_errors() {
    assert!(LinearGradient::new(&[]).is_err());
    assert!(noise_at_pixel([8_388_608, 0]).is_err());
    let paint = LinearGradient::new(&[
        GradientStop {
            offset: 0.0,
            color: [0.0, 0.0, 0.0, 1.0],
        },
        GradientStop {
            offset: 1.0,
            color: [1.0; 4],
        },
    ])
    .unwrap();
    assert!(paint.sample(f32::NAN).is_err());
    assert!(paint.paint(0.5, -0.1, [0, 0]).is_err());
    assert!(paint.paint(0.5, f32::INFINITY, [0, 0]).is_err());
    assert_eq!(paint.paint(0.5, 0.0, [0, 0]).unwrap(), [0.0; 4]);
}

pub(crate) struct Control {
    pub name: &'static str,
    pub directory: &'static str,
    pub width: usize,
    pub height: usize,
    pub start: [f32; 4],
    pub end: [f32; 4],
    pub opacity: f32,
    pub strip: bool,
}

pub(crate) fn controls() -> Vec<Control> {
    let mut cases = Vec::new();
    for (name, start, end, width, opacity) in [
        ("NumericQA-red-low", 0.0, 0.5, 128, 1.0),
        ("NumericQA-red-high", 0.5, 1.0, 128, 1.0),
        ("NumericQA-red-middle", 0.25, 0.75, 128, 1.0),
        ("NumericQA-red-reverse", 1.0, 0.0, 128, 1.0),
        ("NumericQA-red-wide", 0.0, 1.0, 129, 1.0),
        ("NumericQA-red-alpha", 0.0, 1.0, 128, 0.5),
    ] {
        cases.push(Control {
            name,
            directory: "numeric-controls-2026-10-08",
            width,
            height: 128,
            start: [start, 119.0 / 255.0, 0.5, 1.0],
            end: [end, 119.0 / 255.0, 0.5, 1.0],
            opacity,
            strip: false,
        });
    }
    for (name, red) in [
        ("NumericQA-green-ramp", 119.0 / 255.0),
        ("NumericQA-green-ramp-red75", 0.75),
    ] {
        cases.push(Control {
            name,
            directory: "numeric-controls-2026-10-08",
            width: 128,
            height: 128,
            start: [red, 0.0, 0.5, 1.0],
            end: [red, 1.0, 0.5, 1.0],
            opacity: 1.0,
            strip: false,
        });
    }
    for (name, size) in [("ExactQA-red-ramp-1x", 128), ("ExactQA-red-ramp-2x", 256)] {
        cases.push(Control {
            name,
            directory: "exact-controls-2026-10-08",
            width: size,
            height: size,
            start: [0.0, 119.0 / 255.0, 0.5, 1.0],
            end: [1.0, 119.0 / 255.0, 0.5, 1.0],
            opacity: 1.0,
            strip: false,
        });
    }
    cases.push(Control {
        name: "NumericQA-color-strip",
        directory: "numeric-refined-2026-10-08",
        width: 128,
        height: 132,
        start: [0.0, 0.0, 0.5, 1.0],
        end: [0.0, 1.0, 0.5, 1.0],
        opacity: 1.0,
        strip: true,
    });
    cases
}

pub(crate) fn render_control(case: &Control) -> Vec<u8> {
    let gradients: Vec<_> = (0..if case.strip { 33 } else { 1 })
        .map(|i| {
            let mut start = case.start;
            let mut end = case.end;
            if case.strip {
                start[0] = i as f32 / 32.0;
                end[0] = start[0];
            }
            LinearGradient::new(&[
                GradientStop {
                    offset: 0.0,
                    color: start,
                },
                GradientStop {
                    offset: 1.0,
                    color: end,
                },
            ])
            .unwrap()
        })
        .collect();
    let mut output = vec![0_u8; case.width * case.height * 4];
    let offsets = [
        [0.625, 0.875],
        [0.375, 0.125],
        [0.125, 0.625],
        [0.875, 0.375],
    ];
    for (pass, sample) in offsets.iter().enumerate() {
        let alpha = (1.0_f64 / (pass + 1) as f64) as f32;
        for y in 0..case.height {
            for x in 0..case.width {
                let mut sum = [0_u32; 4];
                for dy in 0..2 {
                    for dx in 0..2 {
                        let sx = (x * 2 + dx) as u32;
                        let sy = (y * 2 + dy) as u32;
                        let t = (sx as f32 + sample[0]) / (case.width * 2) as f32;
                        let gradient = &gradients[if case.strip { y / 4 } else { 0 }];
                        let color = gradient.paint(t, case.opacity, [sx, sy]).unwrap();
                        for c in 0..4 {
                            sum[c] += u32::from(encode_unorm8(color[c]));
                        }
                    }
                }
                for (c, total) in sum.iter().enumerate() {
                    let index = (y * case.width + x) * 4 + c;
                    let source = (f64::from(*total) / 1020.0) as f32;
                    let previous = (f64::from(output[index]) / 255.0) as f32;
                    let difference = source - previous;
                    let accumulated =
                        (f64::from(difference) * f64::from(alpha) + f64::from(previous)) as f32;
                    output[index] = (f64::from(accumulated) * 255.0).round_ties_even() as u8;
                }
            }
        }
    }
    // PNG stores straight RGBA only after the final premultiplied RGBA8 frame.
    for rgba in output.chunks_exact_mut(4) {
        if rgba[3] != 0 && rgba[3] != 255 {
            for c in 0..3 {
                rgba[c] = (f64::from(rgba[c]) * 255.0 / f64::from(rgba[3]))
                    .round_ties_even()
                    .min(255.0) as u8;
            }
        }
    }
    output
}

#[test]
fn eleven_real_figma_gradient_pngs_match_every_rgba_byte() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let base = root.join("frontend/design-client/public/fidelity");
    let mut total_pixels = 0;
    for case in controls() {
        let actual = render_control(&case);
        let path = base.join(case.directory).join(format!("{}.png", case.name));
        let expected = image::open(path).unwrap().into_rgba8();
        assert_eq!(
            expected.dimensions(),
            (case.width as u32, case.height as u32)
        );
        let differing = actual
            .iter()
            .zip(expected.as_raw())
            .filter(|(a, b)| a != b)
            .count();
        assert_eq!(differing, 0, "{}: full RGBA byte differences", case.name);
        total_pixels += case.width * case.height;
    }
    assert_eq!(total_pixels, 230_016);
}

#[test]
fn offset_diagonal_gradient_matches_original_export_through_engine() {
    use futureox_design_kernel::{Engine, RenderOptions};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let directory = root.join("frontend/design-client/public/fidelity/optics-combined-2026-10-08");
    let cases: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.join("cases.json")).unwrap()).unwrap();
    let case = cases
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "MaterialQA-texture-neutral")
        .unwrap();
    let mut engine = Engine::new();
    engine.load_document(&case["document"].to_string()).unwrap();
    let mut options = case["options"].clone();
    options["rasterProfile"] = serde_json::json!("figma");
    let options: RenderOptions = serde_json::from_value(options).unwrap();
    let pixels = engine.render(&options).unwrap();
    let expected = image::open(directory.join(case["reference"].as_str().unwrap()))
        .unwrap()
        .into_rgba8();
    assert_eq!(pixels, expected.as_raw().as_slice());
}

/// Independent colour/export contract for the three official phase controls.
/// This deliberately accepts raw continuous SRGB stops, including blue=0.5.
/// It does not convert them to hex or claim to exercise the document renderer.
fn render_phase_control(record: &serde_json::Value, isolated: bool) -> Vec<u8> {
    let width = record["width"].as_u64().unwrap() as usize;
    let height = record["height"].as_u64().unwrap() as usize;
    let layer = &record["children"][0];
    let left = layer["x"].as_u64().unwrap() as usize;
    let top = layer["y"].as_u64().unwrap() as usize;
    let node = if isolated {
        &layer["children"][0]
    } else {
        layer
    };
    let node_width = node["width"].as_u64().unwrap() as usize;
    let node_height = node["height"].as_u64().unwrap() as usize;
    let opacity = layer["opacity"].as_f64().unwrap() as f32;
    assert_eq!(opacity, if isolated { 0.625 } else { 1. });
    let stops = node["fills"][0]["gradientStops"].as_array().unwrap();
    let stops: Vec<_> = stops
        .iter()
        .map(|stop| {
            let color = &stop["color"];
            GradientStop {
                offset: stop["position"].as_f64().unwrap() as f32,
                color: ["r", "g", "b", "a"].map(|channel| color[channel].as_f64().unwrap() as f32),
            }
        })
        .collect();
    assert_eq!(stops[0].color, [0., 119. / 255., 0.5, 1.]);
    assert_eq!(stops[1].color, [1., 119. / 255., 0.5, 1.]);
    let gradient = LinearGradient::new(&stops).unwrap();
    let mut output = vec![255u8; width * height * 4];
    for (pass, sample) in [
        [0.625f32, 0.875],
        [0.375, 0.125],
        [0.125, 0.625],
        [0.875, 0.375],
    ]
    .iter()
    .enumerate()
    {
        let weight = (1f64 / (pass + 1) as f64) as f32;
        for y in top..top + node_height {
            for x in left..left + node_width {
                let mut sum = [0u32; 4];
                for dy in 0..2 {
                    for dx in 0..2 {
                        let sx = x * 2 + dx;
                        let sy = y * 2 + dy;
                        let t = ((sx - left * 2) as f32 + sample[0]) / (node_width * 2) as f32;
                        // Hash uses the export tile's fragment centre, even
                        // for the node offset and the opacity-isolated group.
                        let color = gradient
                            .paint(t, 1., [(sx % 512) as u32, (sy % 512) as u32])
                            .unwrap();
                        let mut pixel = color.map(encode_unorm8);
                        if isolated {
                            // The group has its own RGBA8 colour stage before
                            // opacity. Apply ordinary source-over onto white
                            // within each jitter pass, before export resolve.
                            let source = pixel.map(|v| (f32::from(v) / 255.) * opacity);
                            let inverse = 1. - source[3];
                            pixel = source
                                .map(|v| encode_unorm8((f64::from(inverse) + f64::from(v)) as f32));
                        }
                        for (total, value) in sum.iter_mut().zip(pixel) {
                            *total += u32::from(value);
                        }
                    }
                }
                for (c, total) in sum.into_iter().enumerate() {
                    let index = (y * width + x) * 4 + c;
                    let source = (f64::from(total) / 1020.) as f32;
                    let previous = (f64::from(output[index]) / 255.) as f32;
                    let difference = source - previous;
                    let accumulated =
                        (f64::from(difference) * f64::from(weight) + f64::from(previous)) as f32;
                    output[index] = encode_unorm8(accumulated);
                }
            }
        }
    }
    output
}

#[test]
fn large_offset_and_isolated_phase_controls_match_all_284121_pixels() {
    use sha2::{Digest, Sha256};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let directory = root.join("frontend/design-client/public/fidelity/phase-controls-2026-10-08");
    let fixture: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("testing/fixtures/design/figma-phase-controls-2026-10-08.json"))
            .unwrap(),
    )
    .unwrap();
    let mut total_pixels = 0;
    for (name, dimensions, isolated, sha256) in [
        (
            "PhaseQA-main-513x257",
            (513, 257),
            false,
            "ad94728d8e2cd47982fbb2ee88682b604cf0a5bc4506e88131587da66c31100b",
        ),
        (
            "PhaseQA-offset-282x270",
            (282, 270),
            false,
            "da0fca5a31b78321f2aa1891077ff0e1105ba415789903bbdceca70869ee1a5d",
        ),
        (
            "PhaseQA-isolated-282x270",
            (282, 270),
            true,
            "6bfc9cb388649e835ef60bfc3d24deec5585f9e69005acffc7c0975abc404cc2",
        ),
    ] {
        let original = std::fs::read(directory.join(format!("{name}.png"))).unwrap();
        assert_eq!(
            (Sha256::digest(&original)).iter().map(|b| format!("{b:02x}")).collect::<String>(),
            sha256,
            "original Figma PNG changed: {name}"
        );
        let expected = image::load_from_memory(&original).unwrap().into_rgba8();
        assert_eq!(expected.dimensions(), dimensions);
        let record = fixture["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == name)
            .unwrap();
        let actual = render_phase_control(record, isolated);
        assert_eq!(actual.len(), expected.as_raw().len());
        let differing = actual
            .iter()
            .zip(expected.as_raw())
            .filter(|(a, b)| a != b)
            .count();
        assert_eq!(differing, 0, "{name}: full RGBA byte differences");
        total_pixels += dimensions.0 * dimensions.1;
    }
    assert_eq!(total_pixels, 284_121);
}
