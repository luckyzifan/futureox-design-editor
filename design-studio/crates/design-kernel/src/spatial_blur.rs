//! Portable spatial filters with explicit sigma/angle semantics. Existing
//! `blur` retains its historical tent/radius contract. Motion uses a normalized
//! Gaussian along the transformed local direction, with full-float weights and
//! the shared single-round bilinear sampler (including transparent neighbours).
use crate::{
    blend::{Pixel, Surface},
    math::{Point, Rect, Transform},
    scene::{Document, Effect, Node},
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

fn direction(radius: f64, angle: f64, matrix: Transform) -> Result<([f64; 2], f64), String> {
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
    let x = matrix.0[0] * cos + matrix.0[2] * sin;
    let y = matrix.0[1] * cos + matrix.0[3] * sin;
    let sigma = radius * x.hypot(y);
    if !sigma.is_finite() || sigma > MAX_SIGMA {
        return Err("Motion blur sigma exceeds 512 device pixels".into());
    }
    Ok(([x, y], sigma))
}

fn axis(value: f64) -> (i32, f32) {
    let mut integer = value.floor() as i32;
    let mut fraction = (value - f64::from(integer)) as f32;
    if fraction == 1. {
        integer += 1;
        fraction = 0.;
    }
    (integer, fraction)
}

fn sample(input: &Surface, x: i32, y: i32, tap: Tap) -> Pixel {
    let (x, y) = (x + tap.x, y + tap.y);
    let pixels = [
        input.at(x, y),
        input.at(x + 1, y),
        input.at(x, y + 1),
        input.at(x + 1, y + 1),
    ];
    Pixel(std::array::from_fn(|channel| {
        crate::sampling::bilinear(pixels.map(|p| p.0[channel]), tap.fx, tap.fy)
    }))
}

impl MotionKernel {
    pub fn new(radius: f64, angle: f64, matrix: Transform) -> Result<Self, String> {
        let ([x, y], sigma) = direction(radius, angle, matrix)?;
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
        let length = x.hypot(y);
        let reach = (3. * sigma).ceil() as i32;
        let mut taps = Vec::with_capacity((2 * reach + 1) as usize);
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
                    let value = sample(input, x, y, *tap);
                    for (out, channel) in sum.iter_mut().zip(value.0) {
                        *out += channel * tap.weight;
                    }
                }
                out.pixels[input.rect.index(x, y).unwrap()] = Pixel(sum.map(|v| v / self.total));
            }
        }
        Ok(out)
    }
}

fn sketch_effect<'a>(doc: &Document, node: &'a Node, matrix: Transform) -> Option<&'a Effect> {
    if matrix.0[1] != 0. || matrix.0[2] != 0. || doc.color_management.is_some()
        || node.kind != "rectangle" || node.mask || !node.render_children().is_empty()
        || node.strokes.iter().any(|stroke| stroke.visible)
    {
        return None;
    }
    let mut visible = node.effects.iter().filter(|effect| effect.visible);
    let effect = visible.next().filter(|effect| effect.kind == "motion-blur")?;
    (visible.next().is_none() && crate::interop::sketch_binding(doc, node, "sketchSourceBlur").is_some())
        .then_some(effect)
}

pub(crate) fn sketch_output(doc: &Document, node: &Node, matrix: Transform) -> Option<Rect> {
    let effect = sketch_effect(doc, node, matrix)?;
    let ([x, y], _) = direction(effect.radius, effect.motion_angle, matrix).ok()?;
    let low = matrix.point(Point::new(0., 0.));
    let high = matrix.point(Point::new(node.width, node.height));
    let dx = (3. * effect.radius * x.abs()).ceil();
    let dy = (3. * effect.radius * y.abs()).ceil();
    Some(Rect::from_points([
        Point::new(low.x.min(high.x) - dx, low.y.min(high.y) - dy),
        Point::new(low.x.max(high.x) + dx, low.y.max(high.y) + dy),
    ].into_iter()))
}

pub(crate) fn read_outset(doc: &Document, node: &Node, matrix: Transform, scale: f64) -> f64 {
    let outset = node.effect_outset(scale);
    let Some(effect) = sketch_effect(doc, node, matrix).filter(|effect| effect.radius >= 0.5) else {
        return outset;
    };
    let Ok((_, sigma)) = direction(effect.radius, effect.motion_angle, matrix) else {
        return outset;
    };
    let (last, _) = terminal_stride(sigma * sigma);
    outset.max(4. * last)
}

pub(crate) fn world_read_outset(doc: &Document, node: &Node, matrix: Transform, scale: f64) -> f64 {
    let outset = node.effect_outset(scale);
    // This index is reused across cameras. A linear bound encloses all
    // terminal-stride changes as the device scale crosses a power of two.
    sketch_effect(doc, node, matrix).filter(|effect| effect.radius >= 0.5)
        .map_or(outset, |effect| outset.max(7. * effect.radius * scale + 2.))
}

