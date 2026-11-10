//! Certified binary64 intervals for an exact tent's linear interior. All final
//! acceptance is binary32 bit equality; uncertain pixels use RationalKernel.
//! TwoSum tracks the rounding discarded by each compensated prefix update.
use crate::{
    blend::{Pixel, Surface},
    math::Rect,
    rational_filter::{round_certified_dyadic, Q64Prefix, RationalKernel},
};
#[derive(Clone, Copy, Default)]
struct Prefix {
    hi: f64,
    lo: f64,
    error: f64,
}
fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    let v = s - a;
    (s, (a - (s - v)) + (b - v))
}
impl Prefix {
    fn add(mut self, value: f64) -> Self {
        let (s, e) = two_sum(self.hi, value);
        let (t, f) = two_sum(self.lo, e);
        let (hi, lo) = two_sum(s, t);
        self.hi = hi;
        self.lo = lo;
        self.error = (self.error + f.abs()).next_up();
        self
    }
    fn difference(self, other: Self) -> Interval {
        let mut d = self.add(-other.hi).add(-other.lo);
        d.error = (d.error + other.error).next_up();
        Interval::point(d.hi)
            .plus(Interval::point(d.lo))
            .plus(Interval {
                lo: -d.error,
                hi: d.error,
            })
    }
}
#[derive(Clone, Copy)]
struct Interval {
    lo: f64,
    hi: f64,
}
impl Interval {
    fn point(v: f64) -> Self {
        Self { lo: v, hi: v }
    }
    fn plus(self, b: Self) -> Self {
        Self {
            lo: (self.lo + b.lo).next_down(),
            hi: (self.hi + b.hi).next_up(),
        }
    }
    fn minus(self, b: Self) -> Self {
        self.plus(Self {
            lo: -b.hi,
            hi: -b.lo,
        })
    }
    fn times(self, b: Self) -> Self {
        let p = [
            self.lo * b.lo,
            self.lo * b.hi,
            self.hi * b.lo,
            self.hi * b.hi,
        ];
        Self {
            lo: p.into_iter().fold(f64::INFINITY, f64::min).next_down(),
            hi: p.into_iter().fold(f64::NEG_INFINITY, f64::max).next_up(),
        }
    }
    fn over(self, b: Self) -> Self {
        debug_assert!(b.lo > 0.);
        self.times(Self {
            lo: (1. / b.hi).next_down(),
            hi: (1. / b.lo).next_up(),
        })
    }
    fn rounded(self) -> Option<f32> {
        let lo = self.lo as f32;
        let hi = self.hi as f32;
        (self.lo.is_finite() && self.hi.is_finite() && lo.to_bits() == hi.to_bits()).then_some(lo)
    }
}
/// Consumes `current` instead of cloning it again. Shadow admission keeps one
/// live source plus the pass output.
pub(crate) fn blur_owned(
    mut current: Surface,
    radius: f64,
    clamp_edges: bool,
    kernel: &RationalKernel,
) -> Result<Surface, String> {
    // Transparent-boundary shadows are the wide export. The Q64 line prefix is
    // the same enclosure as the GPU certificate: accepted pixels are exact
    // binary32, and a declined pixel still uses RationalKernel::convolve.
    // Clamped edges keep the general evaluator so their repeated border
    // samples stay on the path already compared with direct convolution.
    if !clamp_edges {
        if let Some(plan) = kernel.q64_prefix(radius) {
            return blur_q64_prefix(current, kernel, &plan);
        }
    }
    let reach = kernel.reach() as i32;
    let interior = radius.floor() as i32 - 1;
    let one = Interval::point(1.);
    let r = Interval::point(radius);
    let square = r.times(r);
    let center = r.minus(one.over(Interval::point(3.))).over(square);
    let boundary: Vec<_> = (interior + 1..=reach)
        .map(|d| {
            let a = r.plus(one).minus(Interval::point(f64::from(d)));
            let a = Interval {
                lo: a.lo.max(0.),
                hi: a.hi.max(0.),
            };
            let b = r.minus(Interval::point(f64::from(d)));
            let b = Interval {
                lo: b.lo.max(0.),
                hi: b.hi.max(0.),
            };
            (
                d,
                a.times(a)
                    .times(a)
                    .minus(b.times(b).times(b).times(Interval::point(2.)))
                    .over(square.times(Interval::point(6.))),
            )
        })
        .collect();
    let _taps = current.reserve_scratch::<f32>((reach * 2 + 1) as usize)?;
    let mut taps = vec![0.; (reach * 2 + 1) as usize];
    for horizontal in [true, false] {
        let Rect { x, y, w, h } = current.rect;
        let (lines, len) = if horizontal {
            (h as i32, w as i32)
        } else {
            (w as i32, h as i32)
        };
        // Clamp extension is explicit geometry, only O(line + radius) metadata.
        let pad = if clamp_edges { reach } else { 0 };
        let start = -pad;
        let end = len + pad;
        let _prefix = current.reserve_scratch::<[Prefix; 4]>((end - start + 1) as usize * 2)?;
        let mut sums = vec![[Prefix::default(); 4]; (end - start + 1) as usize];
        let mut moments = sums.clone();
        let mut out = current.new_like(current.rect)?;
        for line in 0..lines {
            let sample = |at: i32| {
                let at = if clamp_edges {
                    at.clamp(0, len - 1)
                } else {
                    at
                };
                if horizontal {
                    current.at(x + at, y + line)
                } else {
                    current.at(x + line, y + at)
                }
            };
            for at in start..end {
                let v = sample(at);
                let i = (at - start) as usize;
                for c in 0..4 {
                    sums[i + 1][c] = sums[i][c].add(f64::from(v.0[c]));
                    moments[i + 1][c] = moments[i][c].add(f64::from(v.0[c]) * f64::from(at));
                }
            }
            for at in 0..len {
                let lo = (at - interior).max(start);
                let hi = (at + interior + 1).min(end);
                let mid = (at - start) as usize;
                let mut output = [0.; 4];
                for c in 0..4 {
                    let mut value = Interval::point(f64::from(sample(at).0[c])).times(center);
                    if interior > 0 {
                        let ls = sums[mid][c].difference(sums[(lo - start) as usize][c]);
                        let lm = moments[mid][c].difference(moments[(lo - start) as usize][c]);
                        let rs = sums[(hi - start) as usize][c].difference(sums[mid + 1][c]);
                        let rm = moments[(hi - start) as usize][c].difference(moments[mid + 1][c]);
                        let coordinate = Interval::point(f64::from(at));
                        value = value.plus(
                            r.minus(coordinate)
                                .times(ls)
                                .plus(lm)
                                .plus(r.plus(coordinate).times(rs))
                                .minus(rm)
                                .over(square),
                        );
                    }
                    for &(d, weight) in &boundary {
                        value = value.plus(
                            Interval::point(f64::from(sample(at - d).0[c]))
                                .plus(Interval::point(f64::from(sample(at + d).0[c])))
                                .times(weight),
                        );
                    }
                    output[c] = if let Some(value) = value.rounded() {
                        value
                    } else {
                        for (i, v) in taps.iter_mut().enumerate() {
                            *v = sample(at + i as i32 - reach).0[c];
                        }
                        kernel.convolve(&taps)?
                    };
                }
                let index = if horizontal {
                    line as usize * w as usize + at as usize
                } else {
                    at as usize * w as usize + line as usize
                };
                out.pixels[index] = Pixel(output);
            }
        }
        current = out;
    }
    Ok(current)
}

