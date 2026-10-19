//! Operation log for collaborative edits.
//!
//! Ops are the unit of editing, transport and undo: every op knows how to
//! apply itself to a node store and how to invert itself against the state
//! it produced, so undo is op replay rather than snapshot diffing.
use crate::facet::{self, Facet, FacetKind};
use crate::handles::{Arena, Handle};
use crate::scene::Node;
use crate::snapshot::NodeStore;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
#[allow(clippy::large_enum_variant)]
pub enum Op {
    SetName {
        id: String,
        name: String,
    },
    SetVisible {
        id: String,
        visible: bool,
    },
    SetOpacity {
        id: String,
        opacity: f64,
    },
    SetTransform {
        id: String,
        matrix: [f64; 6],
    },
    Resize {
        id: String,
        width: f64,
        height: f64,
    },
    ApplyFacet {
        id: String,
        kind: String,
        facet: Facet,
    },
    InsertNode {
        parent: String,
        index: usize,
        node: Node,
    },
    RemoveNode {
        id: String,
    },
    ReorderChild {
        parent: String,
        from: usize,
        to: usize,
    },
    /// Remove authored data behind a facet (stack layout, constraints, …).
    ClearFacet {
        id: String,
        kind: String,
    },
}

/// Provenance of an edit batch, mirroring the reference editor's edit scope
/// kinds (module 942813: `SYSTEM/USER/PLUGIN/ONBOARDING/AUTOSAVE/AI`).
/// Undo grouping and audit queries read it; it never grants authorization.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditSource {
    System,
    #[default]
    User,
    Plugin,
    Onboarding,
    Autosave,
    Ai,
}

impl EditSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            EditSource::System => "system",
            EditSource::User => "user",
            EditSource::Plugin => "plugin",
            EditSource::Onboarding => "onboarding",
            EditSource::Autosave => "autosave",
            EditSource::Ai => "ai",
        }
    }
}

/// Transaction options one op batch carries through the edit-scope
/// primitive. `ignore_undo_redo` mirrors `openIgnoreUndoRedoScope` (edits
/// apply without entering the undo stack); `write_in_readonly` mirrors
/// `openWriteInReadonlyScope` and is a reserved explicit-authorization
/// channel — the kernel has no document-level readonly mode yet (TODO:
/// enforced once such a mode exists; until then it is recorded, not checked).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EditScope {
    pub source: EditSource,
    pub ignore_undo_redo: bool,
    pub write_in_readonly: bool,
}

impl Default for EditScope {
    /// Old callers and old documents predate edit scopes, so the default
    /// submission is a plain user edit that participates in undo.
    fn default() -> Self {
        EditScope {
            source: EditSource::User,
            ignore_undo_redo: false,
            write_in_readonly: false,
        }
    }
}

impl EditScope {
    pub fn from_source(source: EditSource) -> Self {
        EditScope {
            source,
            ..EditScope::default()
        }
    }
}

#[derive(Debug)]
pub enum OpError {
    UnknownNode(String),
    UnknownParent(String),
    BadIndex { parent: String, index: usize },
    BadFacet(String),
}

impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpError::UnknownNode(id) => write!(f, "unknown node `{id}`"),
            OpError::UnknownParent(id) => write!(f, "unknown parent `{id}`"),
            OpError::BadIndex { parent, index } => {
                write!(f, "child index {index} out of range on `{parent}`")
            }
            OpError::BadFacet(message) => write!(f, "facet rejected: {message}"),
        }
    }
}

