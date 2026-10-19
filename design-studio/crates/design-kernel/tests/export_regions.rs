use futureox_design_kernel::{
    Engine,
    export::{ExportBounds, RegionRequest, region_plan},
};
use serde_json::{Value, json};

fn request(x: f64, y: f64, width: f64, height: f64, scale: f64, profile: &str) -> RegionRequest {
    serde_json::from_value(
        json!({"pageId":"p", "bounds":{"x":x,"y":y,"width":width,"height":height},
        "scale":scale,"rasterProfile":profile}),
    )
    .unwrap()
}
fn document(mut nodes: Value, children: Value) -> Value {
    for node in nodes.as_object_mut().unwrap().values_mut() {
        let object = node.as_object_mut().unwrap();
        object.entry("width").or_insert(json!(24));
        object.entry("height").or_insert(json!(24));
        for list in ["fills", "effects"] {
            if let Some(items) = node.get_mut(list).and_then(Value::as_array_mut) {
                for item in items {
                    let object = item.as_object_mut().unwrap();
                    object.entry("color").or_insert(json!("#000000"));
                    if list == "fills" {
                        object.entry("kind").or_insert(json!("solid"));
                    }
                }
            }
        }
    }
    json!({"schemaVersion":3,"id":"export","name":"Export fixture", "pages":[{"id":"p","name":"Page","children":children,"background":"#ffffff"}],"nodes":nodes})
}
fn engine(doc: &Value) -> Engine {
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    engine
}
fn decoded(engine: &mut Engine, request: &RegionRequest) -> image::RgbaImage {
    image::load_from_memory(&engine.render_region_png(request).unwrap())
        .unwrap()
        .into_rgba8()
}
fn solid(width: f64, height: f64, x: f64, y: f64) -> Value {
    document(
        json!({"r":{"id":"r","kind":"rectangle","width":width,"height":height,
        "transform":[1,0,0,1,x,y],"fills":[{"kind":"solid","color":"#e03080"}]}}),
        json!(["r"]),
    )
}

#[test]
fn region_plan_preserves_fractional_origins_and_rounds_only_the_extent() {
    for scale in [1., 2., 3., 0.5, 1.25] {
        let b = ExportBounds {
            x: -12.375,
            y: 8.125,
            width: 24.25,
            height: 13.125,
        };
        let p = region_plan(b, scale).unwrap();
        assert_eq!(p.width, (b.width * scale).ceil() as u32);
        assert_eq!(p.height, (b.height * scale).ceil() as u32);
        assert_eq!(p.view.x, -b.x * scale);
        assert_eq!(p.view.y, -b.y * scale);
        assert_eq!(p.view.zoom, scale);
    }
    let p = region_plan(
        ExportBounds {
            x: -1.,
            y: 0.,
            width: 24.000000000000004,
            height: 1.,
        },
        1.,
    )
    .unwrap();
    assert_eq!(p.width, 24);
    assert_eq!(
        region_plan(
            ExportBounds {
                x: 0.,
                y: 0.,
                width: 24.000001,
                height: 1.
            },
            1.
        )
        .unwrap()
        .width,
        25
    );
}

#[test]
fn a_positive_subpixel_region_always_allocates_one_pixel() {
    let plan = region_plan(
        ExportBounds {
            x: -0.125,
            y: 0.25,
            width: 1e-14,
            height: 1e-14,
        },
        0.001,
    )
    .unwrap();
    assert_eq!((plan.width, plan.height), (1, 1));
}

#[test]
fn invalid_regions_fail_before_any_frame_allocation() {
    let b = ExportBounds {
        x: 0.,
        y: 0.,
        width: 24.,
        height: 24.,
    };
    for scale in [0., -1., f64::NAN, f64::INFINITY, 128.001, 0.0001] {
        assert!(region_plan(b, scale).is_err());
    }
    for bounds in [
        ExportBounds { width: 0., ..b },
        ExportBounds { height: -1., ..b },
        ExportBounds {
            x: f64::INFINITY,
            ..b
        },
        ExportBounds { x: 1e9 + 1., ..b },
        ExportBounds {
            width: f64::MAX,
            ..b
        },
        ExportBounds { width: 16385., ..b },
        ExportBounds {
            width: 8001.,
            height: 8000.,
            ..b
        },
    ] {
        assert!(region_plan(bounds, 1.).is_err());
    }
}

