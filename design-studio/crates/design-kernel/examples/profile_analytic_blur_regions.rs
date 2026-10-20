//! CPU-only compilation of a supplied Sketch file. Never executes GPU work.
use futureox_design_kernel::{Engine,interop::import_sketch_report};
use serde_json::json;
fn main()->Result<(),Box<dyn std::error::Error>> {
 let args:Vec<_>=std::env::args().collect();
 let imported=import_sketch_report(&std::fs::read(&args[1])?).map_err(|e|format!("{e:?}"))?;
 let d=imported.document;let mut engine=Engine::new();
 engine.load_font(&std::fs::read(&args[2])?)?;
 engine.load_document(&serde_json::to_string(&d)?)?;
 let mut rows=vec![];
 for profile in ["analytic","figmaSubpixel","figma"] {for conservative in [false,true] {
   if conservative && profile!="analytic" {continue;}
   let mut input=serde_json::to_value(&d)?;
   if conservative { input["nodes"]["1AB99304-455A-4A9E-9473-8923A1330FA4"]["effects"]
       .as_array_mut().unwrap().push(json!({"kind":"blur","radius":0,"color":"#000000"})); }
   engine.load_document(&input.to_string())?;
   for css_zoom in [8.,16.,32.] {for dpr in [1.,2.] {
   let zoom=css_zoom*dpr;let x=(320.-551.*css_zoom)*dpr;let y=(240.-898.*css_zoom)*dpr;
   let request=json!({"pageId":d.pages[0].id,"width":(640.*dpr) as u32,"height":(480.*dpr) as u32,
     "view":{"x":x,"y":y,"zoom":zoom},"rasterProfile":profile,"transparent":false,
     "gpuViewport":{"x":(320.*dpr-257.) as i32,"y":(240.*dpr-(257_f64).min(241.*dpr)) as i32,"w":514,"h":(514_f64).min(482.*dpr) as u32}});
   let s=engine.compile_gpu_request(&request.to_string())?;
   let n=&s.nodes["1AB99304-455A-4A9E-9473-8923A1330FA4"];
   rows.push(json!({"profile":profile,"conservativeAnalyticHalo":conservative,"cssZoom":css_zoom,"dpr":dpr,"view":s.view,
      "nodeCount":s.nodes.len(),"extent":s.extent,"output":s.output,"imageRect":n.rect,
      "imageArea":u64::from(n.rect.w)*u64::from(n.rect.h),"imageRadius":n.effects[0].radius*n.matrix.max_scale(),
      "integratedBlur":s.integrated_blur,"coherentSamples":s.coherent_samples}));
 }}}}
 println!("{}",serde_json::to_string_pretty(&json!({"scope":"CPU-only compiled packet regions; not GPU execution or timing","rows":rows}))?);Ok(())
}
