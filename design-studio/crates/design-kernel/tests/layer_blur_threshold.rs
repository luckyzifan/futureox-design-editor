use futureox_design_kernel::Engine;
use serde_json::json;

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

fn render_figma(
    document: serde_json::Value,
    width: u32,
    height: u32,
    zoom: f64,
    transparent: bool,
) -> Vec<u8> {
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

fn pixel(buf: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * width + x) * 4) as usize;
    [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
}

#[test]
fn issue_282_frozen_layer_blur_references_do_not_regress() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let specs = [
        (
            "frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json",
            "BlurThreshold-0p5-1x",
            18usize,
            1u8,
        ),
        (
            "frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json",
            "BlurThreshold-0p25-2x",
            42,
            1,
        ),
        (
            "frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json",
            "BlurThreshold-0p251-2x",
            430,
            1,
        ),
        (
            "frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json",
            "BlurThreshold-0p333-2x",
            621,
            2,
        ),
        (
            "frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json",
            "BlurThreshold-0p499-2x",
            454,
            1,
        ),
        (
            "frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json",
            "BlurThreshold-0p5-2x",
            378,
            1,
        ),
        (
            "frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json",
            "BlurThreshold-0p125-4x",
            234,
            1,
        ),
        (
            "frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json",
            "BlurThreshold-0p249-4x",
            645,
            1,
        ),
        (
            "frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json",
            "BlurThreshold-0p25-4x",
            865,
            1,
        ),
        (
            "frontend/design-client/public/fidelity/blur-threshold-2026-10-08/cases.json",
            "BlurThreshold-0p5-4x",
            1344,
            2,
        ),
        (
            "frontend/design-client/public/fidelity/browser-2026-10-07/cases.json",
            "layer-blur",
            1782,
            1,
        ),
        (
            "frontend/design-client/public/fidelity/combined-2026-10-08/cases.json",
            "BlurQA-0p5",
            18,
            1,
        ),
        (
            "frontend/design-client/public/fidelity/combined-2026-10-08/cases.json",
            "BlurQA-0p75",
            57,
            1,
        ),
        (
            "frontend/design-client/public/fidelity/combined-2026-10-08/cases.json",
            "BlurQA-1",
            114,
            1,
        ),
        (
            "frontend/design-client/public/fidelity/combined-2026-10-08/cases.json",
            "BlurQA-1p5",
            212,
            1,
        ),
        (
            "frontend/design-client/public/fidelity/combined-2026-10-08/cases.json",
            "BlurQA-2p5",
            296,
            2,
        ),
        (
            "frontend/design-client/public/fidelity/combined-2026-10-08/cases.json",
            "BlurQA-4",
            213,
            2,
        ),
        (
            "frontend/design-client/public/fidelity/combined-2026-10-08/cases.json",
            "BlurQA-8",
            361,
            2,
        ),
        (
            "frontend/design-client/public/fidelity/combined-2026-10-08/cases.json",
            "BlurQA-16",
            1079,
            1,
        ),
    ];
    // Issue #282 baselines. A case may not gain different pixels or max channel error.
    let baselines = [
        99usize, 364, 704, 621, 454, 378, 896, 645, 865, 1344, 1782, 99, 57, 114, 212, 296, 213,
        361, 1079,
    ];
    let baseline_max = [2u8, 1, 1, 2, 1, 1, 1, 1, 1, 2, 1, 2, 1, 1, 1, 2, 2, 2, 1];
    for (index, (manifest, id, expect_pixels, expect_max)) in specs.iter().enumerate() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(root.join(manifest)).unwrap()).unwrap();
        let case = cases.into_iter().find(|case| case["id"] == *id).unwrap();
        let reference = root
            .join(manifest)
            .parent()
            .unwrap()
            .join(case["reference"].as_str().unwrap());
        let expected = image::open(reference).unwrap().into_rgba8();
        let width = case["options"]["width"].as_u64().unwrap() as u32;
        let height = case["options"]["height"].as_u64().unwrap() as u32;
        let zoom = case["options"]["view"]["zoom"].as_f64().unwrap();
        let actual = render_figma(case["document"].clone(), width, height, zoom, false);
        assert_eq!(actual.len(), expected.as_raw().len(), "{id}");
        let (pixels, max) = difference(&actual, expected.as_raw());
        assert!(
            pixels <= baselines[index] && max <= baseline_max[index],
            "{id} regressed to {pixels}/{max} from {}/{}",
            baselines[index],
            baseline_max[index]
        );
        assert_eq!((pixels, max), (*expect_pixels, *expect_max), "{id}");
    }
}

#[test]
fn half_pixel_layer_blur_export_row_is_half_up_of_the_constant_column() {
    // Frozen BlurQA-0p5 interior. Per-pass ties-even stored 212 on the flat
    // column; the reference majority is 213. Side columns stay 21.
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../frontend/design-client/public/fidelity/combined-2026-10-08/cases.json");
    let cases: Vec<serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let case = cases
        .into_iter()
        .find(|case| case["id"] == "BlurQA-0p5")
        .unwrap();
    let actual = render_figma(case["document"].clone(), 128, 128, 1., false);
    assert_eq!(
        pixel(&actual, 128, 62, 64),
        [21, 21, 21, 255]
    );
    assert_eq!(
        pixel(&actual, 128, 63, 64),
        [213, 213, 213, 255]
    );
    assert_eq!(
        pixel(&actual, 128, 64, 64),
        [21, 21, 21, 255]
    );
}

