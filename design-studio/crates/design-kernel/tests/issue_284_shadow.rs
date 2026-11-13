//! Issue #284. Radius-4 outer shadow versus the frozen Figma browser PNG.
//! The reference bytes stay the oracle. Figma export still resolves 2× coverage
//! with the official byte average. This outer shadow is filtered on the output
//! pixel grid, which is the tent the browser image follows.
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
fn radius4_outer_shadow_reduces_the_frozen_browser_residual() {
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
    let rendered: RenderOptions = serde_json::from_value(options).unwrap();
    let actual = engine.render(&rendered).unwrap();
    let expected = image::open(reference_path).unwrap().into_rgba8().into_raw();
    let (pixels, max) = gap(&actual, &expected);
    eprintln!(
        "issue284 shadow figma pixels={pixels} max={max} rgba={}",
        sha256(&actual)
    );
    // Frozen failure on this input was 668 pixels, max channel 2. The output
    // grid tent removes that two-code bias. What remains is one code, the
    // browser PNG's variation around the same row.
    assert_eq!(
        (pixels, max),
        (429, 1),
        "measured remainder against the frozen browser PNG"
    );
    assert_eq!(
        sha256(&actual),
        "589a345e3f1e2c5dae2aeb6b88a89b7c870d92f500ca7a654abd09073acd8249"
    );
    let at = |x: usize, y: usize| {
        let i = (y * 128 + x) * 4;
        [actual[i], actual[i + 1], actual[i + 2], actual[i + 3]]
    };
    assert_eq!(at(48, 48), [68, 119, 221, 255], "opaque fill");
    assert_eq!(at(64, 81), [196, 196, 196, 255], "lower penumbra center");
    assert_eq!(at(64, 85), [243, 243, 243, 255], "lower tail");
}
