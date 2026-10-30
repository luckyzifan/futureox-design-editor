use futureox_design_kernel::{
    Engine, RenderOptions,
    font::Fonts,
    layout::{self, SizeMode},
    scene::{Document, Node},
};
use serde_json::json;

fn font_bytes() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
    ))
    .unwrap()
}
fn fonts() -> Fonts {
    let mut f = Fonts::new();
    f.load(&font_bytes()).unwrap();
    f
}
fn text() -> Node {
    serde_json::from_value(json!({
        "id":"t","kind":"text","text":"中文中文中文","fontSize":20,"width":500,"height":30,
        "textStyle":{"wrap":true,"paragraphIndent":25,"direction":"ltr"},
        "sizing":{"width":"hug","height":"hug","maxWidth":65},
        "fills":[{"kind":"solid","color":"#112233"}]
    }))
    .unwrap()
}
fn document(n: &Node) -> Document {
    serde_json::from_value(json!({"schemaVersion":4,"id":"d","name":"limited text",
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":["t"]}],
        "nodes":{"t":n}}))
    .unwrap()
}
fn close(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-9, "{actual} != {expected}");
}
fn solve(n: &Node, f: &Fonts) -> Node {
    let mut d = document(n);
    d.validate().unwrap();
    layout::resolve(&mut d, f).unwrap();
    let once = serde_json::to_value(&d).unwrap();
    layout::resolve(&mut d, f).unwrap();
    assert_eq!(serde_json::to_value(&d).unwrap(), once);
    d.nodes.remove("t").unwrap()
}
#[test]
fn clamped_hug_height_matches_independent_cjk_line_count() {
    let f = fonts();
    for initial_width in [0.01, 65., 500.] {
        let mut n = text();
        n.width = initial_width;
        let solved = solve(&n, &f);
        // Pinned NotoSansSC CJK advance=20: first line fits (65-25)/20=2,
        // continuation fits floor(65/20)=3, then one character remains.
        close(solved.width, 65.);
        close(solved.height, 3. * 20. * 1.35);
        let actual = f.node_layout(&solved, Some(solved.width)).unwrap();
        close(actual.height, solved.height);
        assert_eq!(
            actual
                .lines
                .iter()
                .map(|l| (l.start, l.end))
                .collect::<Vec<_>>(),
            [(0, 2), (2, 5), (5, 6)]
        );
        for (i, x) in [(0, 25.), (2, 0.), (5, 0.)] {
            close(actual.glyphs[i].x, x);
        }
    }
}
#[test]
fn constrained_hug_preserves_spacing_paragraphs_rich_runs_and_negative_indent() {
    let f = fonts();
    for value in [
        "中文中文中文",
        "中文\n\n中文中文\r\n",
        "e\u{301} 中文AB中文",
    ] {
        for indent in [-12.375, 0., 12.375, 80.] {
            let mut n = text();
            n.text = value.into();
            n.text_style.as_mut().unwrap().paragraph_indent = indent;
            n.text_style.as_mut().unwrap().paragraph_spacing = 7.25;
            n.text_style.as_mut().unwrap().letter_spacing = 0.375;
            n.text_runs = serde_json::from_value(json!([
                {"start":0,"end":2,"fontSize":28,"weight":600,"color":"#cc2244","underline":true}
            ]))
            .unwrap();
            let solved = solve(&n, &f);
            let fixed = f.node_layout(&n, Some(65.)).unwrap();
            close(solved.height, fixed.height);
            close(solved.width, 65.);
            let actual = f.node_layout(&solved, Some(solved.width)).unwrap();
            assert_eq!(actual.path.svg_data(), fixed.path.svg_data());
            assert_eq!(
                serde_json::to_value(actual.glyphs).unwrap(),
                serde_json::to_value(fixed.glyphs).unwrap()
            );
        }
    }
}
#[test]
fn width_and_height_limits_preserve_correct_non_reflow_cases() {
    let f = fonts();
    let mut n = text();
    n.text_style.as_mut().unwrap().wrap = false;
    let no_wrap = solve(&n, &f);
    close(no_wrap.width, 65.);
    close(no_wrap.height, 27.);
    n.text_style.as_mut().unwrap().wrap = true;
    n.sizing.as_mut().unwrap().height = SizeMode::Fixed;
    close(solve(&n, &f).height, 30.);
    n.sizing.as_mut().unwrap().height = SizeMode::Hug;
    n.sizing.as_mut().unwrap().max_height = 40.;
    close(solve(&n, &f).height, 40.);
    n.sizing.as_mut().unwrap().max_height = 200.;
    n.sizing.as_mut().unwrap().min_height = 100.;
    close(solve(&n, &f).height, 100.);
    n.sizing.as_mut().unwrap().min_height = 0.01;
    n.sizing.as_mut().unwrap().max_width = 200.;
    close(solve(&n, &f).width, 145.);
    close(solve(&n, &f).height, 27.);
    n.sizing.as_mut().unwrap().min_width = 180.;
    close(solve(&n, &f).width, 180.);
    close(solve(&n, &f).height, 27.);
    n.text.clear();
    close(solve(&n, &f).width, 180.);
    close(solve(&n, &f).height, 27.);
}
#[test]
fn max_width_exact_fit_keeps_fractional_hug_wrap_boundary() {
    let f = fonts();
    for spacing in [-1.25, 0., 0.375] {
        for deficit in [0., 1e-9] {
            let mut n = text();
            n.text = "中文".into();
            n.font_size = 12.;
            n.text_style.as_mut().unwrap().paragraph_indent = 20.3;
            n.text_style.as_mut().unwrap().letter_spacing = spacing;
            n.sizing.as_mut().unwrap().max_width = 44.3 + spacing - deficit;
            let solved = solve(&n, &f);
            close(solved.width, 44.3 + spacing - deficit);
            close(
                solved.height,
                12. * 1.35 * if deficit == 0. { 1. } else { 2. },
            );
        }
    }
}
fn nested(n: &Node, fill_parent: bool) -> Document {
    let mut d:Document=serde_json::from_value(json!({"schemaVersion":4,"id":"d","name":"nested limits",
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":["outer"]}],
        "nodes":{
            "outer":{"id":"outer","kind":"frame","width":120,"height":300,"children":["inner"],
                "layout":{"mode":"vertical","padding":[10,10,10,10]},"sizing":{"height":"hug"}},
            "inner":{"id":"inner","kind":"frame","width":100,"height":300,"children":["t","s"],"clip":true,
                "layout":{"mode":"vertical","padding":[3,5,7,11],"gap":6},"sizing":{"width":"hug","height":"hug"}},
            "t":n,"s":{"id":"s","kind":"rectangle","width":9,"height":8,
                "fills":[{"kind":"solid","color":"#aa3311"}]}
        }})).unwrap();
    if fill_parent {
        d.nodes
            .get_mut("inner")
            .unwrap()
            .sizing
            .as_mut()
            .unwrap()
            .width = SizeMode::Fill;
    }
    d
}
#[test]
fn constrained_text_updates_nested_hug_fill_and_sibling_without_oscillation() {
    let f = fonts();
    for fill in [false, true] {
        let mut d = nested(&text(), fill);
        d.validate().unwrap();
        layout::resolve(&mut d, &f).unwrap();
        close(d.nodes["t"].height, 81.);
        close(d.nodes["inner"].height, 105.);
        close(d.nodes["outer"].height, 125.);
        close(d.nodes["inner"].width, if fill { 100. } else { 81. });
        close(d.nodes["s"].transform.0[5], 90.);
        let once = serde_json::to_value(&d).unwrap();
        for _ in 0..3 {
            layout::resolve(&mut d, &f).unwrap();
            assert_eq!(serde_json::to_value(&d).unwrap(), once);
        }
    }
}
#[test]
fn clipped_hug_cpu_pixels_equal_independent_fixed_geometry() {
    let n = text();
    let mut fixed = n.clone();
    fixed.width = 65.;
    fixed.height = 81.;
    fixed.sizing = None;
    for fill in [false, true] {
        let mut actual = Engine::new();
        let mut reference = Engine::new();
        for engine in [&mut actual, &mut reference] {
            engine.load_font(&font_bytes()).unwrap();
        }
        actual
            .load_document(&serde_json::to_string(&nested(&n, fill)).unwrap())
            .unwrap();
        reference
            .load_document(&serde_json::to_string(&nested(&fixed, fill)).unwrap())
            .unwrap();
        for zoom in [0.25, 1., 1.375, 4., 1.] {
            let options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":500,"height":600,
                "view":{"x":0.125,"y":0.375,"zoom":zoom},"transparent":true,"rasterProfile":"analytic"})).unwrap();
            let expected = reference.render(&options).unwrap();
            assert!(expected.chunks_exact(4).any(|p| p[3] > 0));
            assert!(
                actual.render(&options).unwrap() == expected,
                "fill={fill},zoom={zoom}"
            );
        }
    }
}

