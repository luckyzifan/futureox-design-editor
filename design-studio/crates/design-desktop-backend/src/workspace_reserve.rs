use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

const RESERVE_BYTES: usize = 256 * 1024;

fn reserve_path(database: &Path) -> PathBuf {
    let mut name = std::ffi::OsString::from(".");
    name.push(database.file_name().expect("validated workspace filename"));
    name.push(".reopen-space-v1");
    database.with_file_name(name)
}

fn marker(database: &Path) -> String {
    format!(
        "Futureox SQLite workspace reopen reserve v1\n{}\n",
        crate::hash(database.as_os_str().as_encoded_bytes()),
    )
}

pub(super) fn replenish(database: &Path) {
    let path = reserve_path(database);
    if !matches!(fs::symlink_metadata(&path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
        || !matches!(fs2::available_space(path.parent().expect("validated workspace parent")), Ok(bytes) if bytes >= 2 * RESERVE_BYTES as u64)
    {
        return;
    }
    // Atomic creation stages fully allocated bytes before publishing the reserve.
    // The absent-target path never replaces an existing entry.
    let mut bytes = vec![0; RESERVE_BYTES];
    let marker = marker(database);
    bytes[RESERVE_BYTES - marker.len()..].copy_from_slice(marker.as_bytes());
    let _ = crate::storage::atomic_write(&path, &bytes, None, RESERVE_BYTES);
}

fn regular_reserve(metadata: &fs::Metadata) -> bool {
    if !metadata.is_file() || metadata.file_type().is_symlink()
        || metadata.len() != RESERVE_BYTES as u64
    {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return false;
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}

fn release(database: &Path) -> Option<()> {
    let path = reserve_path(database);
    if !regular_reserve(&fs::symlink_metadata(&path).ok()?) {
        return None;
    }
    let mut file = crate::storage::open_read_no_follow(&path).ok()?;
    let opened = file.metadata().ok()?;
    if !regular_reserve(&opened) {
        return None;
    }
    let marker = marker(database);
    let mut footer = vec![0; marker.len()];
    file.seek(SeekFrom::End(-(footer.len() as i64))).ok()?;
    file.read_exact(&mut footer).ok()?;
    let current = fs::symlink_metadata(&path).ok()?;
    if footer != marker.as_bytes() || !regular_reserve(&current) {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != current.dev() || opened.ino() != current.ino() {
            return None;
        }
    }
    #[cfg(windows)]
    if same_file::Handle::from_file(file.try_clone().ok()?).ok()?
        != same_file::Handle::from_path(&path).ok()?
    {
        return None;
    }
    // Removing the reserved directory entry never truncates its target.
    drop(file);
    fs::remove_file(path).ok()
}

/// None when the volume has space or cannot be measured. Some records whether
/// a verified reservation was released on a volume with no available bytes.
pub(super) fn release_if_full(database: &Path) -> Option<bool> {
    let parent = database.parent().expect("validated workspace parent");
    matches!(fs2::available_space(parent), Ok(0)).then(|| release(database).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workspace_reopen_releases_only_its_own_complete_reserve() {
        let directory = std::env::temp_dir().join(format!("futureox-reserve-{}", crate::unique_id()));
        fs::create_dir(&directory).unwrap();
        let database = directory.join("workspace.sqlite3");
        let reserve = reserve_path(&database);
        // A regular file with the correct size still needs this database's marker.
        fs::write(&reserve, vec![7; RESERVE_BYTES]).unwrap();
        replenish(&database);
        assert!(release(&database).is_none());
        assert_eq!(fs::read(&reserve).unwrap(), vec![7; RESERVE_BYTES]);
        fs::remove_file(&reserve).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let original = directory.join("original");
            fs::write(&original, vec![8; RESERVE_BYTES]).unwrap();
            symlink(&original, &reserve).unwrap();
            replenish(&database);
            assert!(release(&database).is_none());
            assert_eq!(fs::read(&original).unwrap(), vec![8; RESERVE_BYTES]);
            assert!(fs::symlink_metadata(&reserve).unwrap().file_type().is_symlink());
            fs::remove_file(&reserve).unwrap();
        }

        replenish(&database);
        assert_eq!(fs::metadata(&reserve).unwrap().len(), RESERVE_BYTES as u64);
        release(&database).expect("verified reservation can be released");
        assert!(!reserve.exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
