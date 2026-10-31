use futureox_design_kernel::{fig,fig_geometry,math::Point};
use serde_json::{json,Value};
use std::collections::BTreeMap;
fn import(layer:Value,blobs:Vec<Vec<u8>>)->futureox_design_kernel::scene::Document{
 import_layers(layer,blobs,vec![])
}
fn import_layers(layer:Value,blobs:Vec<Vec<u8>>,extra:Vec<Value>)->futureox_design_kernel::scene::Document{
 let mut node=json!({"guid":{"sessionID":1,"localID":3},"type":"RECTANGLE","size":{"x":548,"y":409},
  "parentIndex":{"guid":{"sessionID":1,"localID":2},"position":"a"},
  "fillPaints":[{"type":"SOLID","color":{"r":1,"g":0,"b":0,"a":1}}]});
 node.as_object_mut().unwrap().extend(layer.as_object().unwrap().clone());
 let mut input=json!({"nodeChanges":[{"guid":{"sessionID":1,"localID":1},"type":"DOCUMENT"},
  {"guid":{"sessionID":1,"localID":2},"type":"CANVAS","parentIndex":{"guid":{"sessionID":1,"localID":1},"position":"a"}},node]});
 input["nodeChanges"].as_array_mut().unwrap().extend(extra);
 let doc=fig::document_from_canvas(&input,BTreeMap::new(),blobs).unwrap();doc.validate().unwrap();doc
}
#[test]fn masks_only_affect_following_siblings_and_multiple_masks_nest(){
 let layer=|id:u32,position:&str,x:f64,w:f64,color:[f64;3],mask:bool|json!({"guid":{"sessionID":1,"localID":id},"type":"RECTANGLE",
  "parentIndex":{"guid":{"sessionID":1,"localID":3},"position":position},"size":{"x":w,"y":24},
  "transform":{"m00":1,"m01":0,"m02":x,"m10":0,"m11":1,"m12":0},"mask":mask,
  "fillPaints":[{"type":"SOLID","color":{"r":color[0],"g":color[1],"b":color[2],"a":1}}]});
 for nested in [false,true]{
  let mut extra=vec![layer(4,"!",0.,40.,[1.,0.,0.],false),layer(5,"\"",0.,20.,[1.,1.,1.],true)];
  if nested{extra.extend([layer(6,"#",0.,40.,[0.,1.,0.],false),layer(7,"$",10.,20.,[1.,1.,1.],true),layer(8,"%",0.,40.,[0.,0.,1.],false)]);}
  let doc=import_layers(json!({"type":"FRAME","resizeToFit":true,"size":{"x":40,"y":24},"fillPaints":[]}),vec![],extra);
  let original=&doc.nodes["fig-1-4"];assert_eq!(original.transform.0,[1.,0.,0.,1.,0.,0.]);assert_eq!(original.width,40.);
  let mut engine=futureox_design_kernel::Engine::new();engine.load_document(&serde_json::to_string(&doc).unwrap()).unwrap();
  let options=serde_json::from_value(json!({"pageId":doc.pages[0].id,"width":40,"height":24,"view":{"x":0,"y":0,"zoom":1},"transparent":true})).unwrap();
  let bytes=engine.render(&options).unwrap();let pixel=|x:usize|&bytes[(12*40+x)*4..(12*40+x)*4+4];
  assert_eq!(pixel(35),[255,0,0,255]);
  assert_eq!(pixel(5),if nested{[0,255,0,255]}else{[255,0,0,255]});
  assert_eq!(pixel(15),if nested{[0,0,255,255]}else{[255,0,0,255]});
 }
}
#[test]fn linear_gradient_uses_inverse_native_coordinates(){
 let doc=import(json!({"fillPaints":[{"type":"GRADIENT_LINEAR","transform":{"m00":0,"m01":1,"m02":0,"m10":-1,"m11":0,"m12":1},
  "stops":[{"position":0,"color":{"r":1,"g":0,"b":0,"a":1}},{"position":1,"color":{"r":1,"g":0,"b":0,"a":0}}]}]}),vec![]);
 let forward=doc.nodes["fig-1-3"].fills[0].transform.unwrap();
 assert_eq!(forward.point(Point::new(0.,0.5)),Point::new(0.5,0.));
 assert_eq!(forward.point(Point::new(1.,0.5)),Point::new(0.5,1.));
}
#[test]fn automatic_width_text_does_not_wrap(){
 for mode in ["WIDTH_AND_HEIGHT","HEIGHT","NONE"]{
  let doc=import(json!({"type":"TEXT","textAutoResize":mode,"textData":{"characters":"Completed Tasks"},"fontSize":14}),vec![]);
  assert_eq!(doc.nodes["fig-1-3"].text_style.as_ref().unwrap().wrap,mode!="WIDTH_AND_HEIGHT");
 }
}
const CARD:&[u8]=include_bytes!("../../../../testing/verification-interaction-layout-20261030/fig-card-corners.bin");
const POSTING:&[u8]=include_bytes!("../../../../testing/verification-interaction-layout-20261030/fig-posting-corners.bin");
#[test]fn actual_card_corners_execute_in_the_native_importer(){
 let doc=import(json!({"type":"VECTOR","cornerRadius":6,"vectorData":{"normalizedSize":{"x":548,"y":409},"vectorNetworkBlob":0}}),vec![CARD.to_vec()]);
 let node=&doc.nodes["fig-1-3"];assert_eq!(node.kind,"vector");assert!(node.network.is_none());assert!(node.vector_geometry.is_some());
 assert!(node.paths().unwrap().0.commands.len()>5);
}
#[test]fn actual_per_vertex_rounding_preserves_source_and_refuses_unknown_styles(){
 let original=POSTING.to_vec();let styles=json!([{"styleID":1,"cornerRadius":6},{"styleID":2,"cornerRadius":6},{"styleID":3,"cornerRadius":6},{"styleID":5,"cornerRadius":6}]);
 let mut decoded=fig_geometry::decode_network(&original,1.,1.).unwrap();
 assert!(fig_geometry::round_network(&mut decoded,0.,0.,&styles).unwrap());
 assert!(decoded.vector_geometry.is_some());assert_eq!(original,POSTING);
 for unknown in [json!([{"styleID":1,"cornerRadius":6,"fillPaints":[]}]),json!([])]{
  let mut decoded=fig_geometry::decode_network(POSTING,1.,1.).unwrap();
  let before=serde_json::to_vec(&decoded).unwrap();assert!(!fig_geometry::round_network(&mut decoded,0.,0.,&unknown).unwrap());
  assert_eq!(before,serde_json::to_vec(&decoded).unwrap());
 }
 let mut decoded=fig_geometry::decode_network(CARD,1.,1.).unwrap();
 assert!(!fig_geometry::round_network(&mut decoded,6.,0.5,&Value::Null).unwrap());
 assert!(decoded.network.is_some());
}