impl Op {
    pub fn apply(&self, store: &mut NodeStore) -> Result<(), OpError> {
        match self {
            Op::SetName { id, name } => store
                .update(id, |node| node.name = name.clone())
                .map(|_| ())
                .ok_or_else(|| OpError::UnknownNode(id.clone())),
            Op::SetVisible { id, visible } => store
                .update(id, |node| node.visible = *visible)
                .map(|_| ())
                .ok_or_else(|| OpError::UnknownNode(id.clone())),
            Op::SetOpacity { id, opacity } => store
                .update(id, |node| node.opacity = *opacity)
                .map(|_| ())
                .ok_or_else(|| OpError::UnknownNode(id.clone())),
            Op::SetTransform { id, matrix } => store
                .update(id, |node| node.transform = crate::math::Transform(*matrix))
                .map(|_| ())
                .ok_or_else(|| OpError::UnknownNode(id.clone())),
            Op::Resize { id, width, height } => store
                .update(id, |node| crate::mutation::resize(node, *width, *height))
                .map(|_| ())
                .ok_or_else(|| OpError::UnknownNode(id.clone())),
            Op::ApplyFacet { id, kind, facet } => {
                let kind = FacetKind::from_str(kind)
                    .ok_or_else(|| OpError::BadFacet(format!("unknown kind `{kind}`")))?;
                store
                    .update(id, |node| facet::apply_facet(node, kind, facet))
                    .transpose()
                    .map_err(OpError::BadFacet)?
                    .map(|_| ())
                    .ok_or_else(|| OpError::UnknownNode(id.clone()))
            }
            Op::InsertNode {
                parent,
                index,
                node,
            } => {
                if store.get(&node.id).is_some() {
                    return Err(OpError::BadIndex {
                        parent: node.id.clone(),
                        index: 0,
                    });
                }
                let parent_exists = store.get(parent).is_some();
                if !parent_exists {
                    return Err(OpError::UnknownParent(parent.clone()));
                }
                store.insert(node.clone());
                store
                    .update(parent, |parent_node| {
                        let index = (*index).min(parent_node.children.len());
                        parent_node.children.insert(index, node.id.clone());
                    })
                    .map(|_| ())
                    .ok_or_else(|| OpError::UnknownParent(parent.clone()))?;
                Ok(())
            }
            Op::RemoveNode { id } => {
                let removed = store
                    .remove(id)
                    .ok_or_else(|| OpError::UnknownNode(id.clone()))?;
                let parent_id = store
                    .ids()
                    .find(|pid| {
                        store
                            .get(pid)
                            .is_some_and(|p| p.children.iter().any(|c| c == id))
                    })
                    .cloned();
                if let Some(parent_id) = parent_id {
                    store.update(&parent_id, |parent| {
                        parent.children.retain(|child| child != id);
                    });
                }
                std::mem::drop(removed);
                Ok(())
            }
            Op::ClearFacet { id, kind } => {
                let kind_value = FacetKind::from_str(kind)
                    .ok_or_else(|| OpError::BadFacet(format!("unknown kind `{kind}`")))?;
                match kind_value {
                    FacetKind::Stack => store
                        .update(id, |node| node.layout = None)
                        .map(|_| ())
                        .ok_or_else(|| OpError::UnknownNode(id.clone())),
                    FacetKind::Constraints => store
                        .update(id, |node| node.constraints = None)
                        .map(|_| ())
                        .ok_or_else(|| OpError::UnknownNode(id.clone())),
                    FacetKind::Clip => store
                        .update(id, |node| node.clip = false)
                        .map(|_| ())
                        .ok_or_else(|| OpError::UnknownNode(id.clone())),
                    FacetKind::Mask => store
                        .update(id, |node| {
                            node.mask = false;
                            node.mask_type = None;
                        })
                        .map(|_| ())
                        .ok_or_else(|| OpError::UnknownNode(id.clone())),
                    other => Err(OpError::BadFacet(format!(
                        "facet {} has no clearable authored state",
                        other.as_str()
                    ))),
                }
            }
            Op::ReorderChild { parent, from, to } => store
                .update(parent, |parent| {
                    let len = parent.children.len();
                    if *from >= len {
                        return;
                    }
                    let child = parent.children.remove(*from);
                    let to = (*to).min(len - 1);
                    parent.children.insert(to, child);
                })
                .map(|_| ())
                .ok_or_else(|| OpError::UnknownParent(parent.clone())),
        }
    }

