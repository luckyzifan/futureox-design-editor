use futureox_design_kernel::sampling::bilinear;

#[test]
fn invalid_sampler_inputs_remain_detectably_nonfinite_without_panicking() {
    for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        assert!(bilinear([1., invalid, 2., 3.], 0.5, 0.5).is_nan());
        assert!(bilinear([1.; 4], invalid, 0.5).is_nan());
    }
    assert!(bilinear([1.; 4], -0.1, 0.5).is_nan());
    assert!(bilinear([1.; 4], 0.5, 1.1).is_nan());
}
use futureox_design_kernel::{
    blend::{Pixel, Surface},
    effects,
    math::{Rect, Transform},
};

#[test]
fn linear_sampler_preserves_constant_fields_at_every_fractional_position() {
    let color = Pixel([4.12345, -0.2, 0.2357, 0.43123]);
    let mut input = Surface::new(Rect::new(0, 0, 4, 4)).unwrap();
    input.pixels.fill(color);
    for y in 0..101 {
        for x in 0..101 {
            assert_eq!(
                input
                    .sample_linear(
                        0.5 + f64::from(x) / 101. * 2.9,
                        0.5 + f64::from(y) / 101. * 2.9
                    )
                    .0
                    .map(f32::to_bits),
                color.0.map(f32::to_bits)
            );
        }
    }
}

#[test]
fn zero_texture_displacement_is_exact_identity_even_after_rotation_and_shear() {
    let mut input = Surface::new(Rect::new(-5, 7, 19, 13)).unwrap();
    for (i, pixel) in input.pixels.iter_mut().enumerate() {
        *pixel = Pixel([i as f32 / 37., -(i as f32) / 13., 0.125, 0.43]);
    }
    for matrix in [
        Transform([
            0.9323273456,
            0.3616154319,
            -0.3616154319,
            0.9323273456,
            12.75,
            8.125,
        ]),
        Transform([1., 0.7, -0.3, 2., -3.125, 7.25]),
    ] {
        let actual = effects::texture_linear(&input, 0., matrix).unwrap();
        assert_eq!(actual.pixels, input.pixels);
    }
}

#[test]
fn neutral_texture_and_backdrop_effects_preserve_leaf_sample_planes() {
    use futureox_design_kernel::{Engine, RenderOptions};
    use serde_json::json;
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/precision-corpus.json"
    ))
    .unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    let base = cases
        .iter()
        .find(|v| v["document"]["name"] == "Managed rotated texture none")
        .unwrap();
    for profile in ["figma", "figmaSubpixel"] {
        let mut options = base["options"].clone();
        options["rasterProfile"] = json!(profile);
        let options: RenderOptions = serde_json::from_value(options).unwrap();
        let mut engine = Engine::new();
        engine.load_document(&base["document"].to_string()).unwrap();
        let expected = engine.render_linear(&options).unwrap();
        for name in [
            "Managed rotated texture zero-amount",
            "Managed rotated texture zero-opacity",
            "Managed rotated backdrop neutral-glass",
            "Managed rotated backdrop neutral-glass-before-active-glass",
            "Managed rotated backdrop zero-blur-before-active-glass",
        ] {
            let case = cases
                .iter()
                .find(|v| v["document"]["name"] == name)
                .unwrap();
            engine.load_document(&case["document"].to_string()).unwrap();
            assert_eq!(
                engine.render_linear(&options).unwrap(),
                expected,
                "{profile}: {name}"
            );
        }
    }
}

#[test]
fn bilinear_is_correctly_rounded_against_independent_exact_rational_oracle() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/sampling-vectors.json"
    ))
    .unwrap();
    for (index, row) in corpus["vectors"].as_array().unwrap().iter().enumerate() {
        let bits: Vec<u32> = row
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u32)
            .collect();
        let actual = bilinear(
            std::array::from_fn(|i| f32::from_bits(bits[i])),
            f32::from_bits(bits[4]),
            f32::from_bits(bits[5]),
        );
        assert_eq!(actual.to_bits(), bits[6], "vector {index}: {bits:?}");
    }
}
