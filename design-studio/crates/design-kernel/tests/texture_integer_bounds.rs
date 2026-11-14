//! Issue #178. The browser-2026-10-07 texture fixture is an 88×88 integer
//! rectangle at (20, 20). Real Figma parameters are radius 2, noise size 8 and
//! clip-to-shape; this document keeps the legacy amount-2 mapping. The integer
//! fill itself does not leave the box. Legacy displacement was sampling that
//! fill into the effect halo, which is a different failure from pointwise
//! noise crops.
use futureox_design_kernel::Engine;
use serde_json::{Value, json};

fn texture_case() -> Value {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../frontend/design-client/public/fidelity/browser-2026-10-07/cases.json"
    ))
    .unwrap();
    cases
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == "texture")
        .unwrap()
        .clone()
}

fn render(document: &Value, profile: &str, scale: usize) -> Vec<u8> {
    let case = texture_case();
    let mut options = case["options"].clone();
    options["rasterProfile"] = json!(profile);
    options["width"] = json!(128 * scale);
    options["height"] = json!(128 * scale);
    options["view"]["zoom"] = json!(scale);
    let mut engine = Engine::new();
    engine.load_document(&document.to_string()).unwrap();
    let options = engine.parse_options(options).unwrap();
    let pixels = engine.render(&options).unwrap();
    assert_eq!(pixels.len(), (128 * scale).pow(2) * 4);
    pixels
}

#[test]
fn legacy_texture_sampling_stays_inside_the_authored_integer_rectangle() {
    let case = texture_case();
    let authored = case["document"].clone();
    let mut plain = authored.clone();
    plain["nodes"]["a"]["effects"] = json!([]);
    let (x0, y0, x1, y1) = (20_i32, 20_i32, 108_i32, 108_i32);
    for profile in ["figma", "figmaSoftware", "analytic"] {
        let textured = render(&authored, profile, 1);
        let untextured = render(&plain, profile, 1);
        let mut outside = 0_usize;
        let mut changed_outside = 0_usize;
        let mut changed_inside = 0_usize;
        for y in 0..128 {
            for x in 0..128 {
                let i = ((y * 128 + x) * 4) as usize;
                let inside = (x0..x1).contains(&x) && (y0..y1).contains(&y);
                let textured_px = &textured[i..i + 4];
                let plain_px = &untextured[i..i + 4];
                if inside {
                    changed_inside += usize::from(textured_px != plain_px);
                } else {
                    outside += 1;
                    changed_outside += usize::from(textured_px != plain_px);
                    assert_eq!(
                        plain_px,
                        &[255, 255, 255, 255],
                        "{profile}: the untextured integer rectangle already leaves {x},{y}"
                    );
                }
            }
        }
        assert_eq!(outside, 128 * 128 - 88 * 88);
        assert_eq!(
            changed_outside, 0,
            "{profile}: texture sampling changed pixels outside the authored 88×88 box"
        );
        assert!(
            changed_inside > 0,
            "{profile}: texture must still displace covered texels"
        );
    }
}

#[test]
fn legacy_texture_has_no_empty_texels_inside_an_opaque_shape() {
    let case = texture_case();
    let authored = &case["document"];
    // The independently exported Figma reference has no white background
    // pixels inside the integer rectangle. The random noise itself can differ.
    let reference = image::load_from_memory(include_bytes!(
        "../../../../frontend/design-client/public/fidelity/browser-2026-10-07/texture.png"
    ))
    .unwrap()
    .into_rgba8();
    assert_eq!(reference.dimensions(), (128, 128));
    for y in 20..108 {
        for x in 20..108 {
            assert_ne!(reference.get_pixel(x, y).0, [255; 4]);
        }
    }
    for profile in ["figma", "figmaSoftware", "figmaSubpixel"] {
        for scale in [1, 2, 3] {
            let textured = render(authored, profile, scale);
            let mut holes = 0;
            let mut outside = 0;
            let edge = 20 * scale..108 * scale;
            for (index, pixel) in textured.chunks_exact(4).enumerate() {
                let x = index % (128 * scale);
                let y = index / (128 * scale);
                let inside = edge.contains(&x) && edge.contains(&y);
                holes += usize::from(inside && pixel == [255; 4]);
                outside += usize::from(!inside && pixel != [255; 4]);
            }
            assert_eq!(holes, 0, "{profile} at {scale}x: white texels inside");
            assert_eq!(outside, 0, "{profile} at {scale}x: paint outside");
        }
    }
}
