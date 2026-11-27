//! A wide three-box Gaussian on a fully covered, separable image. The
//! device lattice stays intact: only the two axes of the bilinear source
//! basis are convolved instead of allocating the Cartesian source surface.
use crate::{math::{Point, Rect, Transform}, path::Command, scene::{Document, Node, Paint}};
use serde::{Deserialize, Serialize};

// Each GPU output stripe and each source-texel batch have their own
// allocation. The footprint and the radius do not size either allocation.
const MAX_OUTPUT_PIXELS: usize = 524_288;
const SOURCE_TEXEL_BATCH: usize = 96;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub output: Rect,
    pub radii: [u32; 3],
}

fn simple_paint(paint: &Paint) -> bool {
    paint.visible && paint.kind == "image" && paint.opacity == 1. && paint.blend == "normal"
        && matches!(paint.fit.as_str(), "cover" | "stretch")
        && paint.transform.is_none() && paint.adjust.is_none()
        && !paint.tile.as_ref().is_some_and(|tile| tile.is_active())
}

fn rectangle(n: &Node) -> bool {
    let Ok((path, _)) = n.paths() else { return false; };
    let mut corners = Vec::with_capacity(4);
    let mut closed = false;
    for command in path.commands {
        match command {
            Command::Move(p) if corners.is_empty() && !closed => corners.push(p),
            Command::Line(p) if !corners.is_empty() && !closed => {
                if corners.last() != Some(&p) { corners.push(p); }
                if corners.len() > 5 { return false; }
            }
            Command::Close if !corners.is_empty() && !closed => closed = true,
            _ => return false,
        }
    }
    if corners.len() == 5 && corners.first() == corners.last() { corners.pop(); }
    if !closed || corners.len() != 4 { return false; }
    (0..4).all(|i| {
        let p = corners[i];
        let next = corners[(i + 1) % 4];
        (p.x == 0. || p.x == n.width) && (p.y == 0. || p.y == n.height)
            && ((p.x == next.x) != (p.y == next.y))
            && !corners[..i].contains(&p)
    })
}

pub(crate) fn plan(doc: &Document, n: &Node, matrix: Transform, output: Rect) -> Option<Plan> {
    let [paint] = n.fills.as_slice() else { return None; };
    if n.mask || n.clip || n.passes_backdrop() || n.blend != "normal"
        || !n.render_children().is_empty() || n.strokes.iter().any(|s| s.visible)
        || !matches!(n.kind.as_str(), "rectangle" | "vector") || !simple_paint(paint)
        || !paint.image.as_deref().is_some_and(|uri| uri.starts_with("data:"))
        || crate::interop::sketch_binding(doc, n, "sketchSourceBitmap") == Some("true")
        || output.empty() || n.width <= 0. || n.height <= 0. { return None; }
    let mut effects = n.effects.iter().filter(|e| e.visible);
    let effect = effects.next()?;
    if effects.next().is_some() || effect.kind != "gaussian-blur" || effect.gradient_blur.is_some() { return None; }
    let sigma = effect.radius * matrix.max_scale();
    if sigma <= 1024. || !rectangle(n) { return None; }
    let radii = crate::effects::gaussian_box_radii_for_lattice(sigma).ok()?;
    let support = output_support(radii) + 2;
    let inv = matrix.inverse_composed(output).ok()?;
    // Tiny sine/cosine residues from cardinal imported transforms are allowed
    // only when the ignored cross term is below 2^-28 of a source texel.
    // The evaluator checks this against the actual decoded dimensions.
    if !separable(inv, output, support, [n.width, n.height], [4096, 4096]) { return None; }
    // Prove that all samples are within the rectangle. This is a read
    // footprint rather than an allocated device surface.
    let margin = support as f64;
    let x = f64::from(output.x);
    let y = f64::from(output.y);
    for x in [x - margin, x + f64::from(output.w) + margin] {
        for y in [y - margin, y + f64::from(output.h) + margin] {
            let p = inv.point(Point::new(x, y));
            if !(p.x > 0. && p.x < n.width && p.y > 0. && p.y < n.height) { return None; }
        }
    }
    Some(Plan { output, radii })
}

fn output_support(radii: [u32; 3]) -> i64 {
    radii.into_iter().map(i64::from).sum()
}

fn separable(inv: Transform, output: Rect, support: i64, size: [f64; 2], image: [u32; 2]) -> bool {
    let width = f64::from(output.w) + 2. * support as f64;
    let height = f64::from(output.h) + 2. * support as f64;
    let error_x = inv.0[2].abs() * height * f64::from(image[0]) / size[0];
    let error_y = inv.0[1].abs() * width * f64::from(image[1]) / size[1];
    error_x.max(error_y) <= 2f64.powi(-28)
}

