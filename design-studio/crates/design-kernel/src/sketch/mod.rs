//! Sketch archive adapter within the shared Futureox design kernel.
//!
//! Preserves native page/layer trees, symbols, unknown JSON and resources for
//! source-format inspection and round trips. General editing and rendering use
//! the shared scene document, history and renderer; this adapter never defines
//! a second application engine.
#![forbid(unsafe_code)]
pub(crate) mod archive;
mod curve;
pub(crate) mod geometry;
mod model;
mod raw_json;
mod resize;
mod session;
pub mod preview;

pub use curve::{CurveContour, CurvePoint, PathSink, Point};
pub use model::{
    Document, Layer, LayerKind, NativePage, PinConstraints, TextOverrideTarget, TextOverrideValue,
};
pub use resize::{Frame, Size};
pub use session::{
    Applied, CommandEnvelope, HistoryStatus, MAX_HISTORY_BYTES, MAX_HISTORY_ENTRIES, Owner,
    Session, SketchCommand,
};

/// Legacy archive-session protocol discriminator; not an application kernel.
pub const KERNEL_ID: &str = "sketch";
pub const DOCUMENT_SCHEMA: &str = "sketch-native-v1";
pub const CAPABILITIES: &[&str] = &[
    "native-archive-read-write",
    "layer-name-edit",
    "symbol-text-override",
    "normalized-bezier-path",
    "legacy-parent-resize-proposal",
    "legacy-direct-child-resize",
    "session-undo-redo",
    "native-leaf-frame-edit",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Archive(String),
    Limit(&'static str),
    Invalid(String),
    Unsupported(String),
    Ambiguous(String),
    Missing(String),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Sketch archive: {self:?}")
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;
