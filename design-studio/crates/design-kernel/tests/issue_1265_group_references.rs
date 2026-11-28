//! Issue #1265. The five root Figma references that still differ after the
//! pass-through and group-effect work: group-blur, group-inner-shadow,
//! group-shadow, pass-through-blur and large-nested.
//!
//! Measured on the current CPU Figma profile at 1× (different pixels / max
//! channel code) against the committed root manifest:
//!
//! | case | different / total | max |
//! | --- | ---: | ---: |
//! | group-blur | 2,423 / 16,384 | 2 |
//! | group-inner-shadow | 646 / 16,384 | 1 |
//! | group-shadow | 509 / 16,384 | 3 |
//! | pass-through-blur | 3,535 / 16,384 | 2 |
//! | large-nested | 34,683 / 786,432 | 2 |
//!
//! The frozen PNGs are dithered 8-bit Figma exports. A flat interior of a
//! blurred layer carries a device-coordinate noise field that two different
//! references share at the same absolute pixels, and a straight shadow
//! penumbra mixes both codes of its contour. That field is not this kernel's
//! gradient dither lattice, so a deterministic renderer cannot reproduce every
//! pixel of such a reference. Each case therefore keeps the measured
//! `differentPixels` / `maxChannelDelta` as an explicit ceiling instead of
//! silently declaring equality. The references themselves, their SHA-256 pins
//! and sizes come from the committed root manifest; a missing case or changed
//! PNG fails before any rendering. Point `DESIGN_FIGMA_REFERENCES` at a
//! different manifest directory to run the same gate over an external copy;
//! set `ISSUE1265_DUMP=<dir>` to keep the rendered RGBA for diffing.
use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn root() -> std::path::PathBuf {
    if let Some(root) = std::env::var_os("DESIGN_FIGMA_REFERENCES") {
        return root.into();
    }
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../frontend/design-client/public/fidelity")
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn manifest_case(id: &str) -> Value {
    let path = root().join("cases.json");
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|error| panic!("missing root manifest {}: {error}", path.display()));
    let cases: Vec<Value> = serde_json::from_slice(&bytes).unwrap();
    cases
        .into_iter()
        .find(|case| case["id"] == id)
        .unwrap_or_else(|| panic!("root manifest {} is missing {id}", path.display()))
}

fn reference(case: &Value) -> Vec<u8> {
    let path = root().join(case["reference"].as_str().unwrap());
    let png =
        std::fs::read(&path).unwrap_or_else(|_| panic!("missing reference {}", path.display()));
    assert_eq!(
        sha256(&png),
        case["referenceSha256"].as_str().unwrap(),
        "reference {} changed",
        path.display()
    );
    image::load_from_memory(&png)
        .unwrap()
        .into_rgba8()
        .into_raw()
}

fn render(document: &Value, case: &Value) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&document.to_string()).unwrap();
    // The root manifest stores the pinned size only; every case here uses
    // the authored page at 1× zoom with an opaque page.
    let mut options = case["options"].clone();
    options["pageId"] = document["pages"][0]["id"].clone();
    options["view"] = json!({"x": 0, "y": 0, "zoom": 1});
    options["transparent"] = json!(false);
    options["grid"] = json!(false);
    options["rasterProfile"] = json!("figma");
    let options: RenderOptions = serde_json::from_value(options).unwrap();
    engine.render(&options).unwrap()
}

fn gap(actual: &[u8], expected: &[u8]) -> (usize, u8) {
    assert_eq!(actual.len(), expected.len(), "RGBA byte length");
    let mut pixels = 0usize;
    let mut max = 0u8;
    for (a, b) in actual.chunks_exact(4).zip(expected.chunks_exact(4)) {
        let delta = a
            .iter()
            .zip(b)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap_or(0);
        pixels += usize::from(delta != 0);
        max = max.max(delta);
    }
    (pixels, max)
}

fn paint(color: &str) -> Value {
    json!({"kind": "solid", "color": color, "opacity": 1})
}

fn effect(kind: &str) -> Value {
    json!({"kind": kind, "visible": true, "radius": 4, "x": 0, "y": 4,
        "spread": 0, "color": "#000000", "opacity": 0.25, "amount": 0.65})
}

fn blank(name: &str) -> Value {
    json!({
        "schemaVersion": 2, "id": name, "name": name,
        "pages": [{"id": "p", "name": "Page", "background": "#f5f5f5", "children": ["frame"]}],
        "nodes": {}
    })
}

