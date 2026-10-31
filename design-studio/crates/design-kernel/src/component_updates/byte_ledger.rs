//! Exact canonical JSON accounting owned by one resident component receipt.
//! This optional cache never changes admission: large ledgers use the original
//! full counter. Updates are staged until document validation/publication wins.
use crate::{editing, scene::Document};
use std::collections::{BTreeMap, BTreeSet};

const MAX_LEDGER_BYTES: usize = 16 * 1024 * 1024;
#[derive(Clone, Copy)]
struct Entry { key: usize, value: usize }
pub(super) struct Ledger { entries: BTreeMap<String, Entry>, bytes: usize, storage:usize }
pub(super) struct Update { entries: Vec<(String, Option<Entry>)>, bytes: usize, storage:usize }
impl Update { pub(super) fn bytes(&self)->usize {self.bytes} }
fn commas(count: usize) -> usize { count.saturating_sub(1) }
fn overflow() -> String { "DOCUMENT_RESOURCE_LIMIT: serialized byte accounting overflow".into() }
fn value_size<T: serde::Serialize>(value: &T,limit:usize) -> Result<usize, String> {
    editing::count_json_bytes(value, limit)
        .map_err(|e| format!("document_budget: {e}"))
}
impl Ledger {
    pub(super) fn new(doc: &Document) -> Result<Option<Self>, String> {
        // Conservative cache estimate, not a source/node admission ceiling.
        // Declining the cache leaves the existing full budget path in place.
        let estimate=doc.nodes.keys().try_fold(0usize,|sum,id|sum.checked_add(id.len())?.checked_add(256));
        if estimate.is_none_or(|bytes|bytes>MAX_LEDGER_BYTES) { return Ok(None); }
        let bytes=editing::serialized_size(doc).map_err(|e|e.to_string())?;
        let mut entries=BTreeMap::new();
        for (id,node) in &doc.nodes {
            entries.insert(id.clone(),Entry { key:editing::serialized_size(id).map_err(|e|e.to_string())?.checked_add(1).ok_or_else(overflow)?,
                value:editing::serialized_size(node).map_err(|e|e.to_string())? });
        }
        Ok(Some(Self { entries, bytes, storage:estimate.unwrap() }))
    }
    /// The caller owns a validated scoped plan: fields and all nodes outside
    /// `affected` are unchanged. Count every affected node, including signed
    /// zero changes that ordinary PartialEq would treat as equal.
    pub(super) fn prepare(&self, doc: &Document, affected: &BTreeSet<String>) -> Result<Update, String> {
        self.prepare_with_limit(doc,affected,crate::capacity::document_byte_limit())
    }
    fn prepare_with_limit(&self,doc:&Document,affected:&BTreeSet<String>,limit:usize)->Result<Update,String>{
        let mut bytes=self.bytes.checked_sub(commas(self.entries.len())).ok_or_else(overflow)?;
        let mut count=self.entries.len();let mut storage=self.storage;let mut entries=Vec::with_capacity(affected.len());
        for id in affected {
            let old=self.entries.get(id);
            if let Some(old)=old { bytes=bytes.checked_sub(old.key).and_then(|n|n.checked_sub(old.value)).ok_or_else(overflow)?;count=count.checked_sub(1).ok_or_else(overflow)?;storage=storage.checked_sub(id.len()+256).ok_or_else(overflow)?; }
            let next=doc.nodes.get(id).map(|node| -> Result<Entry,String> {
                Ok(Entry { key:match old {Some(old)=>old.key,None=>value_size(id,limit)?.checked_add(1).ok_or_else(overflow)?},value:value_size(node,limit)? })
            }).transpose()?;
            if let Some(next)=next {bytes=bytes.checked_add(next.key).and_then(|n|n.checked_add(next.value)).ok_or_else(overflow)?;count=count.checked_add(1).ok_or_else(overflow)?;storage=storage.checked_add(id.len()).and_then(|n|n.checked_add(256)).ok_or_else(overflow)?;}
            entries.push((id.clone(),next));
        }
        if count!=doc.nodes.len() {return Err("DERIVED_STATE_STALE".into());}
        bytes=bytes.checked_add(commas(count)).ok_or_else(overflow)?;
        if bytes>limit{return Err("DOCUMENT_RESOURCE_LIMIT: serialized document exceeds its exact byte allowance".into());}
        crate::capacity::check_document_bytes(bytes)?;
        Ok(Update { entries,bytes,storage })
    }
    pub(super) fn commit(&mut self, update:Update) -> bool {
        if update.storage>MAX_LEDGER_BYTES{return false;}
        for (id,entry) in update.entries {if let Some(entry)=entry {self.entries.insert(id,entry);}else{self.entries.remove(&id);}}
        self.bytes=update.bytes;self.storage=update.storage;true
    }
    #[cfg(test)] pub(super) fn bytes(&self)->usize {self.bytes}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_lengths_survive_escaped_keys_signed_zero_insert_remove_and_empty_maps() {
        let mut doc:Document=serde_json::from_value(serde_json::json!({"schemaVersion":16,"id":"d","name":"ledger","pages":[{"id":"p","name":"p","children":[],"background":"#fff"}],"nodes":{}})).unwrap();
        let id="中文\"\\😀".to_owned();let mut node=crate::facet::sample_node(&id,"rectangle");
        node.name="\n\tquoted \" label".into();node.transform.0[4]=-0.;doc.nodes.insert(id.clone(),node);
        let mut ledger=Ledger::new(&doc).unwrap().unwrap();
        assert_eq!(ledger.bytes(),serde_json::to_vec(&doc).unwrap().len());
        for round in 0..5 {
            doc.nodes.get_mut(&id).unwrap().transform.0[4]=[0.,1e-20,1e7,-0.,123456.75][round];
            if round==1{let mut n=doc.nodes[&id].clone();n.id="second".into();doc.nodes.insert(n.id.clone(),n);}
            if round==3{doc.nodes.remove("second");}
            let update=ledger.prepare(&doc,&BTreeSet::from([id.clone(),"second".into()])).unwrap();
            assert!(ledger.commit(update));assert_eq!(ledger.bytes(),serde_json::to_vec(&doc).unwrap().len());
        }
        doc.nodes.clear();assert!(ledger.commit(ledger.prepare(&doc,&BTreeSet::from([id])).unwrap()));
        assert_eq!(ledger.bytes(),serde_json::to_vec(&doc).unwrap().len());
    }
    #[test]
    fn exact_limit_rejects_one_byte_more_without_changing_the_receipt_ledger(){
        let mut doc:Document=serde_json::from_value(serde_json::json!({"schemaVersion":16,"id":"d","name":"ledger","pages":[{"id":"p","name":"p","children":["a"],"background":"#fff"}],"nodes":{"a":{"id":"a","kind":"rectangle","width":10,"height":10}}})).unwrap();
        let ledger=Ledger::new(&doc).unwrap().unwrap();let before=ledger.bytes();
        doc.nodes.get_mut("a").unwrap().name="escaped \" 中文 😀".into();
        let expected=serde_json::to_vec(&doc).unwrap().len();let ids=BTreeSet::from(["a".into()]);
        assert_eq!(ledger.prepare_with_limit(&doc,&ids,expected).unwrap().bytes(),expected);
        assert!(ledger.prepare_with_limit(&doc,&ids,expected-1).err().unwrap().contains("DOCUMENT_RESOURCE_LIMIT"));
        assert_eq!(ledger.bytes(),before);
    }
}
