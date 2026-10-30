use futureox_design_kernel::{
    hit_test_device, hit_test_fill_device,
    math::{Point, Transform},
    path::{Contour, winding},
    scene::Node,
    stroke,
};
use serde_json::json;

const ERROR: f64 = 1. / 64.;
fn shape(radius: f64, smoothing: f64) -> Node {
    serde_json::from_value(json!({"id":"n", "kind":"rectangle", "width":radius*2., "height":radius*2., "radii":([radius;4]), "smoothing":smoothing,"fills":[{"kind":"solid","color":"#000000"}]})).unwrap()
}
fn near(p: Point, cs: &[Contour], distance: f64) -> bool {
    cs.iter().any(|c| {
        let count = if c.closed {
            c.points.len()
        } else {
            c.points.len().saturating_sub(1)
        };
        (0..count).any(|i| {
            let a = c.points[i];
            let b = c.points[(i + 1) % c.points.len()];
            let d = b - a;
            let t = if d.dot(d) > 0. {
                ((p - a).dot(d) / d.dot(d)).clamp(0., 1.)
            } else {
                0.
            };
            (p - a.lerp(b, t)).length() <= distance
        })
    })
}
// The complete high-precision pre-optimization pipeline, prepared once to make
// point-by-point comparisons affordable. No guard or production hit helper.
struct FullReference {
    fill: Vec<Contour>,
    strokes: Vec<(String, Vec<Contour>)>,
    painted: bool,
    evenodd: bool,
}
impl FullReference {
    fn new(n: &Node, m: Transform) -> Self {
        n.validate_strokes().unwrap();
        let (fill, lines) = n.paths().unwrap();
        let fill = fill.flatten(m, ERROR).unwrap();
        let error = (ERROR / m.max_scale()).min(1.);
        let lines = lines.flatten(Transform::default(), error).unwrap();
        let strokes = n
            .strokes
            .iter()
            .filter(|s| s.visible && s.width > 0.)
            .map(|s| {
                let mut outline = stroke::expand(&lines, s, error, 0.).unwrap();
                for c in &mut outline {
                    for p in &mut c.points {
                        *p = m.point(*p);
                    }
                }
                (s.align.clone(), outline)
            })
            .collect();
        Self {
            fill,
            strokes,
            painted: n.fills.iter().any(|p| p.visible),
            evenodd: n.network.as_ref().is_none_or(|g| g.fill_rule == "evenodd"),
        }
    }
    fn inside(&self, p: Point) -> bool {
        let w = winding(p, &self.fill);
        if self.evenodd {
            w.abs() % 2 != 0
        } else {
            w != 0
        }
    }
    fn hit(&self, p: Point, halo: f64) -> bool {
        let inside = self.inside(p);
        (inside && self.painted)
            || self.strokes.iter().any(|(align, cs)| {
                (align == "center" || if align == "inside" { inside } else { !inside })
                    && (winding(p, cs) != 0 || (halo > 0. && near(p, cs, halo)))
            })
    }
    fn fill_hit(&self, p: Point) -> bool {
        self.inside(p) || near(p, &self.fill, 1e-9)
    }
}

#[test]
fn point_guard_matches_full_high_precision_for_affine_smooth_fill_and_exact_edges() {
    let n = shape(2000., 1.);
    let matrices = [
        Transform([32., 0., 0., 32., 0.125, -0.375]),
        Transform([-32., 8., 15., 4., 0.125, -0.375]),
        Transform([0.01, 0., 20., 32., -100., 40.]),
        Transform([32., 8., 15., 4., 3e9 + 0.125, -3e9 - 0.375]),
        Transform([-32., 8., 15., 4., -3e9 - 0.125, 3e9 + 0.375]),
        Transform([32., 0., 32., 0., 0., 0.]),
    ];
    let mut compared = 0;
    for m in matrices {
        let full = FullReference::new(&n, m);
        for c in &full.fill {
            for i in (0..c.points.len()).step_by((c.points.len() / 80).max(1)) {
                let a = c.points[i];
                let b = c.points[(i + 1) % c.points.len()];
                for p in [
                    a,
                    a.lerp(b, 0.5),
                    a + Point::new(0.02, 0.03),
                    a - Point::new(0.02, 0.03),
                    a + Point::new(5., -5.),
                ] {
                    assert_eq!(
                        hit_test_device(&n, p, m, 5.).unwrap(),
                        full.hit(p, 5.),
                        "selection: {m:?} {p:?}"
                    );
                    assert_eq!(
                        hit_test_fill_device(&n, p, m).unwrap(),
                        full.fill_hit(p),
                        "constraint: {m:?} {p:?}"
                    );
                    compared += 2;
                }
            }
        }
    }
    eprintln!("full-adaptive affine/edge point comparisons={compared}");
}

