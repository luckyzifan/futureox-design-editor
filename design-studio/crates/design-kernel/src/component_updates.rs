//! One resident derivation snapshot using the existing Document and resolvers.
//! Receipts fence delta application; unknown dependencies use the full path.
use crate::{components,curve_boolean,design_system,editing::DocumentPatch,font::Fonts,layout,scene::{Document,Node}};
use serde::Serialize;
use std::collections::{BTreeMap,BTreeSet};
mod byte_ledger;
mod pose;

pub(crate) struct Plan { pub instances:BTreeSet<String>, pub roots:BTreeSet<String> }
fn parents(doc:&Document)->BTreeMap<String,String>{doc.nodes.iter().flat_map(|(id,n)|n.children.iter().map(move|c|(c.clone(),id.clone()))).collect()}
fn ancestors(id:&str,parents:&BTreeMap<String,String>)->Vec<String>{let mut out=vec![id.to_owned()];while let Some(p)=parents.get(out.last().unwrap()){out.push(p.clone());}out}
/// True when a connector endpoint is a patched id or a descendant of one.
/// `patched` alone misses a wire whose endpoint names a child of the transformed node.
fn connector_targets_transformed_subtree(doc:&Document,patched:&BTreeSet<&str>,parents:&BTreeMap<String,String>)->bool{
    if patched.is_empty(){return false}
    doc.nodes.values().any(|node|node.connector.as_ref().is_some_and(|connector|{
        [connector.from.node_id.as_deref(),connector.to.node_id.as_deref()].into_iter().flatten()
            .any(|target|endpoint_in_transformed_subtree(target,patched,parents))
    }))
}
fn endpoint_in_transformed_subtree(start:&str,patched:&BTreeSet<&str>,parents:&BTreeMap<String,String>)->bool{
    let mut id=start.to_owned();
    let mut seen=BTreeSet::new();
    loop{
        if patched.contains(id.as_str()){return true}
        if !seen.insert(id.clone()){return true}
        match parents.get(&id){Some(parent)=>id.clone_from(parent),None=>return false}
    }
}
fn blocks_scoped_patch(n:&Node)->bool{
 n.connector.is_some()||n.text_path.is_some()||n.repeat.is_some()||n.board.as_ref().is_some_and(|b|b.kind=="code-block")||!n.bindings.is_empty()||!n.style_refs.is_empty()||!n.variable_modes.is_empty()||n.instance.as_ref().is_some_and(|i|!i.slot_contents.is_empty())||n.component.as_ref().is_some_and(|c|!c.properties.is_empty()||!c.slots.is_empty())
}
pub(crate) fn plan(before:&Document,after:&Document)->Result<Option<Plan>,String>{
 let patch=DocumentPatch::between(before,after).map_err(|e|e.to_string())?;
 plan_patch(before,&patch)
}
fn plan_patch(before:&Document,patch:&DocumentPatch)->Result<Option<Plan>,String>{
 if !patch.fields.is_empty()||!before.animations.is_empty()||patch.nodes.len()>4096{return Ok(None)}
 for(id,next)in &patch.nodes{let(Some(old),Some(next))=(before.nodes.get(id),next)else{return Ok(None)};
  // Clearing a mode map removes the selection the scoped gate looks for, but
  // descendants were already resolved under it. Rebuild them on the full path.
  if old.variable_modes!=next.variable_modes{return Ok(None)}
  if old.kind!=next.kind||old.component!=next.component||old.component_set!=next.component_set||old.component_key!=next.component_key||old.instance_origin!=next.instance_origin{return Ok(None)}
 }
 let next=|id:&str|patch.nodes.get(id).and_then(Option::as_ref).unwrap_or(&before.nodes[id]);
 let parent=parents(before);
 // Cold connectors do not force a full resolve. An endpoint that names the
 // transformed subtree does: a parent pose moves every descendant, and a wire
 // aimed at one of them is not described by the patched id list. Patched nodes
 // and their ancestors keep the previous dependency gate.
 for id in patch.nodes.keys(){if ancestors(id,&parent).iter().any(|id|blocks_scoped_patch(next(id))){return Ok(None)}}
 let patched:BTreeSet<&str>=patch.nodes.keys().map(String::as_str).collect();
 if connector_targets_transformed_subtree(before,&patched,&parent){return Ok(None)}
 // An ordinary reparent/reorder affects both complete original root islands.
 // Parent lists are explicit patch entries; global validation below still
 // rejects missing counterparts, duplicate parents and cycles atomically.
 // Component ownership/topology retains the full resolver contract.
 let mut topology=BTreeSet::new();
 for(id,next)in &patch.nodes{let next=next.as_ref().unwrap();let old=&before.nodes[id];
  if old.children!=next.children{
   topology.insert(id.clone());
   let a:BTreeSet<_>=old.children.iter().cloned().collect();let b:BTreeSet<_>=next.children.iter().cloned().collect();
   topology.extend(a.symmetric_difference(&b).cloned());
  }
 }
 for id in &topology{
  if !before.nodes.contains_key(id){return Ok(None)}
  if ancestors(id,&parent).iter().any(|id|{let n=next(id);n.component.is_some()||n.instance.is_some()||n.instance_origin.is_some()||n.component_set||n.component_key.is_some()}){return Ok(None)}
 }
 let mut definitions=BTreeSet::new();let mut instances=BTreeSet::new();let mut roots=BTreeSet::new();
 // A malformed partial reparent can temporarily make another island's child
 // reachable from a changed parent. Rollback must own that original island
 // too, before any mutable validation starts.
 for id in &topology{if let Some(root)=ancestors(id,&parent).last(){roots.insert(root.clone());}}
 for id in patch.nodes.keys(){let chain=ancestors(id,&parent);if let Some(root)=chain.last(){roots.insert(root.clone());}
  for id in chain{let n=next(&id);if n.component.is_some(){definitions.insert(id.clone());}
   if n.instance.is_some(){instances.insert(n.instance_origin.as_ref().map_or(id.clone(),|o|o.owner.clone()));}
   if let Some(origin)=&n.instance_origin{instances.insert(origin.owner.clone());}
  }
 }
 if !definitions.is_empty(){for depth in 0..=32{let count=definitions.len();
  for id in before.nodes.keys(){let n=next(id);if n.instance.as_ref().is_some_and(|i|definitions.contains(&i.component_id)){
   instances.insert(n.instance_origin.as_ref().map_or(id.clone(),|o|o.owner.clone()));
   for ancestor in ancestors(id,&parent){if next(&ancestor).component.is_some(){definitions.insert(ancestor);}}
  }}
  if definitions.len()==count{break}if depth==32{return Ok(None)}
 }}
 for id in &instances{if !before.nodes.contains_key(id){return Ok(None)}if let Some(root)=ancestors(id,&parent).last(){roots.insert(root.clone());}}
 Ok(Some(Plan{instances,roots}))
}
pub(crate) fn resolve_plan(doc:&mut Document,fonts:&Fonts,plan:&Plan)->Result<(),String>{
 resolve_scoped(doc,fonts,plan,None)
}
fn resolve_scoped(doc:&mut Document,fonts:&Fonts,plan:&Plan,source_bytes:Option<usize>)->Result<(),String>{
 resolve_scoped_model(doc,fonts,plan,source_bytes)?;
 doc.validate()
}
fn resolve_scoped_model(doc:&mut Document,fonts:&Fonts,plan:&Plan,source_bytes:Option<usize>)->Result<(),String>{
 // plan_patch rejects all bindings/styles/modes and definition defaults.
 // Resolving authored bindings therefore has no work and must not walk cold
 // islands (or multiply unrelated Boolean children by an identity resize).
 // plan_patch also excludes definition defaults/slots and cross-root modes.
 // An empty instance set has no component work, even if cold islands contain
 // components. Avoid their global validation/maps and two JSON budget walks.
 if !plan.instances.is_empty(){components::resolve_roots_budgeted(doc,Some(&plan.instances),source_bytes)?;}
 layout::resolve_roots(doc,fonts,Some(&plan.roots))?;
 curve_boolean::resolve_roots(doc,Some(&plan.roots))?;
 if source_bytes.is_none(){components::check_budget(doc)?;}Ok(())
}
fn resolve_full(doc:&mut Document,fonts:&Fonts)->Result<(),String>{
 design_system::resolve_authored(doc)?;components::resolve(doc)?;layout::resolve(doc,fonts)?;curve_boolean::resolve(doc)?;components::check_budget(doc)?;doc.validate()
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct Stats{scoped:bool,instance_roots:usize,layout_roots:usize,total_nodes:usize,#[serde(skip_serializing_if="std::ops::Not::not")]pose:bool}
#[derive(Serialize)]
struct Reply{nodes:BTreeMap<String,Node>,removed:Vec<String>,receipt:u32,stats:Stats}
#[derive(Default)]
pub struct State{document:Option<Document>,receipt:u32,ledger:Option<byte_ledger::Ledger>,font_stamp:Option<crate::font::FontSourceStamp>}
impl State{
 pub fn clear(&mut self){self.document=None;self.ledger=None;self.font_stamp=None;self.receipt=self.receipt.saturating_add(1);}
 fn finish(&mut self,before:&Document,doc:Document,scope:Option<&Plan>)->Result<String,String>{
  let receipt=self.receipt.checked_add(1).ok_or("DERIVED_STATE_EXHAUSTED")?;
  let reply=Reply{nodes:doc.nodes.iter().filter(|(id,n)|before.nodes.get(*id)!=Some(*n)).map(|(id,n)|(id.clone(),n.clone())).collect(),
   removed:before.nodes.keys().filter(|id|!doc.nodes.contains_key(*id)).cloned().collect(),receipt,
   stats:Stats{scoped:scope.is_some(),instance_roots:scope.map_or(0,|p|p.instances.len()),layout_roots:scope.map_or(doc.pages.iter().map(|p|p.children.len()).sum(),|p|p.roots.len()),total_nodes:doc.nodes.len(),pose:false}};
  let encoded=serde_json::to_string(&reply).map_err(|e|e.to_string())?;
  let ledger=byte_ledger::Ledger::new(&doc)?;
  self.document=Some(doc);self.receipt=receipt;self.ledger=ledger;Ok(encoded)
 }
 pub fn full(&mut self,json:&str,fonts:&Fonts)->Result<String,String>{
  crate::capacity::check_document_bytes(json.len())?;let mut doc:Document=serde_json::from_str(json).map_err(|e|e.to_string())?;doc.validate()?;
  let stamp=fonts.source_stamp();let before=doc.clone();let fonts=fonts.with_resources(&doc.fonts)?;resolve_full(&mut doc,&fonts)?;
  let result=self.finish(&before,doc,None);if result.is_ok(){self.font_stamp=Some(stamp)}result
 }
 pub fn patch(&mut self,json:&str,receipt:u32,fonts:&Fonts)->Result<String,String>{
  self.patch_mode(json,receipt,fonts,false)
 }
 pub fn patch_pose(&mut self,json:&str,receipt:u32,fonts:&Fonts)->Result<String,String>{
  self.patch_mode(json,receipt,fonts,true)
 }
 /// Declining this proof leaves normalization/full resolution with the caller.
 /// No caller hint substitutes for the private receipt, node or font checks.
 pub fn try_pose(&mut self,json:&str,receipt:u32,fonts:&Fonts)->Result<Option<String>,String>{
  if receipt!=self.receipt||self.document.is_none(){return Err("DERIVED_STATE_STALE".into())}
  crate::capacity::check_document_bytes(json.len())?;
  if self.ledger.is_none()||self.font_stamp.as_ref()!=Some(&fonts.source_stamp()){return Ok(None)}
  let patch:DocumentPatch=serde_json::from_str(json).map_err(|e|e.to_string())?;
  if !pose::eligible(self.document.as_ref().unwrap(),&patch)?{return Ok(None)}
  self.apply_pose(patch).map(Some)
 }
 fn patch_mode(&mut self,json:&str,receipt:u32,fonts:&Fonts,allow_pose:bool)->Result<String,String>{
  if receipt!=self.receipt||self.document.is_none(){return Err("DERIVED_STATE_STALE".into())}
  crate::capacity::check_document_bytes(json.len())?;let patch:DocumentPatch=serde_json::from_str(json).map_err(|e|e.to_string())?;
  let previous=self.document.as_ref().unwrap();
  let same_fonts=self.font_stamp.as_ref()==Some(&fonts.source_stamp());
  if !same_fonts{self.font_stamp=None;}
  if allow_pose&&same_fonts&&self.ledger.is_some()&&pose::eligible(previous,&patch)? {return self.apply_pose(patch)}
  if let Some(scope)=plan_patch(previous,&patch)? { return self.patch_scoped(patch,scope,fonts); }
  let mut doc=patch.apply(previous).map_err(|e|e.to_string())?;
  let scope=plan(previous,&doc)?;let before=doc.clone();let fonts=fonts.with_resources(&doc.fonts)?;
  if let Some(scope)=&scope{resolve_plan(&mut doc,&fonts,scope)?}else{resolve_full(&mut doc,&fonts)?}
  self.finish(&before,doc,scope.as_ref())
 }
 fn patch_scoped(&mut self,patch:DocumentPatch,scope:Plan,fonts:&Fonts)->Result<String,String>{
  let receipt=self.receipt.checked_add(1).ok_or("DERIVED_STATE_EXHAUSTED")?;
  let previous=self.document.as_ref().unwrap();
  let fonts=fonts.with_resources(&previous.fonts)?;
  fn collect(doc:&Document,roots:&BTreeSet<String>)->BTreeSet<String>{
   let mut result=BTreeSet::new();let mut stack:Vec<_>=roots.iter().cloned().collect();
   while let Some(id)=stack.pop(){if result.insert(id.clone()) {if let Some(n)=doc.nodes.get(&id){stack.extend(n.children.iter().cloned());}}}result
  }
  // Only complete affected islands are copied for rollback. Font/image payloads
  // and cold nodes keep their original resident allocation. Global validation
  // and byte admission still run before committing the next receipt.
  let ids=collect(previous,&scope.roots);
  let backup:BTreeMap<_,_>=ids.iter().map(|id|(id.clone(),previous.nodes[id].clone())).collect();
  let mut doc=self.document.take().unwrap();
  for(id,node)in &patch.nodes {doc.nodes.insert(id.clone(),node.as_ref().unwrap().clone());}
  let mut ledger_update=None;
  let result=(||{
   let changed=patch.nodes.keys().cloned().collect();
   doc.validate_scoped_edit(&changed)?;
   let source_bytes=if let Some(ledger)=&self.ledger{Some(ledger.prepare(&doc,&changed)?.bytes())}
   else{crate::capacity::check_document_bytes(crate::editing::serialized_document_size(&doc).map_err(|e|e.to_string())?)?;None};
   resolve_scoped_model(&mut doc,&fonts,&scope,source_bytes)?;
   let current=collect(&doc,&scope.roots);
   let affected=ids.union(&current).cloned().collect();
   doc.validate_scoped_edit(&affected)?;
   if let Some(ledger)=&self.ledger{ledger_update=Some(ledger.prepare(&doc,&affected)?);}
   let candidate=|id:&str|patch.nodes.get(id).and_then(Option::as_ref).or_else(||backup.get(id));
   let reply=Reply{nodes:current.iter().filter_map(|id|doc.nodes.get(id).filter(|n|candidate(id)!=Some(*n)).map(|n|(id.clone(),n.clone()))).collect(),
    removed:ids.iter().filter(|id|!doc.nodes.contains_key(*id)).cloned().collect(),receipt,
    stats:Stats{scoped:true,instance_roots:scope.instances.len(),layout_roots:scope.roots.len(),total_nodes:doc.nodes.len(),pose:false}};
   serde_json::to_string(&reply).map_err(|e|e.to_string())
  })();
  if result.is_err(){
   for id in collect(&doc,&scope.roots){doc.nodes.remove(&id);}
   doc.nodes.extend(backup);
  }else{if let (Some(ledger),Some(update))=(&mut self.ledger,ledger_update){if !ledger.commit(update){self.ledger=None;}}self.receipt=receipt;}
  self.document=Some(doc);result
 }

 fn apply_pose(&mut self,patch:DocumentPatch)->Result<String,String>{
  let receipt=self.receipt.checked_add(1).ok_or("DERIVED_STATE_EXHAUSTED")?;
  let doc=self.document.as_mut().unwrap();
  // All non-transform fields and all graph/reference edges equal the validated
  // resident model. Still run the original node-body validation and exact byte
  // ledger; publication remains atomic and receipt-owned.
  doc.validate_nodes(patch.nodes.iter().map(|(id,node)|(id,node.as_ref().unwrap())))?;
  let changed=patch.nodes.keys().cloned().collect();
  let backup:Vec<_>=patch.nodes.keys().map(|id|(id.clone(),doc.nodes[id].clone())).collect();
  for(id,node)in patch.nodes{doc.nodes.insert(id,node.unwrap());}
  let result=(||{
   let update=self.ledger.as_ref().unwrap().prepare(doc,&changed)?;
   let reply=Reply{nodes:BTreeMap::new(),removed:Vec::new(),receipt,
    stats:Stats{scoped:true,instance_roots:0,layout_roots:0,total_nodes:doc.nodes.len(),pose:true}};
   let encoded=serde_json::to_string(&reply).map_err(|e|e.to_string())?;
   Ok((update,encoded))
  })();
  match result {
   Ok((update,encoded))=>{if !self.ledger.as_mut().unwrap().commit(update){self.ledger=None;}self.receipt=receipt;Ok(encoded)},
   Err(error)=>{doc.nodes.extend(backup);Err(error)}
  }
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
  assert_eq!(state.ledger.as_ref().unwrap().bytes(),serde_json::to_vec(state.document.as_ref().unwrap()).unwrap().len());
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
 #[test]fn ordinary_island_edits_do_not_encode_cold_component_documents_again(){
  let fonts=Fonts::new();let mut doc=fixture();let node=crate::facet::sample_node("ordinary","rectangle");
  doc.pages[0].children.push(node.id.clone());doc.nodes.insert(node.id.clone(),node);
  let mut state=State::default();state.full(&serde_json::to_string(&doc).unwrap(),&fonts).unwrap();
  let bytes=components::byte_measurements();let full=crate::editing::document_size_count_calls();
  for x in [1.,-0.,23.125,1e-9] {
   let before=state.document.as_ref().unwrap();let mut changed=before.nodes["ordinary"].clone();changed.transform.0[4]=x;
   let patch=DocumentPatch{nodes:BTreeMap::from([("ordinary".into(),Some(changed))]),fields:BTreeMap::new()};
   let result:serde_json::Value=serde_json::from_str(&state.patch(&serde_json::to_string(&patch).unwrap(),state.receipt,&fonts).unwrap()).unwrap();
   assert_eq!(result["stats"]["instanceRoots"],0);assert_eq!(result["stats"]["scoped"],true);
   assert_eq!(state.ledger.as_ref().unwrap().bytes(),serde_json::to_vec(state.document.as_ref().unwrap()).unwrap().len());
  }
  assert_eq!(components::byte_measurements(),bytes);assert_eq!(crate::editing::document_size_count_calls(),full);
  let saved=state.document.clone();let receipt=state.receipt;let size=state.ledger.as_ref().unwrap().bytes();
  let mut invalid=state.document.as_ref().unwrap().nodes["ordinary"].clone();invalid.opacity=2.;
  let patch=DocumentPatch{nodes:BTreeMap::from([("ordinary".into(),Some(invalid))]),fields:BTreeMap::new()};
  assert!(state.patch(&serde_json::to_string(&patch).unwrap(),receipt,&fonts).is_err());
  assert_eq!(state.document,saved);assert_eq!(state.receipt,receipt);assert_eq!(state.ledger.as_ref().unwrap().bytes(),size);
 }
 #[test]fn ordinary_reparent_resolves_both_islands_and_rejects_partial_or_cyclic_topology_atomically(){
  let fonts=Fonts::new();let mut doc=fixture();
  for (id,children) in [("left",vec!["moving".to_owned()]),("right",vec![])]{
   let mut n=crate::facet::sample_node(id,"frame");n.children=children;doc.pages[0].children.push(id.into());doc.nodes.insert(id.into(),n);
  }
  doc.nodes.insert("moving".into(),crate::facet::sample_node("moving","rectangle"));
  let mut state=State::default();state.full(&serde_json::to_string(&doc).unwrap(),&fonts).unwrap();
  let before=state.document.as_ref().unwrap().clone();let mut candidate=before.clone();
  candidate.nodes.get_mut("left").unwrap().children.clear();candidate.nodes.get_mut("right").unwrap().children.push("moving".into());
  candidate.nodes.get_mut("moving").unwrap().transform.0[4]=23.125;
  let patch=DocumentPatch::between(&before,&candidate).unwrap();
  let reply:serde_json::Value=serde_json::from_str(&state.patch(&serde_json::to_string(&patch).unwrap(),state.receipt,&fonts).unwrap()).unwrap();
  assert_eq!(reply["stats"]["scoped"],true);assert_eq!(reply["stats"]["instanceRoots"],0);assert_eq!(reply["stats"]["layoutRoots"],2);
  resolve_full(&mut candidate,&fonts).unwrap();assert_eq!(state.document.as_ref(),Some(&candidate));
  assert_eq!(state.ledger.as_ref().unwrap().bytes(),serde_json::to_vec(&candidate).unwrap().len());
  let receipt=state.receipt;let size=state.ledger.as_ref().unwrap().bytes();
  for children in [vec!["moving".into()],vec!["left".into()]]{
   let mut n=state.document.as_ref().unwrap().nodes["left"].clone();n.children=children;
   let bad=DocumentPatch{nodes:BTreeMap::from([("left".into(),Some(n))]),fields:BTreeMap::new()};
   assert!(state.patch(&serde_json::to_string(&bad).unwrap(),receipt,&fonts).is_err());
   assert_eq!(state.document.as_ref(),Some(&candidate));assert_eq!(state.receipt,receipt);assert_eq!(state.ledger.as_ref().unwrap().bytes(),size);
  }
 }
 #[test]fn scoped_validation_still_rejects_changed_node_bodies_and_invalid_derived_descendants(){
  let fonts=Fonts::new();let mut doc=fixture();
  let mut parent=crate::facet::sample_node("ordinary","frame");parent.width=1.;parent.children=vec!["sized".into()];
  let mut child=crate::facet::sample_node("sized","rectangle");child.width=20.;child.transform.0[4]=2.;
  child.constraints=Some(serde_json::from_value(json!({"horizontal":"scale","vertical":"start","referenceWidth":1,"referenceHeight":parent.height})).unwrap());
  doc.pages[0].children.push(parent.id.clone());doc.nodes.insert(parent.id.clone(),parent);doc.nodes.insert(child.id.clone(),child);
  let mut state=State::default();state.full(&serde_json::to_string(&doc).unwrap(),&fonts).unwrap();
  let before=state.document.clone().unwrap();let receipt=state.receipt;let bytes=state.ledger.as_ref().unwrap().bytes();
  for kind in 0..4 {
   let id=if kind==3{"ordinary"}else{"sized"};let mut next=before.nodes[id].clone();
   match kind {0=>next.opacity=2.,1=>next.transform.0[4]=1e12,2=>next.width=0.,_=>next.width=1e7}
   let patch=DocumentPatch{nodes:BTreeMap::from([(id.into(),Some(next))]),fields:BTreeMap::new()};
   assert!(plan_patch(&before,&patch).unwrap().is_some());
   assert!(state.patch(&serde_json::to_string(&patch).unwrap(),receipt,&fonts).is_err(),"case {kind}");
   assert_eq!(state.document.as_ref(),Some(&before));assert_eq!(state.receipt,receipt);assert_eq!(state.ledger.as_ref().unwrap().bytes(),bytes);
  }
 }
 #[test]fn connector_on_another_page_does_not_force_a_full_plan(){
  let mut doc=fixture();
  let plain=crate::facet::sample_node("plain","rectangle");
  doc.pages[0].children.push(plain.id.clone());
  doc.nodes.insert(plain.id.clone(),plain.clone());
  let cold=crate::facet::sample_node("cold","rectangle");
  let mut wire=crate::facet::sample_node("wire","vector");
  wire.connector=Some(serde_json::from_value(json!({"from":{"point":{"x":0.0,"y":0.0},"nodeId":"cold"},"to":{"point":{"x":10.0,"y":0.0},"nodeId":"cold"},"style":"straight"})).unwrap());
  doc.nodes.insert(cold.id.clone(),cold);
  doc.nodes.insert(wire.id.clone(),wire);
  doc.pages.push(crate::scene::Page{guides:Vec::new(),id:"p2".into(),name:"assets".into(),children:vec!["cold".into(),"wire".into()],background:"#ffffff".into()});
  let mut changed=plain;changed.transform.0[4]=12.;
  let patch=DocumentPatch{nodes:BTreeMap::from([("plain".into(),Some(changed))]),fields:BTreeMap::new()};
  assert!(plan_patch(&doc,&patch).unwrap().is_some());
  let mut aimed=doc.nodes["wire"].clone();
  aimed.connector.as_mut().unwrap().to.node_id=Some("plain".into());
  doc.nodes.insert("wire".into(),aimed);
  assert!(plan_patch(&doc,&patch).unwrap().is_none());
 }
 #[test]fn cleared_ancestor_modes_rebuild_resolved_instance_geometry(){
  let fonts=Fonts::new();
  let source:Document=serde_json::from_value(json!({"schemaVersion":6,"id":"d","name":"ancestor modes",
   "pages":[{"id":"p","name":"Page","background":"#ffffff","children":["main","dark"]}],
   "designSystem":{"collections":{"theme":{"name":"Theme","modes":["light","dark"],"defaultMode":"light"}},
    "variables":{"width":{"name":"Width","collection":"theme","kind":"number","values":{"light":20,"dark":80}}}},
   "nodes":{
    "main":{"id":"main","kind":"frame","width":100,"height":100,"children":["leaf"],"component":{}},
    "leaf":{"id":"leaf","kind":"rectangle","width":10,"height":10,"bindings":{"width":"width"}},
    "dark":{"id":"dark","kind":"frame","width":100,"height":100,"children":["b"],"variableModes":{"theme":"dark"}},
    "b":{"id":"b","kind":"frame","width":100,"height":100,"instance":{"componentId":"main"}}}})).unwrap();
  let mut state=State::default();
  state.full(&serde_json::to_string(&source).unwrap(),&fonts).unwrap();
  let before=state.document.clone().unwrap();
  let placed=|doc:&Document| doc.nodes.values().find(|n| n.instance_origin.as_ref().is_some_and(|o| o.owner=="b" && o.key=="leaf")).unwrap().width;
  assert_eq!(placed(&before),80.);
  let mut next=before.clone();
  next.nodes.get_mut("dark").unwrap().variable_modes.clear();
  let patch=DocumentPatch::between(&before,&next).unwrap();
  assert!(plan_patch(&before,&patch).unwrap().is_none());
  let receipt=state.receipt;
  let reply:serde_json::Value=serde_json::from_str(&state.patch(&serde_json::to_string(&patch).unwrap(),receipt,&fonts).unwrap()).unwrap();
  assert_eq!(reply["stats"]["scoped"],false);
  assert_eq!(placed(state.document.as_ref().unwrap()),20.);
  resolve_full(&mut next,&fonts).unwrap();
  assert_eq!(state.document.as_ref().unwrap(),&next);
 }
}
