use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::{Value, json};

fn rectangle(id: &str, color: &str) -> Value {
    json!({"id":id,"kind":"rectangle","transform":[1,0,0,1,8.125,8.125],"width":60.4,"height":60.6,"fills":[{"kind":"solid","color":color}]})
}
fn document(nodes: Value, roots: Value) -> String {
    json!({"schemaVersion":1,"id":"d","name":"coherence","pages":[{"id":"p","name":"p","children":roots,"background":"#ffffff"}],"nodes":nodes}).to_string()
}

#[test]
fn foreground_effects_do_not_reintroduce_hidden_color_at_shared_edges() {
    for effects in [
        json!([{"kind":"blur","radius":4,"color":"#000000"}]),
        json!([{"kind":"shadow","radius":4,"x":1.25,"y":4,"opacity":0.25,"color":"#000000"}]),
        json!([{"kind":"inner-shadow","radius":4,"x":1.25,"y":4,"opacity":0.5,"color":"#000000"}]),
        json!([{"kind":"shadow","radius":4,"y":4,"opacity":0.25,"color":"#000000"},{"kind":"blur","radius":2.5,"color":"#000000"}]),
    ] {
        let group = json!({"id":"g","kind":"group","width":128,"height":128,"children":["a","b"],"effects":effects});
        let behind = document(
            json!({"g":group.clone(),"a":rectangle("a","#000000"),"b":rectangle("b","#4477dd")}),
            json!(["g"]),
        );
        let same = document(
            json!({"g":group,"a":rectangle("a","#4477dd"),"b":rectangle("b","#4477dd")}),
            json!(["g"]),
        );
        assert!(
            render(&behind) == render(&same),
            "hidden black leaked through {effects}"
        );
    }
}
fn options() -> RenderOptions {
    serde_json::from_value(json!({"pageId":"p","width":128,"height":128,"view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figma","transparent":true})).unwrap()
}

#[test]
fn gpu_culling_preserves_the_existence_of_an_empty_visible_mask() {
    for profile in ["analytic", "figma"] {
        for visible in [true, false] {
            let mut mask = rectangle("mask", "#ffffff");
            mask["mask"] = json!(true);
            mask["visible"] = json!(visible);
            mask["transform"] = json!([1, 0, 0, 1, 1000, 1000]);
            let d = document(
                json!({"g":{"id":"g","kind":"group","width":128,"height":128,"children":["mask","a"]},"mask":mask,"a":rectangle("a","#ff0000")}),
                json!(["g"]),
            );
            let mut o = options();
            o.raster_profile = serde_json::from_value(json!(profile)).unwrap();
            let mut engine = Engine::new();
            engine.load_document(&d).unwrap();
            let gpu = serde_json::to_value(engine.compile_gpu(&o).unwrap()).unwrap();
            assert!(gpu["nodes"].get("mask").is_none());
            assert_eq!(
                gpu["nodes"]["g"]["maskId"],
                if visible { json!("mask") } else { Value::Null }
            );
            let rgba = engine.render(&o).unwrap();
            assert_eq!(rgba.chunks_exact(4).any(|p| p[3] != 0), !visible);
        }
    }
}
fn render(doc: &str) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(doc).unwrap();
    engine.render(&options()).unwrap()
}

#[test]
fn backdrop_blur_does_not_reveal_an_occluded_color_or_increase_uniform_alpha() {
    let lens = json!({"id":"lens","kind":"rectangle","width":128,"height":128,"effects":[{"kind":"background-blur","radius":4,"color":"#000000"}]});
    let black = document(
        json!({"a":rectangle("a","#000000"),"b":rectangle("b","#4477dd"),"lens":lens.clone()}),
        json!(["a", "b", "lens"]),
    );
    let blue = document(
        json!({"a":rectangle("a","#4477dd"),"b":rectangle("b","#4477dd"),"lens":lens}),
        json!(["a", "b", "lens"]),
    );
    assert!(
        render(&black) == render(&blue),
        "backdrop filter exposed the hidden black edge"
    );
    let d = document(
        json!({"a":{"id":"a","kind":"rectangle","transform":[1,0,0,1,-30,-30],"width":188,"height":188,"fills":[{"kind":"solid","color":"#4477dd","opacity":0.5}]},"lens":{"id":"lens","kind":"rectangle","width":128,"height":128,"effects":[{"kind":"background-blur","radius":4,"color":"#000000"}]}}),
        json!(["a", "lens"]),
    );
    assert_eq!(
        render(&d)[(64 * 128 + 64) * 4 + 3],
        128,
        "filtered backdrop was composited over itself"
    );
}

