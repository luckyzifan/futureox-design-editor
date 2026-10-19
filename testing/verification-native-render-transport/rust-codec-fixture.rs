// CPU fixture exercising the production wire codec, not the GPU renderer.
#![forbid(unsafe_code)]
#[path = "../../design-studio/crates/design-gpu/src/serve_protocol.rs"]
mod serve_protocol;
use serve_protocol::{Correlation, Protocol, Reply};
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::time::Instant;
fn rgba(width:usize,height:usize)->Vec<u8>{(0..width*height*4).map(|i|((i*13+i%251)&255)as u8).collect()}
fn reply(width:usize,height:usize,pixels:Vec<u8>)->Reply{Reply{metadata:json!({"type":"frame","width":width,"height":height,"stats":{"frames":1,"backend":"codec-fixture","render_ms":1.25,"label":"中文"}}),rgba:Some(pixels)}}
fn main(){
 let args:Vec<_>=std::env::args().collect();
 if args.get(1).is_some_and(|s|s=="bench") {
  let mut results=Vec::new();let scope=Correlation{session:"benchmark-session".into(),id:1};
  for (width,height) in [(96,64),(512,512),(1920,1080),(3840,2160)] {
   let pixels=rgba(width,height);let mut legacy=Vec::new();let mut binary=Vec::new();
   for index in 0..106 {
    let order=if index%2==0 {[Protocol::Json,Protocol::Frb1]}else{[Protocol::Frb1,Protocol::Json]};
    for protocol in order {let value=reply(width,height,pixels.clone());let start=Instant::now();serve_protocol::emit(&mut std::io::sink(),protocol,value,Some(&scope)).unwrap();let ms=start.elapsed().as_secs_f64()*1000.;if index>=5{if protocol==Protocol::Json{legacy.push(ms)}else{binary.push(ms)}}}
   }
   results.push(json!({"width":width,"height":height,"legacyMs":legacy,"frb1Ms":binary}));
  }
  println!("{}",json!({"scope":"production Rust codec encode + writes to sink; no pipe/GPU/Electron","results":results}));return;
 }
 let protocol=if args.iter().any(|arg|arg=="frb1"){Protocol::Frb1}else{Protocol::Json};
 let mut out=std::io::stdout().lock();let mut previous=None;
 for line in std::io::stdin().lock().lines(){
  let message:Value=serde_json::from_str(&line.unwrap()).unwrap();
  if protocol==Protocol::Frb1{previous=Some(Correlation::read(&message,previous.as_ref()).unwrap())}
  let value=match message["cmd"].as_str().unwrap(){
   "load"=>Reply::control(json!({"type":"loaded"})),
   "stats"=>Reply::control(json!({"type":"stats","stats":{"pid":std::process::id(),"gpu_memory":null}})),
   "frame"=>{if message["options"]["hang"]==true{continue}let width=message["options"]["width"].as_u64().unwrap_or(0) as usize;let height=message["options"]["height"].as_u64().unwrap_or(0) as usize;if width==0||height==0{Reply::error("invalid options")}else{reply(width,height,rgba(width,height))}},
   "stop"=>break,
   _=>Reply::error("unknown command"),
  };
  serve_protocol::emit(&mut out,protocol,value,previous.as_ref()).unwrap();out.flush().unwrap();
 }
}
