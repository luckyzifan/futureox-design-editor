use futureox_design_kernel::blend::{self, Pixel};
#[test]
fn linear_burn_and_dodge_match_figma_blend_table() {
    // Figma blend types 17/18:
    // linear-burn = max(0, b+s-1); linear-dodge = min(1, b+s)
    let src = Pixel([0.5, 0.8, 0.3, 1.0]);
    let dst = Pixel([0.6, 0.4, 0.9, 1.0]);
    let burned = blend::over(dst, src, "linear-burn");
    let dodged = blend::over(dst, src, "linear-dodge");
    // over() 输出 = mixed*(sa) + dst*(1-sa);sa=1 时即 mixed
    assert!((burned.0[0] - 0.1).abs() < 1e-6, "burn r={} want 0.1", burned.0[0]);
    assert!((dodged.0[0] - 1.0).abs() < 1e-6, "dodge r={} want 1.0", dodged.0[0]);
    // 模式有效性
    assert!(blend::valid_mode("linear-burn"));
    assert!(blend::valid_mode("linear-dodge"));
}
