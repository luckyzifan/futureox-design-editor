use futureox_design_kernel::{
    Engine, RenderOptions, View,
    bounds::path_bounds,
    editing::snap_pixel,
    math::{Point, Transform},
    path::{Command, Path},
    preview,
};
use serde_json::json;
fn options(density: u8, zoom: f64) -> RenderOptions {
    RenderOptions {
        page_id: "p".into(),
        width: 128,
        height: 128,
        view: View { x: 0., y: 0., zoom },
        transparent: true,
        grid: false,
        pixel_preview: Some(density),
        animation: None,
        raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
        interactive_effects: false,
        checkerboard: false,
    }
}
fn doc() -> String {
    json!({"schemaVersion":1,"id":"d","name":"preview","pages":[{"id":"p","name":"p","children":["r"],"background":"#ffffff"}],"nodes":{"r":{"id":"r","kind":"rectangle","transform":[1,0,0,1,8.125,8.125],"width":20.4,"height":12.6,"fills":[{"kind":"solid","color":"#ff0000"}]}}}).to_string()
}
#[test]
fn preview_grid_is_anchored_to_document_pixels_under_fractional_pan() {
    for density in [1, 2] {
        for x in [-9.75, -0.1, 0., 0.125, 5.3] {
            let mut o = options(density, 4.);
            o.view.x = x;
            o.view.y = x * 0.7;
            let p = preview::plan(&o).unwrap();
            assert_eq!(p.source.view.x.fract(), 0.);
            assert_eq!(p.source.view.y.fract(), 0.);
            assert_eq!(p.source.view.zoom, f64::from(density));
            assert!(p.source.pixel_preview.is_none());
            let world = (-p.source.view.x) / f64::from(density);
            assert!((world * o.view.zoom + o.view.x - p.presentation.offset_x).abs() < 1e-10);
        }
    }
}
#[test]
fn one_and_two_x_previews_keep_discrete_document_pixel_blocks() {
    let mut e = Engine::new();
    e.load_document(&doc()).unwrap();
    for density in [1, 2] {
        let pixels = e.render(&options(density, 4.)).unwrap();
        let block = 4 / density as usize;
        for y in (0..128).step_by(block) {
            for x in (0..128).step_by(block) {
                for yy in y..y + block {
                    for xx in x..x + block {
                        assert_eq!(
                            &pixels[(y * 128 + x) * 4..(y * 128 + x) * 4 + 4],
                            &pixels[(yy * 128 + xx) * 4..(yy * 128 + xx) * 4 + 4]
                        );
                    }
                }
            }
        }
    }
}
#[test]
fn preview_minification_averages_premultiplied_colors() {
    let mut e = Engine::new();
    let d = serde_json::from_str::<serde_json::Value>(&doc()).unwrap();
    let mut d = d;
    d["nodes"]["r"]["transform"] = json!([1, 0, 0, 1, 8, 8]);
    d["nodes"]["r"]["width"] = json!(1);
    d["nodes"]["r"]["height"] = json!(32);
    e.load_document(&d.to_string()).unwrap();
    let pixels = e.render(&options(1, 0.5)).unwrap();
    let p = &pixels[(5 * 128 + 4) * 4..(5 * 128 + 4) * 4 + 4];
    assert_eq!(p[0], 255);
    assert_eq!(p[1], 0);
    assert!((i32::from(p[3]) - 128).abs() <= 1);
}

