//! Independent Metal unary sine vectors and parameter validation.
//! These values were generated from numerical inputs, not reference image pixels.
use futureox_design_kernel::texture_noise::{self, Error, SineMode};
use sha2::{Digest, Sha256};

const GRID_VECTORS: [(u32, u32); 64] = [
    (0x40be7b24, 0xbea63a05),
    (0x41e4460a, 0xbe838eb3),
    (0x41b539e0, 0xbf1d6266),
    (0xc2041b5e, 0xbf7fcb91),
    (0xc170588d, 0xbf223b1c),
    (0x41e0929d, 0x3e4e314d),
    (0xc165fc06, 0xbf78da2b),
    (0xc1e5e8c6, 0x3ee54852),
    (0xbdb10bcd, 0xbdb0d353),
    (0x4168212b, 0x3f6e96f0),
    (0xbac8a642, 0xbac8ab4c),
    (0xbddec568, 0xbdde54ef),
    (0x40499ce2, 0xbc0d06bc),
    (0xc02e9a94, 0xbecdafde),
    (0xc0b9cf98, 0x3eeae210),
    (0xc14bd03f, 0xbe2f3b31),
    (0xc1fa76f7, 0x3ddc6db8),
    (0xc1f35ba2, 0x3f56e32d),
    (0x411ae469, 0xbe81a35b),
    (0x41ec75c4, 0xbf757bbf),
    (0xc1f5c7b4, 0x3f23a087),
    (0x41a94954, 0x3f3cf852),
    (0xc1a016b4, 0xbf6adb8c),
    (0x4187dbb7, 0xbf74d4c2),
    (0xc1fca534, 0xbe27ee0c),
    (0xb93c750b, 0xb93c7edc),
    (0x41920957, 0xbf0f7d46),
    (0xbdd866ce, 0xbdd7ffd0),
    (0xbddee7fe, 0xbdde7749),
    (0xc1fe28c8, 0xbeb17a7a),
    (0x41ea87a8, 0xbf5d0588),
    (0xb7b0c6c5, 0xb7afeddf),
    (0xb8d54ae6, 0xb8d5a0d8),
    (0xbeb6893b, 0xbeb2b197),
    (0xbbd74abd, 0xbbd74bb4),
    (0xb64ea843, 0xb6490fda),
    (0xc09bea4e, 0x3f7cbb50),
    (0x3d9abc58, 0x3d9a96aa),
    (0xbdd2d616, 0xbdd276d7),
    (0xba66f1fa, 0xba66e832),
    (0xbb35d305, 0xbb35d1c6),
    (0xb63e005b, 0xb6490fda),
    (0x41efc5d3, 0xbf7df4a2),
    (0xba4e8614, 0xba4e8f47),
    (0xbeb8e0de, 0xbeb4e30e),
    (0x41e87b1b, 0xbf351670),
    (0xbe5c9d37, 0xbe5ae94d),
    (0xc1a17265, 0xbf78b172),
    (0xc0546868, 0x3e3495c0),
    (0xc14b1707, 0xbe017227),
    (0x41889778, 0xbf7aa663),
    (0xbc76771c, 0xbc76755d),
    (0x417220e4, 0x3f0b3522),
    (0xb8cfab9b, 0xb8cf5859),
    (0xc1fd0d99, 0xbe5b2e5a),
    (0x414fa93c, 0x3ecd3c68),
    (0xc19fa540, 0xbf64db59),
    (0xb883c460, 0xb883f267),
    (0xbe503f40, 0xbe4ed08a),
    (0x3ed02b9f, 0x3eca7b70),
    (0xc1b4f9a7, 0x3f16f9ef),
    (0xbefc8a70, 0xbef26caf),
    (0xbf15c3cf, 0xbf0d5df9),
    (0xbe64dac6, 0xbe62f446),
];
const OFF_GRID_VECTORS: [(u32, u32); 64] = [
    (0x405dbd55, 0xbea28ede),
    (0xbc4003d2, 0xbc40035f),
    (0x35875152, 0x35875151),
    (0x3c707ad7, 0x3c7078a1),
    (0xbf3b8720, 0xbf2b3368),
    (0x36997b1e, 0x36997b1d),
    (0xb73dbba7, 0xb73c7edc),
    (0xb969d63c, 0xb969a7eb),
    (0x3cac13d9, 0x3cac109a),
    (0x385fed3c, 0x385fed3a),
    (0xbe575249, 0xbe55bcf8),
    (0xbf27ff41, 0xbf1c3232),
    (0xbaa862e1, 0xbaa85ea3),
    (0x39260f2d, 0x39260f2c),
    (0x3cc6b0e2, 0x3cc6abe4),
    (0xbca993b6, 0xbca990ff),
    (0xbcad5319, 0xbcad4fc1),
    (0x40d2d3ef, 0x3e99d728),
    (0xb8b3f7e8, 0xb8b3db2e),
    (0xbe9549b7, 0xbe932e7c),
    (0x3dea8895, 0x3dea056e),
    (0xbe1b8223, 0xbe1ae951),
    (0x39424d37, 0x39424d36),
    (0x3c8c95e5, 0x3c8c9420),
    (0xbc3277ea, 0xbc327746),
    (0xbd255a9d, 0xbd254f1b),
    (0x3b197a95, 0x3b197a8b),
    (0xb772be07, 0xb7750b52),
    (0xbb95179c, 0xbb951713),
    (0x3b993ac1, 0x3b993a9b),
    (0x4136c75c, 0xbf68e5dd),
    (0xbf779f86, 0xbf52c6a9),
    (0xbc99c8b7, 0xbc99c68e),
    (0x3f2cc53a, 0x3f1ff35b),
    (0x3e221551, 0x3e216845),
    (0x3727e0ef, 0x3727e0ee),
    (0xb71d0635, 0xb71d1462),
    (0x3acb1bd7, 0x3acb1bd0),
    (0xbf398480, 0xbf29b370),
    (0xb8e7ebe7, 0xb8e7b144),
    (0x3e36dc0b, 0x3e35e3a4),
    (0x3d09166a, 0x3d090fdc),
    (0xba4e1ac4, 0xba4e119d),
    (0xb9216a35, 0xb9216639),
    (0xbb51f7b5, 0xbb51f88e),
    (0xba6cb33c, 0xba6cb307),
    (0xc0aff806, 0x3f34cb80),
    (0xc1c28bee, 0x3f3a31fc),
    (0xbb62f264, 0xbb62f47e),
    (0xbf492bd4, 0xbf3518ba),
    (0x3a45c1a2, 0x3a45c19f),
    (0xb7c514cd, 0xb7c5eb9b),
    (0xbf58f268, 0xbf3fe566),
    (0xb5d46363, 0xb5c90fda),
    (0xc0291d70, 0xbef517e3),
    (0xbfa10572, 0xbf73938e),
    (0xbb8fe412, 0xbb8fe30d),
    (0xbbd12c70, 0xbbd12c14),
    (0xbeaf0b9a, 0xbeaba7b2),
    (0xbe8138bc, 0xbe7fb548),
    (0x3ad7b72a, 0x3ad7b722),
    (0x3e9d6311, 0x3e9aeb85),
    (0x37787e68, 0x37787e67),
    (0xbfa4423e, 0xbf757da9),
];

