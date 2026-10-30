use base64::Engine as _;
use futureox_design_kernel::{
    Engine,
    font::{FontResource, Fonts, TextRun, TextStyle},
    scene::Node,
};
use serde_json::json;
use std::collections::BTreeMap;
fn font_bytes() -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../frontend/design-client/public/fonts/NotoSansSC.ttf"),
    )
    .unwrap()
}
fn fonts() -> Fonts {
    let mut f = Fonts::new();
    f.load(&font_bytes()).unwrap();
    f
}
fn text(value: &str, width: f64) -> Node {
    serde_json::from_value(json!({"id":"t","kind":"text","text":value,"fontSize":20,"width":width,"height":30,"textStyle":{"wrap":true},"fills":[{"kind":"solid","color":"#000000"}]})).unwrap()
}
#[test]
fn chinese_wrap_uses_available_width_and_preserves_source_clusters() {
    let f = fonts();
    let n = text("中文排版换行测试", 40.);
    let layout = f.node_layout(&n, Some(n.width)).unwrap();
    assert_eq!(layout.lines.len(), 4);
    assert!(layout.lines.iter().all(|l| l.width <= 40.000001));
    assert_eq!(layout.height, 4. * 20. * 1.35);
    assert_eq!(
        layout
            .lines
            .iter()
            .map(|l| (l.start, l.end))
            .collect::<Vec<_>>(),
        vec![(0, 2), (2, 4), (4, 6), (6, 8)]
    );
    assert!(layout.glyphs.iter().all(|g| g.cluster_end > g.cluster));
    let wider = f.node_layout(&n, Some(80.)).unwrap();
    assert_eq!(wider.lines.len(), 2);
}

#[test]
fn display_case_changes_outlines_without_changing_authored_text_or_caret_indices() {
    use futureox_design_kernel::font::TextCase;
    let f=fonts();
    let mut source=text("aßz",500.);
    source.text_style.as_mut().unwrap().text_case=TextCase::Upper;
    let upper=text("ASSZ",500.);
    assert_eq!(f.node_path(&source).unwrap().svg_data(),f.node_path(&upper).unwrap().svg_data());
    assert_eq!(source.text,"aßz");
    let layout=f.node_layout(&source,Some(500.)).unwrap();
    assert_eq!(layout.lines[0].end,3);
    assert!(layout.glyphs.iter().all(|g|g.cluster<3 && g.cluster_end<=3));
    assert!(layout.glyphs.iter().filter(|g|g.cluster==1).count()>=2);
    assert!(f.caret_at(&source,3).is_ok());
    assert!(f.caret_at(&source,4).is_err());
    source.text_runs=vec![TextRun {start:1,end:2,text_case:Some(TextCase::Original),..Default::default()}];
    assert_eq!(f.node_path(&source).unwrap().svg_data(),f.node_path(&text("AßZ",500.)).unwrap().svg_data());
}
#[test]
fn trailing_newlines_and_blank_paragraphs_have_line_boxes() {
    let f = fonts();
    let mut n = text("A\r\n\n", 200.);
    let layout = f.node_layout(&n, Some(200.)).unwrap();
    assert_eq!(layout.lines.len(), 3);
    assert_eq!(layout.glyphs.len(), 1);
    n.text_style.as_mut().unwrap().line_height = 2.;
    assert_eq!(f.node_layout(&n, Some(200.)).unwrap().height, 120.);
}
#[test]
fn weight_and_styled_ranges_share_the_outline_and_measurement_pipeline() {
    let f = fonts();
    let mut n = text("设计 Text", 500.);
    let ordinary = f.node_path(&n).unwrap().svg_data();
    n.text_style.as_mut().unwrap().weight = 800.;
    assert_ne!(ordinary, f.node_path(&n).unwrap().svg_data());
    n.text_runs = vec![TextRun {
        start: 0,
        end: 2,
        font_id: None,
        font_size: Some(40.),
        weight: Some(600.),
        ..Default::default()
    }];
    let layout = f.node_layout(&n, Some(500.)).unwrap();
    assert_eq!(layout.height, 54.);
    let measured = f.node_measure(&n, Some(500.)).unwrap();
    assert_eq!(
        (layout.width, layout.height),
        (measured.width, measured.height)
    );
    assert!(measured.path.commands.is_empty());
}
#[test]
fn missing_fonts_and_split_grapheme_ranges_are_errors() {
    let f = fonts();
    let mut n = text("e\u{301}", 100.);
    n.text_runs = vec![TextRun {
        start: 0,
        end: 1,
        font_id: None,
        font_size: None,
        weight: Some(700.),
        ..Default::default()
    }];
    assert!(f.node_layout(&n, Some(100.)).is_err());
    n.text_runs.clear();
    n.text_style = Some(TextStyle {
        font_id: "missing".into(),
        ..TextStyle::default()
    });
    // A vanished resource no longer fails the render: the cluster degrades to
    // the embedded default face (historically this hard error blanked whole
    // canvases when one font id went stale).
    let layout = f.node_path(&n).unwrap();
    assert!(!layout.commands.is_empty());
}
#[test]
fn document_fonts_are_portable_and_corrupt_fonts_do_not_replace_the_loaded_document() {
    let f = fonts();
    let mut resources = BTreeMap::new();
    resources.insert(
        "custom".into(),
        FontResource {
            family: "Portable Noto".into(),
            data: base64::engine::general_purpose::STANDARD
                .encode(font_bytes())
                .into(),
            index: 0,
            postscript: None,
        },
    );
    let n = text("设计", 100.);
    let ordinary = f.node_path(&n).unwrap().svg_data();
    let mut custom = n.clone();
    custom.text_style.as_mut().unwrap().font_id = "custom".into();
    assert_eq!(
        ordinary,
        f.with_resources(&resources)
            .unwrap()
            .node_path(&custom)
            .unwrap()
            .svg_data()
    );
    let mut doc = json!({"schemaVersion":1,"id":"d","name":"fonts","pages":[{"id":"p","name":"p","background":"#ffffff","children":["t"]}],"nodes":{"t":custom},"fonts":resources});
    let mut engine = Engine::new();
    engine.load_font(&font_bytes()).unwrap();
    engine.load_document(&doc.to_string()).unwrap();
    doc["fonts"]["custom"]["data"] = json!("YWJj");
    assert!(engine.load_document(&doc.to_string()).is_err());
    let options = serde_json::from_value(
        json!({"pageId":"p","width":100,"height":60,"view":{"x":0,"y":0,"zoom":1}}),
    )
    .unwrap();
    assert!(engine.render(&options).is_ok());
}
