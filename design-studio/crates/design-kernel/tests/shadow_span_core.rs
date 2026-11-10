//! One exact-1 run per row uses the interval core. A hole falls back to the
//! histogram. Both must match a source-line box that never skips pixels.

use futureox_design_kernel::blend::{Pixel, Surface};
use futureox_design_kernel::effects::{gaussian_box_radii, shadow};
use futureox_design_kernel::math::Rect;
use futureox_design_kernel::sampling::bilinear;

fn source_line_pass(alpha: &[f32], w: usize, h: usize, r: i32, horizontal: bool) -> Vec<f32> {
    let mut out = alpha.to_vec();
    let (lines, len) = if horizontal { (h as i32, w as i32) } else { (w as i32, h as i32) };
    let denominator = f64::from(2 * r + 1);
    for line in 0..lines {
        let mut source = vec![0_f32; len as usize];
        for at in 0..len as usize {
            source[at] = if horizontal { alpha[line as usize * w + at] } else { alpha[at * w + line as usize] };
        }
        let at_src = |at: i32| if at >= 0 && (at as usize) < source.len() { source[at as usize] } else { 0. };
        let mut sum = 0_f64;
        for k in -r..=r { sum += f64::from(at_src(k)); }
        for at in 0..len {
            let index = if horizontal { line as usize * w + at as usize } else { at as usize * w + line as usize };
            out[index] = if sum == 0. { 0. } else { (sum / denominator).clamp(0., 1.) as f32 };
            sum += f64::from(at_src(at + r + 1));
            sum -= f64::from(at_src(at - r));
        }
    }
    out
}

fn reference(source: &Surface, color: Pixel, sigma: f64, dx: f64, dy: f64) -> Surface {
    let w = source.rect.w as usize;
    let h = source.rect.h as usize;
    let mut alpha: Vec<f32> = source.pixels.iter().map(|p| p.0[3]).collect();
    for radius in gaussian_box_radii(sigma).unwrap() {
        if radius == 0 { continue; }
        alpha = source_line_pass(&alpha, w, h, radius as i32, true);
        alpha = source_line_pass(&alpha, w, h, radius as i32, false);
    }
    let mut out = Surface::new(source.rect).unwrap();
    let sample = |x: i32, y: i32| source.rect.index(x, y).map(|i| alpha[i]).unwrap_or(0.);
    for (i, pixel) in out.pixels.iter_mut().enumerate() {
        let x = source.rect.x + (i % w) as i32;
        let y = source.rect.y + (i / w) as i32;
        let (sx, sy) = (f64::from(x) - dx, f64::from(y) - dy);
        let (ix, iy) = (sx.floor() as i32, sy.floor() as i32);
        let (u, v) = ((sx - sx.floor()) as f32, (sy - sy.floor()) as f32);
        let b = bilinear([sample(ix, iy), sample(ix + 1, iy), sample(ix, iy + 1), sample(ix + 1, iy + 1)], u, v);
        *pixel = color.opacity(b);
    }
    out
}

fn assert_shadow(source: &Surface, sigma: f64) {
    let color = Pixel::rgba(0.15, 0.4, 0.7, 0.5);
    let actual = shadow(source, color, sigma, 0., 0., 2.5, false).unwrap();
    let expected = reference(source, color, sigma, 0., 2.5);
    for (i, (a, b)) in actual.pixels.iter().zip(&expected.pixels).enumerate() {
        assert_eq!(a.0.map(f32::to_bits), b.0.map(f32::to_bits), "pixel {i} sigma={sigma}");
    }
}

#[test]
fn span_core_and_histogram_fallback_match_the_full_box() {
    let mut rect = Surface::new(Rect::new(-3, 4, 200, 160)).unwrap();
    for y in 0..160 {
        for x in 0..200 {
            let alpha = if (6..194).contains(&x) && (6..154).contains(&y) { 1. } else { (x + y) as f32 / 400. };
            rect.pixels[y * 200 + x] = Pixel([0.2, 0.2, 0.2, alpha]);
        }
    }
    assert_shadow(&rect, 2.5);

    let mut ellipse = Surface::new(Rect::new(0, 0, 180, 150)).unwrap();
    for y in 0..150 {
        for x in 0..180 {
            let dx = (x as f64 - 90.) / 70.;
            let dy = (y as f64 - 75.) / 55.;
            let alpha = if dx * dx + dy * dy <= 1. { 1. } else { 0.05 };
            ellipse.pixels[y * 180 + x] = Pixel([0., 0., 0., alpha]);
        }
    }
    assert_shadow(&ellipse, 1.75);

    let mut hole = Surface::new(Rect::new(0, 0, 180, 150)).unwrap();
    for y in 0..150 {
        for x in 0..180 {
            let alpha = if (8..172).contains(&x) && (8..142).contains(&y) && !(70..110).contains(&x) { 1. } else { 0. };
            hole.pixels[y * 180 + x] = Pixel([0., 0., 0., alpha]);
        }
    }
    assert_shadow(&hole, 1.25);
}

#[test]
fn public_shadow_returns_shadow_color_under_an_opaque_source() {
    let mut source = Surface::new(Rect::new(0, 0, 1, 1)).unwrap();
    source.pixels[0] = Pixel::rgba(0.2, 0.2, 0.2, 1.);
    let color = Pixel::rgba(0.15, 0.4, 0.7, 0.5);
    let output = shadow(&source, color, 0., 0., 0., 0., false).unwrap();
    assert_eq!(output.pixels[0].0.map(f32::to_bits), color.0.map(f32::to_bits));
}
