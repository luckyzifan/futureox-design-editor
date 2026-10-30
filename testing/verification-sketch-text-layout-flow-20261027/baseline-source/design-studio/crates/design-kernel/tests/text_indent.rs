use futureox_design_kernel::{
    Engine, RenderOptions,
    font::Fonts,
    layout,
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
    let mut fonts = Fonts::new();
    fonts.load(&font_bytes()).unwrap();
    fonts
}
fn text(value: &str, indent: f64) -> Node {
    serde_json::from_value(json!({
        "id":"t", "kind":"text", "text":value, "fontSize":20,
        "width":500, "height":30, "textStyle":{"wrap":true,"paragraphIndent":indent},
        "sizing":{"width":"hug","height":"hug"},
        "fills":[{"kind":"solid","color":"#112233"}]
    }))
    .unwrap()
}
fn doc(node: &Node) -> Document {
    serde_json::from_value(json!({
        "schemaVersion":4,"id":"d","name":"indent","pages":[{
            "id":"p","name":"p","background":"#ffffff","children":["t"]
        }],"nodes":{"t":node}
    }))
    .unwrap()
}
fn close(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-9, "{actual} != {expected}");
}

#[test]
fn intrinsic_width_includes_positive_indent_without_changing_glyph_advance() {
    let f = fonts();
    // Literal mixed CJK/Latin and U+0301 combining-mark fixtures use the pinned font.
    for value in ["中文", "AB中文", "e\u{301} A", ""] {
        for indent in [0., 0.125, 12.375, 250.] {
            let n = text(value, indent);
            let natural = f.node_measure(&text(value, 0.), None).unwrap();
            let measured = f.node_measure(&n, None).unwrap();
            let outlined = f.node_layout(&n, None).unwrap();
            close(measured.width, natural.width + indent);
            close(outlined.width, measured.width);
            close(outlined.lines[0].width, natural.lines[0].width);
            assert!(measured.path.commands.is_empty());
            assert_eq!(outlined.glyphs.len(), natural.glyphs.len());
            for (actual, reference) in outlined.glyphs.iter().zip(&natural.glyphs) {
                close(actual.x, reference.x + indent);
                close(actual.advance, reference.advance);
                assert_eq!(
                    (actual.id, actual.cluster, actual.cluster_end),
                    (reference.id, reference.cluster, reference.cluster_end)
                );
            }
        }
    }
}

#[test]
fn wrapped_width_counts_indent_only_on_each_paragraphs_first_line() {
    let f = fonts();
    let n = text("中文中文中文\n中文", 25.);
    let l = f.node_layout(&n, Some(65.)).unwrap();
    assert_eq!(
        l.lines
            .iter()
            .map(|line| (line.start, line.end))
            .collect::<Vec<_>>(),
        vec![(0, 2), (2, 5), (5, 6), (7, 9)]
    );
    close(l.width, 65.);
    for (line, width) in l.lines.iter().zip([40., 60., 20., 40.]) {
        close(line.width, width);
    }
    for (index, expected) in [(0, 25.), (2, 0.), (5, 0.), (6, 25.)] {
        close(l.glyphs[index].x, expected);
    }
    // A legal word break can make a continuation wider than the inset first line.
    let word = f
        .node_layout(&text("A ABCDEFGHIJ", 25.), Some(65.))
        .unwrap();
    let continuation = word
        .lines
        .iter()
        .skip(1)
        .map(|line| line.width)
        .fold(0., f64::max);
    assert!(continuation > word.lines[0].width + 25.);
    close(word.width, continuation);
    // Hanging (negative) indentation still overflows the start edge; no rebase.
    let hanging = f.node_layout(&text("中文", -12.375), None).unwrap();
    close(hanging.width, 40.);
    close(hanging.glyphs[0].x, -12.375);
}

#[test]
fn hug_resolution_does_not_rewrap_indented_mixed_text() {
    let f = fonts();
    for value in ["中文AB", "e\u{301} 中文\nAB", "\n中文\r\n"] {
        for wrap in [false, true] {
            let mut n = text(value, 12.375);
            n.text_style.as_mut().unwrap().wrap = wrap;
            let expected = f.node_layout(&n, None).unwrap();
            let mut d = doc(&n);
            layout::resolve(&mut d, &f).unwrap();
            let solved = &d.nodes["t"];
            close(
                solved.width,
                expected
                    .lines
                    .iter()
                    .map(|l| l.width + 12.375)
                    .fold(0., f64::max),
            );
            let actual = f.node_layout(solved, Some(solved.width)).unwrap();
            assert_eq!(
                actual.lines.len(),
                expected.lines.len(),
                "{value:?}, wrap={wrap}"
            );
            close(actual.height, solved.height);
            assert_eq!(actual.path.svg_data(), expected.path.svg_data());
            let once = serde_json::to_value(&d).unwrap();
            layout::resolve(&mut d, &f).unwrap();
            assert_eq!(serde_json::to_value(&d).unwrap(), once);
        }
    }
}

