use futureox_design_kernel::{math::{Rect,Transform},paint::{gradient_sampling_axes,gradient_sampling_grid},scene::Paint};
use serde_json::json;
fn paint(transform:[f64;6])->Paint{serde_json::from_value(json!({"kind":"linear","color":"#000000","transform":transform,"stops":[
 {"offset":0,"color":"#000000"},{"offset":0.5-2f64.powi(-45),"color":"#ffffff"},
 {"offset":0.5+2f64.powi(-45),"color":"#ffffff"},{"offset":1,"color":"#ffffff"}]})).unwrap()}
#[test]fn distant_topology_axes_keep_every_original_binary32_parameter(){
 let mut cases=0;
 for origin in [[729081,425465],[-729081,-425465],[32769,32769]]{
  for mirror in [-1.,1.]{for swap in [false,true]{for zero in [0.,-0.]{
   let rect=Rect::new(origin[0],origin[1],31,29);
   let matrix=Transform([64.*mirror,zero,zero,64.*mirror,origin[0] as f64-510.,origin[1] as f64-810.]);
   let paint=paint(if swap{[zero,1.,-1.,zero,1.,0.]}else{[1.,zero,zero,1.,0.,0.]});
   for sample in [None,Some(0),Some(1),Some(2),Some(3)]{
    let dense=gradient_sampling_grid(rect,matrix,[1037.065673828125,574.8040771484375],&paint,sample).unwrap();
    let compact=gradient_sampling_axes(rect,matrix,[1037.065673828125,574.8040771484375],&paint,sample).unwrap();
    assert!(!compact.is_empty());let w=compact[0] as usize;let h=compact[1] as usize;assert!(w==1||h==1);
    for y in 0..rect.h as usize{for x in 0..rect.w as usize{for k in 0..4{
     assert_eq!(dense[(y*rect.w as usize+x)*4+k].to_bits(),compact[4+((if h==1{0}else{y})*w+if w==1{0}else{x})*4+k].to_bits());
    }}}
    cases+=1;
   }
  }}}
 }
 assert_eq!(cases,120);
}
#[test]fn rotated_maps_and_zero_sign_crossings_keep_dense_fallback(){
 let rect=Rect::new(40000,40000,32,32);let p=paint([0.,1.,-1.,0.,1.,0.]);
 for matrix in [Transform([64.,1.,0.,64.,39000.,39000.]),Transform([64.,0.,0.,64.,40016.,39000.])]{
  assert!(gradient_sampling_axes(rect,matrix,[100.,100.],&p,None).unwrap().is_empty());
 }
}
