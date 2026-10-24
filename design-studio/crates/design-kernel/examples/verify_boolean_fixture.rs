//! Independent fill oracle for a private real-source Boolean fixture.
use futureox_design_kernel::{boolean::Operation,curve_boolean,math::{Point,Transform},path::{Contour,winding},scene::Document};
fn near(p:Point,c:&[Contour])->bool{c.iter().any(|c|c.points.iter().copied().zip(c.points.iter().copied().cycle().skip(1)).take(c.points.len()).any(|(a,b)|{let ab=b-a;let d=ab.x*ab.x+ab.y*ab.y;let t=if d==0.{0.}else{(((p-a).x*ab.x+(p-a).y*ab.y)/d).clamp(0.,1.)};(p-(a+ab*t)).length()<=0.002}))}
fn main()->Result<(),Box<dyn std::error::Error>>{
 let file=std::env::args().nth(1).ok_or("fixture path required")?;let id=std::env::args().nth(2).ok_or("Boolean id required")?;
 let mut doc:Document=serde_json::from_reader(std::fs::File::open(file)?)?;let source=doc.clone();let root=&source.nodes[&id];let op=root.boolean_operation.ok_or("Boolean required")?;
 let inputs:Vec<_>=root.children.iter().filter(|id|source.nodes[*id].visible).map(|id|{let n=&source.nodes[id];Ok((n.paths()?.0.flatten(n.transform,0.00001)?,n.fill_even_odd()))}).collect::<Result<_,String>>()?;
 doc.pages[0].children=vec![id.clone()];for p in doc.pages.iter_mut().skip(1){p.children.clear();}
 let at=std::time::Instant::now();curve_boolean::resolve(&mut doc)?;let node=&doc.nodes[&id];let output=node.paths()?.0.flatten(Transform::default(),0.00001)?;
 let bounds=inputs.iter().flat_map(|(c,_)|c.iter().flat_map(|c|c.points.iter())).fold([f64::INFINITY,f64::INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY],|b,p|[b[0].min(p.x),b[1].min(p.y),b[2].max(p.x),b[3].max(p.y)]);
 let fill=|p,c:&[Contour],even|{let w=winding(p,c);if even{w.abs()%2!=0}else{w!=0}};let(mut compared,mut excluded,mut mismatches)=(0,0,0);
 for y in 0..43{for x in 0..41{let p=Point::new(bounds[0]+(x as f64+0.371)*(bounds[2]-bounds[0])/41.,bounds[1]+(y as f64+0.619)*(bounds[3]-bounds[1])/43.);if inputs.iter().any(|(c,_)|near(p,c)){excluded+=1;continue}
 let states:Vec<_>=inputs.iter().map(|(c,e)|fill(p,c,*e)).collect();let expected=match op{Operation::Union=>states.iter().any(|x|*x),Operation::Intersect=>states.iter().all(|x|*x),Operation::Subtract=>states[0]&&!states[1..].iter().any(|x|*x),Operation::Exclude=>states.iter().filter(|x|**x).count()%2!=0,_=>unreachable!("This oracle exercises the four CSG operations")};compared+=1;if fill(p,&output,node.fill_even_odd())!=expected{mismatches+=1;}
 }}
 for id in &root.children{assert_eq!(doc.nodes[id],source.nodes[id]);}
 println!("{}",serde_json::json!({"ms":at.elapsed().as_secs_f64()*1000.,"compared":compared,"boundaryExcluded":excluded,"mismatches":mismatches,"operationRetained":node.boolean_operation==Some(op),"curveCommands":node.vector_geometry.as_ref().map(|g|g.fill.len()),"networkEdges":node.network.as_ref().map(|g|g.edges.len())}));
 assert!(compared>1700);assert_eq!(mismatches,0);Ok(())
}
