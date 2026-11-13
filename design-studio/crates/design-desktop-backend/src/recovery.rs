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

    /// Publish only a fully parsed temporary snapshot. Partial temps stay on disk
    /// and never replace a newer published snapshot or the import they name.
    fn publish_synced_temps(&self) -> Result<()> {
        let directory = fs::read_dir(&self.root)
            .map_err(|e| BackendError::io("Cannot list recovery directory", e))?;
        for item in directory.take(256) {
            let item = item.map_err(|e| BackendError::io("Cannot inspect recovery entry", e))?;
            let name = item.file_name();
            let Some(name) = name.to_str() else { continue };
            if !(name.starts_with(".fd-write-") && name.ends_with(".tmp")) {
                continue;
            }
            let path = item.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                continue;
            }
            let Ok(bytes) = storage::read_bounded(&path, recovery_byte_limit()) else {
                continue;
            };
            let Ok(record) = self.validated_record(&bytes) else {
                continue;
            };
            let dest = self.path(&record.entry.recovery_id)?;
            match self.read(&record.entry.recovery_id) {
                Ok(existing) if existing.entry.updated_at >= record.entry.updated_at => continue,
                Ok(_) => {}
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

    fn files(&self) -> Result<Vec<(String, PathBuf)>> {
        let mut files = Vec::new();
        let directory = fs::read_dir(&self.root)
            .map_err(|e| BackendError::io("Cannot list recovery directory", e))?;
        // App-owned directory should contain at most 16 snapshots plus interrupted
        // temp writes. Refuse unexpected unbounded content instead of walking it.
        for (index, item) in directory.enumerate() {
            if index >= 256 {
                return Err(BackendError::new(
                    "RECOVERY_LIMIT",
                    "Recovery directory contains too many files; existing files were retained",
                ));
            }
            let item = item.map_err(|e| BackendError::io("Cannot inspect recovery entry", e))?;
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
        if old.is_some() {
            // Do not silently overwrite a corrupt recovery copy with new data.
            self.read(id)?;
        } else if self.files()?.len() >= MAX_RECOVERIES {
            return Err(BackendError::new(
                "RECOVERY_LIMIT",
                "16 recovery snapshots are retained. Explicitly restore or discard one before creating another.",
            ));
        }
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
        fs::remove_file(path)
            .map_err(|e| BackendError::io("Cannot remove selected recovery snapshot", e))?;
        Ok(true)
    }
}
