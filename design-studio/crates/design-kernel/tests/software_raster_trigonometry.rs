//! Bit-level numerical controls from an independent, explicit-fma C++ oracle.
//! These check a software-renderer approximation, not analytic sine accuracy.
use futureox_design_kernel::software_raster::trigonometry::{checked_sin_cos, cos, sin, sin_cos};
use sha2::{Digest, Sha256};

fn record(value: f32) -> [u32; 3] {
    match checked_sin_cos(value) {
        Err(_) => [2, 0, 0],
        Ok((s, c)) if s.is_nan() && c.is_nan() => [1, 0x7fc0_0000, 0x7fc0_0000],
        Ok((s, c)) => {
            assert!(s.is_finite() && c.is_finite());
            [0, s.to_bits(), c.to_bits()]
        }
    }
}

fn assert_oracle(name: &str, inputs: impl IntoIterator<Item = f32>) {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/software-raster-trigonometry-oracle.json"
    ))
    .unwrap();
    let expected = fixture["corpus"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == name)
        .unwrap();
    let mut input_hash = Sha256::new();
    let mut output_hash = Sha256::new();
    let mut count = 0_u64;
    for value in inputs {
        input_hash.update(value.to_bits().to_le_bytes());
        for bits in record(value) {
            output_hash.update(bits.to_le_bytes());
        }
        count += 1;
    }
    assert_eq!(count, expected["count"].as_u64().unwrap(), "{name}");
    assert_eq!(
        (input_hash.finalize()).iter().map(|b| format!("{b:02x}")).collect::<String>(),
        expected["inputSha256"].as_str().unwrap(),
        "{name}: oracle input identity"
    );
    assert_eq!(
        (output_hash.finalize()).iter().map(|b| format!("{b:02x}")).collect::<String>(),
        expected["expectedOutputSha256"].as_str().unwrap(),
        "{name}: independently generated output bits"
    );
}

#[test]
fn software_trigonometry_has_explicit_special_values_and_domain() {
    assert_eq!(sin_cos(0.0), (0.0, 1.0));
    assert_eq!(sin(-0.0).to_bits(), (-0.0_f32).to_bits());
    assert_eq!(cos(-0.0).to_bits(), 1.0_f32.to_bits());
    for bits in [0x7f80_0000, 0xff80_0000, 0x7fc0_0000, 0x7f80_0001] {
        let value = f32::from_bits(bits);
        let (s, c) = checked_sin_cos(value).unwrap();
        assert!(s.is_nan() && c.is_nan());
        assert!(sin(value).is_nan() && cos(value).is_nan());
    }
    for value in [f32::MAX, -f32::MAX, 2_000_000_000.0, -2_000_000_000.0] {
        assert!(checked_sin_cos(value).is_err());
        let (s, c) = sin_cos(value);
        assert!(s.is_nan() && c.is_nan());
    }
    for value in [-65_536.0, -1.5707964, -0.125, 0.125, 7.0685835, 65_536.0] {
        let (s, c) = checked_sin_cos(value).unwrap();
        assert_eq!(sin(value).to_bits(), s.to_bits());
        assert_eq!(cos(value).to_bits(), c.to_bits());
        assert_eq!(sin(-value).to_bits(), s.to_bits() ^ 0x8000_0000);
        assert_eq!(cos(-value).to_bits(), c.to_bits());
    }
}

#[test]
fn software_trigonometry_matches_independent_mixed_bit_oracle() {
    let mut state = 0x3141_5926_u32;
    assert_oracle(
        "lcg100000",
        (0..100_000).map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            f32::from_bits(state)
        }),
    );
    assert_oracle(
        "exponent-boundaries",
        [0_u32, 0x8000_0000].into_iter().flat_map(|sign| {
            (0_u32..256).flat_map(move |exponent| {
                [0_u32, 1, 0x3f_ffff, 0x40_0000, 0x7f_fffe, 0x7f_ffff]
                    .into_iter()
                    .map(move |mantissa| f32::from_bits(sign | (exponent << 23) | mantissa))
            })
        }),
    );
}

#[test]
fn software_trigonometry_matches_quadrant_boundaries_and_large_arguments() {
    assert_oracle(
        "quadrant-neighbors",
        (-64..=64).flat_map(|quadrant| {
            (-3_i32..=3).map(move |step| {
                let mut value = (f64::from(quadrant) * std::f64::consts::PI / 4.0) as f32;
                for _ in 0..step.abs() {
                    value = if step < 0 {
                        value.next_down()
                    } else {
                        value.next_up()
                    };
                }
                value
            })
        }),
    );
    assert_oracle(
        "large-reduction-boundary",
        [
            8192.0,
            65_536.0,
            1_000_000.0,
            100_000_000.0,
            1_000_000_000.0,
            2_147_483_648.0 / (4.0 / std::f64::consts::PI),
        ]
        .into_iter()
        .flat_map(|number| {
            let bits = (number as f32).to_bits();
            [0_u32, 0x8000_0000].into_iter().flat_map(move |sign| {
                (-4_i32..=4).map(move |step| f32::from_bits(bits.wrapping_add_signed(step) ^ sign))
            })
        }),
    );
}

#[test]
fn software_trigonometry_matches_complete_positive_and_negative_noise_domain() {
    assert_oracle(
        "noise512-positive-negative",
        (0..512).flat_map(|y| {
            (0..512).flat_map(move |x| {
                // This dot is intentionally two separately rounded products.
                let a = (x as f32 + 0.5) * 12.9898_f32;
                let b = (y as f32 + 0.5) * 78.233_f32;
                let value = a + b;
                [value, -value]
            })
        }),
    );
}
