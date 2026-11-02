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

#[test]
fn bounded_backdrop_matches_full_domain_bits() {
    let mut engine = Engine::new();
    for (glass, fallback) in [(false,false), (true,false), (true,true)] {
        for nested in [0, 1, 2] {
        for rotation in [0_f64, 0.23] {
            let (sin, cos) = rotation.sin_cos();
            let effect = if glass { json!({"kind":"glass","radius":3.7,"color":"#ffffff","glass":{"depth":8,"bevelSize":2,"refraction":0.7,"dispersion":0.8,"lightAngle":37,"lightIntensity":0.6}}) }
                else { json!({"kind":"background-blur","radius":3.7,"color":"#ffffff"}) };
            let mut document = json!({"schemaVersion":5,"id":"d","name":"regions",
                "pages":[{"id":"p","name":"p","children":["a","b","c"],"background":"#234567"}],
                "nodes":{
                    "a":{"id":"a","kind":"rectangle","transform":[1,0,0,1,-15.3,-7.7],"width":39,"height":58,"fills":[{"kind":"solid","color":"#8765ab","opacity":0.5}]},
                    "b":{"id":"b","kind":"rectangle","transform":[cos,sin,-sin,cos,3.25,5.75],"width":49,"height":37,"opacity":0.7,"fills":[{"kind":"solid","color":"#b34789","opacity":0.125}],"effects":[effect.clone()]},
                    "c":{"id":"c","kind":if fallback {"ellipse"} else {"rectangle"},"radii":[3,3,3,3],"transform":[1,0,0,1,19.5,13.25],"width":43,"height":31,"effects":[effect]}
                }});
            if nested > 0 {
                document["pages"][0]["children"] = json!(["g"]);
                document["nodes"]["g"] = json!({"id":"g","kind":"frame","width":60,"height":44,"transform":[1,0,0,1,-2.25,1.75],"clip":true,"opacity":0.8,"blend":if nested == 1 {"pass-through"} else {"normal"},"children":["a","b","c"],"fills":[{"kind":"solid","color":"#13579b","opacity":0.25}]});
            }
            engine.load_document(&document.to_string()).unwrap();
            let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":64,"height":48,"transparent":true,"rasterProfile":"analytic","view":{"zoom":1.3,"x":-3.25,"y":-7.75}})).unwrap();
            let viewport = Rect::new(0,0,64,48);
            let full_budget = Budget::new(COMPOSITING_BYTES);
            let roi_budget = Budget::new(COMPOSITING_BYTES);
            let reference = engine.render_surfaces_regions(&options,false,viewport,0,full_budget.clone(),false).unwrap();
            let actual = engine.render_surfaces_regions(&options,false,viewport,0,roi_budget.clone(),true).unwrap();
            if !fallback {
                assert!(roi_budget.usage().allocated_surface_pixels < full_budget.usage().allocated_surface_pixels,
                    "ROI branch must reduce surface work: glass={glass} nested={nested} rotation={rotation} full={} roi={}",full_budget.usage().allocated_surface_pixels,roi_budget.usage().allocated_surface_pixels);
            }
            save_bounded_oracle_fixture(&format!("glass-{glass}-fallback-{fallback}-nested-{nested}-rotation-{rotation}"), &document, &options, &actual[0].rgba8(viewport));
            for y in 0..48 { for x in 0..64 {
                assert_eq!(actual[0].at(x,y).0.map(f32::to_bits),reference[0].at(x,y).0.map(f32::to_bits),"glass={glass} fallback={fallback} nested={nested} rotation={rotation} ({x},{y})");
            }}
        }
        }
    }
}

