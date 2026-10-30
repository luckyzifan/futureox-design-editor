use futureox_design_kernel::{
    math::{Rect, Transform},
    paint::image_sampling_grid,
    scene::Paint,
};
use serde_json::json;
fn paint(fit: &str) -> Paint {
    serde_json::from_value(json!({"kind":"image","fit":fit,"color":"#000000"})).unwrap()
}
#[test]
fn contain_preserves_transparent_margins_and_clamped_texel_centers() {
    let grid = image_sampling_grid(
        Rect::new(0, 0, 8, 4),
        Transform::default(),
        [8., 4.],
        [4, 4],
        &paint("contain"),
        None,
    )
    .unwrap();
    let address = |x: usize, y: usize| &grid[(y * 8 + x) * 4..(y * 8 + x + 1) * 4];
    for y in 0..4 {
        for x in [0, 1, 6, 7] {
            assert_eq!(address(x, y), &[-2., -2., 0., 0.]);
        }
    }
    assert_eq!(address(2, 1), &[0., 1., 0., 0.]);
    assert_eq!(address(5, 1), &[3., 1., 0., 0.]);
    let stretch = image_sampling_grid(
        Rect::new(0, 0, 8, 4),
        Transform::default(),
        [8., 4.],
        [4, 4],
        &paint("stretch"),
        None,
    )
    .unwrap();
    assert_eq!(&stretch[(8 + 1) * 4..(8 + 2) * 4], &[0., 1., 0.25, 0.]);
}
#[test]
fn each_correlated_sample_keeps_its_own_address_and_invalid_geometry_is_rejected() {
    let mut addresses = Vec::new();
    for sample in 0..4 {
        let grid = image_sampling_grid(
            Rect::new(1, 1, 1, 1),
            Transform::default(),
            [4., 4.],
            [4, 4],
            &paint("stretch"),
            Some(sample),
        )
        .unwrap();
        addresses.push(grid);
    }
    assert_eq!(
        addresses,
        vec![
            vec![0., 0., 0.875, 0.625],
            vec![1., 0., 0.375, 0.875],
            vec![0., 1., 0.625, 0.125],
            vec![1., 1., 0.125, 0.375]
        ]
    );
    for (size, image, sample) in [
        ([0., 4.], [4, 4], None),
        ([4., 4.], [0, 4], None),
        ([4., 4.], [4, 4], Some(4)),
    ] {
        assert!(
            image_sampling_grid(
                Rect::new(0, 0, 1, 1),
                Transform::default(),
                size,
                image,
                &paint("cover"),
                sample
            )
            .is_err()
        );
    }
    assert!(
        image_sampling_grid(
            Rect::new(0, 0, 4097, 4097),
            Transform::default(),
            [4., 4.],
            [4, 4],
            &paint("cover"),
            None
        )
        .unwrap_err()
        .contains("64 MiB")
    );
}

#[test]
fn byte_grid_preserves_first_centre_binary64_rounding_at_fractional_image_ties() {
    use futureox_design_kernel::paint::image_byte_sampling_grid;
    // Actual first mismatching output (12,102) at zoom1.25, with four sample
    // planes and 2x export. The old GPU local f32 path shifted every address.
    // Independent CPU/real-GPU diagnostic recorded these CPU f32 bits before
    // this shared field existed; no pixel colour is stored in the field.
    let expected = [
        [0x3fad3a07, 0x400253c8],
        [0x3fb0a3d7, 0x40037dac],
        [0x3fab851f, 0x4004a790],
        [0x3faeeeef, 0x4005d174],
    ];
    for (sample, expected) in expected.into_iter().enumerate() {
        let grid = image_byte_sampling_grid(
            Rect::new(24, 204, 2, 2),
            Transform([2.5, 0., 0., 2.5, -10.375, 169.25]),
            [30., 22.],
            [4, 4],
            &paint("stretch"),
            Some(sample),
        )
        .unwrap();
        assert_eq!([grid[0].to_bits(), grid[1].to_bits()], expected);
        assert_eq!(&grid[2..4], &[1., 0.]);
        assert_eq!(grid.len(), 16);
    }
}

#[test]
fn byte_grid_contains_clamps_and_bounds_its_metadata_allocation() {
    use futureox_design_kernel::paint::image_byte_sampling_grid;
    let grid = image_byte_sampling_grid(
        Rect::new(0, 0, 8, 4),
        Transform::default(),
        [8., 4.],
        [4, 4],
        &paint("contain"),
        None,
    )
    .unwrap();
    for y in 0..4 {
        for x in [0, 1, 6, 7] {
            assert_eq!(
                &grid[(y * 8 + x) * 4..(y * 8 + x + 1) * 4],
                &[0., 0., 0., 0.]
            );
        }
    }
    assert_eq!(&grid[(8 + 2) * 4..(8 + 3) * 4], &[0., 1., 1., 0.]);
    assert_eq!(&grid[(8 + 5) * 4..(8 + 6) * 4], &[3., 1., 1., 0.]);
    for (size, image, sample) in [
        ([0., 4.], [4, 4], None),
        ([4., 4.], [0, 4], None),
        ([4., 4.], [4, 4], Some(4)),
    ] {
        assert!(
            image_byte_sampling_grid(
                Rect::new(0, 0, 1, 1),
                Transform::default(),
                size,
                image,
                &paint("cover"),
                sample
            )
            .is_err()
        );
    }
    assert!(
        image_byte_sampling_grid(
            Rect::new(0, 0, 4097, 4097),
            Transform::default(),
            [4., 4.],
            [4, 4],
            &paint("cover"),
            None
        )
        .unwrap_err()
        .contains("64 MiB")
    );
}

