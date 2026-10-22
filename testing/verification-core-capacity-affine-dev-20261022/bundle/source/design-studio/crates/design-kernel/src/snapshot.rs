//! Immutable document snapshots with an undo buffer.
//!
//! Snapshots share unchanged nodes through `Arc`, so pushing an undo point
//! costs one structural clone instead of a deep copy.  The buffer keeps a
//! primary undo chain plus redo entries, mirroring an editor where a live
//! document always has an active undo buffer.
use crate::scene::{Document, Node};
use im::OrdMap;
use std::collections::VecDeque;
use std::sync::Arc;

const HISTORY_LIMIT: usize = 128;

/// Structurally shared node store: nodes are `Arc`d and the map is an
/// ordered persistent B-tree, so snapshots share unchanged map structure.
#[derive(Clone, Default)]
pub struct NodeStore {
    nodes: OrdMap<String, Arc<Node>>,
    // PartialEq collapses signed zero. Reuse is allowed only for projections
    // proven free of negative-zero f32/f64 values by their original JSON.
    // Arbitrary typed writes invalidate this proof; Clone/undo retain it.
    exact_float_equality_safe: bool,
}

impl NodeStore {
    pub fn new() -> Self {
        NodeStore::default()
    }

    pub fn from_document(document: &Document) -> Self {
        NodeStore {
            nodes: document
                .nodes
                .iter()
                .map(|(id, node)| (id.clone(), Arc::new(node.clone())))
                .collect(),
            exact_float_equality_safe: false,
        }
    }

    /// Adopt a freshly parsed node map without cloning each owned node.
    pub(crate) fn from_owned_json_nodes(nodes: std::collections::BTreeMap<String, Node>, json: &str) -> Self {
        Self {
            nodes: nodes.into_iter().map(|(id, node)| (id, Arc::new(node))).collect(),
            exact_float_equality_safe: json_supports_exact_float_equality(json),
        }
    }

    /// Replace a same-document projection, retaining equal immutable allocations.
    /// Ordered merge visits each old/new ID once and compares each matching Node
    /// once; only changed/inserted/deleted entries update the persistent map.
    /// Cost is O(old + new + compared payload + changes * log N), not all-pairs.
    /// The caller owns document-identity checks; no process-global interning occurs.
    pub(crate) fn replacing_nodes(&self, nodes: std::collections::BTreeMap<String, Node>, json: &str) -> Self {
        let exact_float_equality_safe = json_supports_exact_float_equality(json);
        if !self.exact_float_equality_safe || !exact_float_equality_safe {
            return Self {
                nodes: nodes.into_iter().map(|(id, node)| (id, Arc::new(node))).collect(),
                exact_float_equality_safe,
            };
        }
        let mut result = self.nodes.clone();
        let mut previous = self.nodes.iter().peekable();
        for (id, node) in nodes {
            while previous.peek().is_some_and(|(old_id, _)| old_id.as_str() < id.as_str()) {
                let (removed, _) = previous.next().expect("peeked previous node");
                result.remove(removed);
            }
            let unchanged = if previous.peek().is_some_and(|(old_id, _)| *old_id == &id) {
                let (_, old_node) = previous.next().expect("peeked matching node");
                old_node.as_ref() == &node
            } else {
                false
            };
            if !unchanged { result.insert(id, Arc::new(node)); }
        }
        for (removed, _) in previous { result.remove(removed); }
        Self { nodes: result, exact_float_equality_safe }
    }

    pub fn get(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id).map(|arc| arc.as_ref())
    }

    /// Copy-on-write: the Arc is cloned only when this handle is exclusive.
    pub fn update<F, T>(&mut self, id: &str, f: F) -> Option<T>
    where
        F: FnOnce(&mut Node) -> T,
    {
        let arc = self.nodes.get(id)?;
        let mut node = Node::clone(arc);
        self.exact_float_equality_safe = false;
        let result = f(&mut node);
        self.nodes.insert(id.into(), Arc::new(node));
        Some(result)
    }

    pub fn insert(&mut self, node: Node) {
        self.exact_float_equality_safe = false;
        self.nodes.insert(node.id.clone(), Arc::new(node));
    }

    pub fn remove(&mut self, id: &str) -> Option<Arc<Node>> {
        self.nodes.remove(id)
    }

    pub fn ids(&self) -> impl Iterator<Item = &String> {
        self.nodes.keys()
    }

    /// Allocation address of a stored node, for structural-sharing tests.
    pub fn arc_ptr(&self, id: &str) -> Option<*const Node> {
        self.nodes.get(id).map(Arc::as_ptr)
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn to_document(&self, base: &Document) -> Document {
        let mut document = base.clone();
        document.nodes = self
            .nodes
            .iter()
            .map(|(id, node)| (id.clone(), (**node).clone()))
            .collect();
        document
    }
}