#[test]
fn mathematical_assets_are_sha_bound() {
    let bytes = include_bytes!("../src/texture_noise/sine-q19.bin");
    assert_eq!(bytes.len(), texture_noise::LUT_BYTES);
    assert_eq!(
        (Sha256::digest(bytes)).iter().map(|b| format!("{b:02x}")).collect::<String>(),
        texture_noise::LUT_SHA256
    );
    let mut total = bytes.len();
    for asset in texture_noise::RESIDUAL_ASSETS {
        assert_eq!(
            (Sha256::digest(asset.bytes)).iter().map(|b| format!("{b:02x}")).collect::<String>(),
            asset.sha256,
            "{}",
            asset.name
        );
        total += asset.bytes.len();
    }
    assert_eq!(total, texture_noise::TOTAL_MATH_BYTES);
    let mut seed_bytes = Vec::new();
    for channel in texture_noise::SEED_PLAN_BITS {
        for octave in channel {
            for word in octave {
                seed_bytes.extend_from_slice(&word.to_le_bytes());
            }
        }
    }
    assert_eq!(seed_bytes.len(), 72);
    assert_eq!(
        (Sha256::digest(seed_bytes)).iter().map(|b| format!("{b:02x}")).collect::<String>(),
        texture_noise::SEED_PLAN_SHA256
    );
}
#[test]
fn q19_nodes_match_independent_native_sine_bits() {
    for (argument, expected) in GRID_VECTORS {
        let sample =
            texture_noise::sine(f32::from_bits(argument), SineMode::RequireGridNode).unwrap();
        assert!(!sample.interpolated);
        assert_eq!(
            sample.value.to_bits(),
            expected,
            "argument {argument:#010x}"
        );
    }
}
#[test]
fn extended_domains_match_independent_native_values_without_interpolation() {
    let mut compared = 0;
    for (argument, expected) in OFF_GRID_VECTORS {
        let value = f32::from_bits(argument);
        assert!(matches!(
            texture_noise::sine(value, SineMode::RequireGridNode),
            Err(Error::OffGridSine { .. })
        ));
        // These independently recorded vectors are in complete signed-Q22,
        // positive[.25,4), or exhaustively enumerated tiny argument domains.
        if !(0.0..0.25).contains(&value) || (1.0 / 67_108_864.0..1.0 / 8192.0).contains(&value) {
            let sample = texture_noise::sine(value, SineMode::RequireSupportedDomain).unwrap();
            assert!(!sample.interpolated);
            assert_eq!(
                sample.value.to_bits(),
                expected,
                "argument {argument:#010x}"
            );
            compared += 1;
        }
    }
    assert!(compared >= 40);
}
#[test]
fn unsupported_numeric_domains_are_explicit_errors() {
    for mode in [
        SineMode::RequireSupportedDomain,
        SineMode::AllowInterpolation,
    ] {
        assert!(matches!(
            texture_noise::sine(0.01, mode),
            Err(Error::UnsupportedDomain { stage: "sine", .. })
        ));
    }
    assert!(matches!(
        texture_noise::coordinate_sine(0.01),
        Err(Error::UnsupportedDomain { .. })
    ));
    assert_eq!(
        texture_noise::reciprocal_sqrt(0.0),
        Err(Error::ZeroGradient)
    );
    assert!(matches!(
        texture_noise::reciprocal_sqrt(4.0),
        Err(Error::UnsupportedDomain { .. })
    ));
    assert!(matches!(
        texture_noise::reciprocal_sqrt(2.0_f32.powi(-49)),
        Err(Error::UnsupportedDomain { .. })
    ));
}
#[test]
fn origin_gradient_matches_independent_native_normalized_zero_hash() {
    for channel in 0..2 {
        for octave in 0..3 {
            let sample = texture_noise::gradient([0.0, 0.0], channel, octave).unwrap();
            assert_eq!(sample.offset.map(f32::to_bits), [0xbf3504f3; 2]);
            assert_eq!(sample.quality.normalizations, 1);
        }
    }
}
#[test]
fn invalid_parameters_do_not_become_empty_or_neutral_data() {
    for (q, size, radius) in [
        ([f32::NAN, 0.0], [8.0; 2], 2.0),
        ([0.0; 2], [0.0, 8.0], 2.0),
        ([0.0; 2], [f32::INFINITY, 8.0], 2.0),
        ([0.0; 2], [8.0; 2], -1.0),
    ] {
        assert!(texture_noise::displacement(q, size, radius).is_err());
    }
    assert!(texture_noise::gradient([0.5, 0.0], 0, 0).is_err());
    assert!(texture_noise::gradient([0.0; 2], 2, 0).is_err());
    assert!(texture_noise::gradient([0.0; 2], 0, 3).is_err());
}
#[test]
fn neutral_radius_preserves_identity_without_transcendentals() {
    let sample = texture_noise::displacement([23.25, -8.75], [8.0, 16.0], 0.0).unwrap();
    assert_eq!(sample.offset, [0.0; 2]);
    assert_eq!(sample.quality, texture_noise::Quality::default());
}
#[test]
fn integral_perlin_grid_is_neutral_for_every_octave() {
    let sample = texture_noise::displacement([16.0, -32.0], [8.0, 16.0], 2.0).unwrap();
    assert_eq!(sample.offset, [0.0; 2]);
    assert!(sample.quality.normalizations > 0);
}