struct ChannelScratch {
    values: Vec<i128>,
    sums: Vec<i128>,
    moments: Vec<i128>,
}

#[derive(Clone, Copy)]
struct ChannelPlan {
    mode: ChannelMode,
    minimum: u32,
    span: u32,
}

#[derive(Clone, Copy)]
enum ChannelMode {
    Constant(f32),
    Slow,
    Prefix,
}

fn scaled_sample(value: f32, minimum: u32) -> i128 {
    let bits = value.to_bits();
    let exponent = (bits >> 23) & 255;
    let mantissa = (bits & 0x7f_ffff) | if exponent == 0 { 0 } else { 0x80_0000 };
    if mantissa == 0 {
        return 0;
    }
    let magnitude = i128::from(mantissa) << (exponent.max(1) - minimum);
    if bits >> 31 == 0 {
        magnitude
    } else {
        -magnitude
    }
}

fn prepare_channel(line: &[Pixel], channel: usize, bound: u32, scratch: &mut ChannelScratch) -> ChannelPlan {
    scratch.values.clear();
    scratch.sums.clear();
    scratch.moments.clear();
    let mut minimum = 255u32;
    let mut maximum = 0u32;
    let mut first = None;
    let mut uniform = true;
    for pixel in line {
        let bits = pixel.0[channel].to_bits();
        if first.is_none() {
            first = Some(bits);
        } else if first != Some(bits) {
            uniform = false;
        }
        if bits & 0x7fff_ffff != 0 {
            let exponent = ((bits >> 23) & 255).max(1);
            minimum = minimum.min(exponent);
            maximum = maximum.max(exponent);
        }
    }
    // Outside this line is transparent. A line of zeros stays zero. Any other
    // constant still changes at the border, so it has to be filtered.
    if uniform && f32::from_bits(first.unwrap_or(0)) == 0. {
        return ChannelPlan { mode: ChannelMode::Constant(0.), minimum: 0, span: 0 };
    }
    if maximum == 0 {
        return ChannelPlan { mode: ChannelMode::Slow, minimum: 0, span: 0 };
    }
    let span = maximum - minimum;
    if span > 40 || 24 + span + bound > 123 {
        return ChannelPlan { mode: ChannelMode::Slow, minimum, span };
    }
    scratch.values.reserve(line.len());
    for pixel in line {
        scratch.values.push(scaled_sample(pixel.0[channel], minimum));
    }
    scratch.sums.resize(line.len() + 1, 0);
    scratch.moments.resize(line.len() + 1, 0);
    let mut alive = true;
    for (index, &value) in scratch.values.iter().enumerate() {
        let Some(sum) = scratch.sums[index].checked_add(value) else { alive = false; break; };
        let Some(product) = value.checked_mul(index as i128) else { alive = false; break; };
        let Some(moment) = scratch.moments[index].checked_add(product) else { alive = false; break; };
        scratch.sums[index + 1] = sum;
        scratch.moments[index + 1] = moment;
    }
    if !alive {
        return ChannelPlan { mode: ChannelMode::Slow, minimum, span };
    }
    ChannelPlan { mode: ChannelMode::Prefix, minimum, span }
}

