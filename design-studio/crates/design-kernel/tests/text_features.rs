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

#[test]
fn styled_text_expansion_has_no_legacy_forty_thousand_node_ceiling() {
    let fonts = fonts();
    let mut text = text_node(json!({}));
    text.text_runs = serde_json::from_value(json!([{"start":0,"end":2,"color":"#ff0000"}])).unwrap();
    let mut document = doc(&text);
    let empty: Node = serde_json::from_value(json!({"id":"filler","kind":"rectangle","width":1,"height":1})).unwrap();
    for i in 0..40_000 {
        let mut n = empty.clone();
        n.id = format!("filler-{i}");
        document.pages[0].children.push(n.id.clone());
        document.nodes.insert(n.id.clone(), n);
    }
    futureox_design_kernel::capacity::check_document_counts(document.nodes.len() + 4, document.pages.len()).unwrap();
    futureox_design_kernel::font::expand_rich_text(&mut document, &fonts).unwrap();
    assert_eq!(document.nodes["t"].kind, "group");
    assert!(!document.nodes["t"].children.is_empty());
    assert!(document.nodes.len() > 40_001);
}

#[test]
fn styled_text_resource_rejection_is_repeatable_and_engine_recovers() {
    // A separate test process owns a small trusted policy; never mutate the
    // immutable budget used by sibling tests or bypass real render admission.
    const CHILD: &str = "CORE_STYLED_TEXT_RESOURCE_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "styled_text_resource_rejection_is_repeatable_and_engine_recovers", "--nocapture"])
            .env(CHILD, "1")
            .env("CORE_DOCUMENT_MEMORY_BYTES", (32 * 4096).to_string())
            .output().unwrap();
        assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        return;
    }
    let mut text = text_node(json!({}));
    text.text = "A".repeat(40);
    text.text_runs = serde_json::from_value(json!((0..40).map(|i| json!({
        "start":i,"end":i+1,"color":if i % 2 == 0 { "#ff0000" } else { "#0000ff" }
    })).collect::<Vec<_>>())).unwrap();
    let document = doc(&text);
    let json = serde_json::to_string(&document).unwrap();
    assert!(json.len() < futureox_design_kernel::capacity::document_byte_limit());
    futureox_design_kernel::validate_document_json(&json).unwrap();
    let mut engine = Engine::new();
    engine.load_font(&font_bytes()).unwrap();
    engine.load_document(&json).unwrap();
    let revision = engine.content_revision();
    let options: RenderOptions = serde_json::from_value(json!({
        "pageId":"p","width":80,"height":80,"transparent":true,
        "view":{"x":0,"y":0,"zoom":1}
    })).unwrap();
    for _ in 0..2 {
        let error = engine.render(&options).unwrap_err();
        assert!(error.contains("DOCUMENT_RESOURCE_LIMIT") && error.contains("structure"), "{error}");
        assert_eq!(engine.content_revision(), revision);
    }
    let safe = doc(&text_node(json!({})));
    engine.load_document(&serde_json::to_string(&safe).unwrap()).unwrap();
    assert_eq!(engine.render(&options).unwrap().len(), 80 * 80 * 4);
}
