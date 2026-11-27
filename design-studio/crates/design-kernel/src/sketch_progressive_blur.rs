//! Sketch-style variable-radius blur. The strength field is evaluated in
//! layer space. Three or four fractional boxes per axis approximate a Gaussian
//! with the requested local variance. The existing two-end Figma filter is
//! separate.

use crate::{
    blend::{Pixel, Surface},
    math::{Point, Rect, Transform},
    scene::{BlurRampShape, GradientBlurParameters},
};

/// A hard rectangular source has no curved, textured, or stroked coverage
/// to rephase when the very smallest foreground filters retain its edge.
pub(crate) fn sharp_linear_layer(node: &crate::scene::Node) -> bool {
    if node.kind != "rectangle" || node.mask || node.blend != "normal" || !node.children.is_empty() ||
        node.radii.iter().any(|&radius| radius != 0.) || node.strokes.iter().any(|stroke| stroke.visible) ||
        node.fills.iter().any(|fill| fill.visible && (fill.kind != "solid" || fill.blend != "normal"))
    {
        return false;
    }
    let mut effects = node.effects.iter().filter(|effect| effect.visible);
    effects.next().is_some_and(|effect| effect.kind == "gaussian-blur" && effect.sketch_ramp()
        .and_then(|ramp| ramp.sketch.as_ref()).is_some_and(|ramp| ramp.shape == BlurRampShape::Linear)) &&
        effects.next().is_none()
}

pub fn layer_edges_on_pixels([width, height]: [f64; 2], matrix: Transform) -> bool {
    let [a, b, c, d, x, y] = matrix.0;
    b == 0. && c == 0. && a > 0. && d > 0. &&
        [x, y, x + a * width, y + d * height].iter().all(|value| value.is_finite() && value.fract() == 0.)
}

/// A rotated rectangular lens samples the backdrop inside its own capture
/// rectangle. Extend its edge texels into the screen-aligned allocation so
/// separable screen-space filters do not see unrelated pixels in its corners.
#[derive(Clone, Copy)]
pub(crate) struct RotatedBackdrop {
    inverse: Transform,
    world: Transform,
    inset: [f64; 2],
    size: [f64; 2],
    density: [f64; 2],
}

impl RotatedBackdrop {
    pub(crate) fn for_node(doc: &crate::scene::Document, node: &crate::scene::Node,
        effect: &crate::scene::Effect, world: Transform) -> Option<Self>
    {
        (effect.radius > 0.).then(|| Self::for_capture(doc, node, effect, world)).flatten()
    }

    pub(crate) fn for_color_only(doc: &crate::scene::Document, node: &crate::scene::Node,
        effect: &crate::scene::Effect, world: Transform) -> Option<Self>
    {
        (effect.radius == 0. && effect.color_controls.as_ref().is_some_and(|controls| !controls.is_identity()))
            .then(|| Self::for_capture(doc, node, effect, world)).flatten()
    }

