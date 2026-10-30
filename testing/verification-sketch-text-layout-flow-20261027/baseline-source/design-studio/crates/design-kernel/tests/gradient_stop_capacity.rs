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

#[test]
fn fixed_gradient_axis_fields_preserve_all_parameter_bits_and_original_limits(){
    use futureox_design_kernel::{paint::{gradient_sampling_axes,gradient_sampling_grid},math::{Rect,Transform},scene::Paint};
    let r=Rect::new(-9,-11,41,29);
    for matrix in [Transform::default(),Transform([1.,0.,0.,1.,13.25,-4.5]),Transform([-1.,0.,0.,1.,13.25,-4.5]),Transform([0.,1.,-1.,0.,2.125,3.75])]{
        for angle in [0.,90.,180.,270.]{
            let p:Paint=serde_json::from_value(serde_json::json!({"kind":"linear","color":"#000000","angle":angle,"stops":[{"offset":0.,"color":"#ffffff"},{"offset":0.5,"color":"#ffffff"},{"offset":0.5,"color":"#000000"},{"offset":1.,"color":"#000000"}]})).unwrap();
            for sample in [None,Some(0),Some(1),Some(2),Some(3)]{
                let dense=gradient_sampling_grid(r,matrix,[100.,80.],&p,sample).unwrap();
                let axes=gradient_sampling_axes(r,matrix,[100.,80.],&p,sample).unwrap();assert!(!axes.is_empty());
                let(w,h)=(axes[0]as usize,axes[1]as usize);assert!(w==1||h==1);
                for y in 0..r.h as usize{for x in 0..r.w as usize{for c in 0..4{
                    let compact=axes[4+(if h==1{0}else{y}*w+if w==1{0}else{x})*4+c];
                    assert_eq!(compact.to_bits(),dense[(y*r.w as usize+x)*4+c].to_bits());
                }}}
            }
        }
    }
    let p:Paint=serde_json::from_value(serde_json::json!({"kind":"linear","color":"#000000","angle":31})).unwrap();
    assert!(gradient_sampling_axes(r,Transform::default(),[100.,80.],&p,None).unwrap().is_empty());
    let large=Rect::new(0,0,4097,1024);
    assert!(gradient_sampling_axes(large,Transform::default(),[100.,80.],&p,None).unwrap().is_empty());
    assert!(gradient_sampling_grid(large,Transform::default(),[100.,80.],&p,None).unwrap_err().contains("64 MiB"));
}

#[test]
fn logged_topology_gradient_uses_a_bounded_axis_without_admitting_an_oversized_dense_field(){
    use futureox_design_kernel::{paint::{gradient_sampling_axes,gradient_sampling_grid},math::{Rect,Transform},scene::Paint};
    let original=Rect::new(-668,-668,3046,2373);
    let matrix=Transform([55.638927065523575,0.,0.,55.638927065523575,-2767.135138342918,-968.0845931622657]);
    let paint:Paint=serde_json::from_value(json!({"kind":"linear","color":"#000000","angle":0,
        "transform":[0.3129131610576916,0,0,0.3129131610576916,0.3471304086538467,0.4647264751940776],
        "stops":[{"offset":0,"color":"#ffffff"},{"offset":0.5,"color":"#111111"},{"offset":1,"color":"#000000"}]})).unwrap();
    for sample in [None,Some(0),Some(1),Some(2),Some(3)] {
        let axis=gradient_sampling_axes(original,matrix,[130.,48.],&paint,sample).unwrap();
        assert_eq!(&axis[..4],&[3046.,1.,0.,0.]);
        assert_eq!(axis.len(),4+3046*4);
        // Independently use the unchanged dense sampler at several scanlines.
        // The original affine/fixed-point coefficients are invariant for this
        // logged axis-aligned transform; compare every resulting IEEE word.
        for y in [-668,-137,699,1704] {
            let row=gradient_sampling_grid(Rect::new(-668,y,3046,1),matrix,[130.,48.],&paint,sample).unwrap();
            assert_eq!(axis[4..].iter().map(|v|v.to_bits()).collect::<Vec<_>>(),row.iter().map(|v|v.to_bits()).collect::<Vec<_>>());
        }
        assert!(gradient_sampling_grid(original,matrix,[130.,48.],&paint,sample).unwrap_err().contains("64 MiB"));
    }
}