#[test]
fn existing_alignment_flags_keep_fixed_width_geometry() {
    let f = fonts();
    // Only supported CJK/Latin glyphs: exercising a direction flag is not
    // Hebrew/Arabic shaping or Figma alignment acceptance.
    for align in ["start", "center", "end", "justify"] {
        for direction in ["ltr", "rtl"] {
            for indent in [-12.375, 0., 25.] {
                let mut n = text();
                n.text = "中文 AB 中文 AB".into();
                let style = n.text_style.as_mut().unwrap();
                style.align = align.into();
                style.direction = direction.into();
                style.paragraph_indent = indent;
                let fixed = f.node_layout(&n, Some(65.)).unwrap();
                let solved = solve(&n, &f);
                close(solved.height, fixed.height);
                let actual = f.node_layout(&solved, Some(65.)).unwrap();
                assert_eq!(
                    serde_json::to_value(actual).unwrap(),
                    serde_json::to_value(fixed).unwrap()
                );
            }
        }
    }
    // An indivisible glyph wider than maxWidth remains an intentional overflow.
    let mut n = text();
    n.text = "中".into();
    n.font_size = 80.;
    let solved = solve(&n, &f);
    close(solved.width, 65.);
    close(solved.height, 108.);
    assert!(f.node_layout(&solved, Some(65.)).unwrap().width > solved.width);
}

