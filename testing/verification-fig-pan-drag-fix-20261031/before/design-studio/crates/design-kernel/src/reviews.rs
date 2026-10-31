//! Local review pins are document metadata, never painted into exported artwork.
use crate::{math::Point, scene::Document};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Message {
    pub id: String,
    pub author: String,
    pub text: String,
    pub created_at: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Review {
    pub id: String,
    pub page_id: String,
    pub position: Point,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    pub kind: String,
    pub resolved: bool,
    pub messages: Vec<Message>,
}
pub fn validate(doc: &Document) -> Result<(), String> {
    if doc.reviews.is_empty() {
        return Ok(());
    }
    if doc.schema_version < 10 || doc.reviews.len() > 2000 {
        return Err("Local reviews require schema 10; maximum 2000 threads".into());
    }
    let mut ids = std::collections::HashSet::new();
    for review in &doc.reviews {
        if review.id.is_empty()
            || review.id.len() > 128
            || !ids.insert(review.id.as_str())
            || !review.position.finite()
            || review.position.x.abs() > 1e7
            || review.position.y.abs() > 1e7
            || !doc.pages.iter().any(|p| p.id == review.page_id)
            || review
                .node_id
                .as_ref()
                .is_some_and(|id| !doc.nodes.contains_key(id))
            || !matches!(review.kind.as_str(), "comment" | "annotation")
            || review.messages.is_empty()
            || review.messages.len() > 1000
        {
            return Err("Invalid local review".into());
        }
        for m in &review.messages {
            if m.id.is_empty()
                || m.id.len() > 128
                || !ids.insert(m.id.as_str())
                || m.author.is_empty()
                || m.author.encode_utf16().count() > 200
                || m.text.trim().is_empty()
                || m.text.encode_utf16().count() > 10000
            {
                return Err("Invalid local review message".into());
            }
        }
    }
    Ok(())
}
