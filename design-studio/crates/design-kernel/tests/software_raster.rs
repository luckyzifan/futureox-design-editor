//! Primitive arithmetic contracts only: no external-image or renderer acceptance.
use futureox_design_kernel::software_raster::*;

#[test]
fn straight_alpha_preserves_the_binary32_division_boundary() {
    // Both exact rational results end in .5, but normalized binary32 division
    // leaves the second above the tie. Neither global half-up nor rational
    // nearest-even describes the readback conversion.
    assert_eq!(straight_rgba8([31, 155, 186, 186]), [42, 213, 255, 186]);
    assert_eq!(straight_rgba8([200, 100, 40, 0]), [0, 0, 0, 0]);
    for alpha in 1..=255 {
        assert_eq!(
            straight_rgba8([alpha, alpha, alpha, alpha]),
            [255, 255, 255, alpha]
        );
        let mut previous = 0;
        for channel in 0..=alpha {
            let result = straight_rgba8([channel, 0, 0, alpha]);
            assert!(result[0] >= previous);
            assert_eq!(result[3], alpha);
            previous = result[0];
        }
    }
}

// Independent signed rational oracle using Euclidean floor, unlike the
// implementation's sign/magnitude representation.
fn nearest_even(numerator: i64, denominator: i64) -> i64 {
    let floor = numerator.div_euclid(denominator);
    let remainder = numerator.rem_euclid(denominator);
    floor
        + i64::from(
            2 * remainder > denominator
                || (2 * remainder == denominator && floor.rem_euclid(2) != 0),
        )
}

fn lerp_oracle(a: u8, b: u8, weight: u32) -> u8 {
    (i64::from(a) + nearest_even((i64::from(b) - i64::from(a)) * i64::from(weight), 256)) as u8
}

// Exact binary32 significand-product rounding, independent of native f32
// multiplication. Only finite nonnegative operands used by these tests.
fn mul_f32_oracle(a: f32, b: f32) -> f32 {
    fn parts(value: f32) -> (u64, i32) {
        let bits = value.to_bits();
        let exponent = (bits >> 23) & 255;
        let fraction = u64::from(bits & 0x7f_ffff);
        if exponent == 0 {
            (fraction, -149)
        } else {
            (fraction | 0x80_0000, exponent as i32 - 150)
        }
    }
    let (ma, ea) = parts(a);
    let (mb, eb) = parts(b);
    let product = ma * mb;
    if product == 0 {
        return 0.0;
    }
    let high = 63 - product.leading_zeros() as i32;
    let exponent = high + ea + eb;
    let unit = (exponent - 23).max(-149);
    let shift = unit - ea - eb;
    let significand = if shift <= 0 {
        product << -shift
    } else if shift >= 64 {
        0
    } else {
        let floor = product >> shift;
        let remainder = product & ((1_u64 << shift) - 1);
        let midpoint = 1_u64 << (shift - 1);
        floor + u64::from(remainder > midpoint || (remainder == midpoint && floor & 1 != 0))
    };
    // Conversion of the <=25-bit integer and multiplication by an exact power
    // of two are exact in binary64, followed by the sole binary32 conversion.
    (significand as f64 * 2.0_f64.powi(unit)) as f32
}

fn encode_oracle(value: f32) -> u8 {
    let scaled = mul_f32_oracle(value, 255.0);
    let bits = scaled.to_bits();
    let exponent = ((bits >> 23) & 255) as i32;
    if exponent == 0 {
        return 0;
    }
    let significand = i64::from((bits & 0x7f_ffff) | 0x80_0000);
    let shift = 150 - exponent;
    if shift >= 63 {
        0
    } else if shift <= 0 {
        (significand << -shift) as u8
    } else {
        nearest_even(significand, 1_i64 << shift) as u8
    }
}

#[test]
fn every_byte_pair_and_q8_weight_matches_signed_rational_rounding() {
    for a in 0..=255 {
        for b in 0..=255 {
            for weight in 0..=256 {
                assert_eq!(lerp_byte(a, b, weight), lerp_oracle(a, b, weight));
            }
        }
    }
    // Delta parity, not final output parity, controls a half tie.
    assert_eq!(lerp_byte(1, 2, 128), 1);
    assert_eq!(lerp_byte(2, 1, 128), 2);
    assert_eq!(lerp_byte(0, 255, 256), 255);
}

