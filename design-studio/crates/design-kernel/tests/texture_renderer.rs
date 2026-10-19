//! Production CPU route controls. These do not broaden the documented source
//! interpolation approximation into a universal hardware-fidelity claim.
use futureox_design_kernel::{
    Engine,
    math::{Rect, Transform},
    renderer::Stats,
    scene::Document,
    texture_replay::{self, TileOutcome},
};
use serde_json::{Value, json};

fn scene(clipped: bool, radius: f64) -> Value {
    json!({"schemaVersion":5,"id":"synthetic-route","name":"synthetic-route",
        "pages":[{"id":"p","name":"p","background":"#ededed","children":["frame"]}],
        "nodes":{
            "frame":{"id":"frame","kind":"frame","width":24,"height":24,"clip":true,
                "transform":[1,0,0,1,1003.25,-40.5],"children":["leaf"],
                "fills":[{"kind":"solid","color":"#ffffff"}]},
            "leaf":{"id":"leaf","kind":"rectangle","width":12,"height":10,
                "transform":[1,0,0,1,5,4],
                "fills":[{"kind":"linear","color":"#4477dd","angle":45,
                    "stops":[{"offset":0,"color":"#4477dd"},{"offset":1,"color":"#dd7744"}]}],
                "effects":[{"kind":"texture","radius":radius,"opacity":1,"color":"#000000",
                    "texture":{"noiseSize":[8,8],"clipToShape":clipped}}]}}})
}
fn render(document: &Value, crop: [u32; 4], profile: &str) -> (Vec<u8>, Stats) {
    let mut engine = Engine::new();
    engine.load_document(&document.to_string()).unwrap();
    let options = engine
        .parse_options(json!({"pageId":"p","width":crop[2],"height":crop[3],
            "view":{"x":-1003.25+4.-f64::from(crop[0]),
                "y":40.5+3.-f64::from(crop[1]),"zoom":1},
            "rasterProfile":profile,"transparent":false,"grid":false}))
        .unwrap();
    let pixels = engine.render(&options).unwrap();
    (pixels, engine.stats().clone())
}
fn without_effect(document: &Value) -> Value {
    let mut plain = document.clone();
    plain["nodes"]["leaf"]["effects"] = json!([]);
    plain
}

#[test]
fn low_radius_replays_plain_paint_once_without_legacy_texture_noise() {
    for solid in [false, true] {
        let mut input = scene(false, 0.49);
        if solid {
            input["nodes"]["leaf"]["fills"] = json!([{"kind":"solid","color":"#2468ac"}]);
        }
        let (expected, _) = render(&without_effect(&input), [0, 0, 32, 32], "figma");
        for radius in [0., 0.125, 0.49] {
            input["nodes"]["leaf"]["effects"][0]["radius"] = json!(radius);
            let (actual, stats) = render(&input, [0, 0, 32, 32], "figma");
            assert_eq!(actual, expected, "solid={solid}, radius={radius}");
            assert_eq!(stats.effect_layers, 0);
            assert!(stats.peak_compositing_bytes < 1024 * 1024);
        }
    }
}

#[test]
fn disabled_texture_on_a_large_zoomed_frame_does_not_enumerate_global_tiles() {
    let mut input = scene(true, 0.);
    input["nodes"]["frame"]["width"] = json!(4112);
    input["nodes"]["frame"]["height"] = json!(4112);
    input["nodes"]["frame"]["transform"] = json!([1, 0, 0, 1, 0, 0]);
    input["nodes"]["leaf"]["width"] = json!(4112);
    input["nodes"]["leaf"]["height"] = json!(4112);
    input["nodes"]["leaf"]["transform"] = json!([1, 0, 0, 1, 0, 0]);
    let render_small = |doc: &Value| {
        let mut engine = Engine::new();
        engine.load_document(&doc.to_string()).unwrap();
        let options = engine
            .parse_options(json!({"pageId":"p","width":8,"height":8,
            "view":{"x":-512,"y":-512,"zoom":16},"rasterProfile":"figma"}))
            .unwrap();
        let pixels = engine.render(&options).unwrap();
        assert_eq!(engine.stats().effect_layers, 0);
        pixels
    };
    let mut disabled = input.clone();
    disabled["nodes"]["leaf"]["effects"][0]["visible"] = json!(false);
    let expected = render_small(&disabled);
    for radius in [0., 0.01] {
        input["nodes"]["leaf"]["effects"][0]["radius"] = json!(radius);
        assert_eq!(render_small(&input), expected);
    }
}

