//! Minimal single-layer .sketch export for Sketch-side bisection.
use futureox_design_kernel::interop;
use futureox_design_kernel::scene::{Document, Node, Page};

fn doc_with(layer: Node, id: &str) -> Document {
    let mut doc = Document {
        design_system: None,
        prototype: None,
        fd_compatibility: None,
        schema_version: 1,
        color_management: None,
        raster_profile: None,
        id: "bisect".into(),
        name: "Bisect".into(),
        pages: vec![Page {
            guides: vec![],
            id: "page1".into(),
            name: "Page 1".into(),
            children: vec![id.into()],
            background: "#ffffff".into(),
        }],
        nodes: Default::default(),
        fonts: Default::default(),
        animations: Vec::new(),
        reviews: Default::default(),
    };
    let mut page = futureox_design_kernel::facet::sample_node("page1", "page");
    page.children = vec![id.into()];
    doc.nodes.insert("page1".into(), page);
    doc.nodes.insert(id.into(), layer);
    doc
}

fn node_holder(
    doc: &mut futureox_design_kernel::scene::Document,
    node: futureox_design_kernel::scene::Node,
) {
    let id = node.id.clone();
    doc.nodes.insert(id.clone(), node);
    doc.nodes.get_mut("board").unwrap().children = vec![id];
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "text".into());
    let with_fill = std::env::args()
        .nth(2)
        .map(|a| a == "fill")
        .unwrap_or(false);
    let id = format!("{mode}{}", if with_fill { "-f" } else { "" });
    let mut node = futureox_design_kernel::facet::sample_node(&id, &mode);
    node.name = mode.clone();
    node.width = 200.;
    node.height = 40.;
    if mode == "text" {
        node.text = "hi".into();
        node.font_size = 14.;
    }
    if with_fill {
        node.fills.push(futureox_design_kernel::scene::Paint {
            transform: None,
            id: String::new(),
            kind: "solid".into(),
            color: "#2456e6".into(),
            opacity: 1.,
            visible: true,
            angle: 0.,
            stops: Vec::new(),
            image: None,
            fit: "cover".into(),
            blend: "normal".into(),
            adjust: None,
            tile: None,
        });
    }
    let doc = if std::env::var("NEST").is_ok() {
        // 把被测层装进一个 canvasFrame 里,复现真实文档的嵌套结构
        let mut frame = futureox_design_kernel::facet::sample_node("board", "frame");
        frame.name = "Board".into();
        frame.width = 400.;
        frame.height = 300.;
        let mut doc = doc_with(frame, "board");
        let mut page = doc.nodes.get_mut("page1").cloned().unwrap();
        let _ = &mut page;
        doc.nodes.get_mut("page1").unwrap().children = vec!["board".into()];
        node_holder(&mut doc, node);
        doc
    } else {
        doc_with(node, &id)
    };
    let bytes = interop::export_sketch(&doc).expect("export");
    let path = format!("/tmp/fxdk-{id}.sketch");
    std::fs::write(&path, &bytes).unwrap();
    println!("wrote {path}");
}
