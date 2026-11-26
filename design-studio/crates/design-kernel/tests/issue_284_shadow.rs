//! Issue #284. Radius-4 outer shadow versus the frozen Figma browser PNG.
//! The reference bytes stay the oracle. Figma export still resolves 2× coverage
//! with the official byte average. The shadow tent integrates one destination
//! cell on the output grid after resolving the coverage samples.
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
fn radius4_outer_shadow_integrates_one_output_cell() {
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
    // The previous output-grid tent integrated both cells and left 429 pixels
    // different. The destination-cell integral brings that down to 307.
    assert_eq!(
        (pixels, max),
        (307, 1),
        "measured remainder against the frozen browser PNG"
    );
    assert_eq!(
        sha256(&actual),
        "6b49319c86f3c0fa094866f490dd5c76abd1212627f9509ffc8250d2ff445d3e"
    );
    let at = |x: usize, y: usize| {
        let i = (y * 128 + x) * 4;
        [actual[i], actual[i + 1], actual[i + 2], actual[i + 3]]
    };
    assert_eq!(at(48, 48), [68, 119, 221, 255], "opaque fill");
    assert_eq!(at(64, 81), [196, 196, 196, 255], "lower penumbra center");
    assert_eq!(at(64, 85), [243, 243, 243, 255], "lower tail");
}

#[test]
fn offset_outer_shadow_viewport_matches_the_same_full_frame_pixels() {
    let case = shadow_case();
    let document = case["document"].to_string();
    let mut options = case["options"].clone();
    options["rasterProfile"] = json!("figma");
    let options: RenderOptions = serde_json::from_value(options).unwrap();
    let mut full_engine = Engine::new();
    full_engine.load_document(&document).unwrap();
    let full = full_engine.render(&options).unwrap();
    assert_eq!(
        sha256(&full),
        "6b49319c86f3c0fa094866f490dd5c76abd1212627f9509ffc8250d2ff445d3e",
        "full output must retain the frozen pre-fix bytes"
    );

    let (x, y, width, height) = (19, 31, 90, 61);
    let mut cropped = options.clone();
    cropped.width = width;
    cropped.height = height;
    cropped.view.x -= f64::from(x);
    cropped.view.y -= f64::from(y);
    let mut crop_engine = Engine::new();
    crop_engine.load_document(&document).unwrap();
    let actual = crop_engine.render(&cropped).unwrap();
    let expected = (y..y + height)
        .flat_map(|row| {
            let start = ((row * options.width + x) * 4) as usize;
            full[start..start + (width * 4) as usize].iter().copied()
        })
        .collect::<Vec<_>>();
    assert_eq!(actual.len(), expected.len());
    assert_eq!(gap(&actual, &expected), (0, 0));
    let ledger = crop_engine.compositing_ledger();
    assert_eq!(ledger.budget_rejections, 0);
    assert!(ledger.scene_peak_bytes <= full_engine.compositing_ledger().scene_peak_bytes);
}
