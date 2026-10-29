//! Host-authorized immutable source snapshots. The renderer receives opaque
//! capabilities; only the desktop host can turn one into this file descriptor.
use crate::scene::Document;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{fs::File, io::{self, BufReader, Read}, path::PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor { path: PathBuf, bytes: u64, hash: String, document_id: String, page_id: String, stage_id: String, nodes: usize }
struct Source { file: File, bytes: u64, hash: Sha256 }
impl Read for Source {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let count=self.file.read(bytes)?;
        self.bytes=self.bytes.checked_add(count as u64).ok_or_else(||io::Error::other("Source snapshot byte overflow"))?;
        self.hash.update(&bytes[..count]); Ok(count)
    }
}
pub(super) fn read(value: &serde_json::Value) -> Result<Document,String> {
    let descriptor:Descriptor=serde_json::from_value(value.clone()).map_err(|_|"Invalid source snapshot descriptor")?;
    if !descriptor.path.is_absolute() || descriptor.bytes==0 || descriptor.hash.len()!=64 || !descriptor.hash.bytes().all(|b|b.is_ascii_hexdigit()&&!b.is_ascii_uppercase()) {
        return Err("Invalid source snapshot descriptor".into());
    }
    let metadata=std::fs::symlink_metadata(&descriptor.path).map_err(|e|e.to_string())?;
    if !metadata.is_file()||metadata.len()!=descriptor.bytes{return Err("Source snapshot file changed".into());}
    let mut source=Source{file:File::open(&descriptor.path).map_err(|e|e.to_string())?,bytes:0,hash:Sha256::new()};
    // The giant source never becomes a JSON String, a serde Value, or an IPC
    // clone. Hash exactly the bytes consumed before publishing the typed model.
    let doc:Document=serde_json::from_reader(BufReader::with_capacity(64*1024,&mut source)).map_err(|e|format!("Invalid source snapshot: {e}"))?;
    if source.bytes!=descriptor.bytes||format!("{:x}",source.hash.finalize())!=descriptor.hash{return Err("Source snapshot content changed".into());}
    if doc.id!=descriptor.document_id||doc.nodes.len()!=descriptor.nodes||doc.pages.first().is_none_or(|page|page.id!=descriptor.page_id||page.children!=[descriptor.stage_id.clone()])||
        doc.nodes.get(&descriptor.stage_id).is_none_or(|node|node.kind!="frame"){
        return Err("Source snapshot canvas identity changed".into());
    }
    Ok(doc)
}
