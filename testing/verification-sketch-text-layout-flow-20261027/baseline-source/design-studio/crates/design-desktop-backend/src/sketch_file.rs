//! Bounded trusted-host native file admission, shared by inspect and editing sessions.
use futureox_design_kernel::sketch::{Document, Session};
use serde::Deserialize;
use std::{
    fs::File,
    io::Read,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SAFE_EPOCH: u64 = 9_007_199_254_740_991;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InspectRequest {
    pub path: PathBuf,
    pub document_id: String,
    pub session_epoch: u64,
}
pub(crate) fn load_session(
    request: InspectRequest,
    cancel: &AtomicBool,
) -> Result<Session, String> {
    let cancelled = || {
        if cancel.load(Ordering::Acquire) {
            Err("Sketch inspection cancelled".to_owned())
        } else {
            Ok(())
        }
    };
    cancelled()?;
    let path = &request.path;
    if !path.is_absolute()
        || path
            .to_str()
            .is_none_or(|p| p.len() > 32 * 1024 || p.contains('\0'))
        || !path
            .extension()
            .and_then(|v| v.to_str())
            .is_some_and(|v| v.eq_ignore_ascii_case("sketch"))
        || request.session_epoch == 0
        || request.session_epoch > MAX_SAFE_EPOCH
    {
        return Err("Invalid Sketch inspection identity or path".into());
    }
    let initial = std::fs::symlink_metadata(path).map_err(|_| "Sketch file unavailable")?;
    if !initial.is_file() || initial.len() > MAX_ARCHIVE_BYTES {
        return Err("Sketch file must be a regular file within 64 MiB".into());
    }
    let file = File::open(path).map_err(|_| "Sketch file unavailable")?;
    let metadata = file.metadata().map_err(|_| "Sketch metadata unavailable")?;
    if !metadata.is_file() || metadata.len() > MAX_ARCHIVE_BYTES {
        return Err("Sketch file exceeds admission limits".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_ARCHIVE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Sketch file read failed")?;
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err("Sketch file exceeds 64 MiB".into());
    }
    cancelled()?;
    let document = Document::from_sketch(&bytes).map_err(|error| error.to_string())?;
    let session = Session::new(document, request.document_id, request.session_epoch)
        .map_err(|error| error.to_string())?;
    cancelled()?;
    Ok(session)
}
