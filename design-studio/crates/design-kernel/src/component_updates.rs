//! One resident derivation snapshot using the existing Document and resolvers.
//! Receipts fence delta application; unknown dependencies use the full path.
use crate::{components,curve_boolean,design_system,editing::DocumentPatch,font::Fonts,layout,scene::{Document,Node}};
use serde::Serialize;
use std::collections::{BTreeMap,BTreeSet};

pub(crate) struct Plan { pub instances:BTreeSet<String>, pub roots:BTreeSet<String> }
fn parents(doc:&Document)->BTreeMap<String,String>{doc.nodes.iter().flat_map(|(id,n)|n.children.iter().map(move|c|(c.clone(),id.clone()))).collect()}
fn ancestors(id:&str,parents:&BTreeMap<String,String>)->Vec<String>{let mut out=vec![id.to_owned()];while let Some(p)=parents.get(out.last().unwrap()){out.push(p.clone());}out}
pub(crate) fn plan(before:&Document,after:&Document)->Result<Option<Plan>,String>{
 let patch=DocumentPatch::between(before,after).map_err(|e|e.to_string())?;
 if !patch.fields.is_empty()||before.id!=after.id||!after.animations.is_empty()||patch.nodes.len()>4096{return Ok(None)}
 if after.nodes.values().any(|n|n.connector.is_some()||n.text_path.is_some()||n.repeat.is_some()||n.board.as_ref().is_some_and(|b|b.kind=="code-block")||!n.bindings.is_empty()||!n.style_refs.is_empty()||!n.variable_modes.is_empty()||n.instance.as_ref().is_some_and(|i|!i.slot_contents.is_empty())||n.component.as_ref().is_some_and(|c|!c.properties.is_empty()||!c.slots.is_empty())){return Ok(None)}
 for(id,next)in &patch.nodes{let(Some(old),Some(next))=(before.nodes.get(id),next)else{return Ok(None)};
  if old.children!=next.children||old.kind!=next.kind||old.component!=next.component||old.component_set!=next.component_set||old.component_key!=next.component_key||old.instance_origin!=next.instance_origin{return Ok(None)}
 }
 let parent=parents(after);let mut definitions=BTreeSet::new();let mut instances=BTreeSet::new();let mut roots=BTreeSet::new();
 for id in patch.nodes.keys(){let chain=ancestors(id,&parent);if let Some(root)=chain.last(){roots.insert(root.clone());}
  for id in chain{let n=&after.nodes[&id];if n.component.is_some(){definitions.insert(id.clone());}
   if n.instance.is_some(){instances.insert(n.instance_origin.as_ref().map_or(id.clone(),|o|o.owner.clone()));}
   if let Some(origin)=&n.instance_origin{instances.insert(origin.owner.clone());}
  }
 }
 // A template can contain another instance. Propagate definition dependencies
 // until closed, under the same nesting bound as the authoritative Builder.
 for depth in 0..=32{let count=definitions.len();
  for(id,n)in &after.nodes{if n.instance.as_ref().is_some_and(|i|definitions.contains(&i.component_id)){
   instances.insert(n.instance_origin.as_ref().map_or(id.clone(),|o|o.owner.clone()));
   for ancestor in ancestors(id,&parent){if after.nodes[&ancestor].component.is_some(){definitions.insert(ancestor);}}
  }}
  if definitions.len()==count{break}if depth==32{return Ok(None)}
 }
 for id in &instances{if !after.nodes.contains_key(id){return Ok(None)}if let Some(root)=ancestors(id,&parent).last(){roots.insert(root.clone());}}
 Ok(Some(Plan{instances,roots}))
}
pub(crate) fn resolve_plan(doc:&mut Document,fonts:&Fonts,plan:&Plan)->Result<(),String>{
 design_system::resolve_authored(doc)?;
 components::resolve_roots(doc,Some(&plan.instances))?;
 layout::resolve_roots(doc,fonts,Some(&plan.roots))?;
 curve_boolean::resolve_roots(doc,Some(&plan.roots))?;
 components::check_budget(doc)?;doc.validate()
}
fn resolve_full(doc:&mut Document,fonts:&Fonts)->Result<(),String>{
 design_system::resolve_authored(doc)?;components::resolve(doc)?;layout::resolve(doc,fonts)?;curve_boolean::resolve(doc)?;components::check_budget(doc)?;doc.validate()
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct Stats{scoped:bool,instance_roots:usize,layout_roots:usize,total_nodes:usize}
#[derive(Serialize)]
struct Reply{nodes:BTreeMap<String,Node>,removed:Vec<String>,receipt:u32,stats:Stats}
#[derive(Default)]
pub struct State{document:Option<Document>,receipt:u32}
impl State{
 pub fn clear(&mut self){self.document=None;self.receipt=self.receipt.saturating_add(1);}
 fn finish(&mut self,before:&Document,doc:Document,scope:Option<&Plan>)->Result<String,String>{
  let receipt=self.receipt.checked_add(1).ok_or("DERIVED_STATE_EXHAUSTED")?;
  let reply=Reply{nodes:doc.nodes.iter().filter(|(id,n)|before.nodes.get(*id)!=Some(*n)).map(|(id,n)|(id.clone(),n.clone())).collect(),
   removed:before.nodes.keys().filter(|id|!doc.nodes.contains_key(*id)).cloned().collect(),receipt,
   stats:Stats{scoped:scope.is_some(),instance_roots:scope.map_or(0,|p|p.instances.len()),layout_roots:scope.map_or(doc.pages.iter().map(|p|p.children.len()).sum(),|p|p.roots.len()),total_nodes:doc.nodes.len()}};
  let encoded=serde_json::to_string(&reply).map_err(|e|e.to_string())?;
  self.document=Some(doc);self.receipt=receipt;Ok(encoded)
 }
 pub fn full(&mut self,json:&str,fonts:&Fonts)->Result<String,String>{
  crate::capacity::check_document_bytes(json.len())?;let mut doc:Document=serde_json::from_str(json).map_err(|e|e.to_string())?;doc.validate()?;
  let before=doc.clone();let fonts=fonts.with_resources(&doc.fonts)?;resolve_full(&mut doc,&fonts)?;self.finish(&before,doc,None)
 }
 pub fn patch(&mut self,json:&str,receipt:u32,fonts:&Fonts)->Result<String,String>{
  if receipt!=self.receipt||self.document.is_none(){return Err("DERIVED_STATE_STALE".into())}
  crate::capacity::check_document_bytes(json.len())?;let patch:DocumentPatch=serde_json::from_str(json).map_err(|e|e.to_string())?;
  let previous=self.document.as_ref().unwrap();let mut doc=patch.apply(previous).map_err(|e|e.to_string())?;
  let scope=plan(previous,&doc)?;let before=doc.clone();let fonts=fonts.with_resources(&doc.fonts)?;
  if let Some(scope)=&scope{resolve_plan(&mut doc,&fonts,scope)?}else{resolve_full(&mut doc,&fonts)?}
  self.finish(&before,doc,scope.as_ref())
 }
}

#[cfg(test)]
mod tests{
 use super::*;use serde_json::json;
 fn fixture()->Document{serde_json::from_value(json!({"schemaVersion":16,"id":"d","name":"incremental components","pages":[{"id":"p","name":"p","background":"#ffffff","children":["a","b","ia","ib"]}],"nodes":{
  "a":{"id":"a","kind":"frame","width":100,"height":40,"component":{},"children":["a-child"]},
  "b":{"id":"b","kind":"frame","width":100,"height":40,"component":{},"children":["b-child"]},
  "a-child":{"id":"a-child","kind":"rectangle","width":80,"height":30,"fills":[{"kind":"solid","color":"#aabbcc"}]},
  "b-child":{"id":"b-child","kind":"rectangle","width":80,"height":30,"fills":[{"kind":"solid","color":"#ccbbaa"}]},
  "ia":{"id":"ia","kind":"frame","width":100,"height":40,"instance":{"componentId":"a"}},
  "ib":{"id":"ib","kind":"frame","width":100,"height":40,"instance":{"componentId":"b"}}}})).unwrap()}
 #[test]fn scoped_template_updates_match_full_and_leave_unrelated_instance_intact(){
  let fonts=Fonts::new();let mut state=State::default();state.full(&serde_json::to_string(&fixture()).unwrap(),&fonts).unwrap();
  let before=state.document.clone().unwrap();let mut candidate=before.clone();candidate.nodes.get_mut("a-child").unwrap().fills[0].color="#123456".into();
  let patch=DocumentPatch::between(&before,&candidate).unwrap();let receipt=state.receipt;
  let result:serde_json::Value=serde_json::from_str(&state.patch(&serde_json::to_string(&patch).unwrap(),receipt,&fonts).unwrap()).unwrap();
  assert_eq!(result["stats"]["scoped"],true);assert_eq!(result["stats"]["instanceRoots"],1);assert_eq!(result["stats"]["layoutRoots"],2);
  resolve_full(&mut candidate,&fonts).unwrap();assert_eq!(state.document.as_ref().unwrap(),&candidate);
  assert_eq!(before.nodes["ib"],candidate.nodes["ib"]);
  assert_eq!(state.patch("{}",receipt,&fonts).unwrap_err(),"DERIVED_STATE_STALE");
 }
 #[test]fn rejected_delta_is_atomic_and_font_reset_revokes_receipt(){
  let fonts=Fonts::new();let mut state=State::default();state.full(&serde_json::to_string(&fixture()).unwrap(),&fonts).unwrap();
  let before=state.document.clone();let receipt=state.receipt;
  assert!(state.patch(r#"{"nodes":{"a-child":null},"fields":{}}"#,receipt,&fonts).is_err());assert_eq!(state.document,before);assert_eq!(state.receipt,receipt);
  state.clear();assert_eq!(state.patch("{}",receipt,&fonts).unwrap_err(),"DERIVED_STATE_STALE");
 }
 #[test]fn root_metadata_and_topology_fall_back_to_full_semantics(){
  let fonts=Fonts::new();let mut state=State::default();state.full(&serde_json::to_string(&fixture()).unwrap(),&fonts).unwrap();
  let before=state.document.clone().unwrap();let mut after=before.clone();after.name="renamed".into();
  let patch=DocumentPatch::between(&before,&after).unwrap();let reply:serde_json::Value=serde_json::from_str(&state.patch(&serde_json::to_string(&patch).unwrap(),state.receipt,&fonts).unwrap()).unwrap();
  assert_eq!(reply["stats"]["scoped"],false);resolve_full(&mut after,&fonts).unwrap();assert_eq!(state.document.as_ref(),Some(&after));
 }
}
