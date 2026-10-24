use base64::Engine;
use futureox_design_kernel::fig_geometry::decode_network;
use std::collections::BTreeMap;
fn main()->Result<(),Box<dyn std::error::Error>>{
 let file=std::env::args().nth(1).ok_or("FIG network fixture path required")?;
 let values:BTreeMap<String,String>=serde_json::from_reader(std::fs::File::open(file)?)?;
 let mut converted=0;let mut errors=Vec::new();
 for(id,value)in &values{let bytes=base64::engine::general_purpose::STANDARD.decode(value)?;match decode_network(&bytes,1.,1.){Ok(decoded)=>{converted+=usize::from(decoded.vector_geometry.is_some());},Err(error)=>errors.push(serde_json::json!({"blob":id,"error":error}))}}
 println!("{}",serde_json::json!({"total":values.len(),"explicitGeometry":converted,"errors":errors}));
 if !errors.is_empty(){return Err("Native FIG geometry validation failed".into())}Ok(())
}
