use crate::{
    BackendError, MAX_PATH_BYTES, MAX_RECOVERIES, Result, bounded_json, document_byte_limit,
    document_bytes, hash, storage, validate_hash,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const RECOVERY_DIRECTORY_ENTRIES: usize = 256;

fn recovery_byte_limit() -> usize {
    document_byte_limit().saturating_add(64 * 1024)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub recovery_id: String,
    pub document_id: String,
    pub name: String,
    pub updated_at: u64,
    /// Monotonic per-recovery write counter. Wall-clock `updated_at` only has
    /// millisecond resolution, so two writes in the same millisecond tie and a
    /// crash-after-sync-before-rename temp could be mistaken for an older
    /// leftover. A single recovery id has one sequential writer, so this
    /// counter orders a genuine newer temp above the published snapshot even
    /// when their timestamps tie. Legacy records default to 0 and fall back to
    /// `updated_at` ordering.
    #[serde(default)]
    pub sequence: u64,
    pub hash: String,
    pub source_path: Option<String>,
    pub source_hash: Option<String>,
    // Runtime durability warnings are not trusted disk metadata. In particular,
    // don't let many tampered envelopes amplify a bounded list response.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRecord {
    #[serde(flatten)]
    pub entry: RecoveryEntry,
    pub document: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryIssue {
    pub recovery_id: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct RecoveryList {
    pub entries: Vec<RecoveryEntry>,
    pub issues: Vec<RecoveryIssue>,
}

pub(crate) struct RecoveryStore {
    root: PathBuf,
}

impl RecoveryStore {
    pub fn new(path: &Path) -> Result<Self> {
        if !path.is_absolute() || path.as_os_str().len() > MAX_PATH_BYTES {
            return Err(BackendError::new(
                "INVALID_PATH",
                "Recovery directory must be an absolute app-owned path",
            ));
        }
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(BackendError::new(
                    "INVALID_PATH",
                    "Recovery root must be a real directory",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir_all(path)
                    .map_err(|e| BackendError::io("Cannot create app recovery directory", e))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| {
                        BackendError::io("Cannot make recovery directory private", e)
                    })?;
                }
            }
            Err(error) => return Err(BackendError::io("Cannot inspect recovery directory", error)),
        }
        let store = Self {
            root: path
                .canonicalize()
                .map_err(|e| BackendError::io("Cannot resolve recovery directory", e))?,
        };
        // A crash after the temporary snapshot was synced, and before rename,
        // leaves the bytes beside the last published recovery file.
        store.publish_synced_temps()?;
        Ok(store)
    }

    fn validated_record(&self, bytes: &[u8]) -> Result<RecoveryRecord> {
        let record: RecoveryRecord = serde_json::from_slice(bytes).map_err(|e| {
            BackendError::new(
                "INVALID_RECOVERY",
                format!("Recovery snapshot is damaged; retained unchanged: {e}"),
            )
        })?;
        let document = document_bytes(&record.document)?;
        validate_hash(record.entry.source_hash.as_deref())?;
        // Reject a record whose id cannot name a recovery file before any rename.
        self.path(&record.entry.recovery_id)?;
        if record.entry.hash != hash(&document)
            || record.document["id"].as_str() != Some(&record.entry.document_id)
            || record.document["name"].as_str() != Some(&record.entry.name)
            || record
                .entry
                .source_path
                .as_deref()
                .is_some_and(|p| !Path::new(p).is_absolute() || p.len() > MAX_PATH_BYTES)
        {
            return Err(BackendError::new(
                "INVALID_RECOVERY",
                "Recovery metadata/hash mismatch; snapshot retained unchanged",
            ));
        }
        Ok(record)
    }

    fn read_temporary_record(&self, path: &Path) -> Result<Option<RecoveryRecord>> {
        if !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".fd-write-") && name.ends_with(".tmp"))
        {
            return Ok(None);
        }
        let bytes = match storage::read_bounded(path, recovery_byte_limit()) {
            Ok(bytes) => bytes,
            Err(error)
                if matches!(
                    error.code,
                    "INVALID_PATH" | "NOT_FOUND" | "DOCUMENT_TOO_LARGE"
                ) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        Ok(self.validated_record(&bytes).ok())
    }

    /// Publish only a fully parsed temporary snapshot. Partial temps stay on disk
    /// and never replace a newer published snapshot or the import they name.
    fn publish_synced_temps(&self) -> Result<()> {
        let directory = fs::read_dir(&self.root)
            .map_err(|e| BackendError::io("Cannot list recovery directory", e))?;
        for item in directory.take(RECOVERY_DIRECTORY_ENTRIES) {
            let item = item.map_err(|e| BackendError::io("Cannot inspect recovery entry", e))?;
            let path = item.path();
            let Ok(Some(record)) = self.read_temporary_record(&path) else {
                continue;
            };
            let dest = self.path(&record.entry.recovery_id)?;
            match self.read(&record.entry.recovery_id) {
                Ok(existing) => {
                    // Prefer the monotonic write counter; it stays correct when
                    // two writes share a millisecond. Equal counters (legacy
                    // records, or a stale leftover) fall back to wall-clock time
                    // so an older temp never replaces a newer published snapshot.
                    let newer = if record.entry.sequence != existing.entry.sequence {
                        record.entry.sequence > existing.entry.sequence
                    } else {
                        record.entry.updated_at > existing.entry.updated_at
                    };
                    if !newer {
                        continue;
                    }
                }
                Err(error) if error.code == "NOT_FOUND" || error.code == "INVALID_RECOVERY" => {}
                Err(_) => continue,
            }
            if storage::checked_metadata(&dest)?.is_none() && self.files()?.len() >= MAX_RECOVERIES
            {
                continue;
            }
            if fs::rename(&path, &dest).is_err() {
                continue;
            }
        }
        Ok(())
    }

    fn path(&self, id: &str) -> Result<PathBuf> {
        if id.is_empty()
            || id.len() > 80
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err(BackendError::new(
                "INVALID_REQUEST",
                "Recovery ID must contain 1–80 ASCII letters, digits, hyphens or underscores",
            ));
        }
        Ok(self.root.join(format!("{id}.recovery.json")))
    }

    fn directory_entries(&self) -> Result<Vec<fs::DirEntry>> {
        let entries = fs::read_dir(&self.root)
            .map_err(|e| BackendError::io("Cannot list recovery directory", e))?
            .take(RECOVERY_DIRECTORY_ENTRIES + 1)
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(|e| BackendError::io("Cannot inspect recovery entry", e))?;
        // A private recovery directory contains at most 16 published snapshots
        // and some interrupted writes. Keep reads and discard preflight bounded.
        if entries.len() > RECOVERY_DIRECTORY_ENTRIES {
            return Err(BackendError::new(
                "RECOVERY_LIMIT",
                "Recovery directory contains too many files; existing files were retained",
            ));
        }
        Ok(entries)
    }

    fn files(&self) -> Result<Vec<(String, PathBuf)>> {
        let mut files = Vec::new();
        for item in self.directory_entries()? {
            let name = item.file_name();
            let Some(id) = name.to_str().and_then(|s| s.strip_suffix(".recovery.json")) else {
                continue;
            };
            files.push((id.to_owned(), item.path()));
            if files.len() > MAX_RECOVERIES {
                return Err(BackendError::new(
                    "RECOVERY_LIMIT",
                    "Recovery snapshot limit exceeded; existing snapshots were retained",
                ));
            }
        }
        Ok(files)
    }

    pub fn write(
        &self,
        id: &str,
        document: &Value,
        source_path: Option<&str>,
        source_hash: Option<&str>,
    ) -> Result<RecoveryEntry> {
        let path = self.path(id)?;
        validate_hash(source_hash)?;
        if source_path.is_some_and(|p| !Path::new(p).is_absolute() || p.len() > MAX_PATH_BYTES) {
            return Err(BackendError::new(
                "INVALID_PATH",
                "Recovery source path must be absolute and bounded",
            ));
        }
        let bytes = document_bytes(document)?;
        let old = storage::file_hash(&path, recovery_byte_limit())?;
        let prior_sequence = if old.is_some() {
            // Do not silently overwrite a corrupt recovery copy with new data.
            self.read(id)?.entry.sequence
        } else {
            if self.files()?.len() >= MAX_RECOVERIES {
                return Err(BackendError::new(
                    "RECOVERY_LIMIT",
                    "16 recovery snapshots are retained. Explicitly restore or discard one before creating another.",
                ));
            }
            0
        };
        let mut entry = RecoveryEntry {
            recovery_id: id.to_owned(),
            document_id: document["id"].as_str().unwrap_or_default().to_owned(),
            name: document["name"].as_str().unwrap_or_default().to_owned(),
            updated_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| BackendError::new("IO_ERROR", "System clock is before Unix epoch"))?
                .as_millis()
                .try_into()
                .map_err(|_| BackendError::new("IO_ERROR", "System clock is out of range"))?,
            sequence: prior_sequence.saturating_add(1),
            hash: hash(&bytes),
            source_path: source_path.map(str::to_owned),
            source_hash: source_hash.map(str::to_owned),
            warning: None,
        };
        // Serialize by reference so large embedded assets are not cloned.
        #[derive(Serialize)]
        struct RecordRef<'a> {
            #[serde(flatten)]
            entry: &'a RecoveryEntry,
            document: &'a Value,
        }
        let record = bounded_json(
            &RecordRef {
                entry: &entry,
                document,
            },
            recovery_byte_limit(),
            "DOCUMENT_TOO_LARGE",
        )?;
        entry.warning =
            storage::atomic_write(&path, &record, old.as_deref(), recovery_byte_limit())?;
        Ok(entry)
    }

    pub fn read(&self, id: &str) -> Result<RecoveryRecord> {
        let bytes = storage::read_bounded(&self.path(id)?, recovery_byte_limit())?;
        let record = self.validated_record(&bytes)?;
        if record.entry.recovery_id != id {
            return Err(BackendError::new(
                "INVALID_RECOVERY",
                "Recovery metadata/hash mismatch; snapshot retained unchanged",
            ));
        }
        Ok(record)
    }

    pub fn list(&self) -> Result<RecoveryList> {
        let mut list = RecoveryList {
            entries: Vec::new(),
            issues: Vec::new(),
        };
        for (id, _) in self.files()? {
            match self.read(&id) {
                Ok(record) => list.entries.push(record.entry),
                Err(error) => list.issues.push(RecoveryIssue {
                    recovery_id: id,
                    message: error.to_string(),
                }),
            }
        }
        list.entries.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.recovery_id.cmp(&b.recovery_id))
        });
        list.issues
            .sort_by(|a, b| a.recovery_id.cmp(&b.recovery_id));
        Ok(list)
    }

    /// Called only after explicit discard or a confirmed successful save. Reading
    /// a snapshot never deletes it or writes to its original sourcePath.
    pub fn remove(&self, id: &str) -> Result<bool> {
        let path = self.path(id)?;
        if storage::checked_metadata(&path)?.is_none() {
            return Ok(false);
        }
        let mut pending = Vec::new();
        for item in self.directory_entries()? {
            let candidate = item.path();
            if self
                .read_temporary_record(&candidate)?
                .is_some_and(|record| record.entry.recovery_id == id)
            {
                pending.push(candidate);
            }
        }
        // Clear the interrupted writes before removing the published snapshot.
        // On failure the last published copy stays available. If the process
        // stops mid-discard, no older temp can replace a successfully removed
        // snapshot after the next startup.
        for candidate in &pending {
            fs::remove_file(candidate)
                .map_err(|e| BackendError::io("Cannot remove interrupted recovery snapshot", e))?;
        }
        if !pending.is_empty() {
            storage::sync_directory(&self.root).map_err(|e| {
                BackendError::io("Cannot sync interrupted recovery snapshot removal", e)
            })?;
        }
        fs::remove_file(path)
            .map_err(|e| BackendError::io("Cannot remove selected recovery snapshot", e))?;
        Ok(true)
    }
}
