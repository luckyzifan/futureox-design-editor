//! Small native-readable fixture with an installed font; paths are explicit.
use futureox_design_kernel::{Engine,interop,scene::Document};
use serde_json::json;
use base64::Engine as _;
fn id(n:usize)->String {format!("e04a0000-0000-4000-8000-{n:012}")}
fn main()->Result<(),Box<dyn std::error::Error>>{
 let out=std::path::PathBuf::from(std::env::args().nth(1).ok_or("output directory")?);std::fs::create_dir_all(&out)?;
 let bytes=std::fs::read("/System/Library/Fonts/Supplemental/Arial.ttf")?;
 let mut d:Document=serde_json::from_value(json!({"schemaVersion":20,"id":id(1),"name":"Sketch text and flow reference","pages":[{"id":id(2),"name":"Text Flow","background":"#ffffff","children":[]}],"nodes":{},"fonts":{"arial":{"family":"Arial","postscript":"ArialMT","data":base64::engine::general_purpose::STANDARD.encode(bytes),"index":0}}}))?;
 for (i,name) in ["top","center","bottom","paragraphs"].iter().enumerate(){
  let f=id(10+i*2); let t=id(11+i*2);
  d.pages[0].children.push(f.clone());
  d.nodes.insert(f.clone(),serde_json::from_value(json!({"id":f,"kind":"frame","name":name,"width":240,"height":180,"transform":[1,0,0,1,i as f64*280.,0],"fills":[{"kind":"solid","color":"#ffffff"}],"children":[t]}))?);
  let mut n:futureox_design_kernel::scene::Node=serde_json::from_value(json!({"id":t,"kind":"text","name":format!("text-{name}"),"text":if i==3 {"One\nTwo\nThree"}else{"Hello"},"fontSize":20,"width":200,"height":140,"transform":[1,0,0,1,20,20],"sizing":{"width":"fixed","height":"fixed"},"textStyle":{"fontId":"arial","lineHeight":1.5,"wrap":true,"verticalAlign":if i==3 {"top"}else{name}},"fills":[{"kind":"solid","color":"#000000"}]}))?;
  if i==3 {n.text_runs=serde_json::from_value(json!([
   {"start":0,"end":4,"paragraph":{"align":"start","minimumLineHeight":30,"maximumLineHeight":30,"spacing":4,"indent":0}},
   {"start":4,"end":8,"paragraph":{"align":"center","minimumLineHeight":40,"maximumLineHeight":40,"spacing":6,"indent":0}},
   {"start":8,"end":13,"paragraph":{"align":"end","minimumLineHeight":24,"maximumLineHeight":32,"spacing":0,"indent":0}}
  ]))?;}
  d.nodes.insert(t,n);
 }
 // A true modern stack, two navigable screens, and a library Symbol.
 for (i,name) in ["stack","home","destination"].iter().enumerate() {
  let f=id(30+i*10);d.pages[0].children.push(f.clone());
  d.nodes.insert(f.clone(),serde_json::from_value(json!({"id":f,"kind":"frame","name":name,"width":240,"height":180,"transform":[1,0,0,1,i as f64*280.,240],"fills":[{"kind":"solid","color":if i==2 {"#99bbff"}else{"#ffffff"}}]}))?);
 }
 d.nodes.get_mut(&id(30)).unwrap().layout=Some(serde_json::from_value(json!({"mode":"horizontal","gap":10,"padding":[16,16,16,16]}))?);
 for (n,x,w) in [(31,16.,40.),(32,66.,158.)] {d.nodes.insert(id(n),serde_json::from_value(json!({"id":id(n),"kind":"rectangle","name":format!("stack-{n}"),"width":w,"height":40,"transform":[1,0,0,1,x,16],"fills":[{"kind":"solid","color":"#3366cc"}],"sizing":{"width":if n==32 {"fill"}else{"fixed"}}}))?);d.nodes.get_mut(&id(30)).unwrap().children.push(id(n));}
 for (parent,n,name) in [(40,41,"Go next"),(50,51,"Go back")] {d.nodes.insert(id(n),serde_json::from_value(json!({"id":id(n),"kind":"rectangle","name":name,"width":160,"height":50,"transform":[1,0,0,1,20,20]}))?);d.nodes.get_mut(&id(parent)).unwrap().children.push(id(n));}
 d.prototype=Some(serde_json::from_value(json!({"startNode":id(40),"interactions":{
  id(41):[{"trigger":"click","actions":[{"kind":"navigate","target":id(50),"durationMs":300,"transitionStyle":"slide-left"}]}],
  id(51):[{"trigger":"click","actions":[{"kind":"back","durationMs":300,"transitionStyle":"slide-right"}]}]
 }}))?);
 d.nodes.insert(id(60),serde_json::from_value(json!({"id":id(60),"kind":"frame","name":"Library Symbol","component":{"variants":{},"properties":{}},"width":180,"height":50,"transform":[1,0,0,1,0,480],"children":[id(61)],"fills":[{"kind":"solid","color":"#eeeeee"}]}))?);
 d.nodes.insert(id(61),serde_json::from_value(json!({"id":id(61),"kind":"text","name":"Symbol label","text":"Source label","fontSize":18,"width":160,"height":30,"transform":[1,0,0,1,10,10],"textStyle":{"fontId":"arial"},"fills":[{"kind":"solid","color":"#3366cc"}]}))?);
 d.pages[0].children.push(id(60));
 d.nodes.insert(id(62),serde_json::from_value(json!({"id":id(62),"kind":"frame","name":"Instance","width":180,"height":50,"transform":[1,0,0,1,20,100],"instance":{"componentId":id(60),"overrides":{id(61):{"text":"Local label"}},"propertyValues":{}}}))?);
 d.nodes.get_mut(&id(40)).unwrap().children.push(id(62));
 d.validate()?;
 std::fs::write(out.join("document.json"),serde_json::to_vec(&d)?)?;
 std::fs::write(out.join("fixture.sketch"),interop::export_sketch(&d)?)?;
 let mut e=Engine::new();e.load_document(&serde_json::to_string(&d)?)?;
 for id in &d.pages[0].children {let n=&d.nodes[id];let opts=e.parse_options(json!({"pageId":d.pages[0].id,"width":n.width as u32,"height":n.height as u32,"view":{"x":-n.transform.0[4],"y":-n.transform.0[5],"zoom":1}}))?; std::fs::write(out.join(format!("{}.png",n.name)),e.render_png(&opts)?)?;}
 Ok(())
}
