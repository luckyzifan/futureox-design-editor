//! CPU-only numeric/retention checks. No graphics device and no external reference files.
use futureox_design_kernel::{Engine, RenderOptions, math::{Point, Transform}, path::{Command, Path}};
use serde_json::json;

fn distance_to_polyline(point: Point, points: &[Point]) -> f64 {
    points.windows(2).map(|pair| {
        let dx = pair[1].x - pair[0].x;
        let dy = pair[1].y - pair[0].y;
        let length2 = dx * dx + dy * dy;
        let t = if length2 == 0. { 0. } else {
            (((point.x - pair[0].x) * dx + (point.y - pair[0].y) * dy) / length2).clamp(0., 1.)
        };
        (point.x - pair[0].x - t * dx).hypot(point.y - pair[0].y - t * dy)
    }).fold(f64::INFINITY, f64::min)
}

#[test]
fn circle_arc_chord_error_stays_in_device_tolerance_at_32x_fractional_pan() {
    let radius = 30.;
    let path = Path::ellipse(radius * 2., radius * 2.);
    for zoom in [1., 32., 64.] {
        for (x, y) in [(0., 0.), (0.375, -0.125), (-1234.625, 128.5)] {
            let matrix = Transform([zoom, 0., 0., zoom, x, y]);
            let center = matrix.point(Point::new(radius, radius));
            for tolerance in [1. / 64., 1. / 8192.] {
                let contours = path.flatten(matrix, tolerance).unwrap();
                let points = &contours[0].points;
                assert!(points.len() < 131072, "bounded synthetic circle");
                for i in 0..points.len() {
                    let a = points[i];
                    let b = points[(i + 1) % points.len()];
                    let mid = Point::new((a.x + b.x) * 0.5, (a.y + b.y) * 0.5);
                    let error = radius * zoom - (mid.x - center.x).hypot(mid.y - center.y);
                    assert!(error.abs() <= tolerance + 2e-9,
                        "zoom={zoom}, pan={x},{y}, tolerance={tolerance}, chord error={error}");
                }
            }
        }
    }
}

#[test]
fn cubic_samples_stay_within_device_error_after_fractional_pan() {
    let controls = [Point::new(0., 0.), Point::new(2., 8.), Point::new(8., -6.), Point::new(10., 2.)];
    let path = Path { commands: vec![Command::Move(controls[0]), Command::Cubic(controls[1], controls[2], controls[3])], ..Path::default() };
    for zoom in [1., 32.] {
        for (x, y) in [(0., 0.), (0.375, -0.125), (-500.625, 256.5)] {
            let matrix = Transform([zoom, 0., 0., zoom, x, y]);
            for tolerance in [1. / 64., 1. / 8192.] {
                let contours = path.flatten(matrix, tolerance).unwrap();
                // Independent Bernstein evaluation samples the analytic cubic;
                // this is a bounded numeric check, not an exhaustive proof.
                for sample in 0..=512 {
                    let t = sample as f64 / 512.;
                    let s = 1. - t;
                    let weights = [s*s*s, 3.*s*s*t, 3.*s*t*t, t*t*t];
                    let point = matrix.point(Point::new(
                        (0..4).map(|i| controls[i].x * weights[i]).sum(),
                        (0..4).map(|i| controls[i].y * weights[i]).sum(),
                    ));
                    let error = distance_to_polyline(point, &contours[0].points);
                    assert!(error <= tolerance + 2e-9,
                        "zoom={zoom}, pan={x},{y}, tolerance={tolerance}, t={t}, distance={error}");
                }
            }
        }
    }
}

#[test]
fn fractional_pan_and_drag_at_32x_match_fresh_packets_and_cpu_pixels() {
    let mut document = json!({"schemaVersion":1,"id":"zoom-pan","name":"zoom pan",
        "pages":[{"id":"p","name":"p","children":["clip"],"background":"#ffffff"}],
        "nodes":{
            "clip":{"id":"clip","kind":"frame","width":3,"height":2.5,"clip":true,
                "transform":[1,0,0,1,0.5,0.25],"children":["circle","rounded"]},
            "circle":{"id":"circle","kind":"ellipse","width":2,"height":2,
                "transform":[1,0,0,1,0.5,0.375],"opacity":0.63,
                "fills":[{"kind":"solid","color":"#7766cc"}],
                "strokes":[{"width":0.0625,"cap":"round","join":"round","paint":{"kind":"solid","color":"#224466"}}]},
            "rounded":{"id":"rounded","kind":"rectangle","width":1.5,"height":1,
                "radii":[0.25,0.25,0.25,0.25],"smoothing":0.6,
                "transform":[1,0,0,1,1.75,1.125],"opacity":0.5,
                "fills":[{"kind":"solid","color":"#dd6633"}]}
        }});
    let mut retained = Engine::new();
    retained.load_document(&document.to_string()).unwrap();
    for (step, (zoom, x, y)) in [
        (1., 0., 0.), (32., 0.375, -0.125), (32., 0.625, 0.375),
        (32., -7.375, 3.125), (1., 0.375, 0.125), (32., 0.375, -0.125),
    ].into_iter().enumerate() {
        let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":128,"height":96,
            "rasterProfile":"figmaSubpixel","transparent":true,"view":{"x":x,"y":y,"zoom":zoom}})).unwrap();
        if step == 3 {
            let transform = Transform([1., 0., 0., 1., 0.875, 0.5]);
            assert!(retained.apply_interaction_transforms(&[("circle".into(), transform)].into_iter().collect()).unwrap());
            document["nodes"]["circle"]["transform"] = json!(transform);
        }
        let mut fresh = Engine::new();
        fresh.load_document(&document.to_string()).unwrap();
        assert_eq!(retained.compile_gpu(&options).unwrap().into_packet().unwrap(),
            fresh.compile_gpu(&options).unwrap().into_packet().unwrap(), "exact scene packet at step {step}");
        let pixels = retained.render(&options).unwrap();
        assert_eq!(pixels, fresh.render(&options).unwrap(), "CPU coverage at step {step}");
        assert!(pixels.chunks_exact(4).any(|rgba| rgba[3] > 0 && rgba[3] < 255));
    }
}

#[test]
fn raster_addresses_reject_overflow_and_unsafe_integer_coordinates_before_iteration() {
    use futureox_design_kernel::tile_stack::raster_addresses;
    for (bounds, zoom) in [
        ([f64::MAX, 0., 1., 1.], 32.),
        ([f64::MAX, 0., f64::MAX, 1.], 1.),
        ([9_007_199_254_740_992., 0., 512., 512.], 1.),
        ([0., -9_007_199_254_740_992., 512., 512.], 1.),
        ([i32::MAX as f64, 0., 512., 512.], 1.),
    ] {
        assert_eq!(raster_addresses(bounds, zoom, 64, [0., 0.]).unwrap_err(),
            "Tile address exceeds exact coordinate range");
    }
    assert_eq!(raster_addresses([0., 0., 512. * 257., 512. * 256.], 1., usize::MAX, [0., 0.]).unwrap_err(),
        "Visible tile budget exceeded");
    let addresses = raster_addresses([-16.01171875, -0.00390625, 16., 16.], 32., 8, [0.375, 0.125]).unwrap();
    assert_eq!(addresses, vec![[-1, 0]]);
}
