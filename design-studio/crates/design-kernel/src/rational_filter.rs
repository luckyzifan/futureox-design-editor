//! Exact integrated-tent coefficients and correctly rounded binary32 filtering.
//!
//! Radius is the authored binary64 value, without a binary32 parameter cast.
//! A coefficient is an integer numerator / a common positive denominator.
//! Accumulation uses exact products at quantum 2^-149, then one rational RNE.
//! 44 words cover the smallest binary64 radius (denominator < 2^1077),
//! every finite binary32 sample (scaled magnitude < 2^277), and a sign bit.
use crate::{
    blend::{Pixel, Surface},
    math::Rect,
};

const WORDS: usize = 44;
/// CQ48: a separate, versioned enclosure packet, never a replacement coefficient.
pub const CERTIFIED_KERNEL_MAGIC: u32 = 0x3834_5143;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Nat([u32; WORDS]);
impl Nat {
    fn zero() -> Self {
        Self([0; WORDS])
    }
    fn from_u64(n: u64) -> Self {
        let mut a = Self::zero();
        a.0[0] = n as u32;
        a.0[1] = (n >> 32) as u32;
        a
    }
    fn high(&self) -> Option<usize> {
        self.0
            .iter()
            .rposition(|v| *v != 0)
            .map(|i| i * 32 + 31 - self.0[i].leading_zeros() as usize)
    }
    fn trailing(&self) -> usize {
        self.0
            .iter()
            .position(|v| *v != 0)
            .map_or(WORDS * 32, |i| i * 32 + self.0[i].trailing_zeros() as usize)
    }
    fn cmp(&self, b: &Self) -> std::cmp::Ordering {
        self.0.iter().rev().cmp(b.0.iter().rev())
    }
    fn mul(&self, n: u64) -> Self {
        let mut out = Self::zero();
        let mut carry = 0_u128;
        for (a, b) in self.0.iter().zip(&mut out.0) {
            let v = u128::from(*a) * u128::from(n) + carry;
            *b = v as u32;
            carry = v >> 32;
        }
        assert_eq!(carry, 0, "proved rational-filter product capacity");
        out
    }
    fn shl(&self, n: usize) -> Self {
        let mut out = Self::zero();
        let whole = n / 32;
        let part = n % 32;
        for (i, &v) in self.0.iter().enumerate() {
            if v == 0 {
                continue;
            }
            assert!(i + whole < WORDS, "proved rational-filter shift capacity");
            out.0[i + whole] |= v << part;
            if part != 0 {
                let carry = v >> (32 - part);
                if carry != 0 {
                    assert!(i + whole + 1 < WORDS);
                    out.0[i + whole + 1] |= carry;
                }
            }
        }
        out
    }
    fn shr(&self, n: usize) -> Self {
        let mut out = Self::zero();
        let whole = n / 32;
        let part = n % 32;
        for (i, v) in out.0.iter_mut().enumerate().take(WORDS - whole) {
            *v = self.0[i + whole] >> part;
            if part != 0 && i + whole + 1 < WORDS {
                *v |= self.0[i + whole + 1] << (32 - part);
            }
        }
        out
    }
    fn add_assign(&mut self, b: &Self) {
        let mut carry = 0_u64;
        for (a, b) in self.0.iter_mut().zip(&b.0) {
            let s = u64::from(*a) + u64::from(*b) + carry;
            *a = s as u32;
            carry = s >> 32;
        }
    }
    fn sub_assign(&mut self, b: &Self) {
        let mut borrow = false;
        for (a, b) in self.0.iter_mut().zip(&b.0) {
            let (v, b1) = a.overflowing_sub(*b);
            let (v, b2) = v.overflowing_sub(u32::from(borrow));
            *a = v;
            borrow = b1 || b2;
        }
    }
    fn as_f64(&self) -> f64 {
        self.0
            .iter()
            .rev()
            .fold(0., |a, b| a * 4294967296. + f64::from(*b))
    }
}

#[derive(Clone, Debug)]
pub struct RationalKernel {
    denominator: Nat,
    weights: Vec<Nat>,
    approximations: Vec<f64>,
}

