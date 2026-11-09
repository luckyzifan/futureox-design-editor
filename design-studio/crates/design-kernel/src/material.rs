//! Deterministic material parameters. Geometry/noise is shared; each backend
//! samples and composites its own colour surfaces. SVG fractal-noise reference:
//! https://www.w3.org/TR/SVG11/filters.html#feTurbulenceElement
use crate::{
    blend::{Pixel, Surface},
    math::{Point, Rect, Transform},
    scene::TextureParameters,
};
use std::sync::LazyLock;

struct Perlin {
    permutation: [usize; 256],
    gradient: [[[f64; 2]; 256]; 4],
}
impl Perlin {
    fn new() -> Self {
        let mut seed = 1_i64; // SVG seed 0 is normalized to 1.
        let mut random = || {
            seed = (seed * 16807) % 2147483647;
            seed
        };
        let mut out = Self {
            permutation: std::array::from_fn(|i| i),
            gradient: [[[0.; 2]; 256]; 4],
        };
        for channel in &mut out.gradient {
            for g in channel {
                *g = std::array::from_fn(|_| ((random() % 512) - 256) as f64 / 256.);
                let length = (g[0] * g[0] + g[1] * g[1]).sqrt();
                if length > 0. {
                    g[0] /= length;
                    g[1] /= length;
                }
            }
        }
        for i in (1..256).rev() {
            out.permutation.swap(i, (random() % 256) as usize);
        }
        out
    }
    fn noise(&self, x: f64, y: f64, channel: usize) -> f64 {
        let x = x.rem_euclid(256.);
        let y = y.rem_euclid(256.);
        let ix = x.floor() as usize;
        let iy = y.floor() as usize;
        let u = x - x.floor();
        let v = y - y.floor();
        let dot = |dx: usize, dy: usize| {
            let index = self.permutation[(self.permutation[(ix + dx) & 255] + iy + dy) & 255];
            let g = self.gradient[channel][index];
            (u - dx as f64) * g[0] + (v - dy as f64) * g[1]
        };
        let sx = u * u * (3. - 2. * u);
        let sy = v * v * (3. - 2. * v);
        let a = dot(0, 0);
        let b = dot(0, 1);
        let top = a + sx * (dot(1, 0) - a);
        let bottom = b + sx * (dot(1, 1) - b);
        top + sy * (bottom - top)
    }
}
static NOISE: LazyLock<Perlin> = LazyLock::new(Perlin::new);
pub fn fractal_noise(mut x: f64, mut y: f64, channel: usize) -> f64 {
    let mut sum = 0.;
    let mut amplitude = 1.;
    for _ in 0..3 {
        sum += NOISE.noise(x, y, channel) * amplitude;
        x *= 2.;
        y *= 2.;
        amplitude *= 0.5;
    }
    (sum * 0.5 + 0.5).clamp(0., 1.)
}

