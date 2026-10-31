use futureox_design_kernel::{
    Engine, RenderOptions,
    math::{Point, Transform},
    path::{Contour, Path},
};
use serde_json::json;

fn distance(p: Point, contours: &[Contour]) -> f64 {
    contours
        .iter()
        .flat_map(|c| {
            c.points.iter().enumerate().map(move |(i, a)| {
                let b = c.points[(i + 1) % c.points.len()];
                let d = b - *a;
                let t = ((p - *a).dot(d) / d.dot(d)).clamp(0., 1.);
                (p - a.lerp(b, t)).length()
            })
        })
        .fold(f64::INFINITY, f64::min)
}

// Independent implicit superellipse reference: x^n + y^n = 1.
// Deliberately does not share the production angular sampler/tangent bound.
fn reference_point(x: f64, n: f64, radius: f64) -> Point {
    Point::new(
        radius * (1. + x),
        radius * (1. - (1. - x.powf(n)).max(0.).powf(1. / n)),
    )
}

#[test]
fn smooth_corner_honors_device_tolerance_at_high_zoom() {
    let radius = 2000.;
    let m = Transform([32., 0., 0., 32., 0., 0.]);
    let contours = Path::superellipse_rectangle(radius * 2., radius * 2., [radius; 4], 1.)
        .flatten(m, 1. / 64.)
        .unwrap();
    let worst = (1..1024)
        .map(|i| {
            distance(
                m.point(reference_point(i as f64 / 1024., 5., radius)),
                &contours,
            )
        })
        .fold(0., f64::max);
    eprintln!(
        "independent implicit reference: max_device_error={worst}; points={}",
        contours[0].points.len()
    );
    assert!(
        worst <= 1. / 64. + 1e-8,
        "worst device error {worst}; {} points",
        contours[0].points.len()
    );
}

#[test]
fn high_zoom_cpu_keeps_cubic_corner_interior_covered() {
    let radius = 2000.;
    let t = 0.25_f64;
    let k = 4. / 3. * (std::f64::consts::PI / 8.).tan();
    let ps = [
        Point::new(radius, 0.),
        Point::new(radius * (1. + k), 0.),
        Point::new(2. * radius, radius * (1. - k)),
        Point::new(2. * radius, radius),
    ];
    let p = ps[0] * (1. - t).powi(3)
        + ps[1] * (3. * t * (1. - t).powi(2))
        + ps[2] * (3. * t * t * (1. - t))
        + ps[3] * t.powi(3);
    let tangent = (ps[1] - ps[0]) * (3. * (1. - t).powi(2))
        + (ps[2] - ps[1]) * (6. * t * (1. - t))
        + (ps[3] - ps[2]) * (3. * t * t);
    let normal = Point::new(tangent.y, -tangent.x);
    let interior = p - normal * (1.5 / (32. * normal.length()));
    let doc = json!({"schemaVersion":1,"id":"d","name":"smooth","pages":[{"id":"p","name":"p","background":"#ffffff","children":["n"]}],"nodes":{"n":{"id":"n","kind":"rectangle","width":radius*2.,"height":radius*2.,"radii":([radius;4]),"smoothing":1.,"fills":[{"kind":"solid","color":"#000000"}]}}});
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    for profile in ["analytic", "figma", "figmaSubpixel"] {
        let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":64,"height":64,"view":{"x":31.5-interior.x*32.,"y":31.5-interior.y*32.,"zoom":32.},"transparent":true,"rasterProfile":profile})).unwrap();
        let pixels = engine
            .render(&options)
            .unwrap_or_else(|e| panic!("{profile}: {e}"));
        assert_eq!(
            pixels[(31 * 64 + 31) * 4 + 3],
            255,
            "{profile}: 1.5px inside canonical cubic corner"
        );
    }
}

#[test]
fn smooth_corner_refines_instead_of_reusing_fixed_polygon() {
    let path = Path::superellipse_rectangle(100., 80., [30., 20., 10., 0.], 0.75);
    let low = path.flatten(Transform::default(), 0.015625).unwrap();
    let high = path
        .flatten(Transform([32., 0., 0., 32., 0., 0.]), 0.015625)
        .unwrap();
    assert!(high[0].points.len() > low[0].points.len());
}

