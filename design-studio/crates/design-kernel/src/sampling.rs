//! Correctly rounded bilinear interpolation of finite binary32 values.
//!
//! Fractions u,v are binary32 in [0,1]. Expand the bilinear polynomial into
//! nine dyadic terms; accumulate their unrounded products as a signed integer
//! with quantum 2^-447. 19 u32 limbs cover every finite f32 input, including
//! cancellation and subnormals. Only the final result is rounded (ties-even).
//! Exact zero has the canonical +0 encoding. No unsafe or host FMA is used.

const WORDS: usize = 19;

#[derive(Default)]
struct Accumulator([u32; WORDS]);

fn parts(v: f32) -> (u32, i32, bool) {
    let bits = v.to_bits();
    let exponent = (bits >> 23) & 255;
    let mantissa = (bits & 0x7fffff) | if exponent == 0 { 0 } else { 0x800000 };
    (mantissa, exponent.max(1) as i32 - 150, bits >> 31 != 0)
}

impl Accumulator {
    fn word(&mut self, mut index: usize, mut value: u32, subtract: bool) {
        while value != 0 && index < WORDS {
            let (next, carry) = if subtract {
                self.0[index].overflowing_sub(value)
            } else {
                self.0[index].overflowing_add(value)
            };
            self.0[index] = next;
            value = u32::from(carry);
            index += 1;
        }
    }
    fn term(&mut self, a: f32, b: f32, c: f32, negate: bool) {
        let (a, ae, negative) = parts(a);
        let (b, be, _) = parts(b);
        let (c, ce, _) = parts(c);
        let product = u128::from(a) * u128::from(b) * u128::from(c);
        if product == 0 {
            return;
        }
        let shift = (ae + be + ce + 447) as usize;
        for j in 0..3 {
            let value = (product >> (32 * j)) as u32;
            let index = shift / 32 + j;
            let offset = shift % 32;
            self.word(index, value << offset, negative ^ negate);
            if offset != 0 {
                self.word(index + 1, value >> (32 - offset), negative ^ negate);
            }
        }
    }
    fn rounded(mut self) -> f32 {
        let negative = self.0[WORDS - 1] >> 31 != 0;
        if negative {
            self.0.iter_mut().for_each(|w| *w = !*w);
            self.word(0, 1, false);
        }
        let Some(last) = self.0.iter().rposition(|w| *w != 0) else {
            return 0.;
        };
        let top = last * 32 + 31 - self.0[last].leading_zeros() as usize;
        // A subnormal result rounds to multiples of 2^-149, i.e. bit 298.
        let shift = top.saturating_sub(23).max(298);
        let index = shift / 32;
        let offset = shift % 32;
        let mut mantissa = self.0[index] >> offset;
        if offset != 0 {
            mantissa |= self.0[index + 1] << (32 - offset);
        }
        let guard = shift - 1;
        let guard_bit = self.0[guard / 32] & (1 << (guard % 32)) != 0;
        let sticky = self.0[..guard / 32].iter().any(|w| *w != 0)
            || self.0[guard / 32] & ((1 << (guard % 32)) - 1) != 0;
        mantissa += u32::from(guard_bit && (sticky || mantissa & 1 != 0));
        let mut exponent = if top < 321 { 0 } else { top as i32 - 447 + 127 };
        if mantissa >= 0x1000000 {
            mantissa >>= 1;
            exponent += 1;
        }
        if exponent == 0 && mantissa >= 0x800000 {
            exponent = 1;
        }
        f32::from_bits(
            (u32::from(negative) << 31) | ((exponent as u32) << 23) | (mantissa & 0x7fffff),
        )
    }
}

/// Single-round bilinear expression. Callers supply finite colors and [0,1]
/// fractions; interpolation is convex, so finite inputs cannot overflow.
pub fn bilinear(p: [f32; 4], u: f32, v: f32) -> f32 {
    if !p.iter().all(|x| x.is_finite()) || !(0. ..=1.).contains(&u) || !(0. ..=1.).contains(&v) {
        // Preserve a detectable invalid intermediate for the renderer's finite
        // output validation; never panic or turn an invalid input into pixels.
        return f32::NAN;
    }
    let p = p.map(|x| if x == 0. { 0. } else { x });
    if p.iter().all(|x| x.to_bits() == p[0].to_bits()) {
        return p[0];
    }
    if u == 0. && v == 0. {
        return p[0];
    }
    if u == 1. && v == 0. {
        return p[1];
    }
    if u == 0. && v == 1. {
        return p[2];
    }
    if u == 1. && v == 1. {
        return p[3];
    }
    // Certified fast path, not an epsilon acceptance test. Binary32 inputs
    // and their products stay normal in binary64 (smallest triple is 2^-447).
    // Four products, complement calculations and three additions contribute
    // less than 32 binary64 unit roundoffs times max|p|. Reserve 256 unit
    // roundoffs, including interval endpoint rounding. Accept only when both
    // endpoints round to the same binary32 bit pattern; ties/cancellation and
    // uncertain results still use the exact integer accumulator below.
    let x = f64::from(u);
    let y = f64::from(v);
    let a = p.map(f64::from);
    let approximate =
        a[0] * (1. - x) * (1. - y) + a[1] * x * (1. - y) + a[2] * (1. - x) * y + a[3] * x * y;
    let bound = 128. * f64::EPSILON * a.into_iter().map(f64::abs).fold(0., f64::max);
    let lower = (approximate - bound) as f32;
    let upper = (approximate + bound) as f32;
    if lower.to_bits() == upper.to_bits() {
        return lower;
    }
    let mut sum = Accumulator::default();
    sum.term(p[0], 1., 1., false);
    sum.term(p[0], u, 1., true);
    sum.term(p[0], v, 1., true);
    sum.term(p[0], u, v, false);
    sum.term(p[1], u, 1., false);
    sum.term(p[1], u, v, true);
    sum.term(p[2], v, 1., false);
    sum.term(p[2], u, v, true);
    sum.term(p[3], u, v, false);
    sum.rounded()
}

