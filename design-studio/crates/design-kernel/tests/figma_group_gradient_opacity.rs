//! Isolating group opacity around an opaque measured linear gradient.
//! The Chrome phase control is the oracle: quantize the gradient, scale the
//! bytes, then source-over. The frozen PNG is not rewritten.
use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
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
    for (actual, expected) in actual.chunks_exact(4).zip(expected.chunks_exact(4)) {
        let mut local = 0u8;
        for (left, right) in actual.iter().zip(expected) {
            local = local.max(left.abs_diff(*right));
        }
        if local != 0 {
            pixels += 1;
            max = max.max(local);
        }
    }
    (pixels, max)
}

fn srgb(rgba: [f64; 4]) -> String {
    let channel = |value: f64| format!("{}", value as f32);
    format!(
        "color(srgb {} {} {} / {})",
        channel(rgba[0]),
        channel(rgba[1]),
        channel(rgba[2]),
        channel(rgba[3])
    )
}

fn render(document: &Value, width: u32, height: u32) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&document.to_string()).unwrap();
    let options: RenderOptions = serde_json::from_value(json!({
        "pageId": "p",
        "width": width,
        "height": height,
        "view": {"x": 0, "y": 0, "zoom": 1},
        "transparent": false,
        "rasterProfile": "figma"
    }))
    .unwrap();
    engine.render(&options).unwrap()
}

fn stops(node: &Value) -> ([f64; 4], [f64; 4]) {
    let stops = node["fills"][0]["gradientStops"].as_array().unwrap();
    let color = |stop: &Value| {
        let color = &stop["color"];
        [
            color["r"].as_f64().unwrap(),
            color["g"].as_f64().unwrap(),
            color["b"].as_f64().unwrap(),
            color["a"].as_f64().unwrap(),
        ]
    };
    (color(&stops[0]), color(&stops[1]))
}

fn linear(id: &str, x: f64, y: f64, width: f64, height: f64, opacity: f64, start: [f64; 4], end: [f64; 4]) -> Value {
    json!({
        "id": id,
        "kind": "rectangle",
        "transform": [1, 0, 0, 1, x, y],
        "width": width,
        "height": height,
        "opacity": 1,
        "fills": [{
            "kind": "linear",
            "color": "#000000",
            "angle": 0,
            "opacity": opacity,
            "stops": [
                {"offset": 0, "color": srgb(start)},
                {"offset": 1, "color": srgb(end)}
            ]
        }]
    })
}

fn phase_document(record: &Value) -> (u32, u32, Value) {
    let width = record["width"].as_u64().unwrap() as u32;
    let height = record["height"].as_u64().unwrap() as u32;
    let child = &record["children"][0];
    let (nodes, root_children) = if child["type"] == "FRAME" {
        let rect = &child["children"][0];
        let (start, end) = stops(rect);
        let gradient = linear(
            "a",
            0.,
            0.,
            rect["width"].as_f64().unwrap(),
            rect["height"].as_f64().unwrap(),
            1.,
            start,
            end,
        );
        let group = json!({
            "id": "g",
            "kind": "frame",
            "transform": [1, 0, 0, 1, child["x"].as_f64().unwrap(), child["y"].as_f64().unwrap()],
            "width": child["width"].as_f64().unwrap(),
            "height": child["height"].as_f64().unwrap(),
            "clip": true,
            "opacity": child["opacity"].as_f64().unwrap(),
            "blend": "normal",
            "fills": [],
            "children": ["a"]
        });
        (json!({"frame": {}, "g": group, "a": gradient}), json!(["g"]))
    } else {
        let (start, end) = stops(child);
        let gradient = linear(
            "a",
            child["x"].as_f64().unwrap(),
            child["y"].as_f64().unwrap(),
            child["width"].as_f64().unwrap(),
            child["height"].as_f64().unwrap(),
            child["fills"][0]["opacity"].as_f64().unwrap_or(1.),
            start,
            end,
        );
        (json!({"frame": {}, "a": gradient}), json!(["a"]))
    };
    let mut document = json!({
        "schemaVersion": 4,
        "id": "d",
        "name": "phase",
        "pages": [{"id": "p", "name": "Page", "background": "#ffffff", "children": ["frame"]}],
        "nodes": nodes
    });
    document["nodes"]["frame"] = json!({
        "id": "frame",
        "kind": "frame",
        "width": width,
        "height": height,
        "clip": true,
        "fills": [{"kind": "solid", "color": "#ffffff", "opacity": 1}],
        "children": root_children
    });
    (width, height, document)
}

#[test]
fn isolating_group_opacity_matches_the_official_phase_png() {
    let root = repo();
    let fixture: Value = serde_json::from_slice(
        &std::fs::read(root.join("testing/fixtures/design/figma-phase-controls-2026-10-08.json")).unwrap(),
    )
    .unwrap();
    let directory = root.join("frontend/design-client/public/fidelity/phase-controls-2026-10-08");
    for record in fixture["records"].as_array().unwrap() {
        let name = record["name"].as_str().unwrap();
        let png = std::fs::read(directory.join(format!("{name}.png"))).unwrap();
        let expected_hash = match name {
            "PhaseQA-main-513x257" => "ad94728d8e2cd47982fbb2ee88682b604cf0a5bc4506e88131587da66c31100b",
            "PhaseQA-offset-282x270" => "da0fca5a31b78321f2aa1891077ff0e1105ba415789903bbdceca70869ee1a5d",
            "PhaseQA-isolated-282x270" => "6bfc9cb388649e835ef60bfc3d24deec5585f9e69005acffc7c0975abc404cc2",
            other => panic!("unexpected phase control {other}"),
        };
        assert_eq!(sha256(&png), expected_hash, "{name}");
        let image = image::load_from_memory(&png).unwrap().into_rgba8();
        let (width, height, document) = phase_document(record);
        assert_eq!(image.dimensions(), (width, height));
        let actual = render(&document, width, height);
        let (pixels, max) = gap(&actual, image.as_raw());
        assert_eq!((pixels, max), (0, 0), "{name}");
    }
}

#[test]
fn paint_opacity_gradient_and_direct_composites_stay_exact() {
    let path = repo().join("frontend/design-client/public/fidelity/browser-2026-10-07/cases.json");
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    for id in ["linear-gradient", "multiply-opacity", "outside-stroke", "integer-rectangle"] {
        let case = cases.iter().find(|case| case["id"] == id).unwrap();
        let reference = path.parent().unwrap().join(case["reference"].as_str().unwrap());
        let png = std::fs::read(&reference).unwrap();
        assert_eq!(sha256(&png), case["referenceSha256"].as_str().unwrap(), "{id}");
        let image = image::load_from_memory(&png).unwrap().into_rgba8();
        let mut engine = Engine::new();
        engine.load_document(&case["document"].to_string()).unwrap();
        let mut options = case["options"].clone();
        options["rasterProfile"] = json!("figma");
        let options: RenderOptions = serde_json::from_value(options).unwrap();
        let actual = engine.render(&options).unwrap();
        let (pixels, max) = gap(&actual, image.as_raw());
        assert_eq!((pixels, max), (0, 0), "{id}");
    }
}
