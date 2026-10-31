use super::{Result, issue};
use std::path::Path;

/// File-backed sources do not enter wasm32 as one allocation. Their logical
/// ceiling follows the actual backing volume; small working sets retain the
/// independent memory policy. No fixed GiB ceiling is substituted on failure.
pub(super) fn source_limit(directory: &Path) -> Result<u64> {
    let total = fs2::total_space(directory).map_err(issue)?;
    if total == 0 { return Err(issue("Source storage capacity is unavailable")); }
    Ok(total.min(futureox_design_kernel::large_json::MAX_SOURCE_OFFSET))
}

/// Reserve no fictitious memory for the whole source. Check bytes that will
/// actually be copied/expanded to this volume. A concurrent writer can still
/// exhaust it afterwards, so normal I/O failure and atomic cleanup remain required.
pub(super) fn require_space(directory: &Path, bytes: u64) -> Result<()> {
    let available = fs2::available_space(directory).map_err(issue)?;
    if bytes > available {
        return Err(issue(format!("Source storage needs {bytes} additional bytes; {available} bytes are available")));
    }
    Ok(())
}