/// Inspect an already successfully parsed document JSON buffer, without cloning
/// strings or serializing nodes. Signed-zero numeric values (including exponent
/// underflow) conservatively disable sharing for the complete projection. Text,
/// escaped strings and base64 payloads do not act as numeric tokens.
fn json_supports_exact_float_equality(json: &str) -> bool {
    let bytes = json.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'"' => {
                at += 1;
                loop {
                    match bytes.get(at) {
                        Some(b'\\') => at += 2,
                        Some(b'"') => { at += 1; break; }
                        Some(_) => at += 1,
                        None => return false,
                    }
                }
            }
            b'-' | b'0'..=b'9' => {
                let start = at;
                at += 1;
                while at < bytes.len() && matches!(bytes[at], b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-') {
                    at += 1;
                }
                if bytes[start] != b'-' { continue; }
                let token = &bytes[start..at];
                // Use serde_json's own numeric conversion, including f32 fields:
                // -1e-999 can become -0 even though it does not begin with -0.
                let Ok(wide) = serde_json::from_slice::<f64>(token) else { return false; };
                let Ok(narrow) = serde_json::from_slice::<f32>(token) else { return false; };
                if (wide == 0.0 && wide.is_sign_negative()) || (narrow == 0.0 && narrow.is_sign_negative()) {
                    return false;
                }
            }
            _ => at += 1,
        }
    }
    true
}

#[derive(Clone)]
pub struct DocVersion {
    pub revision: u64,
    pub store: NodeStore,
}

/// Undo/redo buffer over immutable versions.
pub struct History {
    current: DocVersion,
    undo: Vec<DocVersion>,
    redo: VecDeque<DocVersion>,
    next_revision: u64,
}

impl History {
    pub fn new(document: &Document) -> Self {
        History {
            current: DocVersion {
                revision: 0,
                store: NodeStore::from_document(document),
            },
            undo: Vec::new(),
            redo: VecDeque::new(),
            next_revision: 1,
        }
    }

    pub fn revision(&self) -> u64 {
        self.current.revision
    }

    pub fn store(&self) -> &NodeStore {
        &self.current.store
    }

    pub fn store_mut(&mut self) -> &mut NodeStore {
        &mut self.current.store
    }

    /// Publish the working store under a new revision; drops the redo chain.
    pub fn push_undo_point(&mut self) -> u64 {
        self.undo.push(self.current.clone());
        if self.undo.len() > HISTORY_LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
        let revision = self.next_revision;
        self.next_revision += 1;
        self.current = DocVersion {
            revision,
            store: self.current.store.clone(),
        };
        revision
    }

    pub fn undo(&mut self) -> Option<u64> {
        let previous = self.undo.pop()?;
        self.redo
            .push_back(std::mem::replace(&mut self.current, previous));
        Some(self.current.revision)
    }

    pub fn redo(&mut self) -> Option<u64> {
        let next = self.redo.pop_front()?;
        self.undo.push(std::mem::replace(&mut self.current, next));
        Some(self.current.revision)
    }

    pub fn undo_depth(&self) -> usize {
        self.undo.len()
    }

