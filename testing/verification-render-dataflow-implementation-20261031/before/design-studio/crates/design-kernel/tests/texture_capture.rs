use futureox_design_kernel::{
    texture_capture::{Field, Rgba8, ShaderParameters, copyback, forward_uv},
    texture_capture_plan::{Input, Outcome, Plan, compile},
};

fn separate_original_plan() -> Box<Plan> {
    let Outcome::Capture(plan) = compile(Input {
        view: [1., 0., 0., 0., 1., 0.],
        node_to_render: [1., 0., 0., 0., 1., 0.],
        render_bounds: [0., 0., 1., 1.],
        capture_source_bounds_render: Some([0., 0., 1., 1.]),
        active_bounds: [0., 0., 1., 1.],
        radius: 1.,
        noise_size: [8., 8.],
        node_center: [0.5, 0.5],
        clipped: true,
        parent_pixels: 4,
        capture_pixels: 8,
        original_pixels: 4,
    })
    .unwrap() else {
        panic!("Expected separate original");
    };
    assert_eq!(plan.original_pixels, Some(4));
    plan
}

fn bytes(value: &serde_json::Value) -> [u8; 4] {
    std::array::from_fn(|i| value[i].as_u64().unwrap() as u8)
}

#[test]
fn separate_forward_graphs_match_independent_gpu_vectors() {
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/texture-forward-gpu-vectors.json"
    ))
    .unwrap();
    let rows = data["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 768);
    let mut wrong_variant_counterexamples = 0;
    for row in rows {
        let pair = |key: &str| {
            std::array::from_fn::<_, 2, _>(|i| f32::from_bits(row[key][i].as_u64().unwrap() as u32))
        };
        let node = pair("nodeBits");
        let displacement = pair("displacementBits");
        let diagonal = pair("diagonalBits");
        let translation = pair("translationBits");
        let matrix = [
            diagonal[0],
            0.,
            translation[0],
            0.,
            diagonal[1],
            translation[1],
        ];
        let scale = f32::from_bits(row["expansionScaleBits"].as_u64().unwrap() as u32);
        let clipped = row["clipped"].as_bool().unwrap();
        let moved = std::array::from_fn(|i| node[i] + displacement[i]);
        let expected = pair("sampleUVBits").map(f32::to_bits);
        assert_eq!(
            forward_uv(matrix, scale, clipped, moved)
                .unwrap()
                .map(f32::to_bits),
            expected,
            "{} {:?} clipped={clipped}",
            row["inputCase"],
            row["sourcePixel"],
        );
        wrong_variant_counterexamples += usize::from(
            forward_uv(matrix, scale, !clipped, moved)
                .unwrap()
                .map(f32::to_bits)
                != expected,
        );
    }
    assert!(wrong_variant_counterexamples >= 128);
}

#[test]
fn forward_graph_rejects_unsupported_inputs_and_overflow() {
    let identity = [1., 0., 0., 0., 1., 0.];
    for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        assert!(forward_uv(identity, value, false, [0.; 2]).is_err());
        assert!(forward_uv(identity, 1., true, [value, 0.]).is_err());
    }
    for scale in [-1., 0., 1.01] {
        assert!(forward_uv(identity, scale, false, [0.; 2]).is_err());
    }
    let mut shear = identity;
    shear[1] = 0.25;
    assert!(forward_uv(shear, 1., false, [0.; 2]).is_err());
    let mut collapsed = identity;
    collapsed[4] = 0.;
    assert!(forward_uv(collapsed, 1., true, [0.; 2]).is_err());
    let mut excessive = identity;
    excessive[0] = f32::MAX;
    assert!(forward_uv(excessive, 1., false, [2., 0.]).is_err());
}

