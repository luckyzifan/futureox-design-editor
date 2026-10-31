//! Non-destructive repeated transforms. Only the source and parameters are authored.
//! The renderer expands a bounded disposable scene; never write it back to storage.
//! Step = T(translation) T(pivot) R(rotation radians) S(scale) T(-pivot).
use crate::{math::{Point, Transform}, scene::{Document, Node}};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
pub const MAX_NODES: usize = 16_384;
pub const MAX_BYTES: usize = 16 * 1024 * 1024;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Repeat {
    /// Total appearances, including the editable source.
    pub count: u32,
    #[serde(deserialize_with = "strict_point")]
    pub translation: Point,
    /// Parent-coordinate pivot; positive radians rotate clockwise in y-down scenes.
    #[serde(deserialize_with = "strict_point")]
    pub pivot: Point,
    pub rotation: f64,
    #[serde(deserialize_with = "strict_point")]
    pub scale: Point,
}
// Strict only for this authored contract; other uses of math::Point retain
// their existing forward-compatible deserialization semantics.
fn strict_point<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Point, D::Error> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct AuthoredPoint { x: f64, y: f64 }
    let point = AuthoredPoint::deserialize(deserializer)?;
    Ok(Point::new(point.x, point.y))
}
impl Repeat {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=256).contains(&self.count)
            || ![self.translation.x,self.translation.y,self.pivot.x,self.pivot.y,self.rotation,self.scale.x,self.scale.y].into_iter().all(f64::is_finite)
            || [self.translation.x,self.translation.y,self.pivot.x,self.pivot.y].into_iter().any(|v| v.abs()>1e7)
            || self.rotation.abs()>std::f64::consts::TAU * 100.
            || !(0.01..=100.).contains(&self.scale.x) || !(0.01..=100.).contains(&self.scale.y) {
            return Err("Invalid repeat parameters (count 1–256, positive scale 0.01–100)".into());
        }
        let mut t=Transform::default();
        for _ in 1..self.count { t=self.step().concat(t); check_transform(t)?; }
        Ok(())
    }
    pub fn step(&self) -> Transform {
        let (s,c)=self.rotation.sin_cos();
        let a=c*self.scale.x; let b=s*self.scale.x; let d=c*self.scale.y; let e=-s*self.scale.y;
        Transform([a,b,e,d,self.translation.x+self.pivot.x-a*self.pivot.x-e*self.pivot.y,
            self.translation.y+self.pivot.y-b*self.pivot.x-d*self.pivot.y])
    }
}
fn check_transform(t:Transform)->Result<(),String>{
    if t.0.iter().any(|v|!v.is_finite() || v.abs()>1e9) || t.inverse().is_err(){return Err("Repeated transform exceeds precision budget".into())} Ok(())
}
pub fn has_repeats(d:&Document)->bool { d.nodes.values().any(|n|n.repeat.is_some()) }
/// Stable non-secret 128-bit identifier; collisions are rejected, never overwrite nodes.
pub fn derived_id(path:&str)->String {
    let mut h=String::new();
    for seed in [2166136261u32,2166136261^0x9e3779b9,2166136261^0x85ebca6b,2166136261^0xc2b2ae35] {
        let mut x=seed; for b in path.bytes(){ x=(x^u32::from(b)).wrapping_mul(16777619); } h.push_str(&format!("{x:08x}"));
    }
    format!("{}-{}-{}-{}-{}",&h[..8],&h[8..12],&h[12..16],&h[16..20],&h[20..])
}
/// Preflight prevents exponential subtree allocation, including nested repeats.
pub fn validate_document(d:&Document)->Result<(),String>{
    if !has_repeats(d){return Ok(())}
    fn walk(d:&Document,id:&str,m:usize,depth:usize,seen:&mut HashSet<String>,nodes:&mut usize,bytes:&mut usize)->Result<(),String>{
        if depth>64 || !seen.insert(id.into()){return Err("Cyclic repeat source".into())}
        let n=d.nodes.get(id).ok_or("Missing repeat source")?;
        if let Some(r)=&n.repeat {
            r.validate()?;
            if n.mask || n.kind == "slice" {return Err("Masks and slices cannot own repeat transforms".into())}
            let mut power=Transform::default(); for _ in 0..r.count {check_transform(power.concat(n.transform))?;power=r.step().concat(power);}
        }
        let m=m.checked_mul(n.repeat.as_ref().map_or(1,|r|r.count as usize)).ok_or("Repeat node budget")?;
        *nodes=nodes.checked_add(m).ok_or("Repeat node budget")?;
        if *nodes>MAX_NODES{return Err("Repeat scene exceeds 16384 nodes".into())}
        let cost=serde_json::to_vec(n).map_err(|e|e.to_string())?.len()+512;
        *bytes=bytes.checked_add(cost.checked_mul(m).ok_or("Repeat byte budget")?).ok_or("Repeat byte budget")?;
        if *bytes>MAX_BYTES{return Err("Repeat scene exceeds 16 MiB".into())}
        for c in &n.children {walk(d,c,m,depth+1,seen,nodes,bytes)?;} Ok(())
    }
    for n in d.nodes.values().filter(|n| n.boolean_operation.is_some()) {
        let mut pending=n.children.clone();let mut seen=HashSet::new();
        while let Some(id)=pending.pop(){if !seen.insert(id.clone()){return Err("Cyclic repeat source".into())}let child=d.nodes.get(&id).ok_or("Missing repeat source")?;if child.repeat.is_some(){return Err("Repeat inside boolean operands requires explicit baking".into())}pending.extend(child.children.clone());}
    }
    let(mut nodes,mut bytes,mut seen)=(0,0,HashSet::new());
    for p in &d.pages {for id in &p.children {walk(d,id,1,0,&mut seen,&mut nodes,&mut bytes)?;}}
    Ok(())
}
/// Atomic expansion on a render snapshot. All expanded nodes have repeat removed.
pub fn resolve(d:&mut Document)->Result<(),String>{
    if !has_repeats(d){return Ok(())} validate_document(d)?;
    fn walk(d:&Document,id:&str,path:&str,out:&mut BTreeMap<String,Node>)->Result<Vec<String>,String>{
        let source=d.nodes.get(id).ok_or("Missing repeat source")?;
        let count=source.repeat.as_ref().map_or(1,|r|r.count);
        let step=source.repeat.as_deref().map_or(Transform::default(),Repeat::step);
        let mut power=Transform::default(); let mut roots=Vec::new();
        for i in 0..count {
            let path=if i==0 {path.to_owned()} else {format!("{path}/{id}:{i}")};
            let new_id=if path.is_empty(){id.into()}else{derived_id(&format!("repeat.v1{path}/{id}"))};
            if !path.is_empty() && d.nodes.contains_key(&new_id){return Err("Repeat identifier collision".into())}
            let mut n=source.clone();n.id=new_id.clone();n.repeat=None;n.repeat_origin=Some(id.into());
            if !path.is_empty(){n.component=None;n.component_set=false;n.component_key=None;n.instance=None;n.instance_origin=None;}n.transform=power.concat(source.transform);check_transform(n.transform)?;
            n.children=Vec::new();for c in &source.children {n.children.extend(walk(d,c,&path,out)?)}
            if out.insert(new_id.clone(),n).is_some(){return Err("Repeat identifier collision".into())}
            roots.push(new_id);power=step.concat(power);
        } Ok(roots)
    }
    let mut nodes=BTreeMap::new();let mut pages=d.pages.clone();
    for p in &mut pages {let roots=p.children.clone();p.children.clear();for id in roots {p.children.extend(walk(d,&id,"",&mut nodes)?);}}
    d.nodes=nodes;d.pages=pages;Ok(())
}

