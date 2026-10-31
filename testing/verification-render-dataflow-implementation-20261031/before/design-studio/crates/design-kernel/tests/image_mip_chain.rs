use base64::Engine as _;
use futureox_design_kernel::math::{Rect, Transform};
use futureox_design_kernel::paint::{
    Images, image_byte_sampling_grid, image_byte_sampling_grid_at_level, image_mip_level,
    image_sampling_grid, image_sampling_grid_at_level,
};
use futureox_design_kernel::scene::Paint;
use serde_json::json;
use std::sync::Arc;

fn gradient_png(w: u32, h: u32) -> String {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut data = Vec::new();
        for y in 0..h {
            for x in 0..w {
                data.extend([
                    (x * 255 / w.max(1)) as u8,
                    (y * 255 / h.max(1)) as u8,
                    64,
                    255,
                ]);
            }
        }
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&data)
            .unwrap();
    }
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn paint(kind: &str) -> Paint {
    serde_json::from_value(json!({"kind":"image","color":"#000000","fit":kind})).unwrap()
}

fn identity() -> Transform {
    Transform([1., 0., 0., 1., 0., 0.])
}

#[test]
fn image_at_generates_a_lazy_deterministic_chain() {
    let uri = gradient_png(8, 8);
    let mut images = Images::default();
    images.set_mip_enabled(true);
    let base = images.image(&uri).unwrap();
    assert_eq!([base.rect.w, base.rect.h], [8, 8]);
    assert_eq!(images.resident_pixels(), 64);
    let level1 = images.image_at(&uri, 1).unwrap();
    assert_eq!([level1.rect.w, level1.rect.h], [4, 4]);
    let level3 = images.image_at(&uri, 3).unwrap();
    assert_eq!([level3.rect.w, level3.rect.h], [1, 1]);
    // 64 + 16 + 4 + 1 charged once, and repeated requests reuse the surfaces.
    assert_eq!(images.resident_pixels(), 85);
    assert!(Arc::ptr_eq(&level1, &images.image_at(&uri, 1).unwrap()));
    assert!(Arc::ptr_eq(&base, &images.image_at(&uri, 0).unwrap()));
    // Requests beyond the chain clamp to the last level.
    assert!(Arc::ptr_eq(&level3, &images.image_at(&uri, 9).unwrap()));
    assert_eq!(images.resident_pixels(), 85);
}

#[test]
fn image_at_requires_the_mip_switch() {
    let uri = gradient_png(4, 4);
    let mut images = Images::default();
    images.image(&uri).unwrap();
    assert!(images.image_at(&uri, 1).is_err());
    images.set_mip_enabled(true);
    assert!(images.image_at(&uri, 1).is_ok());
}

#[test]
fn retain_document_keeps_materialized_levels_in_the_budget() {
    let uri = gradient_png(8, 8);
    let doc: futureox_design_kernel::scene::Document = serde_json::from_value(json!({
        "schemaVersion":4,"id":"d","name":"m","pages":[{"id":"p","name":"p","children":["a"],"background":"#ffffff"}],
        "nodes":{"a":{"id":"a","kind":"rectangle","width":8,"height":8,
            "fills":[{"kind":"image","color":"#000000","image":uri}]}}
    }))
    .unwrap();
    let mut images = Images::default();
    images.retain_document(&doc);
    images.set_mip_enabled(true);
    images.image_at(&uri, 2).unwrap();
    assert_eq!(images.resident_pixels(), 84);
    images.retain_document(&doc);
    assert_eq!(
        images.resident_pixels(),
        84,
        "retain must recount base plus chain instead of dropping to the base"
    );
}

#[test]
fn image_mip_level_follows_minification_thresholds() {
    // stretch maps image texels linearly onto node units.
    let p = paint("stretch");
    let cases = [
        (8u32, 8u32, 0u32), // 1 texel per px
        (4, 4, 1),          // 2 texels per px
        (2, 4, 2),          // anisotropic picks the max axis stride (4)
        (3, 3, 1),          // ratio 8/3 -> floor(log2 2.67) = 1
        (2, 2, 2),          // 4 texels per px
        (16, 16, 0),        // magnification never selects a coarser level
        (1, 1, 3),          // extreme minification clamps only at the caller
    ];
    for (w, h, expected) in cases {
        let level = image_mip_level(
            Rect::new(0, 0, w, h),
            identity(),
            [f64::from(w), f64::from(h)],
            [8, 8],
            &p,
        )
        .unwrap();
        assert_eq!(level, expected, "node {w}x{h}");
    }
}

#[test]
fn cover_fit_selects_levels_from_the_painted_ratio() {
    let p = paint("cover");
    // cover maps the node with the max axis ratio: 8/6 on x -> stride 8/6 < 2.
    let level = image_mip_level(Rect::new(0, 0, 6, 6), identity(), [6., 6.], [8, 8], &p).unwrap();
    assert_eq!(level, 0);
    let level = image_mip_level(Rect::new(0, 0, 3, 3), identity(), [3., 3.], [8, 8], &p).unwrap();
    assert_eq!(level, 1);
}

