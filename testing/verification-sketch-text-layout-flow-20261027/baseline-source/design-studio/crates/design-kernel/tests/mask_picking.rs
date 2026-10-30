use futureox_design_kernel::{
    hit_test_device, hit_test_fill_device,
    math::{Point, Transform},
    scene::Node,
};
use serde_json::json;

fn frame() -> Node {
    serde_json::from_value(json!({
        "id":"clip", "kind":"frame", "width":100, "height":100,
        "radii":[40,40,40,40], "fills":[], "clip":true
    }))
    .unwrap()
}

#[test]
fn rounded_clip_uses_fill_geometry_instead_of_selectable_frame_box() {
    let n = frame();
    for matrix in [
        Transform([32., 0., 0., 32., 0.125, -0.375]),
        Transform([-32., 0., 0., 32., 120.125, 0.375]),
        Transform([32., 8., 24., 32., -0.125, 0.375]),
    ] {
        let outside = matrix.point(Point::new(1., 1.));
        assert!(hit_test_device(&n, outside, matrix, 5.).unwrap());
        assert!(!hit_test_fill_device(&n, outside, matrix).unwrap());
        assert!(hit_test_fill_device(&n, matrix.point(Point::new(25., 25.)), matrix).unwrap());
    }
}

#[test]
fn geometric_constraints_ignore_paints_and_never_add_selection_halo() {
    let n: Node = serde_json::from_value(json!({
        "id":"n", "kind":"rectangle", "width":10, "height":10, "fills":[],
        "strokes":[{"width":100,"paint":{"kind":"solid","color":"#000000"}}]
    }))
    .unwrap();
    for zoom in [0.025, 1., 32.] {
        let m = Transform([zoom, 0., 0., zoom, 0.125, 0.375]);
        assert!(hit_test_fill_device(&n, m.point(Point::new(5., 5.)), m).unwrap());
        for local in [Point::new(10., 5.), Point::new(5., 10.)] {
            assert!(hit_test_fill_device(&n, m.point(local), m).unwrap());
        }
        let just_outside = m.point(Point::new(10., 5.)) + Point::new(0.001, 0.);
        assert!(!hit_test_fill_device(&n, just_outside, m).unwrap());
    }
}

#[test]
fn mask_fill_preserves_nonzero_and_evenodd_under_reflection() {
    let mut n: Node = serde_json::from_value(json!({
        "id":"n", "kind":"vector", "width":100, "height":100,
        "network":{
            "fillRule":"nonzero",
            "vertices":[{"id":"a","x":0,"y":0},{"id":"b","x":100,"y":0},{"id":"c","x":100,"y":100},{"id":"d","x":0,"y":100},{"id":"e","x":25,"y":25},{"id":"f","x":75,"y":25},{"id":"g","x":75,"y":75},{"id":"h","x":25,"y":75}],
            "edges":[{"id":"ab","from":"a","to":"b"},{"id":"bc","from":"b","to":"c"},{"id":"cd","from":"c","to":"d"},{"id":"da","from":"d","to":"a"},{"id":"ef","from":"e","to":"f"},{"id":"fg","from":"f","to":"g"},{"id":"gh","from":"g","to":"h"},{"id":"he","from":"h","to":"e"}]
        }
    })).unwrap();
    for x in [-32., 0.025, 32.] {
        let m = Transform([x, 0., x * 0.25, 32., 0.125, -0.375]);
        let p = m.point(Point::new(50., 50.));
        n.network.as_mut().unwrap().fill_rule = "nonzero".into();
        assert!(hit_test_fill_device(&n, p, m).unwrap());
        n.network.as_mut().unwrap().fill_rule = "evenodd".into();
        assert!(!hit_test_fill_device(&n, p, m).unwrap());
    }
}

#[test]
fn device_fill_scales_curve_precision_below_local_floor() {
    let n: Node = serde_json::from_value(json!({
        "id":"n", "kind":"ellipse", "width":0.001, "height":0.001
    }))
    .unwrap();
    let m = Transform([32000., 0., 8000., 32000., 0.125, 0.375]);
    assert!(hit_test_fill_device(&n, m.point(Point::new(0.0008, 0.0008)), m).unwrap());
    assert!(!hit_test_fill_device(&n, m.point(Point::new(0.00097, 0.00097)), m).unwrap());
}

#[test]
fn device_fill_rejects_invalid_inputs_and_keeps_empty_paths_empty() {
    let n = frame();
    for m in [
        Transform([0.; 6]),
        Transform([f64::NAN; 6]),
        Transform([1e13; 6]),
    ] {
        assert!(hit_test_fill_device(&n, Point::new(1., 1.), m).is_err());
    }
    assert!(hit_test_fill_device(&n, Point::new(f64::INFINITY, 1.), Transform::default()).is_err());
    for kind in ["group", "line"] {
        let n =
            serde_json::from_value(json!({"id":"n","kind":kind,"width":10,"height":10})).unwrap();
        assert!(!hit_test_fill_device(&n, Point::new(5., 5.), Transform::default()).unwrap());
    }
}

#[test]
fn offscreen_shape_mask_is_rejected_before_curve_subdivision() {
    let n = serde_json::from_value(json!({
        "id":"n", "kind":"ellipse", "width":1e7, "height":1e7
    }))
    .unwrap();
    let m = Transform([32., 0., 0., 32., 32e6, 32e6]);
    assert!(!hit_test_fill_device(&n, Point::new(320., 320.), m).unwrap());
}

#[test]
fn fill_bounds_do_not_clamp_large_absolute_device_points_to_render_rect_range() {
    let n = serde_json::from_value(json!({
        "id":"n", "kind":"ellipse", "width":32, "height":32
    }))
    .unwrap();
    for at in [-1e9, 1e9] {
        let m = Transform([1., 0., 0., 1., at, at]);
        assert!(hit_test_fill_device(&n, Point::new(at + 16., at + 16.), m).unwrap());
        assert!(!hit_test_fill_device(&n, Point::new(at - 1., at + 16.), m).unwrap());
    }
}
