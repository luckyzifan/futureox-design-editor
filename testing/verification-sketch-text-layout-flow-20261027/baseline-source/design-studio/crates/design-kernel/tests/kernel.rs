use futureox_design_kernel::{
    Engine, RenderOptions, View,
    blend::{Pixel, Surface, over},
    boolean::{Operation, boolean},
    effects,
    math::{Point, Rect, Transform},
    path::{Command, Contour, Path, area},
    raster::rasterize,
    stroke,
};
use serde_json::{Value, json};
fn rect(x: f64, y: f64, w: f64, h: f64) -> Contour {
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
fn total(cs: &[Contour]) -> f64 {
    cs.iter().map(|c| area(&c.points)).sum::<f64>().abs()
}
fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-5, "{a} != {b}");
}
fn paint(color: &str) -> Value {
    json!({"kind":"solid","color":color,"opacity":1,"visible":true,"stops":[],"blend":"normal"})
}
fn shape(id: &str, x: f64, y: f64, w: f64, h: f64, color: &str) -> Value {
    json!({"id":id,"kind":"rectangle","transform":[1,0,0,1,x,y],"width":w,"height":h,"fills":[paint(color)]})
}
fn document(nodes: Vec<Value>, roots: Vec<&str>) -> Value {
    let nodes: serde_json::Map<String, Value> = nodes
        .into_iter()
        .map(|n| (n["id"].as_str().unwrap().to_owned(), n))
        .collect();
    json!({"schemaVersion":1,"id":"doc","name":"fixture","pages":[{"id":"page","name":"Page","background":"#ffffff","children":roots}],"nodes":nodes})
}
fn options(w: u32, h: u32) -> RenderOptions {
    RenderOptions {
        page_id: "page".into(),
        width: w,
        height: h,
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
    }
}
fn render(doc: Value, w: u32, h: u32) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    engine.render(&options(w, h)).unwrap()
}
fn pixel(bytes: &[u8], w: usize, x: usize, y: usize) -> [u8; 4] {
    bytes[(y * w + x) * 4..(y * w + x) * 4 + 4]
        .try_into()
        .unwrap()
}