#[test]
fn separated_byte_fields_equal_full_grid_bits_for_all_sample_phases() {
    use futureox_design_kernel::paint::{image_byte_sampling_field, image_byte_sampling_grid};
    let mut checked = 0usize;
    let mut separated = 0usize;
    for bounds in [
        Rect::new(-13, -19, 43, 37),
        Rect::new(0, 0, 32, 16),
        Rect::new(-32, -16, 31, 15),
    ] {
        for matrix in [
            Transform::default(),
            Transform([2.5, 0., 0., 1.25, -10.375, 9.25]),
            Transform([-1.25, 0., 0., 0.75, 7.375, -2.625]),
        ] {
            for transform in [None, Some(Transform([-0.9, 0., 0., 1.12, 0.07, -0.03]))] {
                for fit in ["stretch", "contain", "cover"] {
                    for image in [[1, 1], [4, 4], [7, 11]] {
                        let mut p = paint(fit);
                        p.transform = transform;
                        let mut layout = None;
                        for sample in [Some(0), Some(1), Some(2), Some(3), None] {
                            let dense = image_byte_sampling_grid(
                                bounds,
                                matrix,
                                [32., 16.],
                                image,
                                &p,
                                sample,
                            )
                            .unwrap();
                            let field = image_byte_sampling_field(
                                bounds,
                                matrix,
                                [32., 16.],
                                image,
                                &p,
                                sample,
                            )
                            .unwrap();
                            let compact = field[3] == 1.;
                            assert_eq!(
                                *layout.get_or_insert(compact),
                                compact,
                                "sample phase changed field layout"
                            );
                            if compact {
                                separated += 1;
                            }
                            let span = bounds.w.max(bounds.h) as usize;
                            for y in 0..bounds.h as usize {
                                for x in 0..bounds.w as usize {
                                    let d = &dense[(y * bounds.w as usize + x) * 4..][..4];
                                    let q = if compact {
                                        [
                                            field[x * 4],
                                            field[(span + y) * 4],
                                            field[x * 4 + 2] * field[(span + y) * 4 + 2],
                                            0.,
                                        ]
                                    } else {
                                        field[(y * bounds.w as usize + x) * 4..][..4]
                                            .try_into()
                                            .unwrap()
                                    };
                                    assert_eq!(q[2].to_bits(), d[2].to_bits());
                                    if q[2] == 1. {
                                        assert_eq!(
                                            [q[0].to_bits(), q[1].to_bits()],
                                            [d[0].to_bits(), d[1].to_bits()]
                                        );
                                    }
                                    checked += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    assert!(separated > 0);
    println!("full-grid bit comparisons={checked}, separated fields={separated}");
}

#[test]
fn crossed_axes_and_uncertain_zero_use_dense_fields_and_oversize_is_rejected() {
    use futureox_design_kernel::paint::{image_byte_sampling_field, image_byte_sampling_grid};
    let bounds = Rect::new(-5, -7, 20, 19);
    for (matrix, transform) in [
        (Transform([1., 0.2, -0.1, 1., 0., 0.]), None),
        (
            Transform::default(),
            Some(Transform([1., 0.1, -0.1, 1., 0., 0.])),
        ),
        // One paint-axis input is exactly zero for a sample. All phases must
        // select the dense layout so a reused native texture keeps its shape.
        (
            Transform([1., 0., 0., 1., 0.375, 0.125]),
            Some(Transform::default()),
        ),
    ] {
        let mut p = paint("contain");
        p.transform = transform;
        for sample in [Some(0), Some(1), Some(2), Some(3), None] {
            let dense =
                image_byte_sampling_grid(bounds, matrix, [8., 8.], [4, 4], &p, sample).unwrap();
            let field =
                image_byte_sampling_field(bounds, matrix, [8., 8.], [4, 4], &p, sample).unwrap();
            assert_eq!(
                field.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                dense.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
            );
        }
    }
    assert!(
        image_byte_sampling_field(
            Rect::new(0, 0, 2_097_153, 3),
            Transform::default(),
            [4., 4.],
            [4, 4],
            &paint("cover"),
            None
        )
        .unwrap_err()
        .contains("64 MiB")
    );
    assert!(
        image_byte_sampling_field(
            Rect::new(i32::MAX - 1, 0, 4, 4),
            Transform::default(),
            [4., 4.],
            [4, 4],
            &paint("cover"),
            None
        )
        .unwrap_err()
        .contains("integer range")
    );
}
