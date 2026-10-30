//! Deterministic image mip chains, mirroring Sketch's offline
//! `MSImageDataMipMap` box-filter pipeline: each level halves with a 2×2 box
//! average and the chain stops once both extents reach one texel.
//!
//! Two averaging domains match the existing sampling contracts exactly:
//! - SDR surfaces hold premultiplied, sRGB-encoded values quantized to the
//!   1/255 grid, so levels average recovered bytes with a single
//!   ties-to-even rounding — the same boundary `Surface::sample_rgba8_index`
//!   interpolates in.
//! - Managed/HDR surfaces hold premultiplied linear-light floats, where a
//!   plain average is physically correct.
//!
//! Both loops fix the summation order; the outputs are frozen bit-for-bit in
//! the module tests so the CPU reference and every GPU backend agree.

use crate::blend::{Pixel, Surface};
use crate::math::Rect;

fn halve(v: u32) -> u32 {
    v.div_ceil(2)
}

/// Number of levels a full chain holds for base dimensions: the base plus one
/// level per ceil-halving until both extents are a single texel.
pub fn mip_levels(image: [u32; 2]) -> u32 {
    if image.contains(&0) {
        return 1;
    }
    let mut dims = image;
    let mut levels = 1;
    while dims[0] > 1 || dims[1] > 1 {
        dims = [halve(dims[0]), halve(dims[1])];
        levels += 1;
    }
    levels
}

/// Level-`level` dimensions for base dimensions (ceil halving per step).
pub fn level_dimensions(image: [u32; 2], level: u32) -> [u32; 2] {
    let mut dims = image;
    for _ in 0..level {
        dims = [halve(dims[0]), halve(dims[1])];
    }
    [dims[0].max(1), dims[1].max(1)]
}

/// SDR box downsample: average recovered premultiplied bytes, one
/// ties-to-even rounding per channel. Contributor counts per level are 1 or 2
/// per axis (so 1, 2 or 4 texels); the divisor stays a power of two.
pub fn downsample_byte(source: &Surface) -> Result<Surface, String> {
    downsample(source, |values, count| {
        let mut sum = [0f32; 4];
        for p in values {
            let bytes = p.rgba8_quantized().0.map(|c| (c * 255.).round_ties_even());
            for (s, b) in sum.iter_mut().zip(bytes) {
                *s += b;
            }
        }
        let scale = 1. / count as f32;
        Pixel(sum.map(|s| (s * scale).round_ties_even() / 255.))
    })
}

/// Managed linear-light box downsample: accumulate premultiplied f32 values in
/// row-major contributor order, then divide by the power-of-two count.
pub fn downsample_linear(source: &Surface) -> Result<Surface, String> {
    downsample(source, |values, count| {
        let mut sum = [0f32; 4];
        for p in values {
            for (s, c) in sum.iter_mut().zip(p.0) {
                *s += c;
            }
        }
        let scale = 1. / count as f32;
        Pixel(sum.map(|s| s * scale))
    })
}

