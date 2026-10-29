use super::*;
#[derive(Clone, Copy)]
struct Edge { a: Point, b: Point, sign: i32 }
fn reference_spans(
    cs: &[Contour],
    rect: Rect,
    even_odd: bool,
    mut emit: impl FnMut(u32, f64, f64) -> bool,
) -> bool {
    let samples = 8;
    let rows = rect.h as usize * samples;
    let mut buckets = vec![Vec::<Edge>::new(); rows];
    for c in cs {
        if c.points.len() < 3 || !c.closed {
            continue;
        }
        for (i, a) in c.points.iter().enumerate() {
            let b = c.points[(i + 1) % c.points.len()];
            if (a.y - b.y).abs() < 1e-14 {
                continue;
            }
            let edge = if a.y < b.y {
                Edge { a: *a, b, sign: 1 }
            } else {
                Edge {
                    a: b,
                    b: *a,
                    sign: -1,
                }
            };
            let first = ((edge.a.y - rect.y as f64) * samples as f64 - 0.5)
                .ceil()
                .max(0.) as usize;
            if first < rows && edge.b.y > rect.y as f64 {
                buckets[first].push(edge);
            }
        }
    }
    let mut active: Vec<Edge> = Vec::new();
    let mut crossings: Vec<(f64, i32)> = Vec::new();
    for (row, added) in buckets.into_iter().enumerate() {
        let y = rect.y as f64 + (row as f64 + 0.5) / samples as f64;
        active.retain(|e| e.b.y > y);
        active.extend(added.into_iter().filter(|e| e.b.y > y));
        crossings.clear();
        crossings.extend(active.iter().map(|e| {
            (
                e.a.x + (y - e.a.y) * (e.b.x - e.a.x) / (e.b.y - e.a.y),
                e.sign,
            )
        }));
        crossings.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut winding = 0;
        let mut start = 0.;
        for &(x, sign) in &crossings {
            let before = if even_odd {
                winding % 2 != 0
            } else {
                winding != 0
            };
            winding += sign;
            let after = if even_odd {
                winding % 2 != 0
            } else {
                winding != 0
            };
            if !before && after {
                start = x;
            } else if before && !after {
                let left = start.max(rect.x as f64);
                let right = x.min(rect.right() as f64);
                if right <= left {
                    continue;
                }
                if !emit(row as u32, left, right) {
                    return false;
                }
            }
        }
    }
    true
}

#[test]
fn contiguous_buckets_keep_every_interval_bit_and_early_exit() {
    let ellipse=crate::path::Path::ellipse(73.5,48.25).flatten(crate::math::Transform([0.6,0.,0.,1.2,-8.125,3.375]),0.015625).unwrap();
    let cross=vec![Contour{closed:true,points:vec![Point::new(-10.,-4.),Point::new(70.,40.),Point::new(-3.,40.),Point::new(65.,-5.)]}];
    let mut both=ellipse.clone();both.extend(cross.clone());both.extend(ellipse.clone());
    for cs in [ellipse,cross,both,vec![]] {for rule in [true,false] {for limit in [Rect::new(-20,-15,120,512),Rect::new(0,0,32,32),Rect::new(1000,1000,10,10),Rect::default()] {
        for stop in [1,7,usize::MAX] {
            let mut a=Vec::new();let complete_a=visit_spans(&cs,limit,rule,|row,left,right|{a.push((row,left.to_bits(),right.to_bits()));a.len()<stop});
            let mut b=Vec::new();let complete_b=reference_spans(&cs,limit,rule,|row,left,right|{b.push((row,left.to_bits(),right.to_bits()));b.len()<stop});
            assert_eq!(complete_a.unwrap(),complete_b);assert_eq!(a,b);
        }
    }}}
}
