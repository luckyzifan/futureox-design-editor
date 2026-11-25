//! Official Figma smooth-corner vectors and booleans of those rounded rectangles.
//! The frozen PNGs are exact: no channel tolerance. Hardware GPU is not part
//! of this crate test.
use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn fidelity() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../frontend/design-client/public/fidelity")
}

fn cases(relative: &str) -> Vec<Value> {
    serde_json::from_str(&std::fs::read_to_string(fidelity().join(relative)).unwrap()).unwrap()
}

fn png(case_dir: &str, case: &Value) -> Vec<u8> {
    let path = fidelity()
        .join(case_dir)
        .join(case["reference"].as_str().unwrap());
    let bytes = std::fs::read(&path).unwrap();
    let digest = Sha256::digest(&bytes);
    let digest: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    assert_eq!(
        digest,
        case["referenceSha256"].as_str().unwrap(),
        "{}",
        path.display()
    );
    image::open(path).unwrap().into_rgba8().into_raw()
}

fn render_profile(document: &Value, options: &Value, profile: &str) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&document.to_string()).unwrap();
    let mut options = options.clone();
    options["rasterProfile"] = json!(profile);
    let options: RenderOptions = serde_json::from_value(options).unwrap();
    engine.render(&options).unwrap()
}

fn render(document: &Value, options: &Value) -> Vec<u8> {
    render_profile(document, options, "figma")
}

fn gap(actual: &[u8], expected: &[u8]) -> (usize, u8) {
    assert_eq!(actual.len(), expected.len());
    let mut pixels = 0usize;
    let mut max = 0u8;
    for (actual, expected) in actual.chunks_exact(4).zip(expected.chunks_exact(4)) {
        let mut any = false;
        for (left, right) in actual.iter().zip(expected) {
            let delta = left.abs_diff(*right);
            max = max.max(delta);
            any |= delta != 0;
        }
        pixels += usize::from(any);
    }
    (pixels, max)
}

