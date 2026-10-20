//! Region-based Shape Builder. Geometry uses the same cubic intersection graph
//! and 0.001 world-unit tolerance as live curve Booleans, never polygon flattening.
use crate::{curve_boolean, math::Transform, scene::{Network, Node}};
use flo_curves::{bezier::path::*};
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, collections::BTreeSet};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Region { pub id: String, pub sources: Vec<usize>, pub network: Network }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub nodes: Vec<Node>,
    #[serde(default)] pub region_ids: Vec<String>,
    #[serde(default)] pub mode: Mode,
}
#[derive(Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode { #[default] Partition, Merge, Erase }
#[derive(Serialize)]
pub struct Response { pub regions: Vec<Region>, pub networks: Vec<Network> }

fn components(mut paths: Vec<SimpleBezierPath>) -> Vec<Vec<SimpleBezierPath>> {
    // Stable ordering independent of graph traversal. Control-hull bounds are
    // used only for ordering; region membership uses analytic cubic ray casts.
    let key = |p: &SimpleBezierPath| {
        let mut x = p.0.0; let mut y = p.0.1;
        for (a,b,c) in &p.1 { for q in [a,b,c] { x = x.min(q.0); y = y.min(q.1); } }
        (x,y)
    };
    paths.sort_by(|a,b| { let a=key(a); let b=key(b); a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)) });
    let nesting: Vec<Vec<usize>> = paths.iter().enumerate().map(|(i,p)| paths.iter().enumerate()
        .filter_map(|(j,q)| (i!=j && path_contains_point(q, &p.0)).then_some(j)).collect()).collect();
    let mut result = Vec::new();
    for i in 0..paths.len() {
        if nesting[i].len()%2 != 0 { continue }
        let mut component=vec![paths[i].clone()];
        for j in 0..paths.len() {
            if nesting[j].len()==nesting[i].len()+1 && nesting[j].contains(&i) { component.push(paths[j].clone()); }
        }
        result.push(component);
    }
    result
}

