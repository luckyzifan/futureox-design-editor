use futureox_design_kernel::{
    Engine, RenderOptions, View,
    fidelity::RasterProfile,
    math::Point,
    scene::{Document, Network},
    vector_tools::fill_region,
};
use serde_json::json;
fn document() -> serde_json::Value {
    json!({"schemaVersion":10,"id":"d","name":"Local tool fixture","pages":[{"id":"p","name":"Page","background":"#ffffff","children":["shape"]}],"nodes":{"shape":{"id":"shape","kind":"rectangle","width":64,"height":64,"fills":[{"kind":"solid","color":"#226699"}]}}})
}
fn render(value: &serde_json::Value) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&value.to_string()).unwrap();
    engine
        .render(&RenderOptions {
            page_id: "p".into(),
            width: 80,
            height: 80,
            view: View {
                x: 0.,
                y: 0.,
                zoom: 1.,
            },
            transparent: true,
            grid: false,
            pixel_preview: None,
            animation: None,
            raster_profile: RasterProfile::Analytic,
            interactive_effects: false,
        checkerboard: false,
        })
        .unwrap()
}
#[test]
fn slice_and_local_reviews_do_not_change_artwork_pixels() {
    let mut d = document();
    let before = render(&d);
    d["nodes"]["slice"] =
        json!({"id":"slice","kind":"slice","width":40,"height":30,"transform":[1,0,0,1,5,7]});
    d["pages"][0]["children"]
        .as_array_mut()
        .unwrap()
        .push(json!("slice"));
    d["reviews"] = json!([{"id":"comment","pageId":"p","position":{"x":20,"y":10},"nodeId":"shape","kind":"comment","resolved":false,"messages":[{"id":"message","author":"本机","text":"检查切片","createdAt":1}]}]);
    assert_eq!(before, render(&d));
    let parsed: Document = serde_json::from_value(d.clone()).unwrap();
    assert!(parsed.validate().is_ok());
    d["nodes"]["slice"]["fills"] = json!([{"kind":"solid","color":"#ff0000"}]);
    assert!(
        serde_json::from_value::<Document>(d)
            .unwrap()
            .validate()
            .is_err()
    );
}
#[test]
fn paint_bucket_changes_only_the_selected_closed_face() {
    let network:Network=serde_json::from_value(json!({"vertices":[{"id":"a","x":0,"y":0},{"id":"b","x":20,"y":0},{"id":"c","x":40,"y":0},{"id":"d","x":40,"y":20},{"id":"e","x":20,"y":20},{"id":"f","x":0,"y":20}],"edges":[{"id":"ab","from":"a","to":"b"},{"id":"bc","from":"b","to":"c"},{"id":"cd","from":"c","to":"d"},{"id":"de","from":"d","to":"e"},{"id":"ef","from":"e","to":"f"},{"id":"fa","from":"f","to":"a"},{"id":"be","from":"b","to":"e"}]})).unwrap();
    let filled = fill_region(network.clone(), Point::new(10., 10.), false).unwrap();
    assert_eq!(filled.vertices, network.vertices);
    assert_eq!(filled.edges, network.edges);
    let (path, _) = filled.paths().unwrap();
    let contours = path.flatten(Default::default(), 0.001).unwrap();
    assert_ne!(
        futureox_design_kernel::path::winding(Point::new(10., 10.), &contours),
        0
    );
    assert_eq!(
        futureox_design_kernel::path::winding(Point::new(30., 10.), &contours),
        0
    );
    let empty = fill_region(filled, Point::new(10., 10.), true).unwrap();
    assert!(empty.paths().unwrap().0.commands.is_empty());
    assert!(fill_region(network, Point::new(80., 80.), false).is_err());
}
#[test]
fn attached_connector_follows_rust_layout_and_keeps_elbows_orthogonal() {
    let mut d = document();
    d["nodes"]["target"] = json!({"id":"target","kind":"rectangle","width":50,"height":30,"transform":[1,0,0,1,160,90]});
    d["nodes"]["link"] = json!({"id":"link","kind":"vector","width":1,"height":1,"connector":{"from":{"point":{"x":64,"y":32},"nodeId":"shape","anchor":{"x":1,"y":0.5}},"to":{"point":{"x":160,"y":105},"nodeId":"target","anchor":{"x":0,"y":0.5}},"style":"elbow"}});
    d["pages"][0]["children"] = json!(["shape", "target", "link"]);
    let mut doc: Document = serde_json::from_value(d).unwrap();
    doc.validate().unwrap();
    futureox_design_kernel::layout::resolve(&mut doc, &Default::default()).unwrap();
    let link = &doc.nodes["link"];
    let vertices = &link.network.as_ref().unwrap().vertices;
    for pair in vertices.windows(2) {
        assert!(pair[0].x == pair[1].x || pair[0].y == pair[1].y)
    }
    assert_eq!(
        link.connector.as_ref().unwrap().to.point,
        Point::new(160., 105.)
    );
    doc.nodes.get_mut("target").unwrap().transform.0[4] = 210.;
    futureox_design_kernel::layout::resolve(&mut doc, &Default::default()).unwrap();
    assert_eq!(
        doc.nodes["link"].connector.as_ref().unwrap().to.point,
        Point::new(210., 105.)
    );
}
#[test]
fn offset_retains_authored_shape_and_expands_its_actual_geometry() {
    let mut doc: Document = serde_json::from_value(document()).unwrap();
    let n = doc.nodes.get_mut("shape").unwrap();
    n.path_offset = 5.;
    let original = n.width;
    let (_, path) = n.paths().unwrap();
    let b = futureox_design_kernel::bounds::path_bounds(&path, Default::default()).unwrap();
    assert!((b.x + 5.).abs() < 1e-6);
    assert!((b.width - 74.).abs() < 1e-6);
    assert_eq!(n.width, original);
    n.path_offset = -5.;
    let (_, path) = n.paths().unwrap();
    let b = futureox_design_kernel::bounds::path_bounds(&path, Default::default()).unwrap();
    assert!((b.x - 5.).abs() < 1e-6);
    assert!((b.width - 54.).abs() < 1e-6);
}
#[test]
fn text_on_path_uses_real_shaped_glyphs_and_returns_transformed_bounds() {
    let mut fonts = futureox_design_kernel::font::Fonts::new();
    fonts
        .load(
            &std::fs::read(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
            ))
            .unwrap(),
        )
        .unwrap();
    let n:futureox_design_kernel::scene::Node=serde_json::from_value(json!({"id":"text","kind":"text","text":"ABC 中文","width":300,"height":40,"fontSize":20,"textPath":{"offset":0,"normal":0,"reverse":false,"network":{"vertices":[{"id":"a","x":0,"y":40},{"id":"b","x":300,"y":40}],"edges":[{"id":"e","from":"a","to":"b"}]}}})).unwrap();
    let layout = fonts.node_layout(&n, Some(n.width)).unwrap();
    assert!(!layout.path.commands.is_empty());
    assert!(layout.glyphs.iter().all(|g| g.path_transform.is_some()));
    let bounds = layout.bounds.unwrap();
    assert!(bounds.y < 40. && bounds.y + bounds.height <= 42.);
    let json = serde_json::to_value(&n).unwrap();
    assert_eq!(json["text"], "ABC 中文");
}