    fn for_capture(doc: &crate::scene::Document, node: &crate::scene::Node,
        effect: &crate::scene::Effect, world: Transform) -> Option<Self>
    {
        if node.kind != "rectangle" || node.mask || node.passes_backdrop()
            || effect.kind != "background-blur" || effect.sketch_ramp().is_none()
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
            density: [sx, sy],
            inset: [(0.5 / sx).min(size[0] / 2.), (0.5 / sy).min(size[1] / 2.)],
        })
    }

    // The color-only effect reads the rotated capture at its own texel phase.
    // Reconstruct that sample directly to avoid a second full-sized surface.
    pub(crate) fn sample_color_only(self, point: Point, backdrop: &Surface) -> Pixel {
        let local = self.inverse.point(point);
        let grid = [local.x * self.density[0] - 0.5, local.y * self.density[1] - 0.5];
        let cell = grid.map(f64::floor);
        let phase = [grid[0] - cell[0], grid[1] - cell[1]];
        let sample = |x: f64, y: f64| {
            let local_x = ((cell[0] + x + 0.5) / self.density[0])
                .clamp(self.inset[0], self.size[0] - self.inset[0]);
            let local_y = ((cell[1] + y + 0.5) / self.density[1])
                .clamp(self.inset[1], self.size[1] - self.inset[1]);
            let world = self.world.point(Point::new(local_x, local_y));
            backdrop.sample_linear(world.x, world.y)
        };
        let top = sample(0., 0.).interpolate(sample(1., 0.), phase[0] as f32, false);
        let bottom = sample(0., 1.).interpolate(sample(1., 1.), phase[0] as f32, false);
        top.interpolate(bottom, phase[1] as f32, false)
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

fn box_radius(sigma: f32, boxes: usize) -> (usize, f32) {
    let variance = sigma * sigma / boxes as f32;
    // The integer box [-r,r] has variance r(r+1)/3. Include the two
    // neighbouring taps fractionally, solving for this pass's variance.
    let radius = (((12. * variance + 1.).sqrt() - 1.) * 0.5).floor();
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
    source: Surface,
    params: &GradientBlurParameters,
    matrix: Transform,
    origin: Point,
    sigma: f64,
    clamp_edges: bool,
    byte: bool,
    sharp_layer: bool,
) -> Result<Surface, String> {
    apply_with_boxes(source, params, matrix, origin, sigma, clamp_edges, byte, sharp_layer, None)
}

#[allow(clippy::too_many_arguments)]
fn apply_with_boxes(
    mut source: Surface,
    params: &GradientBlurParameters,
    matrix: Transform,
    origin: Point,
    sigma: f64,
    clamp_edges: bool,
    byte: bool,
    sharp_layer: bool,
    boxes_override: Option<usize>,
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
    // Radial and multi-stop ramps change the radius inside the kernel's
    // support, so the three-box approximation leaves a visible kernel-shape
    // residual against the native optical blur. A fourth box cuts that
    // residual once the smallest local radius reaches four device pixels.
    // Below that the box stack has too few taps and keeps three boxes;
    // two-end linear ramps keep the established three-box cost.
    let smallest = field.stops.iter().map(|stop| stop[1]).fold(1f32, f32::min);
    let boxes = boxes_override
        .unwrap_or(if (field.radial || field.stops.len() > 2) && sigma * smallest >= 4. {
            4
        } else {
            3
        })
        .max(1);
    // Rotated and sheared captures require a separate sharp sampling phase.
    let axis_aligned_backdrop = clamp_edges && matrix.0[1] == 0. && matrix.0[2] == 0.;
    let (sharp_start, sharp_end) = if axis_aligned_backdrop {
        (SHARP_BACKDROP_SIGMA, FULL_BACKDROP_SIGMA)
    } else if sharp_layer && !clamp_edges && !field.radial {
        // The layer blur sigma is already in authored device-pixel units.
        (0.7, 1.5)
    } else {
        (0., 0.)
    };
    let sharp = field.stops.iter().any(|stop| sigma * stop[1] < sharp_end)
        .then(|| source.try_clone())
        .transpose()?;
    let [w, h] = [source.rect.w as usize, source.rect.h as usize];
    let max_line = w.max(h);
    let _prefix = source.reserve_scratch::<[f64; 4]>(max_line + 1)?;
    let _line = source.reserve_scratch::<[f32; 4]>(max_line)?;
    let mut prefix = vec![[0.; 4]; max_line + 1];
    let mut original = vec![[0.; 4]; max_line];
    for pass in 0..2 * boxes {
        let horizontal = pass % 2 == 0;
        let sharp = if pass + 1 == 2 * boxes { sharp.as_ref() } else { None };
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
                let (r, edge) = box_radius(local_sigma, boxes);
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
                if let Some(sharp) = sharp.filter(|_| local_sigma < sharp_end) {
                    let weight = ((local_sigma - sharp_start) / (sharp_end - sharp_start)).max(0.);
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stripes(width: usize, height: usize) -> Surface {
        let mut surface = Surface::new(Rect::new(0, 0, width as u32, height as u32)).unwrap();
        for y in 0..height {
            for x in 0..width {
                surface.pixels[y * width + x] = Pixel(if x / 6 % 2 == 0 {
                    [0.1, 0.25, 0.8, 1.]
                } else {
                    [0.9, 0.85, 0.1, 1.]
                });
            }
        }
        surface
    }

    /// Separable variable Gaussian evaluated directly. It is an independent
    /// 2D kernel at every pixel, not the three/four box stack under test.
    fn gaussian_oracle(
        source: &Surface, params: &GradientBlurParameters, sigma: f64,
    ) -> Vec<[f32; 4]> {
        let [w, h] = [source.rect.w as usize, source.rect.h as usize];
        let field = Field::new(params, Transform::default(), source.rect).unwrap();
        let mut out = vec![[0.; 4]; w * h];
        for y in 0..h {
            for x in 0..w {
                let local = sigma as f32 * field.strength(x as f32 + 0.5, y as f32 + 0.5);
                let reach = (3. * local).ceil() as i32;
                let mut sum = [0f64; 4];
                let mut mass = 0f64;
                for dy in -reach..=reach {
                    for dx in -reach..=reach {
                        let weight = (-0.5 * (f64::from(dx * dx + dy * dy)) / f64::from(local).powi(2)).exp();
                        if weight < 1e-12 {
                            continue;
                        }
                        let sx = (x as i32 + dx).clamp(0, w as i32 - 1) as usize;
                        let sy = (y as i32 + dy).clamp(0, h as i32 - 1) as usize;
                        let pixel = source.pixels[sy * w + sx].0;
                        for c in 0..4 {
                            sum[c] += f64::from(pixel[c]) * weight;
                        }
                        mass += weight;
                    }
                }
                out[y * w + x] = sum.map(|value| (value / mass) as f32);
            }
        }
        out
    }

    fn error(
        actual: &Surface, expected: &[[f32; 4]], radius: i32,
    ) -> (f64, i32, f64) {
        let w = actual.rect.w as usize;
        let [x0, y0] = [radius as usize, radius as usize];
        let [x1, y1] = [w - radius as usize, actual.rect.h as usize - radius as usize];
        let (mut sum, mut max, mut count) = (0f64, 0i32, 0usize);
        for y in y0..y1 {
            for x in x0..x1 {
                let i = y * w + x;
                for c in 0..4 {
                    let delta = ((actual.pixels[i].0[c] - expected[i][c]).abs() * 255.).round() as i32;
                    sum += f64::from(delta);
                    max = max.max(delta);
                    count += 1;
                }
            }
        }
        (sum / count as f64, max, sum / count as f64)
    }

    #[test]
    fn radial_and_multi_stop_kernels_gain_from_a_fourth_box() {
        let source = stripes(192, 144);
        let params: GradientBlurParameters = serde_json::from_value(json!({
            "start":[96.,72.],"end":[192.,72.],"startCount":1,"endCount":1,"smooth":true,
            "sketch":{"shape":"radial","ellipse":1.5,"stops":[
                {"offset":0.,"strength":0.6},{"offset":0.4,"strength":1.},{"offset":1.,"strength":0.7}
            ]}
        })).unwrap();
        let sigma = 12.;
        let expected = gaussian_oracle(&source, &params, sigma);
        let mut results = Vec::new();
        for boxes in [3, 4] {
            let filtered = apply_with_boxes(
                source.try_clone().unwrap(), &params, Transform::default(),
                Point::default(), sigma, true, false, false, Some(boxes),
            ).unwrap();
            let (mean, max, _) = error(&filtered, &expected, (3. * sigma).ceil() as i32 + 1);
            println!("KERNEL\tradial\tboxes={boxes}\tmean={mean:.3}\tmax={max}");
            results.push((boxes, mean, max));
        }
        let three = results.iter().find(|r| r.0 == 3).unwrap();
        let four = results.iter().find(|r| r.0 == 4).unwrap();
        assert!(four.1 < three.1, "four-box mean {four:?} must beat three-box {three:?}");
        assert!(four.2 <= three.2, "four-box max {four:?} must not exceed three-box {three:?}");
        // The shipped selection takes the fourth box at this radius.
        let production = apply(
            source, &params, Transform::default(), Point::default(),
            sigma, true, false, false,
        ).unwrap();
        let override_four = apply_with_boxes(
            stripes(192, 144), &params, Transform::default(),
            Point::default(), sigma, true, false, false, Some(4),
        ).unwrap();
        assert_eq!(production.pixels, override_four.pixels, "production must select four boxes");
    }
}
