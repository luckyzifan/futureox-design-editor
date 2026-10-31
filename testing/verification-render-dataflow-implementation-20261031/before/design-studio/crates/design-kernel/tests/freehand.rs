use futureox_design_kernel::{
    freehand::{Request, Sample, fit_samples},
    math::{Point, Transform},
    path::Contour,
    scene::Node,
};
use serde_json::json;
fn request(samples: Vec<Sample>) -> Request {
    Request {
        samples,
        tolerance: 0.5,
        pressure_tolerance: 0.01,
    }
}
fn sample(x: f64, y: f64, pressure: f64) -> Sample {
    Sample { x, y, pressure }
}
fn flattened(f: &futureox_design_kernel::freehand::Fitted) -> Vec<Contour> {
    let n: Node = serde_json::from_value(
        json!({"id":"f","kind":"vector","width":f.width,"height":f.height,"network":f.network}),
    )
    .unwrap();
    n.paths()
        .unwrap()
        .1
        .flatten(Transform([1., 0., 0., 1., f.origin.x, f.origin.y]), 0.01)
        .unwrap()
}
fn distance(p: Point, a: Point, b: Point) -> f64 {
    let d = b - a;
    let t = ((p - a).dot(d) / d.dot(d).max(1e-20)).clamp(0., 1.);
    (p - a - d * t).length()
}
#[test]
fn straight_samples_reduce_to_one_cubic_and_preserve_endpoints() {
    let f = fit_samples(request(
        (0..1000).map(|i| sample(i as f64, 20., 0.5)).collect(),
    ))
    .unwrap();
    assert_eq!(f.network.edges.len(), 1);
    assert_eq!(f.network.vertices.len(), 2);
    assert_eq!(f.network.vertices[0].x + f.origin.x, 0.);
    assert_eq!(f.network.vertices[1].x + f.origin.x, 999.);
    assert_eq!(f.width_profile.len(), 2);
}
#[test]
fn smooth_curve_fit_stays_within_sample_error_budget() {
    let samples: Vec<_> = (0..500)
        .map(|i| {
            let x = i as f64 * 0.6;
            sample(x, 40. * (x / 45.).sin(), 0.5)
        })
        .collect();
    let f = fit_samples(request(samples.clone())).unwrap();
    assert!(f.network.edges.len() < 25);
    let cs = flattened(&f);
    for s in samples {
        let p = Point::new(s.x, s.y);
        let d = cs
            .iter()
            .flat_map(|c| c.points.windows(2))
            .map(|line| distance(p, line[0], line[1]))
            .fold(f64::INFINITY, f64::min);
        assert!(d < 0.55, "error {d}");
    }
}
#[test]
fn pressure_peak_survives_straight_geometry_reduction() {
    let f = fit_samples(request(
        (0..101)
            .map(|i| {
                sample(
                    i as f64,
                    0.,
                    if i <= 50 {
                        i as f64 / 50.
                    } else {
                        (100 - i) as f64 / 50.
                    },
                )
            })
            .collect(),
    ))
    .unwrap();
    assert_eq!(f.network.edges.len(), 1);
    assert_eq!(f.width_profile.len(), 3);
    assert!((f.width_profile[1].position - 0.5).abs() < 1e-12);
    assert_eq!(f.width_profile[1].left, 2.);
}
#[test]
fn pressure_tracks_distance_not_sample_count() {
    let f = fit_samples(request(vec![
        sample(0., 0., 0.),
        sample(1., 0., 1.),
        sample(100., 0., 0.),
    ]))
    .unwrap();
    assert!((f.width_profile[1].position - 0.01).abs() < 1e-12);
}
#[test]
fn sharp_corners_and_reversals_are_not_smoothed_away() {
    let f = fit_samples(request(vec![
        sample(0., 0., 0.5),
        sample(100., 0., 0.5),
        sample(100., 100., 0.5),
        sample(0., 100., 0.5),
        sample(100., 100., 0.5),
    ]))
    .unwrap();
    assert_eq!(f.network.edges.len(), 4);
    for p in [(100., 0.), (100., 100.), (0., 100.)] {
        assert!(f.network.vertices.iter().any(
            |v| (v.x + f.origin.x - p.0).abs() < 1e-8 && (v.y + f.origin.y - p.1).abs() < 1e-8
        ));
    }
}
#[test]
fn a_closed_gesture_stays_an_editable_open_network_without_nan() {
    let f = fit_samples(request(
        (0..=200)
            .map(|i| {
                let t = i as f64 * std::f64::consts::TAU / 200.;
                sample(50. * t.cos(), 50. * t.sin(), 0.5)
            })
            .collect(),
    ))
    .unwrap();
    assert!(f.network.edges.len() > 1);
    assert!(!flattened(&f)[0].closed);
    assert!(
        f.network
            .edges
            .iter()
            .flat_map(|e| [e.c1, e.c2])
            .flatten()
            .all(|p| p.finite())
    );
}
#[test]
fn stationary_pressure_becomes_a_single_dab() {
    let f = fit_samples(request(vec![
        sample(4., 8., 0.2),
        sample(4., 8., 0.8),
        sample(4., 8., 0.),
    ]))
    .unwrap();
    assert_eq!(f.dot_pressure, Some(0.8));
    assert!(f.network.edges.is_empty());
    assert_eq!(f.origin, Point::new(4., 8.));
}
#[test]
fn nonfinite_and_out_of_budget_input_is_rejected() {
    for samples in [
        vec![],
        vec![sample(f64::NAN, 0., 0.5)],
        vec![sample(0., 0., 2.)],
        vec![sample(0., 0., 0.5); 8193],
    ] {
        assert!(fit_samples(request(samples)).is_err());
    }
    let mut r = request(vec![sample(0., 0., 0.5)]);
    r.tolerance = 0.;
    assert!(fit_samples(r).is_err());
}
#[test]
fn adversarial_pressure_has_an_explicit_bound() {
    let samples = (0..2000)
        .map(|i| sample(i as f64, 0., (i % 2) as f64))
        .collect();
    assert!(fit_samples(request(samples)).unwrap_err().contains("512"));
}
#[test]
fn translation_does_not_change_curve_or_pressure_shape() {
    let a: Vec<_> = (0..50)
        .map(|i| sample(i as f64, (i as f64 / 9.).sin() * 10., 0.2 + i as f64 / 100.))
        .collect();
    let b = a
        .iter()
        .map(|s| sample(s.x + 1024., s.y - 512., s.pressure))
        .collect();
    let a = fit_samples(request(a)).unwrap();
    let b = fit_samples(request(b)).unwrap();
    assert_eq!(a.network.edges.len(), b.network.edges.len());
    for (a, b) in a.network.vertices.iter().zip(&b.network.vertices) {
        assert!((a.x - b.x).abs() < 1e-7 && (a.y - b.y).abs() < 1e-7)
    }
    assert_eq!(a.width_profile.len(), b.width_profile.len());
    for (a, b) in a.width_profile.iter().zip(&b.width_profile) {
        assert!((a.position - b.position).abs() < 1e-12);
        assert_eq!(a.left, b.left);
        assert_eq!(a.right, b.right);
    }
}
