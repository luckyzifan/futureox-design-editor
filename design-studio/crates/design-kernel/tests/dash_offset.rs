use futureox_design_kernel::{
    math::{Point, Rect},
    path::Contour,
    raster::rasterize,
    scene::Stroke,
    stroke::{dash_with_offset, expand},
};
use serde_json::json;
fn line() -> Vec<Contour> {
    vec![Contour {
        points: vec![Point::new(0., 0.), Point::new(40., 0.)],
        closed: false,
    }]
}
#[test]
fn positive_negative_periodic_and_zero_length_dash_phases() {
    let spans = |offset| {
        dash_with_offset(&line(), "10 10", offset)
            .unwrap()
            .iter()
            .map(|c| (c.points[0].x, c.points.last().unwrap().x))
            .collect::<Vec<_>>()
    };
    assert_eq!(spans(5.), vec![(0., 5.), (15., 25.), (35., 40.)]);
    assert_eq!(spans(-5.), vec![(5., 15.), (25., 35.)]);
    assert_eq!(spans(25.), spans(5.));
    assert!(dash_with_offset(&line(), "0 10", 0.).unwrap().is_empty());
    assert!(dash_with_offset(&line(), "10 10", f64::NAN).is_err());
}
#[test]
fn uniform_and_variable_width_traversals_share_dash_phase() {
    for offset in [-25., -5., 0., 5., 10., 25.] {
        let mut s:Stroke=serde_json::from_value(json!({"paint":{"kind":"solid","color":"#000000"},"width":4,"cap":"butt","join":"bevel","dash":"10 10","dashOffset":offset})).unwrap();
        let a = expand(&line(), &s, 0.01, 0.).unwrap();
        s.width_profile =
            serde_json::from_value(json!([{"position":0,"left":1,"right":1}])).unwrap();
        let b = expand(&line(), &s, 0.01, 0.).unwrap();
        let clip = Rect {
            x: -5,
            y: -5,
            w: 50,
            h: 10,
        };
        assert_eq!(
            rasterize(&a, clip, false).data,
            rasterize(&b, clip, false).data,
            "offset {offset}"
        );
    }
}
