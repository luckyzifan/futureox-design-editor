#![forbid(unsafe_code)]

//! Offline file/recovery sidecar. Only the trusted Electron main process may own
//! this process's stdin. It must authorize paths through native file dialogs and
//! expose opaque handles, never this path-based protocol, to renderer content.

mod automation;
pub mod catalog;
mod font_collection;
pub mod fonts;
pub mod protocol;
mod recovery;
pub mod runtime;
mod sketch_file;
mod sketch_inspect;
mod sketch_preview;
mod sketch_save;
mod sketch_session;
mod storage;
pub mod workspace;
mod workspace_snapshot;

use futureox_design_kernel::scene::Document;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path};

pub use recovery::{RecoveryEntry, RecoveryList, RecoveryRecord};
pub use storage::{OpenedDocument, SavedDocument, TargetState};

pub use futureox_design_kernel::capacity::document_byte_limit;
pub(crate) mod document_transport;
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_RECOVERIES: usize = 16;
pub(crate) const MAX_PATH_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BackendError {
    pub code: &'static str,
    pub message: String,
}

impl BackendError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        let mut message = message.into();
        if message.len() > 4096 {
            let mut end = 4096;
            while !message.is_char_boundary(end) {
                end -= 1;
            }
            message.truncate(end);
            message.push('…');
        }
        Self { code, message }
    }

    pub(crate) fn io(context: &str, error: std::io::Error) -> Self {
        Self::new("IO_ERROR", format!("{context}: {error}"))
    }
}

impl std::fmt::Display for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for BackendError {}

pub type Result<T> = std::result::Result<T, BackendError>;

/// No network or renderer-provided arbitrary file access is exposed.
/// Optional SQLite workspace owns durable document revisions; the separate
/// catalog only indexes external portable files. Rust/WASM owns live editing.
/// A single instance processes requests in order. The root is chosen by main,
/// outside authored documents, and is never set by an RPC request.
pub struct Backend {
    recovery: recovery::RecoveryStore,
    catalog: Option<catalog::Catalog>,
    catalog_issue: Option<&'static str>,
    workspace: Option<workspace::WorkspaceStore>,
    workspace_issue: Option<&'static str>,
    fonts: fonts::FontCatalog,
    sketch_sessions: sketch_session::Sessions,
}

impl Backend {
    pub fn new(recovery_dir: &Path) -> Result<Self> {
        Ok(Self {
            recovery: recovery::RecoveryStore::new(recovery_dir)?,
            catalog: None,
            catalog_issue: Some("NOT_INITIALIZED"),
            workspace: None,
            workspace_issue: Some("NOT_INITIALIZED"),
            fonts: fonts::FontCatalog::system(),
            sketch_sessions: sketch_session::Sessions::default(),
        })
    }

    pub fn with_catalog(mut self, catalog: catalog::Catalog) -> Self {
        self.catalog = Some(catalog);
        self.catalog_issue = None;
        self
    }

    pub fn with_workspace(mut self, workspace: workspace::WorkspaceStore) -> Self {
        self.workspace = Some(workspace);
        self.workspace_issue = None;
        self
    }

    pub fn with_workspace_unavailable(mut self, reason: &'static str) -> Self {
        self.workspace = None;
        self.workspace_issue = Some(match reason {
            "WORKSPACE_FUTURE_SCHEMA" => "WORKSPACE_FUTURE_SCHEMA",
            "WORKSPACE_CORRUPT" => "WORKSPACE_CORRUPT",
            "WORKSPACE_FULL" => "WORKSPACE_FULL",
            _ => "WORKSPACE_ERROR",
        });
        self
    }

    pub(crate) fn workspace_unavailable(&self) -> BackendError {
        BackendError::new(
            "WORKSPACE_UNAVAILABLE",
            format!(
                "Local workspace unavailable ({}). Database retained; portable files and recovery remain available.",
                self.workspace_issue.unwrap_or("WORKSPACE_ERROR")
            ),
        )
    }

    pub(crate) fn workspace(&self) -> Result<&workspace::WorkspaceStore> {
        self.workspace
            .as_ref()
            .ok_or_else(|| self.workspace_unavailable())
    }

    pub async fn close_stores(&self) {
        if let Some(workspace) = &self.workspace {
            workspace.close().await;
        }
        if let Some(catalog) = &self.catalog {
            catalog.close().await;
        }
    }

    /// Metadata failure must not disable portable file or recovery operations.
    /// Keep only an allowlisted code, never a database/native-path diagnostic.
    pub fn with_catalog_unavailable(mut self, reason: &'static str) -> Self {
        self.catalog = None;
        self.catalog_issue = Some(match reason {
            "CATALOG_FUTURE_SCHEMA" => "CATALOG_FUTURE_SCHEMA",
            "CATALOG_CORRUPT" => "CATALOG_CORRUPT",
            "CATALOG_TOO_LARGE" => "CATALOG_TOO_LARGE",
            _ => "CATALOG_ERROR",
        });
        self
    }

