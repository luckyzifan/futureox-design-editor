//! Portable spatial filters with explicit sigma/angle semantics. Existing
//! `blur` retains its historical tent/radius contract. Motion uses a normalized
//! Gaussian along the transformed local direction, with full-float weights and
//! the shared single-round bilinear sampler (including transparent neighbours).
use crate::{
    blend::{Pixel, Surface},
    math::Transform,
};

pub const MAX_SIGMA: f64 = 512.;
#[derive(Clone, Copy, Debug)]
struct Tap {
    x: i32,
    y: i32,
    fx: f32,
    fy: f32,
    weight: f32,
}
pub struct MotionKernel {
    taps: Vec<Tap>,
    total: f32,
}
impl MotionKernel {
    pub fn new(radius: f64, angle: f64, matrix: Transform) -> Result<Self, String> {
        if !radius.is_finite()
            || radius < 0.
            || !angle.is_finite()
            || angle.abs() > 1e7
            || matrix.0.iter().any(|v| !v.is_finite())
        {
            return Err("Invalid motion blur parameters".into());
        }
        let (sin, cos) = match angle.rem_euclid(360.) {
            0. => (0., 1.),
            90. => (1., 0.),
            180. => (0., -1.),
            270. => (-1., 0.),
            _ => angle.to_radians().sin_cos(),
        };
        let (x, y) = (
            matrix.0[0] * cos + matrix.0[2] * sin,
            matrix.0[1] * cos + matrix.0[3] * sin,
        );
        let length = x.hypot(y);
        let sigma = radius * length;
        if !sigma.is_finite() || sigma > MAX_SIGMA {
            return Err("Motion blur sigma exceeds 512 device pixels".into());
        }
        if sigma == 0. {
            return Ok(Self {
                taps: vec![Tap {
                    x: 0,
                    y: 0,
                    fx: 0.,
                    fy: 0.,
                    weight: 1.,
                }],
                total: 1.,
            });
        }
        let reach = (3. * sigma).ceil() as i32;
        let mut taps = Vec::with_capacity((2 * reach + 1) as usize);
        let axis = |value: f64| {
            let mut integer = value.floor() as i32;
            let mut fraction = (value - f64::from(integer)) as f32;
            if fraction == 1. {
                integer += 1;
                fraction = 0.;
            }
            (integer, fraction)
        };
        let mut total = 0_f32;
        for i in -reach..=reach {
            let weight = (-0.5 * (f64::from(i) / sigma).powi(2)).exp() as f32;
            if weight == 0. {
                continue;
            }
            let (dx, fx) = axis(f64::from(i) * x / length);
            let (dy, fy) = axis(f64::from(i) * y / length);
            total += weight;
            taps.push(Tap {
                x: dx,
                y: dy,
                fx,
                fy,
                weight,
            });
        }
        Ok(Self { taps, total })
    }
    /// A bounded 256-wide metadata texture: header then two texels per tap.
    pub fn encoded(&self) -> Vec<f32> {
        let len = (4 + self.taps.len() * 8).div_ceil(1024) * 1024;
        let mut out = vec![0.; len];
        out[0] = self.taps.len() as f32;
        out[1] = self.total;
        for (i, t) in self.taps.iter().enumerate() {
            let offset = 4 + i * 8;
            out[offset..offset + 5]
                .copy_from_slice(&[t.x as f32, t.y as f32, t.fx, t.fy, t.weight]);
        }
        out
    }
    pub fn apply(&self, input: &Surface) -> Result<Surface, String> {
        if self.taps.len() == 1 && self.taps[0].x == 0 && self.taps[0].y == 0 {
            return input.try_clone();
        }
        let _scratch = input.reserve_scratch::<Tap>(self.taps.len())?;
        let mut out = input.new_like(input.rect)?;
        for y in input.rect.y..input.rect.bottom() {
            crate::render_cancellation::checkpoint()?;
            for x in input.rect.x..input.rect.right() {
                let mut sum = [0_f32; 4];
                for tap in &self.taps {
                    let (x, y) = (x + tap.x, y + tap.y);
                    let pixels = [
                        input.at(x, y),
                        input.at(x + 1, y),
                        input.at(x, y + 1),
                        input.at(x + 1, y + 1),
                    ];
                    for c in 0..4 {
                        let v = crate::sampling::bilinear(pixels.map(|p| p.0[c]), tap.fx, tap.fy);
                        sum[c] += v * tap.weight;
                    }
                }
                out.pixels[input.rect.index(x, y).unwrap()] = Pixel(sum.map(|v| v / self.total));
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Rect;
    #[test]
    fn identity_preserves_hdr_and_sign_bits() {
        let mut input = Surface::new(Rect::new(0, 0, 3, 2)).unwrap();
        input.pixels.fill(Pixel([4., -0.25, -0., 0.5]));
        let out = MotionKernel::new(0., 37., Transform::default())
            .unwrap()
            .apply(&input)
            .unwrap();
        assert_eq!(
            out.pixels
                .iter()
                .map(|p| p.0.map(f32::to_bits))
                .collect::<Vec<_>>(),
            input
                .pixels
                .iter()
                .map(|p| p.0.map(f32::to_bits))
                .collect::<Vec<_>>()
        );
    }
    #[test]
    fn direction_follows_the_local_transform_and_keeps_finite_support() {
        let mut input = Surface::new(Rect::new(-20, -20, 41, 41)).unwrap();
        input.pixels[input.rect.index(0, 0).unwrap()] = Pixel([4., -0.25, 1., 1.]);
        let a = MotionKernel::new(2., 0., Transform::default())
            .unwrap()
            .apply(&input)
            .unwrap();
        let b = MotionKernel::new(2., 0., Transform([0., 1., -1., 0., 0., 0.]))
            .unwrap()
            .apply(&input)
            .unwrap();
        assert!(a.at(2, 0).0[3] > 0. && a.at(0, 2).0[3] == 0.);
        assert!(b.at(0, 2).0[3] > 0. && b.at(2, 0).0[3] == 0.);
        assert!(a.at(0, 0).0[1] < 0.);
        assert_eq!(a.at(8, 0), Pixel::default());
        assert!((a.pixels.iter().map(|p| p.0[3]).sum::<f32>() - 1.).abs() < 1e-6);
    }
}