fn add(document: &mut Value, node: Value) -> String {
    let id = node["id"].as_str().unwrap().to_string();
    document["nodes"][&id] = node;
    id
}

/// Mirrors `figma-fixtures.ts`: a 60.4×60.6 group at (8.125, 8.125) holding
/// two identical rectangles; the group carries the effect.
fn group_document(kind: &str) -> Value {
    let mut document = blank(&format!("Core-QA-{kind}"));
    let frame = add(
        &mut document,
        json!({
            "id": "frame", "kind": "frame", "transform": [1, 0, 0, 1, 0, 0],
            "width": 128, "height": 128, "clip": true,
            "fills": [paint("#ffffff")], "children": ["group"]
        }),
    );
    assert_eq!(frame, "frame");
    let black = add(
        &mut document,
        json!({
            "id": "black", "kind": "rectangle", "transform": [1, 0, 0, 1, 0, 0],
            "width": 60.4, "height": 60.6, "fills": [paint("#000000")]
        }),
    );
    let blue = add(
        &mut document,
        json!({
            "id": "blue", "kind": "rectangle", "transform": [1, 0, 0, 1, 0, 0],
            "width": 60.4, "height": 60.6, "fills": [paint("#4477dd")]
        }),
    );
    add(
        &mut document,
        json!({
            "id": "group", "kind": "group", "transform": [1, 0, 0, 1, 8.125, 8.125],
            "width": 60.4, "height": 60.6, "fills": [], "clip": false,
            "children": [black, blue], "effects": [effect(kind)]
        }),
    );
    document
}

/// Mirrors `figma-fixtures.ts`: pass-through group at 50% opacity with a
/// multiply rectangle, a screen rectangle and a 4px layer blur.
fn pass_through_blur_document() -> Value {
    let mut document = blank("Core-QA-pass-through-blur");
    add(
        &mut document,
        json!({
            "id": "frame", "kind": "frame", "transform": [1, 0, 0, 1, 0, 0],
            "width": 128, "height": 128, "clip": true,
            "fills": [paint("#ffffff")], "children": ["bg", "group"]
        }),
    );
    add(
        &mut document,
        json!({
            "id": "bg", "kind": "rectangle", "transform": [1, 0, 0, 1, 0, 0],
            "width": 128, "height": 128, "fills": [paint("#80a0c0")]
        }),
    );
    add(
        &mut document,
        json!({
            "id": "a", "kind": "rectangle", "transform": [1, 0, 0, 1, 0, 0],
            "width": 64, "height": 64, "blend": "multiply", "fills": [paint("#cc8040")]
        }),
    );
    add(
        &mut document,
        json!({
            "id": "b", "kind": "rectangle", "transform": [1, 0, 0, 1, 32, 32],
            "width": 64, "height": 64, "blend": "screen", "fills": [paint("#4080cc")]
        }),
    );
    add(
        &mut document,
        json!({
            "id": "group", "kind": "group", "transform": [1, 0, 0, 1, 16, 16],
            "width": 96, "height": 96, "fills": [], "clip": false,
            "blend": "pass-through", "opacity": 0.5, "children": ["a", "b"],
            "effects": [{"kind": "blur", "radius": 4, "color": "#172033", "opacity": 0.25}]
        }),
    );
    document
}