struct BoxLattice {
    support: i64,
    normalization: f64,
    terms: [(i64, f64); 8],
}

impl BoxLattice {
    fn new(radii: [u32; 3]) -> Self {
        let widths = radii.map(|radius| 2 * i64::from(radius) + 1);
        let terms = std::array::from_fn(|mask: usize| {
            let shift = widths.into_iter().enumerate()
                .filter_map(|(index, width)| (mask & (1 << index) != 0).then_some(width))
                .sum();
            (shift, if mask.count_ones() % 2 == 0 { 1. } else { -1. })
        });
        Self {
            support: output_support(radii),
            normalization: widths.into_iter().map(|width| width as f64).product(),
            terms,
        }
    }

    // The sum of the three integer box positions has a piecewise quadratic
    // count. Its cumulative mass and first moment follow from inclusion-exclusion.
    // Like the shader, the interval here includes each discrete device sample once.
    fn before(&self, offset: i64) -> [f64; 2] {
        if offset <= -self.support { return [0., 0.]; }
        if offset > self.support { return [1., 0.]; }
        if offset > 0 {
            let [tail, moment] = self.before(1 - offset);
            return [1. - tail, moment];
        }
        let mut mass = 0.;
        let mut moment = 0.;
        for (shift, sign) in self.terms {
            let t = offset - 1 + self.support - shift;
            if t < 0 { continue; }
            let t = t as f64;
            let count = sign * (t + 1.) * (t + 2.) * (t + 3.) / (6. * self.normalization);
            mass += count;
            moment += count * ((shift - self.support) as f64 + 0.75 * t);
        }
        [mass, moment]
    }
}

struct Projection {
    origin: f64,
    step: f64,
    output_count: usize,
    texels: usize,
}

impl Projection {
    fn range(&self, support: i64) -> std::ops::Range<usize> {
        let end = self.origin + self.step * (self.output_count - 1) as f64;
        let reach = self.step.abs() * support as f64;
        let first = (self.origin.min(end) - reach).clamp(0., (self.texels - 1) as f64);
        let last = (self.origin.max(end) + reach).clamp(0., (self.texels - 1) as f64);
        first.floor() as usize..(last.ceil() as usize + 1).min(self.texels)
    }

    fn basis(&self, taps: &BoxLattice, band: std::ops::Range<usize>) -> Result<Vec<f64>, String> {
        let mut basis = Vec::with_capacity(self.output_count * band.len());
        for index in 0..self.output_count {
            crate::render_cancellation::checkpoint()?;
            let center = self.origin + self.step * index as f64;
            let step = self.step.abs();
            for texel in band.clone() {
                let weight = if self.texels == 1 {
                    1.
                } else if step == 0. {
                    1. - (center.clamp(0., (self.texels - 1) as f64) - texel as f64).abs()
                } else {
                    // A reflected image uses the same symmetric taps.
                    let at = texel as f64;
                    let boundary = |coordinate: f64| ((coordinate - center) / step).ceil()
                        .clamp(-taps.support as f64, (taps.support + 1) as f64) as i64;
                    let middle = taps.before(boundary(at));
                    let last = texel + 1 == self.texels;
                    let left = if texel == 0 {
                        middle[0]
                    } else {
                        let lo = taps.before(boundary(at - 1.));
                        (center - at + 1.) * (middle[0] - lo[0]) + step * (middle[1] - lo[1])
                    };
                    let right = if last {
                        1. - middle[0]
                    } else {
                        let hi = taps.before(boundary(at + 1.));
                        (at + 1. - center) * (hi[0] - middle[0]) - step * (hi[1] - middle[1])
                    };
                    left + right
                };
                basis.push(weight.clamp(0., 1.));
            }
        }
        Ok(basis)
    }
}

