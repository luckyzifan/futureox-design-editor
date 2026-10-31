use futureox_design_kernel::{Engine, RenderOptions, View, fidelity::RasterProfile, math::{Point,Transform}, path::Command, scene::{Document,Network}, vector_brush::{VectorBrush,paths}};
use serde_json::json;
fn network(points:&[(f64,f64)],closed:bool)->Network{
    serde_json::from_value(json!({"vertices":points.iter().enumerate().map(|(i,(x,y))|json!({"id":i.to_string(),"x":x,"y":y})).collect::<Vec<_>>(),"edges":(0..points.len()-usize::from(!closed)).map(|i|json!({"id":format!("e{i}"),"from":i.to_string(),"to":((i+1)%points.len()).to_string()})).collect::<Vec<_>>(),"fillRule":"nonzero"})).unwrap()
}
fn brush()->VectorBrush{VectorBrush{source:network(&[(-2.,-1.),(2.,-1.),(2.,1.),(-2.,1.)],true),mode:"scatter".into(),width:4.,spacing:10.,seed:0,rotation:0.,rotation_variance:0.,scale_variance:0.,scatter:0.,follow_tangent:true}}
fn fixture(b:VectorBrush,g:Network)->Document{serde_json::from_value(json!({"schemaVersion":15,"id":"d","name":"Brush","pages":[{"id":"p","name":"P","background":"#ffffff","children":["n"]}],"nodes":{"n":{"id":"n","kind":"vector","width":40,"height":20,"transform":[1,0,0,1,16,24],"fills":[{"kind":"solid","color":"#426bdf"}],"network":g,"vectorBrush":b}}})).unwrap()}
#[test]
fn straight_stretch_is_affine_and_preserves_source_cubics(){
    let mut b=brush();b.mode="stretch".into();b.source.edges[0].c1=Some(Point::new(-1.,-1.));b.source.edges[0].c2=Some(Point::new(1.,-1.));
    let p=paths(&network(&[(-10.,5.),(30.,5.)],false),&b).unwrap();
    assert!(p.commands.iter().any(|c|matches!(c,Command::Cubic(..))));
    let c=p.flatten(Transform::default(),0.001).unwrap();assert!(c.iter().flat_map(|c|&c.points).all(|p|p.x>=-10.&&p.x<=30.&&p.y>=3.&&p.y<=7.));
}
#[test]
fn scatter_is_seeded_and_closed_guides_do_not_duplicate_seam(){
    let g=network(&[(0.,0.),(10.,0.),(10.,10.),(0.,10.)],true);let mut b=brush();
    let p=paths(&g,&b).unwrap();assert_eq!(p.commands.iter().filter(|c|matches!(c,Command::Move(_))).count(),4);
    b.rotation_variance=1.;b.scale_variance=0.4;b.scatter=3.;let p=paths(&g,&b).unwrap();assert_eq!(p,paths(&g,&b).unwrap());b.seed=1;assert_ne!(p,paths(&g,&b).unwrap());
}
#[test]
fn curved_scatter_preserves_beziers_and_curved_stretch_is_explicitly_rejected(){
    let mut g=network(&[(0.,0.),(40.,0.)],false);g.edges[0].c1=Some(Point::new(0.,40.));g.edges[0].c2=Some(Point::new(40.,40.));
    let mut b=brush();b.source.edges[0].c1=Some(Point::new(-1.,-1.));b.source.edges[0].c2=Some(Point::new(1.,-1.));assert!(paths(&g,&b).unwrap().commands.iter().any(|c|matches!(c,Command::Cubic(..))));
    b.mode="stretch".into();assert!(paths(&g,&b).unwrap_err().contains("Curved Stretch"));
    assert!(paths(&network(&[(0.,0.),(10.,0.),(0.,0.)],false),&b).unwrap_err().contains("cusps"));
}
#[test]
fn invalid_input_and_budgets_are_errors(){let g=network(&[(0.,0.),(100.,0.)],false);let mut b=brush();b.spacing=0.001;assert!(paths(&g,&b).unwrap_err().contains("budget"));b.spacing=10.;b.width=f64::NAN;assert!(paths(&g,&b).is_err());b.width=4.;b.source.vertices[0].x=f64::INFINITY;assert!(paths(&g,&b).is_err());assert!(paths(&network(&[(0.,0.),(0.,0.)],false),&brush()).is_err());}
#[test]
fn source_guide_seed_survive_roundtrip_and_cpu_pixels_and_hit_use_derived_geometry(){
    let d=fixture(brush(),network(&[(0.,0.),(40.,0.)],false));d.validate().unwrap();let json=serde_json::to_string(&d).unwrap();let reopened:Document=serde_json::from_str(&json).unwrap();assert_eq!(d,reopened);
    let options=RenderOptions{page_id:"p".into(),width:80,height:48,view:View{x:0.,y:0.,zoom:1.},transparent:true,grid:false,pixel_preview:None,animation:None,raster_profile:RasterProfile::FigmaSoftware,interactive_effects:false,checkerboard:false};
    let mut e=Engine::new();e.load_document(&json).unwrap();let rgba=e.render(&options).unwrap();assert!(rgba.chunks_exact(4).any(|p|p[3]>0));
    let mut e2=Engine::new();e2.load_document(&serde_json::to_string(&reopened).unwrap()).unwrap();assert_eq!(rgba,e2.render(&options).unwrap());
    let n=&d.nodes["n"];
    let svg=futureox_design_kernel::export::svg_paths(n,&futureox_design_kernel::font::Fonts::new()).unwrap();assert!(svg.fill.matches('M').count()>=5);
    let mut zoom=options.clone();zoom.view.zoom=32.;zoom.view.x=-14.*32.;zoom.view.y=-22.*32.;let pixels=e.render(&zoom).unwrap();assert!(pixels.chunks_exact(4).any(|p|p[3]>0));
assert!(futureox_design_kernel::hit_test_fill_device(n,Point::new(0.,1.),Transform::default()).unwrap());assert!(!futureox_design_kernel::hit_test_fill_device(n,Point::new(5.,1.),Transform::default()).unwrap());
}
#[test]
fn closed_cubic_seam_count_is_certified_or_explicitly_rejected(){
    let mut g=network(&[(0.,0.),(100.,0.)],true);g.edges[0].c1=Some(Point::new(0.,100.));g.edges[0].c2=Some(Point::new(100.,100.));let mut b=brush();b.spacing=100.;
    match paths(&g,&b){Ok(p)=>assert_eq!(p.commands.iter().filter(|c|matches!(c,Command::Move(_))).count(),3),Err(e)=>assert!(e.contains("seam count is ambiguous"))}
    b.spacing=97.;let p=paths(&g,&b).unwrap();assert_eq!(p.commands.iter().filter(|c|matches!(c,Command::Move(_))).count(),4);
}
#[test]
fn embedded_source_identifiers_and_faces_are_validated_at_native_boundary(){
    let g=network(&[(0.,0.),(40.,0.)],false);
    let mut b=brush();b.source.edges[1].id=b.source.edges[0].id.clone();assert!(paths(&g,&b).unwrap_err().contains("identifiers"));
    let mut b=brush();b.source.vertices[0].id=String::new();assert!(paths(&g,&b).is_err());
    let mut b=brush();b.source.filled_faces=Some(vec![vec!["missing".into()]]);assert!(paths(&g,&b).unwrap_err().contains("fill faces"));
    let mut b=brush();b.source.filled_faces=Some(vec![vec![];4097]);assert!(paths(&g,&b).is_err());
    let mut value=serde_json::to_value(brush()).unwrap();for seed in [json!(-1),json!(0.5),json!(4294967296u64)]{value["seed"]=seed;assert!(serde_json::from_value::<VectorBrush>(value.clone()).is_err())}
}
#[test]
fn sketch_export_rejects_brush_instead_of_serializing_only_guide(){
    let d=fixture(brush(),network(&[(0.,0.),(40.,0.)],false));
    let error=futureox_design_kernel::interop::export_sketch(&d).unwrap_err().to_string();
    assert!(error.contains("vector brush"));assert!(error.contains("native FD"));assert!(error.contains("bake"));
    let restored:Document=serde_json::from_slice(&serde_json::to_vec(&d).unwrap()).unwrap();
    assert_eq!(restored,d);assert!(futureox_design_kernel::interop::export_sketch(&restored).is_err());
}
#[test]
fn scatter_midpoint_matches_analytic_cubic_position_at_3200_percent(){
    let mut g=network(&[(0.,0.),(100.,0.)],false);g.edges[0].c1=Some(Point::new(0.,100.));g.edges[0].c2=Some(Point::new(100.,100.));
    let mut b=brush();b.spacing=100.;let p=paths(&g,&b).unwrap();
    let starts:Vec<_>=p.commands.iter().filter_map(|c|if let Command::Move(p)=c{Some(*p)}else{None}).collect();
    assert!(starts.len()>=2);let midpoint=starts[1];
    // The artwork's first corner is (-4,-2) relative to the station center.
    assert!((midpoint.x-46.).hypot(midpoint.y-73.)*32.<0.001);
}
