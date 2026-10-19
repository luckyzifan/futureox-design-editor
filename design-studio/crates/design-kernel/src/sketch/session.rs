//! Host session fencing is independent from native Sketch archive/schema state.
use crate::sketch::{DOCUMENT_SCHEMA, Document, Error, KERNEL_ID, Result};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Owner {
    pub kernel_id: String,
    pub document_schema: String,
    pub document_id: String,
    pub session_epoch: u64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SketchCommand {
    SetLeafFrame {
        layer_id: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    Undo,
    Redo,
    ResizeLegacyContainer {
        layer_id: String,
        width: f64,
        height: f64,
    },
    RenameLayer {
        layer_id: String,
        name: String,
    },
    SetTextOverride {
        instance_id: String,
        target_path: String,
        text: String,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandEnvelope {
    pub owner: Owner,
    pub expected_revision: u64,
    /// Correlation only; this in-memory boundary does not claim durable replay.
    pub request_id: String,
    pub command: SketchCommand,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Applied {
    pub owner: Owner,
    pub revision: u64,
    pub request_id: String,
}
/// Bounds cover retained ZIP payload bytes (not allocator or live-document memory).
pub const MAX_HISTORY_ENTRIES: usize = 32;
pub const MAX_HISTORY_BYTES: usize = 64 * 1024 * 1024;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HistoryStatus {
    pub undo_count: usize,
    pub redo_count: usize,
    pub retained_bytes: usize,
}
struct HistoryEntry {
    before: Vec<u8>,
    after: Vec<u8>,
}
impl HistoryEntry {
    fn bytes(&self) -> usize {
        self.before.len() + self.after.len()
    }
}
pub struct Session {
    owner: Owner,
    document: Document,
    revision: u64,
    active: bool,
    undo: VecDeque<HistoryEntry>,
    redo: Vec<HistoryEntry>,
    history_bytes: usize,
    max_entries: usize,
    max_bytes: usize,
}
impl Session {
    pub fn new(document: Document, document_id: String, session_epoch: u64) -> Result<Self> {
        Self::with_history_limits(
            document,
            document_id,
            session_epoch,
            MAX_HISTORY_ENTRIES,
            MAX_HISTORY_BYTES,
        )
    }
    pub fn with_history_limits(
        document: Document,
        document_id: String,
        session_epoch: u64,
        max_entries: usize,
        max_bytes: usize,
    ) -> Result<Self> {
        if max_entries == 0
            || max_entries > MAX_HISTORY_ENTRIES
            || max_bytes == 0
            || max_bytes > MAX_HISTORY_BYTES
        {
            return Err(Error::Invalid("history limits".into()));
        }
        if document_id.is_empty()
            || document_id.len() > 128
            || document_id.chars().any(char::is_control)
            || session_epoch == 0
        {
            return Err(Error::Invalid("session identity".into()));
        }
        Ok(Self {
            owner: Owner {
                kernel_id: KERNEL_ID.into(),
                document_schema: DOCUMENT_SCHEMA.into(),
                document_id,
                session_epoch,
            },
            document,
            revision: 0,
            active: true,
            undo: VecDeque::new(),
            redo: Vec::new(),
            history_bytes: 0,
            max_entries,
            max_bytes,
        })
    }
    pub fn history_status(&self) -> HistoryStatus {
        HistoryStatus {
            undo_count: self.undo.len(),
            redo_count: self.redo.len(),
            retained_bytes: self.history_bytes,
        }
    }
    pub fn owner(&self) -> &Owner {
        &self.owner
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn document(&self) -> &Document {
        &self.document
    }
    pub fn close(&mut self) {
        self.active = false;
    }
    /// Validate ownership for read-only projections as well as mutations.
    pub fn assert_current(&self, owner: &Owner, revision: u64) -> Result<()> {
        if !self.active || owner != &self.owner {
            return Err(Error::Invalid(
                "inactive or foreign kernel/document/session owner".into(),
            ));
        }
        if revision != self.revision {
            return Err(Error::Invalid("stale document revision".into()));
        }
        Ok(())
    }
    pub fn apply(&mut self, envelope: CommandEnvelope) -> Result<Applied> {
        self.assert_current(&envelope.owner, envelope.expected_revision)?;
        if envelope.request_id.is_empty()
            || envelope.request_id.len() > 128
            || envelope.request_id.chars().any(char::is_control)
        {
            return Err(Error::Invalid("request identity".into()));
        }
        let next = self
            .revision
            .checked_add(1)
            .ok_or(Error::Limit("revision"))?;
        match envelope.command {
            SketchCommand::Undo => {
                let entry = self
                    .undo
                    .back()
                    .ok_or_else(|| Error::Invalid("nothing to undo".into()))?;
                let restored = Document::from_sketch(&entry.before)?;
                let entry = self.undo.pop_back().expect("checked undo entry");
                self.redo.push(entry);
                self.document = restored;
            }
            SketchCommand::Redo => {
                let entry = self
                    .redo
                    .last()
                    .ok_or_else(|| Error::Invalid("nothing to redo".into()))?;
                let restored = Document::from_sketch(&entry.after)?;
                let entry = self.redo.pop().expect("checked redo entry");
                self.undo.push_back(entry);
                self.document = restored;
            }
            command => {
                // Prepare the complete native edit and both snapshots before any
                // history/document mutation. No foreign document conversion.
                let mut candidate = self.document.clone();
                match command {
                    SketchCommand::SetLeafFrame {
                        layer_id,
                        x,
                        y,
                        width,
                        height,
                    } => candidate.set_leaf_frame(
                        &layer_id,
                        crate::sketch::Frame {
                            x,
                            y,
                            width,
                            height,
                        },
                    )?,
                    SketchCommand::ResizeLegacyContainer {
                        layer_id,
                        width,
                        height,
                    } => candidate.resize_legacy_container(&layer_id, width, height)?,
                    SketchCommand::RenameLayer { layer_id, name } => {
                        candidate.rename_layer(&layer_id, &name)?
                    }
                    SketchCommand::SetTextOverride {
                        instance_id,
                        target_path,
                        text,
                    } => candidate.set_text_override(&instance_id, &target_path, &text)?,
                    SketchCommand::Undo | SketchCommand::Redo => {
                        unreachable!("handled history commands")
                    }
                }
                let before = self.document.to_sketch()?;
                let after = candidate.to_sketch()?;
                let bytes = before
                    .len()
                    .checked_add(after.len())
                    .ok_or(Error::Limit("history bytes"))?;
                if bytes > self.max_bytes {
                    return Err(Error::Limit("history bytes"));
                }
                // Ensure the captured states satisfy native archive read limits;
                // an edit must never commit an undo/redo state we cannot restore.
                Document::from_sketch(&before)?;
                Document::from_sketch(&after)?;
                for old in self.redo.drain(..) {
                    self.history_bytes -= old.bytes();
                }
                while self.undo.len() >= self.max_entries
                    || self.history_bytes > self.max_bytes - bytes
                {
                    self.history_bytes -= self
                        .undo
                        .pop_front()
                        .expect("history budget invariant")
                        .bytes();
                }
                self.undo.push_back(HistoryEntry { before, after });
                self.history_bytes += bytes;
                self.document = candidate;
            }
        }
        self.revision = next;
        Ok(Applied {
            owner: self.owner.clone(),
            revision: next,
            request_id: envelope.request_id,
        })
    }
}
