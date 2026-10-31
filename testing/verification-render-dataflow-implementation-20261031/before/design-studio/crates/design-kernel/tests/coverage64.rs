#[test]
fn cpu_coverage_operation_boundaries_match_exact_rational_oracle() {
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/coverage-vectors.json"
    ))
    .unwrap();
    for (index, row) in data["cases"].as_array().unwrap().iter().enumerate() {
        let w: Vec<_> = row["words"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
        let value = |i: usize| f64::from_bits(w[i] | (w[i + 1] << 32));
        let x = if let Some(raw) = row["raw"].as_array() {
            let original = |i: usize| {
                f64::from_bits(u64::from_str_radix(raw[i].as_str().unwrap(), 16).unwrap())
            };
            original(0) - original(1)
        } else {
            value(1) - value(3)
        };
        let y = value(5) - value(7);
        let actual = if w[0] == 0 {
            (x / 8.) as f32
        } else {
            (x * y) as f32
        };
        assert_eq!(
            actual.to_bits(),
            row["expected"].as_u64().unwrap() as u32,
            "coverage {index}"
        );
    }
}
