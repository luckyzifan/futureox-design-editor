use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::{Value, json};
fn document(extreme: bool) -> Value {
    let (w, h, stroke, m, parent) = if extreme {
        (32e-12, 1e-13, 2e-12, 1e7, 1e5)
    } else {
        (32., 0.1, 2., 1., 1.)
    };
    json!({"schemaVersion":1,"id":"d","name":"normalization","pages":[{"id":"p","name":"p","background":"#ffffff","children":["g"]}],"nodes":{"g":{"id":"g","kind":"group","width":1,"height":1,"transform":[parent,0,0,parent,0,0],"children":["n"]},"n":{"id":"n","kind":"line","width":w,"height":h,"transform":[m,0,0,m,0,0],"strokes":[{"width":stroke,"cap":"butt","paint":{"kind":"solid","color":"#000000"}}]}}})
}
fn render(document: Value, profile: &str) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&document.to_string()).unwrap();
    let options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":64,"height":64,"view":{"x":8,"y":8,"zoom":1},"transparent":true,"rasterProfile":profile})).unwrap();
    engine.render(&options).unwrap()
}
#[test]
fn accepted_nested_transform_does_not_erase_a_visible_local_short_edge() {
    for profile in ["analytic", "figmaSubpixel"] {
        let expected = render(document(false), profile);
        assert_eq!(expected[(8 * 64 + 20) * 4 + 3], 255);
        assert_eq!(render(document(true), profile), expected, "{profile}");
    }
}

use futureox_design_kernel::{math::Point, path::Contour, scene::Stroke, stroke};
fn style(cap: &str, join: &str, profile: bool) -> Stroke {
    serde_json::from_value(json!({"width":2.,"cap":cap,"join":join,"paint":{"kind":"solid","color":"#000000"},"widthProfile":if profile {json!([{"position":0.,"left":0.25,"right":0.5},{"position":0.4,"left":1.5,"right":0.8},{"position":1.,"left":1.,"right":1.}])}else{json!([])}})).unwrap()
}

#[test]
fn explicitly_closed_contours_keep_the_seam_join() {
    // SVG permits both `... L start Z` and `... Z`. Rectangle/ellipse
    // flattening can also return the start twice; the painted set must agree.
    let corners = [
        Point::new(0., 0.),
        Point::new(32., 0.),
        Point::new(32., 24.),
        Point::new(0., 24.),
    ];
    for reverse in [false, true] {
        for start in 0..corners.len() {
            let mut points: Vec<_> = (0..corners.len())
                .map(|i| corners[(i + start) % corners.len()])
                .collect();
            if reverse {
                points.reverse();
            }
            let implicit = Contour {
                points: points.clone(),
                closed: true,
            };
            points.extend([points[0]; 2]);
            let explicit = Contour {
                points,
                closed: true,
            };
            for join in ["miter", "round", "bevel"] {
                for profiled in [false, true] {
                    let mut s = style("butt", join, profiled);
                    if profiled {
                        s.width_profile.last_mut().unwrap().left = s.width_profile[0].left;
                        s.width_profile.last_mut().unwrap().right = s.width_profile[0].right;
                    }
                    let a = stroke::expand(std::slice::from_ref(&implicit), &s, 0.01, 0.).unwrap();
                    let b = stroke::expand(std::slice::from_ref(&explicit), &s, 0.01, 0.).unwrap();
                    assert_contours_close(&a, &b);
                }
            }
        }
    }
}

