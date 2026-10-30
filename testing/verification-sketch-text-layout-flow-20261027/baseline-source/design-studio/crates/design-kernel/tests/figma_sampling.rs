//! These are primitive-level contracts, not an assertion that any variable
//! gradient or material image passes the complete external fidelity gate.
use futureox_design_kernel::figma_sampling::*;

#[test]
fn every_byte_pair_matches_independent_apple_unpremultiply_shader_readback() {
    let raw = include_bytes!(
        "../../../../testing/fixtures/design/apple-unpremultiply-2026-10-13/conversion.rgba"
    );
    for alpha in 0..=255u8 {
        for color in 0..=255u8 {
            let offset = (usize::from(alpha) * 256 + usize::from(color)) * 4;
            let result = unpremultiply_rgba8([color, color, color, alpha]);
            assert_eq!(
                result,
                &raw[offset..offset + 4],
                "gray={color}, alpha={alpha}"
            );
        }
    }
}

#[test]
fn native_metal_unorm8_filter_vectors() {
    // Independent M2 Pro texture2d_array<float>.sample readbacks, 2026-10-08.
    // One fixed first UV from each of 16 random palettes (seed 2026100802).
    // Complete source SHA e91383a5ed5366929375a51f0172ebecdec5508f3554d4fa36aa3b0209a58bac;
    // UV SHA 6e6de610c505e384c94975998d38b652002f20925884ff1f3c4619cdf04be53b;
    // complete 262144-component readback SHA 5d45d320dabfec3b3bb404f33ad4c32d2621d3ccf3fee72e7e9b7fa8a22f7e97.
    type FilterVector = ([[u8; 4]; 4], [u32; 2], [u32; 4]);
    let vectors: [FilterVector; 16] = [
        (
            [
                [155, 220, 148, 135],
                [150, 195, 3, 27],
                [15, 105, 157, 168],
                [212, 238, 183, 222],
            ],
            [0x3ef78e90, 0x3ee8e1e0],
            [0x3f069697, 0x3f404040, 0x3eea2a2a, 0x3f019192],
        ),
        (
            [
                [243, 129, 93, 112],
                [54, 121, 111, 163],
                [99, 59, 21, 153],
                [198, 209, 98, 83],
            ],
            [0x3ecf2450, 0x3f058dc0],
            [0x3f1b5b5b, 0x3ee6e6e7, 0x3e8b4b4b, 0x3f024242],
        ),
        (
            [
                [226, 51, 177, 224],
                [228, 142, 137, 7],
                [203, 153, 246, 190],
                [206, 122, 84, 67],
            ],
            [0x3f3a3050, 0x3ecdba10],
            [0x3f5e0e0e, 0x3f05e5e6, 0x3ef9f9fa, 0x3e090909],
        ),
        (
            [
                [48, 233, 18, 102],
                [187, 242, 127, 227],
                [180, 75, 116, 131],
                [5, 53, 81, 129],
            ],
            [0x3f0ca1a0, 0x3f030498],
            [0x3eccacad, 0x3f129293, 0x3eb37373, 0x3f18c8c9],
        ),
        (
            [
                [77, 20, 239, 132],
                [118, 238, 176, 56],
                [37, 229, 37, 106],
                [231, 46, 121, 223],
            ],
            [0x3eb503d0, 0x3ebf8b80],
            [0x3ea78788, 0x3ec20202, 0x3f37c7c8, 0x3ef07070],
        ),
        (
            [
                [221, 119, 223, 178],
                [185, 240, 118, 208],
                [130, 137, 243, 3],
                [79, 145, 13, 144],
            ],
            [0x3f054f58, 0x3f1c71a8],
            [0x3f025252, 0x3f19f9fa, 0x3f03e3e4, 0x3edf9fa0],
        ),
        (
            [
                [28, 223, 225, 191],
                [76, 23, 187, 4],
                [100, 218, 30, 206],
                [249, 170, 116, 177],
            ],
            [0x3f199b60, 0x3f2e6a38],
            [0x3f396969, 0x3f2b3b3b, 0x3ed2b2b3, 0x3f293939],
        ),
        (
            [
                [70, 170, 84, 17],
                [81, 54, 153, 28],
                [216, 117, 189, 3],
                [133, 254, 62, 72],
            ],
            [0x3f1a21c8, 0x3ec36790],
            [0x3ec60606, 0x3ef33333, 0x3ef8d8d9, 0x3dfefeff],
        ),
        (
            [
                [88, 77, 103, 2],
                [29, 45, 97, 182],
                [33, 233, 130, 136],
                [93, 26, 252, 81],
            ],
            [0x3f341b88, 0x3eff1f50],
            [0x3e73f3f4, 0x3e3b7b7b, 0x3f292929, 0x3efcdcdd],
        ),
        (
            [
                [111, 219, 175, 44],
                [219, 151, 196, 182],
                [132, 48, 121, 134],
                [2, 184, 184, 247],
            ],
            [0x3f3734c8, 0x3f0a28f8],
            [0x3ec00000, 0x3f273737, 0x3f3a9a9b, 0x3f53b3b4],
        ),
        (
            [
                [72, 212, 224, 186],
                [78, 126, 220, 13],
                [110, 202, 113, 2],
                [209, 5, 101, 46],
            ],
            [0x3ee4d9b0, 0x3eb7b280],
            [0x3eb61616, 0x3f26f6f7, 0x3f463636, 0x3ec14141],
        ),
        (
            [
                [77, 3, 90, 59],
                [169, 253, 176, 70],
                [75, 164, 22, 197],
                [64, 249, 84, 11],
            ],
            [0x3e93f440, 0x3ef1ab00],
            [0x3ea00000, 0x3eb1b1b2, 0x3e83c3c4, 0x3ee5c5c6],
        ),
        (
            [
                [120, 9, 86, 0],
                [194, 170, 167, 233],
                [2, 182, 252, 184],
                [26, 163, 251, 168],
            ],
            [0x3ec06940, 0x3f1eef20],
            [0x3e272727, 0x3f10d0d1, 0x3f571717, 0x3f153535],
        ),
        (
            [
                [165, 179, 176, 156],
                [129, 24, 20, 181],
                [161, 160, 208, 188],
                [217, 129, 1, 105],
            ],
            [0x3e8b8780, 0x3e8993f0],
            [0x3f23f3f4, 0x3f2bebec, 0x3f2a8a8b, 0x3f1ededf],
        ),
        (
            [
                [139, 245, 165, 44],
                [129, 218, 121, 143],
                [35, 37, 95, 145],
                [83, 109, 103, 250],
            ],
            [0x3ee2c4d0, 0x3f2ce4d8],
            [0x3e83e3e4, 0x3eb4d4d5, 0x3ed3d3d4, 0x3f2aeaeb],
        ),
        (
            [
                [194, 120, 54, 134],
                [71, 224, 189, 175],
                [1, 65, 234, 123],
                [181, 105, 112, 126],
            ],
            [0x3eea8e00, 0x3ed532d0],
            [0x3ef21212, 0x3f08d8d9, 0x3f070707, 0x3f0ebebf],
        ),
    ];
    for (pixels, uv, expected) in vectors {
        let x = fraction_q8(f32::from_bits(uv[0]) * 2.0 - 0.5);
        let y = fraction_q8(f32::from_bits(uv[1]) * 2.0 - 0.5);
        assert_eq!(sample_q8(pixels, x, y).map(f32::to_bits), expected);
    }
}

