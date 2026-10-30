//! Exact byte oracle for the contained-row Surface::rgba8 optimization.
use futureox_design_kernel::{
    blend::{Pixel, Surface},
    math::Rect,
};
use std::panic::{AssertUnwindSafe, catch_unwind};

// Preserve the original implementation independently of the optimized loop.
fn reference(surface: &Surface, crop: Rect) -> Vec<u8> {
    let mut out = Vec::with_capacity(crop.pixels() * 4);
    for y in crop.y..crop.bottom() {
        for x in crop.x..crop.right() {
            let p = surface.at(x, y);
            out.extend(p.straight_rgba8());
        }
    }
    out
}

fn compare(surface: &Surface, crop: Rect) {
    let expected = catch_unwind(AssertUnwindSafe(|| reference(surface, crop)));
    let actual = catch_unwind(AssertUnwindSafe(|| surface.rgba8(crop)));
    match (expected, actual) {
        (Ok(expected), Ok(actual)) => assert_eq!(actual, expected, "crop={crop:?}"),
        (Err(_), Err(_)) => {}
        _ => panic!("conversion success/panic changed for crop={crop:?}"),
    }
}

#[test]
fn contained_rows_and_outside_crops_match_original_coordinates() {
    for rect in [Rect::new(0, 0, 7, 5), Rect::new(-9, -6, 7, 5)] {
        let mut surface = Surface::new(rect).unwrap();
        for (i, pixel) in surface.pixels.iter_mut().enumerate() {
            *pixel = Pixel::rgba(i as f32 / 37., 0.73, 0.19, (i % 9) as f32 / 8.);
        }
        // Includes all edge/corner crossings, touches, empty crops, wholly
        // outside crops, full surface, interior rows and narrow/tall strips.
        for y in rect.y - 2..=rect.bottom() + 1 {
            for x in rect.x - 2..=rect.right() + 1 {
                for w in [0, 1, 3, 7, 10] {
                    for h in [0, 1, 2, 5, 8] {
                        compare(&surface, Rect::new(x, y, w, h));
                    }
                }
            }
        }
    }
}

#[test]
fn alpha_threshold_extended_values_and_rounding_boundaries_match() {
    let threshold = 1e-10_f32;
    let alphas = [
        -1.,
        -0.,
        0.,
        f32::from_bits(1),
        f32::from_bits(threshold.to_bits() - 1),
        threshold,
        f32::from_bits(threshold.to_bits() + 1),
        0.125,
        0.5,
        f32::from_bits(1_f32.to_bits() - 1),
        1.,
        f32::from_bits(1_f32.to_bits() + 1),
        2.,
        f32::NEG_INFINITY,
        f32::INFINITY,
        f32::NAN,
    ];
    let mut surface = Surface::new(Rect::new(-3, 7, 768, alphas.len() as u32)).unwrap();
    for (row, alpha) in alphas.into_iter().enumerate() {
        for byte in 0..256 {
            let half = (byte as f32 + 0.5) / 255.;
            for (delta, value) in [
                f32::from_bits(half.to_bits() - 1),
                half,
                f32::from_bits(half.to_bits() + 1),
            ]
            .into_iter()
            .enumerate()
            {
                surface.pixels[row * 768 + byte * 3 + delta] =
                    Pixel([value * alpha, -value, value * 2., alpha]);
            }
        }
    }
    compare(&surface, surface.rect);
    compare(&surface, Rect::new(-2, 8, 765, 13));
}

#[test]
fn deterministic_float_bit_patterns_match_original_bytes() {
    let mut surface = Surface::new(Rect::new(-11, -13, 257, 17)).unwrap();
    let mut state = 0x921d_3a47_u32;
    for pixel in &mut surface.pixels {
        for channel in &mut pixel.0 {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            *channel = f32::from_bits(state);
        }
    }
    compare(&surface, surface.rect);
    compare(&surface, Rect::new(-10, -12, 255, 15));
    compare(&surface, Rect::new(-12, -14, 259, 19));
}

#[test]
fn empty_and_malformed_storage_keeps_original_fallback() {
    for rect in [Rect::new(0, 0, 0, 3), Rect::new(-2, 3, 4, 0)] {
        let surface = Surface::new(rect).unwrap();
        compare(&surface, rect);
        compare(&surface, Rect::new(-3, -3, 8, 8));
    }
    let mut surface = Surface::new(Rect::new(0, 0, 3, 2)).unwrap();
    surface.pixels.pop();
    compare(&surface, Rect::new(0, 0, 3, 1));
    compare(&surface, surface.rect);
    surface.pixels.extend([Pixel::default(); 2]);
    compare(&surface, surface.rect);
}

#[test]
fn extreme_rectangle_endpoints_keep_original_fallback_behavior() {
    let mut surface = Surface::new(Rect::new(0, 0, 1, 1)).unwrap();
    for rect in [
        Rect::new(i32::MAX, 0, 1, 1),
        Rect::new(0, i32::MAX, 1, 1),
        Rect::new(i32::MIN, i32::MIN, 1, 1),
        Rect::new(0, 0, u32::MAX, 0),
        Rect::new(0, 0, 0, u32::MAX),
    ] {
        surface.rect = rect;
        compare(&surface, Rect::new(0, 0, 1, 1));
        // Keep allocated output bounded while exercising endpoint overflow.
        if rect.w <= 1 && rect.h <= 1 {
            compare(&surface, rect);
        }
    }
}