#[test]
fn fractional_pixel_area() {
    let mask = rasterize(&[rect(0.25, 0., 1., 1.)], Rect::new(0, 0, 3, 2), true);
    close(mask.at(0, 0) as f64, 0.75);
    close(mask.at(1, 0) as f64, 0.25);
    close(mask.data.iter().sum::<f32>() as f64, 1.);
}
#[test]
fn offscreen_edges_keep_winding() {
    let mask = rasterize(
        &[rect(-100., -100., 200., 200.)],
        Rect::new(0, 0, 16, 16),
        false,
    );
    assert!(mask.data.iter().all(|a| *a == 1.));
}
#[test]
fn evenodd_hole_and_nonzero_overlap() {
    let cs = vec![rect(0., 0., 10., 10.), rect(2., 2., 6., 6.)];
    let even = rasterize(&cs, Rect::new(0, 0, 10, 10), true);
    let nonzero = rasterize(&cs, Rect::new(0, 0, 10, 10), false);
    assert_eq!(even.at(5, 5), 0.);
    assert_eq!(nonzero.at(5, 5), 1.);
}
#[test]
fn reversed_nonzero_hole() {
    let mut inner = rect(2., 2., 6., 6.);
    inner.points.reverse();
    let mask = rasterize(
        &[rect(0., 0., 10., 10.), inner],
        Rect::new(0, 0, 10, 10),
        false,
    );
    assert_eq!(mask.at(5, 5), 0.);
}
#[test]
fn self_intersection_raster() {
    let c = Contour {
        points: vec![
            Point::new(0., 0.),
            Point::new(10., 10.),
            Point::new(0., 10.),
            Point::new(10., 0.),
        ],
        closed: true,
    };
    let m = rasterize(&[c], Rect::new(0, 0, 10, 10), true);
    close(m.data.iter().sum::<f32>() as f64, 50.);
}
#[test]
fn cubic_collinear_overshoot_is_not_discarded() {
    let p = Path {
        commands: vec![
            Command::Move(Point::new(0., 0.)),
            Command::Cubic(
                Point::new(100., 0.),
                Point::new(-100., 0.),
                Point::new(1., 0.),
            ),
        ],
    };
    let ps = p.flatten(Transform::default(), 0.1).unwrap();
    assert!(ps[0].points.iter().any(|p| p.x < -20.));
    assert!(ps[0].points.iter().any(|p| p.x > 20.));
}
#[test]
fn coincident_cubic_endpoints_retain_loop() {
    let p = Path {
        commands: vec![
            Command::Move(Point::default()),
            Command::Cubic(
                Point::new(100., 100.),
                Point::new(-100., 100.),
                Point::default(),
            ),
            Command::Close,
        ],
    };
    assert!(
        p.flatten(Transform::default(), 0.1).unwrap()[0]
            .points
            .len()
            > 20
    );
}
#[test]
fn device_scale_increases_curve_resolution() {
    let p = Path::ellipse(100., 100.);
    let a = p.flatten(Transform::default(), 0.125).unwrap();
    let b = p
        .flatten(Transform([20., 0., 5., 2., 0., 0.]), 0.125)
        .unwrap();
    assert!(b[0].points.len() > a[0].points.len());
}
#[test]
fn cubic_flatten_preserves_endpoints() {
    let p = Path {
        commands: vec![
            Command::Move(Point::new(1., 2.)),
            Command::Cubic(
                Point::new(5., -20.),
                Point::new(90., 60.),
                Point::new(100., 30.),
            ),
        ],
    };
    let a = p.flatten(Transform::default(), 0.1).unwrap();
    assert_eq!(a[0].points.first(), Some(&Point::new(1., 2.)));
    assert_eq!(a[0].points.last(), Some(&Point::new(100., 30.)));
}
#[test]
fn transform_inverse_round_trip() {
    let m = Transform([2., 0.3, -0.5, 1.7, 1e5, -500.]);
    let p = Point::new(-1., 40.);
    let q = m.inverse().unwrap().point(m.point(p));
    close(p.x, q.x);
    close(p.y, q.y);
}
#[test]
fn boolean_area_operations() {
    let a = vec![rect(0., 0., 100., 100.)];
    let b = vec![rect(50., 20., 100., 100.)];
    for (op, expected) in [
        (Operation::Union, 16000.),
        (Operation::Subtract, 6000.),
        (Operation::Intersect, 4000.),
        (Operation::Exclude, 12000.),
    ] {
        close(
            total(&boolean(&[a.clone(), b.clone()], op).unwrap()),
            expected,
        );
    }
}
#[test]
fn boolean_coincident_and_touching() {
    let a = vec![rect(0., 0., 10., 10.)];
    assert!(
        boolean(&[a.clone(), a.clone()], Operation::Subtract)
            .unwrap()
            .is_empty()
    );
    close(
        total(&boolean(&[a, vec![rect(10., 0., 10., 10.)]], Operation::Union).unwrap()),
        200.,
    );
}
#[test]
fn boolean_holes_survive() {
    let out = boolean(
        &[vec![rect(0., 0., 10., 10.)], vec![rect(2., 2., 6., 6.)]],
        Operation::Subtract,
    )
    .unwrap();
    assert_eq!(out.len(), 2);
    close(total(&out), 64.);
    let m = rasterize(&out, Rect::new(0, 0, 10, 10), true);
    assert_eq!(m.at(5, 5), 0.);
}
#[test]
fn boolean_self_crossing() {
    let bow = Contour {
        points: vec![
            Point::new(0., 0.),
            Point::new(100., 100.),
            Point::new(0., 100.),
            Point::new(100., 0.),
        ],
        closed: true,
    };
    close(
        total(&boolean(&[vec![bow]], Operation::Union).unwrap()),
        5000.,
    );
}
#[test]
fn strokes_keep_anisotropic_transform() {
    let cs = vec![Contour {
        points: vec![Point::new(10., 10.), Point::new(30., 10.)],
        closed: false,
    }];
    let mut outline = stroke::outline(&cs, 4., "round", "round", 0.02).unwrap();
    let m = Transform([3., 0., 0., 1., 0., 0.]);
    for c in &mut outline {
        for p in &mut c.points {
            *p = m.point(*p);
        }
    }
    let b = Rect::from_points(outline.iter().flat_map(|c| c.points.iter().copied()));
    assert!(b.w >= 72);
    assert_eq!(b.h, 4);
}
#[test]
fn dash_phase_survives_polyline_vertices() {
    let cs = vec![Contour {
        points: vec![Point::new(0., 0.), Point::new(7., 0.), Point::new(20., 0.)],
        closed: false,
    }];
    let dash = stroke::dash(&cs, "10 10").unwrap();
    assert_eq!(dash.len(), 1);
    close(dash[0].points.last().unwrap().x, 10.);
}
#[test]
fn invalid_dash_rejected() {
    assert!(stroke::dash(&[], "-1 2").is_err());
}
#[test]
fn cap_coverage() {
    let cs = vec![Contour {
        points: vec![Point::new(10., 10.), Point::new(30., 10.)],
        closed: false,
    }];
    let butt = rasterize(
        &stroke::outline(&cs, 4., "butt", "round", 0.02).unwrap(),
        Rect::new(0, 0, 40, 20),
        false,
    );
    let square = rasterize(
        &stroke::outline(&cs, 4., "square", "round", 0.02).unwrap(),
        Rect::new(0, 0, 40, 20),
        false,
    );
    close(butt.data.iter().sum::<f32>() as f64, 80.);
    close(square.data.iter().sum::<f32>() as f64, 96.);
}
#[test]
fn blend_transparent_source() {
    let d = Pixel::rgba(0.2, 0.4, 0.6, 0.7);
    assert_eq!(over(d, Pixel::default(), "multiply"), d);
}
#[test]
fn source_over_premultiplied() {
    let p = over(
        Pixel::rgba(0., 0., 1., 0.5),
        Pixel::rgba(1., 0., 0., 0.5),
        "normal",
    );
    assert_eq!(p.0, [0.5, 0., 0.25, 0.75]);
}
#[test]
fn separable_blend_reference() {
    let a = Pixel::rgba(0.25, 0.5, 0.75, 1.);
    let b = Pixel::rgba(0.5, 0.5, 0.5, 1.);
    assert_eq!(over(a, b, "multiply").0, [0.125, 0.25, 0.375, 1.]);
    assert_eq!(over(a, b, "screen").0, [0.625, 0.75, 0.875, 1.]);
}
#[test]
fn all_blends_bounded() {
    for mode in [
        "normal",
        "multiply",
        "screen",
        "overlay",
        "darken",
        "lighten",
        "color-dodge",
        "color-burn",
        "hard-light",
        "soft-light",
        "difference",
        "exclusion",
        "hue",
        "saturation",
        "color",
        "luminosity",
    ] {
        for a in [0., 0.1, 0.5, 1.] {
            let p = over(
                Pixel::rgba(0.1, 0.9, 0.6, a),
                Pixel::rgba(0.9, 0.2, 0.1, 0.7),
                mode,
            );
            assert!(
                p.0.iter()
                    .all(|v| v.is_finite() && *v >= -0.00001 && *v <= 1.00001),
                "{mode} {p:?}"
            );
        }
    }
}
#[test]
fn blur_does_not_introduce_black_fringe() {
    let mut s = Surface::new(Rect::new(0, 0, 32, 32)).unwrap();
    s.pixels[16 * 32 + 16] = Pixel::rgba(1., 0., 0., 1.);
    let b = effects::blur(&s, 2.).unwrap();
    for p in &b.pixels {
        if p.0[3] > 1e-7 {
            close(p.rgb()[0] as f64, 1.);
            assert_eq!(p.0[1], 0.);
        }
    }
}
#[test]
fn morphology_expands_alpha() {
    let mut s = Surface::new(Rect::new(0, 0, 9, 9)).unwrap();
    s.pixels[40] = Pixel::rgba(1., 1., 1., 1.);
    let d = effects::morphology_alpha(&s, 1, true).unwrap();
    assert_eq!(d.pixels.iter().filter(|p| p.0[3] == 1.).count(), 9);
}
#[test]
fn solid_scene_pixel_contract() {
    let bytes = render(
        document(vec![shape("r", 2., 3., 5., 6., "#ff0000")], vec!["r"]),
        16,
        16,
    );
    assert_eq!(pixel(&bytes, 16, 3, 4), [255, 0, 0, 255]);
    assert_eq!(pixel(&bytes, 16, 0, 0), [0, 0, 0, 0]);
}
#[test]
fn group_opacity_is_applied_once() {
    let mut group = shape("g", 0., 0., 20., 20., "#ffffff");
    group["kind"] = json!("group");
    group["fills"] = json!([]);
    group["children"] = json!(["a", "b"]);
    group["opacity"] = json!(0.5);
    let bytes = render(
        document(
            vec![
                group,
                shape("a", 0., 0., 10., 10., "#ff0000"),
                shape("b", 5., 0., 10., 10., "#00ff00"),
            ],
            vec!["g"],
        ),
        20,
        20,
    );
    assert_eq!(pixel(&bytes, 20, 7, 5), [0, 255, 0, 128]);
}
#[test]
fn child_clip_and_mask() {
    let mut group = shape("g", 0., 0., 10., 10., "#ffffff");
    group["kind"] = json!("frame");
    group["clip"] = json!(true);
    group["fills"] = json!([]);
    group["children"] = json!(["m", "r"]);
    let mut mask = shape("m", 3., 0., 5., 15., "#ffffff");
    mask["mask"] = json!(true);
    mask["opacity"] = json!(0.5);
    let bytes = render(
        document(
            vec![group, mask, shape("r", 0., 0., 15., 15., "#ff0000")],
            vec!["g"],
        ),
        20,
        20,
    );
    assert_eq!(pixel(&bytes, 20, 5, 5), [255, 0, 0, 128]);
    assert_eq!(pixel(&bytes, 20, 1, 5)[3], 0);
    assert_eq!(pixel(&bytes, 20, 5, 12)[3], 0);
}
#[test]
fn blur_at_viewport_edge_matches_larger_render() {
    let mut n = shape("r", -4., 4., 10., 10., "#ff0000");
    n["effects"] = json!([{"kind":"blur","radius":8,"color":"#000000","opacity":1}]);
    let doc = document(vec![n], vec!["r"]);
    let mut e = Engine::new();
    e.load_document(&doc.to_string()).unwrap();
    let small = e.render(&options(24, 24)).unwrap();
    let mut o = options(64, 64);
    o.view.x = 20.;
    o.view.y = 20.;
    let big = e.render(&o).unwrap();
    for y in 0..24 {
        for x in 0..24 {
            assert_eq!(pixel(&small, 24, x, y), pixel(&big, 64, x + 20, y + 20));
        }
    }
}
#[test]
fn png_signature_from_native_kernel() {
    let d = document(vec![shape("r", 0., 0., 10., 10., "#123456")], vec!["r"]);
    let mut e = Engine::new();
    e.load_document(&d.to_string()).unwrap();
    let png = e.render_png(&options(16, 16)).unwrap();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
}
#[test]
fn reject_cycles_and_invalid_view() {
    let mut n = shape("r", 0., 0., 10., 10., "#123456");
    n["children"] = json!(["r"]);
    let mut e = Engine::new();
    assert!(
        e.load_document(&document(vec![n], vec!["r"]).to_string())
            .is_err()
    );
    let d = document(vec![shape("r", 0., 0., 10., 10., "#123456")], vec!["r"]);
    e.load_document(&d.to_string()).unwrap();
    assert!(e.render(&options(16000, 16000)).is_err());
}