#[test]
fn icon_and_phone_exports_are_exact_at_1x_2x_3x_without_page_padding() {
    for (width, height) in [(24., 24.), (390., 844.)] {
        let doc = solid(width, height, -17.25, 9.375);
        for profile in ["analytic", "figma", "figmaSubpixel"] {
            let mut engine = engine(&doc);
            for scale in [1., 2., 3.] {
                let image = decoded(
                    &mut engine,
                    &request(-17.25, 9.375, width, height, scale, profile),
                );
                assert_eq!(
                    image.dimensions(),
                    ((width * scale) as u32, (height * scale) as u32)
                );
                for (x, y) in [
                    (0, 0),
                    (image.width() - 1, 0),
                    (0, image.height() - 1),
                    (image.width() - 1, image.height() - 1),
                ] {
                    assert_eq!(
                        image.get_pixel(x, y).0,
                        [224, 48, 128, 255],
                        "{width} {height} {scale}x {profile}"
                    );
                }
            }
        }
    }
}

#[test]
fn fractional_shape_edges_remain_transparent_in_outward_rounded_pixels() {
    let mut engine = engine(&solid(4.25, 3.5, -2.375, -7.25));
    for scale in [1., 2., 3.] {
        let image = decoded(
            &mut engine,
            &request(-2.375, -7.25, 4.25, 3.5, scale, "analytic"),
        );
        let alpha = image.get_pixel(image.width() - 1, 0).0[3];
        assert!((i16::from(alpha) - (0.25 * scale * 255.).round() as i16).abs() <= 1);
        assert_eq!(image.get_pixel(0, 0).0, [224, 48, 128, 255]);
        assert!(image.get_pixel(image.width() - 1, image.height() - 1).0[3] < 255);
    }
}

#[test]
fn explicit_slice_crops_at_the_requested_origin_and_preserves_transparency() {
    let doc = document(
        json!({
            "red":{"id":"red","kind":"rectangle","width":3,"height":4,"transform":[1,0,0,1,-4.5,2.25],"fills":[{"color":"#ff0000"}]},
            "blue":{"id":"blue","kind":"rectangle","width":4,"height":4,"transform":[1,0,0,1,-0.5,2.25],"fills":[{"color":"#0000ff"}]}
        }),
        json!(["red", "blue"]),
    );
    for profile in ["analytic", "figma", "figmaSubpixel"] {
        for scale in [1., 2., 3.] {
            let image = decoded(
                &mut engine(&doc),
                &request(-4.5, 2.25, 4., 4., scale, profile),
            );
            assert_eq!(image.get_pixel(0, 0).0, [255, 0, 0, 255]);
            assert_eq!(image.get_pixel(image.width() - 1, 0).0, [0, 0, 0, 0]);
        }
    }
}