#[test]
fn affine_smooth_arcs_stay_within_the_requested_device_error() {
    for smoothing in [1e-6, 0.1, 0.5, 1.] {
        for (radius, m) in [
            (0.000001, Transform([3.2e7, 0., 0., 3.2e7, 0., 0.])),
            (20., Transform([-32., 8., 15., 4., 0.125, -0.375])),
            (20., Transform([0.01, 0., 20., 32., -100., 40.])),
            // Rank-one projection: a quarter can overshoot coincident endpoints.
            (20., Transform([32., 0., 32., 0., 0., 0.])),
        ] {
            let path =
                Path::superellipse_rectangle(radius * 2., radius * 2., [radius; 4], smoothing);
            let contours = path.flatten(m, 1. / 64.).unwrap();
            for i in 0..=256 {
                let p = reference_point(i as f64 / 256., 2. + 3. * smoothing, radius);
                for q in 0..4 {
                    let p = p - Point::new(radius, radius);
                    let p = match q {
                        0 => p,
                        1 => Point::new(-p.y, p.x),
                        2 => p * -1.,
                        _ => Point::new(p.y, -p.x),
                    } + Point::new(radius, radius);
                    assert!(
                        distance(m.point(p), &contours) <= 1. / 64. + 1e-8,
                        "s={smoothing}, r={radius}, matrix={m:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn transformed_smooth_bounds_contain_independent_superellipse_samples() {
    for m in [
        Transform([-32., 8., 15., 4., 0.125, -0.375]),
        Transform([32., 0., 32., 0., 1e9, -1e9]),
        Transform([0.01, 0., 20., 32., 0., 0.]),
    ] {
        for smoothing in [1e-6, 0.5, 1.] {
            let path = Path::superellipse_rectangle(40., 40., [20.; 4], smoothing);
            let b = futureox_design_kernel::bounds::path_bounds(&path, m).unwrap();
            for i in 0..=1024 {
                let p = reference_point(i as f64 / 1024., 2. + 3. * smoothing, 20.)
                    - Point::new(20., 20.);
                for p in [p, Point::new(-p.y, p.x), p * -1., Point::new(p.y, -p.x)] {
                    let p = m.point(p + Point::new(20., 20.));
                    assert!(
                        p.x >= b.x - 1e-6
                            && p.x <= b.x + b.width + 1e-6
                            && p.y >= b.y - 1e-6
                            && p.y <= b.y + b.height + 1e-6,
                        "{p:?} outside {b:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn smooth_cardinal_joins_and_zero_radii_are_exact() {
    let path = Path::superellipse_rectangle(100., 80., [0., 20., 10., 30.], 1.);
    let cs = path.flatten(Transform::default(), 0.01).unwrap();
    for p in [
        Point::new(80., 0.),
        Point::new(100., 20.),
        Point::new(100., 70.),
        Point::new(90., 80.),
        Point::new(30., 80.),
        Point::new(0., 50.),
        Point::new(0., 0.),
    ] {
        assert!(cs[0].points.contains(&p), "missing exact join {p:?}");
    }
    assert!(cs[0].closed);
    let zero = Path::superellipse_rectangle(0., 0., [0.; 4], 1.)
        .flatten(Transform::default(), 0.01)
        .unwrap();
    assert!(zero[0].points.iter().all(|p| *p == Point::default()));
}

#[test]
fn smooth_subdivision_is_translation_invariant_when_precision_allows() {
    let path = Path::superellipse_rectangle(100., 80., [30., 20., 10., 0.], 0.6);
    let base = path
        .flatten(Transform([32., 8., 15., 4., 0., 0.]), 1. / 64.)
        .unwrap();
    for at in [-1e9, 1e9] {
        let moved = path
            .flatten(Transform([32., 8., 15., 4., at, -at]), 1. / 64.)
            .unwrap();
        assert_eq!(moved[0].points.len(), base[0].points.len());
        for (a, b) in moved[0].points.iter().zip(&base[0].points) {
            assert!((*a - *b - Point::new(at, -at)).length() < 1e-6);
        }
    }
}

#[test]
fn smooth_budget_and_unrepresentable_precision_are_explicit_errors() {
    let path = Path::superellipse_rectangle(20_000_000., 20_000_000., [10_000_000.; 4], 1.);
    assert!(
        path.flatten(Transform::default(), 1e-6)
            .unwrap_err()
            .contains("budget")
    );
    let path = Path::superellipse_rectangle(100., 100., [50.; 4], 1.);
    assert!(
        path.flatten(Transform([1., 0., 0., 1., 1e16, 0.]), 0.01)
            .unwrap_err()
            .contains("coordinate precision")
    );
    for smoothing in [f64::NAN, f64::INFINITY] {
        assert!(
            Path::superellipse_rectangle(100., 100., [50.; 4], smoothing)
                .flatten(Transform::default(), 0.01)
                .unwrap_err()
                .contains("Invalid smooth corner")
        );
    }
}

#[test]
fn zero_smoothing_and_legacy_exchange_boundaries_stay_explicit() {
    use futureox_design_kernel::path::Command;
    let circle = Path::superellipse_rectangle(100., 80., [30., 20., 10., 0.], 0.);
    let below = Path::superellipse_rectangle(100., 80., [30., 20., 10., 0.], 0.0000009);
    assert_eq!(circle, below);
    assert_eq!(
        circle
            .commands
            .iter()
            .filter(|c| matches!(c, Command::Arc { .. }))
            .count(),
        4
    );
    let smooth = Path::superellipse_rectangle(100., 80., [30., 20., 10., 0.], 1.);
    assert_eq!(
        smooth
            .commands
            .iter()
            .filter(|c| matches!(c, Command::SmoothCorner(_)))
            .count(),
        4
    );
    let svg = smooth.svg_data();
    assert_eq!(svg.matches('L').count(), 259);
    assert!(!svg.contains("NaN"));
    let curves =
        futureox_design_kernel::curve_boolean::curves(&smooth, Transform::default()).unwrap();
    assert_eq!(curves.len(), 1);
    assert!(curves[0].1.len() <= 260);
    // This checks the shared device-space command encoder. Actual GPU
    // execution is covered by the shared high-zoom precision corpus.
    let gpu_commands = futureox_design_kernel::analytic::segments(
        &smooth,
        Transform::default(),
        futureox_design_kernel::math::Rect::new(0, 0, 100, 80),
    )
    .unwrap();
    assert!(
        gpu_commands
            .chunks_exact(16)
            .all(|segment| segment[0] == 0.)
    );
}