#[test]
#[ignore = "large high-zoom glass memory regression; run explicitly"]
fn bounded_glass_3200_percent_admission_and_crop() {
    let mut engine = Engine::new();
    engine.load_document(&json!({"schemaVersion":5,"id":"d","name":"Glass budget",
        "pages":[{"id":"p","name":"p","children":["a"],"background":"#ffffff"}],
        "nodes":{"a":{"id":"a","kind":"rectangle","transform":[1,0,0,1,70,80],"width":700,"height":570,
            "fills":[{"kind":"solid","color":"#8073dd","opacity":0.2}],
            "effects":[{"kind":"glass","radius":12,"color":"#172033","opacity":0.5,"amount":14,"glass":{"depth":8,"refraction":0.5,"dispersion":0.3,"lightAngle":45,"lightIntensity":0.5}}]}}
    }).to_string()).unwrap();
    for (cx,cy) in [(150,140),(70,100),(70,80)] {
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":640,"height":480,"transparent":false,"rasterProfile":"analytic","view":{"zoom":32,"x":320-cx*32,"y":240-cy*32}})).unwrap();
    let viewport = Rect::new(0,0,640,480);
    let before = Budget::new(COMPOSITING_BYTES);
    let error = engine.render_surfaces_regions(&options,false,viewport,0,before.clone(),false).err().unwrap();
    assert_eq!(error,"Compositing memory budget exceeded");
    assert_eq!(before.usage().live_bytes,0);
    let after = Budget::new(COMPOSITING_BYTES);
    let actual = engine.render_surfaces_regions(&options,false,viewport,0,after.clone(),true).unwrap();
    assert_eq!(after.usage().rejections,0);
    eprintln!("glass32x center=({cx},{cy}) peak={} old-request={} old-live={}",after.usage().peak_bytes,before.usage().last_rejection_requested_bytes,before.usage().last_rejection_live_bytes);
    let crop = Rect::new(211,151,31,29);
    let cropped = engine.render_surfaces_regions(&options,false,crop,0,Budget::new(COMPOSITING_BYTES),true).unwrap();
    for y in crop.y..crop.bottom() { for x in crop.x..crop.right() {
        assert_eq!(actual[0].at(x,y).0.map(f32::to_bits),cropped[0].at(x,y).0.map(f32::to_bits));
    }}
    drop(actual);
    assert_eq!(after.usage().live_bytes,0);
    }
}

#[test]
fn bounded_planner_uses_boolean_render_children_and_skips_hidden_nodes() {
    let mut engine = Engine::new();
    engine.load_document(&json!({"schemaVersion":5,"id":"d","name":"Boolean regional admission",
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":["boolean","hidden","zero"]}],
        "nodes":{
            "boolean":{"id":"boolean","kind":"vector","width":48,"height":40,"booleanOperation":"union","children":["operand-a","operand-b"],"fills":[{"kind":"solid","color":"#8064d2"}]},
            "operand-a":{"id":"operand-a","kind":"rectangle","width":32,"height":32},
            "operand-b":{"id":"operand-b","kind":"rectangle","width":24,"height":24,"transform":[1,0,0,1,16,16]},
            "hidden":{"id":"hidden","kind":"rectangle","width":80,"height":80,"visible":false,"effects":[{"kind":"background-blur","radius":12,"color":"#ffffff"}]},
            "zero":{"id":"zero","kind":"rectangle","width":80,"height":80,"opacity":0,"effects":[{"kind":"background-blur","radius":12,"color":"#ffffff"}]}
        }}).to_string()).unwrap();
    assert!(!engine.doc.as_ref().unwrap().nodes["boolean"].children.is_empty());
    assert!(engine.doc.as_ref().unwrap().nodes["boolean"].render_children().is_empty());
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":48,"height":40,"rasterProfile":"analytic","view":{"zoom":1,"x":0,"y":0}})).unwrap();
    let viewport = Rect::new(0,0,48,40);
    let full = engine.render_surfaces_regions(&options,false,viewport,0,Budget::new(COMPOSITING_BYTES),false).unwrap();
    let roi = engine.render_surfaces_regions(&options,false,viewport,0,Budget::new(COMPOSITING_BYTES),true).unwrap();
    assert_eq!(full[0].rgba8(viewport),roi[0].rgba8(viewport));
}