    pub fn redo_depth(&self) -> usize {
        self.redo.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facet::sample_node;

    fn document_with(node_count: usize) -> Document {
        let mut document = Document {
            reviews: Vec::new(),
            design_system: None,
            prototype: None,
            fd_compatibility: None,
            schema_version: 1,
            color_management: None,
            raster_profile: None,
            id: "d1".into(),
            name: "Doc".into(),
            pages: vec![crate::scene::Page {
                guides: vec![],
                id: "p1".into(),
                name: "Page 1".into(),
                children: (0..node_count).map(|i| format!("n{i}")).collect(),
                background: "#ffffff".into(),
            }],
            nodes: (0..node_count)
                .map(|i| {
                    let mut node = sample_node(&format!("n{i}"), "frame");
                    node.name = format!("Node {i}");
                    node
                })
                .map(|node| (node.id.clone(), node))
                .collect(),
            fonts: Default::default(),
            animations: Vec::new(),
        };
        document.nodes.insert("p1".into(), {
            let mut page = sample_node("p1", "page");
            page.children = (0..node_count).map(|i| format!("n{i}")).collect();
            page
        });
        document
    }

    #[test]
    fn undo_rewind_restores_state() {
        let document = document_with(3);
        let mut history = History::new(&document);
        assert_eq!(history.push_undo_point(), 1);
        history
            .store_mut()
            .update("n1", |node| node.name = "Renamed".into())
            .unwrap();
        assert_eq!(history.store().get("n1").unwrap().name, "Renamed");
        assert!(history.undo().is_some());
        assert_eq!(history.store().get("n1").unwrap().name, "Node 1");
        assert!(history.redo().is_some());
        assert_eq!(history.store().get("n1").unwrap().name, "Renamed");
    }

    #[test]
    fn edits_drop_redo_chain() {
        let document = document_with(2);
        let mut history = History::new(&document);
        history.push_undo_point();
        history.undo();
        assert_eq!(history.redo_depth(), 1);
        history
            .store_mut()
            .update("n0", |node| node.opacity = 0.5)
            .unwrap();
        history.push_undo_point();
        assert_eq!(history.redo_depth(), 0, "new revision must clear redo");
    }

    #[test]
    fn snapshots_share_unchanged_nodes() {
        let document = document_with(4);
        let mut history = History::new(&document);
        let before = history.store().arc_ptr("n2").unwrap() as usize;
        history.push_undo_point();
        history
            .store_mut()
            .update("n0", |node| node.opacity = 0.1)
            .unwrap();
        let after = history.store().arc_ptr("n2").unwrap() as usize;
        assert_eq!(before, after, "untouched nodes must keep their allocation");
    }

    #[test]
    fn history_is_bounded() {
        let document = document_with(1);
        let mut history = History::new(&document);
        for _ in 0..(HISTORY_LIMIT + 20) {
            history.push_undo_point();
        }
        assert_eq!(history.undo_depth(), HISTORY_LIMIT);
    }
    #[test]
    fn exact_float_json_scan_handles_escaped_strings_nested_values_and_underflow() {
        for json in [r#"{"x":-0}"#, r#"{"x":-0.0}"#, r#"{"nested":{"x":[-0e4]}}"#,
                     r#"{"x":-1e-999}"#, r#"{"x":-1e-99}"#] {
            assert!(!json_supports_exact_float_equality(json), "unsafe numeric token: {json}");
        }
        for json in [r#"{"x":0.0,"negative":-1.0,"fraction":-0.25}"#,
                     r#"{"text":"-0 -1e-999","nested":[1e-999,0]}"#,
                     r#"{"text":"escaped\" -0 \\","next":-1.0}"#] {
            assert!(serde_json::from_str::<serde_json::Value>(json).is_ok(), "test JSON must be valid");
            assert!(json_supports_exact_float_equality(json), "safe numeric projection: {json}");
        }
    }

    #[test]
    fn typed_store_insert_and_update_invalidate_exact_float_reuse_proof() {
        let document = document_with(2);
        let json = serde_json::to_string(&document).unwrap();
        let initial = NodeStore::from_owned_json_nodes(document.nodes.clone(), &json);
        assert!(initial.exact_float_equality_safe);
        let cloned = initial.clone();
        assert!(cloned.exact_float_equality_safe);
        let mut updated = initial.clone();
        updated.update("n0", |node| node.opacity = -0.0).unwrap();
        assert!(!updated.exact_float_equality_safe);
        let old_sibling = updated.arc_ptr("n1").unwrap();
        let replaced = updated.replacing_nodes(document.nodes.clone(), &json);
        assert!(replaced.exact_float_equality_safe);
        assert_ne!(replaced.arc_ptr("n1").unwrap(), old_sibling, "unknown typed state conservatively gets a fresh projection");
        let mut inserted = cloned;
        let mut node = sample_node("n0", "frame"); node.opacity = -0.0;
        inserted.insert(node);
        assert!(!inserted.exact_float_equality_safe);
        let replaced = inserted.replacing_nodes(document.nodes.clone(), &json);
        assert_eq!(replaced.get("n0").unwrap().opacity.to_bits(), document.nodes["n0"].opacity.to_bits());
        assert!(initial.exact_float_equality_safe, "writes cannot invalidate an immutable old snapshot");
    }

}