#[test]
fn nonzero_network_preserves_authored_hole_orientation() {
    let outer = rect(0., 0., 20., 20.);
    let mut inner = rect(5., 5., 10., 10.);
    inner.points.reverse();
    let mut vertices = Vec::new();
    let mut edges = Vec::new();
    for (ring, c) in [outer, inner].into_iter().enumerate() {
        for (i, p) in c.points.iter().enumerate() {
            vertices.push(json!({"id":format!("v{ring}-{i}"),"x":p.x,"y":p.y}));
            edges.push(json!({"id":format!("e{ring}-{i}"),"from":format!("v{ring}-{i}"),"to":format!("v{ring}-{}",(i+1)%c.points.len())}));
        }
    }
    let mut n = shape("v", 0., 0., 20., 20., "#ff0000");
    n["kind"] = json!("vector");
    n["network"] = json!({"vertices":vertices,"edges":edges,"fillRule":"nonzero"});
    let bytes = render(document(vec![n], vec!["v"]), 24, 24);
    assert_eq!(pixel(&bytes, 24, 10, 10)[3], 0);
    assert_eq!(pixel(&bytes, 24, 2, 2), [255, 0, 0, 255]);
}
#[test]
fn boolean_nonzero_differs_from_evenodd_for_overlapping_contours() {
    let cs = vec![rect(0., 0., 10., 10.), rect(5., 0., 10., 10.)];
    let nz = futureox_design_kernel::boolean::boolean_with_rules(
        std::slice::from_ref(&cs),
        Operation::Union,
        &[false],
    )
    .unwrap();
    let eo = boolean(&[cs], Operation::Union).unwrap();
    close(total(&nz), 150.);
    close(total(&eo), 100.);
}
#[test]
fn upscaled_image_edges_remain_opaque() {
    use base64::Engine as _;
    use image::ImageEncoder;
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&[255, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
        .unwrap();
    let image = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    );
    let mut n = shape("image", 0., 0., 8., 8., "#ffffff");
    n["fills"][0]["kind"] = json!("image");
    n["fills"][0]["image"] = json!(image);
    let bytes = render(document(vec![n], vec!["image"]), 8, 8);
    assert!(bytes.chunks_exact(4).all(|p| p == [255, 0, 0, 255]));
}
#[test]
fn texture_moves_with_shape() {
    let mut n = shape("r", 5., 5., 20., 20., "#ff0000");
    n["effects"] = json!([{"kind":"texture","radius":0,"amount":3,"opacity":1,"color":"#000000"}]);
    let d = document(vec![n], vec!["r"]);
    let mut e = Engine::new();
    e.load_document(&d.to_string()).unwrap();
    let a = e.render(&options(32, 32)).unwrap();
    let mut o = options(64, 64);
    o.view.x = 20.;
    o.view.y = 20.;
    let b = e.render(&o).unwrap();
    for y in 0..32 {
        for x in 0..32 {
            assert_eq!(pixel(&a, 32, x, y), pixel(&b, 64, x + 20, y + 20));
        }
    }
}
#[test]
fn positive_inner_shadow_spread_grows_inward() {
    let mut n = shape("r", 0., 0., 20., 20., "#ffffff");
    n["effects"] =
        json!([{"kind":"inner-shadow","radius":0,"spread":3,"color":"#000000","opacity":1}]);
    let bytes = render(document(vec![n], vec!["r"]), 20, 20);
    assert_eq!(pixel(&bytes, 20, 1, 10), [0, 0, 0, 255]);
    assert_eq!(pixel(&bytes, 20, 10, 10), [255, 255, 255, 255]);
}
#[test]
fn random_axis_aligned_boolean_area_property() {
    let mut seed = 17u64;
    let mut next = || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        ((seed >> 32) % 1000) as f64 / 10.
    };
    for _ in 0..80 {
        let (x, y, w, h) = (next(), next(), next() + 1., next() + 1.);
        let (a, b, c, d) = (next(), next(), next() + 1., next() + 1.);
        let intersection =
            ((x + w).min(a + c) - x.max(a)).max(0.) * ((y + h).min(b + d) - y.max(b)).max(0.);
        let inputs = [vec![rect(x, y, w, h)], vec![rect(a, b, c, d)]];
        close(
            total(&boolean(&inputs, Operation::Union).unwrap()),
            w * h + c * d - intersection,
        );
        close(
            total(&boolean(&inputs, Operation::Subtract).unwrap()),
            w * h - intersection,
        );
    }
}