fn power_cmp(m: u32, e: i32, alpha: u32) -> std::cmp::Ordering {
    let power = u128::from(m).pow(5);
    if power == 0 {
        return 0_u32.cmp(&alpha);
    }
    let ae = (alpha >> 23) & 255;
    let am = (alpha & 0x7fffff) | if ae > 0 { 1 << 23 } else { 0 };
    let ap = am as u128;
    let ptop = 127 - power.leading_zeros();
    let atop = 127 - ap.leading_zeros();
    let magnitude = (ptop as i32 + e * 5).cmp(&(atop as i32 + ae.max(1) as i32 - 150));
    if magnitude != std::cmp::Ordering::Equal {
        return magnitude;
    }
    (power << (127 - ptop)).cmp(&(ap << (127 - atop)))
}
/// Correctly rounded fifth root on [0,1]. Midpoint^5 uses at most 125 bits.
/// An exact integer comparison chooses the final binary32 neighbour; no powf
/// implementation or driver-dependent transcendental approximation is used.
pub fn fifth_root(alpha: f32) -> f32 {
    let a = alpha.to_bits();
    if a & 0x80000000 != 0 || a == 0 {
        return 0.;
    }
    if a >= 1_f32.to_bits() {
        return 1.;
    }
    let mut lo = 0_u32;
    let mut hi = 1_f32.to_bits();
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        let exponent = ((mid >> 23) & 255) as i32;
        let m = (mid & 0x7fffff) | if exponent > 0 { 1 << 23 } else { 0 };
        if power_cmp(m, exponent.max(1) - 150, a).is_le() {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let e = ((lo >> 23) & 255) as i32;
    let m = (lo & 0x7fffff) | (1 << 23);
    let cmp = power_cmp(2 * m + 1, e - 151, a);
    f32::from_bits(lo + u32::from(cmp.is_lt() || (cmp.is_eq() && lo & 1 != 0)))
}

fn displacement(
    x: i32,
    y: i32,
    amount: f64,
    t: &TextureParameters,
    m: Transform,
    inverse: Transform,
    center: [f64; 2],
) -> Result<[f32; 2], String> {
    let q = inverse.point(Point::new(f64::from(x) + 0.5, f64::from(y) + 0.5));
    let (dx, dy) = if t.noise.as_deref() == Some("perlin") {
        (
            (fractal_noise(q.x / t.noise_size[0], q.y / t.noise_size[1], 0) - 0.5) * amount,
            (fractal_noise(q.x / t.noise_size[0], q.y / t.noise_size[1], 1) - 0.5) * amount,
        )
    } else if t.noise.as_deref() == Some("gabor") {
        // `amount` is the doubled authored radius (Effect::texture_amount).
        let d = crate::texture_noise::gabor::displacement([q.x, q.y], t.noise_size, amount / 2.)?;
        (d[0], d[1])
    } else {
        let q = [q.x as f32 - center[0] as f32, q.y as f32 - center[1] as f32];
        let d = crate::texture_noise::displacement(
            q,
            t.noise_size.map(|v| v as f32),
            (amount / 2.) as f32,
        )
        .map_err(|e| e.to_string())?
        .offset;
        (f64::from(d[0]), f64::from(d[1]))
    };
    Ok([
        (m.0[0] * dx + m.0[2] * dy) as f32,
        (m.0[1] * dx + m.0[3] * dy) as f32,
    ])
}
pub fn texture_field(
    rect: Rect,
    amount: f64,
    t: &TextureParameters,
    m: Transform,
) -> Result<Vec<f32>, String> {
    texture_field_at(rect, amount, t, m, [0.; 2])
}
pub fn texture_field_at(
    rect: Rect,
    amount: f64,
    t: &TextureParameters,
    m: Transform,
    center: [f64; 2],
) -> Result<Vec<f32>, String> {
    let inverse = m.inverse_composed(rect)?;
    crate::sampling::parameter_grid(rect, |x, y| {
        let d = displacement(x, y, amount, t, m, inverse, center)?;
        Ok([d[0], d[1], 0., 0.])
    })
}
pub(crate) fn sample(input: &Surface, x: i32, y: i32, d: [f32; 2], linear: bool) -> Pixel {
    let k = d.map(|v| v - v.floor());
    let ix = x + d[0].floor() as i32;
    let iy = y + d[1].floor() as i32;
    let p = [
        input.at(ix, iy),
        input.at(ix + 1, iy),
        input.at(ix, iy + 1),
        input.at(ix + 1, iy + 1),
    ];
    if linear {
        return Pixel(std::array::from_fn(|c| {
            crate::sampling::bilinear(p.map(|p| p.0[c]), k[0], k[1])
        }));
    }
    let ws = [
        (1. - k[0]) * (1. - k[1]),
        k[0] * (1. - k[1]),
        (1. - k[0]) * k[1],
        k[0] * k[1],
    ];
    let mut out = [0.; 4];
    for (p, w) in p.into_iter().zip(ws) {
        for (c, value) in out.iter_mut().enumerate() {
            *value += p.0[c] * w;
        }
    }
    Pixel(out)
}

#[derive(Clone, Copy)]
pub struct GlassMaterial {
    pub scale: f32,
    pub depth: f32,
    pub refraction: f32,
    pub light: f32,
    pub dispersion: f32,
    pub direction: [f32; 2],
    pub modern: bool,
}
impl GlassMaterial {
    pub fn new(effect: &crate::scene::Effect, scale: f64) -> Self {
        if let Some(g) = &effect.glass {
            let angle = g.light_angle.rem_euclid(360.);
            let direction = match angle {
                0. => [0., -1.],
                90. => [1., 0.],
                180. => [0., 1.],
                270. => [-1., 0.],
                _ => {
                    let (s, c) = angle.to_radians().sin_cos();
                    [s as f32, -c as f32]
                }
            };
            Self {
                scale: (scale * g.bevel_size()) as f32,
                depth: (g.depth * scale) as f32,
                refraction: g.refraction as f32,
                light: g.light_intensity as f32,
                dispersion: g.chromatic_aberration(),
                direction,
                modern: true,
            }
        } else {
            Self {
                scale: scale as f32,
                depth: ((effect.radius * scale * 2.) as f32).max(4.),
                refraction: (effect.amount * scale) as f32,
                light: effect.opacity as f32,
                dispersion: 0.,
                direction: [0., 0.],
                modern: false,
            }
        }
    }
    pub fn uniforms(self) -> [f32; 9] {
        [
            self.depth,
            self.refraction,
            self.light,
            0.,
            self.dispersion,
            self.direction[0],
            self.direction[1],
            f32::from(self.modern),
            self.scale,
        ]
    }
}
pub(crate) fn glass_pixel(
    input: &Surface,
    point: [i32; 2],
    d: f32,
    gradient: [f32; 2],
    m: GlassMaterial,
    linear: bool,
) -> Pixel {
    let [x, y] = point;
    let [gx, gy] = gradient;
    let len = (gx * gx + gy * gy).sqrt().max(1e-5);
    let nx = gx / len;
    let ny = gy / len;
    let edge = (1. - d / m.depth.max(1e-5)).clamp(0., 1.);
    let nz = (1. - edge * edge).max(0.).sqrt();
    let eta = 1. / (1. + m.refraction);
    let transmitted = (1. - (eta * eta) * (edge * edge)).max(1e-10).sqrt();
    let bend = if m.refraction == 0. {
        0.
    } else {
        edge - ((eta * edge) * nz) / transmitted
    };
    let shift = (m.depth * m.refraction) * bend;
    let spread = (m.depth * m.dispersion) * edge * edge * 0.125;
    let rays = [shift - spread, shift, shift + spread]
        .map(|v| sample(input, x, y, [nx * v, ny * v], linear));
    let mut p = Pixel([
        rays[0].0[0],
        rays[1].0[1],
        rays[2].0[2],
        rays.iter().map(|p| p.0[3]).fold(0_f32, f32::max),
    ]);
    let dot = nx * m.direction[0] + ny * m.direction[1];
    let tint = (((dot * m.light) * edge) * edge) * 0.125;
    if tint < 0. {
        p = crate::blend::over(p, Pixel::rgba(0., 0., 0., -tint), "normal");
    } else {
        p = crate::blend::over(p, Pixel::rgba(1., 1., 1., tint), "normal");
    }
    let rim = (1. - (d - 0.5).max(0.) / (m.scale * 0.9375)).clamp(0., 1.);
    let angular = dot.abs() * dot.abs().sqrt();
    let highlight = (((m.light * angular) * (2. - 0.5 * dot)) * rim).clamp(0., 1.);
    crate::blend::over(p, Pixel::rgba(1., 1., 1., highlight), "normal")
}
pub fn texture(
    input: &Surface,
    amount: f64,
    t: &TextureParameters,
    m: Transform,
    linear: bool,
) -> Result<Surface, String> {
    texture_at(input, amount, t, m, linear, [0.; 2])
}
pub fn texture_at(
    input: &Surface,
    amount: f64,
    t: &TextureParameters,
    m: Transform,
    linear: bool,
    center: [f64; 2],
) -> Result<Surface, String> {
    if amount == 0. {
        return input.try_clone();
    }
    let inverse = m.inverse_composed(input.rect)?;
    let mut out = input.new_like(input.rect)?;
    for y in input.rect.y..input.rect.bottom() {
        for x in input.rect.x..input.rect.right() {
            let delta = displacement(x, y, amount, t, m, inverse, center)?;
            let first = sample(input, x, y, delta, linear);
            let p = if t.clip_to_shape {
                let original = input.at(x, y);
                if original.0[3] <= 0. {
                    Pixel::default()
                } else {
                    let weight = fifth_root(original.0[3]) * fifth_root(first.0[3]);
                    let shifted = sample(input, x, y, delta.map(|v| v * weight), linear);
                    // Restore the original if the attenuated lookup is transparent.
                    // Coverage is owned by the shape/render pass, not an alpha gain.
                    if shifted.0[3] > 0. { shifted } else { original }
                }
            } else {
                first
            };
            out.pixels[input.rect.index(x, y).expect("material rect")] = p;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod lighting_tests {
    use super::*;

    #[test]
    fn directional_light_does_not_create_an_ambient_rim() {
        let mut input = Surface::new(Rect::new(0, 0, 8, 8)).unwrap();
        input.pixels.fill(Pixel::rgba(0.3, 0.4, 0.5, 0.75));
        let fx: crate::scene::Effect = serde_json::from_value(serde_json::json!({
            "kind":"glass","color":"#000000","glass":{
                "depth":8,"refraction":0,"dispersion":0,"lightAngle":0,"lightIntensity":1
            }
        }))
        .unwrap();
        let mut material = GlassMaterial::new(&fx, 2.);
        for d in [0.5, 1., 2., 8., 32.] {
            assert_eq!(
                glass_pixel(&input, [3, 3], d, [1., 0.], material, true),
                input.at(3, 3)
            );
        }
        material.light = 0.;
        assert_eq!(
            glass_pixel(&input, [3, 3], 1., [0., 1.], material, true),
            input.at(3, 3)
        );
    }
}
