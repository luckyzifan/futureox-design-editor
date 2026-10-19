//! Auto-width must resize the text frame without moving the text's horizontal
//! anchor. These use the pinned product font, actual shaping and CPU rendering.
use futureox_design_kernel::{
    Engine, RenderOptions,
    font::Fonts,
    layout::{self, SizeMode},
    math::{Point, Transform},
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

fn text(align: &str, direction: &str, transform: [f64; 6]) -> Node {
    serde_json::from_value(json!({
        "id":"t", "kind":"text", "text":"中文 AB", "fontSize":20,
        "width":300, "height":54, "transform":transform,
        "textStyle":{"wrap":false,"align":align,"direction":direction},
        "sizing":{"width":"fixed","height":"fixed"},
        "fills":[{"kind":"solid","color":"#19304b"}]
    }))
    .unwrap()
}

fn document(node: &Node) -> Document {
    serde_json::from_value(json!({
        "schemaVersion":4,"id":"d","name":"auto-width anchor",
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":["parent"]}],
        "nodes":{
            "parent":{"id":"parent","kind":"frame","width":600,"height":400,
                "transform":[0.75,0.25,-0.125,1,18,24],"children":["t"]},
            "t":node
        }
    }))
    .unwrap()
}

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-8,
        "{actual:.15} != {expected:.15}"
    );
}

fn point_close(actual: Point, expected: Point) {
    close(actual.x, expected.x);
    close(actual.y, expected.y);
}

fn hug(node: &mut Node) {
    let sizing = node.sizing.as_mut().unwrap();
    sizing.width = SizeMode::Hug;
    sizing.height = SizeMode::Hug;
}

fn resolve_and_check_stable(doc: &mut Document, fonts: &Fonts) {
    doc.validate().unwrap();
    layout::resolve(doc, fonts).unwrap();
    doc.validate().unwrap();
    let once = serde_json::to_value(&*doc).unwrap();
    for _ in 0..3 {
        layout::resolve(doc, fonts).unwrap();
        assert_eq!(serde_json::to_value(&*doc).unwrap(), once);
    }
}

fn world(doc: &Document) -> Transform {
    doc.nodes["parent"]
        .transform
        .concat(doc.nodes["t"].transform)
}

fn anchor(doc: &Document, factor: f64) -> Point {
    world(doc).point(Point::new(doc.nodes["t"].width * factor, 0.))
}

// Explicit RTL uses the same supported Latin/CJK glyphs. The pinned product
// font has no Hebrew/Arabic or bidi-control glyphs, so auto here exercises the
// first-strong LTR case, not RTL-language shaping acceptance.
const ALIGNMENTS: [(&str, &str, f64); 9] = [
    ("start", "ltr", 0.),
    ("center", "ltr", 0.5),
    ("end", "ltr", 1.),
    ("start", "rtl", 1.),
    ("center", "rtl", 0.5),
    ("end", "rtl", 0.),
    ("start", "auto", 0.),
    ("center", "auto", 0.5),
    ("end", "auto", 1.),
];

#[test]
fn fixed_frame_to_hug_keeps_world_glyph_positions_for_affine_text() {
    let fonts = fonts();
    for (align, direction, factor) in ALIGNMENTS {
        for matrix in [
            [1., 0., 0., 1., 30., 40.],
            [0., 1., -1., 0., 400., 40.],
            [1.25, 0.5, 0.25, 0.75, 30., 40.],
            [1.5, 0., 0., 0.75, 30., 40.],
            [-1., 0.25, 0.5, 1., 400., 40.],
        ] {
            let before = document(&text(align, direction, matrix));
            let old_anchor = anchor(&before, factor);
            let fixed_glyphs = fonts
                .node_layout(&before.nodes["t"], Some(before.nodes["t"].width))
                .unwrap();
            assert!(!fixed_glyphs.glyphs.is_empty());
            let mut after = before.clone();
            hug(after.nodes.get_mut("t").unwrap());
            resolve_and_check_stable(&mut after, &fonts);
            point_close(anchor(&after, factor), old_anchor);
            assert_eq!(&after.nodes["t"].transform.0[..4], &matrix[..4]);
            assert_eq!(after.nodes["parent"], before.nodes["parent"]);
            let intrinsic = fonts.node_measure(&after.nodes["t"], None).unwrap();
            close(after.nodes["t"].width, intrinsic.width);
            close(after.nodes["t"].height, intrinsic.height);
            let actual = fonts
                .node_layout(&after.nodes["t"], Some(after.nodes["t"].width))
                .unwrap();
            assert_eq!(actual.glyphs.len(), fixed_glyphs.glyphs.len());
            for (old, new) in fixed_glyphs.glyphs.iter().zip(&actual.glyphs) {
                assert_eq!(
                    (old.id, old.cluster, old.cluster_end),
                    (new.id, new.cluster, new.cluster_end)
                );
                close(old.advance, new.advance);
                point_close(
                    world(&after).point(Point::new(new.x, new.y)),
                    world(&before).point(Point::new(old.x, old.y)),
                );
            }
        }
    }
}

