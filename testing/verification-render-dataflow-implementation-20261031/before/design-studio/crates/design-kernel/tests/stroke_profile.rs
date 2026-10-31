use futureox_design_kernel::{
    Engine, RenderOptions, View, geometry, hit_test,
    math::{Point, Rect, Transform},
    path::{Contour, winding},
    raster::rasterize,
    scene::{Node, Stroke},
    stroke,
};
use serde_json::json;
fn p(x: f64, y: f64) -> Point {
    Point::new(x, y)
}
fn line() -> Contour {
    Contour {
        points: vec![p(0., 0.), p(100., 0.)],
        closed: false,
    }
}
fn style(profile: serde_json::Value) -> Stroke {
    serde_json::from_value(json!({"width":20,"paint":{"kind":"solid","color":"#000000"},"cap":"butt","join":"miter","widthProfile":profile})).unwrap()
}
fn taper() -> Stroke {
    style(json!([{"position":0,"left":0,"right":0},{"position":1,"left":1,"right":1}]))
}
fn n(s: &Stroke) -> Node {
    serde_json::from_value(json!({"id":"n","kind":"line","width":100,"height":1,"transform":[1,0,0,1,12,32],"strokes":[s]})).unwrap()
}
fn contains(cs: &[Contour], x: f64, y: f64) -> bool {
    winding(p(x, y), cs) != 0
}

#[test]
fn uniform_round_join_sectors_match_the_distance_to_a_polyline() {
    let points = vec![p(0., 0.), p(10., 0.), p(10., 10.), p(16., 4.)];
    let source = Contour {
        points: points.clone(),
        closed: false,
    };
    let outlines = stroke::outline(&[source], 4., "round", "round", 0.0001).unwrap();
    let distance = |q: Point| {
        points
            .windows(2)
            .map(|pair| {
                let d = pair[1] - pair[0];
                let t = ((q - pair[0]).dot(d) / d.dot(d)).clamp(0., 1.);
                (q - (pair[0] + d * t)).length()
            })
            .fold(f64::INFINITY, f64::min)
    };
    for y in -24..=120 {
        for x in -24..=180 {
            let q = p(f64::from(x) / 10. + 0.013, f64::from(y) / 10. + 0.017);
            let d = distance(q);
            if (d - 2.).abs() > 0.001 {
                assert_eq!(contains(&outlines, q.x, q.y), d < 2., "{q:?} distance {d}");
            }
        }
    }
}

#[test]
fn a_zoomed_round_ellipse_stroke_stays_within_the_analytic_command_budget() {
    let doc = json!({"schemaVersion":1,"id":"d","name":"zoomed stroke","pages":[{"id":"p","name":"p","background":"#ffffff","children":["n"]}],"nodes":{"n":{"id":"n","kind":"ellipse","width":64,"height":50,"strokes":[{"width":1.25,"join":"round","paint":{"kind":"solid","color":"#223344"}}]}}});
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    for zoom in [1., 8., 32.] {
        let options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":192,"height":192,"view":{"x":-24.*zoom,"y":0,"zoom":zoom},"rasterProfile":"figma","transparent":true})).unwrap();
        engine.compile_gpu(&options).unwrap();
    }
}
fn options() -> RenderOptions {
    RenderOptions {
        page_id: "p".into(),
        width: 128,
        height: 64,
        view: View {
            x: 0.,
            y: 0.,
            zoom: 1.,
        },
        transparent: true,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
        interactive_effects: false,
        checkerboard: false,
    }
}
fn doc(n: &Node) -> String {
    json!({"schemaVersion":1,"id":"d","name":"test","pages":[{"id":"p","name":"Page","background":"#ffffff","children":["n"]}],"nodes":{"n":n}}).to_string()
}

