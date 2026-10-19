use futureox_design_kernel::{
    Engine,
    blend::{Pixel, Surface},
    material::{GlassMaterial, texture},
    math::{Rect, Transform},
    scene::{Effect, TextureParameters},
};
use serde_json::json;

#[test]
fn default_texture_field_uses_the_same_centered_q19_program_as_capture() {
    let rect = Rect::new(0, 0, 12, 10);
    let params = TextureParameters {
        noise_size: [8., 16.],
        clip_to_shape: false,
        noise: None,
    };
    let field = futureox_design_kernel::material::texture_field_at(
        rect,
        16.,
        &params,
        Transform::default(),
        [6., 5.],
    )
    .unwrap();
    for y in 0..10 {
        for x in 0..12 {
            let expected = futureox_design_kernel::texture_noise::displacement(
                [x as f32 + 0.5 - 6., y as f32 + 0.5 - 5.],
                [8., 16.],
                8.,
            )
            .unwrap()
            .offset;
            let i = (y * 12 + x) * 4;
            assert_eq!(
                [field[i].to_bits(), field[i + 1].to_bits()],
                expected.map(f32::to_bits)
            );
        }
    }
    for noise in ["gabor", "perlin"] {
        let custom = TextureParameters {
            noise: Some(noise.into()),
            ..params.clone()
        };
        assert_ne!(
            field,
            futureox_design_kernel::material::texture_field_at(
                rect,
                16.,
                &custom,
                Transform::default(),
                [6., 5.]
            )
            .unwrap()
        );
    }
}

#[test]
fn material_parameters_are_validated_and_require_schema5() {
    let mut cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/material-scenes.json"
    ))
    .unwrap();
    let document = &mut cases[0]["document"];
    let mut engine = Engine::new();
    engine.load_document(&document.to_string()).unwrap();
    document["schemaVersion"] = json!(4);
    assert!(engine.load_document(&document.to_string()).is_err());
    document["schemaVersion"] = json!(5);
    document["nodes"]["a"]["effects"][0]["glass"]["dispersion"] = json!(1.01);
    assert!(
        engine
            .load_document(&document.to_string())
            .unwrap_err()
            .contains("glass")
    );
    document["nodes"]["a"]["effects"][0]["glass"]["dispersion"] = json!(0);
    document["nodes"]["a"]["effects"][0]["kind"] = json!("texture");
    assert!(
        engine
            .load_document(&document.to_string())
            .unwrap_err()
            .contains("glass")
    );
}

#[test]
fn clipped_texture_preserves_translucent_interior_and_excludes_outside_coverage() {
    let mut source = Surface::new(Rect::new(0, 0, 32, 32)).unwrap();
    for y in 6..26 {
        for x in 6..26 {
            source.pixels[(y * 32 + x) as usize] = Pixel::rgba(0.2, 0.5, 0.8, 0.5);
        }
    }
    let parameters = TextureParameters {
        noise_size: [8., 16.],
        clip_to_shape: true,
        noise: None,
    };
    let out = texture(&source, 4., &parameters, Transform::default(), true).unwrap();
    assert_eq!(out.at(16, 16), source.at(16, 16));
    for y in 0..32 {
        for x in 0..32 {
            if source.at(x, y).0[3] == 0. {
                assert_eq!(out.at(x, y), Pixel::default());
            }
        }
    }
    let unclipped = texture(
        &source,
        4.,
        &TextureParameters {
            clip_to_shape: false,
            ..parameters.clone()
        },
        Transform::default(),
        true,
    )
    .unwrap();
    assert!(
        (0..32)
            .any(|y| (0..32).any(|x| source.at(x, y).0[3] == 0. && unclipped.at(x, y).0[3] > 0.))
    );
    assert_eq!(
        texture(&source, 0., &parameters, Transform::default(), true)
            .unwrap()
            .pixels,
        source.pixels
    );
}

