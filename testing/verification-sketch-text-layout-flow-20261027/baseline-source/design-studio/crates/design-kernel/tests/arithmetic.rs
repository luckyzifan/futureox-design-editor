//! The oracle is generated using exact Python Fraction arithmetic, with one RNE.
#[test]
fn cpu_binary32_operations_match_exact_rational_oracle() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/arithmetic-vectors.json"
    ))
    .unwrap();
    for (index, row) in corpus["vectors"].as_array().unwrap().iter().enumerate() {
        let v: Vec<u32> = row
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u32)
            .collect();
        let actual = match v[0] {
            0 => f32::from_bits(v[1]) / f32::from_bits(v[2]),
            1 => (v[2] as f32 - v[1] as f32).mul_add(f32::from_bits(v[3]), v[1] as f32),
            2 => ((u64::from(v[2]) << 32 | u64::from(v[1])) as f32) * 2_f32.powi(-(v[3] as i32)),
            3 => f32::from_bits(v[1]) + f32::from_bits(v[2]),
            4 => f32::from_bits(v[1]) * f32::from_bits(v[2]),
            5 => f32::from_bits(v[1]).sqrt(),
            6 => {
                futureox_design_kernel::effects::tent_weight(f64::from(f32::from_bits(v[1])), v[2])
                    as f32
            }
            7 => futureox_design_kernel::material::fifth_root(f32::from_bits(v[1])),
            8 => f32::from_bits(v[1]).mul_add(f32::from_bits(v[2]), f32::from_bits(v[3])),
            9 => (f32::from_bits(v[1]) - f32::from_bits(v[2]))
                .mul_add(f32::from_bits(v[3]), f32::from_bits(v[2])),
            10 => {
                let value =
                    f32::from_bits(v[1]).mul_add(f32::from_bits(v[2]), f32::from_bits(v[3]));
                if value.is_nan() {
                    f32::from_bits(0x7fc00000)
                } else {
                    value
                }
            }
            _ => panic!("Unknown arithmetic oracle operation"),
        };
        assert_eq!(actual.to_bits(), v[4], "vector {index}: {row}");
    }
}
