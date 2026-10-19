//! Profile the same material edits on an imported complex document. Output
//! hashes certify identical packet contents across before/after binaries.
use futureox_design_kernel::{Engine,scene::Document,editing::DocumentPatch,renderer::RenderOptions};
use sha2::{Digest,Sha256};
use std::time::Instant;
fn main()->Result<(),Box<dyn std::error::Error>> {
    let input=std::fs::read_to_string(std::env::args().nth(1).ok_or("document required")?)?;
    let value:serde_json::Value=serde_json::from_str(&input)?;
    let mut doc:Document=serde_json::from_value(value.get("document").cloned().unwrap_or(value))?;
    let root=doc.pages[0].children.iter().find(|id|doc.nodes[*id].name=="14_ToDo_List").ok_or("14_ToDo_List required")?.clone();
    let n=&doc.nodes[&root];
    let options:RenderOptions=serde_json::from_value(serde_json::json!({"pageId":doc.pages[0].id,"width":256,"height":256,
        "view":{"x":-n.transform.0[4]*0.6,"y":-n.transform.0[5]*0.6,"zoom":0.6},"transparent":false,"rasterProfile":"analytic"}))?;
    let mut engine=Engine::new(); engine.load_document(&serde_json::to_string(&doc)?)?;
    engine.compile_gpu(&options)?;
    let mut rows=Vec::new();
    for i in 0..7 {
        doc.nodes.get_mut(&root).unwrap().opacity=if i%2==0 {0.8}else{1.};
        let patch=DocumentPatch {nodes:[(root.clone(),Some(doc.nodes[&root].clone()))].into_iter().collect(),fields:Default::default()};
        let at=Instant::now();engine.apply_document_patch_with_damage(&patch)?;let patch_ms=at.elapsed().as_secs_f64()*1000.;
        let at=Instant::now();let packet=engine.compile_gpu(&options)?.into_packet()?;
        rows.push(serde_json::json!({"patchMs":patch_ms,"compileMs":at.elapsed().as_secs_f64()*1000.,"packetBytes":packet.len(),"sha256":format!("{:x}",Sha256::digest(&packet))}));
    }
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"nodes":doc.nodes.len(),"root":root,"rows":rows}))?);Ok(())
}
