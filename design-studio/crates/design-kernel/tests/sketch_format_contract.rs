use futureox_design_kernel::{interop, layout::Anchor};
use serde_json::{json,Value};
use std::io::Write;
const ID:&str="12345678-1234-4234-8234-123456789ABC";
fn archive(layer:Value)->Vec<u8>{
 let mut zip=zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
 for (name,v) in [("meta.json",json!({"version":136})),("document.json",json!({"colorSpace":1,"pages":[{"_ref":"pages/p"}]})),("pages/p.json",json!({"_class":"page","do_objectID":"p","layers":[layer]}))]{zip.start_file(name,zip::write::SimpleFileOptions::default()).unwrap();zip.write_all(&serde_json::to_vec(&v).unwrap()).unwrap();}zip.finish().unwrap().into_inner()
}
fn base()->Value{json!({"_class":"star","do_objectID":ID,"name":"Original","numberOfPoints":5,"radius":0.25,"frame":{"width":40,"height":40},"style":{"fills":[{"isEnabled":true,"fillType":0,"color":{"red":1,"green":0,"blue":0,"alpha":1}}]},"userInfo":{"com.vendor.plugin":{"target":ID,"nested":[1,2,3]}}})}
fn layer(bytes:&[u8])->Value{let files=interop::read_zip_public(bytes).unwrap();let p=files.iter().find(|(n,_)|n.starts_with("pages/")).unwrap();serde_json::from_slice::<Value>(p.1).unwrap()["layers"][0].clone()}
#[test]
fn native_star_geometry_identity_plugin_data_and_radius_edits_roundtrip(){
 let mut doc=interop::import_sketch_report(&archive(base())).unwrap().document;
 assert_eq!(doc.nodes[ID].inner_radius,0.25);
 let n=doc.nodes.get_mut(ID).unwrap();n.name="Renamed".into();n.inner_radius=0.7;
 let out=interop::export_sketch(&doc).unwrap();let native=layer(&out);
 assert_eq!(native["do_objectID"],ID);assert_eq!(native["radius"],0.7);assert_eq!(native["name"],"Renamed");assert_eq!(native["points"].as_array().unwrap().len(),10);
 assert_eq!(native["userInfo"]["com.vendor.plugin"],base()["userInfo"]["com.vendor.plugin"]);
 let reopened=interop::import_sketch_report(&out).unwrap().document;assert_eq!(reopened.nodes[ID].inner_radius,0.7);
}
#[test]
fn legacy_native_masks_map_supported_axes_and_retain_all_source_masks(){
 for mask in 0..64u64{
  let mut input=base();input["resizingConstraint"]=json!(mask);
  let doc=interop::import_sketch_report(&archive(input)).unwrap().document;
  if mask!=63 {let c=doc.nodes[ID].constraints.as_ref().unwrap();let expected=match mask&7{1=>Anchor::Start,2=>Anchor::Stretch,4=>Anchor::End,_=>Anchor::Scale};assert_eq!(c.horizontal,expected);}
  assert_eq!(layer(&interop::export_sketch(&doc).unwrap())["resizingConstraint"],mask);
 }
}
#[test]
fn solid_fill_uses_native_color_alpha_and_preserves_blend_mode(){
 for blend in [0,16,17] {
  let mut input=base();input["style"]["fills"][0]["color"]["alpha"]=json!(0.25);
  input["style"]["fills"][0]["contextSettings"]=json!({"opacity":0.5,"blendMode":blend});
  let doc=interop::import_sketch_report(&archive(input)).unwrap().document;
  assert_eq!(doc.nodes[ID].fills[0].opacity,0.25);
  let native=layer(&interop::export_sketch(&doc).unwrap());
  assert_eq!(native["style"]["fills"][0]["color"]["alpha"],0.25);
  assert_eq!(native["style"]["fills"][0]["contextSettings"]["opacity"],1.);
  assert_eq!(native["style"]["fills"][0]["contextSettings"]["blendMode"],blend);
 }
}
#[test]
fn mixed_name_and_unrepresented_image_edit_is_rejected_by_source_codec(){
 let before=interop::import_sketch_report(&archive(base())).unwrap().document;let mut after=before.clone();
 let n=after.nodes.get_mut(ID).unwrap();n.name="Unsaved".into();n.fills[0].kind="image".into();n.fills[0].transform=Some(futureox_design_kernel::math::Transform([1.,0.,0.,1.,0.2,0.]));
 n.fills[0].image=Some("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==".into());
 after.validate().unwrap();
 let error=interop::export_sketch_layer_edit(&before,&after,ID).unwrap_err();assert!(error.to_string().contains("imagePaint"));assert_eq!(before.nodes[ID].name,"Original");
}

