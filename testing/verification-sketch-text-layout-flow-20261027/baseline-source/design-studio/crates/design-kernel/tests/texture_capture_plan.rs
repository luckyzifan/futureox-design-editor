use futureox_design_kernel::texture_capture_plan::{Input, Outcome, compile, transformed_bounds};

fn input(clipped: bool, jitter: [f32; 2]) -> Input {
    let view = [
        1. / 256.,
        0.,
        jitter[0] / 512.,
        0.,
        1. / 256.,
        jitter[1] / 512.,
    ];
    Input {
        view,
        node_to_render: [1., 0., 20., 0., 1., 20.],
        capture_source_bounds_render: clipped.then_some([20., 20., 108., 108.]),
        render_bounds: transformed_bounds(
            view,
            if clipped {
                [20., 20., 108., 108.]
            } else {
                [18., 18., 110., 110.]
            },
        ),
        active_bounds: [0., 0., 0.5, 0.5],
        radius: 2.,
        noise_size: [8., 8.],
        node_center: [44., 44.],
        clipped,
        parent_pixels: 512,
        capture_pixels: 1024,
        original_pixels: 512,
    }
}

fn expect_bits(actual: &[f32], value: &serde_json::Value, label: &str) {
    let expected: Vec<_> = value["bits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| u32::from_str_radix(v.as_str().unwrap(), 16).unwrap())
        .collect();
    assert_eq!(
        actual.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        expected,
        "{label}"
    );
}

#[test]
fn independent_capture_plan_vectors_match_all_numeric_words() {
    let values: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/texture-capture-plan-vectors.json"
    ))
    .unwrap();
    let cases = values["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 8);
    for case in cases {
        let j = &case["cameraJitter"]["f32"];
        let input = input(
            case["clipped"].as_bool().unwrap(),
            [j[0].as_f64().unwrap() as f32, j[1].as_f64().unwrap() as f32],
        );
        let Outcome::Capture(plan) = compile(input).unwrap() else {
            panic!("Expected active capture");
        };
        for (actual, name) in [
            (vec![plan.normalized_radius], "normalizedRadius"),
            (vec![plan.scale], "scale"),
            (vec![plan.padding], "normalizedPadding"),
            (plan.centered_expansion.to_vec(), "centeredExpansion"),
            (plan.capture_view.to_vec(), "captureView"),
            (plan.node_to_tile.to_vec(), "nodeToTile"),
            (plan.tile_to_node.to_vec(), "tileToNode"),
            (plan.node_center.to_vec(), "nodeCenter"),
            (plan.noise_reciprocal.to_vec(), "noiseReciprocal"),
            (vec![plan.radius], "radiusUniform"),
            (plan.visible_bounds.to_vec(), "visibleEffectBoundsUV"),
            (plan.capture_bounds.to_vec(), "captureActiveBoundsUV"),
            (plan.effect_quad.to_vec(), "effectQuadUV"),
            (plan.copyback_quad.to_vec(), "copybackQuadUV"),
        ] {
            expect_bits(&actual, &case[name], name);
        }
        assert_eq!(
            serde_json::to_value(plan.capture_rect).unwrap(),
            case["capturePixelRect"]
        );
        assert_eq!(
            serde_json::to_value(plan.effect_rect).unwrap(),
            case["effectPixelRect"]
        );
        assert_eq!(plan.original_pixels, None);
        assert!(plan.use_expanded_only);
    }
}

#[test]
fn threshold_empty_and_extra_original_are_distinct_paths() {
    let mut value = input(true, [0., 0.]);
    value.radius = f32::from_bits(0.5_f32.to_bits() - 1);
    assert!(matches!(compile(value).unwrap(), Outcome::Passthrough));
    value.radius = 0.5;
    assert!(matches!(compile(value).unwrap(), Outcome::Capture(_)));
    value.render_bounds = [1., 1., 2., 2.];
    assert!(matches!(compile(value).unwrap(), Outcome::Empty));
    value = input(true, [0., 0.]);
    value.view[0] *= 2.;
    value.view[4] *= 2.;
    value.radius = 100.;
    let Outcome::Capture(plan) = compile(value).unwrap() else {
        panic!("Expected extra original");
    };
    assert!(!plan.use_expanded_only);
    assert_eq!(plan.original_pixels, Some(512));
    assert!(plan.original_rect.is_some());
    value.clipped = false;
    value.capture_source_bounds_render = None;
    let Outcome::Capture(plan) = compile(value).unwrap() else {
        panic!("Expected unclipped capture");
    };
    assert!(plan.use_expanded_only);
    assert!(plan.original_rect.is_none());
}

#[test]
fn empty_active_source_is_explicitly_unsupported_not_invisible_or_invalid() {
    let mut value = input(true, [0., 0.]);
    value.capture_source_bounds_render = Some([500., 500., 501., 501.]);
    assert!(matches!(compile(value).unwrap(), Outcome::Unsupported));
    value.capture_source_bounds_render = Some([500., 500., f32::INFINITY, 501.]);
    assert!(compile(value).is_err());
}

#[test]
fn invalid_inputs_are_not_hidden_by_a_disabled_effect() {
    let base = input(true, [0., 0.]);
    for radius in [f32::NAN, f32::INFINITY, -1.] {
        assert!(compile(Input { radius, ..base }).is_err());
    }
    for side in [0, 3, 16_385, u32::MAX] {
        assert!(
            compile(Input {
                capture_pixels: side,
                ..base
            })
            .is_err()
        );
    }
    let mut bad = base;
    bad.radius = 0.;
    bad.node_to_render = [0.; 6];
    assert!(compile(bad).is_err());
    bad = base;
    bad.capture_source_bounds_render = None;
    assert!(compile(bad).is_err());
    bad = base;
    bad.capture_source_bounds_render = Some([0., 0., f32::INFINITY, 1.]);
    assert!(compile(bad).is_err());
    bad = base;
    bad.capture_source_bounds_render = Some([1000., 1000., 1001., 1001.]);
    assert!(
        matches!(compile(bad).unwrap(), Outcome::Unsupported),
        "Empty source must not skip the effect's original fallback"
    );
    bad = base;
    bad.noise_size = [0., 8.];
    assert!(compile(bad).is_err());
    bad = base;
    bad.active_bounds = [0., 0., f32::NAN, 1.];
    assert!(compile(bad).is_err());
    bad = base;
    bad.active_bounds = [1., 0., 0., 1.];
    assert!(compile(bad).is_err());
    bad = base;
    bad.active_bounds = [0., 0., f32::MAX, f32::MAX];
    bad.render_bounds = bad.active_bounds;
    assert!(compile(bad).is_err());
}
