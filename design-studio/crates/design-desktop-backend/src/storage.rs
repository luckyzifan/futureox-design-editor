use crate::digest_hex;
use crate::{
    BackendError, MAX_PATH_BYTES, Result, document_byte_limit, document_bytes, hash, validate_hash,
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Debug, Serialize)]
pub struct OpenedDocument {
    pub document: Value,
    pub hash: String,
    pub path: PathBuf,
}

#[derive(Debug, Serialize)]
pub struct TargetState {
    pub hash: Option<String>,
    pub path: PathBuf,
}

#[derive(Debug, Serialize)]
pub struct SavedDocument {
    pub hash: String,
    pub path: PathBuf,
    /// Replacement has committed. A durability warning is not a failed save.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

pub fn open(path: &Path) -> Result<OpenedDocument> {
    let path = document_path(path)?;
    let bytes = read_bounded(&path, document_byte_limit())?;
    let document: Value = if bytes.starts_with(&futureox_design_kernel::binfmt::MAGIC) {
        futureox_design_kernel::binfmt::decode_value(&bytes)
            .map_err(|e| BackendError::new("INVALID_DOCUMENT", e.to_string()))?
    } else {
        serde_json::from_slice(&bytes)
            .map_err(|e| BackendError::new("INVALID_DOCUMENT", e.to_string()))?
    };
    document_bytes(&document)?;
    Ok(OpenedDocument {
        document,
        hash: hash(&bytes),
        path,
    })
}

pub fn stat(path: &Path) -> Result<TargetState> {
    let path = document_path(path)?;
    Ok(TargetState {
        hash: file_hash(&path, document_byte_limit())?,
        path,
    })
}

pub fn save(path: &Path, document: &Value, expected_hash: Option<&str>) -> Result<SavedDocument> {
    save_guarded(path, document, expected_hash, || Ok(()))
}

pub(crate) fn save_guarded(
    path: &Path,
    document: &Value,
    expected_hash: Option<&str>,
    authorize: impl Fn() -> Result<()>,
) -> Result<SavedDocument> {
    validate_hash(expected_hash)?;
    authorize()?;
    let path = document_path(path)?;
    document_bytes(document)?; // Validate and bound the authored value before encoding.
    let bytes = futureox_design_kernel::binfmt::encode_value(document)
        .map_err(|error| BackendError::new("INVALID_DOCUMENT", error.to_string()))?;
    if bytes.len() > document_byte_limit() {
        return Err(BackendError::new(
            "DOCUMENT_TOO_LARGE",
            "Encoded document exceeds byte limit",
        ));
    }
    let warning = atomic_write_guarded(
        &path,
        &bytes,
        expected_hash,
        document_byte_limit(),
        || Ok(()),
        sync_directory,
        authorize,
    )?;
    Ok(SavedDocument {
        hash: hash(&bytes),
        path,
        warning,
    })
}

fn document_path(path: &Path) -> Result<PathBuf> {
    if path
        .extension()
        .and_then(|s| s.to_str())
        .is_none_or(|s| !s.eq_ignore_ascii_case("fd"))
    {
        return Err(BackendError::new("INVALID_PATH", "Choose a .fd file"));
    }
    normalized_path(path)
}

pub(crate) fn normalized_path(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() || path.as_os_str().len() > MAX_PATH_BYTES {
        return Err(BackendError::new(
            "INVALID_PATH",
            "An absolute, bounded path from a native dialog is required",
        ));
    }
    let name = path
        .file_name()
        .ok_or_else(|| BackendError::new("INVALID_PATH", "A file name is required"))?;
    let parent = path
        .parent()
        .ok_or_else(|| BackendError::new("INVALID_PATH", "A parent directory is required"))?
        .canonicalize()
        .map_err(|e| BackendError::io("Cannot resolve parent directory", e))?;
    if !parent.is_dir() {
        return Err(BackendError::new(
            "INVALID_PATH",
            "Parent must be a directory",
        ));
    }
    let path = parent.join(name);
    checked_metadata(&path)?;
    Ok(path)
}

pub(crate) fn checked_metadata(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(BackendError::new(
                "INVALID_PATH",
                "Symbolic links and non-regular files are not supported",
            ))
        }
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(BackendError::io("Cannot inspect file", error)),
    }
}