#[test]
fn body_and_font_size_edits_keep_anchor_and_use_current_font_measurement() {
    let fonts = fonts();
    for (align, direction, factor) in ALIGNMENTS {
        let mut doc = document(&text(align, direction, [1.25, 0.5, 0.25, 0.75, 30., 40.]));
        hug(doc.nodes.get_mut("t").unwrap());
        resolve_and_check_stable(&mut doc, &fonts);
        let fixed_anchor = anchor(&doc, factor);
        for (body, size) in [
            ("中文", 20.),
            ("AB中文AB", 32.),
            ("中 A", 14.),
            ("中文 AB", 20.),
        ] {
            let node = doc.nodes.get_mut("t").unwrap();
            node.text = body.into();
            node.font_size = size;
            resolve_and_check_stable(&mut doc, &fonts);
            point_close(anchor(&doc, factor), fixed_anchor);
            let measure = fonts.node_measure(&doc.nodes["t"], None).unwrap();
            close(doc.nodes["t"].width, measure.width);
            close(doc.nodes["t"].height, measure.height);
        }
    }
}

#[test]
fn constrained_hug_wrap_preserves_box_anchor_while_reflowing() {
    let fonts = fonts();
    for (align, direction, factor) in ALIGNMENTS {
        let mut node = text(align, direction, [1.25, 0.5, 0.25, 0.75, 30., 40.]);
        node.text = "中文中文中文".into();
        node.text_style.as_mut().unwrap().wrap = true;
        let mut doc = document(&node);
        let old_anchor = anchor(&doc, factor);
        let node = doc.nodes.get_mut("t").unwrap();
        hug(node);
        node.sizing.as_mut().unwrap().max_width = 45.;
        resolve_and_check_stable(&mut doc, &fonts);
        close(doc.nodes["t"].width, 45.);
        close(doc.nodes["t"].height, 81.);
        point_close(anchor(&doc, factor), old_anchor);
        let actual = fonts.node_layout(&doc.nodes["t"], Some(45.)).unwrap();
        assert_eq!(actual.lines.len(), 3);
        close(actual.height, doc.nodes["t"].height);
    }
}

#[test]
fn width_clamps_keep_the_same_alignment_anchor() {
    let fonts = fonts();
    for (align, direction, factor) in ALIGNMENTS {
        let mut doc = document(&text(align, direction, [0., 1.5, -0.75, 0., 400., 40.]));
        let old_anchor = anchor(&doc, factor);
        hug(doc.nodes.get_mut("t").unwrap());
        for (minimum, maximum, expected_width) in
            [(0.01, 35., 35.), (180., 500., 180.), (0.01, 500., -1.)]
        {
            let sizing = doc.nodes.get_mut("t").unwrap().sizing.as_mut().unwrap();
            sizing.min_width = minimum;
            sizing.max_width = maximum;
            resolve_and_check_stable(&mut doc, &fonts);
            let width = if expected_width < 0. {
                fonts.node_measure(&doc.nodes["t"], None).unwrap().width
            } else {
                expected_width
            };
            close(doc.nodes["t"].width, width);
            point_close(anchor(&doc, factor), old_anchor);
        }
    }
}

#[test]
fn fixed_width_hug_height_keeps_manual_position_and_width() {
    let fonts = fonts();
    for (align, direction, _) in ALIGNMENTS {
        let mut node = text(align, direction, [1.25, 0.5, 0.25, 0.75, 30., 40.]);
        node.width = 45.;
        node.text = "中文中文中文".into();
        node.text_style.as_mut().unwrap().wrap = true;
        node.sizing.as_mut().unwrap().height = SizeMode::Hug;
        let mut doc = document(&node);
        resolve_and_check_stable(&mut doc, &fonts);
        assert_eq!(doc.nodes["t"].transform, node.transform);
        close(doc.nodes["t"].width, 45.);
        close(doc.nodes["t"].height, 81.);
    }
}

#[test]
fn vertical_text_keeps_glyph_positions_without_horizontal_alignment_shift() {
    let fonts = fonts();
    // Vertical shaping does not use horizontal start/center/end placement.
    // Changing its column width must not invent such a placement adjustment.
    for align in ["start", "center", "end"] {
        let mut node = text(align, "ltr", [1.25, 0.5, 0.25, 0.75, 30., 40.]);
        node.text = "中文".into();
        node.text_style.as_mut().unwrap().writing_mode = "vertical".into();
        let before = document(&node);
        let old = fonts.node_layout(&node, Some(node.width)).unwrap();
        let mut after = before.clone();
        hug(after.nodes.get_mut("t").unwrap());
        resolve_and_check_stable(&mut after, &fonts);
        assert_eq!(after.nodes["t"].transform, node.transform);
        let actual = fonts
            .node_layout(&after.nodes["t"], Some(after.nodes["t"].width))
            .unwrap();
        assert_eq!(actual.glyphs.len(), old.glyphs.len());
        for (old, new) in old.glyphs.iter().zip(&actual.glyphs) {
            point_close(
                world(&after).point(Point::new(new.x, new.y)),
                world(&before).point(Point::new(old.x, old.y)),
            );
        }
    }
}