/// Mirrors `explicitCurve` in `large-reference.ts`: an authored vector network
/// with cubic controls and `evenodd`. `node()` authored the shape as a
/// rectangle/ellipse (no stroke) before the kind was switched to `vector`.
fn curve_node(
    id: &str,
    transform: [f64; 2],
    width: f64,
    height: f64,
    ellipse: bool,
    radius: f64,
    fill: Value,
) -> Value {
    let k = 0.55;
    let points: Vec<[f64; 2]> = if ellipse {
        vec![
            [width, height / 2.],
            [width / 2., height],
            [0., height / 2.],
            [width / 2., 0.],
        ]
    } else {
        let r = radius;
        vec![
            [r, 0.],
            [width - r, 0.],
            [width, r],
            [width, height - r],
            [width - r, height],
            [r, height],
            [0., height - r],
            [0., r],
        ]
    };
    let controls: Vec<Option<[[f64; 2]; 2]>> = if ellipse {
        (0..4)
            .map(|i| {
                let (w, h) = (width, height);
                Some(match i {
                    0 => [[w, h / 2. + k * h / 2.], [w / 2. + k * w / 2., h]],
                    1 => [[w / 2. - k * w / 2., h], [0., h / 2. + k * h / 2.]],
                    2 => [[0., h / 2. - k * h / 2.], [w / 2. - k * w / 2., 0.]],
                    _ => [[w / 2. + k * w / 2., 0.], [w, h / 2. - k * h / 2.]],
                })
            })
            .collect()
    } else {
        let (w, h, r) = (width, height, radius);
        (0..8)
            .map(|i| match i {
                1 => Some([[w - r + k * r, 0.], [w, r - k * r]]),
                3 => Some([[w, h - r + k * r], [w - r + k * r, h]]),
                5 => Some([[r - k * r, h], [0., h - r + k * r]]),
                7 => Some([[0., r - k * r], [r - k * r, 0.]]),
                _ => None,
            })
            .collect()
    };
    let vertices: Vec<Value> = points
        .iter()
        .enumerate()
        .map(|(i, [x, y])| json!({"id": format!("v{i}"), "x": x, "y": y}))
        .collect();
    let edges: Vec<Value> = points
        .iter()
        .enumerate()
        .map(|(i, _)| {
            let mut edge = json!({"id": format!("e{i}"), "from": format!("v{i}"),
                "to": format!("v{}", (i + 1) % points.len())});
            if let Some([[x1, y1], [x2, y2]]) = controls[i] {
                edge["c1"] = json!({"x": x1, "y": y1});
                edge["c2"] = json!({"x": x2, "y": y2});
            }
            edge
        })
        .collect();
    json!({
        "id": id, "kind": "vector",
        "transform": [1, 0, 0, 1, transform[0], transform[1]],
        "width": width, "height": height,
        "fills": [fill], "strokes": [],
        "network": {"fillRule": "evenodd", "vertices": vertices, "edges": edges}
    })
}

/// Mirrors `large-reference.ts`: 280 rounded-rectangle cells with an ellipse,
/// then 36 nested pass-through groups at eighth-pixel offsets.
fn large_nested_document() -> Value {
    let mut document = blank("Core-QA-LargeNested-20261006");
    document["pages"][0]["children"] = json!(["frame"]);
    add(
        &mut document,
        json!({
            "id": "frame", "kind": "frame", "transform": [1, 0, 0, 1, 0, 0],
            "width": 1024, "height": 768, "clip": true,
            "fills": [paint("#ffffff")], "children": []
        }),
    );
    let mut frame_children = Vec::new();
    for index in 0..280 {
        let x = 16. + (index % 20) as f64 * 48.;
        let y = 16. + (index / 20) as f64 * 48.;
        let group = format!("cell{index}");
        let rect = format!("rect{index}");
        let ellipse = format!("ellipse{index}");
        let color = ["#4477cc", "#cc7744", "#559977"][index % 3];
        add(
            &mut document,
            json!({
                "id": group, "kind": "group", "transform": [1, 0, 0, 1, x, y],
                "width": 40, "height": 40, "fills": [], "clip": false,
                "blend": "pass-through", "opacity": if index % 7 == 0 { 0.875 } else { 1. },
                "children": [rect, ellipse]
            }),
        );
        add(
            &mut document,
            curve_node(&rect, [0., 0.], 36., 32., false, 6., paint(color)),
        );
        add(
            &mut document,
            curve_node(
                &ellipse,
                [12.125, 16.125],
                24.,
                20.,
                true,
                0.,
                json!({"kind": "solid", "color": "#eecc77", "opacity": 0.55}),
            ),
        );
        frame_children.push(group);
    }
    let mut parent = "frame".to_string();
    for index in 0..36 {
        let group = format!("depth{index}");
        let x = if index == 0 { 820. } else { 0.125 };
        let y = if index == 0 { 680. } else { 0.125 };
        add(
            &mut document,
            json!({
                "id": group, "kind": "group", "transform": [1, 0, 0, 1, x, y],
                "width": 160, "height": 64, "fills": [], "clip": false,
                "blend": "pass-through", "children": []
            }),
        );
        let parent_id = parent.clone();
        let children = document["nodes"][&parent_id]["children"]
            .as_array_mut()
            .unwrap();
        children.push(json!(group));
        if index == 0 {
            frame_children.push(group.clone());
        }
        parent = group;
    }
    add(
        &mut document,
        curve_node(
            "deep-ellipse",
            [0., 0.],
            60.,
            48.,
            true,
            0.,
            paint("#4477dd"),
        ),
    );
    add(
        &mut document,
        curve_node(
            "deep-rect",
            [32.125, 12.125],
            88.,
            40.,
            false,
            8.,
            json!({"kind": "solid", "color": "#dd4477", "opacity": 0.625}),
        ),
    );
    document["nodes"][&parent]["children"] = json!(["deep-ellipse", "deep-rect"]);
    document["nodes"]["frame"]["children"] = json!(frame_children);
    document
}