#[test]
fn baked_export_converts_scaled_leaves_the_default_export_refuses(){
 let mut doc=interop::import_sketch_report(&archive(json!({"_class":"rectangle","do_objectID":ID,"name":"Scaled","frame":{"x":10,"y":5,"width":40,"height":40},"style":{"fills":[{"isEnabled":true,"fillType":0,"color":{"red":0,"green":0,"blue":1,"alpha":1}}]}}))).unwrap().document;
 let node=doc.nodes.get_mut(ID).unwrap();
 node.transform=futureox_design_kernel::math::Transform([2.,0.,0.,1.,10.,5.]);
 assert!(interop::export_sketch(&doc).is_err(),"default export must keep refusing scaled placements");
 let (bytes,baked)=interop::export_sketch_baked(&doc).unwrap();
 assert_eq!(baked,1,"exactly the scaled leaf is baked");
 let back=interop::import_sketch(&bytes).unwrap();
 let baked_node=back.nodes.values().find(|n|n.name=="Scaled").expect("baked node reimported");
 // World geometry is preserved: 40x40 with scaleX 2 becomes an 80-wide
 // explicit vector at the same world origin.
 assert!((baked_node.width-80.).abs()<1e-6,"width {}",baked_node.width);
 assert!((baked_node.height-40.).abs()<1e-6,"height {}",baked_node.height);
 assert!((baked_node.transform.0[4]-10.).abs()<1e-6,"x {}",baked_node.transform.0[4]);
 assert!((baked_node.transform.0[5]-5.).abs()<1e-6,"y {}",baked_node.transform.0[5]);
}

#[test]
fn baked_export_collapses_independent_stroke_topology(){
 use futureox_design_kernel::vector_geometry::{Curve,VectorGeometry};
 let mut doc=interop::import_sketch_report(&archive(json!({"_class":"rectangle","do_objectID":ID,"name":"Stroked","frame":{"x":0,"y":0,"width":40,"height":40},"style":{"fills":[{"isEnabled":true,"fillType":0,"color":{"red":0,"green":1,"blue":0,"alpha":1}}]}}))).unwrap().document;
 let node=doc.nodes.get_mut(ID).unwrap();
 let fill=vec![Curve::Move([0.,0.]),Curve::Line([40.,0.]),Curve::Line([40.,40.]),Curve::Line([0.,40.]),Curve::Close];
 node.kind="vector".into();
 node.vector_geometry=Some(std::sync::Arc::new(VectorGeometry{fill_rule:"nonzero".into(),fill:fill.clone(),stroke:Some(vec![Curve::Move([5.,5.]),Curve::Line([35.,5.]),Curve::Close])}));
 assert!(interop::export_sketch(&doc).is_err(),"default export keeps refusing independent stroke topology");
 let (bytes,baked)=interop::export_sketch_baked(&doc).unwrap();
 assert_eq!(baked,1,"the independent stroke collapses onto the fill outline");
 interop::import_sketch(&bytes).unwrap();
}

#[test]
fn baked_export_propagates_container_scale_losslessly(){
 // A frame scaled 2x containing a 40x40 rect: the frame keeps its identity
 // (box doubled), the child absorbs the scale and is baked to an 80-wide
 // explicit vector, preserving the world geometry exactly.
 let mut doc=interop::import_sketch_report(&archive(json!({"_class":"frame","do_objectID":ID,"name":"Holder","frame":{"x":100,"y":50,"width":40,"height":40},
   "style":{"fills":[{"isEnabled":true,"fillType":0,"color":{"red":1,"green":1,"blue":0,"alpha":1}}]},
   "layers":[{"_class":"rectangle","do_objectID":"c1","name":"Inner","frame":{"x":0,"y":0,"width":40,"height":40},
     "style":{"fills":[{"isEnabled":true,"fillType":0,"color":{"red":0,"green":0,"blue":1,"alpha":1}}]}}]}))).unwrap().document;
 let frame=doc.nodes.get_mut(ID).unwrap();
 frame.transform=futureox_design_kernel::math::Transform([2.,0.,0.,2.,100.,50.]);
 assert!(interop::export_sketch(&doc).is_err(),"default export refuses the scaled container");
 let (bytes,baked)=interop::export_sketch_baked(&doc).unwrap();
 assert!(baked>=2,"container and child are adjusted: {baked}");
 let back=interop::import_sketch(&bytes).unwrap();
 let holder=back.nodes.values().find(|n|n.name=="Holder").unwrap();
 let inner=back.nodes.values().find(|n|n.name=="Inner").unwrap();
 // Frame box doubles under scaleX/Y=2; the child's world footprint is the
 // same 80x80 region at the same origin.
 assert!((holder.width-80.).abs()<1e-6,"holder width {}",holder.width);
 assert!((holder.height-80.).abs()<1e-6);
 assert!((inner.width-80.).abs()<1e-6,"inner width {}",inner.width);
 // The child stays frame-local; its world origin is holder.x + 0 = 100.
 assert!(inner.transform.0[4].abs()<1e-6,"inner local x {}",inner.transform.0[4]);
 assert!(inner.transform.0[5].abs()<1e-6,"inner local y {}",inner.transform.0[5]);
 assert!((holder.transform.0[4]-100.).abs()<1e-6,"holder x {}",holder.transform.0[4]);
 assert!((holder.transform.0[5]-50.).abs()<1e-6,"holder y {}",holder.transform.0[5]);
}