#[test]
fn every_q4_value_and_four_byte_sum_has_the_exact_normalization() {
    // Separate binary64 arithmetic oracle for bounded rational inputs; no
    // integer-bit implementation is reused to produce the expected results.
    for q in 0..=4080 {
        let expected = (f64::from(q) / 4080.0) as f32;
        assert_eq!(normalize_q4(q).to_bits(), expected.to_bits(), "q={q}");
        assert_eq!(
            encode_unorm8(expected),
            (f64::from(expected) * 255.0).round_ties_even() as u8
        );
    }
    for sum in 0..=1020 {
        let normalized = (f64::from(sum) / 1020.0) as f32;
        let expected = (f64::from(normalized) * 255.0).round_ties_even() as u8;
        assert_eq!(normalized_resolve_sum(sum), expected, "sum={sum}");
    }
    assert_eq!(normalized_resolve_sum(119 * 4 + 2), 120);
    assert_eq!(normalized_resolve_sum(190 * 4 + 2), 190);
    assert_eq!(normalized_resolve_sum(191 * 4 + 2), 191);
}

#[test]
fn fraction_quantization_preserves_each_halfway_neighbor() {
    assert_eq!(fraction_q8(0.0), 0);
    assert_eq!(fraction_q8(1.0), 256);
    for q in 0..256 {
        let halfway = (q as f32 + 0.5) / 256.0;
        assert_eq!(fraction_q8(f32::from_bits(halfway.to_bits() - 1)), q);
        assert_eq!(fraction_q8(halfway), q + 1);
        assert_eq!(fraction_q8(f32::from_bits(halfway.to_bits() + 1)), q + 1);
    }
}

