//! Handle-based editing API over the document.
//!
//! The JS side addresses nodes, tiles and op batches through opaque `u32`
//! handles instead of shuttling JSON per query.  Every mutation flows
//! through the op log, so undo, redo and transport all replay the same
//! operations.
use crate::facet::{self, Facet, FacetKind};
use crate::handles::{Arena, Handle, INVALID};
use crate::ops::{EditScope, EditSource, Op, OpError, OpLog};
use crate::protocol::{self, Compression, Frame};
use crate::scene::{Document, Node};
use crate::snapshot::NodeStore;
use crate::tile_stack::{Rect, TileKey, TileStack};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Debug)]
pub enum Error {
    Json(String),
    Op(OpError),
    Binary(crate::binfmt::Error),
    UnknownHandle(u32),
    UnknownFacet(String),
    Protocol(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Json(e) => write!(f, "json error: {e}"),
            Error::Op(e) => write!(f, "{e}"),
            Error::Binary(e) => write!(f, "{e}"),
            Error::UnknownHandle(raw) => write!(f, "stale or unknown handle {raw}"),
            Error::UnknownFacet(kind) => write!(f, "unknown facet `{kind}`"),
            Error::Protocol(e) => write!(f, "protocol error: {e}"),
        }
    }
}

const HISTORY_LIMIT: usize = 128;

/// Rejection message for scopeless edits under strict mode, mirroring the
/// reference engine's `EditScopeWebBindings_onMissingEditScope` bell
/// ("No edit scope is active").
pub const NO_EDIT_SCOPE_ACTIVE: &str = "no edit scope is active";

#[derive(Clone)]
struct GraphSnapshot {
    base: Arc<Document>,
    store: NodeStore,
    /// Provenance of the edit this history entry reverts (undo stack) or
    /// re-applies (redo stack); the entry travels between both stacks.
    edit_source: EditSource,
}

/// Enveloped op submission: `{"ops":[…],"source":"ai","ignoreUndoRedo":false,
/// "writeInReadonly":false}`. A bare `[…]` array remains the back-compatible
/// default-user submission.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpsSubmission {
    ops: Vec<Op>,
    #[serde(default)]
    source: Option<EditSource>,
    #[serde(default)]
    ignore_undo_redo: bool,
    #[serde(default)]
    write_in_readonly: bool,
}

pub struct GraphApi {
    base: Arc<Document>,
    log: OpLog,
    nodes: Arena<String>,
    tiles: TileStack,
    // One chronological journal for document replacements and op batches.
    undo: Vec<GraphSnapshot>,
    redo: Vec<GraphSnapshot>,
    revision: u64,
    /// Opt-in guard mirroring the reference engine's mandatory edit scopes:
    /// when set, commits without a declared scope are rejected. Off by
    /// default because the TS frontend owns its own commit path today.
    scope_strict: bool,
    /// Ambient edit-scope session (openEditScope/closeEditScope analogue).
    /// Commits while a scope is open attach the innermost scope.
    scope_stack: Vec<(EditScope, u32)>,
    next_scope_token: u32,
    /// Scope of the most recent successful commit, including
    /// ignore-undo-redo commits absent from the undo stack.
    last_scope: Option<EditScope>,
}