#[test]
fn point_guard_retains_complete_stroke_dash_profile_alignment_and_five_pixel_halo() {
    for (align, dash, cap, join, profile) in [
        ("center", "", "butt", "miter", json!([])),
        ("inside", "7,3", "round", "round", json!([])),
        ("outside", "3,2,1", "square", "bevel", json!([])),
        (
            "center",
            "9,5",
            "round",
            "round",
            json!([{"position":0.,"left":1.,"right":1.},{"position":0.5,"left":3.,"right":2.},{"position":1.,"left":1.,"right":1.}]),
        ),
    ] {
        let mut value = serde_json::to_value(shape(20., 1.)).unwrap();
        value["fills"] = json!([]);
        value["strokes"] = json!([{"width":3.,"align":align,"dash":dash,"dashOffset":2.25,"cap":cap,"join":join,"widthProfile":profile,"paint":{"kind":"solid","color":"#000000"}}]);
        let n: Node = serde_json::from_value(value).unwrap();
        for m in [
            Transform([4., 0., 0., 4., 0.125, -0.375]),
            Transform([-4., 1., 2., 0.5, 0., 0.]),
        ] {
            let full = FullReference::new(&n, m);
            for y in -2..=10 {
                for x in -2..=10 {
                    let p = m.point(Point::new(x as f64 * 4., y as f64 * 4.));
                    for halo in [0., 5.] {
                        assert_eq!(
                            hit_test_device(&n, p, m, halo).unwrap(),
                            full.hit(p, halo),
                            "{align} {dash} {m:?} {p:?} halo={halo}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn point_guard_keeps_zero_size_zero_smoothing_and_hidden_strokes_semantics() {
    for radius in [0., 0.000001, 1., 20.] {
        for smoothing in [0., 0.0000009, 0.5, 1.] {
            let mut n = shape(radius, smoothing);
            n.strokes=serde_json::from_value(json!([{"visible":false,"width":200.,"paint":{"kind":"solid","color":"#000000"}},{"width":0.,"paint":{"kind":"solid","color":"#000000"}}])).unwrap();
            let scale = if radius > 0. && radius < 0.001 {
                32. / radius
            } else {
                32.
            };
            let m = Transform([scale, 0., 0., scale, 0.125, -0.375]);
            let full = FullReference::new(&n, m);
            for p in [
                Point::default(),
                Point::new(radius, radius),
                Point::new(2. * radius, radius),
                Point::new(3. * radius, 3. * radius),
            ] {
                let p = m.point(p);
                assert_eq!(hit_test_device(&n, p, m, 5.).unwrap(), full.hit(p, 5.));
                assert_eq!(hit_test_fill_device(&n, p, m).unwrap(), full.fill_hit(p));
            }
        }
    }
}

#[test]
fn five_pixel_halo_does_not_expand_fill_or_ancestor_constraints() {
    let n = shape(20., 1.);
    let m = Transform::default();
    let p = Point::new(20., -0.01);
    assert!(!hit_test_device(&n, p, m, 5.).unwrap());
    assert!(!hit_test_fill_device(&n, p, m).unwrap());
}

#[test]
fn point_guard_does_not_hide_invalid_strokes_or_unrepresentable_smooth_precision() {
    let mut n = shape(20., 1.);
    n.strokes=serde_json::from_value(json!([{"visible":false,"width":0.,"dash":"invalid","paint":{"kind":"solid","color":"#000000"}}])).unwrap();
    assert!(
        hit_test_device(&n, Point::new(-100., -100.), Transform::default(), 5.)
            .unwrap_err()
            .contains("dash")
    );
    n.strokes.clear();
    let m = Transform([1e12, 0., 0., 1e12, 0., 0.]);
    assert!(
        hit_test_device(&n, Point::new(-100., -100.), m, 5.)
            .unwrap_err()
            .contains("coordinate precision")
    );
    assert!(
        hit_test_fill_device(&n, Point::new(20e12, 20e12), m)
            .unwrap_err()
            .contains("coordinate precision")
    );
}
