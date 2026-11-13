//! Issue #285. The six smooth-corner references must match the frozen Figma
//! PNGs exactly under rasterProfile=figma. The other curve cases in the same
//! manifest are the non-regression set for this silhouette residual.
use futureox_design_kernel::{Engine, RenderOptions};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn difference(actual: &[u8], expected: &[u8]) -> (usize, u8) {
    assert_eq!(actual.len(), expected.len(), "RGBA length");
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

#[test]
fn smooth_corner_references_match_frozen_figma_pngs() {
    let root = repo_root();
    let fidelity = root.join("frontend/design-client/public/fidelity");
    let mut cases = Vec::new();
    for manifest in [
        fidelity.join("combined-2026-10-08/cases.json"),
        fidelity.join("browser-2026-10-07/cases.json"),
    ] {
        let parsed: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
        for mut case in parsed {
            case["_manifest"] = serde_json::json!(manifest);
            cases.push(case);
        }
    }
    let expected = [
        (
            "curve-1",
            "3d2344f395fb0e4bf03b68afc364d106ce3fbefe57f83cabe58f4b391b8e2cf2",
        ),
        (
            "curve-4",
            "69b40d41cd1ce0082390551841a3e51031091cb78c9c413c2ddc524ca02aea1e",
        ),
        (
            "curve-7",
            "38c1b6ef3a14d18c988c396bf31dfcc610098ece67a869cd4252db7e259de192",
        ),
        (
            "curve-9",
            "87f0a0c07db834fc16aa7b373285c87342d18b2bb60835edb41b8140c035de05",
        ),
        (
            "curve-10",
            "29a20c2a411b3fb101ae5256f2f3fe1a05fcf7edbff205919d6ddde451f0e941",
        ),
        (
            "curve-12",
            "144ba1128f78df729f6fd0390e7b54a24adf91645c78bec20c441cba9df6aa03",
        ),
    ];
    let mut seen = 0usize;
    let mut failures = Vec::new();
    for case in cases.iter().filter(|case| {
        let curve = case["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("curve-"));
        let smooth = case["strictComparable"] == serde_json::json!(true)
            && case.to_string().contains("\"smoothing\"");
        curve || smooth
    }) {
        let id = case["id"].as_str().unwrap();
        let manifest = PathBuf::from(case["_manifest"].as_str().unwrap());
        let reference = manifest
            .parent()
            .unwrap()
            .join(case["reference"].as_str().unwrap());
        let png = std::fs::read(&reference).unwrap();
        if let Some((_, hash)) = expected.iter().find(|(name, _)| *name == id) {
            assert_eq!(sha256(&png), *hash, "{id} reference drifted");
            seen += 1;
        }
        let image = image::load_from_memory(&png).unwrap().to_rgba8();
        let mut engine = Engine::new();
        engine.load_document(&case["document"].to_string()).unwrap();
        let mut options = case["options"].clone();
        options["rasterProfile"] = serde_json::json!("figma");
        let options: RenderOptions = serde_json::from_value(options).unwrap();
        let actual = engine.render(&options).unwrap();
        let (pixels, max) = difference(&actual, image.as_raw());
        if (pixels, max) != (0, 0) {
            let mut where_ = Vec::new();
            let w = image.width() as usize;
            for (i, (a, e)) in actual
                .chunks_exact(4)
                .zip(image.as_raw().chunks_exact(4))
                .enumerate()
            {
                if a != e && where_.len() < 8 {
                    where_.push(format!("({},{}) {:?} vs {:?}", i % w, i / w, a, e));
                }
            }
            failures.push(format!("{id} pixels {pixels} max {max} {where_:?}"));
        }
    }
    assert_eq!(seen, expected.len());
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
