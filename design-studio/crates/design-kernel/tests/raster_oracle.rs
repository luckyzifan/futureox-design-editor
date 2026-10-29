//! Exact integer ray tests are independent of the floating-point scan converter.
use futureox_design_kernel::{
    math::{Point, Rect},
    path::Contour,
    raster::RasterWorkspace,
};
// Coordinates are in eighths. Cross products avoid division and interpolation.
fn inside(cs: &[Vec<(i64, i64)>], x: i64, y: i64, evenodd: bool) -> (bool, bool) {
    let mut winding = 0i64;
    let mut boundary = false;
    for c in cs {
        for i in 0..c.len() {
            let (ax, ay) = c[i];
            let (bx, by) = c[(i + 1) % c.len()];
            let cross =
                i128::from(bx - ax) * i128::from(y - ay) - i128::from(by - ay) * i128::from(x - ax);
            boundary |= cross == 0
                && x >= ax.min(bx)
                && x <= ax.max(bx)
                && y >= ay.min(by)
                && y <= ay.max(by);
            if ay <= y && y < by && cross > 0 {
                winding += 1;
            }
            if by <= y && y < ay && cross < 0 {
                winding -= 1;
            }
        }
    }
    (
        if evenodd {
            winding % 2 != 0
        } else {
            winding != 0
        },
        boundary,
    )
}
#[test]
fn compact_phases_match_integer_oracle_and_independent_tiny_skia() {
    let fixtures = vec![
        vec![vec![(-11, -9), (147, 17), (13, 151)]],
        vec![
            vec![(3, 5), (121, 7), (107, 119), (7, 109)],
            vec![(35, 35), (35, 83), (83, 83), (83, 35)],
        ],
        vec![vec![(1, 1), (127, 121), (1, 121), (127, 1)]],
        vec![vec![(-8, 43), (81, -7), (137, 87), (39, 139)]],
    ];
    let offsets = [(3, 1), (7, 3), (1, 5), (5, 7)];
    let mut independent_checks = 0;
    let mut workspace = RasterWorkspace::default();
    for integer in fixtures {
        let cs: Vec<_> = integer
            .iter()
            .map(|c| Contour {
                closed: true,
                points: c
                    .iter()
                    .map(|&(x, y)| Point::new(x as f64 / 8., y as f64 / 8.))
                    .collect(),
            })
            .collect();
        let mut builder = tiny_skia::PathBuilder::new();
        for c in &cs {
            builder.move_to(c.points[0].x as f32, c.points[0].y as f32);
            for p in &c.points[1..] {
                builder.line_to(p.x as f32, p.y as f32);
            }
            builder.close();
        }
        let path = builder.finish().unwrap();
        for evenodd in [false, true] {
            let packed = workspace
                .samples(&cs, Rect::new(0, 0, 16, 16), evenodd)
                .unwrap();
            assert_eq!(packed.storage_bytes(), packed.rect.pixels());
            for (s, &(sx, sy)) in offsets.iter().enumerate() {
                let mut reference = tiny_skia::Mask::new(16, 16).unwrap();
                reference.fill_path(
                    &path,
                    if evenodd {
                        tiny_skia::FillRule::EvenOdd
                    } else {
                        tiny_skia::FillRule::Winding
                    },
                    false,
                    tiny_skia::Transform::from_translate(
                        0.5 - sx as f32 / 8.,
                        0.5 - sy as f32 / 8.,
                    ),
                );
                for y in 0..16 {
                    for x in 0..16 {
                        let (covered, boundary) = inside(&integer, x * 8 + sx, y * 8 + sy, evenodd);
                        if !boundary {
                            assert_eq!(
                                packed.at(s, x as i32, y as i32),
                                if covered { 1. } else { 0. },
                                "phase {s} at {x},{y}"
                            );
                        }
                        // Exact cross-product margin: an L-infinity ball of
                        // radius 1/8 px cannot cross any edge's supporting line.
                        // Boundary behavior is separately covered by legacy parity.
                        let safe = !boundary
                            && integer.iter().all(|c| {
                                (0..c.len()).all(|i| {
                                    let (ax, ay) = c[i];
                                    let (bx, by) = c[(i + 1) % c.len()];
                                    let dx = bx - ax;
                                    let dy = by - ay;
                                    let cross = i128::from(dx) * i128::from(y * 8 + sy - ay)
                                        - i128::from(dy) * i128::from(x * 8 + sx - ax);
                                    (dx == 0 && dy == 0)
                                        || cross.abs() > i128::from(dx.abs() + dy.abs())
                                })
                            });
                        if safe {
                            assert_eq!(reference.data()[(y * 16 + x) as usize] > 0, covered);
                            independent_checks += 1;
                        }
                    }
                }
            }
        }
    }
    assert!(independent_checks > 3000);
}