#[test]
fn active_texture_beyond_replay_geometry_scope_keeps_legacy_rendering() {
    let mut input = scene(true, 2.);
    input["nodes"]["frame"]["width"] = json!(4112);
    input["nodes"]["frame"]["height"] = json!(4112);
    input["nodes"]["frame"]["transform"] = json!([1, 0, 0, 1, 0, 0]);
    input["nodes"]["leaf"]["width"] = json!(4112);
    input["nodes"]["leaf"]["height"] = json!(4112);
    input["nodes"]["leaf"]["transform"] = json!([1, 0, 0, 1, 0, 0]);
    let doc: Document = serde_json::from_value(input.clone()).unwrap();
    doc.validate().unwrap();
    let leaf = &doc.nodes["leaf"];
    assert!(
        texture_replay::recipe(
            &doc,
            leaf,
            Transform([32., 0., 0., 32., -1024., -1024.]),
            &leaf.effects[0]
        )
        .unwrap()
        .is_none()
    );
    let render_small = |document: &Value, x: f64| {
        let mut engine = Engine::new();
        engine.load_document(&document.to_string()).unwrap();
        let options = engine
            .parse_options(json!({"pageId":"p","width":8,"height":8,
            "view":{"x":x,"y":-512,"zoom":16},"rasterProfile":"figma"}))
            .unwrap();
        engine.render(&options).unwrap()
    };
    // Smoothing has no geometric effect with all four radii zero. Its
    // unsupported metadata forces the established route without changing the
    // rectangle, paint, effect or requested view.
    let mut legacy = input.clone();
    legacy["nodes"]["leaf"]["smoothing"] = json!(0.25);
    for x in [-512., -520.] {
        assert_eq!(render_small(&input, x), render_small(&legacy, x));
    }
}

#[test]
fn unclipped_capture_keeps_its_halo_and_respects_the_root_clip() {
    let mut input = scene(false, 2.);
    input["nodes"]["leaf"]["fills"] = json!([{"kind":"solid","color":"#2468ac"}]);
    let (unclipped, stats) = render(&input, [0, 0, 32, 32], "figma");
    assert_eq!(stats.effect_layers, 1);
    assert!(stats.peak_compositing_bytes >= 2 * 1024 * 1024 * 4);
    assert!(stats.shaded_pixels > 4 * 12 * 10);
    input["nodes"]["leaf"]["effects"][0]["texture"]["clipToShape"] = json!(true);
    let (clipped, _) = render(&input, [0, 0, 32, 32], "figma");
    let mut halo = 0;
    for y in 0..32 {
        for x in 0..32 {
            let k = (y * 32 + x) * 4;
            if !(4..28).contains(&x) || !(3..27).contains(&y) {
                assert_eq!(&unclipped[k..k + 4], &[237, 237, 237, 255]);
            } else if !(9..21).contains(&x) || !(7..17).contains(&y) {
                assert_eq!(&clipped[k..k + 4], &[255; 4]);
                halo += usize::from(unclipped[k..k + 4] != [255; 4]);
            }
        }
    }
    assert!(
        halo > 0,
        "The leaf mask must not cut the unbounded texture halo"
    );
}

#[test]
fn cropped_export_uses_the_same_capture_phase_for_solid_and_gradient() {
    for solid in [false, true] {
        let mut input = scene(false, 2.);
        if solid {
            input["nodes"]["leaf"]["fills"] = json!([{"kind":"solid","color":"#2468ac"}]);
        }
        let (full, _) = render(&input, [0, 0, 32, 32], "figma");
        let (crop, _) = render(&input, [8, 6, 13, 11], "figma");
        for y in 0..11 {
            assert_eq!(
                &crop[y * 13 * 4..(y + 1) * 13 * 4],
                &full[((y + 6) * 32 + 8) * 4..((y + 6) * 32 + 21) * 4],
                "solid={solid}, row={y}"
            );
        }
    }
}

#[test]
fn unsupported_parent_and_other_profile_keep_the_existing_effect_path() {
    for profile in ["figma", "figmaSubpixel"] {
        let mut input = scene(false, 2.);
        if profile == "figma" {
            input["nodes"]["frame"]["clip"] = json!(false);
        }
        let (actual, stats) = render(&input, [0, 0, 32, 32], profile);
        let (plain, _) = render(&without_effect(&input), [0, 0, 32, 32], profile);
        assert_ne!(
            actual, plain,
            "Unsupported replay must retain the legacy effect"
        );
        assert_eq!(stats.effect_layers, 1);
        assert!(
            stats.peak_compositing_bytes < 2 * 1024 * 1024 * 4,
            "{profile}: unsupported input must not allocate the two fixed capture attachments"
        );
    }
}