#[test]
fn bounded_glass_preserves_image_mip_and_gradient_coordinate_domains() {
    use base64::Engine as _;
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png,64,64);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        let pixels: Vec<u8> = (0..64*64).flat_map(|i| [(i*37%256) as u8,(i*71%256) as u8,(i*13%256) as u8,((i*19%192)+63) as u8]).collect();
        writer.write_image_data(&pixels).unwrap();
    }
    let uri = format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(png));
    for kind in ["image","linear"] {
        let mut engine = Engine::new();
        let paint = if kind == "image" {json!({"kind":"image","color":"#ffffff","image":uri})}
            else {json!({"kind":"linear","color":"#ffffff","angle":37,"stops":[{"offset":0,"color":"#7132ef"},{"offset":1,"color":"#13dc95"}]})};
        engine.load_document(&json!({"schemaVersion":5,"id":"d","name":"Paint basis",
            "pages":[{"id":"p","name":"p","children":["background","lens"],"background":"#ffffff"}],
            "nodes":{
                "background":{"id":"background","kind":"rectangle","width":91,"height":71,"transform":[0.97,0.13,-0.13,0.97,-19.25,-13.75],"fills":[paint]},
                "lens":{"id":"lens","kind":"rectangle","width":52,"height":39,"radii":[3,3,3,3],"transform":[1,0,0,1,-2.25,3.5],"effects":[{"kind":"glass","radius":4,"color":"#ffffff","glass":{"depth":7,"refraction":0.8,"dispersion":0.7,"lightAngle":37,"lightIntensity":0.3}}]}
            }}).to_string()).unwrap();
        let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":48,"height":40,"transparent":true,"rasterProfile":"analytic","view":{"zoom":0.51,"x":3.25,"y":-1.75}})).unwrap();
        let viewport = Rect::new(0,0,48,40);
        let full_budget = Budget::new(COMPOSITING_BYTES);
        let roi_budget = Budget::new(COMPOSITING_BYTES);
        let full = engine.render_surfaces_regions(&options,false,viewport,0,full_budget.clone(),false).unwrap();
        let roi = engine.render_surfaces_regions(&options,false,viewport,0,roi_budget.clone(),true).unwrap();
        assert!(roi_budget.usage().allocated_surface_pixels < full_budget.usage().allocated_surface_pixels);
        save_bounded_oracle_fixture(&format!("paint-{kind}"), &serde_json::to_value(engine.doc.as_ref().unwrap()).unwrap(), &options, &roi[0].rgba8(viewport));
        for y in 0..40 { for x in 0..48 {
            assert_eq!(full[0].at(x,y).0.map(f32::to_bits),roi[0].at(x,y).0.map(f32::to_bits),"{kind} ({x},{y})");
        }}
    }
}

fn save_bounded_oracle_fixture(name: &str, document: &serde_json::Value, options: &RenderOptions, rgba: &[u8]) {
    let Some(directory) = std::env::var_os("DESIGN_ROI_ORACLE_DIR") else { return; };
    let directory = std::path::PathBuf::from(directory);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join(format!("{name}.json")), serde_json::to_vec(&json!({"document":document,"options":options})).unwrap()).unwrap();
    std::fs::write(directory.join(format!("{name}.rgba")), rgba).unwrap();
}

#[test]
fn bounded_single_backdrop_tiles_match_direct_at_clipped_edges() {
    for nested in [false,true] {
        let mut engine = Engine::new();
        let mut document = json!({"schemaVersion":5,"id":"d","name":"Single consumer tile certificate",
            "pages":[{"id":"p","name":"p","background":"#334455","children":["background","lens"]}],
            "nodes":{
                "background":{"id":"background","kind":"rectangle","width":73,"height":67,"transform":[1,0,0,1,-9.25,-7.5],"fills":[{"kind":"solid","color":"#ce6589","opacity":0.6}]},
                "lens":{"id":"lens","kind":"rectangle","width":47,"height":39,"radii":[4,4,4,4],"transform":[0.98,0.13,-0.13,0.98,1.25,2.75],"effects":[{"kind":"glass","radius":3.7,"color":"#ffffff","glass":{"depth":8,"refraction":0.7,"dispersion":0.8,"lightAngle":37,"lightIntensity":0.6}}]}
            }});
        if nested {
            document["pages"][0]["children"] = json!(["parent"]);
            document["nodes"]["parent"] = json!({"id":"parent","kind":"frame","width":39,"height":33,"transform":[1,0,0,1,-2.25,1.75],"clip":true,"opacity":0.7,"blend":"pass-through","children":["background","lens"]});
        }
        engine.load_document(&document.to_string()).unwrap();
        let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":64,"height":48,"transparent":true,"rasterProfile":"analytic","view":{"zoom":2,"x":-19,"y":-11}})).unwrap();
        assert_eq!(crate::export::backdrop_padding(&engine,&options,Rect::new(0,0,64,48)).unwrap(),0);
        let direct = engine.render(&options).unwrap();
        let frame = engine.render_tiled_frame(&options,None).unwrap();
        assert_eq!(direct,frame.rgba,"nested={nested}");
    }
}

