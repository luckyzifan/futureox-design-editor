use futureox_design_kernel::{
    Engine, RenderOptions,
    font::Fonts,
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
fn text_node(style: serde_json::Value) -> Node {
    serde_json::from_value(json!({
        "id":"t", "kind":"text", "text":"测试AV设计", "fontSize":20,
        "width":500, "height":200, "textStyle":style,
        "sizing":{"width":"hug","height":"hug"},
        "fills":[{"kind":"solid","color":"#112233"}]
    }))
    .unwrap()
}
fn doc(node: &Node) -> Document {
    serde_json::from_value(json!({
        "schemaVersion":4, "id":"d", "name":"t",
        "pages":[{"id":"p","name":"p","children":["t"],"background":"#ffffff"}],
        "nodes":{"t":node}
    }))
    .unwrap()
}

#[test]
fn open_type_features_parse_and_shape_without_changing_defaults() {
    let fonts = fonts();
    let plain = fonts
        .node_layout(&text_node(json!({})), Some(500.))
        .unwrap();
    let disabled = fonts
        .node_layout(&text_node(json!({"features":["-liga","kern"]})), Some(500.))
        .unwrap();
    // An explicit feature list is accepted; with NotoSansSC's default
    // repertoire the toggles must not disturb the shaped output.
    assert_eq!(plain.glyphs.len(), disabled.glyphs.len());
    assert_eq!(plain.width, disabled.width);
    assert!(
        fonts
            .node_layout(
                &text_node(json!({"features":["not a feature!"]})),
                Some(500.)
            )
            .is_err()
    );
}

#[test]
fn variation_axes_validate_and_carry_into_outlines() {
    let fonts = fonts();
    let varied = fonts
        .node_layout(
            &text_node(json!({"variations":[{"tag":"wdth","value":75.}]})),
            Some(500.),
        )
        .unwrap();
    assert!(varied.width > 0.);
    // wght is reserved for the weight field; four-character tags are enforced.
    assert!(
        fonts
            .node_layout(
                &text_node(json!({"variations":[{"tag":"wght","value":700.}]})),
                Some(500.)
            )
            .is_err()
    );
    assert!(
        fonts
            .node_layout(
                &text_node(json!({"variations":[{"tag":"wd","value":700.}]})),
                Some(500.)
            )
            .is_err()
    );
}

#[test]
fn vertical_layout_stacks_cjk_and_rotates_latin() {
    let fonts = fonts();
    let node = text_node(json!({"writingMode":"vertical"}));
    let layout = fonts.node_layout(&node, Some(500.)).unwrap();
    let upright: Vec<_> = layout
        .glyphs
        .iter()
        .filter(|g| g.path_transform.is_none())
        .collect();
    let rotated: Vec<_> = layout
        .glyphs
        .iter()
        .filter(|g| g.path_transform.is_some())
        .collect();
    // 测试/设计 (CJK) stay upright; the Latin run "AV" rotates.
    assert_eq!(upright.len(), 4, "four CJK glyphs stay upright");
    assert_eq!(rotated.len(), 2, "the Latin run rotates");
    // Upright glyphs advance strictly downward in sequence.
    for pair in upright.windows(2) {
        assert!(pair[1].y > pair[0].y, "upright glyphs stack vertically");
    }
    // The rotated glyphs share one run baseline and keep their horizontal order.
    assert_eq!(rotated[0].y, rotated[1].y);
    assert!(rotated[1].x > rotated[0].x);
    // The column is about one glyph size wide, far narrower than the
    // horizontal baseline of the same string.
    let horizontal = fonts
        .node_layout(&text_node(json!({})), Some(500.))
        .unwrap();
    assert!(layout.width < horizontal.width / 2.);
    assert!(layout.height > horizontal.height);
}

#[test]
fn vertical_text_renders_through_the_engine() {
    let mut engine = Engine::new();
    engine.load_font(&font_bytes()).unwrap();
    let document = doc(&text_node(json!({"writingMode":"vertical"})));
    engine
        .load_document(&serde_json::to_string(&document).unwrap())
        .unwrap();
    let options: RenderOptions = serde_json::from_value(json!({
        "pageId":"p","width":80,"height":240,"transparent":true,
        "view":{"x":0,"y":0,"zoom":1}
    }))
    .unwrap();
    let bytes = engine.render(&options).unwrap();
    assert_eq!(bytes.len(), 80 * 240 * 4);
    // Ink must exist (non-transparent pixels) inside the narrow column.
    assert!(bytes.chunks_exact(4).any(|p| p[3] > 0));
}
