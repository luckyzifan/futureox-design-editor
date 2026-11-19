//! Sketch-style variable-radius blur. The strength field is evaluated in
//! layer space. Three fractional boxes per axis approximate a Gaussian with
//! the requested local variance. The existing two-end Figma filter is separate.

use crate::{
    blend::{Pixel, Surface},
    math::{Point, Rect, Transform},
    scene::{BlurRampShape, GradientBlurParameters},
};

/// A rotated rectangular lens samples the backdrop inside its own capture
/// rectangle. Extend its edge texels into the screen-aligned allocation so
/// separable screen-space filters do not see unrelated pixels in its corners.
#[derive(Clone, Copy)]
pub(crate) struct RotatedBackdrop {
    inverse: Transform,
    world: Transform,
    inset: [f64; 2],
    size: [f64; 2],
}

impl RotatedBackdrop {
    pub(crate) fn for_node(doc: &crate::scene::Document, node: &crate::scene::Node,
        effect: &crate::scene::Effect, world: Transform) -> Option<Self>
    {
        if node.kind != "rectangle" || node.mask || node.passes_backdrop()
            || effect.kind != "background-blur" || effect.radius <= 0. || effect.sketch_ramp().is_none()
            || node.effects.iter().any(|e| e.visible
                && matches!(e.kind.as_str(), "blur" | "gaussian-blur" | "motion-blur" | "zoom-blur"))
        {
            return None;
        }
        let [a, b, c, d, _, _] = world.0;
        let [sx, sy] = [a.hypot(b), c.hypot(d)];
        if !(sx.is_finite() && sy.is_finite() && sx > 0. && sy > 0.) { return None; }
        let axis = [a / sx, b / sx, c / sy, d / sy];
        let size = [node.width, node.height];
        // Right-angle rotations use the same screen capture; sheared lenses
        // have no orthogonal edge texels to extend.
        if axis.iter().any(|v| v.abs() <= 1e-8) || (axis[0] * axis[2] + axis[1] * axis[3]).abs() > 1e-6
            || size.iter().any(|v| !v.is_finite() || *v <= 0.)
        {
            return None;
        }
        // An opaque normal fill already hides the backdrop. Keep the
        // established antialiasing for that paint's outside edge.
        if node.fills.iter().any(|p| p.visible && p.kind == "solid" && p.blend == "normal" && p.opacity == 1.
            && crate::color::pixel(doc.color_management, &p.color, 1.).is_ok_and(|c| c.0[3] == 1.))
        {
            return None;
        }
        let inverse = world.inverse().ok()?;
        Some(Self {
            inverse, world, size,
            inset: [(0.5 / sx).min(size[0] / 2.), (0.5 / sy).min(size[1] / 2.)],
        })
    }

    pub(crate) fn limits(self) -> [f64; 4] {
        [self.inset[0], self.inset[1], self.size[0] - self.inset[0], self.size[1] - self.inset[1]]
    }

    #[inline]
    pub(crate) fn sample(self, point: Point) -> Point {
        let p = self.inverse.point(point);
        let x = p.x.clamp(self.inset[0], self.size[0] - self.inset[0]);
        let y = p.y.clamp(self.inset[1], self.size[1] - self.inset[1]);
        let [a, b, c, d, _, _] = self.world.0;
        Point::new(point.x + (a * (x - p.x) + c * (y - p.y)), point.y + (b * (x - p.x) + d * (y - p.y)))
    }
}

struct Field {
    along: [f32; 3],
    across: [f32; 3],
    radial: bool,
    stops: Vec<[f32; 2]>,
}