/// Q64 interior plan shared with the GPU prefix. `None` keeps the general
/// rational evaluator; accepted pixels match `exact` binary32 bits.
pub(crate) struct Q64Prefix {
    pub weights: Vec<u128>,
    pub interior: usize,
    pub bound: u32,
    pub center: i128,
    pub slope: i128,
    pub intercept: i128,
}
impl RationalKernel {
    pub fn tent(radius: f64) -> Result<Self, String> {
        if !radius.is_finite() || radius <= 0. || radius > 2048. {
            return Err("Exact blur radius must be in (0,2048]".into());
        }
        Self::tent_coefficients(radius)
    }
    /// Separate canvas candidate for large finite support. The old operator's
    /// 2048 boundary remains intact; serialized GPU packets still cap at 64 KiB.
    pub fn large_tent(radius: f64) -> Result<Self, String> {
        if !radius.is_finite() || !(2048. ..=4096.).contains(&radius) || radius == 2048. {
            return Err("Exact large blur radius must be in (2048,4096]".into());
        }
        let kernel = Self::tent_coefficients(radius)?;
        let words = (kernel.denominator.high().expect("positive denominator") + 1).div_ceil(32);
        if 4 + words * (kernel.reach() + 2) > 16384 {
            return Err("Large exact filter packet exceeds 64 KiB".into());
        }
        Ok(kernel)
    }
    fn tent_coefficients(radius: f64) -> Result<Self, String> {
        let bits = radius.to_bits();
        let exponent = ((bits >> 52) & 2047) as i32;
        let mut m = (bits & 0xfffffffffffff) | if exponent == 0 { 0 } else { 1_u64 << 52 };
        let mut e = exponent.max(1) - 1075;
        let zeros = m.trailing_zeros();
        m >>= zeros;
        e += zeros as i32;
        let k = if e >= 0 {
            m <<= e;
            0
        } else {
            (-e) as usize
        };
        let reach = radius.ceil() as usize;
        let (mut denominator, mut weights) = if radius <= 1. {
            let den = Nat::from_u64(6).shl(k);
            let mut center = den.clone();
            center.sub_assign(&Nat::from_u64(m).mul(2));
            (den, vec![center, Nat::from_u64(m)])
        } else {
            let q = 1_u64 << k;
            let den = Nat::from_u64(m).mul(m).mul(6).shl(k);
            let mut weights = Vec::with_capacity(reach + 1);
            for distance in 0..=reach {
                let d = distance as u64;
                let n = if d == 0 {
                    Nat::from_u64(6 * m - 2 * q).shl(2 * k)
                } else if (d + 1) * q <= m {
                    Nat::from_u64(6 * (m - d * q)).shl(2 * k)
                } else {
                    let a = (m + q).saturating_sub(d * q);
                    let b = m.saturating_sub(d * q);
                    let mut n = Nat::from_u64(a).mul(a).mul(a);
                    n.sub_assign(&Nat::from_u64(b).mul(b).mul(b).mul(2));
                    n
                };
                weights.push(n);
            }
            (den, weights)
        };
        let shift = weights
            .iter()
            .map(Nat::trailing)
            .chain([denominator.trailing()])
            .min()
            .unwrap_or(0);
        denominator = denominator.shr(shift);
        for w in &mut weights {
            *w = w.shr(shift);
        }
        let mut mass = weights[0].clone();
        for w in &weights[1..] {
            mass.add_assign(&w.mul(2));
        }
        if mass != denominator {
            return Err("Exact blur coefficient mass invariant".into());
        }
        let d = denominator.as_f64();
        let approximations = weights.iter().map(|n| n.as_f64() / d).collect();
        Ok(Self {
            denominator,
            weights,
            approximations,
        })
    }
    /// Uniform rational weights for each stage of the three-box Gaussian.
    pub fn uniform_box(radius: u32) -> Result<Self, String> {
        if radius > 512 {
            return Err("Box filter radius exceeds 512 pixels".into());
        }
        Self::regional_box(radius)
    }
    /// Same rational operator, restricted to native streamed display plans.
    pub(crate) fn regional_box(radius:u32)->Result<Self,String> {
        if radius>1024{return Err("Regional box radius exceeds 1024 pixels".into());}
        let denominator = 2 * radius + 1;
        Ok(Self {
            denominator: Nat::from_u64(u64::from(denominator)),
            weights: vec![Nat::from_u64(1); radius as usize + 1],
            approximations: vec![1. / f64::from(denominator); radius as usize + 1],
        })
    }
    pub fn reach(&self) -> usize {
        self.weights.len() - 1
    }
    /// Packed u32 words, each encoded as one little-endian RGBA8 texel. Header:
    /// coefficient words, accumulator words, radius reach, reserved; denominator
    /// then symmetric coefficients from center outward. Fits a 16384-wide row (the portable WebGPU texture limit).
    pub fn encoded(&self) -> Vec<u8> {
        let high = self.denominator.high().expect("positive denominator");
        let cw = (high + 1).div_ceil(32);
        let aw = (high + 1 + 277 + 1).div_ceil(32);
        let mut data = vec![cw as u32, aw as u32, self.reach() as u32, 0];
        data.extend_from_slice(&self.denominator.0[..cw]);
        for w in &self.weights {
            data.extend_from_slice(&w.0[..cw]);
        }
        assert!(
            data.len() <= 16384 && aw <= WORDS,
            "proved coefficient packet capacity"
        );
        data.into_iter().flat_map(u32::to_le_bytes).collect()
    }
    fn certified_weights(&self) -> Vec<u64> {
        self.certified_weights_at(48).into_iter().map(|v| v as u64).collect()
    }
    fn certified_weights_at(&self, precision: u32) -> Vec<u128> {
        self.weights
            .iter()
            .map(|weight| {
                // Integer long division is essential: a binary64 approximation
                // followed by floor is not an outward coefficient enclosure.
                let mut remainder = weight.shl(precision as usize);
                let mut divisor = self.denominator.shl(precision as usize);
                let mut quotient = 0_u128;
                for bit in (0..=precision).rev() {
                    if !remainder.cmp(&divisor).is_lt() {
                        remainder.sub_assign(&divisor);
                        quotient |= 1_u128 << bit;
                    }
                    if bit > 0 {
                        divisor = divisor.shr(1);
                    }
                }
                assert!(quotient <= 1_u128 << precision, "coefficient is in [0,1]");
                quotient
            })
            .collect()
    }
    /// Separate RGBA8 packet: [CQ48, reach, 48, 0], then the low/high u32
    /// words of floor(weight * 2^48), or Q64 when header[3] is 64, from the
    /// center outwards. Shifting Q64 by 16 recovers the identical Q48 floor.
    /// The upper endpoint is q+1, including exactly representable coefficients.
    pub fn certified_encoded(&self) -> Vec<u8> {
        self.certified_packet(None).0
    }
    /// Bound the exact signed intermediates of the proposed Q64 prefix.
    /// This is tied to complete actual packet bytes, never a radius-only hint.
    pub fn certified_prefix_plan(&self, interior: usize, bytes: &[u8]) -> Option<u32> {
        let (expected, bound) = self.certified_packet(Some(interior));
        (expected == bytes).then_some(bound).flatten()
    }
    /// Same admission as [`Self::certified_prefix_plan`], with the coefficients
    /// retained for a line prefix. The radius still selects the kernel; this
    /// does not widen the 2048 tent limit or the Q64 interior proof.
    pub(crate) fn q64_prefix(&self, radius: f64) -> Option<Q64Prefix> {
        if !radius.is_finite() || radius < 8. {
            return None;
        }
        let interior = radius.floor() as usize - 1;
        if self.reach() != radius.ceil() as usize {
            return None;
        }
        let wide = self.reach() >= 3 && self.weights[0].cmp(&self.denominator).is_lt();
        if !wide {
            return None;
        }
        let weights = self.certified_weights_at(64);
        let bound = Self::certified_prefix_bound(&weights, interior)?;
        let slope = weights[1].checked_sub(weights[2])?;
        let intercept = weights[1].checked_add(slope)?;
        Some(Q64Prefix {
            center: i128::try_from(weights[0]).ok()?,
            slope: i128::try_from(slope).ok()?,
            intercept: i128::try_from(intercept).ok()?,
            weights,
            interior,
            bound,
        })
    }
    fn certified_prefix_bound(weights: &[u128], interior: usize) -> Option<u32> {
        let reach=weights.len().checked_sub(1)?;
        if !(7..=511).contains(&interior)||reach<interior||reach-interior>4{return None;}
        let slope=weights[1].checked_sub(weights[2])?;let intercept=weights[1].checked_add(slope)?;
        for (d,&actual) in weights.iter().enumerate().take(interior+1).skip(1){
            let approximate=intercept.checked_sub(slope.checked_mul(d as u128)?)?;
            if actual.abs_diff(approximate)>(d+2)as u128{return None;}
        }
        let bits=|value:u128|128-value.leading_zeros();
        let tails=weights.iter().skip(interior+1).try_fold(0_u128,|sum,value|sum.checked_add(*value))?.checked_mul(2)?;
        let width=(interior*interior+7*interior+1+2*(reach-interior))as u128;
        // Five absolute terms: center, interior sum, distance moment, tails,
        // and enclosure width. Three extra bits dominate their total, even
        // with arbitrary mixed signs and cancellation in the real samples.
        let bound=[bits(weights[0]),bits(intercept)+bits(2*interior as u128),
            bits(slope)+bits((interior*(interior+1))as u128),bits(tails),bits(width)]
            .into_iter().max()?.checked_add(3)?;
        (bound<=120).then_some(bound)
    }
    fn certified_packet(&self, interior: Option<usize>) -> (Vec<u8>,Option<u32>) {
        // The old Q48 certificate is recovered exactly by discarding 16 low
        // bits. Prefix filtering uses the full Q64 coefficient to avoid a
        // radius-squared enclosure error at high zoom. A unit coefficient
        // (box radius zero) keeps the original packet because 2^64 needs 65 bits.
        let wide = self.reach() >= 3 && self.weights[0].cmp(&self.denominator).is_lt();
        let precision = if wide { 64 } else { 48 };
        let mut words = vec![CERTIFIED_KERNEL_MAGIC, self.reach() as u32, 48, if wide {64} else {0}];
        let weights=self.certified_weights_at(precision);
        let bound=if wide{interior.and_then(|n|Self::certified_prefix_bound(&weights,n))}else{None};
        for weight in weights {
            words.push(weight as u32);
            words.push((weight >> 32) as u32);
        }
        (words.into_iter().flat_map(u32::to_le_bytes).collect(),bound)
    }
    /// Portable reference for the Q48 GPU certificate. No floating-point
    /// arithmetic participates in acceptance. None means use the exact path.
    ///
    /// With tap_bits=ceil(log2(taps)), a 24-bit mantissa, q+1 <= 2^48+1,
    /// and exponent span <=min(40,51-tap_bits), each product is <2^73.
    /// The absolute sum of all intermediate terms is <2^124. Signed i128 (and the
    /// shader's four u32 limbs) therefore cannot overflow, including severe
    /// cancellation. Each exact coefficient lies in [q,q+1]*2^-48.
    /// Signed endpoint accumulation preserves this enclosure. Accept only
    /// when both dyadic endpoints round to the same binary32 bits.
    pub fn certified_convolve(&self, values: &[f32]) -> Result<Option<f32>, String> {
        if values.len() != self.reach() * 2 + 1 || values.iter().any(|v| !v.is_finite()) {
            return Err("Certified filter requires finite values and complete taps".into());
        }
        if values.iter().all(|v| v.to_bits() == values[0].to_bits()) {
            return Ok(Some(if values[0] == 0. { 0. } else { values[0] }));
        }
        let mut min_exponent = 255;
        let mut max_exponent = 0;
        for value in values {
            let bits = value.to_bits();
            if bits & 0x7fff_ffff != 0 {
                let exponent = ((bits >> 23) & 255).max(1);
                min_exponent = min_exponent.min(exponent);
                max_exponent = max_exponent.max(exponent);
            }
        }
        if max_exponent == 0 {
            return Ok(Some(0.));
        }
        let tap_bits = usize::BITS - (self.reach() * 2).leading_zeros();
        if max_exponent - min_exponent > 40.min(51 - tap_bits) {
            return Ok(None);
        }
        let weights = self.certified_weights();
        let (mut lower, mut upper) = (0_i128, 0_i128);
        for (index, value) in values.iter().enumerate() {
            let bits = value.to_bits();
            let exponent = (bits >> 23) & 255;
            let mantissa =
                u128::from((bits & 0x7f_ffff) | if exponent == 0 { 0 } else { 0x80_0000 });
            if mantissa == 0 {
                continue;
            }
            let shift = exponent.max(1) - min_exponent;
            let weight = u128::from(weights[index.abs_diff(self.reach())]);
            let low = ((mantissa * weight) << shift) as i128;
            let high = ((mantissa * (weight + 1)) << shift) as i128;
            if bits >> 31 == 0 {
                lower += low;
                upper += high;
            } else {
                lower -= high;
                upper -= low;
            }
        }
        let quantum = min_exponent as i32 - 198;
        let lo = round_certified_dyadic(lower, quantum);
        let hi = round_certified_dyadic(upper, quantum);
        Ok((lo == hi && lo & 0x7f80_0000 != 0x7f80_0000).then(|| f32::from_bits(lo)))
    }
    fn exact(&self, values: &[f32]) -> f32 {
        let mut sum = Nat::zero();
        for (i, &v) in values.iter().enumerate() {
            let bits = v.to_bits();
            let e = (bits >> 23) & 255;
            let m = (bits & 0x7fffff) | if e == 0 { 0 } else { 0x800000 };
            let p = self.weights[i.abs_diff(self.reach())]
                .mul(u64::from(m))
                .shl(e.max(1) as usize - 1);
            if bits >> 31 == 0 {
                sum.add_assign(&p);
            } else {
                sum.sub_assign(&p);
            }
        }
        let negative = sum.0[WORDS - 1] >> 31 != 0;
        if negative {
            let mut magnitude = Nat::zero();
            magnitude.sub_assign(&sum);
            sum = magnitude;
        }
        let Some(top) = sum.high() else {
            return 0.;
        };
        let dh = self.denominator.high().expect("positive denominator");
        let mut h = top as i32 - dh as i32;
        if h >= 0 && sum.cmp(&self.denominator.shl(h as usize)).is_lt() {
            h -= 1;
        }
        let shift = (h - 23).max(0) as usize;
        let mut divisor = self.denominator.shl(shift + 23);
        let mut quotient = 0_u32;
        for i in (0..24).rev() {
            if !sum.cmp(&divisor).is_lt() {
                sum.sub_assign(&divisor);
                quotient |= 1 << i;
            }
            if i > 0 {
                divisor = divisor.shr(1);
            }
        }
        let doubled = sum.shl(1);
        let order = doubled.cmp(&divisor);
        quotient += u32::from(order.is_gt() || (order.is_eq() && quotient & 1 != 0));
        let mut exponent = (h - 22).max(0) as u32;
        if quotient >= 0x1000000 {
            quotient >>= 1;
            exponent += 1;
        }
        if exponent == 0 && quotient >= 0x800000 {
            exponent = 1;
        }
        f32::from_bits((u32::from(negative) << 31) | (exponent << 23) | (quotient & 0x7fffff))
    }
    pub fn convolve(&self, values: &[f32]) -> Result<f32, String> {
        if values.len() != self.reach() * 2 + 1 || values.iter().any(|v| !v.is_finite()) {
            return Err("Exact filter requires finite values and complete taps".into());
        }
        if values.iter().all(|v| v.to_bits() == values[0].to_bits()) {
            return Ok(if values[0] == 0. { 0. } else { values[0] });
        }
        // Conservative binary64 certificate. Coefficient conversion uses at
        // most 44 limb steps, division, products and <=1025 additions. Bound
        // absolute error by 4096 eps * taps * max|sample|. Nonfinite estimates,
        // cancellation and all rounding-boundary intervals take exact division.
        let mut candidate = 0.;
        let mut magnitude = 0_f64;
        for (i, &v) in values.iter().enumerate() {
            candidate += f64::from(v) * self.approximations[i.abs_diff(self.reach())];
            magnitude = magnitude.max(f64::from(v).abs());
        }
        let error = 4096. * f64::EPSILON * values.len() as f64 * magnitude;
        let lo = (candidate - error) as f32;
        let hi = (candidate + error) as f32;
        if candidate.is_finite() && lo.to_bits() == hi.to_bits() {
            return Ok(lo);
        }
        Ok(self.exact(values))
    }
}

