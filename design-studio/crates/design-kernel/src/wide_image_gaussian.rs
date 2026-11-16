//! A wide three-box Gaussian on a fully covered, separable image. The
//! device lattice stays intact: only the two axes of the bilinear source
//! basis are convolved instead of allocating the Cartesian source surface.
use crate::{math::{Point, Rect, Transform}, path::Command, scene::{Document, Node, Paint}};
use serde::{Deserialize, Serialize};

const MAX_SIGMA: f64 = 4096.;
const MAX_SOURCE_PIXELS: usize = 4_194_304;
const MAX_OUTPUT_PIXELS: usize = 524_288;
const MAX_AXIS_WORK: usize = 4_194_304;
const MAX_SOURCE_TEXELS: usize = 96;

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
    let radii = crate::effects::gaussian_box_radii_bounded(sigma, MAX_SIGMA).ok()?;
    let source = output.expand(radii.into_iter().sum::<u32>() as i32 + 2);
    if !on_lattice(source) { return None; }
    let inv = matrix.inverse_composed(source).ok()?;
    // Tiny sine/cosine residues from cardinal imported transforms are allowed
    // only when the ignored cross term is below 2^-28 *of a source texel*.
    // The evaluator checks the same bound using the actual decoded size.
    if !separable(inv, source, [n.width, n.height], [4096,4096]) { return None; }
    // Full coverage throughout all six passes. A cutout, a clipped shape
    // edge or a stroke must use the existing general raster dependency plan.
    for x in [source.x, source.right()] { for y in [source.y, source.bottom()] {
        let p = inv.point(Point::new(f64::from(x), f64::from(y)));
        if !(p.x > 0. && p.x < n.width && p.y > 0. && p.y < n.height) { return None; }
    }}
    Some(Plan { output, radii })
}

fn on_lattice(r: Rect) -> bool {
    [Some(r.x), Some(r.y), r.checked_right(), r.checked_bottom()].into_iter()
        .all(|value| value.is_some_and(|v| v.abs_diff(0) <= 1_048_576))
}

fn separable(inv: Transform, source: Rect, size: [f64; 2], image: [u32; 2]) -> bool {
    let error_x = inv.0[2].abs() * f64::from(source.h) * f64::from(image[0]) / size[0];
    let error_y = inv.0[1].abs() * f64::from(source.w) * f64::from(image[1]) / size[1];
    error_x.max(error_y) <= 2f64.powi(-28)
}

struct Basis {
    first: usize,
    count: usize,
    // For each output pixel, a compact row of weights over source texels.
    weights: Vec<f64>,
}

fn basis(positions: &[(usize, f32)], radii: [u32; 3], limit: usize) -> Result<Basis, String> {
    let first = positions.iter().map(|entry| entry.0).min().ok_or("Empty Gaussian axis")?;
    let last = positions.iter().map(|entry| (entry.0 + 1).min(limit - 1)).max().unwrap();
    let count = last - first + 1;
    if count > MAX_SOURCE_TEXELS || positions.len() * count > MAX_AXIS_WORK {
        return Err("Image Gaussian basis exceeds filter work budget".into());
    }
    let shrunk = positions.len().checked_sub(2 * radii.into_iter().sum::<u32>() as usize)
        .filter(|n| *n > 0).ok_or("Invalid Gaussian output length")?;
    let mut weights = vec![0.; shrunk * count];
    let mut prefix = vec![0.; positions.len() + 1];
    let mut line = vec![0.; positions.len()];
    for c in first..=last {
        crate::render_cancellation::checkpoint()?;
        for (v, &(at, fraction)) in line.iter_mut().zip(positions) {
            let f = f64::from(fraction);
            *v = (if at == c { 1. - f } else { 0. })
                + (if (at + 1).min(limit - 1) == c { f } else { 0. });
        }
        let mut length = line.len();
        for radius in radii {
            let diameter = 2 * radius as usize + 1;
            for i in 0..length { prefix[i + 1] = prefix[i] + line[i]; }
            length -= diameter - 1;
            for i in 0..length { line[i] = ((prefix[i + diameter] - prefix[i]) / diameter as f64).clamp(0., 1.); }
        }
        for i in 0..length { weights[i * count + c - first] = line[i]; }
    }
    Ok(Basis { first, count, weights })
}

