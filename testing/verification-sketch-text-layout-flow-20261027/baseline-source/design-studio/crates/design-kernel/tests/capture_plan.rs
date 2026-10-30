use futureox_design_kernel::capture_plan::{
    CaptureInput, CapturePlan, CapturePlanError, MAX_TILE_PIXELS, compile,
};

// Numeric results from an isolated pure-math oracle with synthetic memory.
// No renderer, application startup, imported callback, or reference PNG was
// used to generate these expected bits. Original runtime SHA-256:
// f3b4cfa9a732fdb66f6650212aab065e9e9d7818f952619247b00c3d47a236f9
// Full evidence covers 155 initial inputs and 12 rounding-boundary inputs.
// This representative subset covers
// scale quantization, fractional radii, both caps, affine composition, and the
// branch that retains an unquantized scale. The final two oracle words only
// copy caller metadata and are not part of this module's numeric output.
struct Vector {
    name: &'static str,
    support: u32,
    blur: u32,
    target_pixels: u32,
    source_pixels: u32,
    divisor: u32,
    transform: [u32; 6],
    bounds: [u32; 4],
    expected: [u32; 16],
}

const VECTORS: &[Vector] = &[
    Vector {
        name: "unit_frost",
        support: 0x3b800000,
        blur: 0x3b800000,
        target_pixels: 512,
        source_pixels: 512,
        divisor: 1,
        transform: [
            0x3b800000, 0x00000000, 0x00000000, 0x00000000, 0x3b800000, 0x00000000,
        ],
        bounds: [0x00000000, 0x00000000, 0x3f800000, 0x3f800000],
        expected: [
            0x3ffe03f8, 0x3b7e0000, 0x00000000, 0x3b800000, 0x00000000, 0x3b7e0000, 0x3b800000,
            0x3f7e0000, 0xffffffff, 0xffffffff, 0x00000202, 0x00000202, 0x38000000, 0x38000000,
            0x3f7ffe00, 0x3f7ffe00,
        ],
    },
    Vector {
        name: "fractional_frost",
        support: 0x3bc00000,
        blur: 0x3bc00000,
        target_pixels: 512,
        source_pixels: 512,
        divisor: 1,
        transform: [
            0x3b800000, 0x00000000, 0x00000000, 0x00000000, 0x3b800000, 0x00000000,
        ],
        bounds: [0x00000000, 0x00000000, 0x3f800000, 0x3f800000],
        expected: [
            0x403dc6ac, 0x3b7d0000, 0x00000000, 0x3bc00000, 0x00000000, 0x3b7d0000, 0x3bc00000,
            0x3f7d0000, 0xffffffff, 0xffffffff, 0x00000202, 0x00000202, 0x38900000, 0x38900000,
            0x3f7ffb80, 0x3f7ffb80,
        ],
    },
    Vector {
        name: "half_density",
        support: 0x3e800000,
        blur: 0x3e800000,
        target_pixels: 512,
        source_pixels: 512,
        divisor: 1,
        transform: [
            0x3c800000, 0x00000000, 0x00000000, 0x00000000, 0x3c800000, 0x00000000,
        ],
        bounds: [0x00000000, 0x00000000, 0x3f800000, 0x3f800000],
        expected: [
            0x42800000, 0x3c000000, 0x00000000, 0x3e800000, 0x00000000, 0x3c000000, 0x3e800000,
            0x3f000000, 0x0000003f, 0x0000003f, 0x00000182, 0x00000182, 0x3e000000, 0x3e000000,
            0x3f600000, 0x3f600000,
        ],
    },
    Vector {
        name: "minimum_support",
        support: 0x00000000,
        blur: 0x33d6bf95,
        target_pixels: 256,
        source_pixels: 256,
        divisor: 1,
        transform: [
            0x3b000000, 0x3e800000, 0xbec00000, 0xbe000000, 0x3b19999a, 0x3f400000,
        ],
        bounds: [0xbe800000, 0x3e000000, 0x3f733333, 0x3fc00000],
        expected: [
            0x37d651db, 0x3aff0000, 0x3e7f0000, 0xbebe4000, 0xbdff0000, 0x3b190000, 0x3f3fc000,
            0x3f7f0000, 0xffffffbf, 0x0000001f, 0x00000135, 0x00000161, 0xbe7e051f, 0x3e007ae1,
            0x3f730148, 0x3fbfa0a4,
        ],
    },
    Vector {
        name: "larger_support_and_divisor",
        support: 0x3b03126f,
        blur: 0x3a03126f,
        target_pixels: 256,
        source_pixels: 512,
        divisor: 4,
        transform: [
            0x3b000000, 0x3e800000, 0xbec00000, 0xbe000000, 0x3b19999a, 0x3f400000,
        ],
        bounds: [0xbe800000, 0x3e000000, 0x3f733333, 0x3fc00000],
        expected: [
            0x3e010204, 0x3afc0000, 0x3e7c0000, 0xbeb90000, 0xbdfc0000, 0x3b173334, 0x3f3f0000,
            0x3f7c0000, 0xffffffc1, 0x00000020, 0x00000132, 0x0000015e, 0xbe760419, 0x3e03fbe7,
            0x3f71e76c, 0x3fbe4083,
        ],
    },
    Vector {
        name: "count_cap",
        support: 0x00000000,
        blur: 0x3f800000,
        target_pixels: 256,
        source_pixels: 256,
        divisor: 1,
        transform: [
            0x3b800000, 0x3e800000, 0xbec00000, 0xbe000000, 0x3b99999a, 0x3f400000,
        ],
        bounds: [0x00000000, 0x00000000, 0x3f800000, 0x3f800000],
        expected: [
            0x42800000, 0x3a800000, 0x3d800000, 0x3e900000, 0xbd000000, 0x3a99999a, 0x3f100000,
            0x3e800000, 0x0000001f, 0x0000001f, 0x000000c2, 0x000000c2, 0x3e000000, 0x3e000000,
            0x3f600000, 0x3f600000,
        ],
    },
    Vector {
        name: "unquantized_scale",
        support: 0x42800000,
        blur: 0x42800000,
        target_pixels: 256,
        source_pixels: 2048,
        divisor: 1,
        transform: [
            0x3b800000, 0x3e800000, 0xbec00000, 0xbe000000, 0x3b99999a, 0x3f400000,
        ],
        bounds: [0x00000000, 0x00000000, 0x3f800000, 0x3f800000],
        expected: [
            0x42800000, 0x37800000, 0x3a800000, 0x3efe4000, 0xba000000, 0x3799999a, 0x3f004000,
            0x3b800000, 0xffffffff, 0xffffffff, 0x00000102, 0x00000102, 0x3afc0800, 0x3afc0800,
            0x3f7f81fc, 0x3f7f81fc,
        ],
    },
    Vector {
        name: "source_support_cap",
        support: 0x43800000,
        blur: 0x42800000,
        target_pixels: 2048,
        source_pixels: 2048,
        divisor: 8,
        transform: [
            0x3dcccccd, 0x3e800000, 0xbec00000, 0xbe000000, 0x3df5c290, 0x3f400000,
        ],
        bounds: [0x00000000, 0x00000000, 0x3f800000, 0x3f800000],
        expected: [
            0x41fe0000, 0x37cb3333, 0x387e0000, 0x3effe438, 0xb7fe0000, 0x37f3d70b, 0x3f0003f8,
            0x397e0000, 0x00000380, 0x00000380, 0x00000100, 0x00000100, 0x3ee03020, 0x3ee03020,
            0x3f0fe7f0, 0x3f0fe7f0,
        ],
    },
];