fn prefix_bits(
    scratch: &ChannelScratch,
    x: usize,
    plan: &Q64Prefix,
    span: u32,
    minimum: u32,
) -> Option<u32> {
    let reach = plan.weights.len() - 1;
    let interior = plan.interior;
    let lo = x.saturating_sub(interior);
    let hi = (x + interior + 1).min(scratch.values.len());
    let left = scratch.sums[x].checked_sub(scratch.sums[lo])?;
    let right = scratch.sums[hi].checked_sub(scratch.sums[x + 1])?;
    let left_moment = scratch.moments[x].checked_sub(scratch.moments[lo])?;
    let right_moment = scratch.moments[hi].checked_sub(scratch.moments[x + 1])?;
    let distances = left
        .checked_mul(x as i128)?
        .checked_sub(left_moment)?
        .checked_add(right_moment)?
        .checked_sub(right.checked_mul(x as i128)?)?;
    let mut numerator = scratch.values[x]
        .checked_mul(plan.center)?
        .checked_add(left.checked_add(right)?.checked_mul(plan.intercept)?)?
        .checked_sub(distances.checked_mul(plan.slope)?)?;
    for distance in interior + 1..=reach {
        let left_sample = x.checked_sub(distance).and_then(|index| scratch.values.get(index).copied()).unwrap_or(0);
        let right_sample = scratch.values.get(x + distance).copied().unwrap_or(0);
        let weight = i128::try_from(*plan.weights.get(distance)?).ok()?;
        numerator = numerator.checked_add(left_sample.checked_add(right_sample)?.checked_mul(weight)?)?;
    }
    let width = (interior * interior + 7 * interior + 1 + 2 * (reach - interior)) as i128;
    let error = (0xff_ffff_i128).checked_shl(span)?.checked_mul(width)?;
    let quantum = minimum as i32 - 214;
    let low = round_certified_dyadic(numerator.checked_sub(error)?, quantum);
    let high = round_certified_dyadic(numerator.checked_add(error)?, quantum);
    (low == high && low & 0x7f80_0000 != 0x7f80_0000).then_some(low)
}