/// Round an exact signed integer * 2^quantum without native float operations.
/// Exact zero is +0; a strictly negative value rounding to zero remains -0.
pub(crate) fn round_certified_dyadic(value: i128, quantum: i32) -> u32 {
    if value == 0 {
        return 0;
    }
    let negative = value < 0;
    let magnitude = value.unsigned_abs();
    let top = 127 - magnitude.leading_zeros() as i32;
    let exponent = top + quantum;
    let unit = (exponent - 23).max(-149);
    let shift = unit - quantum;
    let mut mantissa = if shift <= 0 {
        magnitude << -shift
    } else if shift >= 128 {
        0
    } else {
        let quotient = magnitude >> shift;
        let remainder = magnitude & ((1_u128 << shift) - 1);
        let half = 1_u128 << (shift - 1);
        quotient + u128::from(remainder > half || (remainder == half && quotient & 1 != 0))
    };
    let mut raw_exponent = if exponent >= -126 {
        (exponent + 127) as u32
    } else {
        0
    };
    if mantissa >= 0x100_0000 {
        mantissa >>= 1;
        raw_exponent += 1;
    }
    if raw_exponent == 0 && mantissa >= 0x80_0000 {
        raw_exponent = 1;
    }
    let sign = u32::from(negative) << 31;
    if raw_exponent >= 255 {
        return sign | 0x7f80_0000;
    }
    sign | (raw_exponent << 23) | (mantissa as u32 & 0x7f_ffff)
}

