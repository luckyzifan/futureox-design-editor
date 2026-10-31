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
fn solid_color_alpha_and_context_opacity_are_distinct_native_channels(){
 for blend in [0,16,17] {
  let mut input=base();input["style"]["fills"][0]["color"]["alpha"]=json!(0.25);
  input["style"]["fills"][0]["contextSettings"]=json!({"opacity":0.5,"blendMode":blend});
  let doc=interop::import_sketch_report(&archive(input)).unwrap().document;
  assert_eq!(doc.nodes[ID].fills[0].opacity,0.5);
  let native=layer(&interop::export_sketch(&doc).unwrap());
  assert_eq!(native["style"]["fills"][0]["color"]["alpha"],0.25);
  assert_eq!(native["style"]["fills"][0]["contextSettings"]["opacity"],0.5);
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
