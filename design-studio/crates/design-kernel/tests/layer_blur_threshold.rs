use futureox_design_kernel::Engine;
use serde_json::json;
use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn render_figma(document: serde_json::Value, width: u32, height: u32, zoom: f64, transparent: bool) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&document.to_string()).unwrap();
    let options = engine
        .parse_options(json!({
            "pageId": "p",
            "width": width,
            "height": height,
            "view": {"x": 0, "y": 0, "zoom": zoom},
            "transparent": transparent,
            "rasterProfile": "figma"
        }))
        .unwrap();
    engine.render(&options).unwrap()
}

#[test]
fn fine_sdr_layer_blur_activates_at_half_an_output_pixel() {
    // Real browser probes: r=.499 at 1x is unchanged; r=.5 at 1x,
    // r=.25 at 2x and r=.125 at 4x all spread into neighboring pixels.
    for profile in ["figma", "figmaSubpixel"] {
        for zoom in [1., 2., 4.] {
            for radius in [0., 0.1249, 0.125, 0.249, 0.25, 0.499, 0.5] {
                let mut doc = json!({"schemaVersion":4,"id":"d","name":"threshold",
                    "pages":[{"id":"p","name":"p","background":"#000000","children":["a"]}],
                    "nodes":{"a":{"id":"a","kind":"rectangle","width":1,"height":4,
                        "transform":[1,0,0,1,3,2],"fills":[{"kind":"solid","color":"#ffffff"}],
                        "effects":[{"kind":"blur","radius":radius,"color":"#000000"}]}}});
                let mut e = Engine::new();
                e.load_document(&doc.to_string()).unwrap();
                let options = e
                    .parse_options(json!({"pageId":"p","width":(8.*zoom) as u32,
                    "height":(8.*zoom) as u32,"view":{"x":0,"y":0,"zoom":zoom},
                    "rasterProfile":profile}))
                    .unwrap();
                let actual = e.render(&options).unwrap();
                let scene = e.compile_gpu(&options).unwrap();
                let active = radius * zoom >= 0.5;
                assert_eq!(
                    scene.nodes["a"].effects[0].radius > 0.,
                    active,
                    "GPU parameter compiler: {profile}, r={radius}, zoom={zoom}"
                );
                doc["nodes"]["a"]["effects"] = json!([]);
                e.load_document(&doc.to_string()).unwrap();
                let unblurred = e.render(&options).unwrap();
                assert_eq!(
                    actual != unblurred,
                    active,
                    "CPU pixels: {profile}, r={radius}, zoom={zoom}"
                );
            }
        }
    }
}

#[test]
fn managed_blur_does_not_inherit_an_sdr_figma_observation() {
    for profile in ["analytic", "figma", "figmaSubpixel"] {
        let doc = json!({"schemaVersion":4,"id":"d","name":"managed",
            "colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},
            "pages":[{"id":"p","name":"p","background":"#000000","children":["a"]}],
            "nodes":{"a":{"id":"a","kind":"rectangle","width":1,"height":1,
                "fills":[{"kind":"solid","color":"color(srgb-linear 4 0 0)"}],
                "effects":[{"kind":"blur","radius":0.125,"color":"#000000"}]}}});
        let mut e = Engine::new();
        e.load_document(&doc.to_string()).unwrap();
        let options = e
            .parse_options(json!({"pageId":"p","width":4,"height":4,
            "view":{"x":1,"y":1,"zoom":1},"transparent":true,"rasterProfile":profile}))
            .unwrap();
        assert_eq!(
            e.compile_gpu(&options).unwrap().nodes["a"].effects[0].radius,
            0.125
        );
        assert!(
            e.render_linear(&options)
                .unwrap()
                .iter()
                .filter(|p| p.0[0] > 0.)
                .count()
                > 1
        );
    }
}

