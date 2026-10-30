use futureox_design_kernel::{boolean::Operation,curve_boolean,math::{Point,Transform},path::{Contour,winding},scene::Document};

fn away_from_boundary(point:Point,contours:&[Contour])->bool {
    contours.iter().all(|c|c.points.iter().copied().zip(c.points.iter().copied().cycle().skip(1)).take(c.points.len()).all(|(a,b)|{
        let ab=b-a;let denominator=ab.x*ab.x+ab.y*ab.y;
        let t=if denominator==0. {0.}else{(((point-a).x*ab.x+(point-a).y*ab.y)/denominator).clamp(0.,1.)};
        (point-(a+ab*t)).length()>0.002
    }))
}

#[test]
fn coincident_ray_order_is_total_and_matches_independent_winding_for_all_operations(){
    // Reduced from the real source failure; the old flo_curves comparator
    // panics on this geometry. Independent polygon winding is the oracle.
    let source:Document=serde_json::from_str(include_str!("fixtures/boolean-ray-order.json")).unwrap();
    let root=&source.nodes["result"];
    let operands:Vec<_>=root.children.iter().map(|id|{let n=&source.nodes[id];(n.paths().unwrap().0.flatten(n.transform,0.00001).unwrap(),n.fill_even_odd())}).collect();
    let filled=|p:Point,c:&[Contour],evenodd:bool|{let w=winding(p,c);if evenodd{w.abs()%2!=0}else{w!=0}};
    for op in [Operation::Union,Operation::Intersect,Operation::Subtract,Operation::Exclude]{
        let mut doc=source.clone();doc.nodes.get_mut("result").unwrap().boolean_operation=Some(op);
        curve_boolean::resolve(&mut doc).unwrap();doc.validate().unwrap();
        let node=&doc.nodes["result"];let output=node.paths().unwrap().0.flatten(Transform::default(),0.00001).unwrap();
        let mut compared=0;
        for y in 0..96{for x in 0..96{
            let p=Point::new((x as f64+0.371)*root.width/96.,(y as f64+0.619)*root.height/96.);
            if !operands.iter().all(|(c,_)|away_from_boundary(p,c)){continue}
            let states:Vec<_>=operands.iter().map(|(c,e)|filled(p,c,*e)).collect();
            let expected=match op{Operation::Union=>states.iter().any(|x|*x),Operation::Intersect=>states.iter().all(|x|*x),Operation::Subtract=>states[0]&&!states[1..].iter().any(|x|*x),Operation::Exclude=>states.iter().filter(|x|**x).count()%2!=0,_=>unreachable!("This oracle exercises the four CSG operations")};
            assert_eq!(filled(p,&output,node.fill_even_odd()),expected,"operation {op:?}, sample {x},{y}");compared+=1;
        }}
        assert!(compared>9000,"boundary exclusion must stay narrow");
        for id in &root.children{assert_eq!(doc.nodes[id],source.nodes[id]);}
    }
}