#[test]
fn analytic_ellipse_vertices_stay_on_the_ellipse() {
    let cs = Path::ellipse(20000., 10000.)
        .flatten(Transform::default(), 0.125)
        .unwrap();
    for p in &cs[0].points {
        let radius = ((p.x - 10000.) / 10000.).powi(2) + ((p.y - 5000.) / 5000.).powi(2);
        assert!((radius - 1.).abs() < 1e-12);
    }
}
#[test]
fn picking_respects_dashed_gaps() {
    let n:futureox_design_kernel::scene::Node=serde_json::from_value(json!({"id":"v","kind":"vector","width":100,"height":10,"network":{"vertices":[{"id":"a","x":0,"y":0},{"id":"b","x":100,"y":0}],"edges":[{"id":"e","from":"a","to":"b"}],"fillRule":"evenodd"},"strokes":[{"width":4,"cap":"butt","join":"round","dash":"10 10","paint":paint("#ff0000")}]})).unwrap();
    assert!(futureox_design_kernel::hit_test(&n, Point::new(5., 0.), 0.).unwrap());
    assert!(!futureox_design_kernel::hit_test(&n, Point::new(15., 0.), 0.).unwrap());
}
#[test]
fn huge_device_bounds_do_not_overflow() {
    let r = Rect::from_points([Point::new(-1e30, -1e30), Point::new(1e30, 1e30)].into_iter());
    assert_eq!(
        r.intersect(Rect::new(0, 0, 20, 20)),
        Rect::new(0, 0, 20, 20)
    );
}
#[test]
fn composed_transform_budget_is_reported() {
    let mut g = shape("g", 0., 0., 100., 100., "#ffffff");
    g["kind"] = json!("group");
    g["transform"] = json!([1e7, 0, 0, 1e7, 0, 0]);
    g["children"] = json!(["r"]);
    let mut r = shape("r", 0., 0., 10., 10., "#ffffff");
    r["transform"] = json!([1e7, 0, 0, 1e7, 0, 0]);
    let mut e = Engine::new();
    e.load_document(&document(vec![g, r], vec!["g"]).to_string())
        .unwrap();
    assert!(
        e.render(&options(20, 20))
            .unwrap_err()
            .contains("precision budget")
    );
}

