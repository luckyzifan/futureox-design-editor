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
fn texture_sampling_stays_inside_texels_the_shape_already_painted() {
    let mut source = Surface::new(Rect::new(0, 0, 24, 24)).unwrap();
    for y in 6..18 {
        for x in 6..18 {
            source.pixels[(y * 24 + x) as usize] = Pixel::rgba(0.15, 0.45, 0.8, 1.);
        }
    }
    let amount = 4.;
    let matrix = Transform::default();
    for linear in [false, true] {
        let out = if linear {
            effects::texture_linear(&source, amount, matrix).unwrap()
        } else {
            effects::texture(&source, amount, matrix).unwrap()
        };
        let mut spilled_lookup = 0;
        for y in 0..24 {
            for x in 0..24 {
                let index = (y * 24 + x) as usize;
                if source.pixels[index].0[3] > 0. {
                    continue;
                }
                assert_eq!(out.pixels[index], source.pixels[index], "linear={linear} at {x},{y}");
                let dx = (f64::from(effects::noise(x, y, 13)) - 0.5) * amount;
                let dy = (f64::from(effects::noise(x, y, 29)) - 0.5) * amount;
                let sx = f64::from(x) + 0.5 + dx;
                let sy = f64::from(y) + 0.5 + dy;
                let sample = if linear {
                    source.sample_linear(sx, sy)
                } else {
                    source.sample(sx, sy)
                };
                if sample.0[3] > 0. {
                    spilled_lookup += 1;
                }
            }
        }
        assert!(
            spilled_lookup > 0,
            "linear={linear}: the guard must reject a lookup that used to paint empty texels"
        );
        assert!(
            out.pixels
                .iter()
                .zip(&source.pixels)
                .any(|(after, before)| after.0 != before.0),
            "linear={linear}: covered texels must still be displaced"
        );
    }
    let grid = effects::texture_sampling_grid(source.rect, amount, matrix).unwrap();
    let actual = effects::texture_linear(&source, amount, matrix).unwrap();
    for (index, g) in grid.chunks_exact(4).enumerate() {
        if source.pixels[index].0[3] <= 0. {
            assert_eq!(actual.pixels[index], source.pixels[index]);
            continue;
        }
        let x = g[0] as i32 + source.rect.x;
        let y = g[1] as i32 + source.rect.y;
        let ps = [
            source.at(x, y),
            source.at(x + 1, y),
            source.at(x, y + 1),
            source.at(x + 1, y + 1),
        ];
        let alpha = sampling::bilinear(ps.map(|p| p.0[3]), g[2], g[3]);
        for c in 0..4 {
            let shifted = sampling::bilinear(ps.map(|p| p.0[c]), g[2], g[3]);
            // The fixture is fully opaque wherever it is painted. The missing
            // weight from transparent neighbours comes from the destination.
            let reconstructed = shifted + source.pixels[index].0[c] * (1. - alpha);
            assert_eq!(
                actual.pixels[index].0[c].to_bits(),
                reconstructed.to_bits(),
                "covered texel {index} channel {c}"
            );
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