pub(crate) fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let metadata = checked_metadata(path)?
        .ok_or_else(|| BackendError::new("NOT_FOUND", "File does not exist"))?;
    if metadata.len() > limit as u64 {
        return Err(BackendError::new(
            "DOCUMENT_TOO_LARGE",
            "File exceeds the supported byte limit",
        ));
    }
    let file = open_read_no_follow(path).map_err(|e| BackendError::io("Cannot open file", e))?;
    let opened = file
        .metadata()
        .map_err(|e| BackendError::io("Cannot inspect opened file", e))?;
    if !opened.is_file() || opened.file_type().is_symlink() {
        return Err(BackendError::new(
            "INVALID_PATH",
            "Only regular files are supported",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| BackendError::io("Cannot read file", e))?;
    if bytes.len() > limit {
        return Err(BackendError::new(
            "DOCUMENT_TOO_LARGE",
            "File grew beyond the supported byte limit",
        ));
    }
    // Detect a concurrent symlink substitution before exposing loaded data.
    checked_metadata(path)?;
    Ok(bytes)
}

fn open_read_no_follow(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    // Native desktop ABI flags. No unsafe code or extra libc dependency is
    // needed. NONBLOCK prevents a raced regular-file→FIFO swap from hanging.
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        const O_NOFOLLOW: i32 = 0o400000;
        const O_NONBLOCK: i32 = 0o4000;
        options.custom_flags(O_NOFOLLOW | O_NONBLOCK);
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        const O_NOFOLLOW: i32 = 0x100;
        const O_NONBLOCK: i32 = 0x4;
        options.custom_flags(O_NOFOLLOW | O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(path)
}

pub(crate) fn file_hash(path: &Path, limit: usize) -> Result<Option<String>> {
    if checked_metadata(path)?.is_none() {
        return Ok(None);
    }
    let file = open_read_no_follow(path).map_err(|e| BackendError::io("Cannot hash file", e))?;
    let metadata = file
        .metadata()
        .map_err(|e| BackendError::io("Cannot inspect file", e))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(BackendError::new(
            "INVALID_PATH",
            "Only regular files are supported",
        ));
    }
    if metadata.len() > limit as u64 {
        return Err(BackendError::new(
            "DOCUMENT_TOO_LARGE",
            "File exceeds the available document working-memory allowance",
        ));
    }
    let mut reader = file.take(limit as u64 + 1);
    let mut digest = Sha256::new();
    let mut length = 0usize;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut chunk)
            .map_err(|e| BackendError::io("Cannot hash file", e))?;
        if count == 0 {
            break;
        }
        length = length.saturating_add(count);
        if length > limit {
            return Err(BackendError::new(
                "DOCUMENT_TOO_LARGE",
                "File grew beyond the admitted allowance",
            ));
        }
        digest.update(&chunk[..count]);
    }
    checked_metadata(path)?;
    Ok(Some(digest_hex((digest.finalize()).as_slice())))
}

fn check_expected(path: &Path, expected: Option<&str>, limit: usize) -> Result<()> {
    let actual = file_hash(path, limit)?;
    if actual.as_deref() != expected {
        return Err(BackendError::new(
            "CONFLICT",
            "The file changed outside this window. Keep your edits and reopen it or save a copy.",
        ));
    }
    Ok(())
}

struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        // Only the unique temporary file created by this operation is removed.
        let _ = fs::remove_file(&self.0);
    }
}

fn create_temporary(path: PathBuf) -> Result<(File, Temporary)> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(&path)
        .map_err(|e| BackendError::io("Cannot create temporary file; original retained", e))?;
    // Arm cleanup only after create_new succeeds; a colliding file isn't ours.
    Ok((file, Temporary(path)))
}

fn sync_directory(parent: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        File::open(parent)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = parent;
        Ok(())
    }
}

/// For an existing target: check hash, write+sync same-directory temporary file,
/// check hash again, then replace via std::fs::rename (replace-existing on Windows
/// as well). Never remove the original as a rename workaround. Missing targets
/// use a hard link as an atomic create-if-absent, so a racing create is preserved.
/// Hash check + replacement is not an OS-wide CAS against unrelated writers.
pub(crate) fn atomic_write(
    path: &Path,
    bytes: &[u8],
    expected: Option<&str>,
    limit: usize,
) -> Result<Option<String>> {
    atomic_write_with_hooks(path, bytes, expected, limit, || Ok(()), sync_directory)
}