/// Mirrors `figma-fixtures.ts`: a plain 20.4×12.6 black rectangle at an
/// eighth-pixel offset. This is the root 0/0 control that must stay exact.
fn rectangle_document() -> Value {
    let mut document = blank("Core-QA-rectangle");
    add(
        &mut document,
        json!({
            "id": "frame", "kind": "frame", "transform": [1, 0, 0, 1, 0, 0],
            "width": 128, "height": 128, "clip": true,
            "fills": [paint("#ffffff")], "children": ["rect"]
        }),
    );
    add(
        &mut document,
        json!({
            "id": "rect", "kind": "rectangle", "transform": [1, 0, 0, 1, 8.125, 8.125],
            "width": 20.4, "height": 12.6, "fills": [paint("#000000")]
        }),
    );
    document
}

fn pass_through_document() -> Value {
    let mut document = blank("Core-QA-pass-through");
    add(
        &mut document,
        json!({
            "id": "frame", "kind": "frame", "transform": [1, 0, 0, 1, 0, 0],
            "width": 128, "height": 128, "clip": true,
            "fills": [paint("#ffffff")], "children": ["bg", "group"]
        }),
    );
    add(
        &mut document,
        json!({
            "id": "bg", "kind": "rectangle", "transform": [1, 0, 0, 1, 0, 0],
            "width": 128, "height": 128, "fills": [paint("#80a0c0")]
        }),
    );
    add(
        &mut document,
        json!({
            "id": "a", "kind": "rectangle", "transform": [1, 0, 0, 1, 0, 0],
            "width": 64, "height": 64, "blend": "multiply", "fills": [paint("#cc8040")]
        }),
    );
    add(
        &mut document,
        json!({
            "id": "b", "kind": "rectangle", "transform": [1, 0, 0, 1, 32, 32],
            "width": 64, "height": 64, "blend": "screen", "fills": [paint("#4080cc")]
        }),
    );
    add(
        &mut document,
        json!({
            "id": "group", "kind": "group", "transform": [1, 0, 0, 1, 16, 16],
            "width": 96, "height": 96, "fills": [], "clip": false,
            "blend": "pass-through", "opacity": 1, "children": ["a", "b"]
        }),
    );
    document
}

/// Mirrors `figma-fixtures.ts`: one curved vector rotated -17° around
/// (58, 45.5). The transform is `around()` from `commands/affine.ts`.
fn rotated_curve_document() -> Value {
    let mut document = blank("Core-QA-rotated-curve");
    add(
        &mut document,
        json!({
            "id": "frame", "kind": "frame", "transform": [1, 0, 0, 1, 0, 0],
            "width": 128, "height": 128, "clip": true,
            "fills": [paint("#ffffff")], "children": ["curve"]
        }),
    );
    add(
        &mut document,
        json!({
            "id": "curve", "kind": "vector",
            "transform": [0.9563047559630354, -0.29237170472273677,
                0.29237170472273677, 0.9563047559630354,
                -10.768588410740577, 18.94569247760062],
            "width": 128, "height": 128, "fills": [paint("#000000")],
            "network": {
                "fillRule": "nonzero",
                "vertices": [{"id": "a", "x": 8, "y": 8}, {"id": "b", "x": 108, "y": 8}],
                "edges": [
                    {"id": "ab", "from": "a", "to": "b",
                        "c1": {"x": 8, "y": 108}, "c2": {"x": 108, "y": 108}},
                    {"id": "ba", "from": "b", "to": "a"}
                ]
            }
        }),
    );
    document
}