pub fn partition(nodes: &[Node]) -> Result<Vec<Region>, String> {
    if nodes.is_empty() || nodes.len()>16 { return Err("Shape Builder requires 1–16 shapes".into()) }
    let mut paths=Vec::new(); let mut rules=Vec::new(); let mut edges=0;
    for n in nodes {
        if !n.width.is_finite() || !n.height.is_finite() || n.width <= 0. || n.height <= 0. { return Err("Shape Builder requires positive finite dimensions".into()) }
        if n.locked || n.mask || n.mask_type.is_some() || !n.children.is_empty() || !n.visible {
            return Err("Shape Builder requires visible, unlocked, unmasked leaf shapes".into())
        }
        if !matches!(n.kind.as_str(), "rectangle"|"ellipse"|"polygon"|"star"|"vector") || n.boolean_operation.is_some() {
            return Err("Shape Builder requires closed shapes or vectors".into())
        }
        if n.strokes.iter().any(|s| s.visible && s.width>0.) { return Err("Outline visible strokes before Shape Builder".into()) }
        if n.repeat.is_some() { return Err("Bake repeat transforms before Shape Builder".into()) }
        if n.vector_brush.is_some() { return Err("Bake vector brushes before Shape Builder".into()) }
        if n.path_offset!=0. { return Err("Bake path offsets before Shape Builder".into()) }
        if n.transform.0.iter().any(|v| !v.is_finite()) || (n.transform.0[0]*n.transform.0[3]-n.transform.0[1]*n.transform.0[2]).abs()<1e-12 {
            return Err("Shape Builder requires finite, invertible transforms".into())
        }
        let (fill, stroke)=n.paths()?;
        // Reject open contours instead of silently dropping their edges.
        curve_boolean::curves(&stroke, n.transform)?;
        let p=curve_boolean::curves(&fill,n.transform)?;
        if p.iter().any(|(start,segments)| std::iter::once(start).chain(segments.iter().flat_map(|(a,b,c)|[a,b,c])).any(|q| !q.0.is_finite() || !q.1.is_finite() || q.0.abs()>1e8 || q.1.abs()>1e8)) { return Err("Shape Builder coordinates exceed finite geometry limits".into()) }
        edges += p.iter().map(|p|p.1.len()).sum::<usize>();
        if p.is_empty() { return Err("Shape Builder input has no closed filled region".into()) }
        paths.push(p); rules.push(n.network.as_ref().is_none_or(|g|g.fill_rule=="evenodd"));
    }
    if edges>8192 { return Err("Shape Builder exceeds 8192 source segments".into()) }
    let mut graph=GraphPath::new();
    for (i,paths) in paths.iter().enumerate() {
        let mut operand=GraphPath::from_merged_paths(paths.iter().map(|p|(p,PathLabel(i as u32))));
        operand.self_collide(0.001);
        graph=if i==0 { graph.merge(operand) } else { graph.collide(operand,0.001) };
    }
    graph.round(0.001);
    let membership=|counts:&[i32]| -> u16 { rules.iter().enumerate().fold(0,|mask,(i,evenodd)| {
        let w=counts.get(i).copied().unwrap_or(0);
        if if *evenodd { w.abs()%2!=0 } else { w!=0 } { mask|(1<<i) } else { mask }
    }) };
    let masks=RefCell::new(BTreeSet::new());
    graph.set_edge_kinds_by_ray_casting(|counts| { let mask=membership(counts); if mask!=0 { masks.borrow_mut().insert(mask); } mask!=0 });
    if masks.borrow().len()>256 { return Err("Shape Builder exceeds 256 regions".into()) }
    let mut regions=Vec::new(); let mut output_edges=0;
    for mask in masks.into_inner() {
        let mut region_graph=graph.clone();
        region_graph.reset_edge_kinds();
        region_graph.set_edge_kinds_by_ray_casting(|counts|membership(counts)==mask);
        region_graph.heal_exterior_gaps();
        let paths:Vec<SimpleBezierPath>=region_graph.exterior_paths();
        for (component,paths) in components(paths).into_iter().enumerate() {
            output_edges+=paths.iter().map(|p|p.1.len()).sum::<usize>();
            if regions.len()>=256 || output_edges>10000 { return Err("Shape Builder region output budget exceeded".into()) }
            regions.push(Region { id:format!("{mask}:{component}"), sources:(0..nodes.len()).filter(|i|mask&(1<<i)!=0).collect(), network:curve_boolean::network(paths) });
        }
    }
    if regions.is_empty() { return Err("Shape Builder found no nondegenerate regions".into()) }
    Ok(regions)
}

pub fn execute(request: Request) -> Result<Response,String> {
    let regions=partition(&request.nodes)?;
    if request.mode==Mode::Partition { return Ok(Response { regions, networks:vec![] }) }
    let selected:BTreeSet<_>=request.region_ids.iter().collect();
    if selected.is_empty() || selected.iter().any(|id|!regions.iter().any(|r|&r.id==*id)) {
        return Err("Select valid Shape Builder region IDs from the current geometry".into())
    }
    let mut networks=regions.iter().filter(|r|!selected.contains(&r.id)).map(|r|r.network.clone()).collect::<Vec<_>>();
    if request.mode==Mode::Merge {
        let inputs=regions.iter().filter(|r|selected.contains(&r.id)).map(|r|Ok((r.network.paths()?.0,Transform::default(),true))).collect::<Result<Vec<_>,String>>()?;
        networks.push(curve_boolean::combine(&inputs,crate::boolean::Operation::Union)?);
    }
    Ok(Response { regions, networks })
}