#[test]
fn gradient_lut_matches_independent_fraction_rounding_vectors() {
    // Expected bytes were calculated in Python Fraction arithmetic, selecting
    // each nearest-even binary32 by exact distances to neighboring bit values.
    let stops = [
        GradientStop {
            offset: 0.0,
            color: [0.25, 119.0 / 255.0, 0.5, 0.2],
        },
        GradientStop {
            offset: 1.0,
            color: [0.75, 0.2, 0.9, 0.8],
        },
    ];
    let lut = gradient_lut(&stops).unwrap();
    assert_eq!(lut.len(), 8192);
    let expected = [
        (0, [12, 23, 25, 51], [205, 229, 154, 51]),
        (1, [12, 23, 25, 51], [221, 243, 178, 89]),
        (17, [13, 24, 27, 53], [226, 217, 60, 192]),
        (255, [33, 35, 53, 89], [134, 208, 170, 124]),
        (511, [63, 42, 89, 127], [238, 168, 133, 236]),
        (512, [64, 42, 89, 128], [17, 173, 173, 19]),
        (768, [104, 44, 133, 166], [33, 95, 66, 131]),
        (1022, [153, 40, 184, 204], [99, 252, 26, 166]),
        (1023, [153, 40, 184, 204], [153, 246, 81, 204]),
    ];
    for (index, high, low) in expected {
        assert_eq!(
            &lut[index * 4..index * 4 + 4],
            &high,
            "high row index={index}"
        );
        assert_eq!(
            &lut[4096 + index * 4..4100 + index * 4],
            &low,
            "low row index={index}"
        );
    }
}

#[test]
fn invalid_lookup_parameters_are_errors() {
    assert!(gradient_lut(&[]).is_err());
    assert!(
        gradient_lut(&[GradientStop {
            offset: f32::NAN,
            color: [0.0; 4]
        }])
        .is_err()
    );
    assert!(
        gradient_lut(&[GradientStop {
            offset: 0.0,
            color: [f32::INFINITY; 4]
        }])
        .is_err()
    );
    let stop = |offset| GradientStop {
        offset,
        color: [1.0; 4],
    };
    assert!(gradient_lut(&[stop(0.75), stop(0.25)]).is_err());
}

#[test]
fn real_figma_constant_gradient_control_retains_its_exact_color() {
    // This real browser-exported constant gradient is a color/lookup control.
    // It does not exercise the uncompleted variable-gradient source pipeline.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let path = root.join("frontend/design-client/public/fidelity/gradient-quantization-2026-10-08/GradientQA-blue-clear.png");
    let reference = image::open(path).unwrap().into_rgba8();
    assert_eq!(reference.dimensions(), (128, 128));
    let color = [68.0 / 255.0, 119.0 / 255.0, 221.0 / 255.0, 1.0];
    let lut = gradient_lut(&[
        GradientStop { offset: 0.0, color },
        GradientStop { offset: 1.0, color },
    ])
    .unwrap();
    let pixel = |row: usize, column: usize| -> [u8; 4] {
        lut[(row * 1024 + column) * 4..(row * 1024 + column) * 4 + 4]
            .try_into()
            .unwrap()
    };
    for (x, y, expected) in reference.enumerate_pixels() {
        let texels = [
            pixel(0, x as usize),
            pixel(0, x as usize + 1),
            pixel(1, x as usize),
            pixel(1, x as usize + 1),
        ];
        let actual = sample_q8(texels, (x + y) % 257, 1).map(encode_unorm8);
        assert_eq!(actual, expected.0, "constant lookup control at {x},{y}");
    }
}
