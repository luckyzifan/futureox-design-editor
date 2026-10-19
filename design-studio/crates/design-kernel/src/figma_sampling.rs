//! Independently derived Apple RGBA8 sampling arithmetic for the measured Figma
//! compatibility path. No vendor source, shader strings, or reference-image
//! values are embedded here. This is not an HDR/analytic sampling replacement.
//!
//! Independent Metal readbacks and exact-arithmetic controls are described in
//! tests/figma_sampling.rs. The rendering pipeline must opt in explicitly;
//! matching these primitives is not a full-image Figma fidelity pass.

/// Round a finite binary32 interpolation fraction in [0,1] to Q8, half upward.
/// Scaling by a power of two is evaluated from the significand, avoiding a
/// floating add of 0.5 that can move a nearby non-tie onto a tie.
pub fn fraction_q8(value: f32) -> u32 {
    assert!(value.is_finite() && (0.0..=1.0).contains(&value));
    let bits = value.to_bits();
    let exponent = (bits >> 23) & 255;
    if exponent == 0 {
        return 0;
    }
    let significand = (bits & 0x7f_ffff) | 0x80_0000;
    let shift = 142 - exponent;
    if shift >= 25 {
        return 0;
    }
    (significand + (1 << (shift - 1))) >> shift
}

/// Exact RN-binary32(q / 4080), where q is an RGBA8 sample in Q4 byte units.
/// q/4080 = (q/255)/16. Normalizing q/255 requires at most a 32-bit numerator;
/// the odd divisor 255 cannot yield an exact binary32 halfway case.
pub fn normalize_q4(q: u32) -> f32 {
    assert!(q <= 4080);
    if q == 0 {
        return 0.0;
    }
    let msb = 31 - q.leading_zeros();
    let mut exponent = msb as i32 - 8;
    if msb >= 7 && q >= (255 << (msb - 7)) {
        exponent += 1;
    }
    let numerator = q << (23 - exponent) as u32;
    let quotient = numerator / 255;
    let remainder = numerator % 255;
    let significand = quotient + u32::from(remainder >= 128);
    debug_assert!((0x80_0000..0x100_0000).contains(&significand));
    f32::from_bits(((exponent + 123) as u32) << 23 | (significand - 0x80_0000))
}

/// Exact round-to-nearest-even UNORM8 encoding of finite binary32 in [0,1].
/// Multiplication by 255 is exact in a bounded u32 significand product; doing
/// the multiplication in f32 first can introduce a spurious half-byte tie.
pub fn encode_unorm8(value: f32) -> u8 {
    assert!(value.is_finite() && (0.0..=1.0).contains(&value));
    let bits = value.to_bits();
    let exponent = (bits >> 23) & 255;
    if exponent == 0 {
        return 0;
    }
    let significand = (bits & 0x7f_ffff) | 0x80_0000;
    let numerator = significand * 255;
    let shift = 150 - exponent;
    if shift >= 33 {
        return 0;
    }
    if shift == 32 {
        return u8::from(numerator > 0x8000_0000);
    }
    let quotient = numerator >> shift;
    let remainder = numerator & ((1 << shift) - 1);
    let halfway = 1 << (shift - 1);
    (quotient + u32::from(remainder > halfway || (remainder == halfway && quotient & 1 != 0))) as u8
}

/// Measured Apple/Metal byte-surface display conversion, not analytic or HDR.
/// The independent 256x256 GLSL probe samples RGBA8, divides by alpha and writes
/// an RGBA8 target. Its float readback proves RN byte normalization, reciprocal
/// multiplication, and 29 reciprocals one ULP above correctly-rounded division.
/// This 256-bit numeric-domain correction contains no reference image samples.
/// Provenance and all byte pairs: testing/fixtures/design/apple-unpremultiply-2026-10-13.
pub fn unpremultiply_rgba8(value: [u8; 4]) -> [u8; 4] {
    if value[3] == 0 {
        return [0; 4];
    }
    const RECIPROCAL_UP: [u32; 8] = [
        0x10004080, 0x81000000, 0x00880000, 0x48012080, 0x80080000, 0x000a4840, 0x8402c000,
        0x1040a001,
    ];
    let alpha = u32::from(value[3]);
    let reciprocal = 1.0_f32 / normalize_q4(alpha * 16);
    let up = (RECIPROCAL_UP[(alpha / 32) as usize] >> (alpha % 32)) & 1;
    let reciprocal = f32::from_bits(reciprocal.to_bits() + up);
    let mut result = value;
    for channel in 0..3 {
        let straight = normalize_q4(u32::from(value[channel]) * 16) * reciprocal;
        result[channel] = encode_unorm8(straight.clamp(0., 1.));
    }
    result
}