impl Field {
    fn new(params: &GradientBlurParameters, matrix: Transform, bounds: Rect) -> Result<Self, String> {
        let ramp = params.sketch.as_ref().ok_or("Missing Sketch blur ramp")?;
        let inverse = matrix.inverse_composed(bounds)?.0;
        let [x, y] = params.start;
        let dx = params.end[0] - x;
        let dy = params.end[1] - y;
        let length_squared = dx * dx + dy * dy;
        let ratio = if ramp.ellipse == 0. { 1. } else { ramp.ellipse };
        let row = |a: f64, b: f64| {
            [
                (a * inverse[0] + b * inverse[1]) as f32,
                (a * inverse[2] + b * inverse[3]) as f32,
                (a * (inverse[4] - x) + b * (inverse[5] - y)) as f32,
            ]
        };
        let (along, across) = if length_squared > 0. {
            (
                row(dx / length_squared, dy / length_squared),
                row(-dy / length_squared / ratio, dx / length_squared / ratio),
            )
        } else {
            ([0.; 3], [0.; 3])
        };
        if !along.iter().chain(&across).all(|value| value.is_finite()) {
            return Err("Sketch blur ramp transform exceeds the precision limit".into());
        }
        Ok(Self {
            along,
            across,
            radial: ramp.shape == BlurRampShape::Radial,
            stops: ramp.stops.iter().map(|stop| [stop.offset as f32, stop.strength as f32]).collect(),
        })
    }

    fn strength(&self, x: f32, y: f32) -> f32 {
        let project = |[a, b, c]: [f32; 3]| a.mul_add(x, b.mul_add(y, c));
        let along = project(self.along);
        let position = if self.radial {
            let across = project(self.across);
            (along * along + across * across).sqrt()
        } else {
            along
        }.clamp(0., 1.);
        let after = self.stops.partition_point(|stop| stop[0] <= position);
        if after == 0 { return self.stops[0][1]; }
        let [low, strength] = self.stops[after - 1];
        let Some(&[high, end]) = self.stops.get(after) else { return strength };
        strength + (end - strength) * ((position - low) / (high - low))
    }
}

/// Values for the matching GPU box pass. Keep the coordinates in physical
/// pixels, including any fractional origin of a backdrop capture.
pub fn uniforms(params: &GradientBlurParameters, matrix: Transform, bounds: Rect) -> Result<Vec<f32>, String> {
    let field = Field::new(params, matrix, bounds)?;
    let mut values = Vec::with_capacity(8 + field.stops.len() * 2);
    values.extend_from_slice(&field.along);
    values.push(f32::from(field.radial));
    values.extend_from_slice(&field.across);
    values.push(field.stops.len() as f32);
    values.extend(field.stops.into_iter().flatten());
    Ok(values)
}

fn box_radius(sigma: f32) -> (usize, f32) {
    let variance = sigma * sigma / 3.;
    // The integer box [-r,r] has variance r(r+1)/3. Include the two
    // neighbouring taps fractionally, solving for this pass's variance.
    let radius = (((4. * sigma * sigma + 1.).sqrt() - 1.) * 0.5).floor();
    let weight = 2. * radius + 1.;
    let edge = radius + 1.;
    let fraction = weight * (variance - radius * edge / 3.) / (2. * (edge * edge - variance));
    (radius as usize, fraction.clamp(0., 1.))
}

// Sketch keeps the sharp centre of a small progressive backdrop kernel. Its
// weight fades over roughly 0.7–1.5 device pixels of local authored radius.
// The backdrop sigma already includes the radius calibration in Effect.
const SHARP_BACKDROP_SIGMA: f32 = 0.7 * std::f32::consts::SQRT_2 * 0.75;
const FULL_BACKDROP_SIGMA: f32 = 1.5 * std::f32::consts::SQRT_2 * 0.75;

