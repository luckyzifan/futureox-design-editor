/**************************************************************************
 *
 * Copyright 2009-2010 VMware, Inc.
 * All Rights Reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sub license, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice (including the
 * next paragraph) shall be included in all copies or substantial portions
 * of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT.
 * IN NO EVENT SHALL VMWARE AND/OR ITS SUPPLIERS BE LIABLE FOR
 * ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 **************************************************************************/
//! Scalar translation of Mesa 26.1.0 Gallivm `lp_build_sin_or_cos`.
//! Source: https://gitlab.freedesktop.org/mesa/mesa/-/raw/mesa-26.1.0/src/gallium/auxiliary/gallivm/lp_bld_arit.c
//! Input, coefficients, each multiply/add, and each explicit `mul_add` are f32.
//! This is Mesa's approximation, not correctly-rounded mathematical sin/cos.
//! The source's FPToSI reduction is undefined outside its signed-i32 domain;
//! this wrapper reports that finite-input case rather than using Rust saturation.
#![forbid(unsafe_code)]

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReductionDomainError;

impl std::fmt::Display for ReductionDomainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("software sine/cosine range reduction exceeds its signed 32-bit domain")
    }
}
impl std::error::Error for ReductionDomainError {}

/// Returns (sin, cos). Non-finite input returns two NaNs as intended by Mesa.
/// Finite input whose abs(x)*(4/pi) rounds to >=2^31 is rejected.
pub fn checked_sin_cos(value: f32) -> Result<(f32, f32), ReductionDomainError> {
    if !value.is_finite() {
        return Ok((f32::NAN, f32::NAN));
    }
    let magnitude = value.abs();
    let scaled = magnitude * 1.273_239_5_f32;
    if !scaled.is_finite() || scaled >= 2_147_483_648.0_f32 {
        return Err(ReductionDomainError);
    }
    let quadrant_plus_one = scaled as i32 + 1;
    let even_quadrant = quadrant_plus_one & !1;
    let y = even_quadrant as f32;

    let x = y.mul_add(-0.78515625_f32, magnitude);
    let x = y.mul_add(-2.418_756_5e-4_f32, x);
    let x = y.mul_add(-3.774_895e-8_f32, x);
    let square = x * x;

    let cosine = square.mul_add(2.443_315_7E-5_f32, -1.388_731_6E-3_f32);
    let cosine = cosine.mul_add(square, 4.166_664_6E-2_f32);
    let cosine = cosine * square;
    let cosine = cosine * square;
    let half_square = square * 0.5_f32;
    let cosine = cosine - half_square;
    let cosine = cosine + 1.0_f32;

    let sine = square.mul_add(-1.951_529_6E-4_f32, 8.332_161E-3_f32);
    let sine = sine.mul_add(square, -1.666_665_5E-1_f32);
    let sine = sine * square;
    let sine = sine.mul_add(x, x);

    let select = |quadrant: i32| if quadrant & 2 == 0 { sine } else { cosine };
    let sin_sign = (value.to_bits() & 0x8000_0000) ^ (((quadrant_plus_one as u32) & 4) << 29);
    let cos_quadrant = even_quadrant - 2;
    let cos_sign = (((!cos_quadrant) as u32) & 4) << 29;
    let sin = f32::from_bits(select(even_quadrant).to_bits() ^ sin_sign).clamp(-1.0, 1.0);
    let cos = f32::from_bits(select(cos_quadrant).to_bits() ^ cos_sign).clamp(-1.0, 1.0);
    Ok((sin, cos))
}

/// Mesa-compatible sine/cosine for the supported reduction domain.
/// Non-finite input or a finite input outside that domain returns two NaNs.
/// Use `checked_sin_cos` when the caller needs a distinct range-reduction error.
/// Export noise (<50,000 radians) and normalized glass light angles are in range.
pub fn sin_cos(value: f32) -> (f32, f32) {
    checked_sin_cos(value).unwrap_or((f32::NAN, f32::NAN))
}

pub fn sin(value: f32) -> f32 {
    sin_cos(value).0
}

pub fn cos(value: f32) -> f32 {
    sin_cos(value).1
}
