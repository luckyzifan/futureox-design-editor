use futureox_design_kernel::{
    Engine, RenderOptions, View, coverage,
    math::{Point, Rect, Transform},
    path::{Contour, Path},
    raster::rasterize,
};
use serde_json::json;
fn contour(x: f64, y: f64, w: f64, h: f64) -> Contour {
    Contour {
        points: vec![
            Point::new(x, y),
            Point::new(x + w, y),
            Point::new(x + w, y + h),
            Point::new(x, y + h),
        ],
        closed: true,
    }
}
#[test]
fn fractional_rectangle_coverage_is_analytic_in_both_axes() {
    for x in [0., 0.1, 0.125, 0.25, 0.5, 0.9] {
        for y in [0., 0.1, 0.125, 0.3, 0.5, 0.9] {
            let c = contour(x, y, 1.25, 2.7);
            let mask = rasterize(&[c], Rect::new(-1, -1, 5, 6), true);
            for yy in -1..5 {
                for xx in -1..4 {
                    let expected =
                        coverage::rectangle_pixel([x, y, x + 1.25, y + 2.7], xx as f64, yy as f64);
                    assert!((mask.at(xx, yy) as f64 - expected).abs() < 6e-8);
                }
            }
        }
    }
}
#[test]
fn rectangle_recognition_rejects_rotations_holes_and_bow_ties() {
    let c = contour(0., 0., 4., 5.);
    assert_eq!(
        coverage::rectangle(std::slice::from_ref(&c)),
        Some([0., 0., 4., 5.])
    );
    let mut reverse = c.clone();
    reverse.points.reverse();
    assert!(coverage::rectangle(&[reverse]).is_some());
    assert!(coverage::rectangle(&[c.clone(), contour(1., 1., 1., 1.)]).is_none());
    let mut bow = c.clone();
    bow.points.swap(1, 2);
    assert!(coverage::rectangle(&[bow]).is_none());
    let mut open = c.clone();
    open.closed = false;
    assert!(coverage::rectangle(&[open]).is_none());
    let mut skew = c;
    skew.points[1].y += 1e-10;
    assert!(coverage::rectangle(&[skew]).is_none());
}
#[test]
fn primitive_rectangle_and_butt_stroke_keep_fractional_bounds() {
    let cs = Path::rectangle(20.4, 12.6, [0.; 4], 0.)
        .flatten(Transform([1., 0., 0., 1., 8.1, 8.3]), 0.125)
        .unwrap();
    assert_eq!(coverage::rectangle(&cs), Some([8.1, 8.3, 28.5, 20.9]));
    let outlines = futureox_design_kernel::stroke::outline(
        &[Contour {
            points: vec![Point::new(8., 8.5), Point::new(40., 8.5)],
            closed: false,
        }],
        1.,
        "butt",
        "miter",
        0.1,
    )
    .unwrap();
    assert_eq!(coverage::rectangle(&outlines), Some([8., 8., 40., 9.]));
}
#[test]
fn gpu_packet_carries_unrounded_rect_edges_and_pixel_guard() {
    let n = json!({"id":"n","kind":"rectangle","width":20.4,"height":12.6,"transform":[1,0,0,1,8.1,8.3],"fills":[{"kind":"solid","color":"#000000"}]});
    let doc = json!({"schemaVersion":1,"id":"d","name":"d","pages":[{"id":"p","name":"p","background":"#ffffff","children":["n"]}],"nodes":{"n":n}});
    let mut e = Engine::new();
    e.load_document(&doc.to_string()).unwrap();
    let plan = e
        .compile_gpu(&RenderOptions {
            page_id: "p".into(),
            width: 80,
            height: 80,
            view: View {
                x: 0.,
                y: 0.,
                zoom: 1.,
            },
            transparent: true,
            grid: false,
            pixel_preview: None,
            animation: None,
            raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
            interactive_effects: false,
        checkerboard: false,
        })
        .unwrap();
    let path = &plan.nodes["n"].fill;
    let area = path.area.as_ref().unwrap();
    let data = &plan.curves[area.first as usize * 4..(area.first + area.count) as usize * 4];
    assert_eq!(data[0], 1.);
    let remainder = |at: usize| {
        f64::from_bits((0..4).fold(0_u64, |v, i| v | ((data[at + i] as u64) << (16 * i))))
    };
    let left = f64::from(path.rect.x) + f64::from(data[4] + data[6]) + remainder(12);
    let right = f64::from(path.rect.x) + f64::from(data[5] + data[7]) + remainder(16);
    let top = f64::from(path.rect.y) + f64::from(data[8] + data[10]) + remainder(20);
    let bottom = f64::from(path.rect.y) + f64::from(data[9] + data[11]) + remainder(24);
    assert_eq!([left, top, right, bottom], [8.1, 8.3, 28.5, 20.9]);
    assert_eq!(plan.nodes["n"].fill.rect, Rect::new(7, 7, 23, 15));
}
