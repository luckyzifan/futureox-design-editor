use futureox_design_kernel::{interop,Engine,RenderOptions,View,color::{ColorOutput,ColorSpace,ToneMap},fidelity::RasterProfile};
use serde_json::{json,Value};use std::collections::BTreeMap;
fn main()->Result<(),Box<dyn std::error::Error>>{
 let args:Vec<_>=std::env::args().collect();let layer:Value=serde_json::from_reader(std::fs::File::open(&args[1])?)?;
 let x=layer["frame"]["x"].as_f64().unwrap();let y=layer["frame"]["y"].as_f64().unwrap();let width=layer["frame"]["width"].as_f64().unwrap()as u32;let height=layer["frame"]["height"].as_f64().unwrap()as u32;
 let files=BTreeMap::from([("meta.json".into(),br#"{"version":144}"#.to_vec()),("document.json".into(),br#"{"colorSpace":1,"pages":[{"_ref":"pages/p"}]}"#.to_vec()),("pages/p.json".into(),serde_json::to_vec(&json!({"_class":"page","do_objectID":"p","layers":[layer]}))?)]);
 let report=interop::import_sketch_source_window(&files)?;let mut doc=report.document;doc.raster_profile=Some(RasterProfile::Figma);let source=serde_json::to_string(&doc)?;std::fs::write(format!("{}.json",&args[2]),&source)?;
 let mut engine=Engine::new();engine.load_document(&source)?;let options=RenderOptions{page_id:doc.pages[0].id.clone(),width,height,view:View{x:-x,y:-y,zoom:1.},transparent:false,grid:false,pixel_preview:None,animation:None,raster_profile:RasterProfile::Figma,interactive_effects:false,checkerboard:false};
 let image=engine.render_color_png(&options,ColorOutput{space:ColorSpace::Srgb,tone_map:ToneMap::Clip})?;std::fs::write(&args[2],image)?;
 println!("{}",json!({"nodes":doc.nodes.len(),"compounds":doc.nodes.values().filter(|n|n.boolean_operation.is_some_and(|op|op.compound_rule().is_some())).count(),"warnings":report.warnings}));Ok(())
}
