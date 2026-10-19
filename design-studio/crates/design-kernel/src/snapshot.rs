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
/// HAMT, so snapshotting only copies the spine.
#[derive(Clone, Default)]
pub struct NodeStore {
    nodes: OrdMap<String, Arc<Node>>,
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
        }
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
        let result = f(&mut node);
        self.nodes.insert(id.into(), Arc::new(node));
        Some(result)
    }

    pub fn insert(&mut self, node: Node) {
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
}