/// Color-independent sampling addresses. Integer texel cells and separately
/// rounded fractions avoid losing a low fraction when added to a large f32
/// coordinate. Callers charge the uploaded field to their GPU frame budget.
pub(crate) fn coordinate_grid(
    output: crate::math::Rect,
    source: crate::math::Rect,
    mut point: impl FnMut(i32, i32) -> Option<crate::math::Point>,
) -> Result<Vec<f32>, String> {
    let width = output.w as usize;
    let count = width
        .checked_mul(output.h as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or("Sampling coordinate size overflow")?;
    if count > 16_777_216 {
        return Err("Sampling coordinate field exceeds 64 MiB".into());
    }
    let right = output.checked_right().ok_or("Invalid sampling coordinate width")?;
    let bottom = output.checked_bottom().ok_or("Invalid sampling coordinate height")?;
    let mut values = Vec::new();
    if count == 0 {
        return Ok(values);
    }
    values
        .try_reserve_exact(count)
        .map_err(|_| "Sampling coordinate allocation failed")?;
    values.resize(count, 0.);
    let source_origin = (f64::from(source.x), f64::from(source.y));
    let source_size = (f64::from(source.w), f64::from(source.h));
    for (y, row) in (output.y..bottom).zip(values.chunks_exact_mut(width * 4)) {
        for (x, cell) in (output.x..right).zip(row.chunks_exact_mut(4)) {
            let Some(p) = point(x, y) else {
                cell.copy_from_slice(&[-2., -2., 0., 0.]);
                continue;
            };
            if !p.finite() {
                return Err("Nonfinite sample coordinate".into());
            }
            let sx = p.x - 0.5;
            let sy = p.y - 0.5;
            let ix = sx.floor();
            let iy = sy.floor();
            let rx = ix - source_origin.0;
            let ry = iy - source_origin.1;
            if rx < -1. || ry < -1. || rx >= source_size.0 || ry >= source_size.1 {
                cell.copy_from_slice(&[-2., -2., 0., 0.]);
            } else {
                cell.copy_from_slice(&[rx as f32, ry as f32, (sx - ix) as f32, (sy - iy) as f32]);
            }
        }
    }
    Ok(values)
}

/// Bounded geometry/material parameter field; callers provide coordinates or
/// interpolation parameters, never pre-rendered colors.
pub(crate) fn parameter_grid(
    output: crate::math::Rect,
    mut parameter: impl FnMut(i32, i32) -> Result<[f32; 4], String>,
) -> Result<Vec<f32>, String> {
    let right = i64::from(output.x)
        .checked_add(i64::from(output.w))
        .and_then(|v| i32::try_from(v).ok())
        .ok_or("Parameter field horizontal bounds overflow")?;
    let bottom = i64::from(output.y)
        .checked_add(i64::from(output.h))
        .and_then(|v| i32::try_from(v).ok())
        .ok_or("Parameter field vertical bounds overflow")?;
    // Multiplication must be checked before it happens, including on WASM32.
    let count = (output.w as usize)
        .checked_mul(output.h as usize)
        .and_then(|v| v.checked_mul(4))
        .ok_or("Parameter field size overflow")?;
    if count > 16_777_216 {
        return Err("Parameter field exceeds 64 MiB".into());
    }
    let mut values = Vec::new();
    values
        .try_reserve_exact(count)
        .map_err(|_| "Parameter field allocation failed")?;
    for y in output.y..bottom {
        for x in output.x..right {
            let v = parameter(x, y)?;
            if v.iter().any(|n| !n.is_finite()) {
                return Err("Nonfinite material parameter".into());
            }
            values.extend(v);
        }
    }
    Ok(values)
}

#[cfg(test)]
mod parameter_tests {
    use super::parameter_grid;
    use crate::math::Rect;

    #[test]
    fn rejects_overflowing_endpoints_before_running_the_parameter_function() {
        for rect in [
            Rect::new(i32::MAX, 0, 1, 1),
            Rect::new(0, i32::MAX, 1, 1),
            Rect::new(1, 0, u32::MAX, 1),
            Rect::new(0, 1, 1, u32::MAX),
        ] {
            let result = parameter_grid(rect, |_, _| panic!("invalid rectangle was evaluated"));
            assert!(result.is_err(), "accepted {rect:?}");
        }
    }

    #[test]
    fn retains_valid_world_origins_and_the_exact_output_length() {
        for (x, y) in [(i32::MIN, i32::MIN), (i32::MAX - 2, i32::MAX - 2)] {
            let rect = Rect::new(x, y, 2, 2);
            let mut visited = Vec::new();
            let values = parameter_grid(rect, |px, py| {
                visited.push((px, py));
                Ok([1., 2., 3., 4.])
            })
            .unwrap();
            assert_eq!(visited, [(x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)]);
            assert_eq!(values, [1., 2., 3., 4.].repeat(4));
        }
        let empty = parameter_grid(Rect::new(i32::MAX, i32::MIN, 0, 0), |_, _| {
            panic!("empty rectangle was evaluated")
        })
        .unwrap();
        assert!(empty.is_empty());
    }

    #[test]
    fn oversized_fields_are_rejected_without_allocating_or_visiting_pixels() {
        // Endpoints are valid; on a 32-bit target w*h would otherwise wrap to 0.
        let rect = Rect::new(0, 0, 65_536, 65_536);
        let result = parameter_grid(rect, |_, _| panic!("oversized field was evaluated"));
        assert!(result.is_err());
    }
}
