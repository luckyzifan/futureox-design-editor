use futureox_design_gpu::{Backends, NativeGpu, encode_png};
use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::{Value, json};

fn options() -> RenderOptions {
    serde_json::from_value(json!({"pageId":"p","width":97,"height":73,"transparent":true,"rasterProfile":"figma","view":{"x":0,"y":0,"zoom":1}})).unwrap()
}
fn rect(id: &str, x: f64, y: f64, color: &str) -> Value {
    json!({"id":id,"kind":"rectangle","transform":[1,0,0,1,x,y],"width":37.5,"height":31.75,"fills":[{"kind":"solid","color":color}]})
}
fn doc(nodes: Value, roots: Value) -> String {
    json!({"schemaVersion":1,"id":"d","name":"native acceptance","pages":[{"id":"p","name":"p","children":roots,"background":"#ffffff"}],"nodes":nodes}).to_string()
}
fn assert_parity(gpu: &mut NativeGpu, document: &str, options: &RenderOptions) {
    let mut engine = Engine::new();
    engine.load_document(document).unwrap();
    let scene = engine.compile_gpu(options).unwrap();
    let cpu = engine.render(options).unwrap();
    let native = gpu.render(&scene).unwrap();
    assert!(native.draw_calls > 0);
    let max = cpu
        .iter()
        .zip(&native.rgba)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap();
    let different = cpu
        .chunks_exact(4)
        .zip(native.rgba.chunks_exact(4))
        .filter(|(a, b)| a != b)
        .count();
    if max > 0
        && let Ok(dir) = std::env::var("DESIGN_GPU_TEST_ARTIFACTS")
    {
        let dir = std::path::Path::new(&dir);
        std::fs::create_dir_all(dir).unwrap();
        let name = document.len();
        std::fs::write(
            dir.join(format!("{name}.json")),
            json!({"document":serde_json::from_str::<Value>(document).unwrap(),"options":options})
                .to_string(),
        )
        .unwrap();
        std::fs::write(dir.join(format!("{name}-native.rgba")), &native.rgba).unwrap();
        std::fs::write(dir.join(format!("{name}-cpu.rgba")), &cpu).unwrap();
    }
    assert_eq!(native.rgba.len(), cpu.len());
    assert_eq!((max, different), (0, 0), "native/CPU differ");
}
/// Parity with image mips enabled on BOTH sides: the CPU reference sampler and
/// the compositor must derive the same level from the same pure geometry.
fn assert_parity_at_mips(gpu: &mut NativeGpu, document: &str, options: &RenderOptions) {
    let mut engine = Engine::new();
    engine.load_document(document).unwrap();
    engine.set_image_mips(true);
    gpu.set_image_mips(true);
    let scene = engine.compile_gpu(options).unwrap();
    let cpu = engine.render(options).unwrap();
    let native = gpu.render(&scene).unwrap();
    gpu.set_image_mips(false);
    assert!(native.draw_calls > 0);
    assert_eq!(native.rgba.len(), cpu.len());
    let (max, different) = cpu
        .iter()
        .zip(&native.rgba)
        .fold((0_u8, 0_usize), |(max, different), (a, b)| {
            (max.max(a.abs_diff(*b)), different + usize::from(a != b))
        });
    assert_eq!((max, different), (0, 0), "native/CPU differ under mips");
}

#[test]
fn png_round_trip_preserves_unaligned_rows_and_alpha() {
    let bytes: Vec<u8> = (0..97 * 73 * 4).map(|i| (i * 17 % 256) as u8).collect();
    let encoded = encode_png(97, 73, &bytes).unwrap();
    let mut reader = png::Decoder::new(std::io::Cursor::new(encoded))
        .read_info()
        .unwrap();
    assert!(reader.info().srgb.is_some());
    let mut decoded = vec![0; reader.output_buffer_size().unwrap()];
    reader.next_frame(&mut decoded).unwrap();
    assert_eq!(bytes, decoded);
    assert!(encode_png(97, 73, &bytes[..12]).is_err());
}