#[test]
#[ignore = "large high-zoom real tiled regression; run explicitly"]
fn bounded_glass_3200_percent_real_tiles_match_direct() {
    let mut engine = Engine::new();
    engine.load_document(&json!({"schemaVersion":5,"id":"d","name":"Glass budget",
        "pages":[{"id":"p","name":"p","children":["a"],"background":"#ffffff"}],
        "nodes":{"a":{"id":"a","kind":"rectangle","transform":[1,0,0,1,70,80],"width":700,"height":570,
            "fills":[{"kind":"solid","color":"#8073dd","opacity":0.2}],
            "effects":[{"kind":"glass","radius":12,"color":"#172033","opacity":0.5,"amount":14,"glass":{"depth":8,"refraction":0.5,"dispersion":0.3,"lightAngle":45,"lightIntensity":0.5}}]}}
    }).to_string()).unwrap();
    for (cx,cy) in [(70,80)] {
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":640,"height":480,"transparent":false,"rasterProfile":"analytic","view":{"zoom":32,"x":320-cx*32,"y":240-cy*32}})).unwrap();
    let viewport = Rect::new(0,0,640,480);
    assert_eq!(crate::export::backdrop_padding(&engine,&options,viewport).unwrap(),0);
    let direct = engine.render(&options).unwrap();
    let frame = engine.render_tiled_frame(&options,None).unwrap();
    assert_eq!(frame.rgba,direct);
    assert!(frame.visible_tiles > 1);
    let ledger = engine.compositing_ledger();
    assert_eq!(ledger.budget_rejections,0);
    assert!(ledger.scene_peak_bytes <= COMPOSITING_BYTES);
    eprintln!("glass32x actual tiled visible={} peak={} bytes={}",frame.visible_tiles,ledger.scene_peak_bytes,frame.rgba.len());
    }
}

#[test]
fn bounded_planner_skips_descendants_of_geometry_culled_frames() {
    let mut engine = Engine::new();
    engine.load_document(&json!({"schemaVersion":5,"id":"d","name":"Culled subtree",
        "pages":[{"id":"p","name":"p","background":"#234567","children":["root"]}],
        "nodes":{
            "root":{"id":"root","kind":"frame","width":64,"height":48,"clip":true,"children":["visible","offscreen"]},
            "visible":{"id":"visible","kind":"rectangle","width":32,"height":32,"fills":[{"kind":"solid","color":"#8064d2"}]},
            "offscreen":{"id":"offscreen","kind":"frame","width":24,"height":24,"clip":true,"transform":[1,0,0,1,1000,1000],"children":["unprepared"]},
            "unprepared":{"id":"unprepared","kind":"rectangle","width":24,"height":24,"fills":[{"kind":"solid","color":"#ff0000"}]}
        }}).to_string()).unwrap();
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":64,"height":48,"rasterProfile":"analytic","view":{"zoom":1,"x":0,"y":0}})).unwrap();
    let viewport = Rect::new(0,0,64,48);
    let full = engine.render_surfaces_regions(&options,false,viewport,0,Budget::new(COMPOSITING_BYTES),false).unwrap();
    let roi = engine.render_surfaces_regions(&options,false,viewport,0,Budget::new(COMPOSITING_BYTES),true).unwrap();
    assert_eq!(full[0].rgba8(viewport),roi[0].rgba8(viewport));
}

#[test]
fn extreme_zoom_halo_keeps_layer_content_instead_of_failing_the_frame() {
    let mut engine = Engine::new();
    // radius 80 at 32x is a 5120px device halo, past the 2048 combined limit.
    engine.load_document(&json!({"schemaVersion":5,"id":"d","name":"Halo degrade",
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":["a"]}],
        "nodes":{"a":{"id":"a","kind":"rectangle","transform":[1,0,0,1,0.25,0.25],"width":1,"height":1,
            "fills":[{"kind":"solid","color":"#cc2244"}],
            "effects":[{"kind":"blur","radius":80,"color":"#000000"}]}}
    }).to_string()).unwrap();
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":64,"height":48,"transparent":false,"rasterProfile":"analytic","view":{"zoom":32,"x":0,"y":0}})).unwrap();
    let exact = engine.render_surfaces_regions(&options, false, Rect::new(0, 0, 64, 48), 0, Budget::new(COMPOSITING_BYTES), true);
    assert_eq!(exact.err().as_deref(), Some("Combined filter dependency halo exceeds 2048 device pixels"));
    let bytes = engine.render(&options).expect("degraded display keeps the frame");
    assert_eq!(bytes.len(), 64 * 48 * 4);
    // World (0.25, 0.25) at 32x is device pixel 8. The fill must survive
    // even though the blur halo cannot be admitted.
    let pixel = |x: usize, y: usize| {
        let i = (y * 64 + x) * 4;
        [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]
    };
    let inside = pixel(16, 16);
    assert!(inside[0] > 140 && inside[1] < 80 && inside[2] < 120, "fill retained, got {inside:?}");
    let outside = pixel(1, 1);
    assert_eq!(outside, [255, 255, 255, 255]);
}