fn input(vector: &Vector) -> CaptureInput {
    CaptureInput {
        normalized_support: f32::from_bits(vector.support),
        normalized_blur: f32::from_bits(vector.blur),
        target_pixels: vector.target_pixels,
        source_pixels: vector.source_pixels,
        divisor: vector.divisor,
        transform: vector.transform.map(f32::from_bits),
        bounds: vector.bounds.map(f32::from_bits),
    }
}

fn words(plan: CapturePlan) -> [u32; 16] {
    let mut out = [0; 16];
    out[0] = plan.kernel_count.to_bits();
    out[1..7].copy_from_slice(&plan.transform.map(f32::to_bits));
    out[7] = plan.density.to_bits();
    out[8..12].copy_from_slice(&plan.pixel_bounds.map(|v| v as u32));
    out[12..16].copy_from_slice(&plan.expanded_bounds.map(f32::to_bits));
    out
}

#[test]
fn capture_plan_matches_independent_raw_bits() {
    for vector in VECTORS {
        let plan = compile(input(vector)).expect(vector.name);
        assert_eq!(words(plan), vector.expected, "{}", vector.name);
        assert!(plan.normalized_padding.is_finite() && plan.normalized_padding > 0.);
    }
}

#[test]
fn count_is_not_recomputed_from_quantized_density() {
    let input = input(&VECTORS[0]);
    let plan = compile(input).unwrap();
    assert_eq!(plan.kernel_count.to_bits(), 0x3ffe03f8);
    assert_eq!(plan.normalized_padding.to_bits(), 0x3b7e0000);
    let recomputed = input.normalized_blur * input.target_pixels as f32 * plan.density;
    assert_ne!(plan.kernel_count.to_bits(), recomputed.to_bits());
}

