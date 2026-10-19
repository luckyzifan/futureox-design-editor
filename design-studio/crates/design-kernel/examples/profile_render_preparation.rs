//! Read-only preparation profile for an imported local document; no image export.
use futureox_design_kernel::{curve_boolean, design_system, font::{Fonts, expand_rich_text}, layout, scene::Document};
use std::time::Instant;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path=std::env::args().nth(1).ok_or("document JSON path required")?;
    let value:serde_json::Value=serde_json::from_slice(&std::fs::read(path)?)?;
    let mut doc:Document=serde_json::from_value(value.get("document").cloned().unwrap_or(value))?;
    let mut fonts=Fonts::new();fonts.load(&std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"),"/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"))?)?;
    let fonts=fonts.with_resources(&doc.fonts)?;
    let mut results=Vec::new();
    macro_rules! timed { ($name:expr,$body:expr) => {{ let at=Instant::now();$body;results.push(serde_json::json!({"name":$name,"ms":at.elapsed().as_secs_f64()*1000.})); }} }
    timed!("validate",doc.validate()?);
    timed!("clone",{let copy=doc.clone();std::hint::black_box(copy);});
    timed!("design-system-and-components",design_system::resolve(&mut doc)?);
    timed!("layout",layout::resolve(&mut doc,&fonts)?);
    timed!("boolean",curve_boolean::resolve(&mut doc)?);
    timed!("post-validate",doc.validate()?);
    timed!("styled-text",expand_rich_text(&mut doc,&fonts)?);
    println!("{}",serde_json::to_string_pretty(&results)?);Ok(())
}
