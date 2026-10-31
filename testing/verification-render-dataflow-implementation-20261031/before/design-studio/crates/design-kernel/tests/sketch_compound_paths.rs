use futureox_design_kernel::{interop,boolean::Operation,curve_boolean,path::winding,math::{Point,Transform}};
use serde_json::{json,Value};
use std::collections::BTreeMap;
fn contour(id:&str,coords:&[[f64;2]],code:i64)->Value{
 json!({"_class":"shapePath","do_objectID":id,"name":id,"booleanOperation":code,"isVisible":true,"isClosed":true,
 "frame":{"x":0,"y":0,"width":20,"height":20},"style":{"windingRule":0},"points":coords.iter().map(|p|json!({"_class":"curvePoint","point":format!("{{{}, {}}}",p[0]/20.,p[1]/20.),"hasCurveFrom":false,"hasCurveTo":false})).collect::<Vec<_>>()})
}
fn document(rule:i64,reverse:bool,code:i64)->futureox_design_kernel::scene::Document{
 let mut inner=vec![[5.,5.],[15.,5.],[15.,15.],[5.,15.]];if reverse{inner.reverse()}
 let group=json!({"_class":"shapeGroup","do_objectID":"group","name":"outline","booleanOperation":-1,"frame":{"x":0,"y":0,"width":20,"height":20},"style":{"windingRule":rule,"fills":[{"isEnabled":true,"fillType":0,"color":{"red":0.1,"green":0.4,"blue":1.,"alpha":1.}}]},"layers":[contour("outer",&[[0.,0.],[20.,0.],[20.,20.],[0.,20.]],-1),contour("inner",&inner,code)]});
 let files=BTreeMap::from([("meta.json".into(),br#"{"version":144}"#.to_vec()),("document.json".into(),br#"{"colorSpace":1,"pages":[{"_ref":"pages/p"}]}"#.to_vec()),("pages/p.json".into(),serde_json::to_vec(&json!({"_class":"page","do_objectID":"p","layers":[group]})).unwrap())]);
 interop::import_sketch_source_window(&files).unwrap().document
}
#[test]fn native_none_operations_share_directed_winding_instead_of_filling_the_hole(){
 for (rule,reverse,code,center)in [(0,true,-1,false),(0,false,-1,true),(1,false,-1,false),(0,true,0,true)]{
  let mut doc=document(rule,reverse,code);let id=doc.pages[0].children[0].clone();let original=doc.nodes.clone();
  if code == -1{assert!(matches!(doc.nodes[&id].boolean_operation,Some(Operation::CompoundNonzero|Operation::CompoundEvenodd)));assert_eq!(doc.schema_version,16)}
  curve_boolean::resolve(&mut doc).unwrap();doc.validate().unwrap();let root=&doc.nodes[&id];let cs=root.paths().unwrap().0.flatten(Transform::default(),1e-6).unwrap();
  let filled=|p|{let w=winding(p,&cs);if root.fill_even_odd(){w.abs()%2!=0}else{w!=0}};
  assert!(filled(Point::new(2.,2.)));assert_eq!(filled(Point::new(10.,10.)),center,"rule={rule},reverse={reverse},code={code}");
  for child in &root.children{assert_eq!(original[child],doc.nodes[child]);}
  let exported=interop::export_sketch(&doc).unwrap();let imported=interop::import_sketch_report(&exported).unwrap().document;
  assert_eq!(imported.nodes[&imported.pages[0].children[0]].boolean_operation,root.boolean_operation);
 }
}
