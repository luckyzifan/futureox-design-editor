//! Portable linear-paint coordinates on the renderer's eighth-pixel sample grid.
//! Coefficients retain up to 52 fractional bits; products and sums are signed
//! 64-bit integers on both CPU and GPU. This avoids shader contraction changing
//! a gradient's final RGBA8 rounding decision.
use crate::{
    math::{Point, Rect, Transform},
    scene::Paint,
};
use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct FixedGradient {
    pub bits: u32,
    /// Four exactly representable u16 words per signed coefficient, low first.
    pub words: [[u16; 4]; 3],
}
impl FixedGradient {
    pub fn new(
        paint: &Paint,
        inverse: Transform,
        size: [f64; 2],
        bounds: Rect,
    ) -> Result<Option<Self>, String> {
        if paint.kind != "linear" || paint.stops.is_empty() {
            return Ok(None);
        }
        if [
            i64::from(bounds.x),
            i64::from(bounds.y),
            i64::from(bounds.x) + i64::from(bounds.w),
            i64::from(bounds.y) + i64::from(bounds.h),
        ]
        .into_iter()
        .any(|v| v.unsigned_abs() > 32768)
        {
            // Fixed-point coordinates are an optional precision fast path.
            // Valid distant/small imported gradients use the general sampler.
            return Ok(None);
        }
        let m = inverse.0;
        let (a, b, offset) = if let Some(transform) = paint.transform {
            let t = transform.inverse()?.0;
            (t[0], t[2], t[4])
        } else {
            let (sin, cos) = paint.angle.to_radians().sin_cos();
            let norm = cos.abs() + sin.abs();
            (cos / norm, sin / norm, 0.5 - (cos + sin) / norm * 0.5)
        };
        let values = [
            m[0] / size[0] * a + m[1] / size[1] * b,
            m[2] / size[0] * a + m[3] / size[1] * b,
            m[4] / size[0] * a + m[5] / size[1] * b + offset,
        ];
        if values.iter().any(|v| !v.is_finite()) {
            return Err("Invalid linear paint coordinates".into());
        }
        for bits in (24..=52).rev() {
            let scale = (1_u64 << bits) as f64;
            if values
                .iter()
                .any(|v| (v * scale).abs() >= (1_u64 << 61) as f64)
            {
                continue;
            }
            let fixed = values.map(|v| (v * scale).round_ties_even() as i64);
            let bound = (u128::from(fixed[0].unsigned_abs()) + u128::from(fixed[1].unsigned_abs()))
                * 32768
                * 8
                + u128::from(fixed[2].unsigned_abs()) * 8;
            if bound >= 1_u128 << 61 {
                continue;
            }
            let error = (values[0] - fixed[0] as f64 / scale).abs() * 32768.
                + (values[1] - fixed[1] as f64 / scale).abs() * 32768.
                + (values[2] - fixed[2] as f64 / scale).abs();
            if error > 1e-8 {
                continue;
            }
            return Ok(Some(Self {
                bits,
                words: fixed
                    .map(|v| std::array::from_fn(|i| ((v as u64 >> (i * 16)) & 65535) as u16)),
            }));
        }
        Ok(None)
    }
    pub fn parameter(&self, point: Point) -> f32 {
        let values = self.words.map(|words| {
            words
                .into_iter()
                .enumerate()
                .fold(0_u64, |v, (i, w)| v | (u64::from(w) << (i * 16))) as i64
        });
        let x = (point.x * 8.).round_ties_even() as i64;
        let y = (point.y * 8.).round_ties_even() as i64;
        let value = values[0] * x + values[1] * y + values[2] * 8;
        let denominator = 1_i64 << (self.bits + 3);
        let value = value.clamp(0, denominator) as u64;
        if value == 0 {
            return 0.;
        }
        let mut top = 63 - value.leading_zeros();
        let mut mantissa = if top <= 23 {
            value << (23 - top)
        } else {
            let shift = top - 23;
            let q = value >> shift;
            let remainder = value & ((1_u64 << shift) - 1);
            let halfway = 1_u64 << (shift - 1);
            q + u64::from(remainder > halfway || (remainder == halfway && q & 1 != 0))
        };
        if mantissa == 1 << 24 {
            mantissa >>= 1;
            top += 1;
        }
        f32::from_bits(
            ((top as i32 - (self.bits + 3) as i32 + 127) as u32) << 23
                | (mantissa as u32 & 0x7fffff),
        )
    }
}
