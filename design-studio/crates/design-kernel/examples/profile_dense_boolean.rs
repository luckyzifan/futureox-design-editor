use futureox_design_kernel::{scene::Document,curve_boolean};
fn main()->Result<(),Box<dyn std::error::Error>>{
 let file=std::env::args().nth(1).ok_or("fixture path required")?;
 let mut doc:Document=serde_json::from_reader(std::fs::File::open(file)?)?;
 let id="04AD0502-D8B1-4126-87A2-130302EE21AA".to_owned();
 doc.pages[0].children=vec![id.clone()];for p in doc.pages.iter_mut().skip(1){p.children.clear();}
 let at=std::time::Instant::now();curve_boolean::resolve(&mut doc)?;
 let n=&doc.nodes[&id];
 println!("{}",serde_json::json!({"ms":at.elapsed().as_secs_f64()*1000.,"curveCommands":n.vector_geometry.as_ref().map(|g|g.fill.len()),"networkEdges":n.network.as_ref().map(|g|g.edges.len()),"operationRetained":n.boolean_operation.is_some()}));
 Ok(())
}