pub fn json(json:&str)->Result<String,String> {
    let request=serde_json::from_str(json).map_err(|e|format!("Invalid Shape Builder request: {e}"))?;
    serde_json::to_string(&execute(request)?).map_err(|e|e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rect(id:&str,x:f64,y:f64,w:f64,h:f64)->Node { serde_json::from_value(serde_json::json!({"id":id,"kind":"rectangle","width":w,"height":h,"transform":[1,0,0,1,x,y]})).unwrap() }
    #[test] fn overlap_regions_merge_erase() {
        let nodes=vec![rect("a",0.,0.,100.,100.),rect("b",50.,0.,100.,100.)];
        let regions=partition(&nodes).unwrap(); assert_eq!(regions.len(),3);
        assert_eq!(regions.iter().map(|r|r.id.as_str()).collect::<Vec<_>>(),vec!["1:0","2:0","3:0"]);
        let merged=execute(Request{nodes:nodes.clone(),region_ids:vec!["1:0".into(),"3:0".into()],mode:Mode::Merge}).unwrap();
        assert_eq!(merged.networks.len(),2);
        let erased=execute(Request{nodes,region_ids:vec!["3:0".into()],mode:Mode::Erase}).unwrap(); assert_eq!(erased.networks.len(),2);
    }
    #[test] fn disconnected_cells_are_individual_regions() {
        let nodes=vec![rect("a",0.,0.,100.,100.),rect("b",40.,-10.,20.,120.)];
        let r=partition(&nodes).unwrap(); assert_eq!(r.iter().filter(|r|r.sources==vec![0]).count(),2);
    }
    #[test] fn holes_are_attached_to_region() {
        let r=partition(&[rect("a",0.,0.,100.,100.),rect("b",25.,25.,50.,50.)]).unwrap();
        assert_eq!(r.len(),2);
        let outer=&r.iter().find(|r|r.sources==vec![0]).unwrap().network;
        let curves=curve_boolean::curves(&outer.paths().unwrap().0,Transform::default()).unwrap();
        assert_eq!(curves.len(),2);
        assert_eq!(curves.iter().filter(|p|path_contains_point(*p,&flo_curves::Coord2(50.,50.))).count()%2,0);
    }
    #[test] fn cubic_controls_and_transforms_are_preserved() {
        let mut a=rect("ellipse",0.,0.,100.,100.); a.kind="ellipse".into();
        a.transform=Transform([1.,0.2,0.3,1.,10.,20.]);
        let regions=partition(&[a,rect("b",50.,0.,100.,150.)]).unwrap();
        assert!(regions.iter().any(|r|r.network.edges.iter().any(|e|e.c1.is_some()&&e.c2.is_some())));
        assert!(regions.iter().all(|r|r.network.vertices.iter().all(|p|p.x.is_finite()&&p.y.is_finite())));
    }
    #[test] fn reject_unsafe_and_degenerate_inputs() {
        let mut a=rect("a",0.,0.,100.,100.); a.locked=true; assert!(partition(&[a.clone()]).is_err());
        a.locked=false; a.mask=true; assert!(partition(&[a.clone()]).is_err());
        a.mask=false; a.transform=Transform([0.;6]); assert!(partition(&[a]).is_err());
        assert!(partition(&[rect("zero",0.,0.,0.,0.)]).is_err());
    }
}

#[cfg(test)]
mod precision_tests {
    use super::*;
    use flo_curves::bezier::{BezierCurve, Curve};
    fn shape(kind:&str)->Node { serde_json::from_value(serde_json::json!({"id":"shape","kind":kind,"width":123.456,"height":78.912,"transform":[1.2,0.3,-0.2,0.9,12.345,67.891]})).unwrap() }
    #[test] fn single_cubic_boundary_deviation_at_3200_percent_is_subpixel() {
        let n=shape("ellipse");
        let original=curve_boolean::curves(&n.paths().unwrap().0,n.transform).unwrap();
        let result=partition(&[n]).unwrap();
        let output=curve_boolean::curves(&result[0].network.paths().unwrap().0,Transform::default()).unwrap();
        let mut maximum:f64=0.;
        for p in &output { for c in path_to_curves::<_,Curve<_>>(p) { for i in 0..=32 {
            let q=c.point_at_pos(i as f64/32.);
            let distance=original.iter().map(|o|path_closest_point(o,&q).2).fold(f64::INFINITY,f64::min);
            maximum=maximum.max(distance);
        } } }
        // Same cubic engine boundary as Boolean, measured at zoom=32, not an
        // exact-conic claim. No extra tessellation tolerance is introduced.
        assert!(maximum*32.<0.1,"3200% boundary error {} px",maximum*32.);
    }
    #[test] fn repeated_partition_has_stable_component_ids_and_geometry() {
        let mut b=shape("rectangle");b.id="second".into();b.transform.0[4]+=30.;
        let nodes=vec![shape("ellipse"),b];
        assert_eq!(serde_json::to_string(&partition(&nodes).unwrap()).unwrap(),serde_json::to_string(&partition(&nodes).unwrap()).unwrap());
    }
}