#[test]
fn flow_layout_owns_child_placement_after_hug_measurement() {
    let fonts = fonts();
    let mut node = text("end", "ltr", [1., 0., 0., 1., 300., 30.]);
    hug(&mut node);
    node.constraints = Some(serde_json::from_value(json!({"horizontal":"end"})).unwrap());
    let mut doc = document(&node);
    let parent = doc.nodes.get_mut("parent").unwrap();
    parent.layout = Some(
        serde_json::from_value(json!({
            "mode":"horizontal","padding":[10,10,10,10],"gap":7,"align":"start"
        }))
        .unwrap(),
    );
    parent.children.push("s".into());
    doc.nodes.insert(
        "s".into(),
        serde_json::from_value(json!({
            "id":"s","kind":"rectangle","width":15,"height":12
        }))
        .unwrap(),
    );
    let parent = doc.nodes["parent"].clone();
    for body in ["中文 AB", "中", "AB 中文 AB"] {
        doc.nodes.get_mut("t").unwrap().text = body.into();
        resolve_and_check_stable(&mut doc, &fonts);
        close(doc.nodes["t"].transform.0[4], 10.);
        close(doc.nodes["t"].transform.0[5], 10.);
        close(doc.nodes["s"].transform.0[4], 17. + doc.nodes["t"].width);
        close(doc.nodes["s"].transform.0[5], 10.);
        assert_eq!(doc.nodes["parent"], parent);
    }
}

#[test]
fn parent_constraints_compose_with_text_anchor_without_repeated_drift() {
    let fonts = fonts();
    for (horizontal, delta) in [("start", 0.), ("center", 60.), ("end", 120.)] {
        let mut node = text("end", "ltr", [1., 0., 0., 1., 30., 40.]);
        hug(&mut node);
        node.constraints = Some(serde_json::from_value(json!({
            "horizontal":horizontal,"vertical":"start","referenceWidth":600,"referenceHeight":400
        })).unwrap());
        let mut doc = document(&node);
        resolve_and_check_stable(&mut doc, &fonts);
        let old_anchor = anchor(&doc, 1.);
        doc.nodes.get_mut("parent").unwrap().width = 720.;
        doc.nodes.get_mut("t").unwrap().text = "中文 AB 中文".into();
        resolve_and_check_stable(&mut doc, &fonts);
        point_close(
            anchor(&doc, 1.),
            old_anchor + Point::new(0.75 * delta, 0.25 * delta),
        );
        close(
            doc.nodes["t"]
                .constraints
                .as_ref()
                .unwrap()
                .reference_width
                .unwrap(),
            720.,
        );
        close(
            doc.nodes["t"].width,
            fonts.node_measure(&doc.nodes["t"], None).unwrap().width,
        );
    }
}

#[test]
fn auto_width_cpu_pixels_match_same_text_in_its_original_fixed_frame() {
    let bytes = font_bytes();
    for (align, direction, _) in [
        ("center", "ltr", 0.5),
        ("end", "ltr", 1.),
        ("start", "rtl", 1.),
    ] {
        let fixed = document(&text(align, direction, [1., 0., 0., 1., 30., 40.]));
        let mut auto = fixed.clone();
        hug(auto.nodes.get_mut("t").unwrap());
        let mut reference = Engine::new();
        let mut actual = Engine::new();
        for engine in [&mut reference, &mut actual] {
            engine.load_font(&bytes).unwrap();
        }
        reference
            .load_document(&serde_json::to_string(&fixed).unwrap())
            .unwrap();
        actual
            .load_document(&serde_json::to_string(&auto).unwrap())
            .unwrap();
        for zoom in [0.75, 1., 1.375] {
            let options: RenderOptions = serde_json::from_value(json!({
                "pageId":"p","width":380,"height":220,
                "view":{"x":0.125,"y":0.375,"zoom":zoom},
                "transparent":true,"rasterProfile":"analytic"
            }))
            .unwrap();
            let expected = reference.render(&options).unwrap();
            assert!(expected.chunks_exact(4).any(|pixel| pixel[3] > 0));
            assert!(
                actual.render(&options).unwrap() == expected,
                "auto-width moved visible text: align={align},direction={direction},zoom={zoom}"
            );
        }
    }
}