#[test]
fn clipped_texture_preserves_a_faint_uniform_fill() {
    let mut source = Surface::new(Rect::new(0, 0, 32, 32)).unwrap();
    let original = Pixel::rgba(0.2, 0.5, 0.8, 1. / 255.);
    source.pixels.fill(original);
    let parameters = TextureParameters {
        noise_size: [8., 16.],
        clip_to_shape: true,
        noise: None,
    };
    let out = texture(&source, 4., &parameters, Transform::default(), true).unwrap();
    assert_eq!(out.at(16, 16), original);
}

#[test]
fn glass_controls_are_independent_and_angle_wrap_is_exact() {
    let mut fx: Effect =
        serde_json::from_value(json!({"kind":"glass","radius":3,"color":"#000000",
        "glass":{"depth":8,"refraction":0.5,"dispersion":0.3,"lightAngle":0,"lightIntensity":0.5}}))
        .unwrap();
    let first = GlassMaterial::new(&fx, 2.);
    assert_eq!(first.depth, 16.);
    assert_eq!(first.direction, [0., -1.]);
    fx.radius = 17.;
    assert_eq!(GlassMaterial::new(&fx, 2.).uniforms(), first.uniforms());
    fx.glass.as_mut().unwrap().light_angle = 450.;
    assert_eq!(GlassMaterial::new(&fx, 2.).direction, [1., 0.]);
    fx.glass.as_mut().unwrap().refraction = 0.;
    assert!(fx.glass_active());
    fx.glass.as_mut().unwrap().dispersion = 0.;
    fx.glass.as_mut().unwrap().light_intensity = 0.;
    assert!(!fx.glass_active());
}

#[test]
fn glass_frost_minimum_does_not_change_authored_parameters() {
    let mut fx: Effect =
        serde_json::from_value(json!({"kind":"glass","radius":0,"color":"#000000",
        "glass":{"depth":8,"refraction":0,"dispersion":0,"lightAngle":0,"lightIntensity":0}}))
        .unwrap();
    assert_eq!(fx.backdrop_radius(), 1.);
    assert!(futureox_design_kernel::scene::selected_backdrop(&[fx.clone()]).is_some());
    assert_eq!(fx.radius, 0.);
    fx.radius = 0.5;
    assert_eq!(fx.backdrop_radius(), 1.);
    fx.radius = 4.;
    assert_eq!(fx.backdrop_radius(), 4.);
    fx.kind = "background-blur".into();
    fx.glass = None;
    fx.radius = 0.;
    assert_eq!(fx.backdrop_radius(), 0.);
}

#[test]
fn animated_materials_interpolate_and_cannot_bypass_schema_validation() {
    use futureox_design_kernel::{
        animation::{self, Clip, Easing, Keyframe, Pose, Repeat, Sample, Track},
        scene::Document,
    };
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/material-scenes.json"
    ))
    .unwrap();
    let mut doc: Document = serde_json::from_value(cases[7]["document"].clone()).unwrap();
    let mut a = Pose::from(&doc.nodes["a"]);
    a.effects[0].glass.as_mut().unwrap().light_angle = 350.;
    let mut b = a.clone();
    let g = b.effects[0].glass.as_mut().unwrap();
    g.light_angle = 10.;
    g.depth = 24.;
    g.dispersion = 0.5;
    doc.animations = vec![Clip {
        id: "material".into(),
        name: "material".into(),
        page_id: "p".into(),
        duration_ms: 1000.,
        delay_ms: 0.,
        repeat: Repeat::Once,
        tracks: vec![Track {
            node_id: "a".into(),
            rotation_turns: 0,
            keyframes: vec![
                Keyframe {
                    time_ms: 0.,
                    value: a,
                    easing: Easing::Linear,
                },
                Keyframe {
                    time_ms: 1000.,
                    value: b,
                    easing: Easing::Linear,
                },
            ],
        }],
    }];
    let original = doc.clone();
    let (sampled, _) = animation::sample(
        &doc,
        &Sample {
            clip_id: "material".into(),
            time_ms: 500.,
        },
    )
    .unwrap();
    let g = sampled.nodes["a"].effects[0].glass.as_ref().unwrap();
    assert_eq!((g.depth, g.dispersion, g.light_angle), (16., 0.25, 360.));
    assert_eq!(doc, original);
    doc.schema_version = 4;
    doc.nodes.get_mut("a").unwrap().effects[0].glass = None;
    assert!(doc.validate().unwrap_err().contains("schema 5"));
}