#[test]
fn level_zero_grids_stay_bit_identical_to_the_historical_entry_points() {
    let uri = gradient_png(8, 8);
    let p: Paint = serde_json::from_value(json!({
        "kind":"image","color":"#000000","image":uri,"fit":"cover"
    }))
    .unwrap();
    for rect in [Rect::new(0, 0, 5, 5), Rect::new(-3, 2, 7, 4)] {
        let historical = image_sampling_grid(rect, identity(), [8., 8.], [8, 8], &p, Some(1))
            .unwrap()
            .iter()
            .map(|v| v.to_bits())
            .collect::<Vec<_>>();
        let at_level =
            image_sampling_grid_at_level(rect, identity(), [8., 8.], [8, 8], &p, Some(1), 0)
                .unwrap()
                .iter()
                .map(|v| v.to_bits())
                .collect::<Vec<_>>();
        assert_eq!(historical, at_level);
    }
}

#[test]
fn grid_at_level_matches_coordinates_compiled_for_level_dimensions() {
    let p = paint("cover");
    let at_level = image_byte_sampling_grid_at_level(
        Rect::new(0, 0, 6, 6),
        identity(),
        [6., 6.],
        [8, 8],
        &p,
        None,
        1,
    )
    .unwrap();
    let explicit = image_byte_sampling_grid(
        Rect::new(0, 0, 6, 6),
        identity(),
        [6., 6.],
        [4, 4],
        &p,
        None,
    )
    .unwrap();
    assert_eq!(at_level, explicit);
}

#[test]
fn placed_grids_shift_valid_indices_and_keep_markers() {
    use futureox_design_kernel::paint::image_byte_sampling_grid_placed;
    use futureox_design_kernel::paint::image_sampling_grid_placed;
    let uri = gradient_png(8, 4);
    let p: Paint = serde_json::from_value(json!({
        "kind":"image","color":"#000000","image":uri,"fit":"cover"
    }))
    .unwrap();
    let origin = [37i32, 11];
    // Dense byte grids: valid entries shift, invalid markers stay zero.
    let base = image_byte_sampling_grid(
        Rect::new(0, 0, 5, 5),
        identity(),
        [5., 5.],
        [8, 4],
        &p,
        Some(0),
    )
    .unwrap();
    let placed = image_byte_sampling_grid_placed(
        Rect::new(0, 0, 5, 5),
        identity(),
        [5., 5.],
        [8, 4],
        &p,
        Some(0),
        0,
        origin,
    )
    .unwrap();
    for (b, s) in base.chunks_exact(4).zip(placed.chunks_exact(4)) {
        if b[2] == 1. {
            assert_eq!(s[0], b[0] + origin[0] as f32);
            assert_eq!(s[1], b[1] + origin[1] as f32);
            assert_eq!((s[2], s[3]), (1., 0.));
        } else {
            assert_eq!(s, [0., 0., 0., 0.]);
        }
    }
    // Linear cell grids shift identically; zero origin reproduces the level form.
    assert_eq!(
        image_sampling_grid_placed(
            Rect::new(0, 0, 5, 5),
            identity(),
            [5., 5.],
            [8, 4],
            &p,
            Some(1),
            0,
            [0, 0]
        )
        .unwrap(),
        image_sampling_grid(
            Rect::new(0, 0, 5, 5),
            identity(),
            [5., 5.],
            [8, 4],
            &p,
            Some(1)
        )
        .unwrap()
    );
    let base_linear = image_sampling_grid(
        Rect::new(0, 0, 5, 5),
        identity(),
        [5., 5.],
        [8, 4],
        &p,
        Some(1),
    )
    .unwrap();
    let placed_linear = image_sampling_grid_placed(
        Rect::new(0, 0, 5, 5),
        identity(),
        [5., 5.],
        [8, 4],
        &p,
        Some(1),
        0,
        origin,
    )
    .unwrap();
    assert_eq!(base_linear.len(), placed_linear.len());
    for (b, s) in base_linear
        .chunks_exact(4)
        .zip(placed_linear.chunks_exact(4))
    {
        if b[2] != -2. {
            assert_eq!(s[0], b[0] + origin[0] as f32);
            assert_eq!(s[1], b[1] + origin[1] as f32);
        } else {
            assert_eq!(s, b);
        }
    }
}

#[test]
fn sampler_renders_minified_images_from_selected_levels() {
    use futureox_design_kernel::{Engine, RenderOptions};
    let uri = gradient_png(8, 8);
    let doc = json!({
        "schemaVersion":4,"id":"d","name":"m",
        "pages":[{"id":"p","name":"p","children":["a"],"background":"#ffffff"}],
        "nodes":{"a":{"id":"a","kind":"rectangle","width":2,"height":2,
            "fills":[{"kind":"image","color":"#000000","image":uri,"fit":"stretch"}]}}
    });
    let options: RenderOptions = serde_json::from_value(json!({
        "pageId":"p","width":2,"height":2,"transparent":true,
        "view":{"x":0,"y":0,"zoom":1}
    }))
    .unwrap();
    let render = |mips: bool| {
        let mut engine = Engine::new();
        engine.load_document(&doc.to_string()).unwrap();
        engine.set_image_mips(mips);
        engine.render(&options).unwrap()
    };
    let disabled = render(false);
    let enabled = render(true);
    // A 2x2 render of an 8x8 stretch fill integrates 4x4 texel boxes on level
    // 2, so the enabled output must differ from the single-tap baseline and
    // stay deterministic across engines.
    assert_ne!(disabled, enabled);
    assert_eq!(enabled, render(true));
}