#[test]
fn two_axis_filter_retains_the_horizontal_byte_boundary() {
    let palettes = [
        [
            [0, 1, 26, 255],
            [1, 2, 0, 0],
            [255, 26, 1, 128],
            [0, 255, 2, 141],
        ],
        [[255, 26, 141, 128]; 4],
        [[0; 4], [255; 4], [0; 4], [255; 4]],
    ];
    for pixels in palettes {
        for wx in 0..=256 {
            for wy in 0..=256 {
                let expected = std::array::from_fn(|c| {
                    lerp_oracle(
                        lerp_oracle(pixels[0][c], pixels[1][c], wx),
                        lerp_oracle(pixels[2][c], pixels[3][c], wx),
                        wy,
                    )
                });
                assert_eq!(sample_bytes(pixels, wx, wy), expected);
                assert_eq!(
                    sample_q8(pixels, wx, wy).map(f32::to_bits),
                    expected.map(|v| normalize_byte(v).to_bits())
                );
            }
        }
    }
}

#[test]
fn split_products_and_complement_preserve_all_constant_bytes() {
    for byte in 0..=255 {
        for factor in 0..=255 {
            assert_eq!(blend_constant([byte; 4], [byte; 4], factor), [byte; 4]);
        }
    }
    for src in 0..=255 {
        for dst in 0..=255 {
            for factor in [0, 1, 64, 85, 127, 128, 191, 254, 255] {
                let expected = (nearest_even(i64::from(src) * factor, 255)
                    + nearest_even(i64::from(dst) * (255 - factor), 255))
                    as u8;
                assert_eq!(
                    blend_constant([dst; 4], [src; 4], factor as u8),
                    [expected; 4]
                );
            }
        }
    }
}

#[test]
fn encoder_rounds_the_float_product_before_rounding_the_byte() {
    let below_exact_half = f32::from_bits(0x3f32_3232);
    #[allow(clippy::excessive_precision)]
    const BELOW_EXACT_HALF: f32 = 0.6960784196853638;
    assert_eq!(below_exact_half, BELOW_EXACT_HALF);
    assert!((f64::from(below_exact_half) * 255.0) < 177.5);
    assert_eq!(encode_unorm8(below_exact_half), 178);
    assert_eq!(encode_oracle(below_exact_half), 178);
    for integer in 0..255 {
        let midpoint = ((f64::from(integer) + 0.5) / 255.0) as f32;
        for offset in -3_i64..=3 {
            let value = f32::from_bits((i64::from(midpoint.to_bits()) + offset) as u32);
            assert_eq!(encode_unorm8(value), encode_oracle(value));
        }
    }
    for exponent in 0..=127_u32 {
        for mantissa in [0, 1, 0x3f_ffff, 0x7f_fffe, 0x7f_ffff] {
            let value = f32::from_bits((exponent << 23) | mantissa);
            if value <= 1.0 {
                assert_eq!(encode_unorm8(value), encode_oracle(value));
            }
        }
    }
}

#[test]
fn byte_normalization_uses_the_rounded_reciprocal_and_roundtrips() {
    let reciprocal = f32::from_bits(0x3b80_8081);
    assert_eq!(reciprocal, (1.0_f64 / 255.0) as f32);
    let mut differs_from_exact_division = false;
    for byte in 0..=255_u8 {
        let expected = mul_f32_oracle(f32::from(byte), reciprocal);
        assert_eq!(normalize_byte(byte).to_bits(), expected.to_bits());
        assert_eq!(encode_unorm8(expected), byte);
        differs_from_exact_division |=
            expected.to_bits() != ((f64::from(byte) / 255.0) as f32).to_bits();
    }
    assert!(differs_from_exact_division);
}

#[test]
fn normal_over_quantizes_source_alpha_before_multiplying_destination() {
    assert_eq!(
        over([normalize_byte(128); 4], [0.1; 4]).map(encode_unorm8),
        [141; 4]
    );
    for alpha in 0..=255_u8 {
        for dst in 0..=255_u8 {
            let src = [normalize_byte(alpha); 4];
            let expected = (i64::from(alpha)
                + nearest_even(i64::from(dst) * i64::from(255 - alpha), 255))
            .min(255) as u8;
            assert_eq!(
                over([normalize_byte(dst); 4], src).map(encode_unorm8),
                [expected; 4]
            );
        }
    }
    assert_eq!(over([-2.0; 4], [2.0; 4]), [1.0; 4]);
}

#[test]
fn unsupported_weights_and_nonfinite_values_fail_explicitly() {
    assert!(std::panic::catch_unwind(|| lerp_byte(0, 255, 257)).is_err());
    assert!(std::panic::catch_unwind(|| sample_bytes([[0; 4]; 4], 0, 257)).is_err());
    for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, -0.01, 1.01] {
        assert!(std::panic::catch_unwind(|| encode_unorm8(value)).is_err());
    }
    assert!(std::panic::catch_unwind(|| over([0.0; 4], [f32::NAN; 4])).is_err());
}
