//! Explicit byte-domain sampling and blending primitives for software raster
//! compatibility. These functions do not select a renderer or identify the
//! backend used by an external application. They are not an HDR replacement.
//!
//! Mathematical rules were independently implemented from the Mesa 26.1.0
//! reference descriptions and verified with integer/rational test oracles:
//! - `src/gallium/auxiliary/gallivm/lp_bld_arit.c`: signed-delta interpolation,
//!   normalized products, complement and saturating addition.
//! - `src/gallium/drivers/llvmpipe/lp_bld_blend_aos.c` and `lp_bld_blend.c`:
//!   RGBA UNORM8 factor selection and separately rounded blend products.
//! - `src/gallium/auxiliary/gallivm/lp_bld_conv.c`: float-to-byte conversion
//!   rounds the binary32 multiplication before integer rounding; byte-to-float
//!   conversion multiplies by a binary32 reciprocal.
//!
//! Sources: <https://gitlab.freedesktop.org/mesa/mesa/-/tree/mesa-26.1.0/src/gallium>.
//! Those reference files carry the MIT permission notice (VMware and other
//! listed authors). This module contains independent formulas, no copied Mesa
//! source, shader text, reference pixels or lookup tables. The separate
//! trigonometry module documents its own attribution.
#![forbid(unsafe_code)]

pub mod trigonometry;

/// Interpolate bytes with a Q8 weight in 0..=256. Round the signed delta to
/// nearest-even before adding `a`; this is deliberately not a single rounding
/// of the complete affine expression. For example lerp_byte(1, 2, 128) is 1.
pub fn lerp_byte(a: u8, b: u8, weight: u32) -> u8 {
    assert!(weight <= 256);
    let product = (i32::from(b) - i32::from(a)) * weight as i32;
    let magnitude = product.unsigned_abs();
    let quotient = magnitude >> 8;
    let remainder = magnitude & 255;
    let rounded = quotient + u32::from(remainder > 128 || (remainder == 128 && quotient & 1 != 0));
    let delta = if product < 0 {
        -(rounded as i32)
    } else {
        rounded as i32
    };
    let result = i32::from(a) + delta;
    debug_assert!((0..=255).contains(&result));
    result as u8
}

/// Two-axis Q0 byte filtering. Taps are [top-left, top-right, bottom-left,
/// bottom-right], with premultiplied RGBA bytes. Each horizontal result is
/// rounded to a byte before vertical interpolation. Weights include 256.
pub fn sample_bytes(pixels: [[u8; 4]; 4], wx: u32, wy: u32) -> [u8; 4] {
    assert!(wx <= 256 && wy <= 256);
    std::array::from_fn(|channel| {
        let top = lerp_byte(pixels[0][channel], pixels[1][channel], wx);
        let bottom = lerp_byte(pixels[2][channel], pixels[3][channel], wx);
        lerp_byte(top, bottom, wy)
    })
}

/// Byte-filtered sample normalized with the binary32 reciprocal rule below.
pub fn sample_q8(pixels: [[u8; 4]; 4], wx: u32, wy: u32) -> [f32; 4] {
    sample_bytes(pixels, wx, wy).map(normalize_byte)
}

/// Normalize a byte using RN32(byte * RN32(1/255)). This can differ from
/// RN32(byte/255); keeping the pre-rounded reciprocal is part of the contract.
pub fn normalize_byte(value: u8) -> f32 {
    f32::from(value) * f32::from_bits(0x3b80_8081)
}

/// Encode finite binary32 in [0,1], first rounding the multiplication by 255
/// to binary32, then rounding the result to an integer with ties-to-even.
/// The caller must explicitly clamp finite values when its contract requires it.
pub fn encode_unorm8(value: f32) -> u8 {
    assert!(value.is_finite() && (0.0..=1.0).contains(&value));
    let scaled = value * 255.0_f32;
    scaled.round_ties_even() as u8
}

/// Nearest integer to a*b/255. Its odd denominator makes halfway cases
/// impossible, so adding 127 before integer division is exact over byte inputs.
fn product_unorm255(a: u8, b: u8) -> u8 {
    ((u32::from(a) * u32::from(b) + 127) / 255) as u8
}

/// Interpolate premultiplied RGBA8 using a quantized constant blend factor.
/// Source and destination products are rounded independently, then saturated.
/// The complementary factor is exactly 255-factor, not a second conversion.
pub fn blend_constant(previous: [u8; 4], source: [u8; 4], factor: u8) -> [u8; 4] {
    std::array::from_fn(|channel| {
        product_unorm255(source[channel], factor)
            .saturating_add(product_unorm255(previous[channel], 255 - factor))
    })
}

/// Normal premultiplied source-over in the byte domain. Finite input channels
/// are explicitly clamped and encoded before blending, including source alpha.
/// Results use the same reciprocal normalization as stored byte textures.
pub fn over(dst: [f32; 4], src: [f32; 4]) -> [f32; 4] {
    let to_byte = |value: f32| {
        assert!(value.is_finite());
        encode_unorm8(value.clamp(0.0, 1.0))
    };
    let source = src.map(to_byte);
    let destination = dst.map(to_byte);
    let inverse_alpha = 255 - source[3];
    std::array::from_fn(|channel| {
        normalize_byte(
            source[channel].saturating_add(product_unorm255(destination[channel], inverse_alpha)),
        )
    })
}

/// PNG/readback conversion in the same binary32 byte-normalization domain.
/// Divide before encoding: rational ties may move across the halfway point
/// when the normalized ratio rounds to binary32. Alpha is unchanged.
pub fn straight_rgba8(value: [u8; 4]) -> [u8; 4] {
    let alpha = normalize_byte(value[3]);
    let mut result = value;
    for channel in 0..3 {
        result[channel] = if value[3] == 0 {
            0
        } else {
            encode_unorm8((normalize_byte(value[channel]) / alpha).clamp(0., 1.))
        };
    }
    result
}