pub(crate) fn pixels(plan: Plan, matrix: Transform, size: [f64; 2], image: [u32; 2],
    paint: &Paint, pixels: &[f32]) -> Result<Vec<f32>, String> {
    let output = plan.output;
    let input_len = (image[0] as usize).checked_mul(image[1] as usize).and_then(|n| n.checked_mul(4));
    // The renderer supplies bounded output stripes. The image itself is
    // already resident, and each source axis is processed in texel batches.
    if image.contains(&0) || input_len != Some(pixels.len())
        || !size.iter().all(|v| v.is_finite() && *v > 0.)
        || !simple_paint(paint) || output.empty() || output.w.max(output.h) > 1024
        || output.pixels() > MAX_OUTPUT_PIXELS || plan.radii.contains(&0) {
        return Err("Invalid bounded image Gaussian parameters".into());
    }
    let taps = BoxLattice::new(plan.radii);
    if !separable(matrix.inverse_composed(output)?, output, taps.support, size, image) {
        return Err("Image Gaussian requires separable bounded sampling".into());
    }
    let axes = crate::paint::image_gaussian_lattice(output, matrix, size, image, paint)?;
    let [w, h] = [output.w as usize, output.h as usize];
    let [x, y] = std::array::from_fn(|index| Projection {
        origin: axes[index][0], step: axes[index][1], output_count: [w, h][index], texels: image[index] as usize,
    });
    if [&x, &y].into_iter().any(|axis| {
        let end = axis.origin + axis.step * (axis.output_count - 1) as f64;
        let reach = axis.step.abs() * taps.support as f64;
        !end.is_finite() || !reach.is_finite()
    }) {
        return Err("Invalid Gaussian image sample".into());
    }
    let xs = x.range(taps.support);
    let ys = y.range(taps.support);
    let mut result = vec![[0.; 4]; w * h];
    for y_start in ys.clone().step_by(SOURCE_TEXEL_BATCH) {
        let y_band = y_start..(y_start + SOURCE_TEXEL_BATCH).min(ys.end);
        let mut horizontal = vec![[0.; 4]; w * y_band.len()];
        for x_start in xs.clone().step_by(SOURCE_TEXEL_BATCH) {
            let x_band = x_start..(x_start + SOURCE_TEXEL_BATCH).min(xs.end);
            let weights = x.basis(&taps, x_band.clone())?;
            for (row, result_row) in y_band.clone().zip(horizontal.chunks_exact_mut(w)) {
                crate::render_cancellation::checkpoint()?;
                let base = (row * image[0] as usize + x_start) * 4;
                let texels = &pixels[base..base + 4 * x_band.len()];
                if texels.chunks_exact(4).any(|p| !p.iter().all(|x| (0. ..=1.).contains(x))
                    || p[..3].iter().any(|c| *c > p[3])) {
                    return Err("Image Gaussian requires bounded premultiplied SDR texels".into());
                }
                for (pixel, weights) in result_row.iter_mut().zip(weights.chunks_exact(x_band.len())) {
                    for (&weight, texel) in weights.iter().zip(texels.chunks_exact(4)) {
                        for channel in 0..4 { pixel[channel] += f64::from(texel[channel]) * weight; }
                    }
                }
            }
        }
        let weights = y.basis(&taps, y_band.clone())?;
        for (row, weights) in result.chunks_exact_mut(w).zip(weights.chunks_exact(y_band.len())) {
            crate::render_cancellation::checkpoint()?;
            for (&weight, stripe) in weights.iter().zip(horizontal.chunks_exact(w)) {
                for (pixel, texel) in row.iter_mut().zip(stripe) {
                    for channel in 0..4 { pixel[channel] += texel[channel] * weight; }
                }
            }
        }
    }
    Ok(result.into_iter().flatten().map(|channel| channel.clamp(0., 1.) as f32).collect())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::{blend::{Pixel, Surface}, paint::image_sampling_grid, sampling};
    use serde_json::json;

    #[test]
    fn projected_basis_matches_six_real_device_passes_with_fractional_mirrored_paint() {
        let image = [13, 9];
        let texture: Vec<f32> = (0..117u32).flat_map(|i| {
            let a = (i * 17 % 100) as f32 / 100.;
            [a, a * (i % 9) as f32 / 8., a * (i % 13) as f32 / 12., a]
        }).collect();
        let plan = Plan { output: Rect::new(-17, -9, 17, 16), radii: [2, 3, 4] };
        let matrix = Transform([-2.3, 0., 0., 1.6, 8.7, -18.9]);
        let size = [21., 19.];
        for fit in ["stretch", "cover"] {
            let paint: Paint = serde_json::from_value(json!({"kind":"image","color":"#000000","fit":fit})).unwrap();
            let source = plan.output.expand(9);
            let grid = image_sampling_grid(source, matrix, size, image, &paint, None).unwrap();
            let mut reference = Surface::new(source).unwrap();
            for (out, p) in reference.pixels.iter_mut().zip(grid.chunks_exact(4)) {
                let (x,y) = (p[0] as usize, p[1] as usize);
                let at = |dx: usize, dy: usize, ch: usize| {
                    let col = (x + dx).min(12);
                    let row = (y + dy).min(8);
                    texture[(row * 13 + col) * 4 + ch]
                };
                *out = Pixel(std::array::from_fn(|ch| sampling::bilinear(
                    [at(0,0,ch), at(1,0,ch), at(0,1,ch), at(1,1,ch)], p[2], p[3])));
            }
            // Deliberately convolve a full 2D source with the six ordinary
            // device passes; this reference does not use separable weights.
            for radius in plan.radii {
                let r = radius as i32;
                for horizontal in [true,false] {
                    let mut next = Surface::new(source).unwrap();
                    for y in source.y..source.bottom() { for x in source.x..source.right() {
                        let mut rgba = [0f64;4];
                        for d in -r..=r {
                            let p = reference.at(x + if horizontal {d} else {0}, y + if horizontal {0} else {d});
                            for c in 0..4 { rgba[c] += f64::from(p.0[c]); }
                        }
                        next.pixels[source.index(x,y).unwrap()] = Pixel(rgba.map(|v| (v / f64::from(2*r+1)) as f32));
                    }}
                    reference = next;
                }
            }
            let actual = pixels(plan, matrix, size, image, &paint, &texture).unwrap();
            for y in plan.output.y..plan.output.bottom() { for x in plan.output.x..plan.output.right() {
                let ref_pixel = reference.at(x, y);
                let at = plan.output.index(x,y).unwrap()*4;
                for c in 0..4 {
                    assert!((actual[at+c] - ref_pixel.0[c]).abs() < 0.000_002,
                        "{fit}, {x},{y} ch{c}: {:?} != {:?}", &actual[at..at+4], ref_pixel);
                }
            }}
        }
    }

    #[test]
    fn maximum_canvas_zoom_keeps_bitmap_gaussian_on_the_native_lattice() {
        let doc: Document = serde_json::from_value(json!({
            "schemaVersion": 18, "id": "d", "name": "d",
            "pages": [{"id":"p", "name":"p", "background":"#ffffff", "children":["bitmap"]}],
            "nodes": {"bitmap": {
                "id":"bitmap", "kind":"rectangle", "width":1920, "height":1080, "blend":"normal",
                "fills":[{"kind":"image", "color":"#000000", "image":"data:image/png;base64,AA==", "fit":"cover"}],
                "effects":[{"kind":"gaussian-blur", "color":"#000000", "radius":9.564871788024902}]
            }}
        })).unwrap();
        let node = &doc.nodes["bitmap"];
        let camera = Transform([-512., 0., 0., 512., 983040., 0.]);
        let output = Rect::new(282239, 451583, 17, 13);
        let plan = plan(&doc, node, camera, output).unwrap();
        assert_eq!(plan.output, output);
        assert_eq!(plan.radii, crate::effects::gaussian_box_radii_bounded(4897.21435546875, 5000.).unwrap());
        assert!(plan.radii.iter().all(|r| *r > 4096));
        let color = [0.125, 0.25, 0.375, 0.5];
        let actual = pixels(plan, camera, [1920., 1080.], [4, 3], &node.fills[0], &color.repeat(12)).unwrap();
        assert!(actual.chunks_exact(4).all(|pixel| pixel == color));
        let mut deeper = doc.clone();
        deeper.nodes.get_mut("bitmap").unwrap().effects[0].radius = 16000. / 512.;
        let node = &deeper.nodes["bitmap"];
        let wider = super::plan(&deeper, node, camera, output).unwrap();
        assert!(wider.radii.iter().all(|&radius| (15999..=16000).contains(&radius)));
        let wide_pixels = pixels(wider, camera, [1920., 1080.], [4, 3], &node.fills[0], &color.repeat(12)).unwrap();
        assert_eq!(wide_pixels, actual);
    }

    #[test]
    fn projection_accumulates_all_texel_batches() {
        let plan = Plan { output: Rect::new(510, 509, 4, 3), radii: [160, 160, 160] };
        let paint: Paint = serde_json::from_value(json!({"kind":"image","color":"#000000","fit":"stretch"})).unwrap();
        let matrix = Transform([2., 0., 0., 2., 0., 0.]);
        let color = [0.125, 0.25, 0.375, 0.5];
        let actual = pixels(plan, matrix, [512., 512.], [128, 128], &paint, &color.repeat(128 * 128)).unwrap();
        assert!(actual.chunks_exact(4).all(|pixel| pixel == color));
    }

    #[test]
    fn wide_device_crop_with_alpha_keeps_constant_rgba_without_a_full_surface() {
        let plan = Plan { output: Rect::new(-191, -231, 23, 19), radii: [2880, 2880, 2881] };
        let paint: Paint = serde_json::from_value(json!({"kind":"image","color":"#000000","fit":"stretch"})).unwrap();
        let color = [0.0625, 0.125, 0.25, 0.5];
        let actual = pixels(plan, Transform([150.6, 0., 0., -150.6, -10_000., 10_000.]),
            [140., 140.], [32, 31], &paint, &color.repeat(32*31)).unwrap();
        assert!(actual.chunks_exact(4).all(|pixel| pixel == color));
    }
}