#[test]
fn alpha_mask_is_applied_once_to_the_composited_children() {
    let mut mask = rectangle("mask", "#000000");
    mask["mask"] = json!(true);
    mask["opacity"] = json!(0.5);
    let d = document(
        json!({"g":{"id":"g","kind":"group","width":128,"height":128,"children":["mask","a","b"]},"mask":mask,"a":rectangle("a","#000000"),"b":rectangle("b","#4477dd")}),
        json!(["g"]),
    );
    let out = render(&d);
    assert_eq!(
        out[(32 * 128 + 32) * 4 + 3],
        128,
        "mask opacity was applied to each child instead of the aggregate"
    );
    assert_eq!(out[(8 * 128 + 8) * 4 + 3], 96);
}

#[test]
fn backdrop_reads_only_preceding_siblings_and_respects_isolated_groups() {
    let background = json!({"id":"bg","kind":"rectangle","width":128,"height":128,"fills":[{"kind":"solid","color":"#4477dd"}]});
    let lens = json!({"id":"lens","kind":"rectangle","width":128,"height":128,"effects":[{"kind":"background-blur","radius":4,"color":"#000000"}]});
    let front = json!({"id":"front","kind":"rectangle","transform":[1,0,0,1,40,40],"width":24,"height":24,"fills":[{"kind":"solid","color":"#dd4477"}]});
    let d = document(
        json!({"bg":background.clone(),"lens":lens.clone(),"front":front}),
        json!(["bg", "lens", "front"]),
    );
    let out = render(&d);
    assert_eq!(
        &out[(40 * 128 + 40) * 4..(40 * 128 + 40) * 4 + 4],
        &[221, 68, 119, 255]
    );
    let isolated = document(
        json!({"bg":background,"g":{"id":"g","kind":"group","width":128,"height":128,"blend":"normal","children":["lens"]},"lens":lens}),
        json!(["bg", "g"]),
    );
    assert_eq!(
        &render(&isolated)[(64 * 128 + 64) * 4..(64 * 128 + 64) * 4 + 4],
        &[68, 119, 221, 255]
    );
}

#[test]
fn backdrop_zero_radius_is_identity() {
    let a = rectangle("a", "#4477dd");
    let b = rectangle("b", "#dd4477");
    let base = document(json!({"a":a.clone(),"b":b.clone()}), json!(["a", "b"]));
    let lens = json!({"id":"lens","kind":"rectangle","width":128,"height":128,"effects":[{"kind":"background-blur","radius":0,"color":"#000000"}]});
    assert!(
        render(&base)
            == render(&document(
                json!({"a":a,"b":b,"lens":lens}),
                json!(["a", "b", "lens"])
            ))
    );
}

#[test]
fn backdrop_capture_preserves_fractional_phase_and_tight_curve_bounds() {
    use futureox_design_kernel::{
        bounds::path_bounds,
        coverage::backdrop_box,
        math::{Point, Rect, Transform},
        path::{Command, Path},
    };
    let curve = Path {
        commands: vec![
            Command::Move(Point::new(8.125, 8.125)),
            Command::Cubic(
                Point::new(8.125, 108.125),
                Point::new(108.125, 108.125),
                Point::new(108.125, 8.125),
            ),
            Command::Close,
        ],
    };
    assert_eq!(
        backdrop_box(
            path_bounds(&curve, Transform::default()),
            Rect::new(0, 0, 128, 128)
        ),
        [8.125, 8.125, 100., 75.]
    );
    let clipped = backdrop_box(
        path_bounds(&curve, Transform::default()),
        Rect::new(32, 32, 40, 40),
    );
    assert_eq!(clipped, [31.125, 31.125, 41., 41.]);
}