impl GraphApi {
    pub fn new(document_json: &str) -> Result<Self, Error> {
        let mut document: Document =
            serde_json::from_str(document_json).map_err(|e| Error::Json(e.to_string()))?;
        let store = NodeStore::from_owned_json_nodes(std::mem::take(&mut document.nodes), document_json);
        let mut api = GraphApi {
            log: OpLog::new(store),
            base: Arc::new(document),
            nodes: Arena::default(),
            tiles: TileStack::default(),
            undo: Vec::new(),
            redo: Vec::new(),
            revision: 1,
            scope_strict: false,
            scope_stack: Vec::new(),
            next_scope_token: 1,
            last_scope: None,
        };
        let ids: Vec<String> = api.log.store().ids().cloned().collect();
        for id in ids {
            api.nodes.alloc(id);
        }
        Ok(api)
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    fn snapshot(&self) -> GraphSnapshot {
        GraphSnapshot {
            base: self.base.clone(),
            store: self.log.store().clone(),
            edit_source: EditSource::User,
        }
    }

    fn install(&mut self, snapshot: GraphSnapshot) {
        // Handles name either a store node or a page in the immutable base.
        // A transform and its undo/redo preserve both sets of identities.
        let same_handles = Arc::ptr_eq(&self.base, &snapshot.base)
            && self.log.store().shares_node_ids(&snapshot.store);
        self.base = snapshot.base;
        self.log = OpLog::new(snapshot.store);
        self.revision += 1;
        if same_handles {
            return;
        }
        // Keep existing identities, retire removed ones; never reset generations.
        let stale: Vec<_> = self
            .nodes
            .handles()
            .filter(|h| {
                self.nodes.get(*h).is_some_and(|id| {
                    self.log.store().get(id).is_none()
                        && !self.base.pages.iter().any(|p| &p.id == id)
                })
            })
            .collect();
        for h in stale {
            self.nodes.free(h);
        }
    }

    fn commit_scoped(&mut self, next: GraphSnapshot, source: EditSource) {
        let mut previous = self.snapshot();
        previous.edit_source = source;
        self.undo.push(previous);
        if self.undo.len() > HISTORY_LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.install(next);
    }

    // -- edit scopes ----------------------------------------------------------

    /// Resolve the scope a commit runs under. An explicit scope wins (it is
    /// the innermost declaration), then the ambient session's innermost open
    /// scope, then the default user scope — unless strict mode rejects the
    /// scopeless submission outright, mirroring the reference engine's
    /// mandatory edit scopes.
    fn scope_for_commit(&self, explicit: Option<EditScope>) -> Result<EditScope, Error> {
        if let Some(scope) = explicit {
            return Ok(scope);
        }
        if let Some((scope, _)) = self.scope_stack.last() {
            return Ok(*scope);
        }
        if self.scope_strict {
            return Err(Error::Protocol(NO_EDIT_SCOPE_ACTIVE.into()));
        }
        Ok(EditScope::default())
    }

    /// When true, every commit must declare a scope (explicit parameter or an
    /// open ambient session); default submissions are rejected with
    /// `NO_EDIT_SCOPE_ACTIVE`. Off by default for old callers.
    pub fn set_edit_scope_strict(&mut self, strict: bool) {
        self.scope_strict = strict;
    }

    pub fn edit_scope_strict(&self) -> bool {
        self.scope_strict
    }

    /// Open an ambient edit scope; every commit until the matching close runs
    /// under it. Returns the token `close_edit_scope` requires.
    pub fn open_edit_scope(&mut self, scope: EditScope) -> u32 {
        let token = self.next_scope_token;
        self.next_scope_token += 1;
        self.scope_stack.push((scope, token));
        token
    }

    /// Close the innermost open scope; scopes close in LIFO order like the
    /// reference engine's nested edit scopes.
    pub fn close_edit_scope(&mut self, token: u32) -> Result<(), Error> {
        match self.scope_stack.last() {
            Some((_, top)) if *top == token => {
                self.scope_stack.pop();
                Ok(())
            }
            Some(_) => Err(Error::Protocol(
                "edit scopes must close in LIFO order".into(),
            )),
            None => Err(Error::Protocol("no edit scope is open".into())),
        }
    }

    pub fn active_edit_scope(&self) -> Option<EditScope> {
        self.scope_stack.last().map(|(scope, _)| *scope)
    }

    pub fn edit_scope_depth(&self) -> usize {
        self.scope_stack.len()
    }

    /// Metadata and structurally shared nodes use one bounded history timeline.
    pub fn replace_document(&mut self, document_json: &str) -> Result<u64, Error> {
        self.replace_document_with_scope(document_json, None)
    }

    pub fn replace_document_scoped(
        &mut self,
        document_json: &str,
        scope: EditScope,
    ) -> Result<u64, Error> {
        self.replace_document_with_scope(document_json, Some(scope))
    }

    fn replace_document_with_scope(
        &mut self,
        document_json: &str,
        explicit: Option<EditScope>,
    ) -> Result<u64, Error> {
        let scope = self.scope_for_commit(explicit)?;
        let mut next: Document =
            serde_json::from_str(document_json).map_err(|e| Error::Json(e.to_string()))?;
        // Appends change page metadata and therefore use whole-document replace.
        // Preserve equal nodes across these revisions instead of retaining a new
        // deep node graph for every undo entry. A different document never borrows
        // the previous document's allocations, even if its IDs/content coincide.
        let nodes = std::mem::take(&mut next.nodes);
        let store = if next.id == self.base.id {
            self.log.store().replacing_nodes(nodes, document_json)
        } else {
            NodeStore::from_owned_json_nodes(nodes, document_json)
        };
        self.last_scope = Some(scope);
        let snapshot = GraphSnapshot {
            base: Arc::new(next),
            store,
            edit_source: scope.source,
        };
        if scope.ignore_undo_redo {
            self.redo.clear();
            self.install(snapshot);
        } else {
            self.commit_scoped(snapshot, scope.source);
        }
        Ok(self.revision())
    }

    pub fn document_json(&self) -> String {
        serde_json::to_string(&self.log.store().to_document(&self.base))
            .expect("document serializes")
    }

    // -- handle plumbing ----------------------------------------------------

    pub fn node_handle(&mut self, id: &str) -> u32 {
        if let Some(handle) = self
            .nodes
            .handles()
            .find(|&h| self.nodes.get(h).is_some_and(|v| v == id))
        {
            return handle.raw();
        }
        match self.log.store().get(id) {
            Some(_) => self.nodes.alloc(id.into()).raw(),
            None if self.base.pages.iter().any(|p| p.id == id) => self.nodes.alloc(id.into()).raw(),
            None => INVALID,
        }
    }

    fn node_id(&self, handle: u32) -> Result<&str, Error> {
        self.nodes
            .get(Handle::from_raw(handle))
            .map(|s| s.as_str())
            .ok_or(Error::UnknownHandle(handle))
    }

    pub fn node_exists(&self, handle: u32) -> bool {
        self.node_id(handle).is_ok()
    }

    pub fn node_id_string(&self, handle: u32) -> Result<String, Error> {
        Ok(self.node_id(handle)?.to_owned())
    }

    fn node(&self, handle: u32) -> Result<&Node, Error> {
        let id = self.node_id(handle)?;
        self.log.store().get(id).ok_or(Error::UnknownHandle(handle))
    }

    pub fn node_kind(&self, handle: u32) -> Result<String, Error> {
        let id = self.node_id(handle)?;
        if self.base.pages.iter().any(|p| p.id == id) {
            return Ok("page".into());
        }
        Ok(self.node(handle)?.kind.clone())
    }

    pub fn node_name(&self, handle: u32) -> Result<String, Error> {
        let id = self.node_id(handle)?;
        if let Some(p) = self.base.pages.iter().find(|p| p.id == id) {
            return Ok(p.name.clone());
        }
        Ok(self.node(handle)?.name.clone())
    }

    pub fn node_children(&mut self, handle: u32) -> Result<Vec<u32>, Error> {
        let id = self.node_id(handle)?;
        let ids = if let Some(p) = self.base.pages.iter().find(|p| p.id == id) {
            p.children.clone()
        } else {
            self.node(handle)?.children.clone()
        };
        Ok(ids.iter().map(|id| self.node_handle(id)).collect())
    }

    pub fn node_parent(&mut self, handle: u32) -> Result<u32, Error> {
        let id = self.node_id(handle)?.to_owned();
        let parent = self
            .log
            .store()
            .ids()
            .find(|pid| {
                self.log
                    .store()
                    .get(pid)
                    .is_some_and(|p| p.children.contains(&id))
            })
            .cloned();
        match parent {
            Some(pid) => Ok(self.node_handle(&pid)),
            None => {
                let page = self
                    .base
                    .pages
                    .iter()
                    .find(|p| p.children.contains(&id))
                    .map(|p| p.id.clone());
                Ok(page.map(|id| self.node_handle(&id)).unwrap_or(INVALID))
            }
        }
    }

    /// Nearest page (canvas) ancestor, or the node itself when it is a page.
    pub fn find_containing_page(&mut self, handle: u32) -> Result<u32, Error> {
        let mut at = handle;
        let mut seen = std::collections::BTreeSet::new();
        while at != INVALID && seen.insert(at) {
            if self.node_kind(at)? == "page" {
                return Ok(at);
            }
            at = self.node_parent(at)?;
        }
        Ok(INVALID)
    }

    // -- reads ---------------------------------------------------------------

    pub fn node_transform(&self, handle: u32) -> Result<[f64; 6], Error> {
        Ok(self.node(handle)?.transform.0)
    }

    pub fn node_visible(&self, handle: u32) -> Result<bool, Error> {
        Ok(self.node(handle)?.visible)
    }

    pub fn node_opacity(&self, handle: u32) -> Result<f64, Error> {
        Ok(self.node(handle)?.opacity)
    }

    // -- writes (all through the op log) --------------------------------------

    fn apply(&mut self, ops: Vec<Op>) -> Result<(), Error> {
        self.apply_scoped(ops, None)
    }

    /// Commit one op batch under the resolved edit scope. Batches stage
    /// atomically: an `OpError` leaves the store, history and provenance
    /// untouched. `ignore_undo_redo` batches install without an undo entry
    /// but still invalidate the redo chain, like every other commit.
    fn apply_scoped(&mut self, ops: Vec<Op>, explicit: Option<EditScope>) -> Result<(), Error> {
        if ops.is_empty() {
            return Ok(());
        }
        let scope = self.scope_for_commit(explicit)?;
        let mut staged = OpLog::new(self.log.store().clone());
        staged.apply_scoped(ops, scope).map_err(Error::Op)?;
        self.last_scope = Some(scope);
        let next = GraphSnapshot {
            base: self.base.clone(),
            store: staged.store().clone(),
            edit_source: scope.source,
        };
        if scope.ignore_undo_redo {
            self.redo.clear();
            self.install(next);
            return Ok(());
        }
        self.commit_scoped(next, scope.source);
        Ok(())
    }

    /// Rust-native scoped commit face for hosts that prefer typed scopes over
    /// the JSON envelope.
    pub fn apply_ops_scoped(&mut self, ops: Vec<Op>, scope: EditScope) -> Result<(), Error> {
        self.apply_scoped(ops, Some(scope))
    }

    pub fn set_name(&mut self, handle: u32, name: &str) -> Result<(), Error> {
        let id = self.node_id(handle)?.to_owned();
        self.apply(vec![Op::SetName {
            id,
            name: name.into(),
        }])
    }

    pub fn set_visible(&mut self, handle: u32, visible: bool) -> Result<(), Error> {
        let id = self.node_id(handle)?.to_owned();
        self.apply(vec![Op::SetVisible { id, visible }])
    }

    pub fn set_opacity(&mut self, handle: u32, opacity: f64) -> Result<(), Error> {
        let id = self.node_id(handle)?.to_owned();
        self.apply(vec![Op::SetOpacity { id, opacity }])
    }

    pub fn set_transform(&mut self, handle: u32, matrix: [f64; 6]) -> Result<(), Error> {
        let id = self.node_id(handle)?.to_owned();
        self.apply(vec![Op::SetTransform { id, matrix }])
    }

    pub fn resize(&mut self, handle: u32, width: f64, height: f64) -> Result<(), Error> {
        let id = self.node_id(handle)?.to_owned();
        self.apply(vec![Op::Resize { id, width, height }])
    }

    /// Uniform scale around the node origin: extent and translation scale,
    /// matching the editor's scale tool semantics.
    pub fn apply_scale_transform(&mut self, handle: u32, factor: f64) -> Result<(), Error> {
        if !(0.0..=1000.0).contains(&factor) || factor == 0. {
            return Err(Error::Protocol("scale factor out of range".into()));
        }
        let id = self.node_id(handle)?.to_owned();
        let node = self
            .log
            .store()
            .get(&id)
            .ok_or(Error::UnknownHandle(handle))?;
        let m = node.transform.0;
        let scaled = [
            m[0] * factor,
            m[1] * factor,
            m[2] * factor,
            m[3] * factor,
            m[4] * factor,
            m[5] * factor,
        ];
        self.apply(vec![Op::SetTransform { id, matrix: scaled }])
    }

    // -- facets ---------------------------------------------------------------

    pub fn facet_kinds(&self, handle: u32) -> Result<Vec<String>, Error> {
        let node = self.node(handle)?;
        Ok(facet::facets_for_kind(&node.kind)
            .into_iter()
            .filter(|kind| facet::facet_view(node, *kind).is_some())
            .map(|kind| kind.as_str().to_owned())
            .collect())
    }

    pub fn facet_json(&self, handle: u32, kind: &str) -> Result<Option<String>, Error> {
        let kind = FacetKind::from_str(kind).ok_or_else(|| Error::UnknownFacet(kind.into()))?;
        let node = self.node(handle)?;
        Ok(facet::facet_view(node, kind)
            .map(|facet| serde_json::to_string(&facet).expect("facet serializes")))
    }

    /// Capability discovery is distinct from the current optional facet value.
    pub fn facet_capabilities_json(&self, handle: u32) -> Result<String, Error> {
        serde_json::to_string(&facet::facet_capabilities(self.node(handle)?))
            .map_err(|e| Error::Json(e.to_string()))
    }

    pub fn apply_facet_json(&mut self, handle: u32, kind: &str, json: &str) -> Result<(), Error> {
        let kind_value =
            FacetKind::from_str(kind).ok_or_else(|| Error::UnknownFacet(kind.into()))?;
        let facet: Facet = serde_json::from_str(json).map_err(|e| Error::Json(e.to_string()))?;
        let id = self.node_id(handle)?.to_owned();
        self.apply(vec![Op::ApplyFacet {
            id,
            kind: kind_value.as_str().into(),
            facet,
        }])
    }

    // -- history ---------------------------------------------------------------

    pub fn undo(&mut self) -> Result<bool, Error> {
        let Some(previous) = self.undo.pop() else {
            return Ok(false);
        };
        // The state being left re-enters the redo stack tagged with the same
        // edit's source, so provenance survives undo/redo round trips.
        let source = previous.edit_source;
        let mut left = self.snapshot();
        left.edit_source = source;
        self.redo.push(left);
        self.install(previous);
        Ok(true)
    }

    pub fn redo(&mut self) -> Result<bool, Error> {
        let Some(next) = self.redo.pop() else {
            return Ok(false);
        };
        let source = next.edit_source;
        let mut left = self.snapshot();
        left.edit_source = source;
        self.undo.push(left);
        self.install(next);
        Ok(true)
    }

    pub fn undo_depth(&self) -> usize {
        self.undo.len()
    }
    pub fn redo_depth(&self) -> usize {
        self.redo.len()
    }

    /// Provenance of every undo entry, oldest first — the audit face for
    /// "which source class produced this batch" (AI/plugin review etc.).
    pub fn undo_edit_sources(&self) -> Vec<EditSource> {
        self.undo.iter().map(|entry| entry.edit_source).collect()
    }

    /// Provenance of every redo entry, oldest first.
    pub fn redo_edit_sources(&self) -> Vec<EditSource> {
        self.redo.iter().map(|entry| entry.edit_source).collect()
    }

    /// Scope of the most recent successful commit, including
    /// ignore-undo-redo commits that never entered the undo stack.
    pub fn last_commit_scope(&self) -> Option<EditScope> {
        self.last_scope
    }

    // -- ops transport ----------------------------------------------------------

    /// Submit an op batch. Accepts the back-compatible bare `[…]` array
    /// (default user scope) or an enveloped
    /// `{"ops":[…],"source":…,"ignoreUndoRedo":…,"writeInReadonly":…}`
    /// submission carrying edit provenance. Unknown source classes fail
    /// closed.
    pub fn apply_ops_json(&mut self, json: &str) -> Result<(), Error> {
        let value: serde_json::Value =
            serde_json::from_str(json).map_err(|e| Error::Json(e.to_string()))?;
        let (ops, scope) = match value {
            serde_json::Value::Array(_) => {
                let ops: Vec<Op> =
                    serde_json::from_value(value).map_err(|e| Error::Json(e.to_string()))?;
                (ops, None)
            }
            serde_json::Value::Object(_) => {
                let submission: OpsSubmission =
                    serde_json::from_value(value).map_err(|e| Error::Json(e.to_string()))?;
                let scope = EditScope {
                    source: submission.source.unwrap_or_default(),
                    ignore_undo_redo: submission.ignore_undo_redo,
                    write_in_readonly: submission.write_in_readonly,
                };
                (submission.ops, Some(scope))
            }
            _ => {
                return Err(Error::Protocol(
                    "ops submission must be an array or an envelope object".into(),
                ))
            }
        };
        self.apply_scoped(ops, scope)
    }

    pub fn ops_frame(&self, json: &str, revision: u64, lz4: bool) -> Result<Vec<u8>, Error> {
        let ops: Vec<Op> = serde_json::from_str(json).map_err(|e| Error::Json(e.to_string()))?;
        let compression = if lz4 {
            Compression::Lz4
        } else {
            Compression::None
        };
        let frame = protocol::encode_ops_frame(&ops, revision, compression);
        match frame {
            Frame::Binary { payload, .. } => Ok(payload),
            Frame::Text { .. } => unreachable!("ops frames are binary"),
        }
    }

    pub fn decode_ops_frame(&self, bytes: &[u8], lz4: bool) -> Result<(u64, String), Error> {
        let compression = if lz4 {
            Compression::Lz4
        } else {
            Compression::None
        };
        let frame = Frame::Binary {
            revision: 0,
            compression,
            payload: bytes.to_vec(),
        };
        let (revision, ops) =
            protocol::decode_ops_frame(&frame).map_err(|e| Error::Protocol(e.to_string()))?;
        let json = serde_json::to_string(&ops).map_err(|e| Error::Json(e.to_string()))?;
        Ok((revision, json))
    }

    // -- binary documents ---------------------------------------------------------

    pub fn export_binary(&self) -> Vec<u8> {
        crate::binfmt::encode(&self.log.store().to_document(&self.base))
    }

    pub fn import_binary(&mut self, bytes: &[u8]) -> Result<(), Error> {
        let scope = self.scope_for_commit(None)?;
        let mut document = crate::binfmt::decode(bytes).map_err(Error::Binary)?;
        let store = NodeStore::from_document(&document);
        document.nodes.clear();
        self.install(GraphSnapshot {
            base: Arc::new(document),
            store,
            edit_source: scope.source,
        });
        self.undo.clear();
        self.redo.clear();
        self.last_scope = Some(scope);
        Ok(())
    }

    // -- tiles ------------------------------------------------------------------

    pub fn level_for_zoom(zoom: f64) -> i32 {
        TileStack::level_for_zoom(zoom)
    }

    pub fn tile_handle(&mut self, level: i32, x: i32, y: i32) -> u32 {
        self.tiles.tile_handle(TileKey { level, x, y }).raw()
    }

    fn tile(&self, handle: u32) -> Result<&crate::tile_stack::TileState, Error> {
        self.tiles
            .get(Handle::from_raw(handle))
            .ok_or(Error::UnknownHandle(handle))
    }

    pub fn tile_viewport(&self, handle: u32) -> Result<Rect, Error> {
        Ok(self.tile(handle)?.viewport)
    }

    pub fn tile_scissor_for_clear(&self, handle: u32) -> Result<Rect, Error> {
        Ok(self.tile(handle)?.scissor_for_clear())
    }

    pub fn tile_uv_rect(&self, handle: u32) -> Result<[f64; 4], Error> {
        let uv = self.tile(handle)?.uv_space_rect();
        Ok([uv.u, uv.v, uv.du, uv.dv])
    }

    pub fn tile_needs_color_clear(&self, handle: u32) -> Result<bool, Error> {
        Ok(self.tile(handle)?.needs_color_clear())
    }

    pub fn tile_to_node(&self, level: i32, x: i32, y: i32) -> [f64; 9] {
        self.tiles.tile_to_node(TileKey { level, x, y })
    }

    pub fn tile_release(&mut self, handle: u32) -> bool {
        self.tiles.release(Handle::from_raw(handle))
    }

    /// Plan tiles covering a world-space rectangle at `level`; `pad` grows
    /// the rect in world units before snapping so effects that bleed past
    /// node bounds stay covered.
    pub fn tiles_for_rect(
        &mut self,
        level: i32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        pad: i32,
    ) -> Vec<u32> {
        let world = crate::tile_stack::Rect { x, y, w, h };
        self.tiles
            .tiles_for_rect(level, world, pad)
            .into_iter()
            .map(|key| self.tiles.tile_handle(key).raw())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facet::sample_node;

    fn document_json() -> String {
        let mut doc = Document {
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
                children: vec!["f1".into()],
                background: "#ffffff".into(),
            }],
            nodes: Default::default(),
            fonts: Default::default(),
            animations: Vec::new(),
        };
        let mut page = sample_node("p1", "page");
        page.children = vec!["f1".into()];
        doc.nodes.insert("p1".into(), page);
        doc.nodes.insert("f1".into(), sample_node("f1", "frame"));
        serde_json::to_string(&doc).unwrap()
    }

