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

fn render(document: &Value, options: &Value) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&document.to_string()).unwrap();
    let mut options = options.clone();
    options["rasterProfile"] = json!("figma");
    let options: RenderOptions = serde_json::from_value(options).unwrap();
    engine.render(&options).unwrap()
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