#[test]
fn adjacent_slices_on_one_sampling_grid_match_a_single_tiled_export() {
    let doc = document(
        json!({
            "bg":{"id":"bg","kind":"rectangle","width":640,"height":144,"transform":[1,0,0,1,-23.25,7.375],"fills":[{"kind":"linear","angle":18,"stops":[{"offset":0,"color":"#203060"},{"offset":1,"color":"#e06020"}]}]},
            "ellipse":{"id":"ellipse","kind":"ellipse","width":132.5,"height":117.25,"transform":[1,0,0,1,280.5,20.625],"fills":[{"color":"#80a0e0","opacity":0.5}],"effects":[{"kind":"blur","radius":2.25}]},
            "glass":{"id":"glass","kind":"rectangle","width":83.5,"height":69.25,"transform":[1,0,0,1,279.5,16.25],"effects":[{"kind":"glass","radius":1.25,"amount":0,"opacity":0}]}
        }),
        json!(["bg", "ellipse", "glass"]),
    );
    for profile in ["analytic", "figma", "figmaSubpixel"] {
        for scale in [1., 2., 3.] {
            let mut e = engine(&doc);
            let whole = decoded(&mut e, &request(-23.25, 7.375, 640., 144., scale, profile));
            for half in [0., 1.] {
                let part = decoded(
                    &mut e,
                    &request(-23.25 + 320. * half, 7.375, 320., 144., scale, profile),
                );
                let offset = (320. * half * scale) as u32;
                for y in 0..part.height() {
                    for x in 0..part.width() {
                        assert_eq!(
                            part.get_pixel(x, y),
                            whole.get_pixel(offset + x, y),
                            "{profile} {scale}x half {half} ({x},{y})"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn selected_subtrees_keep_world_transform_and_exclude_other_layers() {
    let doc = document(
        json!({
            "parent":{"id":"parent","kind":"group","transform":[2,0,0,2,-10.25,7.5],"opacity":0.1,"children":["r"]},
            "r":{"id":"r","kind":"rectangle","width":12,"height":12,"transform":[1,0,0,1,3.5,-2.25],"fills":[{"color":"#ff0000"}]},
            "other":{"id":"other","kind":"rectangle","width":24,"height":24,"transform":[1,0,0,1,-3.25,3],"fills":[{"color":"#0000ff"}]}
        }),
        json!(["parent", "other"]),
    );
    let mut e = engine(&doc);
    let mut req = request(-3.25, 3., 24., 24., 2., "analytic");
    let whole = e.render_region_png(&req).unwrap();
    req.node_ids = Some(vec!["r".into()]);
    let selected = decoded(&mut e, &req);
    assert!(selected.pixels().all(|p| p.0 == [255, 0, 0, 255]));
    req.node_ids = None;
    assert_eq!(
        e.render_region_png(&req).unwrap(),
        whole,
        "selection must not mutate the next export"
    );
}

#[test]
fn failed_selection_export_restores_the_document_and_rejects_invalid_ids() {
    let doc = solid(24., 24., -5.25, 1.5);
    let mut e = engine(&doc);
    let mut req = request(-5.25, 1.5, 24., 24., 1., "analytic");
    let original = e.render_region_png(&req).unwrap();
    for ids in [vec![], vec!["missing".into()]] {
        req.node_ids = Some(ids);
        assert!(e.render_region_png(&req).is_err());
    }
    req.node_ids = Some(vec!["r".into()]);
    req.color_output = Some(Default::default());
    assert!(e.render_region_png(&req).unwrap_err().contains("managed"));
    req.color_output = None;
    req.node_ids = None;
    assert_eq!(e.render_region_png(&req).unwrap(), original);
}

#[test]
fn selected_parent_and_descendant_render_once_in_original_paint_order() {
    let doc = document(
        json!({
            "group":{"id":"group","kind":"group","children":["a","b"]},
            "a":{"id":"a","kind":"rectangle","width":24,"height":24,"opacity":0.5,"fills":[{"color":"#ff0000"}]},
            "b":{"id":"b","kind":"rectangle","width":24,"height":24,"opacity":0.5,"fills":[{"color":"#0000ff"}]}
        }),
        json!(["group"]),
    );
    let mut e = engine(&doc);
    let mut req = request(0., 0., 24., 24., 1., "analytic");
    let expected = e.render_region_png(&req).unwrap();
    for ids in [vec!["group", "a", "b"], vec!["b", "a"], vec!["b", "a", "a"]] {
        req.node_ids = Some(ids.into_iter().map(String::from).collect());
        assert_eq!(e.render_region_png(&req).unwrap(), expected);
    }
}

#[test]
fn managed_slice_uses_the_same_16_bit_color_encoder_at_all_mobile_scales() {
    let mut doc = solid(24., 24., -5.25, 1.5);
    doc["colorManagement"] =
        json!({"documentSpace":"display-p3","referenceWhiteNits":203,"peakLuminanceNits":1000});
    doc["nodes"]["r"]["fills"][0]["color"] = json!("color(display-p3 1 0.3 0.2 / 0.5)");
    for profile in ["figma", "figmaSubpixel"] {
        for scale in [1., 2., 3.] {
            let mut req = request(-5.25, 1.5, 24., 24., scale, profile);
            req.color_output = Some(
                serde_json::from_value(json!({"space":"display-p3","toneMap":"none"})).unwrap(),
            );
            let bytes = engine(&doc).render_region_png(&req).unwrap();
            let reader = png::Decoder::new(std::io::Cursor::new(&bytes))
                .read_info()
                .unwrap();
            assert_eq!(reader.info().bit_depth, png::BitDepth::Sixteen);
            assert!(reader.info().icc_profile.is_some());
            assert_eq!(
                (reader.info().width, reader.info().height),
                ((24. * scale) as u32, (24. * scale) as u32)
            );
        }
    }
}

#[test]
fn selected_nested_frame_keeps_its_clip_and_alpha_mask_at_mobile_scales() {
    let mut doc = document(
        json!({
            "parent": {"id":"parent","kind":"group","transform":[1,0,0,1,-10.5,2.75],"children":["frame"]},
            "frame": {"id":"frame","kind":"frame","width":8,"height":8,"transform":[1,0,0,1,7.25,0.25],"clip":true,"children":["mask","content"]},
            "mask": {"id":"mask","kind":"rectangle","width":4,"height":20,"transform":[1,0,0,1,2,-6],"mask":true,"opacity":0.5,"fills":[{"color":"#ffffff"}]},
            "content": {"id":"content","kind":"rectangle","width":30,"height":30,"transform":[1,0,0,1,-10,-10],"fills":[{"color":"#ff0000"}]},
            "other": {"id":"other","kind":"rectangle","width":30,"height":30,"transform":[1,0,0,1,-10,-10],"fills":[{"color":"#00ff00"}]}
        }),
        json!(["parent", "other"]),
    );
    for profile in ["analytic", "figma", "figmaSubpixel"] {
        for scale in [1., 2., 3.] {
            let mut request = request(-3.25, 3., 8., 8., scale, profile);
            request.node_ids = Some(vec!["frame".into()]);
            let image = decoded(&mut engine(&doc), &request);
            assert_eq!(image.get_pixel(0, 0).0, [0, 0, 0, 0]);
            assert_eq!(
                image.get_pixel((4. * scale) as u32, (4. * scale) as u32).0,
                [255, 0, 0, 128]
            );
            assert_eq!(
                image.get_pixel((7. * scale) as u32, (7. * scale) as u32).0,
                [0, 0, 0, 0]
            );
        }
    }
    // Hidden or foreign-page selections are errors, never a misleading empty file.
    doc["nodes"]["frame"]["visible"] = json!(false);
    let mut request = request(-3.25, 3., 8., 8., 1., "analytic");
    request.node_ids = Some(vec!["frame".into()]);
    assert!(engine(&doc).render_region_png(&request).is_err());
}

#[test]
fn distant_disjoint_shapes_cannot_change_a_slice_coverage_resolve() {
    let doc = document(
        json!({
            "a":{"id":"a","kind":"ellipse","width":20.25,"height":20.25,"transform":[1,0,0,1,10.125,10.125],"fills":[{"color":"#ff0000"}]},
            "b":{"id":"b","kind":"ellipse","width":20.25,"height":20.25,"transform":[1,0,0,1,350.125,10.125],"fills":[{"color":"#00ff00"}]}
        }),
        json!(["a", "b"]),
    );
    for profile in ["figma", "figmaSubpixel"] {
        for scale in [1., 2., 3.] {
            let mut e = engine(&doc);
            let whole = decoded(&mut e, &request(0., 0., 640., 144., scale, profile));
            for x in [0., 320.] {
                let part = decoded(&mut e, &request(x, 0., 320., 144., scale, profile));
                for row in 0..part.height() {
                    for col in 0..part.width() {
                        assert_eq!(
                            part.get_pixel(col, row),
                            whole.get_pixel((x * scale) as u32 + col, row),
                            "{profile} {scale}x at ({col},{row})"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn small_slices_keep_chained_backdrop_inputs_outside_their_viewport() {
    for (profile, count, radius, bg_x, bg_width, height, y) in [
        ("analytic", 5, 20., 320., 320., 1000., -500.),
        ("figmaSubpixel", 3, 10., 330., 10., 144., 0.),
    ] {
        let scales: &[f64] = if profile == "analytic" {
            &[1.]
        } else {
            &[1., 2., 3.]
        };
        for &scale in scales {
            // Keep device extents constant so every scale still exercises a
            // <=512-pixel slice. Growing the output instead would miss the
            // old small-image fast path at 2x/3x and inflate debug test cost.
            let mut nodes = json!({"bg":{"id":"bg","kind":"rectangle","width":bg_width/scale,"height":height/scale,
                "transform":[1,0,0,1,bg_x/scale,y/scale],"fills":[{"color":"#ff0000"}]}});
            let mut children = vec!["bg".to_string()];
            for i in 0..count {
                let id = format!("blur{i}");
                nodes[&id] = json!({"id":id,"kind":"rectangle","width":640./scale,"height":height/scale,
                    "transform":[1,0,0,1,0,y/scale],"effects":[{"kind":"background-blur","radius":radius/scale,"color":"#000000"}]});
                children.push(id);
            }
            let doc = document(nodes, json!(children));
            let mut e = engine(&doc);
            let whole = decoded(
                &mut e,
                &request(0., 0., 640. / scale, 64. / scale, scale, profile),
            );
            for x in [0., 320.] {
                let part = decoded(
                    &mut e,
                    &request(x / scale, 0., 320. / scale, 64. / scale, scale, profile),
                );
                for row in 0..part.height() {
                    for col in 0..part.width() {
                        assert_eq!(
                            part.get_pixel(col, row),
                            whole.get_pixel(x as u32 + col, row),
                            "{profile} {scale}x at ({col},{row})"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn profile_specific_limits_reject_before_rendering() {
    let mut e = engine(&solid(24., 24., 0., 0.));
    for request in [
        request(0., 0., 8193., 1., 1., "figma"),
        request(0., 0., 3000., 3000., 1., "figma"),
        request(0., 0., 1., 1., 65., "figma"),
    ] {
        assert!(e.render_region_png(&request).is_err());
    }
    let mut doc = solid(24., 24., 0., 0.);
    doc["colorManagement"] =
        json!({"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000});
    assert!(
        engine(&doc)
            .render_region_png(&request(0., 0., 3000., 3000., 1., "figmaSubpixel"))
            .is_err()
    );
}