    pub(crate) fn catalog_unavailable(&self) -> BackendError {
        BackendError::new(
            "CATALOG_UNAVAILABLE",
            format!(
                "Local catalog unavailable ({}). Portable files and recovery remain available; catalog data was not reset.",
                self.catalog_issue.unwrap_or("CATALOG_ERROR")
            ),
        )
    }

    pub(crate) fn catalog(&self) -> Result<&catalog::Catalog> {
        self.catalog
            .as_ref()
            .ok_or_else(|| self.catalog_unavailable())
    }

    pub fn open(&self, path: &Path) -> Result<OpenedDocument> {
        storage::open(path)
    }

    pub fn stat(&self, path: &Path) -> Result<TargetState> {
        storage::stat(path)
    }

    pub fn save(
        &self,
        path: &Path,
        document: &Value,
        expected_hash: Option<&str>,
    ) -> Result<SavedDocument> {
        storage::save(path, document, expected_hash)
    }

    pub fn recovery_write(
        &self,
        id: &str,
        document: &Value,
        source_path: Option<&str>,
        source_hash: Option<&str>,
    ) -> Result<RecoveryEntry> {
        self.recovery.write(id, document, source_path, source_hash)
    }

    pub fn recovery_list(&self) -> Result<RecoveryList> {
        self.recovery.list()
    }

    pub fn recovery_read(&self, id: &str) -> Result<RecoveryRecord> {
        self.recovery.read(id)
    }

    pub fn recovery_remove(&self, id: &str) -> Result<bool> {
        self.recovery.remove(id)
    }
}

pub(crate) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn unique_id() -> String {
    use std::{
        collections::hash_map::RandomState,
        hash::BuildHasher,
        sync::{
            LazyLock,
            atomic::{AtomicU64, Ordering},
        },
        time::SystemTime,
    };
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    static RANDOM: LazyLock<RandomState> = LazyLock::new(RandomState::new);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    // A collision is harmless: create_new refuses it and never removes it. This
    // is a temporary-file name, not a renderer capability or security token.
    format!(
        "{pid}-{sequence}-{:016x}",
        RANDOM.hash_one((pid, sequence, SystemTime::now()))
    )
}

pub(crate) fn validate_hash(value: Option<&str>) -> Result<()> {
    if value.is_some_and(|s| s.len() != 64 || !s.bytes().all(|c| c.is_ascii_hexdigit())) {
        return Err(BackendError::new(
            "INVALID_REQUEST",
            "Expected a SHA-256 hexadecimal hash or null",
        ));
    }
    Ok(())
}

pub(crate) fn validate_document(value: &Value) -> Result<()> {
    // Deserialize by reference; don't clone a potentially large JSON tree.
    let document = Document::deserialize(value)
        .map_err(|e| BackendError::new("INVALID_DOCUMENT", e.to_string()))?;
    fn uuid(value: &str) -> bool {
        value.len() == 36
            && value.bytes().enumerate().all(|(index, byte)| {
                if [8, 13, 18, 23].contains(&index) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
    }
    let mut pages = std::collections::HashSet::new();
    if !uuid(&document.id)
        || document.nodes.keys().any(|id| !uuid(id))
        || document
            .pages
            .iter()
            .any(|page| !uuid(&page.id) || !pages.insert(&page.id))
    {
        return Err(BackendError::new(
            "INVALID_DOCUMENT",
            "Desktop documents require UUID document, node and unique page IDs",
        ));
    }
    document
        .validate()
        .map_err(|e| BackendError::new("INVALID_DOCUMENT", e))
}

/// Check the serialized byte budget while writing, rather than after allocating
/// an unbounded output. Preserve authored JSON fields that the kernel ignores.
pub(crate) fn document_bytes(value: &Value) -> Result<Vec<u8>> {
    let bytes = bounded_json(value, document_byte_limit(), "DOCUMENT_TOO_LARGE")?;
    validate_document(value)?;
    Ok(bytes)
}

pub(crate) fn bounded_json(
    value: &impl Serialize,
    limit: usize,
    code: &'static str,
) -> Result<Vec<u8>> {
    struct LimitedWriter {
        bytes: Vec<u8>,
        limit: usize,
        exceeded: bool,
    }
    impl Write for LimitedWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if buf.len() > self.limit.saturating_sub(self.bytes.len()) {
                self.exceeded = true;
                return Err(std::io::Error::other("JSON byte limit exceeded"));
            }
            self.bytes
                .try_reserve(buf.len())
                .map_err(|_| std::io::Error::other("Document allocation failed"))?;
            self.bytes.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = LimitedWriter {
        bytes: Vec::new(),
        limit,
        exceeded: false,
    };
    if let Err(error) = serde_json::to_writer(&mut writer, value) {
        return Err(BackendError::new(
            if writer.exceeded {
                code
            } else {
                "INVALID_DOCUMENT"
            },
            error.to_string(),
        ));
    }
    Ok(writer.bytes)
}