#[test]
fn opaque_foreground_fully_occludes_a_coincident_shape_including_partial_pixels() {
    let behind = document(
        json!({"a":rectangle("a","#000000"),"b":rectangle("b","#4477dd")}),
        json!(["a", "b"]),
    );
    let same = document(
        json!({"a":rectangle("a","#4477dd"),"b":rectangle("b","#4477dd")}),
        json!(["a", "b"]),
    );
    assert!(
        render(&behind) == render(&same),
        "a fully hidden black shape must not darken the blue edge"
    );
}

#[test]
fn repeated_opaque_fills_do_not_increase_geometric_coverage() {
    let mut n = rectangle("a", "#000000");
    n["fills"] = json!([{"kind":"solid","color":"#000000"},{"kind":"solid","color":"#4477dd"}]);
    let two = render(&document(json!({"a":n.clone()}), json!(["a"])));
    n["fills"]
        .as_array_mut()
        .unwrap()
        .push(json!({"kind":"solid","color":"#4477dd"}));
    assert!(two == render(&document(json!({"a":n}), json!(["a"]))));
}

#[test]
fn a_coincident_vector_mask_preserves_coverage_instead_of_squaring_it() {
    let mut mask = rectangle("mask", "#000000");
    mask["mask"] = json!(true);
    let masked = document(
        json!({"g":{"id":"g","kind":"group","width":128,"height":128,"children":["mask","a"]},"mask":mask,"a":rectangle("a","#000000")}),
        json!(["g"]),
    );
    let repeated = document(
        json!({"a":rectangle("a","#000000"),"b":rectangle("b","#000000")}),
        json!(["a", "b"]),
    );
    let output = render(&masked);
    assert!(output == render(&repeated));
    assert_eq!(output[(8 * 128 + 8) * 4 + 3], 191);
    assert_eq!(output[(10 * 128 + 8) * 4 + 3], 223);
}

#[test]
fn group_opacity_is_applied_once_after_child_composition() {
    let d = document(
        json!({"g":{"id":"g","kind":"group","width":128,"height":128,"opacity":0.5,"children":["a","b"]},"a":rectangle("a","#000000"),"b":rectangle("b","#4477dd")}),
        json!(["g"]),
    );
    let output = render(&d);
    assert_eq!(output[(20 * 128 + 20) * 4 + 3], 128);
    assert_eq!(output[(8 * 128 + 8) * 4 + 3], 96);
}

#[test]
fn gpu_replays_only_interacting_vectors_and_emits_stroke_intersections() {
    let mut shape = rectangle("a", "#4477dd");
    shape["strokes"] =
        json!([{"width":3,"align":"inside","paint":{"kind":"solid","color":"#000000"}}]);
    let mut engine = Engine::new();
    engine
        .load_document(&document(json!({"a":shape}), json!(["a"])))
        .unwrap();
    let scene = engine.compile_gpu(&options()).unwrap();
    assert!(scene.coherent_samples);
    assert!(scene.nodes["a"].strokes[0].path.area.is_some());
    let mut shape = rectangle("a", "#000000");
    shape["effects"] = json!([{"kind":"blur","radius":4,"color":"#000000"}]);
    engine
        .load_document(&document(
            json!({"a":shape,"b":rectangle("b","#000000")}),
            json!(["a", "b"]),
        ))
        .unwrap();
    assert!(engine.compile_gpu(&options()).unwrap().coherent_samples);
}

