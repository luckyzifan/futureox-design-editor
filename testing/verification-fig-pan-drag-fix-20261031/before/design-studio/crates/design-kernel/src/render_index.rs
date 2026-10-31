use std::collections::HashMap;
use crate::scene::Document;

/// Authored topology for a validated document. Proven property-only patches
/// retain these edges; structural changes and unproven installs replace them.
pub(crate) struct RenderIndex {
    pub(crate) parents: HashMap<String, String>,
    pub(crate) has_connectors: bool,
}
impl RenderIndex {
    pub(crate) fn preserved_by(document:&Document,patch:&crate::editing::DocumentPatch)->bool {
        !patch.fields.contains_key("pages") && patch.nodes.iter().all(|(id,next)| {
            document.nodes.get(id).zip(next.as_ref()).is_some_and(|(old,next)|
                old.id==next.id&&old.children==next.children&&old.connector.is_some()==next.connector.is_some())
        })
    }
    pub(crate) fn new(document: &Document) -> Self {
        Self {
            parents: document.nodes.values().flat_map(|node|
                node.children.iter().map(move |child| (child.clone(), node.id.clone()))).collect(),
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