pub fn blur(input: &Surface, radius: f64, clamp_edges: bool) -> Result<Surface, String> {
    blur_owned(input.try_clone()?, radius, clamp_edges)
}

pub(crate) fn blur_owned(
    mut current: Surface,
    radius: f64,
    clamp_edges: bool,
) -> Result<Surface, String> {
    if radius <= 0. {
        return Ok(current);
    }
    let kernel = RationalKernel::tent(radius)?;
    // Measured crossover: direct convolution wins at r=16; certified prefix
    // wins at r=32 and r=64 on both 64x64 and 256x256 varying HDR inputs.
    // Dispatch changes cost only: both paths require the same exact RNE.
    if radius >= 32. {
        return crate::certified_filter::blur_owned(current, radius, clamp_edges, &kernel);
    }
    let _scratch = current.reserve_scratch::<f32>(kernel.reach() * 2 + 1)?;
    let mut values = vec![0.; kernel.reach() * 2 + 1];
    for horizontal in [true, false] {
        let Rect { x, y, w, h } = current.rect;
        let mut out = current.new_like(current.rect)?;
        for py in y..y + h as i32 {
            for px in x..x + w as i32 {
                let mut channels = [0.; 4];
                for (channel, value) in channels.iter_mut().enumerate() {
                    for (i, v) in values.iter_mut().enumerate() {
                        let delta = i as i32 - kernel.reach() as i32;
                        let (mut sx, mut sy) = if horizontal {
                            (px + delta, py)
                        } else {
                            (px, py + delta)
                        };
                        if clamp_edges {
                            sx = sx.clamp(x, x + w as i32 - 1);
                            sy = sy.clamp(y, y + h as i32 - 1);
                        }
                        *v = current.at(sx, sy).0[channel];
                    }
                    *value = kernel.convolve(&values)?;
                }
                out.pixels[current.rect.index(px, py).expect("in-bounds filter output")] =
                    Pixel(channels);
            }
        }
        current = out;
    }
    Ok(current)
}

