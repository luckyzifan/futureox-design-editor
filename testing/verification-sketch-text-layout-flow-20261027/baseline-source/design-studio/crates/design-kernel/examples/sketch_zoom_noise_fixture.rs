//! Self-authored zoom and grain-image fixture; no proprietary texture assets.
use futureox_design_kernel::{
    Engine, interop, noise_fill,
    scene::{Document, Node},
};
use serde_json::json;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = std::path::PathBuf::from(std::env::args().nth(1).ok_or("output directory required")?);
    std::fs::create_dir_all(&out)?;
    let mut doc: Document = serde_json::from_value(
        json!({"schemaVersion":19,"id":"00000000-0000-4000-8000-000000000001","name":"Sketch zoom and grain","rasterProfile":"figma",
        "colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},
        "pages":[{"id":"00000000-0000-4000-8000-000000000002","name":"Zoom and grain","background":"#ffffff","children":[]}],"nodes":{}}),
    )?;
    for (i, name) in ["zoom-center", "zoom-offset", "noise-base", "noise-double"]
        .into_iter()
        .enumerate()
    {
        let frame = format!("10000000-0000-4000-8000-{i:012x}");
        let id = format!("20000000-0000-4000-8000-{i:012x}");
        let f: Node = serde_json::from_value(
            json!({"id":frame,"name":name,"kind":"frame","width":160,"height":160,"clip":true,"transform":[1,0,0,1,i*192,0],"children":[id]}),
        )?;
        let mut n: Node = serde_json::from_value(
            json!({"id":id,"name":format!("{name}-source"),"kind":"rectangle","width":96,"height":96,"transform":[1,0,0,1,32,32],"fills":[{"kind":"solid","color":"#3366b3"}]}),
        )?;
        if i < 2 {
            n.effects = vec![serde_json::from_value(
                json!({"kind":"zoom-blur","radius":0,"color":"#000000","zoomBlur":{"amount":20,"center":if i==0{[0.5,0.5]}else{[0.25,0.75]}}}),
            )?];
        } else {
            let mut paint = noise_fill::preset()?;
            if i == 3 {
                paint.opacity = 0.4;
                paint.tile.as_mut().unwrap().size = [128., 128.];
            }
            n.fills.push(paint);
        }
        doc.pages[0].children.push(frame.clone());
        doc.nodes.insert(frame, f);
        doc.nodes.insert(id, n);
    }
    doc.validate()?;
    std::fs::write(out.join("fixture.json"), serde_json::to_vec(&doc)?)?;
    std::fs::write(out.join("fixture.sketch"), interop::export_sketch(&doc)?)?;
    let mut e = Engine::new();
    e.load_document(&serde_json::to_string(&doc)?)?;
    for id in &doc.pages[0].children {
        let n = &doc.nodes[id];
        let opts=e.parse_options(json!({"pageId":doc.pages[0].id,"width":160,"height":160,"transparent":true,"view":{"x":-n.transform.0[4],"y":0,"zoom":1}}))?;
        std::fs::write(out.join(format!("{}.png", n.name)), e.render_png(&opts)?)?;
    }
    Ok(())
}