    #[test]
    fn handle_lifecycle_and_reads() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let page = api.node_handle("p1");
        let frame = api.node_handle("f1");
        assert!(api.node_exists(frame));
        assert!(!api.node_exists(999));
        assert_eq!(api.node_kind(frame).unwrap(), "frame");
        assert_eq!(api.node_children(page).unwrap(), vec![frame]);
        assert_eq!(api.node_parent(frame).unwrap(), page);
        assert_eq!(api.find_containing_page(frame).unwrap(), page);
        assert_eq!(api.node_handle("ghost"), INVALID);
    }

    #[test]
    fn edits_go_through_ops_and_undo() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let frame = api.node_handle("f1");
        api.set_name(frame, "Hero").unwrap();
        api.set_opacity(frame, 0.5).unwrap();
        assert_eq!(api.node_name(frame).unwrap(), "Hero");
        assert_eq!(api.undo_depth(), 2);
        api.undo().unwrap();
        assert_eq!(api.node_opacity(frame).unwrap(), 1.);
        api.undo().unwrap();
        assert_eq!(api.node_name(frame).unwrap(), "");
    }

    #[test]
    fn scale_transform_updates_extent_and_matrix() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let frame = api.node_handle("f1");
        api.set_transform(frame, [1., 0., 0., 1., 10., 20.])
            .unwrap();
        api.apply_scale_transform(frame, 2.).unwrap();
        let node = api.log.store().get("f1").unwrap();
        assert_eq!(
            (node.width, node.height),
            (100., 60.),
            "Scale must not multiply geometry and matrix twice"
        );
        assert_eq!(node.transform.0, [2., 0., 0., 2., 20., 40.]);
    }

    #[test]
    fn facet_flow_round_trips() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let frame = api.node_handle("f1");
        api.apply_facet_json(
            frame,
            "stack",
            r#"{"kind":"stack","horizontal":true,"grid":false,"gap":8,"padding":[4,4,4,4]}"#,
        )
        .unwrap();
        let kinds = api.facet_kinds(frame).unwrap();
        assert!(kinds.contains(&"stack".to_string()));
        let json = api.facet_json(frame, "stack").unwrap().unwrap();
        assert!(json.contains("\"horizontal\":true"));
    }

    #[test]
    fn rejected_facet_batch_preserves_document_revision_and_redo() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let handle = api.node_handle("f1");
        api.set_name(handle, "First").unwrap();
        api.set_name(handle, "Second").unwrap();
        api.undo().unwrap();
        let before = api.document_json();
        let revision = api.revision();
        let history = (api.undo_depth(), api.redo_depth());
        let batch = r#"[
            {"type":"setName","id":"f1","name":"Must not commit"},
            {"type":"applyFacet","id":"f1","kind":"effects","facet":{"kind":"effects","count":2}}
        ]"#;
        assert!(api.apply_ops_json(batch).unwrap_err().to_string().contains("read-only"));
        assert_eq!(api.document_json(), before);
        assert_eq!(api.revision(), revision);
        assert_eq!((api.undo_depth(), api.redo_depth()), history);
        assert_eq!(api.node_name(handle).unwrap(), "First");
        api.redo().unwrap();
        assert_eq!(api.node_name(handle).unwrap(), "Second");
    }

    #[test]
    fn facet_capabilities_distinguish_optional_values_and_read_only_summaries() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let handle = api.node_handle("f1");
        let capabilities: serde_json::Value = serde_json::from_str(
            &api.facet_capabilities_json(handle).unwrap()).unwrap();
        let capabilities = capabilities.as_array().unwrap();
        assert!(capabilities.iter().any(|c| c["kind"] == "effects" && c["access"] == "readOnly"));
        assert!(capabilities.iter().any(|c| c["kind"] == "stack" && c["access"] == "readWrite" && c["present"] == false));
        assert_eq!(api.facet_json(handle, "text").unwrap(), None);
    }

    #[test]
    fn binary_round_trip_through_api() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let frame = api.node_handle("f1");
        api.set_name(frame, "Persisted").unwrap();
        let bytes = api.export_binary();
        api.import_binary(&bytes).unwrap();
        let frame = api.node_handle("f1");
        assert_eq!(api.node_name(frame).unwrap(), "Persisted");
    }

    #[test]
    fn ops_frame_round_trip_with_lz4() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let ops = r#"[{"type":"setName","id":"f1","name":"Net"}]"#;
        let frame_bytes = api.ops_frame(ops, 12, true).unwrap();
        let (revision, decoded) = api.decode_ops_frame(&frame_bytes, true).unwrap();
        assert_eq!(revision, 12);
        assert!(decoded.contains("Net"));
        api.apply_ops_json(&decoded).unwrap();
        let frame = api.node_handle("f1");
        assert_eq!(api.node_name(frame).unwrap(), "Net");
    }

    #[test]
    fn tiles_for_rect_allocates_viewport_tiles() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let handles = api.tiles_for_rect(0, 100, 100, 300, 300, 0);
        // A 512 grid covers the 100..400 span with four tiles.
        assert_eq!(handles.len(), 4);
        let first = handles[0];
        let viewport = api.tile_viewport(first).unwrap();
        assert_eq!((viewport.x, viewport.y), (0, 0));
        let last = *handles.last().unwrap();
        let viewport = api.tile_viewport(last).unwrap();
        assert_eq!((viewport.x, viewport.y), (512, 512));
    }

    #[test]
    fn stale_handle_is_rejected() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let stale = api.node_handle("f1");
        let raw = stale;
        api.tile_release(raw); // wrong arena; no-op
        let _ = api.node_name(raw);
        assert!(matches!(
            api.node_name(4242),
            Err(Error::UnknownHandle(4242))
        ));
    }

    #[test]
    fn transforms_keep_handles_and_same_size_structural_edits_retire_them() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let initial = api.document_json();
        let page = api.node_handle("p1");
        let frame = api.node_handle("f1");
        api.set_transform(frame, [0.0, 1.0, -1.0, 0.0, 21.0, 9.0]).unwrap();
        let rotated = api.document_json();
        assert!(api.undo().unwrap());
        assert_eq!(api.document_json(), initial);
        assert!(api.redo().unwrap());
        assert_eq!(api.document_json(), rotated);
        assert_eq!(api.node_handle("f1"), frame);

        api.apply_ops_json(&serde_json::json!([
            {"type":"removeNode","id":"f1"},
            {"type":"insertNode","parent":"p1","index":0,"node":sample_node("f2","frame")}
        ]).to_string()).unwrap();
        let replacement = api.node_handle("f2");
        assert!(!api.node_exists(frame));
        assert!(api.node_exists(replacement));
        assert!(api.undo().unwrap());
        let restored = api.node_handle("f1");
        assert_ne!(restored, frame);
        assert!(!api.node_exists(replacement));
        assert_eq!(api.document_json(), rotated);
        assert!(api.redo().unwrap());
        assert!(!api.node_exists(restored));
        assert_eq!(api.node_handle("p1"), page);
    }

    #[test]
    fn replace_document_stacks_for_exact_undo() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let frame = api.node_handle("f1");
        api.set_name(frame, "First").unwrap();
        let v1 = api.document_json();
        let mut edited: Document = serde_json::from_str(&v1).unwrap();
        edited.nodes.get_mut("f1").unwrap().name = "Second".into();
        edited.pages[0].name = "Renamed page".into();
        let r = api
            .replace_document(&serde_json::to_string(&edited).unwrap())
            .unwrap();
        assert!(r > 1);
        let frame = api.node_handle("f1");
        assert_eq!(api.node_name(frame).unwrap(), "Second");
        // top-level fields travelled with the replacement
        assert!(api.document_json().contains("Renamed page"));
        api.undo().unwrap();
        let frame = api.node_handle("f1");
        assert_eq!(
            api.node_name(frame).unwrap(),
            "First",
            "undo only the latest document edit"
        );
        assert!(!api.document_json().contains("Renamed page"));
        api.redo().unwrap();
        let frame = api.node_handle("f1");
        assert_eq!(api.node_name(frame).unwrap(), "Second");
    }

    #[test]
    fn document_edits_clear_the_redo_chain() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let frame = api.node_handle("f1");
        api.set_name(frame, "A").unwrap();
        assert_eq!(api.revision(), 2, "one op-level undo entry");
        api.undo().unwrap();
        assert_eq!(api.revision(), 3, "undo advances the mutation revision");
        api.replace_document(&document_json().replace("\"Doc\"", "\"Replaced\""))
            .unwrap();
        // new document edit must clear the redo chain
        assert!(!api.redo().unwrap());
    }
    #[test]
    fn document_and_ops_share_chronology_and_bounded_history() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let h = api.node_handle("f1");
        api.set_name(h, "A").unwrap();
        let mut d: Document = serde_json::from_str(&api.document_json()).unwrap();
        d.nodes.get_mut("f1").unwrap().name = "B".into();
        api.replace_document(&serde_json::to_string(&d).unwrap())
            .unwrap();
        api.set_name(h, "C").unwrap();
        assert_eq!(api.undo_depth(), 3);
        for expected in ["B", "A", ""] {
            let r = api.revision();
            assert!(api.undo().unwrap());
            assert!(api.revision() > r);
            assert_eq!(api.node_name(h).unwrap(), expected);
        }
        for expected in ["A", "B", "C"] {
            assert!(api.redo().unwrap());
            assert_eq!(api.node_name(h).unwrap(), expected);
        }
        for i in 0..200 {
            api.set_name(h, &i.to_string()).unwrap();
        }
        assert_eq!(api.undo_depth(), 128);
    }
    #[test]
    fn failed_op_batch_preserves_every_prior_field() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let before = api.document_json();
        let result = api.apply(vec![
            Op::SetName {
                id: "f1".into(),
                name: "temporary".into(),
            },
            Op::SetName {
                id: "missing".into(),
                name: "bad".into(),
            },
        ]);
        assert!(result.is_err());
        assert_eq!(api.document_json(), before);
        assert_eq!(api.undo_depth(), 0);
    }

    #[test]
    fn enveloped_submission_carries_source_into_undo_grouping() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        api.apply_ops_json(r#"[{"type":"setName","id":"f1","name":"by-user"}]"#)
            .unwrap();
        api.apply_ops_json(
            r#"{"ops":[{"type":"setName","id":"f1","name":"by-ai"}],"source":"ai"}"#,
        )
        .unwrap();
        api.apply_ops_json(
            r#"{"ops":[{"type":"setName","id":"f1","name":"by-plugin"}],"source":"plugin"}"#,
        )
        .unwrap();
        assert_eq!(
            api.undo_edit_sources(),
            vec![
                EditSource::User,
                EditSource::Ai,
                EditSource::Plugin
            ]
        );
        assert_eq!(api.last_commit_scope().unwrap().source, EditSource::Plugin);
        api.undo().unwrap();
        let handle = api.node_handle("f1");
        assert_eq!(api.node_name(handle).unwrap(), "by-ai");
        assert_eq!(api.undo_edit_sources(), vec![EditSource::User, EditSource::Ai]);
        assert_eq!(api.redo_edit_sources(), vec![EditSource::Plugin]);
        api.redo().unwrap();
        assert_eq!(
            api.undo_edit_sources(),
            vec![
                EditSource::User,
                EditSource::Ai,
                EditSource::Plugin
            ],
            "provenance survives undo/redo round trips"
        );
    }

    #[test]
    fn bare_array_defaults_to_user_and_unknown_sources_fail_closed() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        api.apply_ops_json(r#"[{"type":"setName","id":"f1","name":"legacy"}]"#)
            .unwrap();
        assert_eq!(api.undo_edit_sources(), vec![EditSource::User]);
        let before = api.document_json();
        let err = api
            .apply_ops_json(
                r#"{"ops":[{"type":"setName","id":"f1","name":"x"}],"source":"typo"}"#,
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("unknown variant `typo`"), "{err}");
        assert_eq!(api.document_json(), before, "failed envelope changes nothing");
        // Envelope without a source degrades to the default user scope.
        api.apply_ops_json(r#"{"ops":[{"type":"setName","id":"f1","name":"y"}]}"#)
            .unwrap();
        assert_eq!(
            api.undo_edit_sources(),
            vec![EditSource::User, EditSource::User]
        );
    }

    #[test]
    fn ignore_undo_redo_submission_applies_without_an_undo_entry() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let handle = api.node_handle("f1");
        api.set_name(handle, "first").unwrap();
        api.undo().unwrap();
        assert_eq!(api.redo_depth(), 1);
        let revision = api.revision();
        api.apply_ops_json(
            r#"{"ops":[{"type":"setName","id":"f1","name":"silent"}],"source":"system","ignoreUndoRedo":true}"#,
        )
        .unwrap();
        assert_eq!(api.node_name(handle).unwrap(), "silent");
        assert_eq!(api.undo_depth(), 0, "ignored commit stays out of the undo stack");
        assert_eq!(api.redo_depth(), 0, "redo chain is stale after the document moved on");
        assert!(api.revision() > revision);
        let scope = api.last_commit_scope().unwrap();
        assert!(scope.ignore_undo_redo && scope.source == EditSource::System);
    }

    #[test]
    fn strict_mode_rejects_scopeless_edits_until_a_scope_is_declared() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let handle = api.node_handle("f1");
        api.set_edit_scope_strict(true);
        assert!(api.edit_scope_strict());
        let err = api.set_name(handle, "blocked").unwrap_err().to_string();
        assert!(err.contains(NO_EDIT_SCOPE_ACTIVE), "{err}");
        let err = api
            .apply_ops_json(r#"[{"type":"setName","id":"f1","name":"blocked"}]"#)
            .unwrap_err()
            .to_string();
        assert!(err.contains(NO_EDIT_SCOPE_ACTIVE), "{err}");
        let err = api.replace_document(&document_json()).unwrap_err().to_string();
        assert!(err.contains(NO_EDIT_SCOPE_ACTIVE), "{err}");
        // An enveloped source passes without an ambient session.
        api.apply_ops_json(
            r#"{"ops":[{"type":"setName","id":"f1","name":"declared"}],"source":"user"}"#,
        )
        .unwrap();
        assert_eq!(api.node_name(handle).unwrap(), "declared");
        // The ambient session unlocks the convenience setters too.
        let token = api.open_edit_scope(EditScope::from_source(EditSource::Ai));
        api.set_name(handle, "assisted").unwrap();
        assert_eq!(api.undo_edit_sources(), vec![EditSource::User, EditSource::Ai]);
        api.close_edit_scope(token).unwrap();
        assert!(api.set_name(handle, "blocked-again").is_err());
        // Strict off restores the old permissive default.
        api.set_edit_scope_strict(false);
        api.set_name(handle, "default").unwrap();
        assert_eq!(api.undo_edit_sources().last(), Some(&EditSource::User));
    }

    #[test]
    fn ambient_scopes_nest_lifo_and_tag_every_commit() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let handle = api.node_handle("f1");
        let outer = api.open_edit_scope(EditScope::from_source(EditSource::Autosave));
        assert_eq!(api.edit_scope_depth(), 1);
        let inner = api.open_edit_scope(EditScope::from_source(EditSource::Onboarding));
        assert_eq!(api.active_edit_scope().unwrap().source, EditSource::Onboarding);
        api.set_name(handle, "nested").unwrap();
        // Out-of-order closes are rejected instead of silently unwinding.
        assert!(api.close_edit_scope(outer).is_err());
        api.close_edit_scope(inner).unwrap();
        api.set_name(handle, "outer").unwrap();
        api.close_edit_scope(outer).unwrap();
        assert_eq!(api.active_edit_scope(), None);
        assert!(api.close_edit_scope(outer).is_err());
        assert_eq!(
            api.undo_edit_sources(),
            vec![EditSource::Onboarding, EditSource::Autosave],
            "innermost scope tags the commit, not the outer session"
        );
    }

    #[test]
    fn scoped_replacement_records_provenance() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let edited = document_json().replace("\"Doc\"", "\"Replaced\"");
        api.replace_document_scoped(&edited, EditScope::from_source(EditSource::Plugin))
            .unwrap();
        assert_eq!(api.undo_edit_sources(), vec![EditSource::Plugin]);
        assert!(api.undo().unwrap());
        assert!(api.document_json().contains("\"Doc\""));
        assert_eq!(api.redo_edit_sources(), vec![EditSource::Plugin]);
        // Typed scoped apply and ignore-scoped replacement share the semantics.
        api.apply_ops_scoped(
            vec![Op::SetName {
                id: "f1".into(),
                name: "typed".into(),
            }],
            EditScope {
                source: EditSource::Ai,
                ignore_undo_redo: true,
                write_in_readonly: true,
            },
        )
        .unwrap();
        let scope = api.last_commit_scope().unwrap();
        // write_in_readonly is recorded as an explicit authorization but has
        // no readonly mode to bypass yet (reserved channel).
        assert!(scope.write_in_readonly && scope.ignore_undo_redo);
        assert_eq!(scope.source, EditSource::Ai);
        assert_eq!(
            api.undo_depth(),
            0,
            "ignored typed batch left the (already undone) history intact"
        );
    }
    #[test]
    fn replacement_reuses_unchanged_nodes_and_preserves_metadata() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let original = api.document_json();
        let unchanged = api.log.store().arc_ptr("f1").unwrap();
        let mut next: Document = serde_json::from_str(&original).unwrap();
        next.name = "Appended document".into();
        next.pages[0].name = "Renamed page".into();
        next.pages[0].children.push("new".into());
        next.nodes.get_mut("p1").unwrap().children.push("new".into());
        next.nodes.insert("new".into(), sample_node("new", "frame"));
        let expected = serde_json::to_value(&next).unwrap();
        api.replace_document(&serde_json::to_string(&next).unwrap()).unwrap();
        assert_eq!(api.log.store().arc_ptr("f1").unwrap(), unchanged, "whole replacements must share unchanged native nodes");
        assert_eq!(serde_json::from_str::<serde_json::Value>(&api.document_json()).unwrap(), expected);
        assert_eq!(api.undo_depth(), 1);
        assert!(api.undo().unwrap());
        assert_eq!(api.document_json(), original);
        assert_eq!(api.log.store().arc_ptr("f1").unwrap(), unchanged);
        assert!(api.redo().unwrap());
        assert_eq!(serde_json::from_str::<serde_json::Value>(&api.document_json()).unwrap(), expected);
    }

    #[test]
    fn replacement_full_node_equality_does_not_hide_changes() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let mutations: [fn(&mut Node); 5] = [
            |n| n.name = "Changed".into(),
            |n| n.width += 1.0,
            |n| n.height += 1.0,
            |n| n.opacity = 0.25,
            |n| { n.bindings.insert("fill".into(), "new-token".into()); },
        ];
        for mutate in mutations {
            let old = api.log.store().arc_ptr("f1").unwrap();
            let page = api.log.store().arc_ptr("p1").unwrap();
            let before = api.document_json();
            let mut next: Document = serde_json::from_str(&before).unwrap();
            mutate(next.nodes.get_mut("f1").unwrap());
            let expected = serde_json::to_value(&next).unwrap();
            api.replace_document(&serde_json::to_string(&next).unwrap()).unwrap();
            assert_ne!(api.log.store().arc_ptr("f1").unwrap(), old);
            assert_eq!(api.log.store().arc_ptr("p1").unwrap(), page);
            assert_eq!(serde_json::from_str::<serde_json::Value>(&api.document_json()).unwrap(), expected);
            assert!(api.undo().unwrap());
            assert_eq!(api.document_json(), before);
            assert!(api.redo().unwrap());
            assert_eq!(serde_json::from_str::<serde_json::Value>(&api.document_json()).unwrap(), expected);
        }
    }

    #[test]
    fn replacement_deletion_and_readdition_preserve_exact_history() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let original = api.document_json();
        let old = api.log.store().arc_ptr("f1").unwrap();
        let mut removed: Document = serde_json::from_str(&original).unwrap();
        removed.nodes.remove("f1");
        removed.nodes.get_mut("p1").unwrap().children.clear();
        removed.pages[0].children.clear();
        let removed_json = serde_json::to_string(&removed).unwrap();
        api.replace_document(&removed_json).unwrap();
        assert!(api.log.store().get("f1").is_none());
        api.replace_document(&original).unwrap();
        let readded = api.log.store().arc_ptr("f1").unwrap();
        assert_ne!(readded, old, "do not search deleted historical nodes or cross ownership boundaries");
        assert_eq!(api.document_json(), original);
        assert!(api.undo().unwrap());
        assert_eq!(api.document_json(), removed_json);
        assert!(api.undo().unwrap());
        assert_eq!(api.log.store().arc_ptr("f1").unwrap(), old);
        assert_eq!(api.document_json(), original);
        assert!(api.redo().unwrap());
        assert!(api.log.store().get("f1").is_none());
        assert!(api.redo().unwrap());
        assert_eq!(api.log.store().arc_ptr("f1").unwrap(), readded);
    }

    #[test]
    fn replacement_different_document_never_reuses_previous_owner() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let old = api.log.store().arc_ptr("f1").unwrap();
        let mut next: Document = serde_json::from_str(&api.document_json()).unwrap();
        next.id = "different-document".into();
        api.replace_document(&serde_json::to_string(&next).unwrap()).unwrap();
        assert_ne!(api.log.store().arc_ptr("f1").unwrap(), old);
        assert_eq!(api.base.id, "different-document");
        assert!(api.undo().unwrap());
        assert_eq!(api.base.id, "d1");
        assert_eq!(api.log.store().arc_ptr("f1").unwrap(), old);
        assert!(api.redo().unwrap());
        assert_eq!(api.base.id, "different-document");
    }

    #[test]
    fn replacement_retains_all_128_history_entries_with_shared_nodes() {
        let mut api = GraphApi::new(&document_json()).unwrap();
        let original = api.log.store().arc_ptr("f1").unwrap();
        let mut next: Document = serde_json::from_str(&api.document_json()).unwrap();
        for revision in 1..=130 {
            next.name = format!("revision-{revision}");
            api.replace_document(&serde_json::to_string(&next).unwrap()).unwrap();
            assert_eq!(api.log.store().arc_ptr("f1").unwrap(), original);
        }
        assert_eq!(api.undo_depth(), 128);
        for _ in 0..128 { assert!(api.undo().unwrap()); }
        assert_eq!(api.base.name, "revision-2");
        assert!(!api.undo().unwrap());
        for _ in 0..128 { assert!(api.redo().unwrap()); }
        assert_eq!(api.base.name, "revision-130");
        assert!(!api.redo().unwrap());
        assert_eq!(api.log.store().arc_ptr("f1").unwrap(), original);
    }

    #[test]
    fn replacement_preserves_signed_zero_bits_and_exact_history() {
        for (from, to) in [(0.0_f64, -0.0_f64), (-0.0, 0.0), (-0.0, -0.0)] {
            let mut source: Document = serde_json::from_str(&document_json()).unwrap();
            source.nodes.get_mut("f1").unwrap().opacity = from;
            let before = serde_json::to_string(&source).unwrap();
            let mut api = GraphApi::new(&before).unwrap();
            let old = api.log.store().arc_ptr("f1").unwrap();
            source.nodes.get_mut("f1").unwrap().opacity = to;
            let after = serde_json::to_string(&source).unwrap();
            api.replace_document(&after).unwrap();
            assert_eq!(api.log.store().get("f1").unwrap().opacity.to_bits(), to.to_bits());
            assert_eq!(api.document_json(), after);
            assert_ne!(api.log.store().arc_ptr("f1").unwrap(), old, "signed-zero projections conservatively allocate fresh nodes");
            assert!(api.undo().unwrap());
            assert_eq!(api.log.store().get("f1").unwrap().opacity.to_bits(), from.to_bits());
            assert_eq!(api.document_json(), before);
            assert!(api.redo().unwrap());
            assert_eq!(api.document_json(), after);
        }
    }
    #[test]
    fn replacement_preserves_nested_json_signed_zero() {
        let mut source: Document = serde_json::from_str(&document_json()).unwrap();
        source.nodes.get_mut("f1").unwrap().instance = Some(Box::new(crate::components::Instance {
            slot_contents: Default::default(), component_id: "source".into(), overrides: Default::default(),
            property_values: [("nested".into(), serde_json::from_str(r#"{"items":[0.0]}"#).unwrap())].into(),
        }));
        let before = serde_json::to_string(&source).unwrap();
        let mut api = GraphApi::new(&before).unwrap();
        source.nodes.get_mut("f1").unwrap().instance.as_mut().unwrap().property_values
            .insert("nested".into(), serde_json::from_str(r#"{"items":[-0.0]}"#).unwrap());
        let after = serde_json::to_string(&source).unwrap();
        api.replace_document(&after).unwrap();
        let value = &api.log.store().get("f1").unwrap().instance.as_ref().unwrap().property_values["nested"]["items"][0];
        assert_eq!(value.as_f64().unwrap().to_bits(), (-0.0_f64).to_bits());
        assert_eq!(api.document_json(), after, "Value::PartialEq is not a signed-zero oracle");
        assert!(api.undo().unwrap()); assert_eq!(api.document_json(), before);
        assert!(api.redo().unwrap()); assert_eq!(api.document_json(), after);
    }

    #[test]
    fn replacement_preserves_underflow_negative_zero_and_ignores_string_tokens() {
        let mut source: Document = serde_json::from_str(&document_json()).unwrap();
        source.nodes.get_mut("f1").unwrap().opacity = 0.0;
        source.nodes.get_mut("f1").unwrap().name = "quoted \\\" -0 -1e-999 \\ tail".into();
        let before = serde_json::to_string(&source).unwrap();
        let mut api = GraphApi::new(&before).unwrap();
        let old = api.log.store().arc_ptr("f1").unwrap();
        source.name = "metadata-only".into();
        let metadata = serde_json::to_string(&source).unwrap();
        api.replace_document(&metadata).unwrap();
        assert_eq!(api.log.store().arc_ptr("f1").unwrap(), old, "escaped text does not disable safe reuse");
        let raw = metadata.replace("\"opacity\":0.0", "\"opacity\":-1e-999");
        assert_ne!(raw, metadata);
        let normalized: Document = serde_json::from_str(&raw).unwrap();
        assert_eq!(normalized.nodes["f1"].opacity.to_bits(), (-0.0_f64).to_bits());
        api.replace_document(&raw).unwrap();
        assert_eq!(api.log.store().get("f1").unwrap().opacity.to_bits(), (-0.0_f64).to_bits());
        assert_eq!(api.document_json(), serde_json::to_string(&normalized).unwrap());
        assert!(api.undo().unwrap()); assert_eq!(api.document_json(), metadata);
        assert_eq!(api.log.store().arc_ptr("f1").unwrap(), old);
        assert!(api.redo().unwrap());
        assert_eq!(api.log.store().get("f1").unwrap().opacity.to_bits(), (-0.0_f64).to_bits());
    }

    #[test]
    fn replacement_after_typed_op_does_not_reuse_uncertain_float_bits() {
        let mut source: Document = serde_json::from_str(&document_json()).unwrap();
        source.nodes.get_mut("f1").unwrap().opacity = 0.0;
        let mut api = GraphApi::new(&serde_json::to_string(&source).unwrap()).unwrap();
        let handle = api.node_handle("f1");
        api.set_opacity(handle, -0.0).unwrap();
        assert_eq!(api.log.store().get("f1").unwrap().opacity.to_bits(), (-0.0_f64).to_bits());
        let positive = serde_json::to_string(&source).unwrap();
        api.replace_document(&positive).unwrap();
        assert_eq!(api.log.store().get("f1").unwrap().opacity.to_bits(), 0.0_f64.to_bits());
        assert_eq!(api.document_json(), positive);
        assert!(api.undo().unwrap());
        assert_eq!(api.log.store().get("f1").unwrap().opacity.to_bits(), (-0.0_f64).to_bits());
        assert!(api.redo().unwrap()); assert_eq!(api.document_json(), positive);
        let restored = api.log.store().arc_ptr("f1").unwrap();
        source.name = "proof restored by redo".into();
        api.replace_document(&serde_json::to_string(&source).unwrap()).unwrap();
        assert_eq!(api.log.store().arc_ptr("f1").unwrap(), restored);
    }

}
