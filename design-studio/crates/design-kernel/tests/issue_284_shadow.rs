//! Issue #284. Radius-4 outer shadow versus the frozen Figma browser PNG.
//! The reference bytes stay the oracle. The 2× export resolve used to keep
//! the lower byte of an exact half-byte mean; the browser image keeps the
//! upper byte.
use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn shadow_case() -> Value {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../frontend/design-client/public/fidelity/browser-2026-10-07/cases.json"
    ))
    .unwrap();
    cases
        .into_iter()
        .find(|case| case["id"] == "shadow")
        .unwrap()
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn gap(actual: &[u8], expected: &[u8]) -> (usize, u8) {
    let mut pixels = 0usize;
    let mut max = 0u8;
    for (a, b) in actual.chunks_exact(4).zip(expected.chunks_exact(4)) {
        let delta = a
            .iter()
            .zip(b)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap_or(0);
        if delta != 0 {
            pixels += 1;
            max = max.max(delta);
        }
    }
    (pixels, max)
}

#[test]
fn radius4_outer_shadow_matches_the_frozen_browser_png() {
    let case = shadow_case();
    let reference_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../frontend/design-client/public/fidelity/browser-2026-10-07")
        .join(case["reference"].as_str().unwrap());
    let png = std::fs::read(&reference_path).unwrap();
    assert_eq!(
        sha256(&png),
        case["referenceSha256"].as_str().unwrap(),
        "frozen shadow.png"
    );
    let mut engine = Engine::new();
    engine.load_document(&case["document"].to_string()).unwrap();
    let mut options = case["options"].clone();
    options["rasterProfile"] = json!("figma");
    let options: RenderOptions = serde_json::from_value(options).unwrap();
    let actual = engine.render(&options).unwrap();
    let expected = image::open(reference_path).unwrap().into_rgba8().into_raw();
    let (pixels, max) = gap(&actual, &expected);
    eprintln!(
        "issue284 shadow figma pixels={pixels} max={max} rgba={}",
        sha256(&actual)
    );
    // Frozen failure on this input was 668 pixels, max channel 2. The 2×
    // export was keeping the lower byte of an exact half-byte shadow mean.
    // After that bias is removed, every remaining difference is one code.
    // Those pixels are the browser PNG's per-pixel variation around the modal
    // gray of the same shadow row; this test does not replace the PNG.
    assert!(
        pixels < 668 && max <= 1,
        "radius-4 outer shadow regressed past the frozen 668/2 failure: pixels={pixels} max={max}"
    );
    assert_eq!(
        (pixels, max),
        (289, 1),
        "measured remainder against the frozen browser PNG"
    );
    let at = |x: usize, y: usize| {
        let i = (y * 128 + x) * 4;
        [actual[i], actual[i + 1], actual[i + 2], actual[i + 3]]
    };
    assert_eq!(at(48, 48), [68, 119, 221, 255], "opaque fill");
    assert_eq!(at(31, 56), [231, 231, 231, 255], "left penumbra");
    assert_eq!(at(64, 85), [243, 243, 243, 255], "lower penumbra");
    assert_eq!(at(64, 81), [196, 196, 196, 255], "modal lower row");
}