pub(crate) fn pixels(plan: Plan, matrix: Transform, size: [f64; 2], image: [u32; 2],
    paint: &Paint, pixels: &[f32]) -> Result<Vec<f32>, String> {
    let output = plan.output;
    let input_len = (image[0] as usize).checked_mul(image[1] as usize).filter(|v| *v <= MAX_SOURCE_PIXELS);
    if image.contains(&0) || image.iter().any(|v| *v > 4096)
        || input_len.map(|n| n * 4) != Some(pixels.len())
        || !size.iter().all(|v| v.is_finite() && *v > 0.)
        || !simple_paint(paint) || output.empty() || output.w.max(output.h) > 1024
        || output.pixels() > MAX_OUTPUT_PIXELS
        || !plan.radii.iter().all(|r| (1..=MAX_SIGMA as u32).contains(r))
        || output.x.abs_diff(0) > 1_048_576 || output.y.abs_diff(0) > 1_048_576 {
        return Err("Invalid bounded image Gaussian parameters".into());
    }
    let source = output.expand(plan.radii.into_iter().sum::<u32>() as i32);
    if !on_lattice(source) || !separable(matrix.inverse_composed(source)?, source, size, image) {
        return Err("Image Gaussian requires separable bounded sampling".into());
    }
    let [xs, ys] = crate::paint::image_gaussian_axes(source, matrix, size, image, paint)?;
    let x = basis(&xs, plan.radii, image[0] as usize)?;
    let y = basis(&ys, plan.radii, image[1] as usize)?;
    let (w, h) = (output.w as usize, output.h as usize);
    let mut horizontal = vec![[0.; 4]; w * y.count];
    for row in 0..y.count {
        crate::render_cancellation::checkpoint()?;
        let base = ((y.first + row) * image[0] as usize + x.first) * 4;
        let texels = &pixels[base..base + 4 * x.count];
        if texels.chunks_exact(4).any(|p| !p.iter().all(|x| (0. ..=1.).contains(x)) || p[..3].iter().any(|c| *c > p[3])) {
            return Err("Image Gaussian requires bounded premultiplied SDR texels".into());
        }
        for (i, weights) in x.weights.chunks_exact(x.count).enumerate() {
            let mut rgba = [0.; 4];
            for (&weight, texel) in weights.iter().zip(texels.chunks_exact(4)) {
                for c in 0..4 { rgba[c] += f64::from(texel[c]) * weight; }
            }
            horizontal[row * w + i] = rgba;
        }
    }
    let mut result = vec![0.; w * h * 4];
    for (row, weights) in y.weights.chunks_exact(y.count).enumerate() {
        crate::render_cancellation::checkpoint()?;
        for col in 0..w {
            let mut rgba = [0.; 4];
            for (i, weight) in weights.iter().enumerate() {
                for c in 0..4 { rgba[c] += horizontal[i * w + col][c] * weight; }
            }
            for c in 0..4 { result[(row * w + col) * 4 + c] = rgba[c].clamp(0., 1.) as f32; }
        }
    }
    Ok(result)
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
    fn wide_device_crop_with_alpha_keeps_constant_rgba_without_a_full_surface() {
        let plan = Plan { output: Rect::new(-191, -231, 23, 19), radii: [2880, 2880, 2881] };
        let paint: Paint = serde_json::from_value(json!({"kind":"image","color":"#000000","fit":"stretch"})).unwrap();
        let color = [0.0625, 0.125, 0.25, 0.5];
        let actual = pixels(plan, Transform([150.6, 0., 0., -150.6, -10_000., 10_000.]),
            [140., 140.], [32, 31], &paint, &color.repeat(32*31)).unwrap();
        assert!(actual.chunks_exact(4).all(|pixel| pixel == color));
    }
}