#[test]
fn zero_filters_and_coincident_unblurred_shadow_preserve_coverage() {
    let nodes = json!({"g":{"id":"g","kind":"group","width":128,"height":128,"children":["a","b"]},"a":rectangle("a","#000000"),"b":rectangle("b","#4477dd")});
    let baseline = render(&document(nodes.clone(), json!(["g"])));
    for kind in ["blur", "shadow", "inner-shadow"] {
        let mut filtered = nodes.clone();
        filtered["g"]["effects"] = json!([{"kind":kind,"radius":0,"x":0,"y":0,"spread":0,"color":"#000000","opacity":0.5}]);
        assert!(
            baseline == render(&document(filtered, json!(["g"]))),
            "zero {kind}"
        );
    }
}

#[test]
fn effect_sources_are_filtered_before_ancestor_clipping() {
    let nodes = json!({"frame":{"id":"frame","kind":"frame","transform":[1,0,0,1,32,32],"width":64,"height":64,"clip":true,"children":["a"]},"a":{"id":"a","kind":"rectangle","transform":[1,0,0,1,-32,-32],"width":128,"height":128,"fills":[{"kind":"solid","color":"#000000"}],"effects":[{"kind":"blur","radius":4,"color":"#000000"}]}});
    let output = render(&document(nodes, json!(["frame"])));
    assert_eq!(
        output[(32 * 128 + 32) * 4 + 3],
        255,
        "ancestor edge was blurred into the source"
    );
    assert_eq!(
        output[(31 * 128 + 32) * 4 + 3],
        0,
        "blur escaped ancestor clip"
    );
}

#[test]
fn nested_effects_are_cached_once_per_frame_and_invalidated_on_edit() {
    let mut nodes = json!({"g":{"id":"g","kind":"group","width":128,"height":128,"opacity":0.5,"children":["h"],"effects":[{"kind":"shadow","radius":3,"y":2,"color":"#000000"}]},"h":{"id":"h","kind":"group","width":128,"height":128,"children":["a","b"],"effects":[{"kind":"blur","radius":2,"color":"#000000"},{"kind":"inner-shadow","radius":2,"x":1,"color":"#000000","opacity":0.2}]},"a":rectangle("a","#000000"),"b":rectangle("b","#4477dd")});
    let mut engine = Engine::new();
    engine
        .load_document(&document(nodes.clone(), json!(["g"])))
        .unwrap();
    let old = engine.render(&options()).unwrap();
    assert_eq!(engine.stats().effect_layers, 2);
    nodes["b"]["fills"][0]["color"] = json!("#dd4477");
    let edited = document(nodes, json!(["g"]));
    engine.load_document(&edited).unwrap();
    let current = engine.render(&options()).unwrap();
    assert_eq!(engine.stats().effect_layers, 2);
    assert!(current != old);
    assert!(current == render(&edited));
}

#[test]
fn backdrop_filters_request_synchronized_destinations() {
    let mut a = rectangle("a", "#4477dd");
    a["effects"] = json!([{"kind":"background-blur","radius":4,"color":"#000000"}]);
    let mut engine = Engine::new();
    engine
        .load_document(&document(
            json!({"a":a,"b":rectangle("b","#000000")}),
            json!(["a", "b"]),
        ))
        .unwrap();
    let scene = engine.compile_gpu(&options()).unwrap();
    assert!(scene.coherent_samples && scene.backdrop_samples);
}

#[test]
fn a_zero_opacity_mask_still_hides_contents_without_running_its_backdrop_filter() {
    let mut mask = rectangle("mask", "#000000");
    mask["mask"] = json!(true);
    mask["opacity"] = json!(0);
    mask["effects"] = json!([{"kind":"background-blur","radius":4,"color":"#000000"}]);
    let d = document(
        json!({"g":{"id":"g","kind":"group","width":128,"height":128,"children":["mask","a","b"]},"mask":mask,"a":rectangle("a","#000000"),"b":rectangle("b","#4477dd")}),
        json!(["g"]),
    );
    assert!(render(&d).iter().all(|v| *v == 0));
}