#[test]
fn four_times_glass_export_respects_memory_budget_and_tile_seams() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../frontend/design-client/public/fidelity/optics-2026-10-08/cases.json"
    ))
    .unwrap();
    let case = cases
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "OpticsQA-frost-4-4x")
        .unwrap();
    let mut engine = Engine::new();
    engine.load_document(&case["document"].to_string()).unwrap();
    let mut request = case["options"].clone();
    request["rasterProfile"] = json!("figma");
    let full = engine
        .render(&engine.parse_options(request.clone()).unwrap())
        .unwrap();
    assert!(engine.stats().peak_compositing_bytes <= 256 * 1024 * 1024);
    assert_eq!(full.len(), 512 * 512 * 4);
    request["width"] = json!(64);
    request["height"] = json!(64);
    request["view"]["x"] = json!(-240);
    request["view"]["y"] = json!(-240);
    let crop = engine
        .render(&engine.parse_options(request).unwrap())
        .unwrap();
    for y in 0..64 {
        let offset = ((240 + y) * 512 + 240) * 4;
        assert_eq!(
            &full[offset..offset + 64 * 4],
            &crop[y * 64 * 4..(y + 1) * 64 * 4],
            "row {y} across both tile seams"
        );
    }
}

#[test]
fn reference_texture_and_legacy_perlin_remain_distinct_materials() {
    let mut source = Surface::new(Rect::new(0, 0, 64, 64)).unwrap();
    for y in 0..64 {
        for x in 0..64 {
            source.pixels[(y * 64 + x) as usize] =
                Pixel::rgba(x as f32 / 63., y as f32 / 63., 0.5, 1.);
        }
    }
    let t = TextureParameters {
        noise_size: [8., 8.],
        clip_to_shape: false,
        noise: None,
    };
    let default = texture(&source, 8., &t, Transform::default(), true).unwrap();
    assert_eq!(
        texture(&source, 8., &t, Transform::default(), true)
            .unwrap()
            .pixels,
        default.pixels,
        "same parameters must give identical pixels"
    );
    let legacy = texture(
        &source,
        8.,
        &TextureParameters {
            noise: Some("perlin".into()),
            ..t.clone()
        },
        Transform::default(),
        true,
    )
    .unwrap();
    assert_ne!(default.pixels, legacy.pixels);
    // The retained Perlin path keeps its established lattice values.
    for (x, y, channel, bits) in [
        (4.0625, 4.0625, 0, 0x3fe08592e7c2978f),
        (4.0625, 4.0625, 1, 0x3fe0b170f4cd7e66),
        (1.25, 3.75, 0, 0x3fe245d3e03ccba4),
        (0.5, 0.5, 1, 0x3fd268a5cfed10a0),
    ] {
        assert_eq!(
            futureox_design_kernel::material::fractal_noise(x, y, channel).to_bits(),
            bits
        );
    }
    let document = |noise: Option<&str>| {
        let texture = match noise {
            Some(n) => json!({"noiseSize":[8,8],"clipToShape":false,"noise":n}),
            None => json!({"noiseSize":[8,8],"clipToShape":false}),
        };
        let mut d = json!({
            "schemaVersion":5,"id":"d","name":"n",
            "pages":[{"id":"p","name":"p","background":"#000000","children":["a"]}],
            "nodes":{"a":{"id":"a","kind":"rectangle","width":8,"height":8,
                "effects":[{"kind":"texture","radius":2,"color":"#000000"}]}}
        });
        d["nodes"]["a"]["effects"][0]["texture"] = texture;
        d
    };
    for noise in [None, Some("gabor"), Some("perlin")] {
        Engine::new()
            .load_document(&document(noise).to_string())
            .unwrap();
    }
    assert!(
        Engine::new()
            .load_document(&document(Some("value")).to_string())
            .is_err()
    );
}