#[test]
fn selected_vertices_move_together_without_moving_unselected_controls() {
    let g:Network=serde_json::from_value(json!({"vertices":[{"id":"a","x":0,"y":0},{"id":"b","x":100,"y":0},{"id":"c","x":200,"y":20}],"edges":[{"id":"ab","from":"a","to":"b","c1":{"x":30,"y":10},"c2":{"x":70,"y":10}},{"id":"bc","from":"b","to":"c","c1":{"x":120,"y":10},"c2":{"x":160,"y":-30}}]})).unwrap();
    let moved = futureox_design_kernel::vector_tools::translate_vertices(
        g.clone(),
        &["a".into(), "b".into()],
        Point::new(-5., 8.),
    )
    .unwrap();
    assert_eq!(moved.vertices[0].x, -5.);
    assert_eq!(moved.vertices[1].x, 95.);
    assert_eq!(moved.vertices[2], g.vertices[2]);
    assert_eq!(moved.edges[0].c1, Some(Point::new(25., 18.)));
    assert_eq!(moved.edges[0].c2, Some(Point::new(65., 18.)));
    assert_eq!(moved.edges[1].c1, Some(Point::new(115., 18.)));
    assert_eq!(moved.edges[1].c2, g.edges[1].c2);
    assert!(
        futureox_design_kernel::vector_tools::translate_vertices(
            g,
            &["missing".into()],
            Point::new(0., 0.)
        )
        .is_err()
    );
}

#[test]
fn code_language_derives_colors_without_changing_the_authored_source() {
    let mut d = document();
    d["nodes"]["block"] = json!({"id":"block","kind":"frame","width":300,"height":180,"board":{"kind":"code-block","language":"rust"},"children":["code"]});
    d["nodes"]["code"] = json!({"id":"code","kind":"text","width":260,"height":140,"fontSize":16,"text":"fn main() { let value = 42; }"});
    d["pages"][0]["children"] = json!(["shape", "block"]);
    let mut doc: Document = serde_json::from_value(d).unwrap();
    let original = doc.nodes["code"].text.clone();
    futureox_design_kernel::code_blocks::resolve(&mut doc).unwrap();
    doc.validate().unwrap();
    assert_eq!(doc.nodes["code"].text, original);
    assert!(
        doc.nodes["code"]
            .text_runs
            .iter()
            .any(|r| r.color.as_deref() == Some("#ff7b72"))
    );
    doc.nodes
        .get_mut("block")
        .unwrap()
        .board
        .as_mut()
        .unwrap()
        .language = Some("plain".into());
    futureox_design_kernel::code_blocks::resolve(&mut doc).unwrap();
    assert!(doc.nodes["code"].text_runs.is_empty());
}
