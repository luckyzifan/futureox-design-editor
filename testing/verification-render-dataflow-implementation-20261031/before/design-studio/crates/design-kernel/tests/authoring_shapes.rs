use futureox_design_kernel::{
    Engine, RenderOptions, View,
    authoring_shapes::{ellipse_arc, rounded_polygon},
    fidelity::RasterProfile,
    math::{Point, Transform},
    path::{Command, Path},
    scene::{Document, EllipseArc},
};
use serde_json::json;
use std::f64::consts::{PI, TAU};

fn fixture(kind: &str) -> Document {
    serde_json::from_value(json!({"schemaVersion":7,"id":"d","name":"Native shape parameters","pages":[{"id":"p","name":"Page","background":"#ffffff","children":["n"]}],"nodes":{"n":{"id":"n","kind":kind,"width":80,"height":64,"transform":[1,0,0,1,16.125,12.375],"fills":[{"kind":"solid","color":"#426bdf"}]}}})).unwrap()
}
fn options() -> RenderOptions {
    RenderOptions {
        page_id: "p".into(),
        width: 128,
        height: 96,
        view: View {
            x: 0.,
            y: 0.,
            zoom: 1.,
        },
        transparent: true,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: RasterProfile::FigmaSoftware,
        interactive_effects: false,
        checkerboard: false,
    }
}
#[test]
fn full_ellipse_retains_the_original_analytic_commands() {
    let actual = ellipse_arc(
        80.,
        64.,
        EllipseArc {
            start_angle: 0.,
            sweep_angle: TAU,
            inner_radius: 0.,
        },
    );
    assert_eq!(actual, Path::ellipse(80., 64.));
}
#[test]
fn ring_keeps_opposite_inner_winding_and_hit_testing_excludes_the_hole() {
    let mut d = fixture("ellipse");
    let n = d.nodes.get_mut("n").unwrap();
    n.arc = Some(EllipseArc {
        start_angle: 0.,
        sweep_angle: TAU,
        inner_radius: 0.5,
    });
    let (p, _) = n.paths().unwrap();
    let arcs: Vec<_> = p
        .commands
        .iter()
        .filter_map(|c| {
            if let Command::Arc { sweep, .. } = c {
                Some(*sweep)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(arcs, vec![TAU, -TAU]);
    assert!(
        !futureox_design_kernel::hit_test_fill_device(
            n,
            Point::new(40., 32.),
            Transform::default()
        )
        .unwrap()
    );
    assert!(
        futureox_design_kernel::hit_test_fill_device(n, Point::new(70., 32.), Transform::default())
            .unwrap()
    );
}
#[test]
fn sector_zero_negative_sweep_and_inner_radius_are_retained() {
    let mut d = fixture("ellipse");
    let n = d.nodes.get_mut("n").unwrap();
    for sweep in [0., PI / 2., -PI / 2., TAU, -TAU] {
        n.arc = Some(EllipseArc {
            start_angle: 0.,
            sweep_angle: sweep,
            inner_radius: 0.375,
        });
        let (p, _) = n.paths().unwrap();
        if sweep == 0. {
            assert!(p.commands.is_empty());
        } else {
            assert!(
                p.commands
                    .iter()
                    .any(|c| matches!(c,Command::Arc{sweep:s,..} if *s==sweep))
            );
        }
    }
}
#[test]
fn fillets_are_circular_tangent_arcs_with_bounded_radius() {
    let p = rounded_polygon(
        &[
            Point::new(0., 0.),
            Point::new(100., 0.),
            Point::new(100., 60.),
            Point::new(0., 60.),
        ],
        10.,
    );
    assert_eq!(
        p.commands[0],
        Command::Move(Point::new(0., 10.000000000000002))
    );
    let arcs: Vec<_> = p
        .commands
        .iter()
        .filter_map(|c| {
            if let Command::Arc { radius, sweep, .. } = c {
                Some((*radius, *sweep))
            } else {
                None
            }
        })
        .collect();
    assert_eq!(arcs.len(), 4);
    for (radius, sweep) in arcs {
        assert_eq!(radius, Point::new(10., 10.));
        assert_eq!(sweep, PI / 2.);
    }
    let sharp = vec![
        Point::new(0., 0.),
        Point::new(20., 0.),
        Point::new(10., 30.),
    ];
    assert_eq!(rounded_polygon(&sharp, 0.), Path::polygon(&sharp, true));
    assert!(
        rounded_polygon(&[Point::new(0., 0.); 3], 100.)
            .commands
            .iter()
            .all(|c| !matches!(c, Command::Arc { .. }))
    );
}
#[test]
fn native_roundtrip_preserves_parameters_and_exact_rendered_bytes() {
    for kind in ["ellipse", "polygon", "star"] {
        let mut d = fixture(kind);
        let n = d.nodes.get_mut("n").unwrap();
        n.constrain_proportions = true;
        if kind == "ellipse" {
            n.arc = Some(EllipseArc {
                start_angle: 0.125,
                sweep_angle: PI * 1.5,
                inner_radius: 0.625,
            });
        } else {
            n.corner_radius = 5.125;
        }
        d.validate().unwrap();
        let source = serde_json::to_string(&d).unwrap();
        let restored: Document = serde_json::from_str(&source).unwrap();
        assert_eq!(restored, d);
        let mut a = Engine::new();
        a.load_document(&source).unwrap();
        let pixels = a.render(&options()).unwrap();
        let mut b = Engine::new();
        b.load_document(&serde_json::to_string(&restored).unwrap())
            .unwrap();
        assert_eq!(pixels, b.render(&options()).unwrap());
        assert!(pixels.chunks_exact(4).any(|p| p[3] > 0));
        let svg = futureox_design_kernel::export::svg_paths(
            &d.nodes["n"],
            &futureox_design_kernel::font::Fonts::new(),
        )
        .unwrap();
        assert!(svg.fill.contains('A'));
    }
}
#[test]
fn schema_and_invalid_parameters_fail_instead_of_silently_dropping_geometry() {
    let mut d = fixture("ellipse");
    d.nodes.get_mut("n").unwrap().arc = Some(EllipseArc {
        start_angle: 0.,
        sweep_angle: PI,
        inner_radius: 0.5,
    });
    d.schema_version = 6;
    assert!(d.validate().is_err());
    d.schema_version = 7;
    d.nodes
        .get_mut("n")
        .unwrap()
        .arc
        .as_mut()
        .unwrap()
        .inner_radius = 1.01;
    assert!(d.validate().is_err());
    d.nodes.get_mut("n").unwrap().arc = None;
    d.nodes.get_mut("n").unwrap().corner_radius = 3.;
    assert!(d.validate().is_err());
}

#[test]
fn animation_preserves_arc_parameters_at_endpoints_and_interpolates_without_frame_drift() {
    use futureox_design_kernel::animation::{
        self, Clip, Easing, Keyframe, Pose, Repeat, Sample, Track,
    };
    let mut d = fixture("ellipse");
    let a = Pose::from(&d.nodes["n"]);
    let mut b = a.clone();
    b.arc = Some(EllipseArc {
        start_angle: 0.5,
        sweep_angle: PI,
        inner_radius: 0.5,
    });
    d.animations = vec![Clip {
        id: "clip".into(),
        name: "Arc".into(),
        page_id: "p".into(),
        duration_ms: 1000.,
        delay_ms: 0.,
        repeat: Repeat::Once,
        tracks: vec![Track {
            node_id: "n".into(),
            rotation_turns: 0,
            keyframes: vec![
                Keyframe {
                    time_ms: 0.,
                    value: a.clone(),
                    easing: Easing::Linear,
                },
                Keyframe {
                    time_ms: 1000.,
                    value: b.clone(),
                    easing: Easing::Linear,
                },
            ],
        }],
    }];
    d.validate().unwrap();
    let sample = |t| {
        animation::sample(
            &d,
            &Sample {
                clip_id: "clip".into(),
                time_ms: t,
            },
        )
        .unwrap()
        .0
    };
    assert_eq!(Pose::from(&sample(0.).nodes["n"]), a);
    assert_eq!(Pose::from(&sample(1000.).nodes["n"]), b);
    assert_eq!(
        sample(500.).nodes["n"].arc,
        Some(EllipseArc {
            start_angle: 0.25,
            sweep_angle: PI * 1.5,
            inner_radius: 0.25
        })
    );
    assert_eq!(sample(333.), sample(333.));
    d.schema_version = 6;
    assert!(d.validate().is_err());
}