#[tokio::test]
#[cfg_attr(not(feature = "hardware-tests"), ignore = "requires actual GPU host")]
async fn sketch_color_controls_preserve_alpha_and_match_cpu_pixels() {
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    for space in [None, Some("srgb"), Some("display-p3")] {
        for background in [false, true] {
            let mut controls=json!({"brightness":0.2,"contrast":1.4,"saturation":0.8,"hue":0.7});
            if let Some(space)=space {controls["space"]=json!(space);}
            let mut a=rect("a",8.,8.,"#3366b3");
            let mut b=rect("b",14.25,15.5,"color(srgb 1 0 0 / 0.5)");
            if background { b["fills"]=json!([]); }
            b["effects"]=json!([{"kind":if background {"background-blur"} else {"color-controls"},
                "radius":0.,"color":"#000000","colorControls":controls}]);
            a["width"]=json!(70.);a["height"]=json!(60.);
            let document=json!({"schemaVersion":17,"id":"controls","name":"controls",
                "colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},
                "pages":[{"id":"p","name":"P","background":"#ffffff","children":["a","b"]}],"nodes":{"a":a,"b":b}});
            assert_parity(&mut gpu,&document.to_string(),&options());
        }
    }
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn authoring_paint_transforms_and_luminance_masks() {
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    for kind in ["linear", "radial", "angular", "diamond"] {
        let mut a = rect("a", 8., 8., "#000000");
        a["fills"][0]["kind"] = json!(kind);
        a["fills"][0]["stops"] =
            json!([{"offset":0,"color":"#000000"},{"offset":1,"color":"#ffffff"}]);
        a["fills"][0]["transform"] = json!([0, 1, -1, 0, 1, 0]);
        let document = doc(json!({"a":a}), json!(["a"]))
            .replace(r#""schemaVersion":1"#, r#""schemaVersion":4"#);
        let mut engine = Engine::new();
        engine.load_document(&document).unwrap();
        let opts = options();
        let scene = engine.compile_gpu(&opts).unwrap();
        let cpu = engine.render(&opts).unwrap();
        let native = gpu.render(&scene).unwrap();
        let maximum = cpu
            .iter()
            .zip(native.rgba.iter())
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        println!("authoring gradient {kind}: max difference {maximum}");
        assert_eq!(maximum, 0, "{kind}: nonzero byte difference");
    }
    let mut mask = rect("mask", 8., 8., "#ff0000");
    mask["mask"] = json!(true);
    mask["maskType"] = json!("luminance");
    let document=doc(json!({"g":{"id":"g","kind":"group","width":80,"height":64,"children":["mask","a"]},"mask":mask,"a":rect("a",8.,8.,"#ffffff")}),json!(["g"])).replace(r#""schemaVersion":1"#, r#""schemaVersion":4"#);
    assert_parity(&mut gpu, &document, &options());
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn managed_float_preserves_hdr_gamut_alpha_and_filter_energy() {
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    let mut failures = Vec::new();
    for filtered in [false, true] {
        let mut a = rect("a", 8.125, 9.25, "color(srgb-linear 4 -0.1 0.25)");
        a["fills"][0]["kind"] = json!("linear");
        a["fills"][0]["stops"] = json!([{"offset":0,"color":"color(srgb-linear 4 -0.1 0.25 / 0.5)"},{"offset":1,"color":"color(display-p3 0 1 0)"}]);
        if filtered {
            a["effects"] = json!([{"kind":"blur","radius":4.25,"x":0,"y":0,"spread":0,"color":"#000000","opacity":0.5,"amount":0.5}]);
        }
        let mut d: Value = serde_json::from_str(&doc(
            json!({"a":a,"b":rect("b",19.5,19.125,"color(srgb-linear 0 0 2 / 0.25)")}),
            json!(["a", "b"]),
        ))
        .unwrap();
        d["schemaVersion"] = json!(3);
        d["colorManagement"] =
            json!({"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000});
        let mut engine = Engine::new();
        engine.load_document(&d.to_string()).unwrap();
        let o = options();
        let cpu = engine.render_linear(&o).unwrap();
        let scene = engine.compile_gpu(&o).unwrap();
        let result = gpu.render(&scene).unwrap();
        let values = result.linear.unwrap();
        assert_eq!(values.len(), cpu.len() * 4);
        assert!(values.iter().step_by(4).any(|v| *v > 1.));
        let mut max = 0_f32;
        let mut different = 0;
        for (a, b) in cpu.iter().flat_map(|p| p.0).zip(&values) {
            max = max.max((a - b).abs());
            different += usize::from(a.to_bits() != b.to_bits());
        }
        eprintln!(
            "managed parity filtered={filtered} differentFloatWords={different} max_absolute_error={max}"
        );
        if different != 0 {
            failures.push((filtered, different));
        }
    }
    assert!(
        failures.is_empty(),
        "Managed precision failures: {failures:?}"
    );
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn gpu_empty_mask_constraints_survive_culling() {
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    for profile in ["figma", "figmaSubpixel"] {
        for blend in ["normal", "pass-through"] {
            for (visible, opacity, offset) in
                [(true, 1., 1000.), (true, 0., 0.), (false, 1., 1000.)]
            {
                let mut mask = rect("mask", offset, offset, "#ffffff");
                mask["mask"] = json!(true);
                mask["visible"] = json!(visible);
                mask["opacity"] = json!(opacity);
                let d = doc(
                    json!({"g":{"id":"g","kind":"group","width":80,"height":64,"blend":blend,"children":["mask","a"]},"mask":mask,"a":rect("a",8.,8.,"#ff0000")}),
                    json!(["g"]),
                );
                let mut o = options();
                o.raster_profile = serde_json::from_value(json!(profile)).unwrap();
                assert_parity(&mut gpu, &d, &o);
            }
        }
    }
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn offscreen_leaf_keeps_visible_pixel_resolve_stable() {
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    let o = options();
    let mut d: Value = serde_json::from_str(&doc(
        json!({"a":rect("a",8.125,8.125,"#000000")}),
        json!(["a"]),
    ))
    .unwrap();
    let mut engine = Engine::new();
    engine.load_document(&d.to_string()).unwrap();
    let before = gpu.render(&engine.compile_gpu(&o).unwrap()).unwrap().rgba;
    d["nodes"]["far"] = rect("far", 100000., 100000., "#000000");
    d["pages"][0]["children"]
        .as_array_mut()
        .unwrap()
        .push(json!("far"));
    engine.load_document(&d.to_string()).unwrap();
    let after = gpu.render(&engine.compile_gpu(&o).unwrap()).unwrap().rgba;
    assert_eq!(before, after);
    assert_eq!(after, engine.render(&o).unwrap());
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn animation_fractional_shadow_and_gradient_are_byte_exact() {
    let request: Value = serde_json::from_str(include_str!(
        "../../design-kernel/tests/fixtures/animation-shadow.json"
    ))
    .unwrap();
    let document = request["document"].to_string();
    let mut options: RenderOptions = serde_json::from_value(request["options"].clone()).unwrap();
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    for time in [0., 125., 300., 600., 900., 1200., 1800., 2400., 300.] {
        options.animation.as_mut().unwrap().time_ms = time;
        assert_parity(&mut gpu, &document, &options);
    }
}

// Explicit hardware suite; invoked with --ignored in local native acceptance.
// Failure to obtain an adapter is a failure, never a skipped/passed test.
#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn gpu_masks_effects_topology_and_recovery() {
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    let mut o = options();
    for kind in ["blur", "shadow", "inner-shadow", "background-blur", "glass"] {
        eprintln!("effect: {kind}");
        let mut a = rect("a", 8.125, 11.375, "#4488cc");
        a["kind"] = json!("ellipse");
        let mut b = rect("b", 27.875, 19.625, "#ee9944");
        b["opacity"] = json!(0.625);
        b["effects"] = json!([{"kind":kind,"color":"#223344","radius":2.5,"x":1.25,"y":2.,"opacity":0.5,"amount":1.5}]);
        let d = doc(json!({"a":a,"b":b}), json!(["a", "b"]));
        assert_parity(&mut gpu, &d, &o);
    }
    for passthrough in [false, true] {
        let mut mask = rect("mask", 4.375, 3.625, "#000000");
        mask["mask"] = json!(true);
        mask["opacity"] = json!(0.5);
        let g = json!({"id":"g","kind":"group","width":80,"height":64,"blend":if passthrough{"pass-through"}else{"normal"},"children":["mask","a","b"],"opacity":0.875});
        let d = doc(
            json!({"g":g,"mask":mask,"a":rect("a",8.125,11.375,"#4488cc"),"b":rect("b",19.625,23.375,"#ee9944")}),
            json!(["g"]),
        );
        assert_parity(&mut gpu, &d, &o);
    }
    // Crossing, coincident, zero-length and near-collinear edges, both winding
    // rules, reflected/sheared transforms and fractional pixel phase.
    for rule in ["evenodd", "nonzero"] {
        for seed in 0..12 {
            let points = [
                (0., 0.),
                (40., 36.),
                (0., 36.),
                (40., 0.),
                (40., 0.),
                (20., 0.00001),
                (0., 0.),
            ];
            let vertices: Vec<_> = points
                .iter()
                .enumerate()
                .map(|(i, (x, y))| json!({"id":format!("v{i}"),"x":x,"y":y}))
                .collect();
            let edges:Vec<_>=(0..points.len()).map(|i|json!({"id":format!("e{i}"),"from":format!("v{i}"),"to":format!("v{}",(i+1)%points.len())})).collect();
            let mut n = rect("v", 5.125, 7.375, "#8866dd");
            n["kind"] = json!("vector");
            n["transform"] = json!([
                if seed % 2 == 0 { 1. } else { -1. },
                0.125,
                -0.125,
                1.,
                45.125 + seed as f64 * 0.03125,
                7.375
            ]);
            n["network"] = json!({"vertices":vertices,"edges":edges,"fillRule":rule});
            let d = doc(json!({"v":n}), json!(["v"]));
            assert_parity(&mut gpu, &d, &o);
        }
    }
    let d = doc(json!({"a":rect("a",12.125,9.375,"#4488cc")}), json!(["a"]));
    for density in [1, 2] {
        o.pixel_preview = Some(density);
        o.view.zoom = 1.375;
        let plan = futureox_design_kernel::preview::plan(&o).unwrap();
        eprintln!("preview source: {density}");
        assert_parity(&mut gpu, &d, &plan.source);
        eprintln!("preview output: {density}");
        assert_parity(&mut gpu, &d, &o);
    }
    o = options();
    let mut engine = Engine::new();
    engine.load_document(&d).unwrap();
    let mut analytic = o.clone();
    analytic.raster_profile = Default::default();
    assert_parity(&mut gpu, &d, &analytic);
    let mut huge = engine.compile_gpu(&o).unwrap();
    huge.extent.w = u32::MAX;
    assert!(gpu.render(&huge).is_err());
    let mut cycle = engine.compile_gpu(&o).unwrap();
    let n = cycle.nodes.get_mut("a").unwrap();
    n.children = vec!["a".into()];
    n.mask = true;
    assert!(gpu.render(&cycle).unwrap_err().contains("nesting exceeds"));
    assert_parity(&mut gpu, &d, &o);
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn gpu_ordered_batches_survive_command_pages() {
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    let mut nodes = serde_json::Map::new();
    let mut roots = Vec::new();
    for i in 0..230 {
        let id = format!("n{i}");
        let mut n = rect(
            &id,
            (i % 16) as f64 * 5. + 0.125,
            (i / 16) as f64 * 4. + 0.375,
            if i % 2 == 0 { "#dd6644" } else { "#4477dd" },
        );
        n["width"] = json!(7.75);
        n["height"] = json!(6.5);
        if (40..185).contains(&i) {
            n["fills"] = json!([{"kind":"linear","color":"#4455dd","stops":[{"offset":0.,"color":"#4455dd"},{"offset":1.,"color":"#dd7744"}]}]);
        }
        nodes.insert(id.clone(), n);
        roots.push(id);
    }
    let d = doc(Value::Object(nodes), json!(roots));
    let o = options();
    assert_parity(&mut gpu, &d, &o);
    let mut engine = Engine::new();
    engine.load_document(&d).unwrap();
    let rendered = gpu.render(&engine.compile_gpu(&o).unwrap()).unwrap();
    assert!(
        rendered.submissions > 1,
        "fixture must exercise queue paging"
    );
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn translucent_batches_and_absolute_animation_frames() {
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    let mut nodes = serde_json::Map::new();
    let mut roots = Vec::new();
    for i in 0..40 {
        let id = format!("n{i}");
        let mut n = rect(
            &id,
            (i % 8) as f64 * 8. + 0.125,
            (i / 8) as f64 * 7. + 0.375,
            if i % 2 == 0 { "#4477dd" } else { "#cc8844" },
        );
        n["fills"][0]["opacity"] = json!([0.15, 0.3, 0.55, 0.85][i % 4]);
        nodes.insert(id.clone(), n);
        roots.push(id);
    }
    assert_parity(
        &mut gpu,
        &doc(Value::Object(nodes), json!(roots)),
        &options(),
    );
    use futureox_design_kernel::{
        animation::{Clip, Easing, Keyframe, Pose, Repeat, Sample, Track},
        scene::Document,
    };
    let mut d: Document = serde_json::from_str(&doc(
        json!({"a":rect("a",8.125,9.375,"#4488cc")}),
        json!(["a"]),
    ))
    .unwrap();
    let a = Pose::from(&d.nodes["a"]);
    let mut b = a.clone();
    b.transform.0[4] += 24.;
    b.opacity = 0.5;
    d.animations = vec![Clip {
        id: "clip".into(),
        name: "native".into(),
        page_id: "p".into(),
        duration_ms: 1000.,
        delay_ms: 0.,
        repeat: Repeat::Once,
        tracks: vec![Track {
            node_id: "a".into(),
            rotation_turns: 0,
            keyframes: vec![
                Keyframe {
                    time_ms: 0.,
                    value: a,
                    easing: Easing::Linear,
                },
                Keyframe {
                    time_ms: 1000.,
                    value: b,
                    easing: Easing::Linear,
                },
            ],
        }],
    }];
    let mut o = options();
    let mut engine = Engine::new();
    engine
        .load_document(&serde_json::to_string(&d).unwrap())
        .unwrap();
    let mut previous = Vec::new();
    for time in [0., 250., 500., 750., 1000., 500.] {
        o.animation = Some(Sample {
            clip_id: "clip".into(),
            time_ms: time,
        });
        let compiled = engine.compile_gpu(&o).unwrap();
        let cpu = engine.render(&o).unwrap();
        let actual = gpu.render(&compiled).unwrap();
        assert!(
            cpu == actual.rgba,
            "animated CPU/GPU frame differs at {time} ms"
        );
        if time == 500. {
            if !previous.is_empty() {
                assert!(
                    previous == actual.rgba,
                    "revisiting the same time changed pixels"
                );
            }
            previous = actual.rgba;
        }
    }
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn managed_masks_procedural_effects_and_tagged_images_match_cpu() {
    use base64::Engine as _;
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    let mut cases = Vec::new();
    let mut mask = rect("mask", 8., 8., "#ffffff");
    mask["mask"] = json!(true);
    mask["opacity"] = json!(0.5);
    cases.push(("mask",json!({"g":{"id":"g","kind":"group","width":64,"height":56,"children":["mask","a","b"]},"mask":mask,"a":rect("a",8.,8.,"color(srgb-linear 4 0 0)"),"b":rect("b",8.,8.,"color(srgb-linear 0 0 2)")}),json!(["g"])));
    let mut bg = rect("bg", 0., 0., "color(srgb-linear 4 1 0.25)");
    bg["width"] = json!(97);
    bg["height"] = json!(73);
    let mut surface = rect("surface", 16.125, 16.125, "#ffffff");
    surface["fills"][0]["opacity"] = json!(0.1);
    surface["effects"] = json!([{"kind":"background-blur","radius":4.25,"x":0,"y":0,"spread":0,"color":"#000000","opacity":0.25,"amount":0.5}]);
    cases.push((
        "backdrop",
        json!({"bg":bg,"surface":surface}),
        json!(["bg", "surface"]),
    ));
    let mut blend_child = rect("a", 8.125, 8.125, "color(srgb-linear 2 0.5 0.25)");
    blend_child["blend"] = json!("multiply");
    cases.push(("pass-through",json!({"bg":bg,"g":{"id":"g","kind":"group","width":64,"height":56,"blend":"pass-through","opacity":0.5,"children":["a"]},"a":blend_child}),json!(["bg","g"])));
    for kind in ["noise", "texture"] {
        let mut a = rect("a", 8.125, 9.25, "color(srgb-linear 2 0.3 0.4)");
        a["effects"] = json!([{"kind":kind,"radius":0,"x":0,"y":0,"spread":0,"color":"#000000","opacity":0.3,"amount":0.7}]);
        cases.push((kind, json!({"a":a}), json!(["a"])));
    }
    for (kind, bytes) in [
        (
            "ICC",
            include_bytes!(
                "../../../../frontend/design-client/public/color-fixtures/p3-red-icc.png"
            )
            .as_slice(),
        ),
        (
            "PQ",
            include_bytes!(
                "../../../../frontend/design-client/public/color-fixtures/pq-highlights.png"
            )
            .as_slice(),
        ),
        (
            "HLG",
            include_bytes!(
                "../../../../frontend/design-client/public/color-fixtures/hlg-highlights.png"
            )
            .as_slice(),
        ),
    ] {
        let mut a = rect("a", 8.125, 9.25, "#ffffff");
        a["fills"][0]["kind"] = json!("image");
        a["fills"][0]["image"] = json!(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ));
        cases.push((kind, json!({"a":a}), json!(["a"])));
    }
    let mut failures = Vec::new();
    for (kind, nodes, roots) in cases {
        let mut d: Value = serde_json::from_str(&doc(nodes, roots)).unwrap();
        d["schemaVersion"] = json!(3);
        d["colorManagement"] =
            serde_json::to_value(futureox_design_kernel::color::ColorSettings::default()).unwrap();
        let mut engine = Engine::new();
        engine.load_document(&d.to_string()).unwrap();
        let options = options();
        let cpu = engine.render_linear(&options).unwrap();
        let gpu_values = gpu
            .render(&engine.compile_gpu(&options).unwrap())
            .unwrap()
            .linear
            .unwrap();
        if kind == "mask" {
            assert_eq!(
                &gpu_values[(16 * 97 + 16) * 4..(16 * 97 + 16) * 4 + 4],
                &[0., 0., 1., 0.5]
            );
        }
        let mut max = 0_f32;
        let mut different = 0;
        for (a, b) in cpu.iter().flat_map(|p| p.0).zip(gpu_values) {
            let error = (a - b).abs();
            max = max.max(error);
            different += usize::from(a.to_bits() != b.to_bits());
        }
        eprintln!("managed {kind} differentFloatWords={different} max_absolute_error={max}");
        if different != 0 {
            failures.push((kind, different));
        }
    }
    assert!(
        failures.is_empty(),
        "Managed precision failures: {failures:?}"
    );
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn shared_precision_corpus_is_byte_exact() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/precision-corpus.json"
    ))
    .unwrap();
    let font = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
    ))
    .unwrap();
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    eprintln!("Strict corpus adapter: {:?}", gpu.description());
    let mut failures = Vec::new();
    let profiles =
        std::env::var("DESIGN_PARITY_PROFILES").unwrap_or_else(|_| "figma,figmaSubpixel".into());
    for profile in profiles.split(',') {
        for (index, row) in corpus["cases"].as_array().unwrap().iter().enumerate() {
            let mut options = row["options"].clone();
            options["rasterProfile"] = json!(profile);
            let options: RenderOptions = serde_json::from_value(options).unwrap();
            let mut engine = Engine::new();
            engine.load_font(&font).unwrap();
            engine.load_document(&row["document"].to_string()).unwrap();
            let scene = match engine.compile_gpu(&options) {
                Ok(scene) => scene,
                Err(error) => {
                    failures.push(json!({"profile":profile,"index":index,"name":row["document"]["name"],"compileError":error}));
                    continue;
                }
            };
            let native = match gpu.render(&scene) {
                Ok(rendered) => rendered,
                Err(error) => {
                    failures.push(json!({"profile":profile,"index":index,"name":row["document"]["name"],"backendError":error}));
                    continue;
                }
            };
            let cpu = engine.render(&options).unwrap();
            if scene.color_management.is_some() {
                let cpu_linear: Vec<u32> = engine
                    .render_linear(&options)
                    .unwrap()
                    .iter()
                    .flat_map(|p| p.0.map(f32::to_bits))
                    .collect();
                let native_linear: Vec<u32> = native
                    .linear
                    .as_ref()
                    .expect("Missing managed float readback")
                    .iter()
                    .map(|p| p.to_bits())
                    .collect();
                if cpu_linear != native_linear {
                    failures.push(json!({"profile":profile,"index":index,"name":row["document"]["name"],
                        "differentFloatWords":cpu_linear.iter().zip(&native_linear).filter(|(a,b)|a!=b).count()}));
                }
                if let Ok(directory) = std::env::var("DESIGN_GPU_TEST_ARTIFACTS") {
                    let directory = std::path::Path::new(&directory);
                    std::fs::create_dir_all(directory).unwrap();
                    for (backend, values) in [("cpu", &cpu_linear), ("native", &native_linear)] {
                        let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
                        std::fs::write(
                            directory
                                .join(format!("corpus-{profile}-{index}-{backend}.linear.f32")),
                            bytes,
                        )
                        .unwrap();
                    }
                }
            }
            if cpu != native.rgba {
                let different = cpu.iter().zip(&native.rgba).filter(|(a, b)| a != b).count();
                failures.push(json!({"profile":profile,"index":index,"name":row["document"]["name"],"differentBytes":different}));
            }
            // Persist successful frames too: the gate must compare native
            // Rust CPU directly with WASM CPU, not assume they coincide.
            if let Ok(directory) = std::env::var("DESIGN_GPU_TEST_ARTIFACTS") {
                let directory = std::path::Path::new(&directory);
                std::fs::create_dir_all(directory).unwrap();
                std::fs::write(
                    directory.join(format!("corpus-{profile}-{index}-cpu.rgba")),
                    &cpu,
                )
                .unwrap();
                std::fs::write(
                    directory.join(format!("corpus-{profile}-{index}-native.rgba")),
                    &native.rgba,
                )
                .unwrap();
            }
        }
    }
    println!(
        "Shared corpus: {} inputs x requested profiles; {} failures",
        corpus["cases"].as_array().unwrap().len(),
        failures.len()
    );
    if let Ok(directory) = std::env::var("DESIGN_GPU_TEST_ARTIFACTS") {
        let directory = std::path::Path::new(&directory);
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(
            directory.join("results.json"),
            serde_json::to_vec_pretty(&json!({
                "inputs":corpus["cases"].as_array().unwrap().len(), "profiles":profiles,
                "hardware":gpu.description(), "failures":failures,
                "scope":"RGBA8 bytes and managed binary32 bits; zero tolerance"
            }))
            .unwrap(),
        )
        .unwrap();
    }
    assert!(
        failures.is_empty(),
        "{}",
        serde_json::to_string_pretty(&failures).unwrap()
    );
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn byte_image_coordinates_match_cpu_at_fractional_and_transformed_samples() {
    use base64::Engine as _;
    let rgba: Vec<u8> = (0..16)
        .flat_map(|i| {
            let (x, y) = (i % 4, i / 4);
            if x == 0 && y == 0 {
                [75, 123, 181, 80]
            } else if x >= 2 && y >= 2 {
                [0, 0, 255, 255]
            } else if x < 3 && y < 3 {
                [255, 0, 0, 128]
            } else {
                [0, 0, 0, 0]
            }
        })
        .collect();
    let uri = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(encode_png(4, 4, &rgba).unwrap())
    );
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    println!("adapter {:?}", gpu.description());
    for profile in ["figma", "figmaSubpixel", "figmaSoftware"] {
        for transformed in [false, true] {
            for fit in ["stretch", "contain", "cover"] {
                let mut image = json!({"id":"image","kind":"rectangle","width":30,"height":22,
                    "transform":[1,0,0,1,11.25,79.5],"fills":[{"kind":"image","color":"#ffffff","image":uri,"fit":fit}]});
                if transformed {
                    image["transform"] = json!([0.93, 0.17, -0.22, 1.07, 14.25, 76.5]);
                    image["fills"][0]["transform"] = json!([0.9, 0.1, 0.08, 1.12, 0.07, -0.03]);
                }
                let document=json!({"schemaVersion":5,"id":"byte-image","name":"byte image fields",
                    "pages":[{"id":"p","name":"p","background":"#ffffff","children":["base","image"]}],
                    "nodes":{"base":{"id":"base","kind":"rectangle","transform":[1,0,0,1,4,8],"width":142,"height":103,
                        "fills":[{"kind":"solid","color":"#d65425"}]},"image":image}}).to_string();
                let opts: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":192,"height":128,
                    "view":{"x":-19.25,"y":-14.75,"zoom":1.25},"transparent":true,"rasterProfile":profile})).unwrap();
                println!("byte image {profile} transformed={transformed} fit={fit}");
                assert_parity(&mut gpu, &document, &opts);
            }
        }
    }
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn minified_images_match_cpu_with_mips_enabled() {
    use base64::Engine as _;
    // 64×64 structured asset rendered into a 16×12 node: the max texel stride
    // is 4, so both engines must sample from level 2 of the chain.
    let rgba: Vec<u8> = (0..64 * 64)
        .flat_map(|i| {
            let (x, y) = (i % 64, i / 64);
            [
                (x * 4) as u8,
                (y * 4) as u8,
                ((x * y) % 256) as u8,
                if x % 7 == 0 { 128 } else { 255 },
            ]
        })
        .collect();
    let uri = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(encode_png(64, 64, &rgba).unwrap())
    );
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    println!("adapter {:?}", gpu.description());
    for profile in ["figma", "figmaSubpixel"] {
        for fit in ["stretch", "contain", "cover"] {
            let document = json!({"schemaVersion":5,"id":"mip-image","name":"mip parity",
                "pages":[{"id":"p","name":"p","background":"#ffffff","children":["image"]}],
                "nodes":{"image":{"id":"image","kind":"rectangle","width":16,"height":12,
                    "transform":[1,0,0,1,2.25,3.5],
                    "fills":[{"kind":"image","color":"#ffffff","image":uri,"fit":fit}]}}})
            .to_string();
            let opts: RenderOptions =
                serde_json::from_value(json!({"pageId":"p","width":96,"height":72,
                "view":{"x":-1.25,"y":-2.75,"zoom":1},"transparent":true,"rasterProfile":profile}))
                .unwrap();
            println!("mip image {profile} fit={fit}");
            assert_parity_at_mips(&mut gpu, &document, &opts);
            // Level selection must actually engage for this geometry: with mips
            // off the CPU output differs from the mips-on reference.
            let render = |mips: bool| {
                let mut engine = Engine::new();
                engine.load_document(&document).unwrap();
                engine.set_image_mips(mips);
                engine.render(&opts).unwrap()
            };
            assert_ne!(
                render(false),
                render(true),
                "level selection did not engage for {fit}"
            );
        }
    }
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn atlas_packed_float_images_match_cpu_and_standalone_textures() {
    use base64::Engine as _;
    let rgba: Vec<u8> = (0..64 * 64)
        .flat_map(|i| {
            let (x, y) = (i % 64, i / 64);
            [(x * 4) as u8, (y * 4) as u8, ((x * y) % 256) as u8, 255]
        })
        .collect();
    let uri = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(encode_png(64, 64, &rgba).unwrap())
    );
    let mut nodes = serde_json::Map::new();
    let mut roots = Vec::new();
    for i in 0..4 {
        let id = format!("image{i}");
        nodes.insert(
            id.clone(),
            json!({"id":id,"kind":"rectangle","width":80,"height":60,
                "transform":[1,0,0,1,(i%2) as f64 * 82.5,(i/2) as f64 * 62.25],
                "fills":[{"kind":"image","color":"#ffffff","image":uri,"fit":"stretch"}]}),
        );
        roots.push(json!(id));
    }
    let document = json!({"schemaVersion":5,"id":"atlas-float","name":"atlas float parity",
        "colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":roots}],
        "nodes":nodes}).to_string();
    let opts: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":200,"height":160,
        "view":{"x":-4.5,"y":-6.25,"zoom":1},"transparent":true,"rasterProfile":"figma"}))
    .unwrap();
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    println!("adapter {:?}", gpu.description());
    gpu.set_image_atlas(true);
    assert_parity(&mut gpu, &document, &opts);
    gpu.set_image_atlas(false);
    // Atlas packing must be byte-exact by construction: packed and standalone
    // frame bytes agree with the CPU reference to the last bit.
    assert_parity(&mut gpu, &document, &opts);
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn byte_image_coordinate_large_frame_stays_within_surface_budget() {
    use base64::Engine as _;
    let rgba = [75_u8, 123, 181, 80].repeat(512 * 512);
    let uri = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(encode_png(512, 512, &rgba).unwrap())
    );
    let document=json!({"schemaVersion":5,"id":"large-byte","name":"large byte image","pages":[{"id":"p","name":"p","background":"#ffffff","children":["image"]}],
        "nodes":{"image":{"id":"image","kind":"rectangle","width":1008,"height":748,"transform":[1,0,0,1,3.25,4.5],
            "fills":[{"kind":"image","color":"#ffffff","image":uri,"fit":"stretch"}]}}}).to_string();
    let opts: RenderOptions = serde_json::from_value(
        json!({"pageId":"p","width":1024,"height":768,"transparent":true,
        "rasterProfile":"figmaSoftware","view":{"x":0.375,"y":-0.625,"zoom":1}}),
    )
    .unwrap();
    let mut engine = Engine::new();
    engine.load_document(&document).unwrap();
    let scene = engine.compile_gpu(&opts).unwrap();
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    let result = gpu
        .render(&scene)
        .expect("valid large image must fit the existing GPU surface budget");
    println!(
        "large image adapter={:?} bytes={} render_ms={} submissions={}",
        gpu.description(),
        result.peak_texture_bytes,
        result.render_ms,
        result.submissions
    );
    assert_eq!(result.rgba.len(), 1024 * 768 * 4);
    assert!(result.peak_texture_bytes <= 256 * 1024 * 1024);
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn native_parametric_arcs_and_corners_match_cpu_exactly() {
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    for profile in ["figma", "figmaSoftware"] {
        for kind in ["ellipse", "polygon", "star"] {
            let mut n = rect("n", 8.125, 6.375, "#426bdf");
            n["kind"] = json!(kind);
            n["transform"] = json!([1., 0.125, -0.25, 1., 20.125, 6.375]);
            if kind == "ellipse" {
                n["arc"] =
                    json!({"startAngle":0.125,"sweepAngle":-4.71238898038469,"innerRadius":0.625});
            } else {
                n["cornerRadius"] = json!(3.125);
            }
            let document = json!({"schemaVersion":7,"id":"d","name":"Native shape GPU parity","pages":[{"id":"p","name":"p","children":["n"],"background":"#ffffff"}],"nodes":{"n":n}}).to_string();
            let mut opts = options();
            opts.raster_profile = serde_json::from_value(json!(profile)).unwrap();
            assert_parity(&mut gpu, &document, &opts);
        }
    }
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn native_stroke_markers_match_cpu_exactly() {
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    for profile in ["figma", "figmaSoftware"] {
        for marker in ["arrow", "triangle", "circle", "diamond", "square", "bar"] {
            let document=json!({"schemaVersion":8,"id":"d","name":"Marker GPU parity","pages":[{"id":"p","name":"p","children":["n"],"background":"#ffffff"}],"nodes":{"n":{"id":"n","kind":"line","width":48,"height":20,"transform":[1,0.125,-0.25,1,20.125,20.375],"strokes":[{"paint":{"kind":"solid","color":"#426bdf"},"width":3.5,"startMarker":marker,"endMarker":marker,"dash":"5 3"}]}}}).to_string();
            let mut opts = options();
            opts.raster_profile = serde_json::from_value(json!(profile)).unwrap();
            assert_parity(&mut gpu, &document, &opts);
        }
    }
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn dirty_tile_cache_matches_full_render_byte_for_byte() {
    use futureox_design_gpu::TileCache;
    // Fixture: solid grid + shadow + translucent group + background-blur +
    // blend + mask, so the per-tile influence rules (effect bleed, backdrop
    // capture, mask consumers) all participate in the cache keys.
    let mut nodes = serde_json::Map::new();
    let mut roots = Vec::new();
    for i in 0..40 {
        let id = format!("n{i}");
        let mut n = rect(
            &id,
            (i % 8) as f64 * 64.125 + 8.125,
            (i / 8) as f64 * 58.375 + 6.25,
            if i % 2 == 0 { "#4477dd" } else { "#cc8844" },
        );
        if i % 5 == 0 {
            n["effects"] = json!([{"kind":"shadow","color":"#000000","radius":6.5,"x":2.25,"y":3.5,"opacity":0.5}]);
        }
        nodes.insert(id.clone(), n);
        roots.push(id);
    }
    let mut blurred = rect("surface", 150.25, 120.5, "#ffffff");
    blurred["width"] = json!(180);
    blurred["height"] = json!(120);
    blurred["fills"][0]["opacity"] = json!(0.15);
    blurred["effects"] = json!([{"kind":"background-blur","color":"#000000","radius":5.25,"x":0,"y":0,"opacity":0.4}]);
    let mut mask = rect("mask", 96.375, 88.125, "#ffffff");
    mask["mask"] = json!(true);
    mask["opacity"] = json!(0.75);
    let group = json!({"id":"g","kind":"group","width":260,"height":200,
        "transform":[1,0,0,1,96,88],"children":["mask","surface","blend"],"opacity":0.9});
    let mut blend_child = rect("blend", 176.625, 148.875, "#3355ff");
    blend_child["blend"] = json!("multiply");
    blend_child["opacity"] = json!(0.625);
    for (id, node) in [("mask", mask), ("surface", blurred), ("blend", blend_child)] {
        nodes.insert(id.into(), node);
    }
    nodes.insert("g".into(), group);
    roots.push("g".into());
    let document = doc(Value::Object(nodes), json!(roots));

    let mut engine = Engine::new();
    engine.load_document(&document).unwrap();
    let mut o = options();
    o.width = 1024;
    o.height = 768;
    o.raster_profile = serde_json::from_value(json!("figmaSubpixel")).unwrap();
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    let mut cache = TileCache::new();

    // Cold frame: full composition seeds the cache.
    let warm = cache.render(&mut gpu, &mut engine, &o).unwrap();
    let reference = gpu.render(&engine.compile_gpu(&o).unwrap()).unwrap();
    assert_eq!(
        warm.rgba, reference.rgba,
        "cold cache frame must equal full render"
    );
    assert_eq!(cache.stats.full_frames, 1);

    // Edit sequence: every frame flips between the full path and the cached
    // (dirty-region) path and must land on identical bytes. Coverage: move,
    // fill, resize, visibility, reorder-ish replacement, insert, remove.
    let mut node = serde_json::from_value::<futureox_design_kernel::scene::Node>(rect(
        "n0", 8.125, 6.25, "#4477dd",
    ))
    .unwrap();
    let mut edits = 0;
    #[allow(clippy::explicit_counter_loop)]
    for step in 0..8 {
        let patch = match step % 4 {
            0 => {
                node.transform.0[4] += 19.875;
                node.transform.0[5] += 7.25;
                Some(node.clone())
            }
            1 => {
                node.fills[0].color = if edits % 2 == 0 {
                    "#dd4477".into()
                } else {
                    "#4477dd".into()
                };
                Some(node.clone())
            }
            2 => {
                node.width = 37.5 + (step as f64) * 2.125;
                node.height = 31.75 + (step as f64) * 1.5;
                Some(node.clone())
            }
            _ => None,
        };
        if step == 6 {
            // Insert a fresh node inside the grid area.
            let fresh = rect("fresh", 300.625, 200.375, "#22aa66");
            let mut doc_value: Value = serde_json::from_str(&document).unwrap();
            doc_value["nodes"]["fresh"] = fresh;
            doc_value["pages"][0]["children"]
                .as_array_mut()
                .unwrap()
                .push(json!("fresh"));
            engine
                .load_document(&serde_json::to_string(&doc_value).unwrap())
                .unwrap();
        } else if step == 7 {
            // Remove it again by restoring the original document.
            engine.load_document(&document).unwrap();
        } else if let Some(node) = patch {
            let patch = futureox_design_kernel::editing::DocumentPatch {
                nodes: std::collections::BTreeMap::from([("n0".to_string(), Some(node))]),
                fields: Default::default(),
            };
            engine.apply_document_patch(&patch).unwrap();
        }
        edits += 1;

        let full = gpu.render(&engine.compile_gpu(&o).unwrap()).unwrap();
        let cached = cache.render(&mut gpu, &mut engine, &o).unwrap();
        let differing = full
            .rgba
            .iter()
            .zip(&cached.rgba)
            .filter(|(a, b)| a != b)
            .count();
        assert_eq!(
            differing, 0,
            "step {step}: full-frame and dirty-region paths diverge ({differing} bytes)"
        );
        eprintln!(
            "step {step}: tiles cached={} rendered={} draw_calls={} render_ms={:.2}",
            cache.stats.tiles_cached,
            cache.stats.tiles_rendered,
            cached.draw_calls,
            cached.render_ms
        );
        if step < 6 {
            assert!(
                cache.stats.tiles_rendered < cache.stats.tiles_total,
                "a small edit must not repaint every tile"
            );
            assert!(
                cache.stats.tiles_cached > 0,
                "unchanged tiles must be reused"
            );
        }
    }

    // Viewport change: the cache must honestly invalidate everything, and the
    // refilled frame must still match a fresh full render byte for byte.
    let mut panned = o.clone();
    panned.view.x = -64.5;
    panned.view.y = -32.25;
    let cached = cache.render(&mut gpu, &mut engine, &panned).unwrap();
    let full = gpu.render(&engine.compile_gpu(&panned).unwrap()).unwrap();
    assert_eq!(
        cached.rgba, full.rgba,
        "panned refill must match full render"
    );
    assert!(
        cache.stats.tiles_rendered == cache.stats.tiles_total,
        "viewport change must invalidate every tile"
    );
    // After the pan, a content edit still reuses tiles outside the edit.
    let cached = cache.render(&mut gpu, &mut engine, &panned).unwrap();
    let full = gpu.render(&engine.compile_gpu(&panned).unwrap()).unwrap();
    assert_eq!(cached.rgba, full.rgba);
    assert!(cache.stats.tiles_cached == cache.stats.tiles_total);
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn gradient_blur_gpu_composite_matches_the_f64_reference() {
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    eprintln!("adapter {:?}", gpu.description());
    for managed in [false, true] {
        let mut n = rect(
            "a",
            20.125,
            16.375,
            if managed {
                "color(srgb-linear 3 0.25 0.5)"
            } else {
                "#ff4400"
            },
        );
        n["effects"] = json!([
            {"kind":"blur","color":"#000000","radius":2,"gradientBlur":{"start":[0,0],"end":[37.5,31.75],"startCount":0,"endCount":3,"smooth":true}},
            {"kind":"blur","color":"#000000","radius":1,"gradientBlur":{"start":[0,0],"end":[0,31.75],"startCount":2,"endCount":0,"smooth":false}}]);
        let mut d: Value = serde_json::from_str(&doc(json!({"a":n}), json!(["a"]))).unwrap();
        d["schemaVersion"] = json!(9);
        if managed {
            d["colorManagement"] =
                json!({"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000});
        }
        let mut engine = Engine::new();
        engine.load_document(&d.to_string()).unwrap();
        let o = options();
        let cpu = engine.render(&o).unwrap();
        let linear = if managed {
            engine.render_linear(&o).unwrap()
        } else {
            Vec::new()
        };
        let result = gpu.render(&engine.compile_gpu(&o).unwrap()).unwrap();
        eprintln!(
            "gradient blur managed={managed} render_ms={}",
            result.render_ms
        );
        // SDR: the byte-quantized shader output must land on the same bytes
        // as the f64 reference composite.
        assert_eq!(result.rgba, cpu, "gradient bytes, managed={managed}");
        if managed {
            // Exact hybrid composition must keep the reference float words.
            let values = result.linear.unwrap();
            let mut max = 0_f32;
            let mut different = 0;
            for (a, b) in linear.iter().flat_map(|p| p.0).zip(&values) {
                max = max.max((a - b).abs());
                different += usize::from(a.to_bits() != b.to_bits());
            }
            eprintln!(
                "gradient blur managed: differentFloatWords={different} max_absolute_error={max}"
            );
            assert_eq!(
                different, 0,
                "managed gradient blur must preserve every float bit; max={max}"
            );
        }
        d["nodes"]["a"]["effects"][0]
            .as_object_mut()
            .unwrap()
            .remove("gradientBlur");
        d["nodes"]["a"]["effects"][1]
            .as_object_mut()
            .unwrap()
            .remove("gradientBlur");
        engine.load_document(&d.to_string()).unwrap();
        assert_ne!(
            engine.render(&o).unwrap(),
            cpu,
            "gradient parameters must affect the image"
        );
    }
}
