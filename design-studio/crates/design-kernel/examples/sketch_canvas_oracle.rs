//! Render an isolated native-reference fixture through the production importer
//! and engine. Input is read-only; artifacts go to the explicit output directory.
use futureox_design_kernel::{Engine, interop};
use serde_json::json;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args=std::env::args().skip(1);
    let input=args.next().ok_or("input .sketch required")?;
    let output=std::path::PathBuf::from(args.next().ok_or("output directory required")?);
    let transparent = args.next().as_deref() == Some("--transparent");
    std::fs::create_dir_all(&output)?;
    let report=interop::import_sketch_report(&std::fs::read(input)?)?;
    let doc=report.document;
    std::fs::write(output.join("document.json"),serde_json::to_vec(&doc)?)?;
    std::fs::write(output.join("warnings.json"),serde_json::to_vec(&report.warnings)?)?;
    std::fs::write(output.join("reexport.sketch"), interop::export_sketch(&doc)?)?;
    let mut engine=Engine::new();engine.load_document(&serde_json::to_string(&doc)?)?;
    for page in &doc.pages { for id in &page.children {
        let n=&doc.nodes[id];
        if n.kind!="frame" {continue}
        let opts=engine.parse_options(json!({"pageId":page.id,"width":n.width as u32,"height":n.height as u32,
            "view":{"x":-n.transform.0[4],"y":-n.transform.0[5],"zoom":1},"transparent":transparent}))?;
        let filename: String=n.name.chars().map(|c|if c.is_ascii_alphanumeric()||c=='-' {c} else {'_'}).collect();
        std::fs::write(output.join(format!("{filename}.png")),engine.render_png(&opts)?)?;
    }}
    Ok(())
}
