//! Export a sample kernel document as .sketch for external validation.
use futureox_design_kernel::interop;
use futureox_design_kernel::math::Transform;
use futureox_design_kernel::scene::{Document, Page};

fn main() {
    let mut doc = Document {
        design_system: None,
        prototype: None,
        fd_compatibility: None,
        schema_version: 1,
        color_management: None,
        raster_profile: None,
        id: "e2e".into(),
        name: "E2E".into(),
        pages: vec![Page {
            guides: vec![],
            id: "page1".into(),
            name: "Page 1".into(),
            children: vec!["board1".into(), "caption".into()],
            background: "#ffffff".into(),
        }],
        nodes: Default::default(),
        fonts: Default::default(),
        animations: Vec::new(),
        reviews: Default::default(),
    };
    let mut page = futureox_design_kernel::facet::sample_node("page1", "page");
    page.children = vec!["board1".into(), "caption".into()];
    let mut board = futureox_design_kernel::facet::sample_node("board1", "frame");
    board.name = "Hero Board".into();
    board.width = 375.;
    board.height = 240.;
    board.transform = Transform([1., 0., 0., 1., 24., 40.]);
    board.fills.push(futureox_design_kernel::scene::Paint {
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
    let mut text = futureox_design_kernel::facet::sample_node("caption", "text");
    text.name = "Caption".into();
    text.text = "exported by design-kernel".into();
    text.font_size = 16.;
    text.width = 260.;
    text.height = 24.;
    doc.nodes.insert("page1".into(), page);
    doc.nodes.insert("board1".into(), board);
    doc.nodes.insert("caption".into(), text);
    let bytes = interop::export_sketch(&doc).expect("export");
    std::fs::write("/tmp/fxdk-export.sketch", &bytes).expect("write");
    println!("wrote /tmp/fxdk-export.sketch ({} bytes)", bytes.len());
}