#[test]
fn tile_configuration_is_explicit_and_checked() {
    let valid = input(&VECTORS[0]);
    for invalid in [
        CaptureInput {
            target_pixels: 0,
            ..valid
        },
        CaptureInput {
            source_pixels: 0,
            ..valid
        },
        CaptureInput {
            divisor: 0,
            ..valid
        },
        CaptureInput {
            source_pixels: 3,
            divisor: 1,
            ..valid
        },
        CaptureInput {
            target_pixels: MAX_TILE_PIXELS + 1,
            ..valid
        },
        CaptureInput {
            divisor: MAX_TILE_PIXELS + 1,
            ..valid
        },
    ] {
        assert_eq!(
            compile(invalid).unwrap_err(),
            CapturePlanError::InvalidTileConfiguration
        );
    }
}

#[test]
fn invalid_numeric_inputs_are_errors() {
    let valid = input(&VECTORS[0]);
    for radius in [0., -1., f32::NAN, f32::INFINITY] {
        assert_eq!(
            compile(CaptureInput {
                normalized_blur: radius,
                ..valid
            })
            .unwrap_err(),
            CapturePlanError::InvalidRadius,
        );
    }
    for support in [-1., f32::NAN, f32::NEG_INFINITY] {
        assert_eq!(
            compile(CaptureInput {
                normalized_support: support,
                ..valid
            })
            .unwrap_err(),
            CapturePlanError::InvalidRadius,
        );
    }
    assert_eq!(
        compile(CaptureInput {
            transform: [f32::NAN; 6],
            ..valid
        })
        .unwrap_err(),
        CapturePlanError::InvalidTransform,
    );
    for bounds in [
        [1., 0., 0., 1.],
        [0., 2., 1., 1.],
        [0., 0., f32::INFINITY, 1.],
    ] {
        assert_eq!(
            compile(CaptureInput { bounds, ..valid }).unwrap_err(),
            CapturePlanError::InvalidBounds,
        );
    }
}

#[test]
fn overflow_is_not_saturated_to_a_pixel_rectangle() {
    let valid = input(&VECTORS[0]);
    assert_eq!(
        compile(CaptureInput {
            normalized_support: f32::MAX,
            divisor: 2,
            ..valid
        })
        .unwrap_err(),
        CapturePlanError::ArithmeticRange,
    );
    assert_eq!(
        compile(CaptureInput {
            bounds: [0., 0., f32::MAX, 1.],
            ..valid
        })
        .unwrap_err(),
        CapturePlanError::PixelBoundsOverflow,
    );
}

#[test]
fn rounded_pixel_bounds_do_not_increment_large_odd_integers() {
    // The original pure helper returns upper edge 8_388_609 unchanged.
    // Using a decimal 0.5 bias rounds it to the next even integer, incorrectly
    // adding a pixel to each extent. This is a numeric plan, not an allocation.
    let vector = Vector {
        name: "large_odd_pixel_edge",
        support: 0,
        blur: 0x33d6_bf95,
        target_pixels: 8_388_608,
        source_pixels: 8_388_608,
        divisor: 1,
        transform: [0x3f80_0000, 0, 0, 0, 0x3f80_0000, 0],
        bounds: [0, 0, 0x3f80_0000, 0x3f80_0000],
        expected: [
            0x3f56_51db,
            0x3f7f_7d32,
            0,
            0x3a82_ce00,
            0,
            0x3f7f_7d32,
            0x3a82_ce00,
            0x3f7f_7d32,
            0xffff_ffff,
            0xffff_ffff,
            0x0080_0002,
            0x0080_0002,
            0xb33b_0000,
            0xb33b_0000,
            0x3f80_0000,
            0x3f80_0000,
        ],
    };
    let plan = compile(input(&vector)).unwrap();
    assert_eq!(plan.pixel_bounds, [-1, -1, 8_388_610, 8_388_610]);
    assert_eq!(words(plan), vector.expected);
}