fn difference(actual: &[u8], expected: &[u8]) -> (usize, u8) {
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
fn issue_282_frozen_layer_blur_references() {
    let root = repo_root();
    let specs = [
        ("frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json", "BlurThreshold-0p5-1x"),
        ("frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json", "BlurThreshold-0p25-2x"),
        ("frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json", "BlurThreshold-0p251-2x"),
        ("frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json", "BlurThreshold-0p333-2x"),
        ("frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json", "BlurThreshold-0p499-2x"),
        ("frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json", "BlurThreshold-0p5-2x"),
        ("frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json", "BlurThreshold-0p125-4x"),
        ("frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json", "BlurThreshold-0p249-4x"),
        ("frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json", "BlurThreshold-0p25-4x"),
        ("frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json", "BlurThreshold-0p5-4x"),
        ("frontend/design-client/public/fidelity/browser-2026-10-07/cases.json", "layer-blur"),
        ("frontend/design-client/public/fidelity/combined-2026-10-08/cases.json", "BlurQA-0p5"),
        ("frontend/design-client/public/fidelity/combined-2026-10-08/cases.json", "BlurQA-0p75"),
        ("frontend/design-client/public/fidelity/combined-2026-10-08/cases.json", "BlurQA-1"),
        ("frontend/design-client/public/fidelity/combined-2026-10-08/cases.json", "BlurQA-1p5"),
        ("frontend/design-client/public/fidelity/combined-2026-10-08/cases.json", "BlurQA-2p5"),
        ("frontend/design-client/public/fidelity/combined-2026-10-08/cases.json", "BlurQA-4"),
        ("frontend/design-client/public/fidelity/combined-2026-10-08/cases.json", "BlurQA-8"),
        ("frontend/design-client/public/fidelity/combined-2026-10-08/cases.json", "BlurQA-16"),
    ];
    let mut report = Vec::new();
    for (manifest, id) in specs {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(root.join(manifest)).unwrap()).unwrap();
        let case = cases.into_iter().find(|case| case["id"] == id).unwrap();
        let reference = root
            .join(manifest)
            .parent()
            .unwrap()
            .join(case["reference"].as_str().unwrap());
        let expected = image::open(&reference).unwrap().into_rgba8();
        let width = case["options"]["width"].as_u64().unwrap() as u32;
        let height = case["options"]["height"].as_u64().unwrap() as u32;
        let zoom = case["options"]["view"]["zoom"].as_f64().unwrap();
        let actual = render_figma(case["document"].clone(), width, height, zoom, false);
        assert_eq!(actual.len(), expected.as_raw().len(), "{id}");
        let (pixels, max) = difference(&actual, expected.as_raw());
        report.push(format!("{id} {pixels} {max}"));
    }
    // These are the pixels where the frozen Figma PNG is not constant inside a
    // tent column that any linear filter must keep constant. The quantize-once
    // export matches that column's rounded value; it does not reproduce the
    // PNG's own ±1 scatter, and a few columns span three codes so the max
    // distance stays 2. Lock the measured remainder so it cannot grow.
    assert_eq!(
        report.join("\n"),
        [
            "BlurThreshold-0p5-1x 16 1",
            "BlurThreshold-0p25-2x 42 1",
            "BlurThreshold-0p251-2x 74 1",
            "BlurThreshold-0p333-2x 169 1",
            "BlurThreshold-0p499-2x 316 1",
            "BlurThreshold-0p5-2x 352 1",
            "BlurThreshold-0p125-4x 234 1",
            "BlurThreshold-0p249-4x 643 1",
            "BlurThreshold-0p25-4x 939 1",
            "BlurThreshold-0p5-4x 1341 2",
            "layer-blur 1415 1",
            "BlurQA-0p5 16 1",
            "BlurQA-0p75 57 1",
            "BlurQA-1 116 1",
            "BlurQA-1p5 78 1",
            "BlurQA-2p5 210 2",
            "BlurQA-4 215 2",
            "BlurQA-8 372 1",
            "BlurQA-16 1091 1",
        ]
        .join("\n")
    );
}

#[test]
fn figma_half_pixel_layer_blur_rounds_the_flat_row_after_the_pair_average() {
    // Frozen BlurQA-0p5 row y=64. Per-pass ties-even stored 212; the reference
    // majority on that flat column is 213, and the side columns are 21.
    let path = repo_root().join("frontend/design-client/public/fidelity/combined-2026-10-08/cases.json");
    let cases: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let case = cases.into_iter().find(|case| case["id"] == "BlurQA-0p5").unwrap();
    let actual = render_figma(case["document"].clone(), 128, 128, 1., false);
    let row = 64 * 128;
    assert_eq!(
        &actual[(row + 62) * 4..(row + 65) * 4],
        &[21, 21, 21, 255, 213, 213, 213, 255, 21, 21, 21, 255]
    );
}

#[test]
fn figma_layer_blur_keeps_a_constant_interior_source_over() {
    // Radius 1 does not reach the center of this rect. Blurring must not
    // composite the backdrop early: normal and multiply interiors stay equal
    // to the sharp stack. The rejected pair-average bake turned
    // [170, 0, 85, 192] into a second composite.
    for blend in ["normal", "multiply"] {
        let scene = |radius: f64| {
            json!({
                "schemaVersion": 4, "id": "stack", "name": "stack",
                "pages": [{"id": "p", "name": "p", "background": "#000000", "children": ["red", "blue"]}],
                "nodes": {
                    "red": {"id": "red", "kind": "rectangle", "width": 32, "height": 32,
                        "fills": [{"kind": "solid", "color": "#ff0000", "opacity": 0.5}]},
                    "blue": {"id": "blue", "kind": "rectangle", "width": 16, "height": 16,
                        "transform": [1, 0, 0, 1, 8, 8], "blend": blend,
                        "fills": [{"kind": "solid", "color": "#0000ff", "opacity": 0.75}],
                        "effects": if radius > 0.0 {
                            json!([{"kind": "blur", "radius": radius, "color": "#000000"}])
                        } else {
                            json!([])
                        }}
                }
            })
        };
        let sharp = render_figma(scene(0.0), 32, 32, 1., true);
        let blurred = render_figma(scene(1.0), 32, 32, 1., true);
        let center = (16 * 32 + 16) * 4;
        assert_eq!(
            &blurred[center..center + 4],
            &sharp[center..center + 4],
            "{blend}"
        );
    }
}
