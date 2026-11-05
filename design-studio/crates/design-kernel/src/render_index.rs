use std::collections::HashMap;
use std::sync::Arc;
use crate::scene::Document;

/// Private derived topology only. Ordinals never leave this immutable index,
/// so a rebuilt revision cannot accidentally consume a recycled node handle.
pub(crate) struct Parents {
    ids: Vec<Arc<str>>,
    ordinals: HashMap<Arc<str>,usize>,
    parent: Box<[usize]>,
}
const ROOT:usize=usize::MAX;
impl Parents {
    pub(crate) fn new(document:&Document)->Self {
        let ids:Vec<Arc<str>>=document.nodes.keys().map(|id|Arc::from(id.as_str())).collect();
        let ordinals:HashMap<_,_>=ids.iter().enumerate().map(|(index,id)|(id.clone(),index)).collect();
        let mut parent=vec![ROOT;ids.len()].into_boxed_slice();
        for (index,id) in ids.iter().enumerate() {
            for child in &document.nodes[id.as_ref()].children {
                if let Some(&child)=ordinals.get(child.as_str()) {parent[child]=index;}
            }
        }
        Self{ids,ordinals,parent}
    }
    pub(crate) fn ancestors(&self,id:&str)->Ancestors<'_> {
        Ancestors{index:self,next:self.ordinals.get(id).map_or(ROOT,|&i|self.parent[i])}
    }
}
pub(crate) struct Ancestors<'a> { index:&'a Parents, next:usize }
impl<'a> Iterator for Ancestors<'a> {
    type Item=&'a str;
    fn next(&mut self)->Option<Self::Item> {
        if self.next==ROOT {return None;}
        let at=self.next;self.next=self.index.parent[at];Some(self.index.ids[at].as_ref())
    }
}
/// Camera invalidation also accepts a temporary map from other compilers.
/// Dense parent walks hash the starting ID once, then follow integer edges.
pub(crate) trait ParentLookup {
    fn for_each_ancestor(&self,id:&str,visit:impl FnMut(&str));
}
impl ParentLookup for Parents {
    fn for_each_ancestor(&self,id:&str,mut visit:impl FnMut(&str)) {for id in self.ancestors(id) {visit(id);}}
}
impl ParentLookup for HashMap<String,String> {
    fn for_each_ancestor(&self,id:&str,mut visit:impl FnMut(&str)) {
        let mut current=self.get(id);while let Some(id)=current {visit(id);current=self.get(id);}
    }
}

/// Authored topology for a validated document. Proven property-only patches
/// retain these edges; structural changes and unproven installs replace them.
pub(crate) struct RenderIndex {
    pub(crate) parents: Parents,
    pub(crate) has_connectors: bool,
    pub(crate) sketch_mask_owners: std::collections::HashSet<String>,
}
impl RenderIndex {
    pub(crate) fn in_sketch_mask_chain(&self, id: &str) -> bool {
        !self.sketch_mask_owners.is_empty() && (self.sketch_mask_owners.contains(id)
            || self.parents.ancestors(id).any(|p| self.sketch_mask_owners.contains(p)))
    }
    pub(crate) fn preserved_by(document:&Document,patch:&crate::editing::DocumentPatch)->bool {
        !patch.fields.contains_key("pages") && patch.nodes.iter().all(|(id,next)| {
            document.nodes.get(id).zip(next.as_ref()).is_some_and(|(old,next)|
                old.id==next.id&&old.children==next.children&&old.connector.is_some()==next.connector.is_some()
                && crate::sketch_masks::starts(old)==crate::sketch_masks::starts(next)
                && old.boolean_operation.is_some()==next.boolean_operation.is_some())
        })
    }
    pub(crate) fn new(document: &Document) -> Self {
        let parents = Parents::new(document);
        Self {
            sketch_mask_owners: crate::sketch_masks::owners(document, &parents),
            parents,
            has_connectors: document.nodes.values().any(|node| node.connector.is_some()),
        }
    }
}
#[cfg(test)]mod tests{
 use super::*;use serde_json::json;
 #[test]fn property_proof_does_not_retain_reparented_or_removed_edges(){
  let doc:Document=serde_json::from_value(json!({"schemaVersion":16,"id":"d","name":"index","pages":[{"id":"p","name":"p","background":"#ffffff","children":["r"]}],"nodes":{"r":{"id":"r","kind":"frame","width":100,"height":100,"children":["n"]},"n":{"id":"n","kind":"rectangle","width":20,"height":20}}})).unwrap();
  let mut changed=doc.clone();changed.nodes.get_mut("n").unwrap().width=40.;
  let patch=crate::editing::DocumentPatch::between(&doc,&changed).unwrap();assert!(RenderIndex::preserved_by(&doc,&patch));
  changed.nodes.get_mut("r").unwrap().children.clear();assert!(!RenderIndex::preserved_by(&doc,&crate::editing::DocumentPatch::between(&doc,&changed).unwrap()));
  let mut removed=doc.clone();removed.nodes.remove("n");assert!(!RenderIndex::preserved_by(&doc,&crate::editing::DocumentPatch::between(&doc,&removed).unwrap()));
 }
}
