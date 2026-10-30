use futureox_design_kernel::{
    blend::{Pixel, Surface},
    effects,
    math::{Rect, Transform},
    sampling,
};

#[test]
fn address_field_preserves_binary64_cell_selection_and_separate_fraction_bits() {
    let mut source = Surface::new(Rect::new(-3, 5, 19, 13)).unwrap();
    for (i, p) in source.pixels.iter_mut().enumerate() {
        *p = Pixel([i as f32 / 37. - 2., 0.43123, (i % 11) as f32 / 13., 0.73]);
    }
    for matrix in [
        Transform::default(),
        Transform([1., 0., 0., 1., 0.50000001, -0.50000001]),
        Transform([
            0.9205048534524404,
            0.39073112848927377,
            -0.39073112848927377,
            0.9205048534524404,
            2.125,
            -1.375,
        ]),
        Transform([-1., 0.25, 0.37, 0.83, 7., -2.]),
    ] {
        for amount in [0.0000001, 0.42, 7., 256.] {
            let grid = effects::texture_sampling_grid(source.rect, amount, matrix).unwrap();
            let actual = effects::texture_linear(&source, amount, matrix).unwrap();
            for (index, g) in grid.chunks_exact(4).enumerate() {
                let x = g[0] as i32 + source.rect.x;
                let y = g[1] as i32 + source.rect.y;
                let ps = [
                    source.at(x, y),
                    source.at(x + 1, y),
                    source.at(x, y + 1),
                    source.at(x + 1, y + 1),
                ];
                for c in 0..4 {
                    let reconstructed = sampling::bilinear(ps.map(|p| p.0[c]), g[2], g[3]);
                    assert_eq!(
                        actual.pixels[index].0[c].to_bits(),
                        reconstructed.to_bits(),
                        "{matrix:?} amount {amount}, texel {index} channel {c}"
                    );
                }
            }
        }
    }
}

#[test]
fn coordinate_fields_are_bounded_and_reject_nonfinite_inputs() {
    assert!(
        effects::texture_sampling_grid(Rect::new(0, 0, 100_000, 100_000), 1., Transform::default())
            .is_err()
    );
    assert!(
        effects::texture_sampling_grid(Rect::new(0, 0, 2, 2), f64::NAN, Transform::default())
            .is_err()
    );
    assert!(effects::texture_sampling_grid(Rect::new(0, 0, 2, 2), 1., Transform([0.; 6])).is_err());
}