#[cfg(test)]
mod large_tent_tests {
    use super::*;
    #[test]
    fn large_tent_packets_keep_mass_and_bounded_certificate() {
        for radius in [512.0000000000001, 1024., 1224.3035888671875, 2048.] {
            let kernel=RationalKernel::tent(radius).unwrap();
            assert!(kernel.encoded().len()/4<=16384);
            assert_eq!(kernel.reach(),radius.ceil() as usize);
            let constant=vec![0.25;kernel.reach()*2+1];
            assert_eq!(kernel.exact(&constant).to_bits(),0.25_f32.to_bits());
            assert_eq!(kernel.certified_convolve(&constant).unwrap().unwrap().to_bits(),0.25_f32.to_bits());
            let values:Vec<f32>=(0..constant.len()).map(|i|f32::from_bits(((110+i as u32%17)<<23)|(i as u32*7919&0x7fffff))).collect();
            if let Some(actual)=kernel.certified_convolve(&values).unwrap() {
                assert_eq!(actual.to_bits(),kernel.exact(&values).to_bits());
            }
        }
        assert!(RationalKernel::tent(2048.0001).is_err());
    }
}

#[cfg(test)]
mod certified_prefix_interval_tests {
    use super::*;
    // Independent CPU model of the GPU enclosure. Its accepted bits are
    // compared with the general 44-word exact convolution, including borders.
    fn prefix(kernel:&RationalKernel,radius:f64,line:&[f32],x:usize,q:&[u128],bound:u32)->Option<u32>{
        let interior=radius.floor() as usize-1;
        let exponents=line.iter().filter(|v|v.to_bits()&0x7fff_ffff!=0).map(|v|((v.to_bits()>>23)&255).max(1)).collect::<Vec<_>>();
        if line.iter().any(|v|!v.is_finite()){return None;}
        if exponents.is_empty(){return Some(0);}
        let minimum=*exponents.iter().min()?;let maximum=*exponents.iter().max()?;let span=maximum-minimum;
        if span>40||24+span+bound>123{return None;}
        let slope=q[1].checked_sub(q[2])?;let intercept=q[1]+slope;
        for (d,&actual) in q.iter().enumerate().take(interior+1).skip(1){
            let approximate=intercept.checked_sub(slope*d as u128)?;
            if actual.abs_diff(approximate)>(d+2) as u128{return None;}
        }
        let values=line.iter().map(|v|{
            let bits=v.to_bits();let exponent=(bits>>23)&255;
            let mantissa=(bits&0x7f_ffff)|if exponent==0{0}else{0x80_0000};if mantissa==0{return 0;}
            let magnitude=i128::from(mantissa)<<(exponent.max(1)-minimum);
            if bits>>31==0{magnitude}else{-magnitude}
        }).collect::<Vec<_>>();
        let mut sums=vec![0_i128;values.len()+1];let mut moments=sums.clone();
        for (i,&v)in values.iter().enumerate(){sums[i+1]=sums[i]+v;moments[i+1]=moments[i]+v*i as i128;}
        let lo=x.saturating_sub(interior);let hi=(x+interior+1).min(values.len());
        let left=sums[x]-sums[lo];let right=sums[hi]-sums[x+1];
        let distances=left*x as i128-(moments[x]-moments[lo])+(moments[hi]-moments[x+1])-right*x as i128;
        let mut n=values[x]*q[0] as i128+(left+right)*intercept as i128-distances*slope as i128;
        for (d,&weight)in q.iter().enumerate().skip(interior+1){
            let a=x.checked_sub(d).and_then(|i|values.get(i)).copied().unwrap_or(0);
            let b=values.get(x+d).copied().unwrap_or(0);n+=(a+b)*weight as i128;
        }
        let maximum=(0xff_ffff_i128)<<span;
        let error=maximum*(interior*interior+7*interior+1+2*(kernel.reach()-interior))as i128;
        let low=round_certified_dyadic(n-error,minimum as i32-214);let high=round_certified_dyadic(n+error,minimum as i32-214);
        (low==high&&low&0x7f80_0000!=0x7f80_0000).then_some(low)
    }
    #[test]
    fn q64_prefix_acceptance_matches_full_rational_bits_for_signed_hdr_subnormal_and_border_inputs(){
        let mut accepted=0;let mut declined=0;let mut seed=0x57851392_u32;
        for radius in [8.,8.872759199349778,17.062998120031647,17.5,31.999999999999996,32.,33.75523176884158,63.25,128.1927301,511.99999999,512.]{
            let kernel=RationalKernel::tent(radius).unwrap();
            let q=kernel.certified_weights_at(64);
            let bound=kernel.certified_prefix_plan(radius.floor()as usize-1,&kernel.certified_encoded()).unwrap();
            for shape in 0..8 {
                let line=(0..97).map(|i|{seed=seed.wrapping_mul(1664525).wrapping_add(1013904223);match shape {
                    0=>0.,1=>0.25,2=>(i%7)as f32/7.,
                    3=>f32::from_bits((seed&0x807f_ffff)|((117+seed%9)<<23)),
                    4=>f32::from_bits((seed&0x807f_ffff)|((220+seed%6)<<23)),
                    5=>f32::from_bits(seed&0x807f_ffff),
                    6=>if i==47{f32::MAX}else{f32::from_bits(1)},
                    _=>if i==47{f32::NAN}else{1.},
                }}).collect::<Vec<_>>();
                for clamp in [false,true]{
                    let reach=kernel.reach();let pad=if clamp{reach}else{0};
                    let extended=(0..line.len()+pad*2).map(|i|line[i.saturating_sub(pad).min(line.len()-1)]).collect::<Vec<_>>();
                    for x in [0,1,8,19,47,48,80,95,96]{
                        match prefix(&kernel,radius,&extended,x+pad,&q,bound){
                            None=>declined+=1,
                            Some(bits)=>{
                                let taps=(0..reach*2+1).map(|i|{let at=x as isize+i as isize-reach as isize;
                                    if clamp{line[at.clamp(0,line.len()as isize-1)as usize]}
                                    else{usize::try_from(at).ok().and_then(|i|line.get(i)).copied().unwrap_or(0.)}
                                }).collect::<Vec<_>>();
                                assert_eq!(bits,kernel.exact(&taps).to_bits(),"r={radius} shape={shape} x={x} clamp={clamp}");accepted+=1;
                            }
                        }
                    }
                }
            }
        }
        assert!(accepted>400,"actual certified cases {accepted}");assert!(declined>200,"actual declined cases {declined}");
    }
}