    /// Build the op that undoes `self` against the store state BEFORE apply.
    /// Call before mutating, or invert against the post-state semantics used
    /// here (reads run against `store`, so pass the pre-state).
    pub fn invert_against(&self, store: &NodeStore) -> Result<Op, OpError> {
        Ok(match self {
            Op::SetName { id, .. } => Op::SetName {
                id: id.clone(),
                name: store.get(id).map(|n| n.name.clone()).unwrap_or_default(),
            },
            Op::SetVisible { id, .. } => Op::SetVisible {
                id: id.clone(),
                visible: store.get(id).map(|n| n.visible).unwrap_or(true),
            },
            Op::SetOpacity { id, .. } => Op::SetOpacity {
                id: id.clone(),
                opacity: store.get(id).map(|n| n.opacity).unwrap_or(1.),
            },
            Op::SetTransform { id, .. } => Op::SetTransform {
                id: id.clone(),
                matrix: store
                    .get(id)
                    .map(|n| n.transform.0)
                    .unwrap_or([1., 0., 0., 1., 0., 0.]),
            },
            Op::Resize { id, .. } => {
                let node = store
                    .get(id)
                    .ok_or_else(|| OpError::UnknownNode(id.clone()))?;
                Op::Resize {
                    id: id.clone(),
                    width: node.width,
                    height: node.height,
                }
            }
            Op::ApplyFacet { id, kind, .. } => {
                let kind_value = FacetKind::from_str(kind)
                    .ok_or_else(|| OpError::BadFacet(format!("unknown kind `{kind}`")))?;
                match store
                    .get(id)
                    .and_then(|node| facet::facet_view(node, kind_value))
                {
                    Some(previous) => Op::ApplyFacet {
                        id: id.clone(),
                        kind: kind.clone(),
                        facet: previous,
                    },
                    None => Op::ClearFacet {
                        id: id.clone(),
                        kind: kind.clone(),
                    },
                }
            }
            Op::InsertNode { node, .. } => Op::RemoveNode {
                id: node.id.clone(),
            },
            Op::RemoveNode { id } => {
                let node = store
                    .get(id)
                    .ok_or_else(|| OpError::UnknownNode(id.clone()))?;
                let (parent, index) = parent_and_index(store, id)
                    .ok_or_else(|| OpError::UnknownParent(id.clone()))?;
                Op::InsertNode {
                    parent,
                    index,
                    node: node.clone(),
                }
            }
            Op::ClearFacet { id, kind } => {
                let kind_value = FacetKind::from_str(kind)
                    .ok_or_else(|| OpError::BadFacet(format!("unknown kind `{kind}`")))?;
                match store
                    .get(id)
                    .and_then(|node| facet::facet_view(node, kind_value))
                {
                    Some(previous) => Op::ApplyFacet {
                        id: id.clone(),
                        kind: kind.clone(),
                        facet: previous,
                    },
                    None => Op::ClearFacet {
                        id: id.clone(),
                        kind: kind.clone(),
                    },
                }
            }
            Op::ReorderChild { parent, from, .. } => {
                let children = store
                    .get(parent)
                    .map(|p| p.children.clone())
                    .unwrap_or_default();
                let current = children.get(*from).cloned().unwrap_or_default();
                let previous = children
                    .iter()
                    .position(|child| child == &current)
                    .unwrap_or(*from);
                Op::ReorderChild {
                    parent: parent.clone(),
                    from: *from,
                    to: previous,
                }
            }
        })
    }
}

fn parent_and_index(store: &NodeStore, id: &str) -> Option<(String, usize)> {
    for pid in store.ids() {
        if let Some(index) = store.get(pid)?.children.iter().position(|c| c == id) {
            return Some((pid.clone(), index));
        }
    }
    None
}

/// Undo/redo over ops with automatic inversion, driven by the same
/// `NodeStore` the snapshot layer shares.
struct Batch {
    original: Vec<Op>,
    inverses: Vec<Op>,
    /// Provenance of the edit this batch represents (undo grouping/audit).
    source: EditSource,
}

pub struct OpLog {
    store: NodeStore,
    undo: Vec<Batch>,
    redo: Vec<Batch>,
    /// Scope of the most recent successful commit, including
    /// ignore-undo-redo commits that never entered the undo stack.
    last_scope: Option<EditScope>,
    /// Scratch arena so op inversion can hand out temporary handles without
    /// new allocations per call.
    scratch: Arena<()>,
}

impl OpLog {
    pub fn new(store: NodeStore) -> Self {
        OpLog {
            store,
            undo: Vec::new(),
            redo: Vec::new(),
            last_scope: None,
            scratch: Arena::default(),
        }
    }

    pub fn store(&self) -> &NodeStore {
        &self.store
    }

    /// Back-compatible entry point: a plain user edit that participates in
    /// undo. Equivalent to `apply_scoped(ops, EditScope::default())`.
    pub fn apply(&mut self, ops: Vec<Op>) -> Result<(), OpError> {
        self.apply_scoped(ops, EditScope::default())
    }

