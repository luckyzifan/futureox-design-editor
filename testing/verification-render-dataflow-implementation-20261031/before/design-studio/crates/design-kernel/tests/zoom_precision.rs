use futureox_design_kernel::{
    Engine, RenderOptions,
    math::{Point, Transform},
    path::Contour,
    stroke,
};
use serde_json::json;

#[test]
fn round_caps_honor_device_error_at_large_zoom() {
    for zoom in [1., 32., 128.] {
        let radius = 2000.;
        let source = Contour {
            points: vec![Point::new(0., 0.)],
            closed: false,
        };
        let outlines =
            stroke::outline(&[source], radius * 2., "round", "round", 0.125 / zoom).unwrap();
        let points = &outlines[0].points;
        for i in 0..points.len() {
            let mid = points[i].lerp(points[(i + 1) % points.len()], 0.5);
            let device_error = (radius - mid.length()) * zoom;
            assert!(
                device_error <= 0.125 + 1e-8,
                "zoom {zoom}: error {device_error}, {} vertices",
                points.len()
            );
        }
    }
}

#[test]
fn zoomed_round_cap_keeps_known_interior_pixels_covered() {
    let doc = json!({"schemaVersion":1,"id":"d","name":"round cap","pages":[{"id":"p","name":"p","background":"#ffffff","children":["n"]}],"nodes":{"n":{"id":"n","kind":"line","width":1,"height":1,"strokes":[{"width":4000,"cap":"round","join":"round","paint":{"kind":"solid","color":"#000000"}}]}}});
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    for profile in ["analytic", "figma", "figmaSubpixel"] {
        let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":64,"height":64,"view":{"x":64030.,"y":31.5,"zoom":32.},"transparent":true,"rasterProfile":profile})).unwrap();
        let bytes = engine.render(&options).unwrap();
        assert_eq!(
            bytes[(31 * 64 + 31) * 4 + 3],
            255,
            "{profile}: point is 1.5 px inside true circle"
        );
    }
}

#[test]
fn tiny_local_ellipse_remains_pickable_when_magnified() {
    let node = serde_json::from_value(json!({"id":"n","kind":"ellipse","width":0.001,"height":0.001,"fills":[{"kind":"solid","color":"#000000"}]})).unwrap();
    let transform = Transform([32000., 0., 0., 32000., 0., 0.]);
    assert!(
        futureox_design_kernel::hit_test_device(&node, Point::new(25.6, 25.6), transform, 5.)
            .unwrap()
    );
    assert!(
        !futureox_design_kernel::hit_test_device(&node, Point::new(30., 30.), transform, 5.)
            .unwrap()
    );
}

#[test]
fn stroke_picking_halo_is_measured_in_device_pixels_under_anisotropy() {
    let node = serde_json::from_value(json!({"id":"n","kind":"line","width":100,"height":1,"strokes":[{"width":2,"cap":"butt","paint":{"kind":"solid","color":"#000000"}}]})).unwrap();
    for matrix in [
        Transform([0.01, 0., 0., 100., 0., 0.]),
        Transform([-0.01, 0., 0., 100., 0., 0.]),
        Transform([0.01, 0.005, 20., 100., 0., 0.]),
    ] {
        let a = matrix.point(Point::new(0., 0.));
        let b = matrix.point(Point::new(100., 1.));
        let tangent = b - a;
        let local_normal = Point::new(100., 1.).normal();
        let mapped_normal = matrix.point(local_normal) - a;
        let mut normal = tangent.normal();
        if mapped_normal.dot(normal) < 0. {
            normal = normal * -1.;
        }
        let edge = matrix.point(Point::new(50., 0.5) + local_normal);
        assert!(
            futureox_design_kernel::hit_test_device(&node, edge + normal * 4., matrix, 5.).unwrap()
        );
        assert!(
            !futureox_design_kernel::hit_test_device(&node, edge + normal * 6., matrix, 5.)
                .unwrap()
        );
    }
}

#[test]
fn stroke_arc_exhaustion_reports_error_instead_of_coarsening() {
    let source = Contour {
        points: vec![Point::new(0., 0.)],
        closed: false,
    };
    let result = stroke::outline(&[source], 4000., "round", "round", 1e-12);
    assert!(result.unwrap_err().contains("subdivision budget"));
}

#[test]
fn local_curve_tolerance_scales_below_the_old_absolute_floor() {
    use futureox_design_kernel::path::Path;
    let path = Path::ellipse(0.00001, 0.00001);
    let zoom = 10_000_000.;
    let local = path.flatten(Transform::default(), 0.125 / zoom).unwrap();
    assert!(local[0].points.len() > 32);
    for pair in local[0].points.windows(2) {
        let center = Point::new(0.000005, 0.000005);
        let error = (0.000005 - (pair[0].lerp(pair[1], 0.5) - center).length()) * zoom;
        assert!(error <= 0.125 + 1e-10, "{error}");
    }
}

#[test]
fn variable_width_round_caps_keep_the_same_sagitta_contract() {
    let style = serde_json::from_value(json!({"width":4000,"paint":{"kind":"solid","color":"#000000"},"cap":"round","join":"round","widthProfile":[{"position":0,"left":1,"right":1}]})).unwrap();
    let source = Contour {
        points: vec![Point::new(0., 0.), Point::new(100., 0.)],
        closed: false,
    };
    let sigma = 2048.;
    let outlines = stroke::expand(&[source], &style, 0.125 / sigma, 0.).unwrap();
    let cap = &outlines[1].points;
    assert!(cap.len() > 4096);
    for pair in cap[1..].windows(2) {
        let error = (2000. - pair[0].lerp(pair[1], 0.5).length()) * sigma;
        assert!(error <= 0.125 + 1e-6, "{error}");
    }
}

#[test]
fn fractional_hairline_coverage_is_stable_for_the_same_device_geometry() {
    for zoom in [0.025, 0.125, 1., 4., 32., 128.] {
        let doc = json!({"schemaVersion":1,"id":"d","name":"hairline","pages":[{"id":"p","name":"p","background":"#ffffff","children":["n"]}],"nodes":{"n":{"id":"n","kind":"rectangle","transform":[1,0,0,1,10.125/zoom,4./zoom],"width":0.25/zoom,"height":8./zoom,"fills":[{"kind":"solid","color":"#000000"}]}}});
        let mut engine = Engine::new();
        engine.load_document(&doc.to_string()).unwrap();
        let options = serde_json::from_value(json!({"pageId":"p","width":32,"height":16,"view":{"x":0,"y":0,"zoom":zoom},"transparent":true,"rasterProfile":"analytic"})).unwrap();
        let pixels = engine.render(&options).unwrap();
        assert_eq!(pixels[(8 * 32 + 10) * 4 + 3], 64, "zoom {zoom}");
        assert_eq!(pixels[(8 * 32 + 9) * 4 + 3], 0);
        assert_eq!(pixels[(8 * 32 + 11) * 4 + 3], 0);
    }
}

#[test]
fn high_precision_uniform_strokes_keep_a_total_output_budget() {
    let source = Contour {
        points: vec![Point::new(0., 0.)],
        closed: false,
    };
    let error = stroke::outline(&vec![source; 17], 2., "round", "round", 3.5e-10).unwrap_err();
    assert!(error.contains("Stroke output budget"), "{error}");
}
