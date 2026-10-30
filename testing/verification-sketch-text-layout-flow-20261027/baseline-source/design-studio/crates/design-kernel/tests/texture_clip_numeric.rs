//! Scalar clip arithmetic only. Expected bits and digests come from independent
//! Metal fast-log/fast-exp numeric readbacks, never reference-image colours.
use futureox_design_kernel::{
    figma_sampling::normalize_q4,
    material::fifth_root,
    texture_noise::clip_weight::{self, Error},
};
use sha2::{Digest, Sha256};

#[test]
fn assets_are_fixed_and_baseline_roots_are_independently_correctly_rounded() {
    let roots = clip_weight::baseline_root_bytes();
    let residuals = clip_weight::residual_bytes();
    assert_eq!(roots.len(), 16_324);
    assert_eq!(residuals.len(), 4_164_661);
    assert_eq!(roots.len() + residuals.len(), clip_weight::TOTAL_BYTES);
    assert_eq!(
        format!("{:x}", Sha256::digest(roots)),
        clip_weight::BASELINE_SHA256
    );
    assert_eq!(
        format!("{:x}", Sha256::digest(residuals)),
        clip_weight::RESIDUAL_SHA256
    );
    assert_eq!(residuals.last().unwrap() >> 4, 0);
    for q in 0..clip_weight::ALPHA_COUNT {
        let offset = q as usize * 4;
        let actual = u32::from_le_bytes(roots[offset..offset + 4].try_into().unwrap());
        assert_eq!(actual, fifth_root(normalize_q4(q)).to_bits(), "q={q}");
    }
}

#[test]
fn all_ordered_pairs_reconstruct_the_native_scalar_function_exactly() {
    let mut triangle_digest = Sha256::new();
    let mut ordered = 0;
    for high in 0..clip_weight::ALPHA_COUNT {
        for low in 0..=high {
            let value = clip_weight::evaluate_indices(low, high).unwrap();
            assert!(value.is_finite() && (0. ..=1.).contains(&value));
            assert_eq!(
                value.to_bits(),
                clip_weight::evaluate_indices(high, low).unwrap().to_bits()
            );
            if low == 0 {
                assert_eq!(value.to_bits(), 0);
            }
            triangle_digest.update(value.to_le_bytes());
            ordered += if low == high { 1 } else { 2 };
        }
    }
    assert_eq!(ordered, 16_654_561);
    // Digest of the full real-Metal triangle in high-major/low-minor order.
    assert_eq!(
        format!("{:x}", triangle_digest.finalize()),
        "60d716e013367ca21b44b0da630cd1a3c5e16f0ba511022f0798a0492d84382d"
    );
}

#[test]
fn float_entrypoint_accepts_only_exact_q4_nodes_even_with_zero_other_alpha() {
    for q in 0..clip_weight::ALPHA_COUNT {
        let alpha = normalize_q4(q);
        assert_eq!(clip_weight::alpha_index(alpha), Ok(q));
        assert_eq!(
            clip_weight::evaluate(alpha, 1.).unwrap().to_bits(),
            clip_weight::evaluate_indices(q, 4080).unwrap().to_bits()
        );
        assert_eq!(clip_weight::evaluate(0., alpha).unwrap().to_bits(), 0);
        if q > 0 {
            for bits in [alpha.to_bits() - 1, alpha.to_bits() + 1] {
                assert_eq!(
                    clip_weight::alpha_index(f32::from_bits(bits)),
                    Err(Error::InvalidAlpha)
                );
            }
        }
    }
    for invalid in [
        f32::NAN,
        f32::INFINITY,
        f32::NEG_INFINITY,
        -0.,
        -0.1,
        1.01,
        f32::from_bits(1),
    ] {
        assert_eq!(clip_weight::evaluate(0., invalid), Err(Error::InvalidAlpha));
        assert_eq!(clip_weight::evaluate(invalid, 0.), Err(Error::InvalidAlpha));
    }
    for invalid in [4081, u32::MAX] {
        assert_eq!(
            clip_weight::evaluate_indices(0, invalid),
            Err(Error::InvalidIndex)
        );
        assert_eq!(
            clip_weight::evaluate_indices(invalid, 0),
            Err(Error::InvalidIndex)
        );
    }
}