#[test]
fn preview_minification_conserves_constant_color_at_maximum_footprint() {
    let mut o = options(1, 1. / 64.);
    o.width = 1;
    o.height = 1;
    let plan = preview::plan(&o).unwrap();
    assert_eq!((plan.source.width, plan.source.height), (64, 64));
    assert_eq!(preview::resample(&vec![255; 64 * 64 * 4], &plan), [255; 4]);
    let mut transparent = vec![255; 64 * 64 * 4];
    for p in transparent.chunks_exact_mut(4) {
        p[3] = 0;
    }
    assert_eq!(preview::resample(&transparent, &plan), [0; 4]);
}
#[test]
fn gpu_preview_command_includes_output_mapping_without_cpu_bitmap() {
    let mut e = Engine::new();
    e.load_document(&doc()).unwrap();
    let p = e.compile_gpu(&options(1, 4.)).unwrap();
    assert_eq!((p.width, p.height), (32, 32));
    let target = p.presentation.unwrap();
    assert_eq!((target.width, target.height), (128, 128));
    assert_eq!(target.scale, 4.);
    assert!(p.vertices.is_empty());
    assert!(!p.curves.is_empty());
    assert!(
        p.nodes
            .values()
            .any(|n| n.fill.area.is_some() && n.fill.count > 0)
    );
}
#[test]
fn preview_invalid_density_and_resource_limits_are_explicit() {
    let mut o = options(3, 4.);
    assert!(preview::plan(&o).is_err());
    o.pixel_preview = Some(1);
    o.view.zoom = 0.001;
    assert!(preview::plan(&o).is_err());
    o.view.zoom = 0.1;
    o.width = 8192;
    o.height = 1024;
    assert!(preview::plan(&o).is_err());
}
#[test]
fn cubic_true_bounds_exclude_control_handles() {
    let path = Path {
        commands: vec![
            Command::Move(Point::new(0., 0.)),
            Command::Cubic(
                Point::new(0., 100.),
                Point::new(100., 100.),
                Point::new(100., 0.),
            ),
            Command::Close,
        ],
        ..Path::default()
    };
    let b = path_bounds(&path, Transform::default()).unwrap();
    assert_eq!((b.x, b.y, b.width, b.height), (0., 0., 100., 75.));
}
#[test]
fn transformed_cubic_bounds_match_independent_dense_sampling() {
    let a = Point::new(0., 0.);
    let b = Point::new(0., 100.);
    let c = Point::new(100., 100.);
    let d = Point::new(100., 0.);
    let path = Path {
        commands: vec![Command::Move(a), Command::Cubic(b, c, d)],
        ..Path::default()
    };
    let angle = 17f64.to_radians();
    let m = Transform([
        angle.cos(),
        angle.sin(),
        -angle.sin(),
        angle.cos(),
        4.5,
        -9.1,
    ]);
    let expected = path_bounds(&path, m).unwrap();
    let mut min = Point::new(f64::INFINITY, f64::INFINITY);
    let mut max = Point::new(f64::NEG_INFINITY, f64::NEG_INFINITY);
    for i in 0..=100_000 {
        let t = i as f64 / 100_000.;
        let s = 1. - t;
        let p = m
            .point(a * (s * s * s) + b * (3. * s * s * t) + c * (3. * s * t * t) + d * (t * t * t));
        min.x = min.x.min(p.x);
        min.y = min.y.min(p.y);
        max.x = max.x.max(p.x);
        max.y = max.y.max(p.y);
    }
    for (a, b) in [
        (expected.x, min.x),
        (expected.y, min.y),
        (expected.width, max.x - min.x),
        (expected.height, max.y - min.y),
    ] {
        assert!((a - b).abs() < 1e-6);
    }
}
#[test]
fn affine_ellipse_bounds_use_arc_extrema() {
    let m = Transform([1.2, 0.3, 0.4, 0.8, 7., -3.]);
    let b = path_bounds(&Path::ellipse(60., 100.), m).unwrap();
    let centre = m.point(Point::new(30., 50.));
    let rx = (36f64 * 36. + 20. * 20.).sqrt();
    let ry = (9f64 * 9. + 40. * 40.).sqrt();
    assert!((b.x - (centre.x - rx)).abs() < 1e-10);
    assert!((b.y - (centre.y - ry)).abs() < 1e-10);
    assert!((b.width - 2. * rx).abs() < 1e-10);
    assert!((b.height - 2. * ry).abs() < 1e-10);
}
#[test]
fn pixel_snap_preserves_manual_input_until_an_edit_command_requests_it() {
    let p = snap_pixel(Point::new(8.125 + 5., 8.125)).unwrap();
    assert_eq!(p, Point::new(13., 8.));
    assert_eq!(
        snap_pixel(Point::new(-2.5, 3.5)).unwrap(),
        Point::new(-2., 4.)
    );
    assert!(snap_pixel(Point::new(f64::NAN, 0.)).is_err());
}