#[cfg(test)]
mod large_canvas_tent_tests {
    use super::*;
    #[test]
    fn separate_large_kernel_keeps_legacy_boundary_and_exact_normalization() {
        for radius in [2048.000000000001, 2240., 2240.125, 3072., 4096.] {
            assert!(RationalKernel::tent(radius).is_err());
            let k=RationalKernel::large_tent(radius).unwrap();
            assert_eq!(k.reach(), radius.ceil() as usize);
            assert_eq!(k.convolve(&vec![1.;2*k.reach()+1]).unwrap().to_bits(),1_f32.to_bits());
            let mut impulse=vec![0.;2*k.reach()+1];impulse[k.reach()]=1.;
            let expected = ((3. * radius - 1.) / (3. * radius * radius)) as f32;
            assert_eq!(k.convolve(&impulse).unwrap().to_bits(), expected.to_bits());
        }
        assert_eq!(RationalKernel::large_tent(4095.9999999999995).unwrap_err(), "Large exact filter packet exceeds 64 KiB");
        for radius in [0.,512.,2048.,4096.0001,f64::NAN,f64::INFINITY] {assert!(RationalKernel::large_tent(radius).is_err());}
    }
}

#[cfg(test)]
mod wide_shadow_prefix_tests {
    use super::RationalKernel;
    use crate::{blend::{Pixel, Surface}, effects, math::Rect};

