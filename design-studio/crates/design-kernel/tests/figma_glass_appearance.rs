//! Issue 179. The frozen Chrome cases now carry the Figma glass readback
//! (depth, refraction, dispersion, light) instead of the old amount/opacity
//! stand-in, so export profiles use the calibrated capture. Ceilings are the
//! measured gaps after that mapping and are below the 2026-11-10 main deltas.
use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// (case, profile, max different pixels, max channel). Inclusive ceilings.
const CEILINGS: &[(&str, &str, usize, u8)] = &[
    ("backdrop-blur", "figma", 3887, 7),
    ("backdrop-blur", "figmaSoftware", 3974, 7),
    ("glass-frost-only", "figma", 0, 0),
    ("glass-frost-only", "figmaSoftware", 2536, 2),
    ("glass-full", "figma", 0, 0),
    ("glass-full", "figmaSoftware", 2077, 3),
];

fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../frontend/design-client/public/fidelity/browser-2026-10-07")
}

fn cases() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "../../../../frontend/design-client/public/fidelity/browser-2026-10-07/cases.json"
    ))
    .unwrap()
}

fn case<'a>(cases: &'a [Value], id: &str) -> &'a Value {
    cases.iter().find(|c| c["id"] == id).expect(id)
}

fn render(case: &Value, profile: &str) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&case["document"].to_string()).unwrap();
    let mut options = case["options"].clone();
    options["rasterProfile"] = json!(profile);
    let options: RenderOptions = serde_json::from_value(options).unwrap();
    engine.render(&options).unwrap()
}

fn gap(actual: &[u8], expected: &[u8]) -> (usize, u8) {
    assert_eq!(actual.len(), expected.len());
    let mut pixels = 0usize;
    let mut max = 0u8;
    for (a, b) in actual.chunks_exact(4).zip(expected.chunks_exact(4)) {
        let delta = a.iter().zip(b).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
        if delta != 0 {
            pixels += 1;
            max = max.max(delta);
        }
    }
    (pixels, max)
}

fn reference(case: &Value) -> Vec<u8> {
    let path = root().join(case["reference"].as_str().unwrap());
    let bytes = std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let digest = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(digest, case["referenceSha256"].as_str().unwrap());
    image::open(path).unwrap().into_rgba8().into_raw()
}

#[test]
fn glass_cases_bind_the_frozen_figma_readback() {
    let cases = cases();
    let provenance: Value = serde_json::from_str(include_str!(
        "../../../../frontend/design-client/public/fidelity/browser-2026-10-07/provenance.json"
    ))
    .unwrap();
    for id in ["glass-frost-only", "glass-full"] {
        let case = case(&cases, id);
        let source = provenance["frames"]
            .as_array()
            .unwrap()
            .iter()
            .find(|frame| frame["case"] == id)
            .unwrap()["children"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["name"] == "lens")
            .unwrap()["effects"][0]
            .clone();
        assert_eq!(source["type"], "GLASS");
        let effect = &case["document"]["nodes"]["lens"]["effects"][0];
        assert_eq!(effect["kind"], "glass");
        assert_eq!(effect["radius"], source["radius"]);
        for key in ["depth", "refraction", "dispersion", "lightAngle", "lightIntensity"] {
            assert_eq!(effect["glass"][key], source[key], "{id}.{key}");
        }
        assert_eq!(case["document"]["schemaVersion"], 5);
        assert_eq!(case["strictComparable"], true);
    }
    let backdrop = &case(&cases, "backdrop-blur")["document"]["nodes"]["lens"]["effects"][0];
    assert_eq!((backdrop["kind"].as_str(), backdrop["radius"].as_f64()), (Some("background-blur"), Some(4.)));
}

#[test]
fn issue_179_appearance_stays_within_the_measured_ceilings() {
    let cases = cases();
    for &(id, profile, pixels, max) in CEILINGS {
        let case = case(&cases, id);
        let (got_pixels, got_max) = gap(&render(case, profile), &reference(case));
        assert!(
            got_pixels <= pixels && got_max <= max,
            "{id}/{profile}: pixels {got_pixels} ceiling {pixels}, max {got_max} ceiling {max}"
        );
    }
}
