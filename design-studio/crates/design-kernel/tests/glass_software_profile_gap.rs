//! Issue #1059: the `figma` raster profile matches the preserved Chrome Figma
//! glass/frost/refraction/backdrop PNGs while `figmaSoftware` used to be off by
//! one to three codes. The software profile now selects the measured Figma
//! arithmetic for documents with a backdrop material. These rows are a subset
//! of the published 66-document table.
use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::Value;

fn references(name: &str) -> (std::path::PathBuf, Vec<Value>) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../frontend/design-client/public/fidelity")
        .join(name);
    let cases: Vec<Value> =
        serde_json::from_slice(&std::fs::read(root.join("cases.json")).unwrap()).unwrap();
    (root, cases)
}

fn render(case: &Value, profile: &str) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&case["document"].to_string()).unwrap();
    let mut options = case["options"].clone();
    options["rasterProfile"] = serde_json::json!(profile);
    let options: RenderOptions = serde_json::from_value(options).unwrap();
    engine.render(&options).unwrap()
}

fn compare(actual: &[u8], expected: &[u8]) -> (usize, i32) {
    let mut different = 0;
    let mut max = 0;
    for (a, b) in actual.chunks_exact(4).zip(expected.chunks_exact(4)) {
        let delta = a.iter().zip(b).map(|(x, y)| (*x as i32 - *y as i32).abs()).max().unwrap();
        different += usize::from(delta != 0);
        max = max.max(delta);
    }
    (different, max)
}

#[test]
fn glass_frost_refraction_and_backdrop_rows_match_both_profiles() {
    // (directory, case ids). `optics-2026-10-08` / `OpticsQA-frost-1.5-1x`
    // stays on #179 and is intentionally absent.
    let rows: &[(&str, &[&str])] = &[
        ("browser-2026-10-07", &["glass-frost-only", "glass-full"]),
        ("material-parameters-2026-10-08", &[
            "MaterialQA-glass-neutral",
            "MaterialQA-light-0",
            "MaterialQA-light-strong",
            "MaterialQA-frost-1",
            "MaterialQA-frost-4",
            "MaterialQA-refraction-1",
            "MaterialQA-dispersion-half",
        ]),
        ("optics-2026-10-08", &[
            "OpticsQA-frost-0-1x",
            "OpticsQA-frost-0-4x",
            "OpticsQA-frost-4-4x",
            "OpticsQA-light-45-0-depth-8-2x",
            "OpticsQA-light-45-0.5-depth-8-1x",
        ]),
        ("optics-world-2026-10-08", &["OpticsQA-frost-1.5-1x"]),
    ];
    for (directory, ids) in rows {
        let (root, cases) = references(directory);
        for id in *ids {
            let case = cases
                .iter()
                .find(|case| case["id"] == *id)
                .unwrap_or_else(|| panic!("{directory} is missing {id}"));
            let reference = image::open(root.join(case["reference"].as_str().unwrap()))
                .unwrap()
                .into_rgba8();
            for profile in ["figma", "figmaSoftware"] {
                let actual = render(case, profile);
                let (different, max) = compare(&actual, reference.as_raw());
                assert_eq!(
                    (different, max),
                    (0, 0),
                    "{directory}/{id} {profile} differs from the Chrome export"
                );
            }
        }
    }
}