fn downsample(
    source: &Surface,
    reduce: impl Fn(&[Pixel], u32) -> Pixel,
) -> Result<Surface, String> {
    if source.rect.w == 0 || source.rect.h == 0 {
        return Err("Cannot downsample an empty image".into());
    }
    if source.rect.w == 1 && source.rect.h == 1 {
        return Err("Image mip chain already reached one texel".into());
    }
    let w = halve(source.rect.w);
    let h = halve(source.rect.h);
    let mut out = Surface::new(Rect::new(0, 0, w, h))?;
    let mut values = Vec::new();
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            values.clear();
            for dy in 0..2 {
                for dx in 0..2 {
                    let sx = 2 * x + dx;
                    let sy = 2 * y + dy;
                    if (sx as u32) < source.rect.w && (sy as u32) < source.rect.h {
                        values.push(source.at(sx, sy));
                    }
                }
            }
            let index = out.rect.index(x, y).expect("output within bounds");
            out.pixels[index] = reduce(&values, values.len() as u32);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface(w: u32, h: u32, fill: impl Fn(u32, u32) -> Pixel) -> Surface {
        let mut s = Surface::new(Rect::new(0, 0, w, h)).unwrap();
        for y in 0..h {
            for x in 0..w {
                s.pixels[s.rect.index(x as i32, y as i32).unwrap()] = fill(x, y);
            }
        }
        s
    }

    #[test]
    fn mip_levels_count_halving_to_one_texel() {
        assert_eq!(mip_levels([1, 1]), 1);
        assert_eq!(mip_levels([2, 2]), 2);
        assert_eq!(mip_levels([4, 3]), 3);
        assert_eq!(mip_levels([5, 3]), 4);
        assert_eq!(mip_levels([8192, 1]), 14);
        assert_eq!(mip_levels([0, 5]), 1);
    }

    #[test]
    fn level_dimensions_ceil_halving() {
        assert_eq!(level_dimensions([8, 8], 1), [4, 4]);
        assert_eq!(level_dimensions([5, 3], 1), [3, 2]);
        assert_eq!(level_dimensions([5, 3], 2), [2, 1]);
        assert_eq!(level_dimensions([5, 3], 8), [1, 1]);
        assert_eq!(level_dimensions([16, 16], 4), [1, 1]);
    }

    #[test]
    fn byte_domain_averages_recovered_bytes_with_ties_even() {
        // Bytes 1,2,3,4 average to 2.5 which must round to even 2.
        let s = surface(2, 2, |x, y| {
            Pixel([(x + y * 2 + 1) as f32 / 255., 0., 0., 1.])
        });
        let out = downsample_byte(&s).unwrap();
        assert_eq!((out.at(0, 0).0[0] * 255.) as i32, 2);
        // Odd widths keep the trailing texel as its own level texel.
        let s = surface(3, 1, |x, _| Pixel([(x + 2) as f32 / 255., 0., 0., 1.]));
        let out = downsample_byte(&s).unwrap();
        assert_eq!(out.rect.w, 2);
        assert_eq!((out.at(0, 0).0[0] * 255.) as i32, 2);
        assert_eq!((out.at(1, 0).0[0] * 255.) as i32, 4);
    }

    #[test]
    fn linear_domain_averages_in_order() {
        // Bytes 0,1,2,3: the linear average keeps 1.5/255 while the byte
        // domain would round the 1.5 tie to 2 — the two domains differ here.
        let s = surface(2, 2, |x, y| Pixel([(x + y * 2) as f32 / 255., 0., 0., 1.]));
        let out = downsample_linear(&s).unwrap();
        assert_eq!((out.at(0, 0).0[0] * 255.) as i32, 1);
        let byte = downsample_byte(&s).unwrap();
        assert_eq!((byte.at(0, 0).0[0] * 255.) as i32, 2);
    }

    #[test]
    fn byte_levels_are_bit_frozen() {
        let s = surface(3, 2, |x, y| {
            Pixel([
                (x * 40 + y * 10) as f32 / 255.,
                (255 - x * 30) as f32 / 255.,
                (y * 60) as f32 / 255.,
                1.,
            ])
        });
        let l1 = downsample_byte(&s).unwrap();
        let bytes: Vec<u8> = l1
            .pixels
            .iter()
            .flat_map(|p| p.0.map(|c| (c * 255.) as u8))
            .collect();
        assert_eq!(bytes, vec![25, 240, 30, 255, 85, 195, 30, 255]);
    }

    #[test]
    fn chain_stops_at_one_texel() {
        let mut s = surface(5, 3, |x, y| Pixel([x as f32, y as f32, 0., 1.]));
        let mut levels = 1;
        while s.rect.w > 1 || s.rect.h > 1 {
            s = downsample_byte(&s).unwrap();
            levels += 1;
        }
        assert_eq!(levels, mip_levels([5, 3]));
    }
}