pub(crate) fn apply(
    mut source: Surface,
    params: &GradientBlurParameters,
    matrix: Transform,
    origin: Point,
    sigma: f64,
    clamp_edges: bool,
    byte: bool,
) -> Result<Surface, String> {
    if !sigma.is_finite() || !(0. ..=512.).contains(&sigma) {
        return Err("Sketch progressive blur sigma must be in [0,512]".into());
    }
    if source.rect.empty() || sigma == 0. {
        return Ok(source);
    }
    let guard = Rect::new(
        source.rect.x + origin.x.floor() as i32, source.rect.y + origin.y.floor() as i32,
        source.rect.w + 1, source.rect.h + 1,
    );
    let field = Field::new(params, matrix, guard)?;
    let sigma = sigma as f32;
    // Rotated and sheared captures require a separate sharp sampling phase.
    let axis_aligned_backdrop = clamp_edges && matrix.0[1] == 0. && matrix.0[2] == 0.;
    let sharp = (axis_aligned_backdrop
        && field.stops.iter().any(|stop| sigma * stop[1] < FULL_BACKDROP_SIGMA))
        .then(|| source.try_clone())
        .transpose()?;
    let [w, h] = [source.rect.w as usize, source.rect.h as usize];
    let max_line = w.max(h);
    let _prefix = source.reserve_scratch::<[f64; 4]>(max_line + 1)?;
    let _line = source.reserve_scratch::<[f32; 4]>(max_line)?;
    let mut prefix = vec![[0.; 4]; max_line + 1];
    let mut original = vec![[0.; 4]; max_line];
    for pass in 0..6 {
        let horizontal = pass % 2 == 0;
        let sharp = if pass == 5 { sharp.as_ref() } else { None };
        let (lines, length) = if horizontal { (h, w) } else { (w, h) };
        for line in 0..lines {
            crate::render_cancellation::checkpoint()?;
            let index = |i: usize| if horizontal { line * w + i } else { i * w + line };
            // An axis pass only reads this line. Keep its fractional taps
            // before overwriting it so the sharp capture can occupy the
            // second surface without adding a third full-size allocation.
            for i in 0..length {
                let pixel = source.pixels[index(i)].0;
                original[i] = pixel;
                prefix[i + 1] = std::array::from_fn(|c| prefix[i][c] + f64::from(pixel[c]));
            }
            let sample = |i: i64| -> [f32; 4] {
                if clamp_edges || (0..length as i64).contains(&i) {
                    original[i.clamp(0, length as i64 - 1) as usize]
                } else {
                    [0.; 4]
                }
            };
            for i in 0..length {
                let (x, y) = if horizontal { (i, line) } else { (line, i) };
                let x = (source.rect.x as f32 + x as f32 + 0.5) + origin.x as f32;
                let y = (source.rect.y as f32 + y as f32 + 0.5) + origin.y as f32;
                let local_sigma = sigma * field.strength(x, y);
                let (r, edge) = box_radius(local_sigma);
                let left = i as i64 - r as i64;
                let right = (i + r) as i64;
                let a = prefix[left.max(0) as usize];
                let b = prefix[(right + 1).min(length as i64) as usize];
                let l = sample(left - 1);
                let h = sample(right + 1);
                let left_pad = if clamp_edges { (-left).max(0) as f64 } else { 0. };
                let right_pad = if clamp_edges { (right + 1 - length as i64).max(0) as f64 } else { 0. };
                let f = f64::from(edge);
                let divisor = (2 * r + 1) as f64 + 2. * f;
                let mut filtered = std::array::from_fn(|c| {
                    ((b[c] - a[c] + (left_pad + f) * f64::from(l[c]) + (right_pad + f) * f64::from(h[c])) / divisor) as f32
                });
                let offset = index(i);
                if let Some(sharp) = sharp.filter(|_| local_sigma < FULL_BACKDROP_SIGMA) {
                    let weight = ((local_sigma - SHARP_BACKDROP_SIGMA)
                        / (FULL_BACKDROP_SIGMA - SHARP_BACKDROP_SIGMA)).max(0.);
                    filtered = std::array::from_fn(|c| {
                        sharp.pixels[offset].0[c] * (1. - weight) + filtered[c] * weight
                    });
                }
                source.pixels[offset] = Pixel(filtered);
            }
        }
        if byte { source.quantize_rgba8(); }
    }
    Ok(source)
}
