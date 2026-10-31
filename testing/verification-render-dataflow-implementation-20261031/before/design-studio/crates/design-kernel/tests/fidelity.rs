use futureox_design_kernel::{
    Engine, RenderOptions, View, analytic,
    fidelity::RasterProfile,
    math::{Point, Rect, Transform},
    path::{Command, Path},
};
use serde_json::json;
fn doc() -> String {
    json!({"schemaVersion":1,"id":"d","name":"pixel","pages":[{"id":"p","name":"p","children":["r"],"background":"#ffffff"}],"nodes":{"r":{"id":"r","kind":"rectangle","transform":[1,0,0,1,8.125,8.125],"width":20.4,"height":12.6,"fills":[{"kind":"solid","color":"#000000"}]}}}).to_string()
}

#[test]
fn resolve_quantizes_premultiplied_bytes_before_straight_alpha_conversion() {
    use futureox_design_kernel::fidelity::downsample;
    let translucent = [255, 0, 0, 128, 0, 255, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0];
    assert_eq!(downsample(&translucent, 1, 1), [128, 128, 0, 64]);
    // Native normalized texture-filter readbacks, distinct from MSAA resolve.
    for (a, b, expected) in [(159, 160, 159), (174, 175, 174), (127, 128, 128)] {
        let samples = [a, a, a, 255, a, a, a, 255, b, b, b, 255, b, b, b, 255];
        assert_eq!(
            downsample(&samples, 1, 1),
            [expected, expected, expected, 255]
        );
    }
    assert_eq!(
        downsample(&[255, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 1, 1),
        [0, 0, 0, 0]
    );
}
fn options() -> RenderOptions {
    RenderOptions {
        page_id: "p".into(),
        width: 128,
        height: 128,
        view: View {
            x: 0.,
            y: 0.,
            zoom: 1.,
        },
        transparent: false,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: RasterProfile::Figma,
        interactive_effects: false,
        checkerboard: false,
    }
}
#[test]
fn rectangle_matches_the_official_browser_export() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).unwrap();
    let actual = engine.render(&options()).unwrap();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../frontend/design-client/public/fidelity/resolve-controls-2026-10-08/ResolveQA-rectangle-1x.png");
    let expected = image::open(path).unwrap().into_rgba8();
    assert_eq!(expected.dimensions(), (128, 128));
    assert_eq!(actual, expected.into_raw());
    // Preserve all six original observations as well as the complete fresh PNG.
    let observed: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/figma-rectangle-reference.json"
    ))
    .unwrap();
    for pixel in observed["samples"].as_array().unwrap() {
        let x = pixel[0].as_u64().unwrap() as usize;
        let y = pixel[1].as_u64().unwrap() as usize;
        assert_eq!(
            actual[(y * 128 + x) * 4],
            pixel[2].as_u64().unwrap() as u8,
            "external pixel {x},{y}"
        );
    }
}