    fn direct(source: &Surface, radius: f64) -> Surface {
        let kernel = RationalKernel::tent(radius).unwrap();
        let reach = kernel.reach() as i32;
        let mut expected = source.try_clone().unwrap();
        let mut taps = vec![0.; kernel.reach() * 2 + 1];
        for horizontal in [true, false] {
            let rect = expected.rect;
            let mut out = Surface::new(rect).unwrap();
            for y in rect.y..rect.bottom() {
                for x in rect.x..rect.right() {
                    let mut value = [0.; 4];
                    for (channel, sample) in value.iter_mut().enumerate() {
                        for (index, tap) in taps.iter_mut().enumerate() {
                            let delta = index as i32 - reach;
                            let (sx, sy) = if horizontal { (x + delta, y) } else { (x, y + delta) };
                            *tap = expected.at(sx, sy).0[channel];
                        }
                        *sample = kernel.convolve(&taps).unwrap();
                    }
                    out.pixels[rect.index(x, y).unwrap()] = Pixel(value);
                }
            }
            expected = out;
        }
        expected
    }

    #[test]
    fn wide_shadow_radii_keep_exact_bits_through_the_q64_prefix() {
        for radius in [64., 128.5, 256., 384.] {
            assert!(RationalKernel::tent(radius).unwrap().q64_prefix(radius).is_some(), "{radius}");
            let mut source = Surface::new(Rect::new(-4, 2, 64, 3)).unwrap();
            for x in 12..40 {
                source.pixels[64 + x] = Pixel([0.35, -0.5, 1., 0.125]);
            }
            let actual = effects::linear_tent_blur(&source, radius, false).unwrap();
            let expected = direct(&source, radius);
            for (index, (got, want)) in actual.pixels.iter().zip(&expected.pixels).enumerate() {
                assert_eq!(got.0.map(f32::to_bits), want.0.map(f32::to_bits), "r={radius} pixel={index}");
            }
        }
    }
}
