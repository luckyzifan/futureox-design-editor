use futureox_design_kernel::scene::{Document,MAX_GRADIENT_STOPS};
use serde_json::json;
fn document(count:usize)->Document {
 serde_json::from_value(json!({"schemaVersion":16,"colorManagement":futureox_design_kernel::color::ColorSettings::default(),"id":"d","name":"gradient","pages":[{"id":"p","name":"p","background":"#ffffff","children":["n"]}],"nodes":{"n":{"id":"n","kind":"rectangle","width":32,"height":32,"fills":[{"kind":"radial","color":"#ffffff","stops":(0..count).map(|i|json!({"offset":i as f64/(count-1)as f64,"color":if i%2==0{"color(srgb 1 0 0 / 0.5)"}else{"color(srgb 0 1 0 / 1)"}})).collect::<Vec<_>>()}]}}})).unwrap()
}
#[test]fn thirty_six_and_sixty_four_stops_roundtrip_without_truncation(){
 for count in [32,36,MAX_GRADIENT_STOPS]{let doc=document(count);doc.validate().unwrap();let raw=serde_json::to_vec(&doc).unwrap();let again:Document=serde_json::from_slice(&raw).unwrap();assert_eq!(doc,again);assert_eq!(again.nodes["n"].fills[0].stops.len(),count);}
 assert!(document(MAX_GRADIENT_STOPS+1).validate().is_err());
}
#[test]fn gradient_region_chunks_preserve_every_sample_bit_and_domain(){
 use futureox_design_kernel::{math::{Rect,Transform},paint::{gradient_sampling_grid,gradient_sampling_grid_region}};
 for kind in ["linear","radial","angular","diamond"]{let mut paint=document(36).nodes["n"].fills[0].clone();paint.kind=kind.into();paint.angle=23.7;
 for sample in [None,Some(0),Some(1),Some(2),Some(3)]{
  let original=Rect::new(-19,37,37,29);let m=Transform([1.25,0.31,-0.12,0.73,-27.125,22.75]);
  let all=gradient_sampling_grid(original,m,[80.,90.],&paint,sample).unwrap();
  let mut rebuilt=Vec::new();for y in (0..29).step_by(7){rebuilt.extend(gradient_sampling_grid_region(original,Rect::new(-19,37+y,37,(29-y).min(7)as u32),m,[80.,90.],&paint,sample).unwrap());}
  assert_eq!(all.iter().map(|v|v.to_bits()).collect::<Vec<_>>(),rebuilt.iter().map(|v|v.to_bits()).collect::<Vec<_>>());
  assert!(gradient_sampling_grid_region(original,Rect::new(-20,37,1,1),m,[80.,90.],&paint,sample).is_err());
 }}
}