#[test]
fn hug_text_cpu_pixels_equal_independently_sized_reference_at_fractional_zoom() {
    let f = fonts();
    let n = text("中文AB", 12.375);
    let mut fixed = n.clone();
    fixed.sizing = None;
    // Reference is the unindented advance plus explicit first-line inset.
    let reference = f.node_measure(&text(&n.text, 0.), None).unwrap();
    fixed.width = reference.width + 12.375;
    fixed.height = reference.height;
    let mut hug_engine = Engine::new();
    let mut fixed_engine = Engine::new();
    for engine in [&mut hug_engine, &mut fixed_engine] {
        engine.load_font(&font_bytes()).unwrap();
    }
    hug_engine
        .load_document(&serde_json::to_string(&doc(&n)).unwrap())
        .unwrap();
    fixed_engine
        .load_document(&serde_json::to_string(&doc(&fixed)).unwrap())
        .unwrap();
    for zoom in [0.25, 1., 1.375, 4., 1.] {
        let options: RenderOptions = serde_json::from_value(json!({
            "pageId":"p","width":400,"height":140,
            "view":{"x":0.125,"y":0.375,"zoom":zoom},
            "transparent":true,"rasterProfile":"analytic"
        }))
        .unwrap();
        let expected = fixed_engine.render(&options).unwrap();
        assert!(expected.chunks_exact(4).any(|pixel| pixel[3] != 0));
        assert!(
            hug_engine.render(&options).unwrap() == expected,
            "CPU bytes differ at zoom={zoom}"
        );
    }
}

#[test]
fn fractional_indent_does_not_round_the_hug_wrap_budget_down() {
    let f = fonts();
    for spacing in [-1.25, 0., 0.375] {
        let mut n = text("中文", 20.3);
        n.font_size = 12.;
        n.text_style.as_mut().unwrap().letter_spacing = spacing;
        let mut d = doc(&n);
        layout::resolve(&mut d, &f).unwrap();
        let solved = &d.nodes["t"];
        close(solved.width, 44.3 + spacing);
        let actual = f.node_layout(solved, Some(solved.width)).unwrap();
        assert_eq!(actual.lines.len(), 1, "spacing={spacing}");
        close(actual.height, solved.height);
        // A real, even tiny deficit remains a wrap, not an epsilon allowance.
        assert_eq!(
            f.node_layout(solved, Some(solved.width - 1e-9))
                .unwrap()
                .lines
                .len(),
            2
        );
    }
}

#[test]
fn nested_hug_parent_and_sibling_use_the_indented_rich_text_width() {
    let f = fonts();
    let mut n = text("中文AB", 12.375);
    n.text_runs = serde_json::from_value(json!([
        {"start":0,"end":2,"fontSize":28,"weight":600,"color":"#cc2244","underline":true},
        {"start":2,"end":4,"fontSize":16,"strikethrough":true}
    ]))
    .unwrap();
    let expected = f.node_layout(&n, None).unwrap();
    let mut plain = n.clone();
    plain.text_style.as_mut().unwrap().paragraph_indent = 0.;
    let width = f.node_measure(&plain, None).unwrap().width + 12.375;
    let mut d: Document = serde_json::from_value(json!({
        "schemaVersion":4,"id":"d","name":"nested indent",
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":["frame"]}],
        "nodes":{
            "frame":{"id":"frame","kind":"frame","width":500,"height":100,
                "children":["t","s"],"clip":true,"sizing":{"width":"hug","height":"hug"},
                "layout":{"mode":"horizontal","padding":[3,5,7,11],"gap":6}},
            "t":n,
            "s":{"id":"s","kind":"rectangle","width":9,"height":8}
        }
    }))
    .unwrap();
    d.validate().unwrap();
    layout::resolve(&mut d, &f).unwrap();
    close(d.nodes["t"].width, width);
    close(d.nodes["frame"].width, 11. + width + 6. + 9. + 5.);
    close(d.nodes["frame"].height, 3. + expected.height + 7.);
    close(d.nodes["s"].transform.0[4], 11. + width + 6.);
    close(d.nodes["t"].transform.0[4], 11.);
    assert_eq!(
        f.node_path(&d.nodes["t"]).unwrap().svg_data(),
        expected.path.svg_data()
    );
    let once = serde_json::to_value(&d).unwrap();
    layout::resolve(&mut d, &f).unwrap();
    assert_eq!(serde_json::to_value(&d).unwrap(), once);
}