pub(crate) enum MotionFilter {
    Standard(MotionKernel),
    Sketch(SketchMotion, Rect),
}

impl MotionFilter {
    pub(crate) fn for_effect(
        doc: &Document,
        node: &Node,
        effect: &Effect,
        matrix: Transform,
        analytic: bool,
    ) -> Result<Self, String> {
        if let Some(clip) = analytic.then(|| sketch_output(doc, node, matrix)).flatten() {
            return Ok(Self::Sketch(SketchMotion::new(effect.radius, effect.motion_angle, matrix)?, clip));
        }
        MotionKernel::new(effect.radius, effect.motion_angle, matrix).map(Self::Standard)
    }

    pub(crate) fn apply(&self, input: &Surface) -> Result<Surface, String> {
        match self {
            Self::Standard(kernel) => kernel.apply(input),
            Self::Sketch(kernel, clip) => kernel.apply(input, *clip),
        }
    }
}

pub struct SketchMotion {
    passes: Vec<SketchMotionPass>,
}

struct SketchMotionPass {
    taps: [Tap; 4],
    weights: [f32; 3],
    intermediate: bool,
}

fn terminal_stride(target: f64) -> (f64, f64) {
    let mut stride = 1.;
    let mut variance = 0.;
    while target > variance + stride * stride + 1. / 12. {
        variance += stride * stride;
        stride *= 2.;
    }
    (stride, variance)
}

impl SketchMotion {
    pub fn new(radius: f64, angle: f64, matrix: Transform) -> Result<Self, String> {
        let ([x, y], sigma) = direction(radius, angle, matrix)?;
        let mut passes = Vec::new();
        if radius < 0.5 || sigma == 0. {
            return Ok(Self { passes });
        }
        let length = x.hypot(y);
        let mut stride = 1.;
        let target = sigma * sigma;
        let (last_stride, variance) = terminal_stride(target);
        let mut push = |stride: f64, center: f64, side: f64, intermediate| {
            let taps = [-1., 1., -2., 2.].map(|index| {
                let (x, fx) = axis(x / length * stride * index);
                let (y, fy) = axis(y / length * stride * index);
                Tap { x, y, fx, fy, weight: 0. }
            });
            passes.push(SketchMotionPass {
                taps,
                weights: [center as f32, side as f32, (side * side) as f32],
                intermediate,
            });
        };
        // The full stages are five-tap binomial kernels. Each adds the
        // square of its stride before the last stage supplies the remainder.
        while stride < last_stride {
            push(stride, 0.375, 0.25, true);
            stride *= 2.;
        }
        let side = if stride == 1. {
            3. * target / 13.
        } else {
            (target - variance - 1. / 12.) / (4. * stride * stride)
        };
        push(stride, 1. - 2.5 * side, side, false);
        Ok(Self { passes })
    }

    pub fn uniforms(&self) -> impl Iterator<Item = [f32; 20]> + '_ {
        self.passes.iter().map(|pass| {
            let [center, near, far] = pass.weights;
            let mut values = [0.; 20];
            values[..4].copy_from_slice(&[center, near, far, if pass.intermediate { 2. } else { 1. }]);
            for (target, tap) in values[4..].chunks_exact_mut(4).zip(&pass.taps) {
                target.copy_from_slice(&[tap.x as f32, tap.y as f32, tap.fx, tap.fy]);
            }
            values
        })
    }

    fn apply(&self, input: &Surface, clip: Rect) -> Result<Surface, String> {
        let rect = input.rect;
        let mut current = None;
        for pass in &self.passes {
            let source = current.as_ref().unwrap_or(input);
            let mut output = source.new_like(rect)?;
            let [center, near, far] = pass.weights;
            let write = if pass.intermediate { rect } else { rect.intersect(clip) };
            for y in write.y..write.bottom() {
                crate::render_cancellation::checkpoint()?;
                for x in write.x..write.right() {
                    let base = source.at(x, y);
                    let [left, right, far_left, far_right] =
                        pass.taps.map(|tap| sample(source, x, y, tap));
                    let channels = std::array::from_fn(|c| {
                        let value = base.0[c] * center
                            + (left.0[c] + right.0[c]) * near
                            + (far_left.0[c] + far_right.0[c]) * far;
                        if pass.intermediate { half_toward_zero(value) } else { value }
                    });
                    output.pixels[rect.index(x, y).expect("motion pixel")] = Pixel(channels);
                }
            }
            current = Some(output);
        }
        current.map_or_else(|| input.try_clone(), Ok)
    }
}

fn half_toward_zero(value: f32) -> f32 {
    let rounded = half::f16::from_f32(value);
    if rounded.to_f32().abs() > value.abs() {
        half::f16::from_bits(rounded.to_bits() - 1).to_f32()
    } else {
        rounded.to_f32()
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
