//! Issue 179. Glass frost and full glass on the figma profile match the frozen
//! Chrome PNGs. The software profile's separable byte lerp on the glass filter
//! axis, and its separable read of the finished capture, were a code high.
//! Those two reads now use the joint Q4 sample that the exact export already
//! matches. Downsample and the filter store stay on the software byte contract.
//!
//! Measured on this Linux CPU build against browser-2026-10-07 (PNG checksums
//! unchanged). Backdrop is unchanged. figmaSoftware glass pixel counts fell;
//! the max channel did not.
//!
//! | case | profile | main pixels / max | candidate |
//! | --- | --- | ---: | ---: |
//! | glass-frost-only | figmaSoftware | 2536 / 2 | 1690 / 2 |
//! | glass-full | figmaSoftware | 2077 / 3 | 1579 / 3 |
use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// (case, profile, max different pixels, max channel). Inclusive ceilings.
const CEILINGS: &[(&str, &str, usize, u8)] = &[
    ("backdrop-blur", "figma", 3887, 7),
    ("backdrop-blur", "figmaSoftware", 3974, 7),
    ("glass-frost-only", "figma", 0, 0),
    ("glass-frost-only", "figmaSoftware", 1690, 2),
    ("glass-full", "figma", 0, 0),
    ("glass-full", "figmaSoftware", 1579, 3),
];

/// Cases that were exact on main and must stay exact.
const EXACT: &[(&str, &str)] = &[
    ("integer-rectangle", "figma"),
    ("integer-rectangle", "figmaSoftware"),
    ("fractional-rectangle", "figma"),
    ("fractional-rectangle", "figmaSoftware"),
    ("ellipse", "figma"),
    ("rotated-rectangle", "figma"),
    ("smooth-corner", "figma"),
    ("multiply-opacity", "figma"),
    ("outside-stroke", "figma"),
    ("blur-small", "figma"),
    ("blur-small", "figmaSoftware"),
    ("alpha-mask", "figma"),
    ("alpha-mask", "figmaSoftware"),
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
fn previously_exact_chrome_references_stay_exact() {
    let cases = cases();
    for &(id, profile) in EXACT {
        let case = case(&cases, id);
        let (pixels, max) = gap(&render(case, profile), &reference(case));
        assert_eq!((pixels, max), (0, 0), "{id}/{profile}");
    }
}

fn manifest(relative: &str) -> (std::path::PathBuf, Vec<Value>) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../frontend/design-client/public/fidelity")
        .join(relative);
    let cases = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    (path, cases)
}

fn reference_of(manifest: &std::path::Path, case: &Value) -> Vec<u8> {
    let path = manifest.parent().unwrap().join(case["reference"].as_str().unwrap());
    let bytes = std::fs::read(&path).unwrap();
    let digest = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(digest, case["referenceSha256"].as_str().unwrap());
    image::open(path).unwrap().into_rgba8().into_raw()
}

/// Legacy frost documents keep amount 0 / opacity 0 and no glass struct.
/// That subset is Figma's default depth 8, zero dispersion and light angle 45,
/// with the one-unit frost minimum. The frozen PNGs are unchanged.
#[test]
fn legacy_zero_refraction_frost_matches_the_frozen_pngs() {
    let specs = [
        ("combined-2026-10-08/cases.json", "glass-frost-only"),
        ("combined-2026-10-08/cases.json", "MaterialQA-frost-quarter"),
        ("combined-2026-10-08/cases.json", "MaterialQA-frost-1"),
        ("combined-2026-10-08/cases.json", "MaterialQA-frost-4"),
        ("materials-2026-10-08/cases.json", "MaterialQA-frost-quarter"),
        ("materials-2026-10-08/cases.json", "MaterialQA-frost-1"),
        ("materials-2026-10-08/cases.json", "MaterialQA-frost-4"),
    ];
    for (file, id) in specs {
        let (path, cases) = manifest(file);
        let case = case(&cases, id);
        let effect = &case["document"]["nodes"]
            .as_object()
            .unwrap()
            .values()
            .find_map(|node| node["effects"].as_array())
            .unwrap()[0];
        assert!(effect.get("glass").is_none(), "{id} keeps the legacy frost fields");
        assert_eq!(effect["amount"], 0);
        assert_eq!(effect["opacity"], 0);
        let (pixels, max) = gap(&render(case, "figma"), &reference_of(&path, case));
        assert_eq!((pixels, max), (0, 0), "{file} {id}");
    }
}

#[test]
fn legacy_nonzero_amount_is_not_a_full_glass_mapping() {
    let fx: futureox_design_kernel::scene::Effect = serde_json::from_value(json!({
        "kind": "glass", "radius": 4, "amount": 4, "opacity": 0.5, "color": "#000000"
    }))
    .unwrap();
    assert!(fx.evaluated_glass().is_none());
    assert_eq!(fx.backdrop_radius(), 4.);
    let mut frost: futureox_design_kernel::scene::Effect = serde_json::from_value(json!({
        "kind": "glass", "radius": 0.25, "amount": 0, "opacity": 0, "color": "#000000"
    }))
    .unwrap();
    let glass = frost.evaluated_glass().unwrap();
    assert_eq!(
        (glass.depth, glass.refraction, glass.dispersion, glass.light_angle, glass.light_intensity),
        (8., 0., 0., 45., 0.)
    );
    assert_eq!(frost.backdrop_radius(), 1.);
    assert_eq!(frost.radius, 0.25);
    frost.radius = 4.;
    assert_eq!(frost.backdrop_radius(), 4.);
}

#[test]
fn issue_179_appearance_stays_within_the_measured_ceilings() {
    let cases = cases();
    for &(id, profile, pixels, max) in CEILINGS {
        let case = case(&cases, id);
        let (got_pixels, got_max) = gap(&render(case, profile), &reference(case));
        eprintln!("issue179 {id}/{profile}: pixels {got_pixels} max {got_max}");
        assert!(
            got_pixels <= pixels && got_max <= max,
            "{id}/{profile}: pixels {got_pixels} ceiling {pixels}, max {got_max} ceiling {max}"
        );
        if profile == "figmaSoftware" && (id == "glass-frost-only" || id == "glass-full") {
            let previous = if id == "glass-frost-only" { 2536 } else { 2077 };
            assert!(
                got_pixels < previous,
                "{id} did not improve on main's {previous} software pixels: {got_pixels}"
            );
        }
    }
}