/// Bilinear RGBA8 sample. Pixels are [top-left, top-right, bottom-left,
/// bottom-right], already in the texture's premultiplied-byte representation.
/// Coordinate transforms/addressing are a separate contract. Both weights
/// range from 0 to 256 inclusive; endpoint 256 is legitimate.
pub fn sample_q8(pixels: [[u8; 4]; 4], wx: u32, wy: u32) -> [f32; 4] {
    assert!(wx <= 256 && wy <= 256);
    let weights = [
        (256 - wx) * (256 - wy),
        wx * (256 - wy),
        (256 - wx) * wy,
        wx * wy,
    ];
    std::array::from_fn(|channel| {
        // The weights sum to 65536, so numerator <=255*65536 <2^24.
        let numerator: u32 = (0..4)
            .map(|i| u32::from(pixels[i][channel]) * weights[i])
            .sum();
        normalize_q4((numerator + 2048) >> 12)
    })
}

/// RGBA8 encode of the normalized 2x2 texture average for one byte channel.
/// Non-half-byte results cannot cross the integer rounding boundary due to
/// binary32 normalization. For half-byte values, exact midpoint odd/510 has
/// binary32 rounding direction determined by its remainder modulo 255.
pub fn normalized_resolve_sum(sum: u32) -> u8 {
    assert!(sum <= 1020);
    let q = sum / 4;
    let remainder = sum % 4;
    if remainder != 2 {
        return (q + u32::from(remainder > 2)) as u8;
    }
    let odd = 2 * q + 1;
    if odd == 255 {
        return 128;
    }
    let msb = 31 - odd.leading_zeros();
    let shift = (31 - msb) % 8;
    // 2^8 ==1 mod255. Product <=254*128, safely inside u32.
    let binary_remainder = ((odd % 255) << shift) % 255;
    (q + u32::from(binary_remainder >= 128)) as u8
}

/// Straight, encoded SDR color, including alpha. Managed/HDR interpolation is
/// a separate contract and must not be routed through this lookup builder.
#[derive(Clone, Copy, Debug)]
pub struct GradientStop {
    pub offset: f32,
    pub color: [f32; 4],
}

pub const GRADIENT_LUT_WIDTH: usize = 1024;
pub const GRADIENT_LUT_HEIGHT: usize = 2;

/// Build a two-row RGBA8 lookup from binary32 stops. Row zero stores the high
/// byte of each premultiplied 16-bit component; row one stores its low byte.
///
/// Each sample uses binary32 j * (1/1023), then an unfused binary32
/// subtract/multiply/add interpolation. RGB is premultiplied *after* the
/// straight colors and alpha are interpolated. Multiplication by 65535 also
/// rounds to binary32 before the half-up conversion to an integer.
///
/// At duplicated offsets the earlier stop owns the exact sample position;
/// the next positive interval owns samples strictly past that position.
/// Texture coordinates, filtering and dithering are deliberately separate.
pub fn gradient_lut(stops: &[GradientStop]) -> Result<Vec<u8>, String> {
    if stops.is_empty() || stops.len() > 4096 {
        return Err("Gradient lookup requires 1 to 4096 stops".into());
    }
    if stops.iter().any(|stop| {
        !stop.offset.is_finite()
            || !(0.0..=1.0).contains(&stop.offset)
            || stop
                .color
                .iter()
                .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
    }) || stops.windows(2).any(|pair| pair[0].offset > pair[1].offset)
    {
        return Err("Gradient lookup requires sorted finite SDR stops".into());
    }
    let mut bytes = vec![0; GRADIENT_LUT_WIDTH * GRADIENT_LUT_HEIGHT * 4];
    let mut right = 0;
    let step = 1.0_f32 / (GRADIENT_LUT_WIDTH - 1) as f32;
    for index in 0..GRADIENT_LUT_WIDTH {
        let position = index as f32 * step;
        while right < stops.len() && stops[right].offset < position {
            right += 1;
        }
        let color = if right == 0 {
            stops[0].color
        } else if right == stops.len() {
            stops[stops.len() - 1].color
        } else {
            let left = stops[right - 1];
            let right = stops[right];
            let weight = if right.offset > left.offset {
                (position - left.offset) / (right.offset - left.offset)
            } else {
                0.0
            };
            std::array::from_fn(|channel| {
                left.color[channel] + (right.color[channel] - left.color[channel]) * weight
            })
        };
        for channel in 0..4 {
            let component = if channel == 3 {
                color[3]
            } else {
                color[channel] * color[3]
            };
            let encoded = (f64::from(component * 65535.0_f32) + 0.5) as u32;
            bytes[index * 4 + channel] = (encoded >> 8) as u8;
            bytes[GRADIENT_LUT_WIDTH * 4 + index * 4 + channel] = encoded as u8;
        }
    }
    Ok(bytes)
}