#[test]
fn issue_1265_five_group_references_keep_the_measured_ceilings() {
    // Measured on the current main CPU Figma profile. The references are
    // dithered exports: see `root_blur_and_shadow_references_carry_dither`.
    // Ceilings equal the measured values; a case may only improve. The three
    // trailing controls are the root rows that are already bit-exact and must
    // stay exact; they are not evidence for any of the five residual rows.
    let cases: &[(&str, fn() -> Value, usize, u8)] = &[
        ("group-blur", || group_document("blur"), 2423, 2),
        (
            "group-inner-shadow",
            || group_document("inner-shadow"),
            646,
            1,
        ),
        ("group-shadow", || group_document("shadow"), 509, 3),
        ("pass-through-blur", pass_through_blur_document, 3535, 2),
        ("large-nested", large_nested_document, 34683, 2),
        ("rectangle", rectangle_document, 0, 0),
        ("pass-through", pass_through_document, 0, 0),
        ("rotated-curve", rotated_curve_document, 0, 0),
    ];
    for (id, document, pixels, max) in cases {
        let case = manifest_case(id);
        let expected = reference(&case);
        let actual = render(&document(), &case);
        if let Some(dir) = std::env::var_os("ISSUE1265_DUMP") {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                std::path::Path::new(&dir).join(format!("{id}.rgba")),
                &actual,
            )
            .unwrap();
        }
        let (got_pixels, got_max) = gap(&actual, &expected);
        eprintln!(
            "issue1265 {id}: pixels={got_pixels} max={got_max} rgba={}",
            sha256(&actual)
        );
        assert!(
            got_pixels <= *pixels && got_max <= *max,
            "{id} regressed to {got_pixels}/{got_max} from {pixels}/{max}"
        );
    }
}

#[test]
fn root_blur_and_shadow_references_carry_dither() {
    // A flat interior of a blurred layer must keep one code for any linear
    // approximation. Figma's PNG export stores several neighbouring codes
    // instead, which is why the five ceilings above cannot be zero.
    let group = reference(&manifest_case("group-blur"));
    let mut unique = std::collections::BTreeSet::new();
    let mut off = 0;
    for y in 13..63 {
        for x in 13..63 {
            let i = (y * 128 + x) * 4;
            let pixel = [group[i], group[i + 1], group[i + 2]];
            unique.insert(pixel);
            off += usize::from(pixel != [68, 119, 221]);
        }
    }
    eprintln!("dither group-blur interior unique={unique:?} off={off}");
    assert!(
        unique.len() >= 3,
        "group-blur flat interior lost its dither"
    );
    assert!(
        off >= 300,
        "group-blur flat interior no longer covers the measured spread"
    );

    // The same absolute device pixels carry the same noise in the unrelated
    // layer-blur export (blue at (32, 32), 64×48): the field belongs to the
    // effect output on the export lattice, not to one document's content.
    let layer = reference(&manifest_case("layer-blur"));
    let mut shared = 0usize;
    let mut deviating = 0usize;
    for y in 36..60 {
        for x in 36..60 {
            let i = (y * 128 + x) * 4;
            let (a, b) = (group[i + 2], layer[i + 2]);
            shared += usize::from(a == b);
            deviating += usize::from(a != 221);
        }
    }
    eprintln!("dither shared group/layer-blue={shared} deviating={deviating}");
    assert_eq!(
        shared,
        24 * 24,
        "two references disagree on the device noise field"
    );
    assert!(
        deviating >= 100,
        "the shared region lost its measured noise"
    );

    let pass = reference(&manifest_case("pass-through-blur"));
    let mut unique = std::collections::BTreeSet::new();
    let mut off = 0;
    for y in 20..44 {
        for x in 20..44 {
            let i = (y * 128 + x) * 4;
            let pixel = [pass[i], pass[i + 1], pass[i + 2]];
            unique.insert(pixel);
            off += usize::from(pixel != [166, 144, 128]);
        }
    }
    eprintln!("dither pass-through-blur interior unique={unique:?} off={off}");
    assert!(
        unique.len() >= 3,
        "pass-through-blur flat interior lost its dither"
    );
    assert!(
        off >= 50,
        "pass-through-blur flat interior no longer covers the measured spread"
    );

    // The shadow penumbra is a straight horizontal contour; its dither shows
    // as both codes mixed along one row.
    let shadow = reference(&manifest_case("shadow"));
    let values: std::collections::BTreeSet<u8> =
        (40..89).map(|x| shadow[(80 * 128 + x) * 4]).collect();
    eprintln!("dither shadow row 80 values={values:?}");
    assert!(values.len() >= 2, "shadow penumbra row lost its dither");
}