#[test]
fn coherent_vector_tiles_keep_phase_and_accumulate_work_statistics() {
    let mut a = rectangle("a", "#000000");
    let mut b = rectangle("b", "#4477dd");
    a["transform"] = json!([1, 0, 0, 1, 500.125, 8.125]);
    b["transform"] = a["transform"].clone();
    let mut engine = Engine::new();
    engine
        .load_document(&document(json!({"a":a,"b":b}), json!(["a", "b"])))
        .unwrap();
    let mut o = options();
    o.width = 600;
    o.height = 90;
    let tiled = engine.render(&o).unwrap();
    assert_eq!(engine.stats().nodes, 4);
    let mut left = o.clone();
    left.width = 300;
    let mut right = left.clone();
    right.view.x = -300.;
    let l = engine.render(&left).unwrap();
    let r = engine.render(&right).unwrap();
    for y in 0..90 {
        assert_eq!(
            &tiled[y * 2400..y * 2400 + 1200],
            &l[y * 1200..(y + 1) * 1200]
        );
        assert_eq!(
            &tiled[y * 2400 + 1200..(y + 1) * 2400],
            &r[y * 1200..(y + 1) * 1200]
        );
    }
}

#[test]
fn complex_stroke_intervals_match_every_cpu_sample_without_other_rows() {
    let shape = json!({"id":"a","kind":"ellipse","transform":[1,0.14,0.25,1,40,45],"width":150,"height":68,"fills":[{"kind":"solid","color":"#4477dd"}],"strokes":[{"width":4,"align":"outside","paint":{"kind":"solid","color":"#000000"}}]});
    let mut engine = Engine::new();
    engine
        .load_document(&document(json!({"a":shape}), json!(["a"])))
        .unwrap();
    let mut o = options();
    o.width = 256;
    o.height = 192;
    let scene = engine.compile_gpu(&o).unwrap();
    let path = &scene.nodes["a"].strokes[0].path;
    let node: futureox_design_kernel::scene::Node = serde_json::from_value(shape).unwrap();
    let matrix = scene.nodes["a"].matrix;
    let scale = matrix.max_scale().max(1e-6);
    let (_, center) = node.paths().unwrap();
    let lines = center
        .flatten(
            futureox_design_kernel::math::Transform::default(),
            (0.125 / scale).min(1.),
        )
        .unwrap();
    let mut outline =
        futureox_design_kernel::stroke::expand(&lines, &node.strokes[0], 0.125 / scale, 0.)
            .unwrap();
    for contour in &mut outline {
        for point in &mut contour.points {
            *point = matrix.point(*point);
        }
    }
    let area = path.area.as_ref().unwrap();
    let data = &scene.curves[area.first as usize * 4..(area.first + area.count) as usize * 4];
    assert_eq!(data[0], 3.);
    let remainder = |at: usize| {
        f64::from_bits((0..4).fold(0_u64, |v, i| v | ((data[at + i] as u64) << (16 * i))))
    };
    for sample in 0..4 {
        let expected = futureox_design_kernel::raster::rasterize_sample_linear(
            &outline,
            path.rect,
            false,
            Some(sample),
        );
        let sx = futureox_design_kernel::fidelity::SAMPLE_OFFSETS[sample].0;
        for y in 0..path.rect.h {
            for x in 0..path.rect.w {
                let row = 4 + ((y * 4 + sample as u32) * 4) as usize;
                let start = data[row] as usize * 4;
                let count = data[row + 1] as usize;
                assert!(start + count * 12 <= data.len());
                let point = f64::from(path.rect.x) + f64::from(x) + sx;
                let inside = (0..count).any(|i| {
                    let base = start + i * 12;
                    let left = f64::from(path.rect.x)
                        + f64::from(data[base] + data[base + 2])
                        + remainder(base + 4);
                    let right = f64::from(path.rect.x)
                        + f64::from(data[base + 1] + data[base + 3])
                        + remainder(base + 8);
                    point >= left && point < right
                });
                assert_eq!(
                    f32::from(inside),
                    expected.at(path.rect.x + x as i32, path.rect.y + y as i32),
                    "sample {sample}, ({x},{y})"
                );
            }
        }
    }
}
