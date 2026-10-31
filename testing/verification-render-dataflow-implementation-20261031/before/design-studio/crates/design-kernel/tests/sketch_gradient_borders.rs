use futureox_design_kernel::{interop::{import_sketch_source_window,export_sketch,read_zip_public,import_sketch_report},scene::Document,Engine,RenderOptions};
use serde_json::{json,Value};
use std::collections::BTreeMap;
fn fixture(kind:i32)->(Document,Value){
 let gradient=json!({"_class":"gradient","gradientType":kind,"from":"{0.50000310851954777, -0.043236982880252135}","to":"{0.50000310851954777, 1.0432520730060286}","elipseLength":0.7,"stops":[{"_class":"gradientStop","position":0,"color":{"_class":"color","red":0,"green":0.8,"blue":1,"alpha":0.25}},{"_class":"gradientStop","position":1,"color":{"_class":"color","red":0,"green":0.8,"blue":1,"alpha":0.25}}]});
 let layer=json!({"_class":"rectangle","do_objectID":"n","name":"gradient border","frame":{"x":8,"y":8,"width":40,"height":20},"style":{"contextSettings":{"opacity":0.5,"blendMode":0},"fills":[],"borders":[{"isEnabled":true,"fillType":1,"color":{"red":0,"green":0,"blue":0,"alpha":1},"contextSettings":{"opacity":0.6,"blendMode":0},"gradient":gradient,"thickness":4,"position":0}],"borderOptions":{"lineCapStyle":1,"lineJoinStyle":2,"dashPattern":[]}}});
 let files=BTreeMap::from([("meta.json".into(),br#"{"version":136}"#.to_vec()),("document.json".into(),br#"{"colorSpace":1,"pages":[{"_ref":"pages/p"}]}"#.to_vec()),("pages/p.json".into(),serde_json::to_vec(&json!({"_class":"page","do_objectID":"p","layers":[layer]})).unwrap())]);
 (import_sketch_source_window(&files).unwrap().document,gradient)
}
fn pixels(doc:&Document)->Vec<f32>{let mut engine=Engine::new();engine.load_document(&serde_json::to_string(doc).unwrap()).unwrap_or_else(|e|panic!("{e}; pages={:?} nodes={:?}",doc.pages,doc.nodes.keys().collect::<Vec<_>>()));let options:RenderOptions=serde_json::from_value(json!({"pageId":doc.pages[0].id,"width":64,"height":40,"view":{"x":0,"y":0,"zoom":1},"transparent":true,"rasterProfile":"analytic"})).unwrap();engine.render_linear(&options).unwrap().into_iter().flat_map(|p|p.0).collect()}
#[test]
fn native_gradient_border_ignores_black_fallback_and_applies_alpha_once(){
 let(doc,gradient)=fixture(0);let stroke=&doc.nodes["n"].strokes[0];assert_eq!(stroke.paint.kind,"linear");assert_eq!(stroke.paint.opacity,0.6);assert_eq!(stroke.width,4.);assert_eq!(stroke.cap,"round");assert_eq!(stroke.join,"bevel");assert_eq!(stroke.paint.stops.len(),2);
 let mut oracle=doc.clone();let paint=&mut oracle.nodes.get_mut("n").unwrap().strokes[0].paint;paint.kind="solid".into();paint.color="color(srgb 0 0.8 1 / 0.25)".into();paint.stops.clear();paint.transform=None;
 let actual=pixels(&doc);let expected=pixels(&oracle);assert!(actual.iter().zip(&expected).all(|(a,b)|(a-b).abs()<1e-6));assert!(actual.chunks(4).any(|p|p[2]>0.01&&p[0]==0.));
 let files=read_zip_public(&export_sketch(&doc).unwrap()).unwrap();let page:Value=serde_json::from_slice(files.iter().find(|(n,_)|n.starts_with("pages/")).unwrap().1).unwrap();let border=&page["layers"][0]["style"]["borders"][0];assert_eq!(border["fillType"],1);assert_eq!(border["gradient"],gradient);assert_eq!(border["contextSettings"]["opacity"],0.6);
 let reopened=import_sketch_report(&export_sketch(&doc).unwrap()).unwrap().document;assert!(pixels(&reopened).iter().zip(actual).all(|(a,b)|(a-b).abs()<1e-6));
}
#[test]
fn linear_radial_angular_node_and_shared_borders_preserve_stops_and_hidden_state(){
 for (code,kind) in [(0,"linear"),(1,"radial"),(2,"angular")]{
  let(doc,gradient)=fixture(code);assert_eq!(doc.nodes["n"].strokes[0].paint.kind,kind);
  for shared in [false,true]{for visible in [false,true]{
   let mut next=doc.clone();let mut strokes=next.nodes["n"].strokes.clone();strokes[0].visible=visible;
   if shared{let system=next.design_system.get_or_insert_with(Default::default);system.styles.insert("s".into(),serde_json::from_value(json!({"name":"s","kind":"paint","value":[],"strokes":strokes})).unwrap());next.nodes.get_mut("n").unwrap().strokes.clear();}
   else{next.nodes.get_mut("n").unwrap().strokes=strokes;}
   let files=read_zip_public(&export_sketch(&next).unwrap()).unwrap();
   let native:Value=if shared {serde_json::from_slice(&files["document.json"]).unwrap()}else{serde_json::from_slice(files.iter().find(|(n,_)|n.starts_with("pages/")).unwrap().1).unwrap()};
   let border=if shared{&native["layerStyles"]["objects"][0]["value"]["borders"][0]}else{&native["layers"][0]["style"]["borders"][0]};
   assert_eq!(border["fillType"],1);assert_eq!(border["isEnabled"],visible);for(a,b)in border["gradient"]["stops"].as_array().unwrap().iter().zip(gradient["stops"].as_array().unwrap()){assert_eq!(a["position"].as_f64(),b["position"].as_f64());for key in ["red","green","blue","alpha"]{assert_eq!(a["color"][key].as_f64(),b["color"][key].as_f64());}}
  }}
 }
}
#[test]
fn gradient_border_export_still_rejects_hdr_without_implicit_tone_mapping(){
 let(mut doc,_)=fixture(0);doc.nodes.get_mut("n").unwrap().strokes[0].paint.stops[0].color="color(rec2100-pq 0.5 0.5 0.5)".into();
 assert!(export_sketch(&doc).unwrap_err().to_string().contains("cannot preserve HDR"));
}
