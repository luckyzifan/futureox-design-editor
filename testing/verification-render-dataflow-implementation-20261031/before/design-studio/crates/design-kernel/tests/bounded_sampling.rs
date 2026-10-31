use futureox_design_kernel::sampling::bilinear;

#[test]
fn bounded_sampler_vectors_retain_the_existing_cpu_exact_bilinear_contract() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/bounded-sampling-vectors.json"
    ))
    .unwrap();
    let (mut bounded, mut fallback) = (0, 0);
    for (index, row) in corpus["vectors"].as_array().unwrap().iter().enumerate() {
        let values: Vec<_> = row
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u32)
            .collect();
        let result = bilinear(
            std::array::from_fn(|i| f32::from_bits(values[i])),
            f32::from_bits(values[4]),
            f32::from_bits(values[5]),
        );
        assert_eq!(
            result.to_bits(),
            values[6],
            "independent boundary vector {index}: {values:?}"
        );
        if values[7] == 1 {
            bounded += 1;
        } else {
            fallback += 1;
        }
    }
    assert!(
        bounded > 200 && fallback > 100,
        "both bounded and general domains must be represented"
    );
}
