//! Property tests for boolean geometry: algebraic laws any correct
//! implementation must satisfy, independent of a reference engine.
//!
//! For polygonal inputs the operations are exact, so the laws below hold
//! without tolerances beyond float summation error in areas.
use crate::boolean::{Operation, boolean};
use crate::math::Point;
use crate::path::{Contour, area};

fn rect(x: f64, y: f64, w: f64, h: f64) -> Vec<Contour> {
    vec![Contour {
        points: vec![
            Point::new(x, y),
            Point::new(x + w, y),
            Point::new(x + w, y + h),
            Point::new(x, y + h),
        ],
        closed: true,
    }]
}

fn circle(cx: f64, cy: f64, r: f64, n: usize) -> Vec<Contour> {
    let points = (0..n)
        .map(|i| {
            let a = i as f64 / n as f64 * std::f64::consts::TAU;
            Point::new(cx + r * a.cos(), cy + r * a.sin())
        })
        .collect();
    vec![Contour {
        points,
        closed: true,
    }]
}

fn total_area(contours: &[Contour]) -> f64 {
    contours.iter().map(|c| area(&c.points).abs()).sum()
}

fn assert_close(a: f64, b: f64, what: &str) {
    assert!(
        (a - b).abs() < 1e-6 * b.abs().max(1.).max(a.abs().max(1.)),
        "{what}: {a} vs {b}"
    );
}

#[test]
fn union_is_idempotent() {
    let a = rect(0., 0., 100., 60.);
    let once = boolean(&[a.clone(), a.clone()], Operation::Union).unwrap();
    assert_close(total_area(&once), 100. * 60., "A∪A area equals A");
}

#[test]
fn intersect_is_idempotent() {
    let a = rect(0., 0., 100., 60.);
    let once = boolean(&[a.clone(), a.clone()], Operation::Intersect).unwrap();
    assert_close(total_area(&once), 100. * 60., "A∩A area equals A");
}

#[test]
fn subtract_self_is_empty() {
    let a = rect(0., 0., 100., 60.);
    let out = boolean(&[a.clone(), a.clone()], Operation::Subtract).unwrap();
    assert!(
        out.is_empty() || total_area(&out) < 1e-6,
        "A−A must be empty, got area {}",
        total_area(&out)
    );
}

#[test]
fn union_is_commutative_in_area() {
    let a = rect(0., 0., 100., 60.);
    let b = rect(50., 30., 100., 60.);
    let ab = boolean(&[a.clone(), b.clone()], Operation::Union).unwrap();
    let ba = boolean(&[b, a], Operation::Union).unwrap();
    assert_close(total_area(&ab), total_area(&ba), "A∪B == B∪A (area)");
}

#[test]
fn union_intersect_partition() {
    // |A∪B| + |A∩B| == |A| + |B| for any measurable sets.
    let a = rect(0., 0., 100., 60.);
    let b = rect(50., 30., 100., 60.);
    let u = boolean(&[a.clone(), b.clone()], Operation::Union).unwrap();
    let i = boolean(&[a.clone(), b.clone()], Operation::Intersect).unwrap();
    assert_close(
        total_area(&u) + total_area(&i),
        100. * 60. + 100. * 60.,
        "|A∪B| + |A∩B| == |A| + |B|",
    );
}

#[test]
fn subtract_plus_intersect_is_first_operand() {
    let a = rect(0., 0., 100., 60.);
    let b = rect(50., 30., 100., 60.);
    let s = boolean(&[a.clone(), b.clone()], Operation::Subtract).unwrap();
    let i = boolean(&[a, b], Operation::Intersect).unwrap();
    assert_close(
        total_area(&s) + total_area(&i),
        100. * 60.,
        "|A−B| + |A∩B| == |A|",
    );
}

#[test]
fn disjoint_union_and_empty_intersect() {
    let a = rect(0., 0., 40., 40.);
    let b = rect(100., 100., 40., 40.);
    let u = boolean(&[a.clone(), b.clone()], Operation::Union).unwrap();
    let i = boolean(&[a, b], Operation::Intersect).unwrap();
    assert_close(total_area(&u), 2. * 40. * 40., "disjoint union sums");
    assert!(
        i.is_empty() || total_area(&i) < 1e-6,
        "disjoint intersect empty"
    );
}

#[test]
fn contained_intersect_is_inner() {
    let outer = rect(0., 0., 100., 100.);
    let inner = rect(25., 25., 50., 50.);
    let i = boolean(&[outer, inner], Operation::Intersect).unwrap();
    assert_close(total_area(&i), 50. * 50., "outer∩inner == inner");
}

#[test]
fn curved_inputs_keep_partition_law() {
    let a = circle(0., 0., 50., 64);
    let b = circle(25., 0., 50., 64);
    let approx = |c: &Vec<Contour>| total_area(c);
    let u = boolean(&[a.clone(), b.clone()], Operation::Union).unwrap();
    let i = boolean(&[a.clone(), b.clone()], Operation::Intersect).unwrap();
    let pi = std::f64::consts::PI;
    // polygonal circles slightly underestimate π r²; compare law against
    // the polygon areas themselves, computed independently.
    let sa = approx(&a);
    let sb = approx(&b);
    assert_close(
        approx(&u) + approx(&i),
        sa + sb,
        "circle partition law (polygonal)",
    );
    // sanity: a 64-gon approximates π r² within 0.5%
    assert!(
        (sa - pi * 2500.).abs() / (pi * 2500.) < 5e-3,
        "circle A area {sa}"
    );
    assert!(
        (sb - pi * 2500.).abs() / (pi * 2500.) < 5e-3,
        "circle B area {sb}"
    );
}

#[test]
fn exclude_equals_union_minus_twice_intersect() {
    // |A ⊕ B| == |A∪B| − 2|A∩B|
    let a = rect(0., 0., 100., 60.);
    let b = rect(50., 30., 100., 60.);
    let x = boolean(&[a.clone(), b.clone()], Operation::Exclude).unwrap();
    let u = boolean(&[a.clone(), b.clone()], Operation::Union).unwrap();
    let i = boolean(&[a, b], Operation::Intersect).unwrap();
    assert_close(
        total_area(&x),
        total_area(&u) - total_area(&i),
        "|A⊕B| == |A∪B| − |A∩B|",
    );
    assert_close(
        total_area(&x),
        100. * 60. * 2. - 2. * total_area(&i),
        "|A⊕B| == |A| + |B| − 2|A∩B|",
    );
}