#[test]
fn device_rect_halo_keeps_the_fill_instead_of_failing_the_tile() {
    let mut engine = Engine::new();
    engine.load_document(&json!({"schemaVersion":5,"id":"d","name":"Tile halo",
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":["a"]}],
        "nodes":{"a":{"id":"a","kind":"rectangle","transform":[1,0,0,1,0.25,0.25],"width":1,"height":1,
            "fills":[{"kind":"solid","color":"#cc2244"}],
            "effects":[{"kind":"blur","radius":80,"color":"#000000"}]}}
    }).to_string()).unwrap();
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":64,"height":48,"transparent":false,"rasterProfile":"analytic","view":{"zoom":32,"x":0,"y":0}})).unwrap();
    let exact = engine.render_surfaces_regions(&options, false, Rect::new(0, 0, 64, 48), 0, Budget::new(COMPOSITING_BYTES), true);
    assert_eq!(exact.err().as_deref(), Some("Combined filter dependency halo exceeds 2048 device pixels"));
    let bytes = engine.render_device_rect(&options, 0, 0, 64, 48).expect("tile degrade keeps the fill");
    assert_eq!(bytes.len(), 64 * 48 * 4);
    let pixel = |x: usize, y: usize| {
        let i = (y * 64 + x) * 4;
        [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]
    };
    let inside = pixel(16, 16);
    assert!(inside[0] > 140 && inside[1] < 80 && inside[2] < 120, "fill retained, got {inside:?}");
    let outside = pixel(1, 1);
    assert_eq!(outside, [255, 255, 255, 255]);
}

#[test]
fn small_analytic_frame_matches_exact_surfaces() {
    let mut engine = Engine::new();
    engine.load_document(&json!({"schemaVersion":5,"id":"d","name":"Small",
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":["a"]}],
        "nodes":{"a":{"id":"a","kind":"rectangle","width":8,"height":8,
            "fills":[{"kind":"solid","color":"#2244cc"}]}}
    }).to_string()).unwrap();
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":16,"height":16,"transparent":false,"rasterProfile":"analytic","view":{"zoom":1,"x":0,"y":0}})).unwrap();
    let exact = engine.render_surfaces_regions(&options, false, Rect::new(0, 0, 16, 16), 0, Budget::new(COMPOSITING_BYTES), true).unwrap();
    let bytes = engine.render(&options).unwrap();
    assert_eq!(bytes, exact[0].rgba8(Rect::new(0, 0, 16, 16)));
}

#[test]
fn oversized_analytic_blur_keeps_fill_when_the_frame_cannot_fit() {
    let mut engine = Engine::new();
    // radius 800 at 1x is a 2402px gaussian outset. The exact frame reports
    // the halo/budget error. Degraded tiles keep the fill and the page color.
    engine.load_document(&json!({"schemaVersion":5,"id":"d","name":"Budget topology",
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":["a"]}],
        "nodes":{"a":{"id":"a","kind":"rectangle","transform":[1,0,0,1,40,40],"width":48,"height":48,
            "fills":[{"kind":"solid","color":"#cc2244"}],
            "effects":[{"kind":"blur","radius":800,"color":"#000000"}]}}
    }).to_string()).unwrap();
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":256,"height":256,"transparent":false,"rasterProfile":"analytic","view":{"zoom":1,"x":0,"y":0}})).unwrap();
    let exact = engine.render_surfaces_regions(&options, false, Rect::new(0, 0, 256, 256), 0, Budget::new(COMPOSITING_BYTES), true);
    let error = match exact {
        Err(error) => error,
        Ok(_) => panic!("full frame must not admit this blur stack"),
    };
    assert!(
        error == "Compositing memory budget exceeded"
            || error.contains("halo exceeds 2048")
            || error == "Layer surface exceeds 16 million pixels"
            || error == "Frame compositing work budget exceeded",
        "{error}"
    );
    let bytes = engine.render(&options).expect("degraded display keeps the frame");
    assert_eq!(bytes.len(), 256 * 256 * 4);
    let pixel = |x: usize, y: usize| {
        let i = (y * 256 + x) * 4;
        [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]
    };
    let inside = pixel(64, 64);
    assert!(inside[0] > 140 && inside[1] < 120 && inside[2] < 140, "fill retained, got {inside:?}");
    let outside = pixel(4, 4);
    assert_eq!(outside, [255, 255, 255, 255]);
}
