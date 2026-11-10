//! Independent Chrome PNG contract for the software export profile.
//! No channel tolerance: a pixel either matches the preserved reference or the
//! case stays outside this gate.
use futureox_design_kernel::blend::{Pixel, over};
use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::Value;

fn references() -> (std::path::PathBuf, Vec<Value>) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../frontend/design-client/public/fidelity/browser-2026-10-07");
    let cases: Vec<Value> =
        serde_json::from_slice(&std::fs::read(root.join("cases.json")).unwrap()).unwrap();
    assert_eq!(cases.len(), 16, "the 16-reference set must stay complete");
    (root, cases)
}

fn render(case: &Value, profile: &str, zoom: u32) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&case["document"].to_string()).unwrap();
    let mut options = case["options"].clone();
    options["rasterProfile"] = serde_json::json!(profile);
    options["width"] = serde_json::json!(128 * zoom);
    options["height"] = serde_json::json!(128 * zoom);
    options["view"]["zoom"] = serde_json::json!(zoom);
    let options: RenderOptions = serde_json::from_value(options).unwrap();
    engine.render(&options).unwrap()
}

fn pixel(image: &[u8], x: usize, y: usize, width: usize) -> &[u8] {
    let i = (y * width + x) * 4;
    &image[i..i + 4]
}

/// Quantizing the mask to UNORM 128 and blending again is the rejected result.
/// The preserved export is one rounding of the exact one-half factor.
#[test]
fn double_quantized_half_mask_is_one_code_below_the_reference_composite() {
    let white = Pixel([1., 1., 1., 1.]);
    let blue = Pixel([0., 0., 1., 1.]);
    let rejected = over(white, blue.opacity(128. / 255.), "normal")
        .rgba8_quantized()
        .straight_rgba8();
    let accepted = over(white, blue.opacity(0.5), "normal")
        .rgba8_quantized()
        .straight_rgba8();
    assert_eq!(rejected, [127, 127, 255, 255]);
    assert_eq!(accepted, [128, 128, 255, 255]);
}

#[test]
fn software_profile_matches_the_bit_exact_browser_references() {
    let (root, cases) = references();
    // integer-rectangle and blur-small were already exact. alpha-mask became
    // exact once the mask factor stopped taking a second UNORM rounding.
    // Glass, backdrop, and texture stay on their own issues. The other misses
    // are profile-arithmetic gaps and are not given a tolerance here.
    for id in ["integer-rectangle", "blur-small", "alpha-mask"] {
        let case = cases.iter().find(|case| case["id"] == id).unwrap();
        let expected = image::open(root.join(case["reference"].as_str().unwrap()))
            .unwrap()
            .into_rgba8();
        for profile in ["figma", "figmaSoftware"] {
            let actual = render(case, profile, 1);
            assert_eq!(
                actual.as_slice(),
                expected.as_raw().as_slice(),
                "{id} {profile}"
            );
        }
    }
}

#[test]
fn half_alpha_mask_stays_on_the_reference_code_at_integer_scales() {
    let (_root, cases) = references();
    let case = cases
        .iter()
        .find(|case| case["id"] == "alpha-mask")
        .unwrap();
    for zoom in [1, 2, 3] {
        let image = render(case, "figmaSoftware", zoom);
        let width = 128 * zoom as usize;
        // The mask is an integer 64px square at (16, 16). Its center and a
        // pixel just inside the far edge stay on the 1x reference code.
        assert_eq!(
            pixel(&image, 48 * zoom as usize, 48 * zoom as usize, width),
            &[128, 128, 255, 255],
            "center x{zoom}"
        );
        assert_eq!(
            pixel(&image, 79 * zoom as usize, 79 * zoom as usize, width),
            &[128, 128, 255, 255],
            "inside far corner x{zoom}"
        );
        assert_eq!(pixel(&image, 0, 0, width), &[255, 255, 255, 255]);
        assert_eq!(
            pixel(&image, 15 * zoom as usize, 16 * zoom as usize, width),
            &[255, 255, 255, 255],
            "outside the mask x{zoom}"
        );
    }
}