#[cfg(test)]
mod tests {
 use super::*;
 fn params(count:u32)->Repeat {Repeat{count,translation:Point::new(20.,0.),pivot:Point::new(0.,0.),rotation:0.,scale:Point::new(1.,1.)}}
 fn document()->Document {
  let mut d:Document=serde_json::from_value(serde_json::json!({"schemaVersion":15,"id":"repeat-doc","name":"Repeat","pages":[{"id":"page","name":"Page","children":["source"],"background":"#ffffff"}],"nodes":{}})).unwrap();
  let mut n=crate::facet::sample_node("source","rectangle");n.width=10.;n.height=10.;n.repeat=Some((params(3)).into());n.fills=vec![serde_json::from_value(serde_json::json!({"kind":"solid","color":"#ff0000"})).unwrap()];d.nodes.insert(n.id.clone(),n);d
 }
 #[test] fn rejects_unknown_nested_point_keys_in_native_json(){
  for key in ["translation","pivot","scale"] {
   let mut value=serde_json::to_value(params(3)).unwrap();value[key]["ignored"]=serde_json::json!(1);
   assert!(serde_json::from_value::<Repeat>(value).is_err(),"{key}");
  }
 }
 #[test] fn sketch_export_rejects_instead_of_silently_dropping_appearances(){
  let d=document();let before=d.clone();let err=crate::interop::export_sketch(&d).unwrap_err().to_string();
  assert!(err.contains("non-destructive repeated transforms"));assert!(err.contains("native FD/JSON"));assert_eq!(d,before);
 }
 #[test] fn authored_source_round_trip_and_derived_rebuild(){
  let d=document();d.validate().unwrap();let reopened=crate::binfmt::decode(&crate::binfmt::encode(&d)).unwrap();assert_eq!(reopened,d);assert_eq!(reopened.nodes.len(),1);
  let mut derived=d.clone();resolve(&mut derived).unwrap();assert_eq!(derived.nodes.len(),3);assert_eq!(d.nodes.len(),1);assert!(derived.nodes.values().all(|n|n.repeat.is_none()));
  assert_eq!(derived.nodes[&derived.pages[0].children[2]].transform.0[4],40.);
  let mut changed=d.clone();changed.nodes.get_mut("source").unwrap().width=17.;resolve(&mut changed).unwrap();assert!(changed.nodes.values().all(|n|n.width==17.));
 }
 #[test] fn rejects_bad_counts_finites_and_exponential_trees(){
  for count in [0,257,u32::MAX]{assert!(params(count).validate().is_err())}
  let mut r=params(3);r.rotation=f64::NAN;assert!(r.validate().is_err());r=params(256);r.scale.x=100.;assert!(r.validate().is_err());
  assert!(serde_json::from_value::<Repeat>(serde_json::json!({"count":-1,"translation":{"x":0,"y":0},"pivot":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}})).is_err());
  let mut d=document();let mut child=d.nodes["source"].clone();child.id="child".into();child.repeat=Some((params(256)).into());d.nodes.get_mut("source").unwrap().repeat=Some((params(256)).into());d.nodes.get_mut("source").unwrap().children=vec![child.id.clone()];d.nodes.insert(child.id.clone(),child);let before=d.clone();assert!(resolve(&mut d).is_err());assert_eq!(d,before);
 }
 #[test] fn parent_pivot_nested_and_stable_ids(){
  let mut d=document();let n=d.nodes.get_mut("source").unwrap();n.transform=Transform([1.,0.,0.,1.,10.,10.]);n.repeat=Some((Repeat{count:2,translation:Point::new(5.,0.),pivot:Point::new(10.,10.),rotation:std::f64::consts::FRAC_PI_2,scale:Point::new(2.,2.)}).into());
  let mut child=crate::facet::sample_node("child","rectangle");child.repeat=Some((params(2)).into());n.children=vec!["child".into()];d.nodes.insert("child".into(),child);resolve(&mut d).unwrap();assert_eq!(d.nodes.len(),6);
  let t=d.nodes[&d.pages[0].children[1]].transform;assert!((t.0[4]-15.).abs()<1e-12);assert!((t.0[5]-10.).abs()<1e-12);
  assert_eq!(derived_id("repeat.v1/source:1/source"),"edebb2de-f85c-804d-762e-a7bbec2c7091");
 }
 #[test] fn cpu_pixels_match_explicit_reference_and_source_edit(){
  let d=document();let mut expected=d.clone();resolve(&mut expected).unwrap();let options=serde_json::from_value::<crate::RenderOptions>(serde_json::json!({"pageId":"page","width":64,"height":24,"view":{"x":0,"y":0,"zoom":1},"transparent":true})).unwrap();
  let mut engine=crate::Engine::new();engine.load_document(&serde_json::to_string(&d).unwrap()).unwrap();let mut reference=crate::Engine::new();reference.load_document(&serde_json::to_string(&expected).unwrap()).unwrap();assert_eq!(engine.render(&options).unwrap(),reference.render(&options).unwrap());
  let mut edited=d.clone();edited.nodes.get_mut("source").unwrap().width=15.;let patch=crate::editing::DocumentPatch{nodes:BTreeMap::from([("source".into(),Some(edited.nodes["source"].clone()))]),fields:BTreeMap::new()};
  let damage=engine.apply_document_patch_with_damage(&patch).unwrap();assert!(damage.full);resolve(&mut edited).unwrap();reference.load_document(&serde_json::to_string(&edited).unwrap()).unwrap();assert_eq!(engine.render(&options).unwrap(),reference.render(&options).unwrap());
 }
}