#[test]
fn rectangle_outside_miter_covers_all_four_corners() {
    let doc = json!({"schemaVersion":1,"id":"d","name":"seam","pages":[{"id":"p","name":"p","background":"#ffffff","children":["n"]}],"nodes":{"n":{"id":"n","kind":"rectangle","width":32,"height":24,"fills":[],"strokes":[{"width":4,"align":"outside","join":"miter","paint":{"kind":"solid","color":"#000000"}}]}}});
    for profile in ["analytic", "figma", "figmaSubpixel"] {
        let actual = render(doc.clone(), profile);
        for (x, y) in [(5, 5), (42, 5), (5, 34), (42, 34)] {
            assert_eq!(
                &actual[(y * 64 + x) * 4..(y * 64 + x) * 4 + 4],
                &[0, 0, 0, 255],
                "{profile} corner {x},{y}"
            );
        }
    }
}
fn assert_contours_close(actual: &[Contour], expected: &[Contour]) {
    assert_eq!(actual.len(), expected.len());
    for (a, b) in actual.iter().zip(expected) {
        assert_eq!(a.closed, b.closed);
        assert_eq!(a.points.len(), b.points.len());
        for (a, b) in a.points.iter().zip(&b.points) {
            assert!((*a - *b).length() < 1e-8, "{a:?} != {b:?}");
        }
    }
}
fn translated_scaled(input: &[Contour], scale: f64, origin: Point) -> Vec<Contour> {
    input
        .iter()
        .map(|c| Contour {
            closed: c.closed,
            points: c.points.iter().map(|p| *p * scale + origin).collect(),
        })
        .collect()
}
#[test]
fn normalized_units_preserve_caps_joins_width_profiles_and_dilation() {
    let source = vec![Contour {
        points: vec![
            Point::new(0., 0.),
            Point::new(8., 0.),
            Point::new(8., 12.),
            Point::new(20., 4.),
        ],
        closed: false,
    }];
    let factor = 2f64.powi(39);
    for cap in ["butt", "square", "round"] {
        for join in ["miter", "bevel", "round"] {
            for profile in [false, true] {
                for dilation in [0., 0.75] {
                    let s = style(cap, join, profile);
                    let expected = stroke::expand(&source, &s, 0.125, dilation).unwrap();
                    let mut tiny = s.clone();
                    tiny.width /= factor;
                    let small = translated_scaled(&source, 1. / factor, Point::new(1e-9, -2e-9));
                    let actual =
                        stroke::expand(&small, &tiny, 0.125 / factor, dilation / factor).unwrap();
                    let actual = actual
                        .into_iter()
                        .map(|c| Contour {
                            closed: c.closed,
                            points: c
                                .points
                                .into_iter()
                                .map(|p| (p - Point::new(1e-9, -2e-9)) * factor)
                                .collect(),
                        })
                        .collect::<Vec<_>>();
                    assert_contours_close(&actual, &expected);
                }
            }
        }
    }
}
#[test]
fn whole_contour_normalization_retains_dash_phase_and_closed_seams() {
    let source = vec![Contour {
        points: vec![
            Point::new(100., -200.),
            Point::new(132., -200.),
            Point::new(132., -176.),
            Point::new(100., -176.),
        ],
        closed: true,
    }];
    for profile in [false, true] {
        for offset in [-9.25, 0., 2.75, 17.] {
            let mut s = style("butt", "miter", profile);
            s.dash = "6 2 0 3".into();
            s.dash_offset = offset;
            if profile {
                s.width_profile.last_mut().unwrap().left = 0.25;
                s.width_profile.last_mut().unwrap().right = 0.5;
            }
            let expected = stroke::expand(&source, &s, 0.125, 0.).unwrap();
            let actual = stroke::expand(&source, &s, 1e-8, 0.).unwrap();
            assert_contours_close(&actual, &expected);
        }
    }
}
#[test]
fn zero_length_subpaths_and_independent_contour_origins_are_preserved() {
    let source = vec![
        Contour {
            points: vec![Point::new(0., 0.), Point::new(0., 0.)],
            closed: false,
        },
        Contour {
            points: vec![Point::new(10., 20.)],
            closed: false,
        },
        Contour {
            points: vec![],
            closed: false,
        },
    ];
    let factor = 2f64.powi(39);
    for profile in [false, true] {
        for cap in ["butt", "square", "round"] {
            let s = style(cap, "round", profile);
            let expected = stroke::expand(&source, &s, 0.125, 0.).unwrap();
            let mut tiny = s.clone();
            tiny.width /= factor;
            let actual = stroke::expand(
                &translated_scaled(&source, 1. / factor, Point::default()),
                &tiny,
                0.125 / factor,
                0.,
            )
            .unwrap();
            assert_contours_close(
                &translated_scaled(&actual, factor, Point::default()),
                &expected,
            );
        }
    }
}
#[test]
fn normalized_lengths_do_not_reapply_authored_width_or_dash_limits() {
    let source = vec![Contour {
        points: vec![Point::new(0., 0.), Point::new(32., 0.)],
        closed: false,
    }];
    let mut s = style("butt", "miter", false);
    s.width = 10000.;
    s.align = "outside".into();
    s.dash = "10000000 10000000".into();
    s.dash_offset = 0.;
    let result = stroke::expand(&source, &s, 1e-12, 0.).unwrap();
    assert!(!result.is_empty());
    s.width = 10001.;
    assert!(
        stroke::expand(&source, &s, 1e-12, 0.)
            .unwrap_err()
            .contains("Invalid stroke")
    );
    s.width = 1.;
    s.dash = "0.0000001 1".into();
    assert!(
        stroke::expand(&source, &s, 1e-12, 0.)
            .unwrap_err()
            .contains("Invalid dash")
    );
}
#[test]
fn normalization_keeps_global_dash_and_output_budgets() {
    let source = Contour {
        points: vec![Point::new(0., 0.), Point::new(10001., 0.)],
        closed: false,
    };
    let mut s = style("butt", "miter", false);
    s.dash = "1 1".into();
    assert!(
        stroke::expand(&[source.clone(), source], &s, 1e-7, 0.)
            .unwrap_err()
            .contains("Dash subdivision budget")
    );
    let point = Contour {
        points: vec![Point::default()],
        closed: false,
    };
    s = style("round", "round", false);
    s.width = 2e-12;
    assert!(
        stroke::expand(&vec![point; 17], &s, 3.5e-22, 0.)
            .unwrap_err()
            .contains("Stroke output budget")
    );
}
#[test]
fn impossible_normalization_reports_an_error_instead_of_nonfinite_geometry() {
    let source = Contour {
        points: vec![Point::default(), Point::new(1., 0.)],
        closed: false,
    };
    assert!(
        stroke::expand(&[source], &style("butt", "miter", false), 1e-320, 0.)
            .unwrap_err()
            .contains("normalization exceeds numerical range")
    );
}

#[test]
fn normalization_preserves_the_global_profile_input_budget() {
    let source = Contour {
        points: (0..60000)
            .map(|i| Point::new(f64::from(i) * 1e-12, 0.))
            .collect(),
        closed: false,
    };
    let mut s = style("butt", "miter", true);
    s.width = 2e-12;
    let error = stroke::expand(&[source.clone(), source], &s, 1.25e-13, 0.).unwrap_err();
    assert!(
        error.contains("Width profile subdivision budget"),
        "{error}"
    );
}

#[test]
fn synthesized_large_dilation_profile_keeps_the_uniform_global_dash_budget() {
    let source = Contour {
        points: vec![Point::new(0., 0.), Point::new(10001., 0.)],
        closed: false,
    };
    let mut s = style("butt", "miter", false);
    s.width = 10000.;
    s.align = "outside".into();
    s.dash = "1 1".into();
    for tolerance in [0.125, 1e-7] {
        let result = stroke::expand(&[source.clone(), source.clone()], &s, tolerance, 1.);
        assert!(
            result.is_err(),
            "uniform preflight budget lost at tolerance {tolerance}"
        );
        assert!(result.unwrap_err().contains("Dash subdivision budget"));
    }
}