fn boolean_document(case: &Value, operation: &str, copies: usize) -> Value {
    let mut document = case["document"].clone();
    let source = document["nodes"]["n"].clone();
    let mut child = source.clone();
    child["transform"] = json!([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    document["nodes"]["n"] = child.clone();
    let mut children = vec!["n".to_string()];
    if copies == 2 {
        let mut twin = child;
        twin["id"] = json!("n2");
        document["nodes"]["n2"] = twin;
        children.push("n2".into());
    }
    document["nodes"]["bool"] = json!({
        "id": "bool",
        "kind": "vector",
        "booleanOperation": operation,
        "width": source["width"],
        "height": source["height"],
        "transform": source["transform"],
        "fills": source["fills"],
        "children": children,
    });
    document["pages"][0]["children"] = json!(["bool"]);
    document
}

#[test]
fn official_smooth_corner_vectors_and_rounded_booleans_match_figma_pngs() {
    let rectangles = cases("curves-2026-10-07/cases.json");
    let flattened = cases("curves-2026-10-07/flattened-cases.json");
    assert_eq!(rectangles.len(), 16);
    assert_eq!(flattened.len(), 16);
    let mut failures = Vec::new();
    for (rectangle, flat) in rectangles.iter().zip(&flattened) {
        let id = rectangle["id"].as_str().unwrap();
        let rect_png = png("curves-2026-10-07", rectangle);
        let flat_png = png("curves-2026-10-07", flat);
        let options = &rectangle["options"];
        let live = render(&rectangle["document"], options);
        let vector = render(&flat["document"], options);
        for (label, actual, expected) in [
            ("rectangle", &live, &rect_png),
            ("flattened", &vector, &flat_png),
        ] {
            let result = gap(actual, expected);
            if result != (0, 0) {
                failures.push(format!("{id} {label} {result:?}"));
            }
        }
        let white = vec![255u8; rect_png.len()];
        for (operation, copies, expect_shape) in [
            ("union", 1, true),
            ("union", 2, true),
            ("intersect", 1, true),
            ("intersect", 2, true),
            ("subtract", 1, true),
            ("exclude", 1, true),
            ("subtract", 2, false),
            ("exclude", 2, false),
        ] {
            let actual = render(&boolean_document(rectangle, operation, copies), options);
            let result = if expect_shape {
                gap(&actual, &rect_png)
            } else {
                gap(&actual, &white)
            };
            if result != (0, 0) {
                failures.push(format!("{id} {operation} x{copies} {result:?}"));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn official_alpha_mask_and_smooth_corner_frames_stay_exact() {
    let browser = cases("browser-2026-10-07/cases.json");
    for id in ["alpha-mask", "smooth-corner"] {
        let case = browser.iter().find(|case| case["id"] == id).unwrap();
        let expected = png("browser-2026-10-07", case);
        let profiles: &[_] = if id == "alpha-mask" {
            &["figma", "figmaSoftware"]
        } else {
            &["figma"]
        };
        for profile in profiles {
            let mut options = case["options"].clone();
            options["rasterProfile"] = json!(profile);
            let mut engine = Engine::new();
            engine.load_document(&case["document"].to_string()).unwrap();
            let options: RenderOptions = serde_json::from_value(options).unwrap();
            let actual = engine.render(&options).unwrap();
            assert_eq!(gap(&actual, &expected), (0, 0), "{id} {profile}");
        }
    }
}

#[test]
fn software_export_resolves_official_colored_curves_exactly() {
    let sources = [
        ("curves-2026-10-07", "cases.json", "curve-"),
        ("curves-2026-10-07", "flattened-cases.json", "curve-"),
    ];
    let mut failures = Vec::new();
    let mut count = 0;
    for (directory, manifest, prefix) in sources {
        for case in cases(&format!("{directory}/{manifest}")) {
            let id = case["id"].as_str().unwrap();
            if !id.starts_with(prefix) {
                continue;
            }
            assert_eq!(case["strictComparable"], true, "{id}");
            let expected = png(directory, &case);
            let actual = render_profile(&case["document"], &case["options"], "figmaSoftware");
            let delta = gap(&actual, &expected);
            if delta != (0, 0) {
                failures.push(format!("{id} {delta:?}"));
            }
            count += 1;
        }
    }
    assert_eq!(count, 32);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn zero_texture_radius_keeps_software_gradient_pixels() {
    let case = cases("material-parameters-2026-10-08/cases.json")
        .into_iter()
        .find(|case| case["id"] == "MaterialQA-texture-neutral")
        .unwrap();
    let mut untextured = case["document"].clone();
    assert_eq!(untextured["nodes"]["a"]["effects"][0]["radius"], 0);
    untextured["nodes"]["a"]["effects"] = json!([]);
    let actual = render_profile(&case["document"], &case["options"], "figmaSoftware");
    let ordinary = render_profile(&untextured, &case["options"], "figmaSoftware");
    assert_eq!(gap(&actual, &ordinary), (0, 0));
}

#[test]
fn software_color_coverage_proof_preserves_deep_glass_bytes() {
    use futureox_design_kernel::math::Rect;
    let curve = &cases("curves-2026-10-07/cases.json")[0];
    let glass = cases("material-parameters-2026-10-08/cases.json")
        .into_iter()
        .find(|case| case["id"] == "MaterialQA-depth-24")
        .unwrap();
    for (case, allowed) in [(curve, true), (&glass, false)] {
        let mut engine = Engine::new();
        engine.load_document(&case["document"].to_string()).unwrap();
        let mut options = case["options"].clone();
        options["rasterProfile"] = json!("figmaSoftware");
        let options: RenderOptions = serde_json::from_value(options).unwrap();
        let whole = engine.compile_gpu(&options).unwrap();
        // The crop is outside the lens. It still uses the whole-page proof.
        let crop = engine.compile_gpu_region(&options, Rect::new(0, 0, 16, 16), None).unwrap();
        for scene in [whole, crop] {
            let resolve = serde_json::to_value(scene.resolve).unwrap();
            assert_eq!(resolve["softwareColorCoverage"].as_bool(), allowed.then_some(true), "{}", case["id"]);
        }
    }
    let expected = png("material-parameters-2026-10-08", &glass);
    let actual = render_profile(&glass["document"], &glass["options"], "figmaSoftware");
    assert_eq!(gap(&actual, &expected), (1464, 2));
    // Complete RGBA output from the frozen baseline, before endpoint inference.
    assert_eq!(
        Sha256::digest(&actual).iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
        "992b3ef648d1208fb8af11ef58cf8d85dbb1fdf99187cfc8d47d88d7b36bb7c5",
    );
}