#[test]
fn gpu_geometry_clips_huge_coordinates_and_preserves_signed_area() {
    let mut engine = Engine::new();
    engine
        .load_document(
            &document(
                vec![shape("r", -10000., -10000., 20000., 20000., "#ff0000")],
                vec!["r"],
            )
            .to_string(),
        )
        .unwrap();
    let scene = engine.compile_gpu(&options(32, 24)).unwrap();
    let path = &scene.nodes["r"].fill;
    assert_eq!(path.count % 3, 0);
    assert!(path.count > 0);
    // The analytic packet describes a clipped interval rectangle, never a
    // width*height coverage bitmap. Its bounds preserve exactly 32*24 area.
    let area = path.area.as_ref().unwrap();
    let data = &scene.curves[area.first as usize * 4..(area.first + area.count) as usize * 4];
    assert_eq!(data.len(), 28);
    assert_eq!(data[0], 1.);
    assert_eq!(&data[4..12], &[0., 32., 0., 0., 0., 24., 0., 0.]);
    assert_eq!((data[5] - data[4]) * (data[9] - data[8]), 768.);
    let encoded = serde_json::to_value(scene).unwrap();
    assert!(encoded.get("pixels").is_none());
    assert!(encoded.get("rgba").is_none());
}
#[test]
fn gpu_compiler_keeps_nested_transform_clip_mask_and_stroke_union() {
    let mut parent = shape("p", 10., 12., 80., 60., "#ffffff");
    parent["kind"] = json!("frame");
    parent["clip"] = json!(true);
    parent["children"] = json!(["c"]);
    parent["transform"] = json!([2, 0, 0, 2, 10, 12]);
    let mut child = shape("c", 3., 4., 12., 14., "#ff0000");
    child["mask"] = json!(true);
    child["strokes"] = json!([{"paint":paint("#000000"),"width":4,"align":"outside","cap":"round","join":"round","dash":"3 2","visible":true}]);
    let mut engine = Engine::new();
    engine
        .load_document(&document(vec![parent, child], vec!["p"]).to_string())
        .unwrap();
    let plan = engine.compile_gpu(&options(128, 128)).unwrap();
    assert!(plan.nodes["p"].clip);
    assert!(plan.nodes["c"].mask);
    assert_eq!(plan.nodes["c"].matrix.0, [2., 0., 0., 2., 16., 20.]);
    assert_eq!(plan.nodes["c"].strokes[0].path.rule, "nonzero");
    assert!(plan.nodes["c"].strokes[0].path.area.is_some());
    assert!(plan.nodes["c"].strokes[0].path.count > 0);
}

