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
fn distance_to_contour(path:&futureox_design_kernel::path::Path,point:Point)->f64{
    let flat=path.flatten(Transform::default(),1e-7).unwrap();
    let mut best=f64::MAX;
    for contour in flat{
        for window in contour.points.windows(2){
            let (a,b)=(window[0],window[1]);
            let chord=b-a;let denom=chord.dot(chord).max(1e-30);
            let t=((point-a).dot(chord)/denom).clamp(0.,1.);
            best=best.min((point-a.lerp(b,t)).length());
        }
    }
    best
}
#[test]
fn ordinary_tight_freehand_curve_accepts_stretch_at_brush_width() {
    let points = [
        (0., 139.91392705680448),
        (15.18987341772152, 204.2155475480214),
        (48.10126582278481, 279.66492820627514),
        (75.9493670886076, 235.91273836890232),
        (118.9873417721519, 61.2683070918966),
        (154.43037974683546, 1.267801750654229),
        (184.81012658227849, 75.61230656558757),
        (200., 139.91392705680445),
    ];
    let controls = [
        ((4.887441484154995, 161.38736177833155), (9.72310468327689, 182.8800974733091)),
        ((18.66548578423579, 217.780005407304), (32.22583752549734, 275.5067618855794)),
        ((62.04895641646677, 283.318172464765), (73.31066015201237, 244.35133408680954)),
        ((93.84966636629822, 178.66750710086114), (103.08808619021956, 119.05952905816474)),
        ((121.34717394606005, 52.690698897432156), (136.60751199916672, -9.596085104156629)),
        ((169.64249083010156, 10.540308059468288), (180.6575883182446, 59.405973881820245)),
        ((190.2768953167231, 96.94775664029981), (195.11255851584497, 118.44049233527744)),
    ];
    let mut guide = network(&points, false);
    for (edge, ((x1, y1), (x2, y2))) in guide.edges.iter_mut().zip(controls) {
        edge.c1 = Some(Point::new(x1, y1));
        edge.c2 = Some(Point::new(x2, y2));
    }
    let heist = network(
        &[
            (0., 0.),
            (4., -2.),
            (16., -8.),
            (28., -5.),
            (40., -1.),
            (40., 1.),
            (28., 5.),
            (16., 8.),
            (4., 2.),
        ],
        true,
    );
    for width in [12., 24.] {
        let mut art = brush();
        art.mode = "stretch".into();
        art.width = width;
        art.source = heist.clone();
        let mapped = paths(&guide, &art).unwrap_or_else(|error| panic!("width {width}: {error}"));
        assert!(mapped.commands.len() > 2, "{}", mapped.commands.len());
    }
}
#[test]
fn curved_scatter_preserves_beziers_and_curved_stretch_follows_the_frame(){
    let mut g=network(&[(0.,0.),(40.,0.)],false);g.edges[0].c1=Some(Point::new(0.,40.));g.edges[0].c2=Some(Point::new(40.,40.));
    let mut b=brush();b.source.edges[0].c1=Some(Point::new(-1.,-1.));b.source.edges[0].c2=Some(Point::new(1.,-1.));
    let scatter=paths(&g,&b).unwrap();
    assert!(scatter.commands.iter().any(|c|matches!(c,Command::Cubic(..))));
    assert_eq!(scatter,paths(&g,&b).unwrap());
    b.mode="stretch".into();
    let stretched=paths(&g,&b).unwrap();
    assert!(stretched.commands.iter().any(|c|matches!(c,Command::Cubic(..))),"curved stretch keeps cubic commands");
    assert!(stretched.commands.len()<100_000);
    assert_eq!(stretched.commands,paths(&g,&b).unwrap().commands);
    // Symmetric analytic cubic: length 200, arc midpoint (30,75), tangent +x.
    let mut analytic=network(&[(-20.,0.),(80.,0.)],false);
    analytic.edges[0].c1=Some(Point::new(-20.,100.));analytic.edges[0].c2=Some(Point::new(80.,100.));
    let mut width=b.clone();width.width=2.;
    let mapped=paths(&analytic,&width).unwrap();
    let gap=distance_to_contour(&mapped,Point::new(30.,76.));
    assert!(gap*32.<0.00064,"curved stretch left the 3200% position budget, gap {gap}");
    let cusp_guide=network(&[(0.,0.),(10.,0.),(0.,0.)],false);
    let cusp=paths(&cusp_guide,&width).unwrap();
    assert!(cusp.commands.iter().any(|c|matches!(c,Command::Arc{sweep,..} if (sweep.abs()-std::f64::consts::PI).abs()<1e-6)),"a reversal sweeps +pi");
    assert!(distance_to_contour(&cusp,Point::new(9.,0.))<1e-6,"cusp arc missed the deterministic semicircle");
    assert_eq!(cusp.commands,paths(&cusp_guide,&width).unwrap().commands);
    let corner=paths(&network(&[(0.,0.),(10.,0.),(10.,10.)],false),&width).unwrap();
    for point in [Point::new(0.,1.),Point::new(10.,1.),Point::new(9.,0.),Point::new(9.,10.)]{
        assert!(distance_to_contour(&corner,point)<1e-6,"corner stretch missed {point:?}");
    }
    let closed=paths(&network(&[(0.,0.),(30.,0.),(30.,20.),(0.,20.)],true),&width).unwrap();
    let contours=closed.flatten(Transform::default(),1e-6).unwrap();
    assert!(contours.iter().any(|c|c.closed));
    assert!(closed.commands.iter().filter(|c|matches!(c,Command::Arc{..})).count()>=3);
}
#[test]
fn curved_stretch_render_pick_export_and_gpu_scene_share_one_derived_path(){
    let mut g=network(&[(-20.,0.),(80.,0.)],false);
    g.edges[0].c1=Some(Point::new(-20.,100.));g.edges[0].c2=Some(Point::new(80.,100.));
    let mut b=brush();b.mode="stretch".into();b.width=2.;
    let d=fixture(b,g);d.validate().unwrap();
    let json=serde_json::to_string(&d).unwrap();
    let reopened:Document=serde_json::from_str(&json).unwrap();
    assert_eq!(reopened.nodes["n"].vector_brush,d.nodes["n"].vector_brush);
    let options=RenderOptions{page_id:"p".into(),width:120,height:140,view:View{x:0.,y:0.,zoom:1.},transparent:true,grid:false,pixel_preview:None,animation:None,raster_profile:RasterProfile::FigmaSoftware,interactive_effects:false,checkerboard:false};
    let mut engine=Engine::new();engine.load_document(&json).unwrap();
    let rgba=engine.render(&options).unwrap();
    assert!(rgba.chunks_exact(4).any(|p|p[3]>0),"CPU render of curved stretch is empty");
    let scene=engine.compile_gpu(&options).unwrap();
    assert!(!scene.curves.is_empty(),"official WebGPU scene did not receive curved-stretch crossings");
    let node=&d.nodes["n"];
    let svg=futureox_design_kernel::export::svg_paths(node,&futureox_design_kernel::font::Fonts::new()).unwrap();
    assert!(svg.fill.contains('C')||svg.fill.contains('A'),"SVG dropped the curved stretch outline");
    let pdf=engine.export_pdf_vector(&options).unwrap();
    let pdf=String::from_utf8_lossy(&pdf);
    assert!(pdf.contains(" c ")||pdf.contains("\nc "),"vector PDF dropped the curved stretch cubics");
    assert!(futureox_design_kernel::hit_test_fill_device(node,Point::new(30.,75.),Transform::default()).unwrap());
    assert!(!futureox_design_kernel::hit_test_fill_device(node,Point::new(30.,120.),Transform::default()).unwrap());
    assert!(futureox_design_kernel::interop::export_sketch(&d).is_err());
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
