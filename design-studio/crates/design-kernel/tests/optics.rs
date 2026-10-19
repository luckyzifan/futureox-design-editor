use futureox_design_kernel::{
    blend::{Pixel, Surface},
    math::{Rect, Transform},
    optics::{GlassShape, field, render},
    scene::GlassParameters,
};

fn glass() -> GlassParameters {
    GlassParameters {
        bevel_size: None,
        depth: 8.,
        refraction: 0.5,
        dispersion: 0.5,
        light_angle: 30.,
        light_intensity: 0.75,
    }
}
fn shape() -> GlassShape {
    GlassShape {
        size: [96., 96.],
        radius: 16.,
    }
}

#[test]
fn bevel_default_is_compatible_and_custom_width_changes_the_optical_field() {
    let rect = Rect::new(0, 0, 96, 96);
    let original = glass();
    let implicit = field(rect, shape(), Transform::default(), &original, None).unwrap();
    let mut changed = original.clone();
    changed.bevel_size = Some(1.);
    assert_eq!(implicit, field(rect, shape(), Transform::default(), &changed, None).unwrap());
    changed.bevel_size = Some(3.);
    let wide = field(rect, shape(), Transform::default(), &changed, None).unwrap();
    assert_ne!(implicit, wide);
    assert!(wide.iter().all(|v| v.is_finite()));
    let stored = serde_json::to_string(&changed).unwrap();
    assert_eq!(serde_json::from_str::<GlassParameters>(&stored).unwrap(), changed);
}

#[test]
fn continuous_glass_fields_keep_the_same_phase_across_tiles() {
    let whole = Rect::new(0, 0, 128, 128);
    let matrix = Transform([1., 0., 0., 1., 16.125, 16.375]);
    for sample in [None, Some(0), Some(1), Some(2), Some(3)] {
        let full = field(whole, shape(), matrix, &glass(), sample).unwrap();
        for rect in [Rect::new(0, 0, 63, 128), Rect::new(63, 0, 65, 128)] {
            let tile = field(rect, shape(), matrix, &glass(), sample).unwrap();
            for y in rect.y..rect.bottom() {
                for x in rect.x..rect.right() {
                    let a = whole.index(x, y).unwrap() * 4;
                    let b = rect.index(x, y).unwrap() * 4;
                    assert_eq!(&full[a..a + 4], &tile[b..b + 4]);
                }
            }
        }
    }
}

#[test]
fn zero_refraction_has_zero_displacement_but_retains_dispersion_arithmetic() {
    let rect = Rect::new(0, 0, 2, 2);
    let mut g = glass();
    g.refraction = 0.;
    g.light_intensity = 0.;
    g.dispersion = 1.;
    let parameters = field(rect, shape(), Transform::default(), &g, Some(0)).unwrap();
    assert!(parameters.chunks_exact(4).all(|p| p[0] == 0. && p[1] == 0.));
    let mut source = Surface::new(rect).unwrap();
    for (pixel, byte) in source.pixels.iter_mut().zip([2., 1., 1., 0.]) {
        *pixel = Pixel::rgba(byte / 255., byte / 255., byte / 255., 1.);
    }
    // Rotated sample zero has weights [3,21,5,35]/64 here, yielding a
    // Q4 half-byte. Native eight-tap arithmetic crosses its UNORM rounding
    // boundary even with identical rays: geometrical identity is insufficient.
    g.dispersion = 0.;
    let single = render(&source, shape(), Transform::default(), &g, Some(0), false).unwrap();
    g.dispersion = 1.;
    let multiple = render(&source, shape(), Transform::default(), &g, Some(0), false).unwrap();
    assert_eq!(single.at(1, 1).0[0], 1. / 255.);
    assert_eq!(multiple.at(1, 1).0[0], 0.);
}

#[test]
fn illumination_is_additive_and_does_not_change_alpha() {
    let rect = Rect::new(0, 0, 96, 96);
    let mut a = Surface::new(rect).unwrap();
    a.pixels.fill(Pixel([0.125, 0.125, 0.125, 1.]));
    let mut b = a.try_clone().unwrap();
    b.pixels.fill(Pixel([0.25, 0.25, 0.25, 1.]));
    let mut g = glass();
    g.refraction = 0.;
    g.dispersion = 0.;
    let a = render(&a, shape(), Transform::default(), &g, None, true).unwrap();
    let b = render(&b, shape(), Transform::default(), &g, None, true).unwrap();
    // Interior top edge, away from surface addressing and coverage boundaries.
    let low = a.at(48, 0);
    let high = b.at(48, 0);
    assert!(low.0[0] > 0.125);
    for c in 0..3 {
        assert!((high.0[c] - low.0[c] - 0.125).abs() < 1e-7);
    }
    assert_eq!(low.0[3], 1.);
    assert_eq!(high.0[3], 1.);
}

#[test]
fn malformed_public_geometry_inputs_are_errors() {
    assert!(
        field(
            Rect::new(0, 0, 1, 1),
            shape(),
            Transform::default(),
            &glass(),
            Some(4)
        )
        .is_err()
    );
    assert!(
        field(
            Rect::new(0, 0, 1, 1),
            GlassShape {
                size: [96., f64::NAN],
                radius: 1.
            },
            Transform::default(),
            &glass(),
            None
        )
        .is_err()
    );
}
