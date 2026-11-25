//! Portable radial zoom blur. Authored amount is dimensionless, independent of
//! camera scale. The normalized focal point follows the node's affine matrix.
//! A bounded separable coordinate table retains binary64 geometry on all GPU
//! backends. Sketch imports use the measured native tap positions; both
//! sampling rules use the same portable texel reconstruction and summation.
use crate::{
    blend::{Pixel, Surface},
    math::{Point, Rect, Transform},
};
use serde::{Deserialize, Serialize};

pub const SAMPLES: usize = 64;
const SKETCH_SAMPLES: usize = 100;
const MAX_TABLE_BYTES: usize = 64 * 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ZoomBlur {
    pub amount: f64,
    pub center: [f64; 2],
}
impl ZoomBlur {
    pub fn is_identity(&self) -> bool {
        (-f64::from(self.amount as f32) / 50.).exp() == 1.
    }
    pub fn validate(&self) -> bool {
        self.amount.is_finite()
            && (0. ..=1000.).contains(&self.amount)
            && self.center.iter().all(|v| v.is_finite() && v.abs() <= 1e6)
    }
}
fn table_len(rect: Rect, samples: usize) -> Result<usize, String> {
    let axes = (rect.w as usize)
        .checked_add(rect.h as usize)
        .ok_or("Zoom coordinate extent overflow")?;
    let len = axes
        .checked_mul(samples * 4)
        .and_then(|n| n.checked_add(4))
        .and_then(|n| n.checked_add(1023))
        .map(|n| n / 1024 * 1024)
        .filter(|n| *n <= MAX_TABLE_BYTES / 4)
        .ok_or("Zoom coordinate table exceeds 64 MiB")?;
    if rect.w == 0 || rect.h == 0 || rect.w > 16384 || rect.h > 16384 {
        return Err("Invalid zoom filter extent".into());
    }
    Ok(len)
}
pub(crate) fn sketch_sampling(doc: &crate::scene::Document, node: &crate::scene::Node) -> bool {
    doc.color_management.is_none()
        && crate::interop::sketch_binding(doc, node, "sketchSourceBlur").is_some()
        && crate::interop::sketch_binding(doc, node, "sketchPortableZoomBlur") != Some("true")
}

pub fn coordinates(
    params: ZoomBlur,
    matrix: Transform,
    size: [f64; 2],
    rect: Rect,
) -> Result<Vec<f32>, String> {
    coordinates_sampled(params, matrix, size, rect, false)
}

pub fn coordinates_sampled(
    params: ZoomBlur,
    matrix: Transform,
    size: [f64; 2],
    rect: Rect,
    sketch: bool,
) -> Result<Vec<f32>, String> {
    if !params.validate()
        || matrix.0.iter().chain(size.iter()).any(|v| !v.is_finite())
        || size.iter().any(|v| *v < 0.)
    {
        return Err("Invalid zoom blur parameters".into());
    }
    let count = if sketch { SKETCH_SAMPLES } else { SAMPLES };
    let len = table_len(rect, count)?;
    if params.is_identity() {
        return Ok(vec![0.; 1024]);
    }
    let center = matrix.point(Point::new(
        params.center[0] * size[0],
        params.center[1] * size[1],
    ));
    if !center.x.is_finite() || !center.y.is_finite() {
        return Err("Invalid zoom blur center".into());
    }
    let amount = f64::from(params.amount as f32);
    let near = if sketch { 0.98_f64.powf(amount) } else { (-amount / 50.).exp() };
    // Float impulse captures at amounts 5, 10 and 40 resolve all 100
    // equally weighted samples, including the two endpoints.
    let scales: [f64; SKETCH_SAMPLES] = std::array::from_fn(|tap| {
        if sketch {
            let t = tap as f64 / (SKETCH_SAMPLES - 1) as f64;
            let position = t + 0.4 * t * (1. - t) * (1. - 2. * t);
            1. - (1. - near) * position
        } else {
            near + (1. - near) * (tap as f64 + 0.5) / SAMPLES as f64
        }
    });
    let mut result = vec![0.; len];
    result[..4].copy_from_slice(&[
        count as f32, rect.w as f32, rect.h as f32, (1 + rect.w as usize * count) as f32,
    ]);
    // Device-aligned Sketch captures sample with eight fractional coordinate bits.
    let sketch_sample_phase = sketch && matrix.0[1] == 0. && matrix.0[2] == 0.;
    for (axis, (origin, length, focal)) in [(rect.x, rect.w, center.x), (rect.y, rect.h, center.y)]
        .into_iter()
        .enumerate()
    {
        let base = 1 + if axis == 0 {
            0
        } else {
            rect.w as usize * count
        };
        for pixel in 0..length as usize {
            if pixel % 64 == 0 {
                crate::render_cancellation::checkpoint()?;
            }
            for (tap, scale) in scales[..count].iter().copied().enumerate() {
                let local_center = focal - f64::from(origin) - 0.5;
                let q = pixel as f64 + (local_center - pixel as f64) * (1. - scale);
                // Keep both neighbours outside when the true footprint is
                // outside, including zero-weight neighbours and nonfinites.
                let q = if q < -1. {
                    -2.
                } else if q >= f64::from(length) {
                    f64::from(length)
                } else {
                    q
                };
                let q = if sketch_sample_phase { (q * 256.).round_ties_even() / 256. } else { q };
                let mut integer = q.floor();
                let mut fraction = (q - integer) as f32;
                if fraction == 1. {
                    integer += 1.;
                    fraction = 0.;
                }
                let at = (base + pixel * count + tap) * 4;
                result[at] = integer as f32;
                result[at + 1] = fraction;
            }
        }
    }
    Ok(result)
}
fn mean(values: [Pixel; 4]) -> Pixel {
    Pixel(std::array::from_fn(|c| {
        ((values[0].0[c] * 0.25 + values[1].0[c] * 0.25) + values[2].0[c] * 0.25)
            + values[3].0[c] * 0.25
    }))
}
fn sketch_average(groups: impl IntoIterator<Item = Pixel>) -> Pixel {
    let mut sum = [0.; 4];
    for group in groups {
        for (out, value) in sum.iter_mut().zip(group.0) { *out += value; }
    }
    Pixel(sum.map(|v| v * 0.04))
}

