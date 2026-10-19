use super::*;
use serde_json::json;

#[test]
fn sdr_glass_materializes_refraction_and_light_before_integer_source_over() {
    let mut backdrop = Surface::new(Rect::new(0, 0, 5, 5)).unwrap();
    backdrop.pixels.fill(Pixel::rgba(0.2, 0.4, 0.6, 0.5));
    let mut mask = Surface::new(backdrop.rect).unwrap();
    for y in 0..5 {
        for x in 1..4 {
            mask.pixels[y * 5 + x] = Pixel([1.; 4]);
        }
    }
    // At (1,2): distance=1, gradient=(2,0), factor=3/4, highlight=3/16.
    // Refraction materializes [26,51,76,128], light is white alpha=48.
    // Integer source-over is round((dst*207 + 48*255)/255).
    let actual = effects::glass_unmasked(
        &backdrop,
        &mask,
        crate::material::GlassMaterial {
            scale: 1.,
            depth: 4.,
            refraction: 0.,
            light: 1.,
            dispersion: 0.,
            direction: [0., 0.],
            modern: false,
        },
        true,
    )
    .unwrap();
    assert_eq!(
        actual
            .at(1, 2)
            .0
            .map(|v| (v * 255.).round_ties_even() as u8),
        [69, 89, 110, 152]
    );
}

#[test]
fn sdr_image_interpolation_keeps_half_bytes_in_byte_space_until_opacity() {
    let mut image = Surface::new(Rect::new(0, 0, 1, 2)).unwrap();
    image.pixels[0] = Pixel([1., 0., 0., 1.]);
    image.pixels[1] = Pixel([0., 0., 80. / 255., 80. / 255.]);
    // Blue = 80 * 0.075 * 0.75 = 4.5, ties-to-even -> 4.
    assert_eq!(
        image
            .sample_rgba8_index(0., 0.075, 0.75)
            .0
            .map(|v| (v * 255.).round_ties_even() as u8),
        [177, 0, 4, 181]
    );
}

