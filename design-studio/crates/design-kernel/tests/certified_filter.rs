use futureox_design_kernel::rational_filter::{CERTIFIED_KERNEL_MAGIC, RationalKernel};

#[test]
fn q48_integer_certificates_match_independent_fraction_integration_and_rne() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/certified-filter-vectors.json"
    ))
    .unwrap();
    let kernels: Vec<_> = corpus["kernels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            let radius = f64::from_bits(
                u64::from_str_radix(row["radiusBits"].as_str().unwrap(), 16).unwrap(),
            );
            let kernel = if row["kind"] == "box" {
                RationalKernel::uniform_box(radius as u32)
            } else {
                RationalKernel::tent(radius)
            }
            .unwrap();
            let bytes = kernel.certified_encoded();
            let words: Vec<_> = bytes
                .chunks_exact(4)
                .map(|word| u32::from_le_bytes(word.try_into().unwrap()))
                .collect();
            assert_eq!(
                &words[..4],
                &[CERTIFIED_KERNEL_MAGIC, kernel.reach() as u32, 48, if kernel.reach() >= 3 {64} else {0}]
            );
            assert_eq!(words.len(), 4 + 2 * (kernel.reach() + 1));
            for (index, q) in row["q48"].as_array().unwrap().iter().enumerate() {
                let expected: u64 = q.as_str().unwrap().parse().unwrap();
                let raw = u64::from(words[4 + index * 2]) | (u64::from(words[5 + index * 2]) << 32);
                let actual = if words[3] == 64 { raw >> 16 } else { raw };
                assert_eq!(actual, expected, "Q48 floor radius={radius} distance={index}");
                if words[3] == 64 {
                    let q64: u64 = row["q64"][index].as_str().unwrap().parse().unwrap();
                    assert_eq!(raw, q64, "Q64 floor radius={radius} distance={index}");
                }
            }
            kernel
        })
        .collect();
    let (mut accepted, mut declined, mut nonconstant_accepted) = (0, 0, 0);
    for (index, row) in corpus["cases"].as_array().unwrap().iter().enumerate() {
        let kernel = &kernels[row["kernel"].as_u64().unwrap() as usize];
        let values: Vec<_> = row["values"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| f32::from_bits(v.as_u64().unwrap() as u32))
            .collect();
        let expected = row["expected"].as_u64().unwrap() as u32;
        let actual = kernel.certified_convolve(&values).unwrap();
        if let Some(value) = actual {
            accepted += 1;
            nonconstant_accepted +=
                usize::from(values.iter().any(|v| v.to_bits() != values[0].to_bits()));
            assert_eq!(
                value.to_bits(),
                expected,
                "certificate case={index} family={}",
                row["family"]
            );
        } else {
            declined += 1;
        }
        assert_eq!(
            kernel.convolve(&values).unwrap().to_bits(),
            expected,
            "exact fallback case={index}"
        );
    }
    assert!(
        accepted > 70 && nonconstant_accepted > 40,
        "must exercise varying accepted inputs: {accepted}/{nonconstant_accepted}"
    );
    assert!(
        declined > 20,
        "must exercise uncertainty and range fallback: {declined}"
    );
}

#[test]
fn q48_rejects_invalid_input_and_declines_wide_exponents_and_true_rounding_ties() {
    let kernel = RationalKernel::tent(0.5).unwrap();
    for values in [
        [0., f32::NAN, 0.],
        [0., f32::INFINITY, 0.],
        [0., f32::NEG_INFINITY, 0.],
    ] {
        assert!(kernel.certified_convolve(&values).is_err());
    }
    assert!(kernel.certified_convolve(&[0.]).is_err());
    let span41 = [f32::from_bits(97 << 23), f32::from_bits(138 << 23), 0.];
    assert!(kernel.certified_convolve(&span41).unwrap().is_none());
    let tie = [1., 1., f32::from_bits(1_f32.to_bits() + 6)];
    assert!(kernel.certified_convolve(&tie).unwrap().is_none());
    assert_eq!(kernel.convolve(&tie).unwrap().to_bits(), 1_f32.to_bits());
    assert_eq!(
        kernel
            .certified_convolve(&[-0., 0., -0.])
            .unwrap()
            .unwrap()
            .to_bits(),
        0
    );
    let tiny = [-f32::from_bits(1), 0., 0.];
    assert_eq!(
        kernel.certified_convolve(&tiny).unwrap().unwrap().to_bits(),
        0x8000_0000
    );
}

#[test]
fn q48_acceptance_agrees_with_original_independent_extreme_corpus() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/filter-vectors.json"
    ))
    .unwrap();
    for (index, row) in corpus["cases"].as_array().unwrap().iter().enumerate() {
        let radius =
            f64::from_bits(u64::from_str_radix(row["radiusBits"].as_str().unwrap(), 16).unwrap());
        let kernel = if row["kind"] == "box" {
            RationalKernel::uniform_box(radius as u32)
        } else {
            RationalKernel::tent(radius)
        }
        .unwrap();
        let values: Vec<_> = row["values"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| f32::from_bits(v.as_u64().unwrap() as u32))
            .collect();
        if let Some(value) = kernel.certified_convolve(&values).unwrap() {
            assert_eq!(
                value.to_bits(),
                row["expected"].as_u64().unwrap() as u32,
                "old independent case {index}"
            );
        }
    }
}
