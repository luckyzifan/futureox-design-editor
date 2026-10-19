use std::collections::HashMap;
use crate::scene::Document;

/// Authored topology for a validated document. Transform-only edits cannot
/// change these edges; all structural/property installs replace the index.
pub(crate) struct RenderIndex {
    pub(crate) parents: HashMap<String, String>,
    pub(crate) has_connectors: bool,
}
impl RenderIndex {
    pub(crate) fn new(document: &Document) -> Self {
        Self {
            parents: document.nodes.values().flat_map(|node|
                node.children.iter().map(move |child| (child.clone(), node.id.clone()))).collect(),
            has_connectors: document.nodes.values().any(|node| node.connector.is_some()),
        }
    }
}