#[test]
fn byte_multiply_and_screen_match_independent_straight_color_equations() {
    for da in [1_u32, 17, 63, 128, 191, 254, 255] {
        for sa in [1_u32, 17, 63, 128, 191, 254, 255] {
            for db in [0, da / 3, da / 2, da] {
                for sb in [0, sa / 3, sa / 2, sa] {
                    for opacity in [0_f32, 0.125, 0.5, 0.75, 1.] {
                        for mode in ["normal", "multiply", "screen"] {
                            let dst = Pixel([db as f32 / 255.; 4]);
                            let dst = Pixel([dst.0[0], dst.0[0], dst.0[0], da as f32 / 255.]);
                            let src = Pixel([
                                sb as f32 / 255.,
                                sb as f32 / 255.,
                                sb as f32 / 255.,
                                sa as f32 / 255.,
                            ]);
                            let weight = f64::from((opacity * 65535.).round_ties_even()) / 65535.;
                            let a = f64::from(sa) / 255. * weight;
                            let b = f64::from(da) / 255.;
                            let cs = f64::from(sb) / f64::from(sa);
                            let cb = f64::from(db) / f64::from(da);
                            let mixed = match mode {
                                "multiply" => cs * cb,
                                "screen" => cb + cs - cb * cs,
                                _ => cs,
                            };
                            let channel = (1. - a) * b * cb + (1. - b) * a * cs + a * b * mixed;
                            let alpha = a + b * (1. - a);
                            let actual = dst
                                .over_rgba8_blend(src, opacity, mode)
                                .0
                                .map(|v| (v * 255.).round_ties_even() as u32);
                            assert_eq!(
                                actual,
                                [
                                    (channel * 255.).round() as u32,
                                    (channel * 255.).round() as u32,
                                    (channel * 255.).round() as u32,
                                    (alpha * 255.).round() as u32
                                ]
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn subpixel_tiles_preserve_a_single_sampling_grid_across_the_seam() {
    let mut engine = Engine::new();
    engine.load_document(&json!({"schemaVersion":4,"id":"d","name":"Subpixel seam",
        "pages":[{"id":"p","name":"p","children":["bg","a"],"background":"#ffffff"}],
        "nodes":{
            "bg":{"id":"bg","kind":"rectangle","width":1030,"height":48,"fills":[{"kind":"linear","color":"#000000","angle":17,"stops":[{"offset":0,"color":"#b56b90"},{"offset":1,"color":"#426c9b"}]}]},
            "a":{"id":"a","kind":"ellipse","width":53.25,"height":31.5,"transform":[1,0.125,0.25,1,490.375,6.125],"opacity":0.5,"blend":"screen","fills":[{"kind":"solid","color":"#75a1dd"}],"effects":[{"kind":"blur","radius":2.25,"color":"#000000"}]}
        }}).to_string()).unwrap();
    let opts: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":1025,"height":40,"rasterProfile":"figmaSubpixel","transparent":true,"view":{"x":0.125,"y":0.375,"zoom":1}})).unwrap();
    let actual = engine.render(&opts).unwrap();
    let viewport = Rect::new(0, 0, 1025, 40);
    let surfaces = engine.render_surfaces_at(&opts, true, viewport, 0).unwrap();
    let planes: Vec<_> = surfaces.iter().map(|s| s.rgba8(viewport)).collect();
    let expected =
        crate::fidelity::resolve_sample_planes([&planes[0], &planes[1], &planes[2], &planes[3]]);
    assert_eq!(actual, expected);
}

#[test]
fn buffer_ownership_counts_bytes_once_and_rejects_copies_before_allocation() {
    let budget = Budget::new(64);
    let surface = Arc::new(Surface::new_in(Rect::new(0, 0, 2, 1), &budget).unwrap());
    let shared = surface.clone();
    assert_eq!(budget.usage().live_bytes, 32);
    let copied = surface.try_clone().unwrap();
    assert_eq!(budget.usage().live_bytes, 64);
    assert!(surface.try_clone().is_err());
    assert_eq!(budget.usage().live_bytes, 64);
    assert_eq!(budget.usage().allocated_surface_pixels, 4);
    drop(copied);
    drop(surface);
    assert_eq!(budget.usage().live_bytes, 32);
    drop(shared);
    assert_eq!(budget.usage().live_bytes, 0);
}

#[test]
fn mixed_buffer_units_and_overflow_cannot_bypass_the_budget() {
    let budget = Budget::new(68);
    let pixels = Surface::new_in(Rect::new(0, 0, 2, 2), &budget).unwrap();
    let mask = pixels.reserve_scratch::<f32>(1).unwrap();
    assert_eq!(budget.usage().live_bytes, 68);
    assert!(pixels.reserve_scratch::<f32>(1).is_err());
    assert!(pixels.reserve_scratch::<Pixel>(usize::MAX).is_err());
    assert_eq!(budget.usage().live_bytes, 68);
    drop(mask);
    drop(pixels);
    assert_eq!(budget.usage().live_bytes, 0);
    assert_eq!(budget.usage().peak_bytes, 68);
}

#[test]
fn blur_and_morphology_reject_scratch_exhaustion_without_leaking_reservations() {
    for filter in [
        effects::BlurFilter::Gaussian(2.),
        effects::BlurFilter::IntegratedTent(2.),
        effects::BlurFilter::PortableTent(2.25),
        effects::BlurFilter::LinearTent(2.),
    ] {
        let budget = Budget::new(512);
        let source = Surface::new_in(Rect::new(0, 0, 4, 4), &budget).unwrap();
        assert!(filter.apply(&source).is_err());
        assert_eq!(budget.usage().live_bytes, 256);
        assert!(effects::morphology_alpha(&source, 2, true).is_err());
        assert_eq!(budget.usage().live_bytes, 256);
        drop(source);
        assert_eq!(budget.usage().live_bytes, 0);
    }
    // Two pixel copies fit; the prefix-moment scanline buffers do not.
    let budget = Budget::new(3 * 256);
    let source = Surface::new_in(Rect::new(0, 0, 4, 4), &budget).unwrap();
    assert!(effects::linear_tent_blur(&source, 2., false).is_err());
    assert_eq!(budget.usage().live_bytes, 256);
}

#[test]
fn glass_distance_fields_and_result_copy_share_the_same_budget() {
    let budget = Budget::new(768);
    let backdrop = Surface::new_in(Rect::new(0, 0, 4, 4), &budget).unwrap();
    let mask = backdrop.try_clone().unwrap();
    assert!(
        effects::glass_unmasked(
            &backdrop,
            &mask,
            crate::material::GlassMaterial {
                scale: 1.,
                depth: 4.,
                refraction: 1.,
                light: 1.,
                dispersion: 0.,
                direction: [0., 0.],
                modern: false
            },
            false
        )
        .is_err()
    );
    assert_eq!(budget.usage().peak_bytes, 768);
    assert_eq!(budget.usage().live_bytes, 512);
    drop(mask);
    drop(backdrop);
    assert_eq!(budget.usage().live_bytes, 0);
}

#[test]
fn render_failure_releases_all_planes_masks_and_effects_and_next_frame_is_unchanged() {
    let mut engine = Engine::new();
    engine.load_document(&json!({
        "schemaVersion":4,"id":"d","name":"Memory",
        "pages":[{"id":"p","name":"p","children":["g"],"background":"#ffffff"}],
        "nodes":{
            "g":{"id":"g","kind":"frame","width":24,"height":20,"clip":true,"opacity":0.8,"children":["m","a"]},
            "m":{"id":"m","kind":"ellipse","width":22,"height":18,"mask":true,"fills":[{"kind":"solid","color":"#ffffff","opacity":0.6}]},
            "a":{"id":"a","kind":"rectangle","width":20,"height":16,"fills":[{"kind":"solid","color":"#c070e0"}],"effects":[{"kind":"blur","radius":1.25,"color":"#000000","x":0,"y":0},{"kind":"shadow","radius":1,"x":1,"y":1,"color":"#000000"}]}
        }
    }).to_string()).unwrap();
    for synchronized in [false, true] {
        let options: RenderOptions = serde_json::from_value(json!({
            "pageId":"p","width":24,"height":20,"transparent":true,
            "view":{"x":0,"y":0,"zoom":1},"rasterProfile":if synchronized {"figmaSubpixel"} else {"analytic"}
        })).unwrap();
        let viewport = Rect::new(0, 0, 24, 20);
        let generous = Budget::new(COMPOSITING_BYTES);
        let reference = engine
            .render_surfaces_with_budget(&options, synchronized, viewport, 0, generous.clone())
            .unwrap();
        let pixels: Vec<_> = reference.iter().map(|s| s.rgba8(viewport)).collect();
        let peak = generous.usage().peak_bytes;
        drop(reference);
        assert_eq!(generous.usage().live_bytes, 0);
        // Probe failures at different depths, including effect scratch, without
        // allocating hundreds of MB to exercise the production limit.
        for limit in [1, peak / 4, peak / 2, peak - 1] {
            let constrained = Budget::new(limit);
            assert!(
                engine
                    .render_surfaces_with_budget(
                        &options,
                        synchronized,
                        viewport,
                        0,
                        constrained.clone()
                    )
                    .is_err()
            );
            assert_eq!(constrained.usage().live_bytes, 0);
            assert!(constrained.usage().peak_bytes <= limit);
        }
        let repeated = engine
            .render_surfaces_with_budget(&options, synchronized, viewport, 0, generous.clone())
            .unwrap();
        assert_eq!(
            repeated
                .iter()
                .map(|s| s.rgba8(viewport))
                .collect::<Vec<_>>(),
            pixels
        );
        assert_eq!(engine.stats().peak_compositing_bytes, peak);
        drop(repeated);
        assert_eq!(generous.usage().live_bytes, 0);
    }
}