#[test]
fn taper_matches_analytic_area_and_width() {
    let cs = stroke::expand(&[line()], &taper(), 0.01, 0.).unwrap();
    let mask = rasterize(&cs, Rect::new(0, -10, 100, 20), false);
    assert!((mask.data.iter().sum::<f32>() - 1000.).abs() < 0.02);
    for x in 1..99 {
        assert!(contains(&cs, x as f64, x as f64 * 0.1 - 0.02));
        assert!(!contains(&cs, x as f64, x as f64 * 0.1 + 0.02));
    }
}
#[test]
fn interior_knots_subdivide_even_a_single_straight_edge() {
    let s = style(
        json!([{"position":0,"left":0,"right":0},{"position":0.3,"left":3,"right":1},{"position":1,"left":0,"right":0}]),
    );
    let cs = stroke::expand(&[line()], &s, 0.01, 0.).unwrap();
    assert!(contains(&cs, 30., 29.));
    assert!(!contains(&cs, 30., 31.));
    assert!(contains(&cs, 30., -9.));
    assert!(!contains(&cs, 30., -11.));
}
#[test]
fn dash_width_uses_original_arc_length_not_each_dash_length() {
    let mut s = taper();
    s.dash = "10 10".into();
    let cs = stroke::expand(&[line()], &s, 0.01, 0.).unwrap();
    assert!(!contains(&cs, 5., 1.));
    assert!(contains(&cs, 85., 8.));
    assert!(!contains(&cs, 95., 0.));
    assert!(!contains(&cs, 25., 3.));
    assert!(contains(&cs, 25., 2.));
}
#[test]
fn asymmetric_round_and_square_caps_use_shifted_center() {
    let mut s = style(json!([{"position":0,"left":2,"right":0}]));
    s.cap = "round".into();
    let cs = stroke::expand(&[line()], &s, 0.005, 0.).unwrap();
    assert!(contains(&cs, -9., 10.));
    assert!(!contains(&cs, -11., 10.));
    assert!(!contains(&cs, -2., -1.));
    assert!(contains(&cs, 109., 10.));
    s.cap = "square".into();
    let cs = stroke::expand(&[line()], &s, 0.01, 0.).unwrap();
    assert!(contains(&cs, -9., 19.));
    assert!(!contains(&cs, -11., 19.));
}
#[test]
fn closed_profile_wraps_without_a_seam_cap() {
    let c = Contour {
        points: vec![p(0., 0.), p(100., 0.), p(100., 100.), p(0., 100.)],
        closed: true,
    };
    let mut s =
        style(json!([{"position":0.25,"left":1,"right":1},{"position":0.75,"left":3,"right":3}]));
    s.join = "miter".into();
    s.cap = "round".into();
    let cs = stroke::expand(std::slice::from_ref(&c), &s, 0.01, 0.).unwrap();
    assert!(contains(&cs, 1., -19.));
    assert!(!contains(&cs, 1., -21.));
    s.cap = "butt".into();
    assert_eq!(
        serde_json::to_string(&cs.iter().map(|c| &c.points).collect::<Vec<_>>()).unwrap(),
        serde_json::to_string(
            &stroke::expand(&[c], &s, 0.01, 0.)
                .unwrap()
                .iter()
                .map(|c| &c.points)
                .collect::<Vec<_>>()
        )
        .unwrap()
    );
}
#[test]
fn seam_and_bad_profiles_are_rejected_before_rendering() {
    let mut node = n(&taper());
    node.kind = "ellipse".into();
    node.height = 100.;
    assert!(
        node.validate_strokes()
            .unwrap_err()
            .contains("matching widths")
    );
    for profile in [
        json!([{"position":0.5,"left":1,"right":1},{"position":0.5,"left":2,"right":2}]),
        json!([{"position":1.1,"left":1,"right":1}]),
        json!([{"position":0,"left":-1,"right":1}]),
        json!([{"position":0,"left":1,"right":5}]),
    ] {
        assert!(stroke::validate(&style(profile)).is_err());
    }
    let mut s = taper();
    s.width_profile[0].left = f64::NAN;
    assert!(stroke::validate(&s).is_err());
    let mut s = taper();
    s.width_profile = vec![s.width_profile[0]; 513];
    assert!(stroke::validate(&s).is_err());
}
#[test]
fn branched_profile_rejected_but_uniform_network_kept() {
    let mut node = n(&taper());
    node.kind = "vector".into();
    node.network=serde_json::from_value(json!({"vertices":[{"id":"a","x":0,"y":0},{"id":"b","x":100,"y":0},{"id":"c","x":0,"y":100},{"id":"d","x":100,"y":100}],"edges":[{"id":"1","from":"a","to":"b"},{"id":"2","from":"a","to":"c"},{"id":"3","from":"a","to":"d"}]})).unwrap();
    assert!(node.validate_strokes().is_err());
    node.strokes[0].width_profile.clear();
    assert!(node.validate_strokes().is_ok());
}
#[test]
fn dash_budgets_include_zero_ink_and_tiny_gaps() {
    for value in ["0 0.00000000001", "0 0.000001", "-1 2"] {
        let mut s = taper();
        s.dash = value.into();
        assert!(stroke::expand(&[line()], &s, 0.1, 0.).is_err());
        assert!(stroke::dash(&[line()], value).is_err());
    }
    let mut s = taper();
    s.dash = "0 0".into();
    assert!(contains(
        &stroke::expand(&[line()], &s, 0.01, 0.).unwrap(),
        90.,
        8.
    ));
}
#[test]
fn picking_dilates_the_profile_instead_of_scaling_tolerance_by_pressure() {
    let node = n(&taper());
    // Primitive lines run diagonally from (0,0) to (100,1).
    assert!(hit_test(&node, p(10., 2.), 2.).unwrap());
    assert!(!hit_test(&node, p(10., 5.), 2.).unwrap());
    assert!(hit_test(&node, p(90., 8.), 0.).unwrap());
}
#[test]
fn duplicate_vertices_and_degenerate_paths_are_finite() {
    let cs = [Contour {
        points: vec![p(0., 0.), p(0., 0.), p(100., 0.), p(100., 0.)],
        closed: false,
    }];
    let mut s = taper();
    s.cap = "round".into();
    for c in stroke::expand(&cs, &s, 0.01, 0.).unwrap() {
        assert!(c.points.iter().all(|p| p.finite()));
    }
    assert!(
        stroke::expand(
            &[Contour {
                points: vec![],
                closed: false
            }],
            &s,
            0.01,
            0.
        )
        .unwrap()
        .is_empty()
    );
}
#[test]
fn every_join_and_alignment_survives_reflection_shear_and_outline_conversion() {
    for join in ["round", "miter", "bevel"] {
        for align in ["center", "inside", "outside"] {
            let mut s = style(
                json!([{"position":0,"left":1,"right":2},{"position":0.5,"left":3,"right":0.5},{"position":1,"left":1,"right":2}]),
            );
            s.join = join.into();
            s.align = align.into();
            let mut node = n(&s);
            node.kind = "rectangle".into();
            node.width = 40.;
            node.height = 30.;
            node.transform = Transform([-1., 0.2, 0.4, 1.3, 60., 10.]);
            let mut e = Engine::new();
            e.load_document(&doc(&node)).unwrap();
            assert!(e.render(&options()).unwrap().chunks(4).any(|p| p[3] > 0));
            let gpu = e.compile_gpu(&options()).unwrap();
            assert!(gpu.vertices.iter().all(|v| v.is_finite()));
            let result =
                geometry(&json!({"operation":"outline","nodes":[node]}).to_string()).unwrap();
            let outlines: Vec<Vec<Vec<Point>>> = serde_json::from_str(&result).unwrap();
            assert!(!outlines[0].is_empty());
        }
    }
}
#[test]
fn native_render_and_gpu_compiler_use_the_same_profile_geometry() {
    let node = n(&taper());
    let mut e = Engine::new();
    e.load_document(&doc(&node)).unwrap();
    let bytes = e.render(&options()).unwrap();
    let gpu = e.compile_gpu(&options()).unwrap();
    assert_eq!(gpu.nodes["n"].strokes[0].path.rule, "nonzero");
    assert!(gpu.nodes["n"].strokes[0].path.area.is_some());
    assert!(gpu.nodes["n"].strokes[0].path.count >= 3);
    assert_eq!(bytes[(40 * 128 + 100) * 4 + 3], 255);
    assert_eq!(bytes[(40 * 128 + 20) * 4 + 3], 0);
    let handles = stroke::handles(&node, 0).unwrap();
    assert_eq!(handles.len(), 2);
    assert!((handles[1].point.x - 100.).abs() < 1e-8);
}
#[test]
fn profile_bounds_prevent_offscreen_centerline_culling() {
    let mut node = n(&style(json!([{"position":0,"left":4,"right":4}])));
    node.transform = Transform([1., 0., 0., 1., 12., -30.]);
    let mut e = Engine::new();
    e.load_document(&doc(&node)).unwrap();
    assert!(e.render(&options()).unwrap().chunks(4).any(|p| p[3] > 0));
    assert!(e.compile_gpu(&options()).unwrap().nodes.contains_key("n"));
}

#[test]
fn asymmetric_reversal_round_join_covers_both_exterior_sides() {
    let mut s = style(json!([{"position":0,"left":3,"right":1}]));
    s.join = "round".into();
    let cs = stroke::expand(
        &[Contour {
            points: vec![p(0., 0.), p(100., 0.), p(0., 0.)],
            closed: false,
        }],
        &s,
        0.01,
        0.,
    )
    .unwrap();
    assert!(contains(&cs, 125., 0.));
    assert!(contains(&cs, 105., 25.));
    assert!(!contains(&cs, 131., 0.));
}