    /// Apply one batch under an explicit edit scope. `ignore_undo_redo`
    /// batches take effect without creating an undo entry, but like every
    /// commit they invalidate the redo chain captured against earlier states.
    pub fn apply_scoped(&mut self, ops: Vec<Op>, scope: EditScope) -> Result<(), OpError> {
        let mut inverses = Vec::with_capacity(ops.len());
        let mut staged = self.store.clone();
        for op in &ops {
            inverses.push(op.invert_against(&staged)?);
            op.apply(&mut staged)?;
        }
        self.store = staged;
        self.last_scope = Some(scope);
        self.redo.clear();
        if !scope.ignore_undo_redo {
            inverses.reverse();
            self.undo.push(Batch {
                original: ops,
                inverses,
                source: scope.source,
            });
        }
        Ok(())
    }

    /// Undo replays inverses; redo replays the originals against the state
    /// the undo restored.
    pub fn undo(&mut self) -> Result<bool, OpError> {
        let Some(batch) = self.undo.pop() else {
            return Ok(false);
        };
        for op in &batch.inverses {
            op.apply(&mut self.store)?;
        }
        self.redo.push(batch);
        Ok(true)
    }

    pub fn redo(&mut self) -> Result<bool, OpError> {
        let Some(batch) = self.redo.pop() else {
            return Ok(false);
        };
        for op in &batch.original {
            op.apply(&mut self.store)?;
        }
        self.undo.push(batch);
        Ok(true)
    }

    pub fn undo_depth(&self) -> usize {
        self.undo.len()
    }

    pub fn redo_depth(&self) -> usize {
        self.redo.len()
    }

    /// Provenance of every undo entry, oldest first: which source class
    /// produced each batch ("who did this batch" for the audit face).
    pub fn undo_sources(&self) -> Vec<EditSource> {
        self.undo.iter().map(|batch| batch.source).collect()
    }

    /// Provenance of every redo entry, oldest first. Sources travel with the
    /// batch through undo/redo, so redo grouping survives round trips.
    pub fn redo_sources(&self) -> Vec<EditSource> {
        self.redo.iter().map(|batch| batch.source).collect()
    }

    /// Scope of the most recent successful commit, including
    /// ignore-undo-redo commits that are absent from the undo stack.
    pub fn last_commit_scope(&self) -> Option<EditScope> {
        self.last_scope
    }