#[test]
fn fractional_sample_survives_until_the_parent_blend_store() {
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/texture-copyback-vectors.json"
    ))
    .unwrap();
    let cases = data["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 128);
    let mut early_store_counterexamples = 0;
    for case in cases {
        let pixels: Vec<u8> = case["pixels"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(bytes)
            .collect();
        let source = Rgba8::new(2, &pixels).unwrap();
        let uv =
            std::array::from_fn(|i| f32::from_bits(case["uvBits"][i].as_u64().unwrap() as u32));
        let expected_bits =
            std::array::from_fn::<_, 4, _>(|i| case["sampleBits"][i].as_u64().unwrap() as u32);
        assert_eq!(source.sample(uv).unwrap().map(f32::to_bits), expected_bits);
        let expected = bytes(&case["expected"]);
        assert_eq!(
            copyback(source, uv, bytes(&case["destination"])).unwrap(),
            expected
        );
        early_store_counterexamples += usize::from(bytes(&case["prematurelyStored"]) != expected);
    }
    assert!(
        early_store_counterexamples >= 32,
        "Controls must detect an extra RGBA8 store"
    );
}

#[test]
fn resource_and_coordinate_validation_precedes_indexing() {
    assert!(Rgba8::new(0, &[]).is_err());
    assert!(Rgba8::new(u32::MAX, &[]).is_err());
    assert!(Rgba8::new(2, &[0; 15]).is_err());
    let texture = Rgba8::new(1, &[17, 23, 42, 128]).unwrap();
    for uv in [[f32::MAX, -f32::MAX], [0., 0.], [1., 1.]] {
        assert_eq!(
            texture.sample(uv).unwrap(),
            [17., 23., 42., 128.].map(|v| v / 255.)
        );
    }
    for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        assert!(texture.sample([invalid, 0.]).is_err());
        assert!(copyback(texture, [0., invalid], [0; 4]).is_err());
    }
}

#[test]
fn clipped_transparent_resample_keeps_the_filtered_original() {
    let plan = separate_original_plan();
    let parameters = ShaderParameters::new(&plan).unwrap();
    let clear = [0; 8 * 8 * 4];
    let original = [17, 23, 42, 128].repeat(16);
    let field = Field {
        node_point: [0.5; 2],
        displacement: [0.25, -0.25],
    };
    let effect = parameters
        .bind(
            Rgba8::new(8, &clear).unwrap(),
            Some(Rgba8::new(4, &original).unwrap()),
        )
        .unwrap();
    assert_eq!(effect.shade([0.5; 2], field).unwrap(), [17, 23, 42, 128]);

    let solid = [128, 64, 32, 255].repeat(64);
    let original = [0; 4 * 4 * 4];
    let effect = parameters
        .bind(
            Rgba8::new(8, &solid).unwrap(),
            Some(Rgba8::new(4, &original).unwrap()),
        )
        .unwrap();
    assert_eq!(effect.shade([0.5; 2], field).unwrap(), [0; 4]);
}

#[test]
fn shader_domain_and_attachment_errors_cannot_be_hidden_by_empty_color() {
    let mut plan = separate_original_plan();
    let parameters = ShaderParameters::new(&plan).unwrap();
    let clear = [0; 8 * 8 * 4];
    assert!(
        parameters
            .bind(Rgba8::new(8, &clear).unwrap(), None)
            .is_err()
    );
    let original = [0; 4 * 4 * 4];
    let effect = parameters
        .bind(
            Rgba8::new(8, &clear).unwrap(),
            Some(Rgba8::new(4, &original).unwrap()),
        )
        .unwrap();
    assert!(
        effect
            .shade(
                [0.5; 2],
                Field {
                    node_point: [0.; 2],
                    displacement: [f32::NAN, 0.]
                }
            )
            .is_err()
    );
    assert!(parameters.field([f32::INFINITY, 0.]).is_err());
    plan.node_to_tile[1] = 0.1;
    assert!(
        ShaderParameters::new(&plan).is_err(),
        "General affine shader contraction remains outside the measured domain"
    );
}
