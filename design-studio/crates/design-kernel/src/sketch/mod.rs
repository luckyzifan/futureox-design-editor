//! Sketch archive adapter within the shared Futureox design kernel.
//!
//! Preserves native page/layer trees, symbols, unknown JSON and resources for
//! source-format inspection and round trips. General editing and rendering use
//! the shared scene document, history and renderer; this adapter never defines
//! a second application engine.
#![forbid(unsafe_code)]
pub(crate) mod archive;
pub(crate) mod archived_text;
mod curve;
pub mod geometry;
mod model;
mod raw_json;
mod resize;
mod session;
pub mod preview;

pub use curve::{CurveContour, CurvePoint, PathSink, Point};
pub(crate) use curve::path_field;
pub use model::{
    Document, Layer, LayerKind, NativePage, PinConstraints, TextOverrideTarget, TextOverrideValue,
};
pub use resize::{Frame, Size};
pub use session::{
    Applied, CommandEnvelope, HistoryStatus, MAX_HISTORY_BYTES, MAX_HISTORY_ENTRIES, Owner,
    Session, SketchCommand,
};

use serde_json::Value;

pub(crate) fn uses_legacy_transparent_artboards(meta: &Value) -> bool {
    if !matches!(
        meta.get("app").and_then(Value::as_str),
        Some("com.bohemiancoding.sketch3" | "com.bohemiancoding.sketchtool")
    ) || !meta.get("version").and_then(Value::as_u64).is_some_and(|version| version > 0)
    {
        return false;
    }
    let Some(version) = meta.get("appVersion").and_then(Value::as_str) else {
        return false;
    };
    let mut parts = version.split('.');
    let is_number = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    // Sketch 101.9 was the last release before Athens 2025.1, which migrates
    // legacy artboards into frames when opening a document.
    parts.next().filter(|part| is_number(part))
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| (1..=101).contains(&major))
        && parts.all(is_number)
}

pub(crate) fn implicit_white_artboard_background(
    layer: &Value,
    inside_artboard: bool,
    legacy_transparent_artboards: bool,
) -> bool {
    let legacy_background_disabled = legacy_transparent_artboards
        && layer.get("hasBackgroundColor").and_then(Value::as_bool) == Some(false)
        && layer.get("includeBackgroundColorInExport").and_then(Value::as_bool) == Some(false);
    inside_artboard
        && !legacy_background_disabled
        && layer.get("backgroundColor").is_some()
        && !layer
            .pointer("/userInfo/com.futureox.design-kernel")
            .is_some_and(Value::is_object)
}

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
