//! Issue #283. Partial paint opacity on a measured linear gradient must match
//! the frozen Chrome PNG. The authored opacity stays the f64 image of that
//! f32 value; the compare stays exact.
use futureox_design_kernel::{Engine, RenderOptions};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

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
    let mut pixels = 0;
    let mut max = 0_u8;
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

fn render_case(case: &serde_json::Value) -> Vec<u8> {
    let mut engine = Engine::new();
    engine
        .load_document(&case["document"].to_string())
        .expect("document");
    let mut options = case["options"].clone();
    options["rasterProfile"] = serde_json::json!("figma");
    let options: RenderOptions = serde_json::from_value(options).expect("options");
    engine.render(&options).expect("render")
}

fn strict_cases(root: &Path) -> Vec<(String, serde_json::Value, PathBuf)> {
    let fidelity = root.join("frontend/design-client/public/fidelity");
    let mut directories: Vec<_> = std::fs::read_dir(&fidelity)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.join("cases.json").is_file())
        .collect();
    directories.sort();
    let mut cases = Vec::new();
    for directory in directories {
        let manifest = directory.join("cases.json");
        let parsed: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
        for case in parsed {
            if case.get("strictComparable") != Some(&serde_json::json!(true)) {
                continue;
            }
            let Some(name) = case["reference"].as_str() else {
                continue;
            };
            let reference = manifest.parent().unwrap().join(name);
            let reference = reference.canonicalize().unwrap();
            assert!(
                reference.starts_with(fidelity.canonicalize().unwrap()),
                "reference escaped fidelity directory"
            );
            let id = format!(
                "{}/{}",
                directory.file_name().unwrap().to_string_lossy(),
                case["id"].as_str().unwrap()
            );
            cases.push((id, case, reference));
        }
    }
    cases
}

#[test]
fn partial_opacity_linear_gradient_matches_frozen_chrome_png() {
    let root = repo_root();
    let cases = strict_cases(&root);
    assert!(
        cases.len() > 200,
        "strict reference set shrank: {}",
        cases.len()
    );
    let mut lines = Vec::new();
    let mut linear = Vec::new();
    for (id, case, reference) in &cases {
        let expected = image::open(reference).unwrap().into_rgba8();
        assert_eq!(
            (expected.width(), expected.height()),
            (
                case["options"]["width"].as_u64().unwrap() as u32,
                case["options"]["height"].as_u64().unwrap() as u32
            )
        );
        let actual = render_case(case);
        let (pixels, max) = difference(&actual, expected.as_raw());
        if id.ends_with("/linear-gradient") {
            let opacity = case["document"]["nodes"]["a"]["fills"][0]["opacity"]
                .as_f64()
                .unwrap();
            assert_eq!(opacity.to_bits(), 0.7300000190734863_f64.to_bits());
            assert_ne!(opacity.to_bits(), 0.73_f64.to_bits());
            let png = std::fs::read(reference).unwrap();
            assert_eq!(
                sha256(&png),
                "b2e440261bec79d3821a9ae91683da6a1cad0e309265a36cb4ec39126433e386"
            );
            linear.push((id.clone(), pixels, max));
        }
        lines.push(format!("{id} {pixels} {max}"));
    }
    lines.sort();
    let others = lines
        .iter()
        .filter(|line| !line.contains("/linear-gradient "))
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    let others_sha = sha256(others.as_bytes());
    eprintln!("strict cases {}", lines.len());
    for (id, pixels, max) in &linear {
        eprintln!("linear-gradient {id} pixels {pixels} max {max}");
    }
    eprintln!("other strict sha256 {others_sha}");
    assert!(
        linear.len() == 2
            && linear
                .iter()
                .all(|(_, pixels, max)| *pixels == 0 && *max == 0),
        "linear-gradient {linear:?}"
    );
    // Digest of "directory/id differentPixels maxChannelError" for every other
    // strict figma CPU reference. Recomputed after the smooth-corner coverage
    // residual: the six previously non-zero curve rows are now zero, and no
    // other row moved.
    assert_eq!(
        others_sha, "223846cf65b816201aa9a83ab12272eca90204843356a63385246676d7f0ae28",
        "other frozen figma references moved"
    );
}
