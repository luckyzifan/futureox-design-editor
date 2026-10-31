use futureox_design_kernel::{
    Engine, RenderOptions,
    animation::{self, Clip, Easing, Keyframe, Pose, Repeat, Sample, Track},
    math::Transform,
    scene::Document,
};
use serde_json::json;
#[test]
fn named_easing_roundtrips_the_editor_wire_format() {
    for family in ["sine", "quad", "cubic", "quart", "quint", "expo", "circ"] {
        for direction in ["in", "out", "in-out"] {
            let value = json!({"kind":"named", "name":format!("ease-{direction}-{family}")});
            let easing: Easing = serde_json::from_value(value.clone()).unwrap();
            easing.validate().unwrap();
            assert_eq!(serde_json::to_value(&easing).unwrap(), value);
            assert_eq!(easing.sample(0., 1000.), 0.);
            assert_eq!(easing.sample(1., 1000.), 1.);
            assert!(easing.sample(0.25, 1000.).is_finite());
        }
    }
    let bad: Easing = serde_json::from_value(json!({"kind":"named","name":"unknown"})).unwrap();
    assert!(bad.validate().is_err());
}
fn document() -> Document {
    serde_json::from_value(json!({"schemaVersion":1,"id":"d","name":"animation","pages":[{"id":"p","name":"p","background":"#ffffff","children":["r"]}],"nodes":{"r":{"id":"r","kind":"rectangle","width":20,"height":16,"fills":[{"kind":"solid","color":"#4488cc"}],"transform":[1,0,0,1,12.125,9.375]}}})).unwrap()
}
fn animated() -> Document {
    let mut d = document();
    let a = Pose::from(&d.nodes["r"]);
    let mut b = a.clone();
    b.transform = Transform([-1., 0., 0., -1., 68.125, 48.375]);
    b.opacity = 0.25;
    b.fills[0].color = "#ee8844".into();
    b.radii = [4.; 4];
    d.animations = vec![Clip {
        id: "move".into(),
        name: "Move".into(),
        page_id: "p".into(),
        duration_ms: 1000.,
        delay_ms: 0.,
        repeat: Repeat::Once,
        tracks: vec![Track {
            node_id: "r".into(),
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
    d
}

#[test]
fn compiled_tile_cache_isolated_by_animation_sample_and_restoration() {
    let source=serde_json::to_string(&animated()).unwrap();
    let mut cached=Engine::new();cached.load_document(&source).unwrap();
    let viewport=futureox_design_kernel::math::Rect::new(0,0,128,96);
    for time in [Some(0.),Some(500.),Some(1000.),None] {
        let mut options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":128,"height":96,
            "view":{"x":0.,"y":0.,"zoom":1.},"rasterProfile":"figmaSubpixel"})).unwrap();
        options.animation=time.map(|time_ms|Sample{clip_id:"move".into(),time_ms});
        let actual=cached.compile_gpu_region(&options,viewport,Some(viewport)).unwrap().into_packet().unwrap();
        let mut fresh=Engine::new();fresh.load_document(&source).unwrap();
        let expected=fresh.compile_gpu_region(&options,viewport,None).unwrap().into_packet().unwrap();
        assert!(actual==expected,"stale compiled geometry for sample {time:?}");
    }
}
fn sample(d: &Document, t: f64) -> Document {
    animation::sample(
        d,
        &Sample {
            clip_id: "move".into(),
            time_ms: t,
        },
    )
    .unwrap()
    .0
}
#[test]
fn transform_interpolation_preserves_rotation_and_base_document() {
    let d = animated();
    let original = d.clone();
    let mid = sample(&d, 500.);
    let m = mid.nodes["r"].transform.0;
    assert!(
        m[0].abs() < 1e-12
            && (m[1] - 1.).abs() < 1e-12
            && (m[2] + 1.).abs() < 1e-12
            && m[3].abs() < 1e-12
    );
    assert!(mid.nodes["r"].transform.inverse().is_ok());
    assert_eq!(mid.nodes["r"].opacity, 0.625);
    assert_eq!(d, original);
    assert_eq!(
        Pose::from(&sample(&d, 0.).nodes["r"]),
        d.animations[0].tracks[0].keyframes[0].value
    );
    assert_eq!(
        Pose::from(&sample(&d, 1000.).nodes["r"]),
        d.animations[0].tracks[0].keyframes[1].value
    );
    assert_eq!(sample(&d, 375.), sample(&d, 375.));
}

#[test]
fn unmanaged_srgb_alpha_animation_preserves_transparency_without_parsing_as_hex() {
    let mut doc = animated();
    doc.animations[0].tracks[0].keyframes[0].value.fills[0].color = "color(srgb 1 0 0 / 0.25)".into();
    doc.animations[0].tracks[0].keyframes[1].value.fills[0].color = "#ff0000".into();
    let sampled = sample(&doc, 500.);
    let color = futureox_design_kernel::color::unmanaged_straight(&sampled.nodes["r"].fills[0].color).unwrap();
    assert_eq!(color, [1., 0., 0., 0.625]);
    assert!(sampled.color_management.is_none());
}
#[test]
fn easing_curves_are_absolute_time_and_handle_all_damping_regimes() {
    let linear = Easing::Cubic {
        x1: 0.,
        y1: 0.,
        x2: 1.,
        y2: 1.,
    };
    for t in [0.01, 0.1, 0.3, 0.7, 0.99] {
        assert!((linear.sample(t, 1000.) - t).abs() < 1e-12);
    }
    let ease = Easing::Cubic {
        x1: 0.42,
        y1: 0.,
        x2: 0.58,
        y2: 1.,
    };
    assert!((ease.sample(0.5, 1000.) - 0.5).abs() < 1e-12);
    assert!(ease.sample(0.25, 1000.) < 0.25);
    for damping in [0., 10., 20., 40., 100000.] {
        let e = Easing::Spring {
            mass: 1.,
            stiffness: 100.,
            damping,
            velocity: 0.,
        };
        e.validate().unwrap();
        assert_eq!(e.sample(0., 1000.), 0.);
        assert_eq!(e.sample(1., 1000.), 1.);
        for i in 1..100 {
            assert!(e.sample(i as f64 / 100., 1000.).is_finite());
        }
    }
    assert!(
        Easing::Spring {
            mass: 1.,
            stiffness: 100.,
            damping: 10.,
            velocity: 0.
        }
        .sample(0.4, 1000.)
            > 1.
    );
    assert_eq!(Easing::Hold.sample(0.99, 1000.), 0.);
    assert_eq!(Easing::Hold.sample(1., 1000.), 1.);
}
#[test]
fn delay_loop_and_alternate_have_defined_boundary_samples() {
    let mut d = animated();
    d.animations[0].delay_ms = 200.;
    assert_eq!(sample(&d, 100.), sample(&d, 200.));
    let end = sample(&d, 1200.);
    d.animations[0].repeat = Repeat::Alternate;
    assert_eq!(
        Pose::from(&sample(&d, 1200.).nodes["r"]),
        Pose::from(&end.nodes["r"])
    );
    assert_eq!(sample(&d, 700.), sample(&d, 1700.));
    assert_eq!(sample(&d, 2200.), sample(&d, 200.));
    d.animations[0].repeat = Repeat::Loop;
    assert_eq!(sample(&d, 200.), sample(&d, 1200.));
    assert_eq!(sample(&d, 700.), sample(&d, 2700.));
}
#[test]
fn invalid_tracks_and_incompatible_topology_are_rejected() {
    let base = animated();
    for mutate in [0, 1, 2, 3, 4, 5, 6] {
        let mut d = base.clone();
        match mutate {
            0 => d.animations[0].tracks[0].keyframes[1].time_ms = 0.,
            1 => d.animations[0].tracks[0].node_id = "missing".into(),
            2 => d.animations[0].duration_ms = 0.,
            3 => {
                d.animations[0].tracks[0].keyframes[1].value.transform =
                    Transform([1., 0., 0., -1., 0., 0.])
            }
            4 => d.animations[0].tracks[0].rotation_turns = i32::MIN,
            5 => {
                d.animations[0].tracks[0].keyframes[0].easing = Easing::Cubic {
                    x1: 2.,
                    y1: 0.,
                    x2: 1.,
                    y2: 1.,
                }
            }
            _ => d.animations[0].tracks[0].keyframes[1].value.effects.push(
                serde_json::from_value(json!({"kind":"blur","color":"#000000","radius":2}))
                    .unwrap(),
            ),
        };
        assert!(d.validate().is_err(), "case {mutate}");
    }
    assert!(
        animation::sample(
            &base,
            &Sample {
                clip_id: "move".into(),
                time_ms: f64::NAN
            }
        )
        .is_err()
    );
}
#[test]
fn renderer_seek_stop_and_error_recovery_restore_geometry() {
    let d = animated();
    let mut engine = Engine::new();
    engine
        .load_document(&serde_json::to_string(&d).unwrap())
        .unwrap();
    let mut options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":96,"height":72,"transparent":true,"view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figma"})).unwrap();
    let initial = engine.render(&options).unwrap();
    for time in [0., 1000., 500., 250., 750., 0.] {
        options.animation = Some(Sample {
            clip_id: "move".into(),
            time_ms: time,
        });
        let pixels = engine.render(&options).unwrap();
        let mut other = Engine::new();
        let mut sampled = sample(&d, time);
        sampled.animations.clear();
        other
            .load_document(&serde_json::to_string(&sampled).unwrap())
            .unwrap();
        let mut plain = options.clone();
        plain.animation = None;
        assert_eq!(pixels, other.render(&plain).unwrap());
    }
    options.animation = Some(Sample {
        clip_id: "missing".into(),
        time_ms: 0.,
    });
    assert!(engine.render(&options).is_err());
    options.animation = None;
    assert_eq!(initial, engine.render(&options).unwrap());
    engine
        .load_document(&serde_json::to_string(&document()).unwrap())
        .unwrap();
    assert_eq!(initial, engine.render(&options).unwrap());
}

// Keep GPU-scene compilation outside CPU-only acceptance runs.
#[test]
fn gpu_compile_animation_then_document_reload_restores_geometry() {
    let mut engine = Engine::new();
    engine
        .load_document(&serde_json::to_string(&animated()).unwrap())
        .unwrap();
    let mut options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":96,"height":72,"transparent":true,"view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figma"})).unwrap();
    let initial = engine.render(&options).unwrap();
    options.animation = Some(Sample {
        clip_id: "move".into(),
        time_ms: 500.,
    });
    engine.compile_gpu(&options).unwrap();
    engine
        .load_document(&serde_json::to_string(&document()).unwrap())
        .unwrap();
    options.animation = None;
    assert_eq!(initial, engine.render(&options).unwrap());
}