    pub fn scratch(&mut self) -> Handle {
        self.scratch.alloc(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facet::sample_node;

    fn store() -> NodeStore {
        let mut store = NodeStore::new();
        let mut page = sample_node("p1", "page");
        page.children = vec!["f1".into(), "f2".into()];
        store.insert(page);
        store.insert(sample_node("f1", "frame"));
        store.insert(sample_node("f2", "frame"));
        store
    }

    #[test]
    fn op_inversion_reverts_every_kind() {
        let mut log = OpLog::new(store());
        log.apply(vec![
            Op::SetName {
                id: "f1".into(),
                name: "Renamed".into(),
            },
            Op::Resize {
                id: "f1".into(),
                width: 320.,
                height: 240.,
            },
            Op::SetTransform {
                id: "f2".into(),
                matrix: [2., 0., 0., 2., 5., 6.],
            },
        ])
        .unwrap();
        assert_eq!(log.store().get("f1").unwrap().name, "Renamed");
        assert!((log.store().get("f1").unwrap().width - 320.).abs() < 1e-9);
        log.undo().unwrap();
        assert_eq!(log.store().get("f1").unwrap().name, "");
        assert!((log.store().get("f1").unwrap().width - 100.).abs() < 1e-9);
        assert_eq!(
            log.store().get("f2").unwrap().transform.0,
            [1., 0., 0., 1., 0., 0.]
        );
        log.redo().unwrap();
        assert_eq!(log.store().get("f1").unwrap().name, "Renamed");
    }

    #[test]
    fn insert_remove_round_trip() {
        let mut log = OpLog::new(store());
        let child = sample_node("c1", "rect");
        log.apply(vec![Op::InsertNode {
            parent: "p1".into(),
            index: 1,
            node: child,
        }])
        .unwrap();
        assert_eq!(
            log.store().get("p1").unwrap().children,
            vec!["f1", "c1", "f2"]
        );
        log.undo().unwrap();
        assert_eq!(log.store().get("p1").unwrap().children, vec!["f1", "f2"]);
        assert!(log.store().get("c1").is_none());
    }

    #[test]
    fn unknown_node_is_rejected() {
        let mut log = OpLog::new(store());
        let result = log.apply(vec![Op::SetName {
            id: "ghost".into(),
            name: "x".into(),
        }]);
        assert!(result.is_err());
        assert_eq!(log.undo_depth(), 0, "failed batch must not pollute history");
    }

    #[test]
    fn facet_op_inverts_to_previous_projection() {
        let mut log = OpLog::new(store());
        let op = Op::ApplyFacet {
            id: "f1".into(),
            kind: "stack".into(),
            facet: Facet::Stack {
                horizontal: true,
                grid: false,
                gap: 8.,
                padding: [2.; 4],
            },
        };
        log.apply(vec![op]).unwrap();
        assert!(log.store().get("f1").unwrap().layout.is_some());
        log.undo().unwrap();
        assert!(log.store().get("f1").unwrap().layout.is_none());
    }

    #[test]
    fn edit_source_round_trips_all_six_kinds() {
        let expected = [
            ("system", EditSource::System),
            ("user", EditSource::User),
            ("plugin", EditSource::Plugin),
            ("onboarding", EditSource::Onboarding),
            ("autosave", EditSource::Autosave),
            ("ai", EditSource::Ai),
        ];
        for (wire, value) in expected {
            assert_eq!(serde_json::to_string(&value).unwrap(), format!("\"{wire}\""));
            let parsed: EditSource = serde_json::from_str(&format!("\"{wire}\"")).unwrap();
            assert_eq!(parsed, value);
            assert_eq!(value.as_str(), wire);
        }
        // Unknown classes fail closed instead of silently becoming user.
        assert!(serde_json::from_str::<EditSource>("\"typo\"").is_err());
    }

    #[test]
    fn default_submission_is_a_user_edit_for_old_documents() {
        let mut log = OpLog::new(store());
        log.apply(vec![Op::SetName {
            id: "f1".into(),
            name: "legacy".into(),
        }])
        .unwrap();
        assert_eq!(log.undo_sources(), vec![EditSource::User]);
        assert_eq!(
            log.last_commit_scope(),
            Some(EditScope {
                source: EditSource::User,
                ignore_undo_redo: false,
                write_in_readonly: false
            })
        );
        // A default scope also deserializes from `{}`.
        assert_eq!(serde_json::from_str::<EditScope>("{}").unwrap(), EditScope::default());
    }

    #[test]
    fn ignore_undo_redo_batch_takes_effect_without_an_undo_entry() {
        let mut log = OpLog::new(store());
        log.apply(vec![Op::SetName {
            id: "f1".into(),
            name: "visible".into(),
        }])
        .unwrap();
        log.undo().unwrap();
        assert_eq!(log.redo_depth(), 1);
        log.apply_scoped(
            vec![Op::SetName {
                id: "f1".into(),
                name: "silent".into(),
            }],
            EditScope {
                source: EditSource::System,
                ignore_undo_redo: true,
                write_in_readonly: false,
            },
        )
        .unwrap();
        assert_eq!(log.store().get("f1").unwrap().name, "silent");
        assert_eq!(log.undo_depth(), 0, "ignored batch must not enter the undo stack");
        assert_eq!(log.redo_depth(), 0, "document moved on, redo entries are stale");
        let scope = log.last_commit_scope().unwrap();
        assert!(scope.ignore_undo_redo && scope.source == EditSource::System);
    }

    #[test]
    fn batch_sources_are_queryable_and_travel_through_undo_redo() {
        let mut log = OpLog::new(store());
        for (name, source) in [
            ("a", EditSource::User),
            ("b", EditSource::Ai),
            ("c", EditSource::Plugin),
        ] {
            log.apply_scoped(
                vec![Op::SetName {
                    id: "f1".into(),
                    name: name.into(),
                }],
                EditScope::from_source(source),
            )
            .unwrap();
        }
        assert_eq!(
            log.undo_sources(),
            vec![EditSource::User, EditSource::Ai, EditSource::Plugin]
        );
        log.undo().unwrap();
        assert_eq!(log.undo_sources(), vec![EditSource::User, EditSource::Ai]);
        assert_eq!(log.redo_sources(), vec![EditSource::Plugin]);
        log.redo().unwrap();
        assert_eq!(
            log.undo_sources(),
            vec![EditSource::User, EditSource::Ai, EditSource::Plugin]
        );
    }
}