fn blur_q64_prefix(mut current: Surface, kernel: &RationalKernel, plan: &Q64Prefix) -> Result<Surface, String> {
    let reach = kernel.reach();
    let mut taps = vec![0.; reach * 2 + 1];
    let mut scratch = [
        ChannelScratch { values: Vec::new(), sums: Vec::new(), moments: Vec::new() },
        ChannelScratch { values: Vec::new(), sums: Vec::new(), moments: Vec::new() },
        ChannelScratch { values: Vec::new(), sums: Vec::new(), moments: Vec::new() },
        ChannelScratch { values: Vec::new(), sums: Vec::new(), moments: Vec::new() },
    ];
    for horizontal in [true, false] {
        let Rect { x, y, w, h } = current.rect;
        let (lines, len) = if horizontal { (h as i32, w as i32) } else { (w as i32, h as i32) };
        let len_usize = len.max(0) as usize;
        let mut line = vec![Pixel::default(); len_usize];
        let mut out = current.new_like(current.rect)?;
        for line_index in 0..lines {
            for at in 0..len {
                line[at as usize] = if horizontal {
                    current.at(x + at, y + line_index)
                } else {
                    current.at(x + line_index, y + at)
                };
            }
            let plans = [
                prepare_channel(&line, 0, plan.bound, &mut scratch[0]),
                prepare_channel(&line, 1, plan.bound, &mut scratch[1]),
                prepare_channel(&line, 2, plan.bound, &mut scratch[2]),
                prepare_channel(&line, 3, plan.bound, &mut scratch[3]),
            ];
            for at in 0..len_usize {
                let mut output = [0.; 4];
                for channel in 0..4 {
                    output[channel] = match plans[channel].mode {
                        ChannelMode::Constant(value) => value,
                        ChannelMode::Prefix => {
                            if let Some(bits) = prefix_bits(
                                &scratch[channel],
                                at,
                                plan,
                                plans[channel].span,
                                plans[channel].minimum,
                            ) {
                                f32::from_bits(bits)
                            } else {
                                for (index, tap) in taps.iter_mut().enumerate() {
                                    let sample_at = at as i32 + index as i32 - reach as i32;
                                    *tap = if sample_at < 0 || sample_at >= len {
                                        0.
                                    } else {
                                        line[sample_at as usize].0[channel]
                                    };
                                }
                                kernel.convolve(&taps)?
                            }
                        }
                        ChannelMode::Slow => {
                            for (index, tap) in taps.iter_mut().enumerate() {
                                let sample_at = at as i32 + index as i32 - reach as i32;
                                *tap = if sample_at < 0 || sample_at >= len {
                                    0.
                                } else {
                                    line[sample_at as usize].0[channel]
                                };
                            }
                            kernel.convolve(&taps)?
                        }
                    };
                }
                let index = if horizontal {
                    line_index as usize * w as usize + at
                } else {
                    at * w as usize + line_index as usize
                };
                out.pixels[index] = Pixel(output);
            }
        }
        current = out;
    }
    Ok(current)
}