fn atomic_write_with_hooks(
    path: &Path,
    bytes: &[u8],
    expected: Option<&str>,
    limit: usize,
    before_commit: impl FnOnce() -> Result<()>,
    sync_directory: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<Option<String>> {
    atomic_write_guarded(
        path,
        bytes,
        expected,
        limit,
        before_commit,
        sync_directory,
        || Ok(()),
    )
}

fn atomic_write_guarded(
    path: &Path,
    bytes: &[u8],
    expected: Option<&str>,
    limit: usize,
    before_commit: impl FnOnce() -> Result<()>,
    sync_directory: impl FnOnce(&Path) -> std::io::Result<()>,
    authorize: impl Fn() -> Result<()>,
) -> Result<Option<String>> {
    authorize()?;
    check_expected(path, expected, limit)?;
    let previous = checked_metadata(path)?;
    if previous
        .as_ref()
        .is_some_and(|m| m.permissions().readonly())
    {
        return Err(BackendError::new(
            "READ_ONLY",
            "The selected file is read-only",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| BackendError::new("INVALID_PATH", "Missing parent directory"))?;
    let temporary_path = parent.join(format!(".fd-write-{}.tmp", crate::unique_id()));
    let (mut file, temporary) = create_temporary(temporary_path)?;
    file.write_all(bytes)
        .map_err(|e| BackendError::io("Cannot write temporary file; original retained", e))?;
    if let Some(metadata) = previous {
        file.set_permissions(metadata.permissions()).map_err(|e| {
            BackendError::io("Cannot retain file permissions; original retained", e)
        })?;
    }
    file.sync_all()
        .map_err(|e| BackendError::io("Cannot sync temporary file; original retained", e))?;
    drop(file); // Windows must not retain our write handle during replacement.
    before_commit()?;
    check_expected(path, expected, limit)?;
    authorize()?;
    if expected.is_some() {
        fs::rename(&temporary.0, path)
            .map_err(|e| BackendError::io("Cannot replace file; original retained", e))?;
    } else {
        fs::hard_link(&temporary.0, path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                BackendError::new(
                    "CONFLICT",
                    "A file appeared at the selected destination. Save to another name.",
                )
            } else {
                BackendError::io("Cannot create file atomically; destination retained", e)
            }
        })?;
    }
    // Once committed, do not return a failure that implies the old hash is valid.
    // Directory fsync is portable on Unix; Windows std has no directory flush.
    if let Err(error) = sync_directory(parent) {
        return Ok(Some(format!(
            "File saved, but directory durability could not be confirmed: {error}"
        )));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_failure_before_replace_preserves_original_and_removes_temporary() {
        let root = std::env::temp_dir().join(format!("forma-atomic-test-{}", crate::unique_id()));
        fs::create_dir(&root).unwrap();
        let path = root.join("original.fd");
        fs::write(&path, b"original").unwrap();
        let result = atomic_write_with_hooks(
            &path,
            b"replacement",
            Some(&hash(b"original")),
            100,
            || {
                Err(BackendError::new(
                    "IO_ERROR",
                    "Injected full-disk/write interruption before rename",
                ))
            },
            sync_directory,
        );
        assert_eq!(result.unwrap_err().code, "IO_ERROR");
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn modification_during_write_is_detected_before_replace() {
        let root = std::env::temp_dir().join(format!("forma-race-test-{}", crate::unique_id()));
        fs::create_dir(&root).unwrap();
        let path = root.join("original.fd");
        fs::write(&path, b"original").unwrap();
        let result = atomic_write_with_hooks(
            &path,
            b"replacement",
            Some(&hash(b"original")),
            100,
            || {
                fs::write(&path, b"external").unwrap();
                Ok(())
            },
            sync_directory,
        );
        assert_eq!(result.unwrap_err().code, "CONFLICT");
        assert_eq!(fs::read(&path).unwrap(), b"external");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn committed_file_returns_warning_if_directory_sync_fails() {
        let root = std::env::temp_dir().join(format!("forma-sync-test-{}", crate::unique_id()));
        fs::create_dir(&root).unwrap();
        let path = root.join("original.fd");
        fs::write(&path, b"original").unwrap();
        let result = atomic_write_with_hooks(
            &path,
            b"replacement",
            Some(&hash(b"original")),
            100,
            || Ok(()),
            |_| Err(std::io::Error::other("injected directory sync failure")),
        );
        assert!(result.unwrap().unwrap().contains("File saved"));
        assert_eq!(
            file_hash(&path, 100).unwrap().as_deref(),
            Some(hash(b"replacement").as_str())
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_temp_create_does_not_remove_a_colliding_file() {
        let path =
            std::env::temp_dir().join(format!("forma-collision-test-{}", crate::unique_id()));
        fs::write(&path, b"not ours").unwrap();
        assert!(create_temporary(path.clone()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"not ours");
        fs::remove_file(path).unwrap();
    }
}