#[test]
fn gpu_coverage_bounds_exclude_effect_halo_but_keep_layer_extent() {
    let mut n = shape("r", 50., 50., 20., 20., "#ffffff");
    n["strokes"] = json!([{"paint":paint("#000000"),"width":4,"widthProfile":[{"position":0,"left":1,"right":1}]}]);
    n["effects"] =
        json!([{"kind":"shadow","radius":20,"x":10,"y":10,"color":"#000000","opacity":0.5}]);
    let mut e = Engine::new();
    e.load_document(&document(vec![n], vec!["r"]).to_string())
        .unwrap();
    let plan = e.compile_gpu(&options(160, 160)).unwrap();
    let n = &plan.nodes["r"];
    assert!(n.rect.w > 100 && n.rect.h > 100);
    assert_eq!(n.fill.rect, Rect::new(49, 49, 22, 22));
    assert!(n.strokes[0].path.rect.w <= 26 && n.strokes[0].path.rect.h <= 26);
}
#[test]
fn gpu_empty_and_invalid_viewports_have_explicit_results() {
    let mut engine = Engine::new();
    engine
        .load_document(&document(vec![], vec![]).to_string())
        .unwrap();
    let plan = engine.compile_gpu(&options(16, 16)).unwrap();
    assert!(plan.vertices.is_empty());
    assert!(engine.compile_gpu(&options(0, 16)).is_err());
    assert!(engine.compile_gpu(&options(8192, 8192)).is_err());
    let mut invalid = options(16, 16);
    invalid.view.x = f64::INFINITY;
    assert!(engine.compile_gpu(&invalid).is_err());
}

