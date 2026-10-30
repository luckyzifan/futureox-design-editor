//! New-file-only native Sketch save-as. The trusted host owns the dialog path.
//! No overwrite grant, Figma save token, or document-format conversion is used.
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};
const LIMIT: usize = 64 * 1024 * 1024;
static SERIAL: AtomicU64 = AtomicU64::new(0);
#[derive(Debug)]
pub(crate) struct SaveOutcome {
    pub directory_synced: bool,
    pub warning: Option<String>,
}
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("Sketch save cancelled before publication".into())
    } else {
        Ok(())
    }
}
fn sync_directory(parent: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        File::open(parent)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = parent;
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "directory flush is unavailable on this platform",
        ))
    }
}
pub(crate) fn save_new(
    path: &Path,
    bytes: &[u8],
    cancel: &AtomicBool,
) -> Result<SaveOutcome, String> {
    save_with_hooks(path, bytes, cancel, || Ok(()), sync_directory)
}
fn save_with_hooks(
    path: &Path,
    bytes: &[u8],
    cancel: &AtomicBool,
    before_publish: impl FnOnce() -> Result<(), String>,
    sync: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<SaveOutcome, String> {
    cancelled(cancel)?;
    if !path.is_absolute()
        || path
            .to_str()
            .is_none_or(|p| p.len() > 32768 || p.contains('\0'))
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        || !path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("sketch"))
    {
        return Err("Invalid trusted Sketch destination".into());
    }
    if bytes.len() > LIMIT {
        return Err("Sketch snapshot exceeds 64 MiB".into());
    }
    futureox_design_kernel::sketch::Document::from_sketch(bytes)
        .map_err(|_| "Invalid native Sketch snapshot")?;
    let parent = path
        .parent()
        .ok_or("Missing Sketch destination directory")?;
    // Reject symlinks/reparse-style indirections visible at admission. This is
    // not a sandbox against a hostile process replacing ancestor directories.
    for ancestor in parent.ancestors() {
        let m = fs::symlink_metadata(ancestor)
            .map_err(|_| "Sketch destination directory unavailable")?;
        if !m.is_dir() || m.file_type().is_symlink() {
            return Err("Sketch destination requires ordinary directories".into());
        }
    }
    match fs::symlink_metadata(path) {
        Ok(_) => return Err("Sketch destination already exists; choose a new name".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Sketch destination cannot be checked".into()),
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Clock unavailable")?
        .as_nanos();
    let temp_path = parent.join(format!(
        ".sketch-save-{}-{stamp}-{}.tmp",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp_path)
        .map_err(|_| "Cannot create Sketch temporary file")?;
    let temp = Temporary(temp_path);
    file.write_all(bytes)
        .map_err(|_| "Cannot write Sketch temporary file; destination unchanged")?;
    file.sync_all()
        .map_err(|_| "Cannot sync Sketch temporary file; destination unchanged")?;
    drop(file);
    before_publish()?;
    cancelled(cancel)?;
    // std::fs::rename can overwrite a racing target. A same-directory hard link
    // is atomic create-if-absent; unsupported filesystems fail without fallback.
    fs::hard_link(&temp.0, path).map_err(
        |_| "Sketch destination appeared or atomic publication failed; existing file retained",
    )?;
    let cleanup = fs::remove_file(&temp.0);
    let flushed = sync(parent);
    // Publication is the commit point: cancellation after it is not a failed save.
    if cleanup.is_err() || flushed.is_err() {
        return Ok(SaveOutcome{directory_synced:false,warning:Some("Sketch file was published, but temporary cleanup or directory durability could not be confirmed. Keep the session dirty and verify the saved copy.".into())});
    }
    Ok(SaveOutcome {
        directory_synced: true,
        warning: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            // current_dir avoids platform /tmp aliases rejected by the production check.
            let p = std::env::current_dir().unwrap().join(format!(
                "sketch-save-test-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn native() -> Vec<u8> {
        let mut z = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name,data) in [("meta.json",b"{}".as_slice()),("document.json",br#"{"_class":"document","pages":[{"_ref":"pages/P","_ref_class":"MSImmutablePage"}]}"#),("pages/P.json",br#"{"_class":"page","do_objectID":"P","layers":[],"unknown":17}"#),("images/raw",b"opaque")]{
            z.start_file(name,zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();z.write_all(data).unwrap();
        }
        z.finish().unwrap().into_inner()
    }
    #[test]
    fn native_save_new_preserves_bytes_and_refuses_existing_destination() {
        let f = Fixture::new();
        let p = f.0.join("copy.sketch");
        let bytes = native();
        let cancel = AtomicBool::new(false);
        let outcome = save_new(&p, &bytes, &cancel).unwrap();
        #[cfg(unix)]
        assert!(outcome.directory_synced);
        assert_eq!(fs::read(&p).unwrap(), bytes);
        assert!(save_new(&p, &bytes, &cancel).is_err());
        assert_eq!(fs::read(&p).unwrap(), bytes);
        assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
    }
    #[test]
    fn native_save_race_cancel_and_precommit_failure_never_clobber() {
        let f = Fixture::new();
        let bytes = native();
        let cancel = AtomicBool::new(false);
        let race = f.0.join("race.sketch");
        assert!(
            save_with_hooks(
                &race,
                &bytes,
                &cancel,
                || {
                    fs::write(&race, b"newer user file").unwrap();
                    Ok(())
                },
                sync_directory
            )
            .is_err()
        );
        assert_eq!(fs::read(&race).unwrap(), b"newer user file");
        let p = f.0.join("cancel.sketch");
        assert!(
            save_with_hooks(
                &p,
                &bytes,
                &cancel,
                || {
                    cancel.store(true, Ordering::Release);
                    Ok(())
                },
                sync_directory
            )
            .is_err()
        );
        assert!(!p.exists());
        cancel.store(false, Ordering::Release);
        assert!(
            save_with_hooks(
                &p,
                &bytes,
                &cancel,
                || Err("injected before publication failure".into()),
                sync_directory
            )
            .is_err()
        );
        assert!(!p.exists());
        assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
    }
    #[test]
    fn native_save_postpublication_sync_failure_is_explicit_and_links_are_refused() {
        let f = Fixture::new();
        let bytes = native();
        let cancel = AtomicBool::new(false);
        let p = f.0.join("copy.sketch");
        let result = save_with_hooks(
            &p,
            &bytes,
            &cancel,
            || Ok(()),
            |_| Err(std::io::Error::other("injected fsync")),
        )
        .unwrap();
        assert!(!result.directory_synced);
        assert!(result.warning.is_some());
        assert_eq!(fs::read(&p).unwrap(), bytes);
        #[cfg(unix)]
        {
            let link = f.0.join("link.sketch");
            std::os::unix::fs::symlink(&p, &link).unwrap();
            assert!(save_new(&link, &bytes, &cancel).is_err());
            assert_eq!(fs::read(&p).unwrap(), bytes);
        }
    }
}
