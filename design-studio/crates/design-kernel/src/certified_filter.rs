//! Certified binary64 intervals for an exact tent's linear interior. All final
//! acceptance is binary32 bit equality; uncertain pixels use RationalKernel.
//! TwoSum tracks the rounding discarded by each compensated prefix update.
use crate::{
    blend::{Pixel, Surface},
    math::Rect,
    rational_filter::RationalKernel,
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