struct SketchSourceSupport {
    bounds: Rect,
    uniform: Option<Pixel>,
}

impl SketchSourceSupport {
    fn measure(input: &Surface) -> Result<Self, String> {
        let [w, h] = [input.rect.w as usize, input.rect.h as usize];
        let (mut lo, mut hi) = ([w, h], [0, 0]);
        let mut color = None;
        let mut uniform = true;
        let mut pixels = 0;
        for (y, row) in input.pixels.chunks_exact(w).enumerate() {
            crate::render_cancellation::checkpoint()?;
            for (x, p) in row.iter().copied().enumerate() {
                if p == Pixel::default() { continue; }
                lo = [lo[0].min(x), lo[1].min(y)];
                hi = [hi[0].max(x + 1), hi[1].max(y + 1)];
                if let Some(first) = color { uniform &= p == first; } else { color = Some(p); }
                pixels += 1;
            }
        }
        let bounds = if pixels == 0 {
            Rect::default()
        } else {
            Rect::new(lo[0] as i32, lo[1] as i32, (hi[0] - lo[0]) as u32, (hi[1] - lo[1]) as u32)
        };
        let uniform = color.filter(|_| uniform && bounds.pixels() == pixels).map(|color| {
            let group = mean([color; 4]);
            sketch_average(std::iter::repeat_n(group, SKETCH_SAMPLES / 4))
        });
        Ok(Self { bounds, uniform })
    }

    fn constant(&self, x: [i32; 2], y: [i32; 2]) -> Option<Pixel> {
        // The eased ray is monotone on each axis. The first and last taps
        // bound all four neighbours, including both bilinear edge texels.
        let (x0, x1, y0, y1) = (x[0].min(x[1]), x[0].max(x[1]) + 2, y[0].min(y[1]), y[0].max(y[1]) + 2);
        if self.bounds.empty() || x1 <= self.bounds.x || y1 <= self.bounds.y
            || x0 >= self.bounds.right() || y0 >= self.bounds.bottom()
        {
            return Some(Pixel::default());
        }
        self.uniform.filter(|_| x0 >= self.bounds.x && y0 >= self.bounds.y
            && x1 <= self.bounds.right() && y1 <= self.bounds.bottom())
    }
}

pub fn apply(
    input: &Surface,
    params: ZoomBlur,
    matrix: Transform,
    size: [f64; 2],
) -> Result<Surface, String> {
    apply_sampled(input, params, matrix, size, false)
}