#[test]
fn constrained_hug_sizes_are_recomputed_after_each_call_and_font_change() {
    let f = fonts();
    let mut d = document(&text());
    for step in 0..6 {
        let n = d.nodes.get_mut("t").unwrap();
        match step {
            1 => n.text = "中文".into(),
            2 => n.font_size = 28.,
            3 => {
                n.text_runs =
                    serde_json::from_value(json!([{"start":0,"end":2,"fontSize":40,"weight":800}]))
                        .unwrap()
            }
            4 => n.sizing.as_mut().unwrap().max_width = 120.,
            5 => n.sizing.as_mut().unwrap().max_width = 30.,
            _ => {}
        }
        layout::resolve(&mut d, &f).unwrap();
        let n = &d.nodes["t"];
        close(n.height, [81., 27., 75.6, 108., 54., 108.][step]);
        close(f.node_layout(n, Some(n.width)).unwrap().height, n.height);
    }
    // A new font context or font ID must be consulted on every call.
    assert!(layout::resolve(&mut d, &Fonts::new()).is_err());
    d.nodes
        .get_mut("t")
        .unwrap()
        .text_style
        .as_mut()
        .unwrap()
        .font_id = "missing".into();
    // A stale font id resolves through the fallback chain instead of failing
    // the whole layout pass.
    assert!(layout::resolve(&mut d, &f).is_ok());
}

#[test]
fn component_variant_rebuild_and_variable_modes_precede_new_hug_measurement() {
    use futureox_design_kernel::{components, design_system};
    let f = fonts();
    let mut long = text();
    long.id = "long-label".into();
    long.component_key = Some("label".into());
    let mut short = long.clone();
    short.id = "short-label".into();
    short.text = "中文".into();
    let mut d:Document=serde_json::from_value(json!({"schemaVersion":4,"id":"d","name":"variants",
      "pages":[{"id":"p","name":"p","background":"#ffffff","children":["set","i"]}],
      "nodes":{
        "set":{"id":"set","kind":"section","width":300,"height":300,"componentSet":true,"children":["long","short"]},
        "long":{"id":"long","kind":"frame","width":100,"height":100,"children":["long-label"],"component":{"variants":{"State":"long"}},"layout":{"mode":"vertical","padding":[0,0,0,0]},"sizing":{"width":"hug","height":"hug"}},
        "short":{"id":"short","kind":"frame","width":100,"height":100,"children":["short-label"],"component":{"variants":{"State":"short"}},"layout":{"mode":"vertical","padding":[0,0,0,0]},"sizing":{"width":"hug","height":"hug"}},
        "long-label":long,"short-label":short,
        "i":{"id":"i","kind":"frame","width":100,"height":100,"instance":{"componentId":"long"}}
      }})).unwrap();
    let mut generated_id = None;
    for (variant, height) in [("long", 81.), ("short", 27.), ("long", 81.)] {
        d.nodes
            .get_mut("i")
            .unwrap()
            .instance
            .as_mut()
            .unwrap()
            .component_id = variant.into();
        d.validate().unwrap();
        components::resolve(&mut d).unwrap();
        layout::resolve(&mut d, &f).unwrap();
        let generated = d
            .nodes
            .values()
            .find(|n| {
                n.instance_origin
                    .as_ref()
                    .is_some_and(|o| o.owner == "i" && o.key == "label")
            })
            .unwrap();
        close(generated.height, height);
        close(d.nodes["i"].height, height);
        if let Some(id) = &generated_id {
            assert_eq!(&generated.id, id);
        }
        generated_id = Some(generated.id.clone());
    }
    let mut d = document(&text());
    d.design_system=Some(serde_json::from_value(json!({"collections":{"c":{"name":"Size","modes":["small","large"],"defaultMode":"small"}},"variables":{"size":{"name":"Size","collection":"c","kind":"number","values":{"small":20,"large":28}}},"activeModes":{"c":"small"}})).unwrap());
    d.nodes
        .get_mut("t")
        .unwrap()
        .bindings
        .insert("fontSize".into(), "size".into());
    for (mode, height) in [("small", 81.), ("large", 151.2), ("small", 81.)] {
        d.design_system
            .as_mut()
            .unwrap()
            .active_modes
            .insert("c".into(), mode.into());
        design_system::resolve(&mut d).unwrap();
        layout::resolve(&mut d, &f).unwrap();
        close(d.nodes["t"].height, height);
    }
}