#[test]
fn wide_gradient_lattice_matches_independent_identity_metal_digest() {
    let mut digest = Sha256::new();
    for channel in 0..2 {
        for octave in 0..3 {
            for y in -256..=256 {
                for x in -256..=256 {
                    let sample =
                        texture_noise::gradient([x as f32, y as f32], channel, octave).unwrap();
                    assert_eq!(sample.quality.sine_interpolated_samples, 0);
                    for value in sample.offset {
                        digest.update(value.to_le_bytes());
                    }
                }
            }
        }
    }
    assert_eq!(
        (digest.finalize()).iter().map(|b| format!("{b:02x}")).collect::<String>(),
        "9544440731665ecb3881995f5aa2a0b6ac36ae5a11376a38a95cfd47f6f01b0d"
    );
}

// q, authored sizes, radius and expected displacement bits, independently
// generated by the identity Metal mathematical probe with rounded reciprocals.
// A runtime quantize diagnostic branch changes weight-bias fusion and is excluded.
const DISPLACEMENT_VECTORS: [([u32; 5], [u32; 2]); 40] = [
    (
        [0xc1b70f4a, 0xc0004687, 0x3f800000, 0x3f800000, 0x40000000],
        [0xbea95fac, 0x3e0194c2],
    ),
    (
        [0xc2076562, 0x427ed8f9, 0x3f800000, 0x3f800000, 0x40000000],
        [0x3e3ffd19, 0x3ecaea0b],
    ),
    (
        [0xc186b1bb, 0xc1856c47, 0x3f800000, 0x3f800000, 0x40000000],
        [0xbe20c96c, 0x3e07ef6d],
    ),
    (
        [0xc26c0887, 0x41e43951, 0x3f800000, 0x3f800000, 0x40000000],
        [0x3ea4e38f, 0xbdd84567],
    ),
    (
        [0xc116db64, 0xc2597b14, 0x3f800000, 0x3f800000, 0x40000000],
        [0x3db27cbf, 0xbf561553],
    ),
    (
        [0x4236d4db, 0xc27fb0dc, 0x3f800000, 0x3f800000, 0x40000000],
        [0xbf46ec95, 0xbf0b93d5],
    ),
    (
        [0xc1acbf61, 0xc1f8b3f5, 0x3f800000, 0x3f800000, 0x40000000],
        [0xbe1418a6, 0xbedf7066],
    ),
    (
        [0x40dbd238, 0xc160d3dc, 0x3f800000, 0x3f800000, 0x40000000],
        [0x3e8b1c19, 0x3ea62bdd],
    ),
    (
        [0xc1b70f4a, 0xc0004687, 0x41000000, 0x41800000, 0x40000000],
        [0x3ede729f, 0xbee3a839],
    ),
    (
        [0xc2076562, 0x427ed8f9, 0x41000000, 0x41800000, 0x40000000],
        [0x3e6759ef, 0x3d134bc4],
    ),
    (
        [0xc186b1bb, 0xc1856c47, 0x41000000, 0x41800000, 0x40000000],
        [0x3e944b98, 0xbef88a28],
    ),
    (
        [0xc26c0887, 0x41e43951, 0x41000000, 0x41800000, 0x40000000],
        [0x3f4d2d76, 0xbfaf4612],
    ),
    (
        [0xc116db64, 0xc2597b14, 0x41000000, 0x41800000, 0x40000000],
        [0x3e2d194c, 0xbd266533],
    ),
    (
        [0x4236d4db, 0xc27fb0dc, 0x41000000, 0x41800000, 0x40000000],
        [0xbd8ec0e4, 0xbd18b516],
    ),
    (
        [0xc1acbf61, 0xc1f8b3f5, 0x41000000, 0x41800000, 0x40000000],
        [0x3ef91deb, 0x3e855886],
    ),
    (
        [0x40dbd238, 0xc160d3dc, 0x41000000, 0x41800000, 0x40000000],
        [0xbe0ae81e, 0x3e890054],
    ),
    (
        [0xc1b70f4a, 0xc0004687, 0x42000000, 0x42000000, 0x42800000],
        [0x41e11c37, 0x4042d30d],
    ),
    (
        [0xc2076562, 0x427ed8f9, 0x42000000, 0x42000000, 0x42800000],
        [0x409fd788, 0x3fd5fd3e],
    ),
    (
        [0xc186b1bb, 0xc1856c47, 0x42000000, 0x42000000, 0x42800000],
        [0x417de2c9, 0x3f31c840],
    ),
    (
        [0xc26c0887, 0x41e43951, 0x42000000, 0x42000000, 0x42800000],
        [0x40087cab, 0xc039e7da],
    ),
    (
        [0xc116db64, 0xc2597b14, 0x42000000, 0x42000000, 0x42800000],
        [0xc108eb63, 0x4197ee7e],
    ),
    (
        [0x4236d4db, 0xc27fb0dc, 0x42000000, 0x42000000, 0x42800000],
        [0xc13225a3, 0xbf675938],
    ),
    (
        [0xc1acbf61, 0xc1f8b3f5, 0x42000000, 0x42000000, 0x42800000],
        [0x404d4960, 0xc12f006a],
    ),
    (
        [0x40dbd238, 0xc160d3dc, 0x42000000, 0x42000000, 0x42800000],
        [0x40272152, 0xc1178377],
    ),
    (
        [0xc1b70f4a, 0xc0004687, 0x40533333, 0x418d999a, 0x4293cccd],
        [0xc1545346, 0xbfc96071],
    ),
    (
        [0xc2076562, 0x427ed8f9, 0x40533333, 0x418d999a, 0x4293cccd],
        [0x416fc097, 0xc1c21eef],
    ),
    (
        [0xc186b1bb, 0xc1856c47, 0x40533333, 0x418d999a, 0x4293cccd],
        [0x3e8c6a6f, 0xc09cf4d2],
    ),
    (
        [0xc26c0887, 0x41e43951, 0x40533333, 0x418d999a, 0x4293cccd],
        [0x4112c7f0, 0xc16c78b6],
    ),
    (
        [0xc116db64, 0xc2597b14, 0x40533333, 0x418d999a, 0x4293cccd],
        [0xc0cf307d, 0x4005e89c],
    ),
    (
        [0x4236d4db, 0xc27fb0dc, 0x40533333, 0x418d999a, 0x4293cccd],
        [0x413b05be, 0x3feb5908],
    ),
    (
        [0xc1acbf61, 0xc1f8b3f5, 0x40533333, 0x418d999a, 0x4293cccd],
        [0x400c0e1f, 0x40fbe352],
    ),
    (
        [0x40dbd238, 0xc160d3dc, 0x40533333, 0x418d999a, 0x4293cccd],
        [0x3fef7e56, 0x421f4baf],
    ),
    (
        [0xc1b70f4a, 0xc0004687, 0x3f333333, 0x40b00000, 0x3e800000],
        [0x3b9fe5aa, 0x3d93e3c9],
    ),
    (
        [0xc2076562, 0x427ed8f9, 0x3f333333, 0x40b00000, 0x3e800000],
        [0xbd6f2bdd, 0xbd0ff2f5],
    ),
    (
        [0xc186b1bb, 0xc1856c47, 0x3f333333, 0x40b00000, 0x3e800000],
        [0x3b1127c6, 0xbcb33924],
    ),
    (
        [0xc26c0887, 0x41e43951, 0x3f333333, 0x40b00000, 0x3e800000],
        [0xbdafc083, 0x3c038166],
    ),
    (
        [0xc116db64, 0xc2597b14, 0x3f333333, 0x40b00000, 0x3e800000],
        [0xbd54a1b8, 0x3ac14880],
    ),
    (
        [0x4236d4db, 0xc27fb0dc, 0x3f333333, 0x40b00000, 0x3e800000],
        [0x3d53cb78, 0x3e13bffd],
    ),
    (
        [0xc1acbf61, 0xc1f8b3f5, 0x3f333333, 0x40b00000, 0x3e800000],
        [0x3d8bc4e8, 0xbde4ed8d],
    ),
    (
        [0x40dbd238, 0xc160d3dc, 0x3f333333, 0x40b00000, 0x3e800000],
        [0xbd1a6188, 0xbe01ff89],
    ),
];
#[test]
fn continuous_displacement_preserves_the_native_operation_graph() {
    for (input, expected) in DISPLACEMENT_VECTORS {
        let [x, y, sx, sy, radius] = input.map(f32::from_bits);
        let result = texture_noise::displacement([x, y], [sx, sy], radius).unwrap();
        assert_eq!(result.offset.map(f32::to_bits), expected, "input {input:?}");
        assert_eq!(result.quality.sine_interpolated_samples, 0);
    }
}