pub(crate) fn apply_sampled(
    input: &Surface,
    params: ZoomBlur,
    matrix: Transform,
    size: [f64; 2],
    sketch: bool,
) -> Result<Surface, String> {
    if !params.validate() {
        return Err("Invalid zoom blur parameters".into());
    }
    if params.is_identity() {
        return input.try_clone();
    }
    let count = if sketch { SKETCH_SAMPLES } else { SAMPLES };
    let _scratch = input.reserve_scratch::<f32>(table_len(input.rect, count)?)?;
    let table = coordinates_sampled(params, matrix, size, input.rect, sketch)?;
    let mut output = input.new_like(input.rect)?;
    let support = sketch.then(|| SketchSourceSupport::measure(input)).transpose()?;
    let ybase = 1 + input.rect.w as usize * count;
    let sample = |x: usize, y: usize, tap: usize| {
        let xc = (1 + x * count + tap) * 4;
        let yc = (ybase + y * count + tap) * 4;
        let ix = table[xc] as i32;
        let iy = table[yc] as i32;
        let at = |dx: i32, dy: i32| {
            input
                .rect
                .x
                .checked_add(dx)
                .zip(input.rect.y.checked_add(dy))
                .map_or(Pixel::default(), |(x, y)| input.at(x, y))
        };
        let pixels = [
            at(ix, iy),
            at(ix + 1, iy),
            at(ix, iy + 1),
            at(ix + 1, iy + 1),
        ];
        Pixel(std::array::from_fn(|c| {
            crate::sampling::bilinear(pixels.map(|p| p.0[c]), table[xc + 1], table[yc + 1])
        }))
    };
    for y in 0..input.rect.h as usize {
        for x in 0..input.rect.w as usize {
            if x % 16 == 0 {
                crate::render_cancellation::checkpoint()?;
            }
            let value = if let Some(support) = &support {
                let endpoints = |base| [table[base] as i32, table[base + (count - 1) * 4] as i32];
                support.constant(endpoints((1 + x * count) * 4), endpoints((ybase + y * count) * 4))
                    .unwrap_or_else(|| sketch_average((0..SKETCH_SAMPLES / 4).map(|group| {
                        mean(std::array::from_fn(|tap| sample(x, y, group * 4 + tap)))
                    })))
            } else {
                let groups = std::array::from_fn(|g| {
                    mean(std::array::from_fn(|q| {
                        mean(std::array::from_fn(|t| sample(x, y, g * 16 + q * 4 + t)))
                    }))
                });
                mean(groups)
            };
            output.pixels[y * input.rect.w as usize + x] = value;
        }
    }
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sketch_sampling_matches_offset_focus_at_native_box_edge() {
        // Frozen Sketch zoom control: 64×64 box at (96,64), amount 40,
        // center (0.25,0.75). At (93,54) the native alpha is 188.
        let mut input = Surface::new(Rect::new(0, 0, 256, 192)).unwrap();
        for y in 64..128 {
            for x in 96..160 {
                input.pixels[input.rect.index(x, y).unwrap()] = Pixel([1.; 4]);
            }
        }
        let p = ZoomBlur { amount: 40., center: [0.25, 0.75] };
        let shape = Transform([1., 0., 0., 1., 96., 64.]);
        let result = apply_sampled(&input, p, shape, [64., 64.], true).unwrap();
        let alpha = |x, y| (result.at(x, y).0[3] * 255.).round_ties_even() as u8;
        assert_eq!(alpha(93, 54), 188);
        assert_eq!(alpha(80, 16), 21);
        assert_eq!(alpha(206, 143), 21);
        assert_eq!(alpha(112, 112), 255);
        assert_eq!(alpha(0, 0), 0);
    }

    #[test]
    fn identity_and_radial_focal_point_preserve_extended_values() {
        let mut surface = Surface::new(Rect::new(-16, -16, 64, 64)).unwrap();
        surface.pixels.fill(Pixel([4., -0.25, 1., 1.]));
        let p = ZoomBlur {
            amount: 0.,
            center: [0.5, 0.5],
        };
        assert_eq!(
            apply(&surface, p, Transform::default(), [32., 32.])
                .unwrap()
                .pixels,
            surface.pixels
        );
        let tiny = ZoomBlur {
            amount: f64::MIN_POSITIVE,
            center: [1e6, -1e6],
        };
        assert_eq!(
            apply(&surface, tiny, Transform::default(), [32., 32.])
                .unwrap()
                .pixels,
            surface.pixels
        );
        let p = ZoomBlur { amount: 20., ..p };
        let output = apply(&surface, p, Transform::default(), [32., 32.]).unwrap();
        assert_eq!(output.at(16, 16), Pixel([4., -0.25, 1., 1.]));
        surface.pixels.fill(Pixel::default());
        surface.pixels[surface.rect.index(24, 16).unwrap()] = Pixel([4., -0.25, 1., 1.]);
        let output = apply(&surface, p, Transform::default(), [32., 32.]).unwrap();
        assert!(output.at(26, 16).0[3] > 0.);
        assert_eq!(output.at(20, 16), Pixel::default());
    }
}
