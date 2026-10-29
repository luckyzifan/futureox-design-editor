//! Portable radial zoom blur. Authored amount is dimensionless, independent of
//! camera scale. The normalized focal point follows the node's affine matrix.
//! A bounded separable coordinate table retains binary64 geometry on all GPU
//! backends; sampling and the fixed 4×4×4 mean use the shared binary32 rules.
//! This is a portable kernel, not a claim of Core Image bit equivalence.
use crate::{
    blend::{Pixel, Surface},
    math::{Point, Rect, Transform},
};
use serde::{Deserialize, Serialize};

pub const SAMPLES: usize = 64;
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
fn table_len(rect: Rect) -> Result<usize, String> {
    let axes = (rect.w as usize)
        .checked_add(rect.h as usize)
        .ok_or("Zoom coordinate extent overflow")?;
    let len = axes
        .checked_mul(SAMPLES * 4)
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
pub fn coordinates(
    params: ZoomBlur,
    matrix: Transform,
    size: [f64; 2],
    rect: Rect,
) -> Result<Vec<f32>, String> {
    if !params.validate()
        || matrix.0.iter().chain(size.iter()).any(|v| !v.is_finite())
        || size.iter().any(|v| *v < 0.)
    {
        return Err("Invalid zoom blur parameters".into());
    }
    let len = table_len(rect)?;
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
    // Measured radial range against CIZoomBlur. Sampling remains explicitly
    // portable: Core Image's undocumented reconstruction differs at edges.
    let near = (-f64::from(params.amount as f32) / 50.).exp();
    let mut result = vec![0.; len];
    result[..4].copy_from_slice(&[
        SAMPLES as f32,
        rect.w as f32,
        rect.h as f32,
        (1 + rect.w as usize * SAMPLES) as f32,
    ]);
    for (axis, (origin, length, focal)) in [(rect.x, rect.w, center.x), (rect.y, rect.h, center.y)]
        .into_iter()
        .enumerate()
    {
        let base = 1 + if axis == 0 {
            0
        } else {
            rect.w as usize * SAMPLES
        };
        for pixel in 0..length as usize {
            if pixel % 64 == 0 {
                crate::render_cancellation::checkpoint()?;
            }
            for tap in 0..SAMPLES {
                let scale = near + (1. - near) * (tap as f64 + 0.5) / SAMPLES as f64;
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
                let mut integer = q.floor();
                let mut fraction = (q - integer) as f32;
                if fraction == 1. {
                    integer += 1.;
                    fraction = 0.;
                }
                let at = (base + pixel * SAMPLES + tap) * 4;
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
pub fn apply(
    input: &Surface,
    params: ZoomBlur,
    matrix: Transform,
    size: [f64; 2],
) -> Result<Surface, String> {
    if !params.validate() {
        return Err("Invalid zoom blur parameters".into());
    }
    if params.is_identity() {
        return input.try_clone();
    }
    let _scratch = input.reserve_scratch::<f32>(table_len(input.rect)?)?;
    let table = coordinates(params, matrix, size, input.rect)?;
    let mut output = input.new_like(input.rect)?;
    let ybase = 1 + input.rect.w as usize * SAMPLES;
    let sample = |x: usize, y: usize, tap: usize| {
        let xc = (1 + x * SAMPLES + tap) * 4;
        let yc = (ybase + y * SAMPLES + tap) * 4;
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
            let groups = std::array::from_fn(|g| {
                mean(std::array::from_fn(|q| {
                    mean(std::array::from_fn(|t| sample(x, y, g * 16 + q * 4 + t)))
                }))
            });
            output.pixels[y * input.rect.w as usize + x] = mean(groups);
        }
    }
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
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