#[test]
fn retained_paths_match_fresh_compilation_after_edits_and_undo() {
    let original = document(vec![shape("a", 8., 8., 22., 24., "#ff0000")], vec!["a"]);
    let mut engine = Engine::new();
    let mut cases = vec![original.clone()];
    let mut changed = original.clone();
    changed["nodes"]["a"]["fills"][0]["color"] = json!("#0000ff");
    cases.push(changed.clone());
    changed["nodes"]["a"]["transform"] = json!([1, 0, 0, 1, 19, 11]);
    cases.push(changed.clone());
    changed["nodes"]["a"]["width"] = json!(38);
    cases.push(changed.clone());
    changed["nodes"]["a"]["radii"] = json!([8, 4, 6, 12]);
    cases.push(changed.clone());
    changed["nodes"]["a"]["smoothing"] = json!(0.8);
    cases.push(changed.clone());
    changed["nodes"]["a"]["kind"] = json!("star");
    changed["nodes"]["a"]["points"] = json!(7);
    cases.push(changed.clone());
    changed["nodes"]["a"]["innerRadius"] = json!(0.6);
    cases.push(changed.clone());
    cases.push(original);
    cases.push(document(vec![], vec![]));
    cases.push(changed);
    for document in cases {
        let json = document.to_string();
        engine.load_document(&json).unwrap();
        let mut fresh = Engine::new();
        fresh.load_document(&json).unwrap();
        let retained = engine.compile_gpu(&options(64, 64)).unwrap();
        let expected = fresh.compile_gpu(&options(64, 64)).unwrap();
        assert_eq!(retained.vertices, expected.vertices);
        assert_eq!(retained.curves, expected.curves);
        assert_eq!(
            engine.render(&options(64, 64)).unwrap(),
            fresh.render(&options(64, 64)).unwrap()
        );
    }
}

#[test]
fn gpu_interval_sharing_keeps_subpixel_offsets_and_clipping_distinct() {
    let mut engine = Engine::new();
    engine
        .load_document(
            &document(
                vec![
                    shape("a", 8., 8., 20., 20., "#ff0000"),
                    shape("b", 40., 8., 20., 20., "#0000ff"),
                    shape("c", 8.25, 40., 20., 20., "#00ff00"),
                    shape("d", -8., 40., 20., 20., "#ffffff"),
                ],
                vec!["a", "b", "c", "d"],
            )
            .to_string(),
        )
        .unwrap();
    let plan = engine.compile_gpu(&options(64, 64)).unwrap();
    let start = |id: &str| plan.nodes[id].fill.area.as_ref().unwrap().first;
    assert_eq!(start("a"), start("b"));
    assert_ne!(start("a"), start("c"));
    assert_ne!(start("a"), start("d"));
    let unshared: usize = plan
        .nodes
        .values()
        .map(|n| n.fill.area.as_ref().unwrap().count as usize * 4)
        .sum();
    assert!(plan.curves.len() < unshared);
}