#[test]
fn authored_and_reciprocal_displacement_entries_are_identical() {
    for (input, expected) in DISPLACEMENT_VECTORS {
        let [x, y, sx, sy, radius] = input.map(f32::from_bits);
        let authored = texture_noise::displacement([x, y], [sx, sy], radius).unwrap();
        let direct =
            texture_noise::displacement_with_reciprocal([x, y], [1.0 / sx, 1.0 / sy], radius)
                .unwrap();
        assert_eq!(direct.offset.map(f32::to_bits), expected);
        assert_eq!(
            direct.offset.map(f32::to_bits),
            authored.offset.map(f32::to_bits)
        );
        assert_eq!(direct.quality, authored.quality);
    }
    let neutral = texture_noise::displacement([1.0, 2.0], [f32::from_bits(1); 2], 0.0).unwrap();
    assert_eq!(neutral.offset, [0.0; 2]);
    assert_eq!(neutral.quality, texture_noise::Quality::default());
    assert!(matches!(
        texture_noise::displacement([0.0, 1.0], [f32::from_bits(1), 1.0], 2.0),
        Err(Error::NonFinite("noise x"))
    ));
    assert!(matches!(
        texture_noise::displacement([0.0, 1.0], [1.0, f32::from_bits(1)], 2.0),
        Err(Error::NonFinite("noise y"))
    ));
}

#[test]
fn invalid_reciprocals_are_errors_even_at_neutral_radius() {
    for frequency in [
        [0.0, 1.0],
        [-0.0, 1.0],
        [-1.0, 1.0],
        [f32::NAN, 1.0],
        [1.0, f32::INFINITY],
        [1.0, f32::NEG_INFINITY],
    ] {
        for radius in [0.0, 2.0] {
            assert!(
                texture_noise::displacement_with_reciprocal([1.0, 2.0], frequency, radius).is_err()
            );
        }
    }
    for (q, radius) in [
        ([f32::NAN, 0.0], 0.0),
        ([0.0; 2], -1.0),
        ([0.0; 2], f32::INFINITY),
    ] {
        assert!(texture_noise::displacement_with_reciprocal(q, [1.0; 2], radius).is_err());
    }
}