#[test]
fn every_spatial_byte_sum_matches_an_official_solid_vector_export() {
    let mut source = vec![0u8; 64 * 64 * 4];
    for n in 0..1024 {
        let mut sum = n % 1021;
        let mut values = [0u8; 4];
        for value in &mut values {
            *value = sum.min(255) as u8;
            sum -= usize::from(*value);
        }
        for k in 0..4 {
            let x = (n % 32) * 2 + k % 2;
            let y = (n / 32) * 2 + k / 2;
            let v = values[(k + n % 4) % 4];
            source[(y * 64 + x) * 4..(y * 64 + x) * 4 + 4].copy_from_slice(&[v, v, v, 255]);
        }
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../frontend/design-client/public/fidelity/resolve-controls-2026-10-08/ResolveQA-solid-spatial-sums.png");
    let expected = image::open(path).unwrap().into_rgba8();
    assert_eq!(expected.dimensions(), (32, 32));
    assert_eq!(
        futureox_design_kernel::fidelity::downsample(&source, 32, 32),
        expected.into_raw()
    );
}
#[test]
fn source_tile_validation_rejects_overflow_nonfinite_and_invalid_profile() {
    let mut e = Engine::new();
    e.load_document(&doc()).unwrap();
    let mut o = options();
    o.width = u32::MAX;
    assert!(e.render(&o).is_err());
    assert!(e.compile_gpu(&o).is_err());
    o = options();
    o.view.x = f64::NAN;
    assert!(e.render(&o).is_err());
    assert!(e.compile_gpu(&o).is_err());
    assert!(serde_json::from_value::<RenderOptions>(json!({"pageId":"p","width":128,"height":128,"view":{"x":0,"y":0,"zoom":1},"rasterProfile":"unknown"})).is_err());
}
#[test]
fn curve_commands_are_relative_to_the_actual_coverage_texture_and_preserve_extrema() {
    let p = Path {
        commands: vec![
            Command::Move(Point::new(8., 8.)),
            Command::Cubic(
                Point::new(8., 108.),
                Point::new(108., 108.),
                Point::new(108., 8.),
            ),
            Command::Close,
        ],
    };
    let data = analytic::segments(&p, Transform::default(), Rect::new(7, 7, 102, 77)).unwrap();
    assert!(data.len() > 32);
    let curve = |t: f64| {
        Point::new(
            8. + 100. * (3. * t * t - 2. * t * t * t),
            8. + 300. * t * (1. - t),
        )
    };
    for segment in data.chunks_exact(16) {
        assert_eq!(
            segment[0], 0.,
            "GPU and CPU share device-space line geometry"
        );
        let a = Point::new(f64::from(segment[4]) + 7., f64::from(segment[5]) + 7.);
        let b = Point::new(f64::from(segment[6]) + 7., f64::from(segment[7]) + 7.);
        for point in [a, a.lerp(b, 0.5), b] {
            let mut t = ((point.x - 8.) / 100.).clamp(0., 1.);
            for _ in 0..24 {
                let q = curve(t) - point;
                let first = Point::new(600. * t * (1. - t), 300. * (1. - 2. * t));
                let second = Point::new(600. - 1200. * t, -600.);
                t = (t - q.dot(first) / (first.dot(first) + q.dot(second))).clamp(0., 1.);
            }
            // Independent polynomial-distance oracle plus the bounded f32
            // transport rounding at this fixture's <=108px coordinates.
            assert!((curve(t) - point).length() <= 1. / 8192. + 0.00002);
        }
    }
    assert!(data.chunks_exact(16).any(|s| s[1] == 1.));
    assert!(data.chunks_exact(16).any(|s| s[1] == -1.));
}
#[test]
fn open_paths_do_not_acquire_fill_and_arc_segments_have_monotone_bands() {
    let p = Path {
        commands: vec![
            Command::Move(Point::new(0., 0.)),
            Command::Line(Point::new(50., 100.)),
        ],
    };
    assert!(
        analytic::segments(&p, Transform::default(), Rect::new(0, 0, 100, 100))
            .unwrap()
            .is_empty()
    );
    let p = Path::ellipse(100., 60.);
    let data = analytic::segments(&p, Transform::default(), Rect::new(0, 0, 100, 60)).unwrap();
    assert!(!data.is_empty());
    for segment in data.chunks_exact(16) {
        assert_eq!(segment[0], 0.);
        assert!(segment[14] < segment[15]);
    }
}
#[test]
fn gpu_uses_shared_edge_programs_without_cpu_bitmap_upload() {
    let mut e = Engine::new();
    e.load_document(&doc()).unwrap();
    let s = e.compile_gpu(&options()).unwrap();
    assert!(s.vertices.is_empty());
    assert!(!s.curves.is_empty());
    let p = &s.nodes["r"].fill;
    assert!(p.area.is_some());
    assert!(p.analytic_rect.is_none());
    assert_eq!(p.sample_count, Some(4));
    assert_eq!(s.resolve.unwrap().scale, 0.5);
    assert!(s.integrated_blur);
}

#[test]
fn integrated_blur_has_no_seam_at_a_cpu_sampling_tile_boundary() {
    let document = json!({"schemaVersion":1,"id":"seam","name":"seam","pages":[{"id":"p","name":"p","children":["r"],"background":"#ffffff"}],"nodes":{"r":{"id":"r","kind":"rectangle","transform":[1,0,0,1,500.25,8.5],"width":30.5,"height":20,"fills":[{"kind":"solid","color":"#4477dd"}],"effects":[{"kind":"blur","radius":3.25,"visible":true,"color":"#000000"}]}}});
    let mut engine = Engine::new();
    engine.load_document(&document.to_string()).unwrap();
    let mut tiled = options();
    tiled.width = 600;
    tiled.height = 40;
    let actual = engine.render(&tiled).unwrap();
    let mut full = futureox_design_kernel::fidelity::source(&tiled, 0, 0, 600, 40).unwrap();
    full.raster_profile = RasterProfile::FigmaSubpixel;
    let reference =
        futureox_design_kernel::fidelity::downsample(&engine.render(&full).unwrap(), 600, 40);
    assert!(
        actual == reference,
        "blur differs when crossing the 512-pixel tile seam"
    );
}