#[test]
fn fractional_root_clip_limits_each_sample_before_the_export_resolve() {
    let mut input = scene(false, 4.);
    input["nodes"]["frame"]["transform"] = json!([1, 0, 0, 1, 1003.5, -39.75]);
    input["nodes"]["leaf"]["transform"] = json!([1, 0, 0, 1, 0, 0]);
    input["nodes"]["leaf"]["width"] = json!(24);
    input["nodes"]["leaf"]["height"] = json!(24);
    input["nodes"]["leaf"]["fills"] = json!([{"kind":"solid","color":"#000000"}]);
    let (textured, _) = render(&input, [0, 0, 32, 32], "figma");
    let (opaque_mask, _) = render(&without_effect(&input), [0, 0, 32, 32], "figma");
    let mut partial_edges = 0;
    for (actual, bound) in textured.chunks_exact(4).zip(opaque_mask.chunks_exact(4)) {
        // A displaced black source can uncover white, but cannot cover more
        // of any AA plane than the original opaque black root rectangle.
        for channel in 0..3 {
            assert!(actual[channel] >= bound[channel]);
        }
        partial_edges += usize::from(bound[0] > 0 && bound[0] < 237);
        assert_eq!(actual[3], 255);
    }
    assert!(partial_edges > 0);
}

#[test]
fn tiny_and_halo_only_sources_fall_back_before_partial_replay() {
    for tiny in [true, false] {
        let mut input = scene(false, 2.);
        input["nodes"]["frame"]["width"] = json!(280);
        input["nodes"]["leaf"]["transform"] =
            json!([1, 0, 0, 1, if tiny { 5.125 } else { 242.01 }, 4.125]);
        input["nodes"]["leaf"]["width"] = json!(if tiny { 0.05 } else { 12. });
        input["nodes"]["leaf"]["height"] = json!(if tiny { 0.05 } else { 10. });
        let doc: Document = serde_json::from_value(input.clone()).unwrap();
        let node = &doc.nodes["leaf"];
        let camera = Transform([2., 0., 0., 2., -2006.5 + 8., 81. + 6.]);
        let matrix = camera
            .concat(doc.nodes["frame"].transform)
            .concat(node.transform);
        assert!(
            texture_replay::recipe(&doc, node, matrix, &node.effects[0])
                .unwrap()
                .is_none(),
            "Whole-node eligibility must reject the empty source even before a viewport is selected"
        );
        // Inspect the legal numeric request directly to prove that rejection
        // is caused by mixed source support, not by an unrelated scene rule.
        let root = &doc.nodes["frame"];
        let replay = texture_replay::Replay {
            parent_matrix: camera.concat(root.transform),
            parent_world_transform: root.transform,
            camera_matrix: camera,
            parent_size: [root.width, root.height],
            node_transform: node.transform,
            node_size: [node.width, node.height],
            paint: node.fills[0].clone(),
            radius: 2.,
            noise_size: [8.; 2],
            clipped: false,
        };
        let viewport = Rect::new(0, 0, 600, 64);
        let mut capture = 0;
        let mut unsupported = 0;
        for (origin, _) in replay.tiles(viewport).unwrap() {
            for sample in 0..4 {
                match replay.tile(origin, sample, viewport).unwrap() {
                    TileOutcome::Capture(_) => capture += 1,
                    TileOutcome::Unsupported => unsupported += 1,
                    _ => (),
                }
            }
        }
        assert!(
            capture > 0 && unsupported > 0,
            "The control must exercise mixed eligibility"
        );
        let (actual, stats) = render(&input, [0, 0, 300, 32], "figma");
        let mut old_path = input.clone();
        // This root change rejects replay; the source and its halo are still
        // wholly inside the parent, so ordinary rendering is equivalent.
        old_path["nodes"]["frame"]["clip"] = json!(false);
        let (expected, _) = render(&old_path, [0, 0, 300, 32], "figma");
        assert_eq!(
            actual.iter().zip(&expected).filter(|(a, b)| a != b).count(),
            0,
            "tiny={tiny}: no partially captured prefix"
        );
        assert!(stats.effect_layers > 0, "Fallback must retain TEXTURE");
        assert!(stats.peak_compositing_bytes < 2 * 1024 * 1024 * 4);
        let mut cropped_camera = camera;
        cropped_camera.0[4] -= 8.;
        cropped_camera.0[5] -= 6.;
        assert!(
            texture_replay::recipe(
                &doc,
                node,
                cropped_camera.concat(root.transform).concat(node.transform),
                &node.effects[0],
            )
            .unwrap()
            .is_none(),
            "Cropping must not change whole-node replay eligibility"
        );
        let (crop, crop_stats) = render(&input, [4, 3, 250, 24], "figma");
        let (old_crop, _) = render(&old_path, [4, 3, 250, 24], "figma");
        // The existing fallback itself is not universally crop invariant.
        // Preserve its output for each request; do not silently switch a crop
        // to the new capture path and mistake a changed image for a repair.
        assert_eq!(
            crop.iter().zip(&old_crop).filter(|(a, b)| a != b).count(),
            0,
            "tiny={tiny}: cropped fallback must retain the original renderer"
        );
        assert!(crop_stats.peak_compositing_bytes < 2 * 1024 * 1024 * 4);
    }
}