#[test]
fn later_opaque_cover_of_one_device_sample_does_not_see_a_flattened_pair() {
    // Output pixel x=62 is device samples 124 (black) and 125 (blur value 42).
    // An opaque rect from x=62.5 covers only device 125. The resolved pixel is
    // red over black, so green stays 0. Flattening that pair to 21 before the
    // later layer would leave green near 10.
    let scene = json!({
        "schemaVersion": 4, "id": "edge", "name": "edge",
        "pages": [{"id": "p", "name": "p", "background": "#000000", "children": ["frame"]}],
        "nodes": {
            "frame": {"id": "frame", "kind": "frame", "width": 128, "height": 128, "clip": true,
                "fills": [{"kind": "solid", "color": "#000000", "opacity": 1}],
                "children": ["bar", "cover"]},
            "bar": {"id": "bar", "kind": "rectangle", "width": 1, "height": 96,
                "transform": [1, 0, 0, 1, 63, 16],
                "fills": [{"kind": "solid", "color": "#ffffff", "opacity": 1}],
                "effects": [{"kind": "blur", "radius": 0.5, "color": "#000000"}]},
            "cover": {"id": "cover", "kind": "rectangle", "width": 2, "height": 20,
                "transform": [1, 0, 0, 1, 62.5, 40],
                "fills": [{"kind": "solid", "color": "#ff0000", "opacity": 1}]}
        }
    });
    let actual = render_figma(scene, 128, 128, 1., false);
    let edge = pixel(&actual, 128, 62, 50);
    assert_eq!(edge[1], 0, "green leaked from a flattened blur sample: {edge:?}");
    assert_eq!(edge[2], 0, "blue leaked from a flattened blur sample: {edge:?}");
    assert!(
        (100..=160).contains(&edge[0]) && edge[3] == 255,
        "partial red cover: {edge:?}"
    );
    assert_eq!(
        pixel(&actual, 128, 63, 50),
        [255, 0, 0, 255],
        "opaque later layer must replace the blur"
    );
}

#[test]
fn translucent_overlay_composites_once_on_the_rounded_blur() {
    let blur_only = render_figma(blur_scene(false), 128, 128, 1., false);
    let stacked = render_figma(blur_scene(true), 128, 128, 1., false);
    let center = pixel(&blur_only, 128, 63, 64);
    assert_eq!(center, [213, 213, 213, 255]);
    // 50% red over the blur, in the same UNORM8 source-over the painter uses.
    let expected = over_half_red(center);
    assert_eq!(pixel(&stacked, 128, 63, 64), expected);
    // A second composite of the blur under the red would not match this.
    let double = over_half_red(over_half_red(center));
    assert_ne!(expected, double);
}

fn blur_scene(overlay: bool) -> serde_json::Value {
    let mut document = json!({
        "schemaVersion": 4, "id": "veil", "name": "veil",
        "pages": [{"id": "p", "name": "p", "background": "#000000", "children": ["frame"]}],
        "nodes": {
            "frame": {"id": "frame", "kind": "frame", "width": 128, "height": 128, "clip": true,
                "fills": [{"kind": "solid", "color": "#000000", "opacity": 1}],
                "children": ["bar"]},
            "bar": {"id": "bar", "kind": "rectangle", "width": 1, "height": 96,
                "transform": [1, 0, 0, 1, 63, 16],
                "fills": [{"kind": "solid", "color": "#ffffff", "opacity": 1}],
                "effects": [{"kind": "blur", "radius": 0.5, "color": "#000000"}]}
        }
    });
    if overlay {
        document["nodes"]["frame"]["children"]
            .as_array_mut()
            .unwrap()
            .push(json!("veil"));
        document["nodes"]["veil"] = json!({
            "id": "veil", "kind": "rectangle", "width": 128, "height": 128,
            "fills": [{"kind": "solid", "color": "#ff0000", "opacity": 0.5}]
        });
    }
    document
}

fn over_half_red(dst: [u8; 4]) -> [u8; 4] {
    // Matches Pixel::over_rgba8 for normal mode, source red at opacity 0.5.
    let src = [255u32, 0, 0, 255];
    let weight = (0.5_f32 * 65535.).round_ties_even() as u32;
    const DENOMINATOR: u32 = 255 * 65535;
    std::array::from_fn(|c| {
        let numerator = u32::from(dst[c]) * (DENOMINATOR - src[3] * weight) + src[c] * 255 * weight;
        let q = numerator / DENOMINATOR;
        let remainder = numerator % DENOMINATOR;
        (q + u32::from(remainder * 2 > DENOMINATOR)) as u8
    })
}

#[test]
fn frame_clip_keeps_the_page_clear_of_layer_blur() {
    let scene = json!({
        "schemaVersion": 4, "id": "clip", "name": "clip",
        "pages": [{"id": "p", "name": "p", "background": "#00ff00", "children": ["frame"]}],
        "nodes": {
            "frame": {"id": "frame", "kind": "frame", "width": 60, "height": 128, "clip": true,
                "fills": [{"kind": "solid", "color": "#000000", "opacity": 1}],
                "children": ["bar"]},
            "bar": {"id": "bar", "kind": "rectangle", "width": 1, "height": 96,
                "transform": [1, 0, 0, 1, 58, 16],
                "fills": [{"kind": "solid", "color": "#ffffff", "opacity": 1}],
                "effects": [{"kind": "blur", "radius": 4, "color": "#000000"}]}
        }
    });
    let actual = render_figma(scene, 128, 128, 1., false);
    assert_eq!(pixel(&actual, 128, 80, 64), [0, 255, 0, 255]);
    assert_eq!(pixel(&actual, 128, 70, 20), [0, 255, 0, 255]);
    let inside = pixel(&actual, 128, 58, 64);
    assert_ne!(inside, [0, 255, 0, 255], "blur was clipped away entirely");
    assert!(inside[0] > 0, "blur did not reach the bar: {inside:?}");
}
