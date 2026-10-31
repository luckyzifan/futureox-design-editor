use futureox_design_kernel::{math::{Rect, Transform}, paint::{image_sampling_axes_placed, image_sampling_grid_placed}, scene::Paint};

fn compare(rect: Rect, matrix: Transform, size: [f64; 2], image: [u32; 2], paint: &Paint, sample: Option<usize>, level: u32, origin: [i32; 2]) -> bool {
    let compact = image_sampling_axes_placed(rect, matrix, size, image, paint, sample, level, origin).unwrap();
    if compact.is_empty() { return false; }
    let dense = image_sampling_grid_placed(rect, matrix, size, image, paint, sample, level, origin).unwrap();
    let span = rect.w.max(rect.h) as usize;
    assert_eq!(compact.len(), span * 8);
    for y in 0..rect.h as usize { for x in 0..rect.w as usize {
        let a = &compact[x * 4..x * 4 + 4]; let b = &compact[(span + y) * 4..(span + y) * 4 + 4];
        assert_eq!(a[3], -1.); assert_eq!(b[3], -1.);
        let actual = if a[2] == 0. || b[2] == 0. { [-2., -2., 0., 0.] } else { [a[0], b[0], a[1], b[1]] };
        let start = (y * rect.w as usize + x) * 4;
        assert_eq!(actual.map(f32::to_bits), dense[start..start + 4].iter().map(|v| v.to_bits()).collect::<Vec<_>>().as_slice(), "x={x}, y={y}, sample={sample:?}, fit={}", paint.fit);
    }}
    true
}

#[test]
fn compact_linear_axes_equal_dense_bits_across_fits_phases_mips_and_placements() {
    let mut used = 0;
    for fit in ["cover", "contain", "stretch"] {
        for matrix in [Transform([1., 0., 0., 1., 0.25, -0.5]), Transform([2.5, 0., 0., 0.75, -7., 11.]), Transform([-0.75, 0., 0., 1.5, 10., -3.])] {
            for transform in [None, Some(Transform([0.7, 0., 0., -1.1, 0.2, 0.4]))] {
                let mut paint: Paint = serde_json::from_value(serde_json::json!({"kind":"image", "color":"#ffffff", "fit":fit})).unwrap();
                paint.transform = transform;
                for sample in [None, Some(0), Some(1), Some(2), Some(3)] { for level in [0, 1, 3] { for origin in [[0, 0], [9, 17]] {
                    used += usize::from(compare(Rect::new(-7, 11, 21, 17), matrix, [31., 19.], [11, 7], &paint, sample, level, origin));
                }}}
            }
        }
    }
    assert!(used > 200, "proof must actually exercise compact axes");
}

#[test]
fn contain_invalid_other_axis_preserves_useful_coordinates_and_coupled_samples_fall_back() {
    let paint: Paint = serde_json::from_value(serde_json::json!({"kind":"image", "color":"#ffffff", "fit":"contain"})).unwrap();
    assert!(compare(Rect::new(-3, -3, 16, 56), Transform::default(), [10., 50.], [40, 10], &paint, None, 0, [7, 13]));
    let stretch: Paint = serde_json::from_value(serde_json::json!({"kind":"image", "color":"#ffffff", "fit":"stretch"})).unwrap();
    assert!(image_sampling_axes_placed(Rect::new(0, 0, 20, 20), Transform([1., 0.25, 0., 1., 0., 0.]), [20., 20.], [40, 40], &stretch, None, 0, [0, 0]).unwrap().is_empty());
    assert!(image_sampling_axes_placed(Rect::new(i32::MAX, 0, 20, 20), Transform::default(), [10., 50.], [40, 10], &paint, None, 0, [0, 0]).is_err());
}

#[test]
fn one_texel_contain_margins_cannot_hide_a_valid_interior_between_invalid_ends() {
    let paint: Paint = serde_json::from_value(serde_json::json!({"kind":"image", "color":"#ffffff", "fit":"contain"})).unwrap();
    let rect = Rect::new(-2, -2, 5, 5); let matrix = Transform([1., 0.25, 0.25, 1., 0., 0.]);
    let dense = image_sampling_grid_placed(rect, matrix, [1., 1.], [1, 1], &paint, None, 0, [0, 0]).unwrap();
    assert!(dense.chunks_exact(4).any(|v| v[0] == 0.));
    assert!(dense.chunks_exact(4).any(|v| v[0] == -2.));
    assert!(image_sampling_axes_placed(rect, matrix, [1., 1.], [1, 1], &paint, None, 0, [0, 0]).unwrap().is_empty());
}

#[test]
fn imported_reflection_residual_is_certified_without_rounding_the_transform() {
    let paint: Paint = serde_json::from_value(serde_json::json!({"kind":"image", "color":"#ffffff", "fit":"cover"})).unwrap();
    let matrix = Transform([-1., -2.4492935982947064e-16, -2.4492935982947064e-16, 1., 10., 0.]);
    for sample in [None, Some(0), Some(1), Some(2), Some(3)] {
        assert!(compare(Rect::new(-7, 11, 21, 17), matrix, [31., 19.], [11, 7], &paint, sample, 0, [9, 17]));
    }
}

#[test]
fn each_phase_certifies_its_own_cells_without_requiring_the_other_phases() {
    let paint: Paint = serde_json::from_value(serde_json::json!({"kind":"image", "color":"#ffffff", "fit":"stretch"})).unwrap();
    // Tiny coupling changes cell ownership only for the centre phase at an
    // integer boundary. The four subpixel phases have stable endpoint bits.
    // Their compact representation must remain exact even when the centre
    // phase independently uses a dense field.
    let rect = Rect::new(1, -1, 5, 5);
    let matrix = Transform([1., 0., 1e-10, 1., 0., 0.]);
    for sample in 0..4 {
        assert!(compare(rect, matrix, [32., 32.], [32, 32], &paint, Some(sample), 0, [9, 17]));
    }
    assert!(image_sampling_axes_placed(rect, matrix, [32., 32.], [32, 32], &paint, None, 0, [9, 17]).unwrap().is_empty());
    let dense = image_sampling_grid_placed(rect, matrix, [32., 32.], [32, 32], &paint, None, 0, [9, 17]).unwrap();
    assert_ne!(dense[0], dense[(rect.h as usize - 1) * rect.w as usize * 4], "the failed centre proof must not be replaced with a reused subpixel plane");
}

#[test]
fn full_rotation_residual_preserves_dense_bits_at_large_zoom_and_strip_origins() {
    let paint: Paint = serde_json::from_value(serde_json::json!({"kind":"image", "color":"#ffffff", "fit":"cover"})).unwrap();
    let angle = 360f64.to_radians();
    let scale = 128.;
    let matrix = Transform([scale * angle.cos(), scale * angle.sin(), -scale * angle.sin(), scale * angle.cos(), -1123.25, 27.5]);
    assert_ne!(matrix.0[1], 0., "keep the authored full-rotation residual");
    let mut used = 0;
    // The 117 trace builds 3480-wide strips for the blur support region.
    // Cover both far-offscreen clamping and visible interior coordinates.
    for y in [-1281, -1, 63, 127, 1983] {
        for sample in [None, Some(0), Some(1), Some(2), Some(3)] {
            used += usize::from(compare(Rect::new(-1279, y, 3480, 64), matrix, [1920., 1080.], [1920, 1080], &paint, sample, 0, [9, 17]));
        }
    }
    assert!(used >= 20, "large-zoom coverage must exercise compact fields, not only early fallback");
}
