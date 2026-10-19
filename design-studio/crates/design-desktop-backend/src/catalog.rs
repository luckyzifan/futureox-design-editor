//! Local discovery metadata only. Documents and recovery snapshots remain files.
//! A persisted row is never authority: each process requires a native reselection.
use crate::{BackendError, MAX_PATH_BYTES, Result, hash};
use serde_json::{Value, json};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const SCHEMA_VERSION: i64 = 1;
pub const MAX_DIRECTORIES: i64 = 32;
pub const MAX_CATALOG_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_FILES: usize = 512;
pub const MAX_SCAN_ENTRIES: usize = 2048;
fn db(e: sqlx::Error) -> BackendError {
    BackendError::new("CATALOG_ERROR", e.to_string())
}
fn stale() -> BackendError {
    BackendError::new(
        "STALE_DIRECTORY",
        "Select this directory again using the native dialog",
    )
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    path: PathBuf,
    #[cfg(not(windows))]
    key: String,
    #[cfg(windows)]
    key: std::sync::Arc<same_file::Handle>,
}
fn identity(path: &Path) -> Result<Identity> {
    let m = fs::symlink_metadata(path).map_err(|_| stale())?;
    if !m.is_dir() || m.file_type().is_symlink() {
        return Err(stale());
    }
    #[cfg(unix)]
    let key = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", m.dev(), m.ino())
    };
    #[cfg(windows)]
    let key = {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return Err(stale());
        }
        std::sync::Arc::new(same_file::Handle::from_path(path).map_err(|_| stale())?)
    };
    #[cfg(not(any(unix, windows)))]
    let key = format!("{:?}", m.created().map_err(|_| stale())?);
    Ok(Identity {
        path: path.canonicalize().map_err(|_| stale())?,
        key,
    })
}
fn lineage(path: &Path) -> Result<Vec<Identity>> {
    if !path.is_absolute()
        || path.as_os_str().len() > MAX_PATH_BYTES
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(stale());
    }
    if path.ancestors().count() > 64 {
        return Err(stale());
    }
    path.ancestors().map(identity).collect()
}

/// SQLite's page limit is a per-connection safety setting. SQLx may recycle the
/// connection, so install and verify it before every new connection is admitted.
async fn configure_connection(
    connection: &mut sqlx::SqliteConnection,
) -> std::result::Result<(), sqlx::Error> {
    let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
        .fetch_one(&mut *connection)
        .await?;
    if page_size <= 0 {
        return Err(sqlx::Error::Protocol("Invalid catalog page size".into()));
    }
    let limit = (MAX_CATALOG_BYTES / (page_size as u64)) as i64;
    // PRAGMA assignment does not accept bind parameters. SQLite page sizes are
    // powers of two from 512 through 65536; choose reviewed static SQL for the
    // fixed 32 MiB budget instead of constructing unaudited SQL text.
    let pragma = match page_size {
        512 => "PRAGMA max_page_count=65536",
        1024 => "PRAGMA max_page_count=32768",
        2048 => "PRAGMA max_page_count=16384",
        4096 => "PRAGMA max_page_count=8192",
        8192 => "PRAGMA max_page_count=4096",
        16384 => "PRAGMA max_page_count=2048",
        32768 => "PRAGMA max_page_count=1024",
        65536 => "PRAGMA max_page_count=512",
        _ => {
            return Err(sqlx::Error::Protocol(
                "Unsupported catalog page size".into(),
            ));
        }
    };
    let effective: i64 = sqlx::query_scalar(pragma)
        .fetch_one(&mut *connection)
        .await?;
    // SQLite cannot lower the bound below existing page_count. A larger returned
    // value is a refusal, not successful enforcement; leave those bytes intact.
    if limit <= 0 || effective != limit {
        return Err(sqlx::Error::Protocol(
            "Catalog page limit could not be enforced; database preserved".into(),
        ));
    }
    Ok(())
}

pub struct Catalog {
    pool: SqlitePool,
    grants: Mutex<HashMap<String, Vec<Identity>>>,
}
impl Catalog {
    pub async fn open(path: &Path) -> Result<Self> {
        if !path.is_absolute() || path.as_os_str().len() > MAX_PATH_BYTES {
            return Err(BackendError::new(
                "INVALID_PATH",
                "Catalog requires an absolute app-owned path",
            ));
        }
        let parent = path.parent().ok_or_else(stale)?;
        lineage(parent)?;
        if let Ok(m) = fs::symlink_metadata(path) {
            if !m.is_file() || m.file_type().is_symlink() {
                return Err(stale());
            }
            if m.len() > MAX_CATALOG_BYTES {
                return Err(BackendError::new(
                    "CATALOG_TOO_LARGE",
                    "Catalog exceeds 32 MiB; database preserved",
                ));
            }
        }
        // Create the app-owned metadata file privately. Never replace existing
        // bytes when SQLite reports a corrupt or future schema.
        let mut create = fs::OpenOptions::new();
        create.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            create.mode(0o600);
        }
        match create.open(path) {
            Ok(file) => drop(file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(BackendError::io("Cannot create private catalog", e)),
        }
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .min_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .after_connect(|connection, _| Box::pin(configure_connection(connection)))
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(false)
                    .foreign_keys(true)
                    .busy_timeout(Duration::from_secs(2)),
            )
            .await
            .map_err(db)?;
        let result = Self::migrate(&pool).await;
        if let Err(error) = result {
            pool.close().await;
            return Err(error);
        }
        Ok(Self {
            pool,
            grants: Mutex::new(HashMap::new()),
        })
    }
    async fn migrate(pool: &SqlitePool) -> Result<()> {
        let check: String = sqlx::query_scalar("PRAGMA quick_check")
            .fetch_one(pool)
            .await
            .map_err(db)?;
        if check != "ok" {
            return Err(BackendError::new("CATALOG_CORRUPT", check));
        }
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(pool)
            .await
            .map_err(db)?;
        if !(0..=SCHEMA_VERSION).contains(&version) {
            return Err(BackendError::new(
                "CATALOG_FUTURE_SCHEMA",
                "Unsupported catalog schema; database preserved",
            ));
        }
        if version == 0 {
            let mut tx = pool.begin().await.map_err(db)?;
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetch_one(&mut *tx).await.map_err(db)?;
            if count != 0 {
                return Err(BackendError::new(
                    "CATALOG_CORRUPT",
                    "Unversioned nonempty database preserved",
                ));
            }
            for sql in [
                "CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL)",
                "CREATE TABLE directories(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), path TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL)",
                "CREATE TABLE files(id TEXT PRIMARY KEY, directory_id TEXT NOT NULL REFERENCES directories(id), relative_path TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0), modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL, last_opened_at INTEGER NOT NULL DEFAULT 0, UNIQUE(directory_id,relative_path))",
                "CREATE INDEX files_directory ON files(directory_id)",
                "PRAGMA user_version=1",
            ] {
                sqlx::query(sql).execute(&mut *tx).await.map_err(db)?;
            }
            tx.commit().await.map_err(db)?;
        }
        // Reject missing/altered required columns at startup, without recreating data.
        sqlx::query("SELECT p.id,p.name,p.updated_at,d.id,d.project_id,d.path,d.updated_at,f.id,f.directory_id,f.relative_path,f.size,f.modified_at,f.indexed_at,f.last_opened_at FROM projects p LEFT JOIN directories d ON d.project_id=p.id LEFT JOIN files f ON f.directory_id=d.id LIMIT 1").fetch_optional(pool).await.map_err(db)?;
        Ok(())
    }
    pub async fn close(&self) {
        self.pool.close().await;
    }
    pub async fn register(&self, path: &Path, name: Option<&str>) -> Result<Value> {
        let pins = lineage(path)?;
        let canonical = pins.first().ok_or_else(stale)?.path.clone();
        let path_text = canonical.to_str().ok_or_else(stale)?;
        let name = name.unwrap_or_else(|| {
            path.file_name()
                .and_then(|x| x.to_str())
                .unwrap_or("Project")
        });
        if name.is_empty() || name.len() > 256 {
            return Err(BackendError::new(
                "INVALID_REQUEST",
                "Project name must contain 1–256 bytes",
            ));
        }
        let id = hash(path_text.as_bytes());
        let project = format!("project-{id}");
        let directory = format!("directory-{id}");
        let timestamp = now();
        let mut tx = self.pool.begin().await.map_err(db)?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM directories WHERE path<>?")
            .bind(path_text)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        if count >= MAX_DIRECTORIES {
            return Err(BackendError::new(
                "CATALOG_FULL",
                "Directory registration limit reached",
            ));
        }
        sqlx::query("INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at").bind(&project).bind(name).bind(timestamp).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO directories VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at").bind(&directory).bind(&project).bind(path_text).bind(timestamp).execute(&mut *tx).await.map_err(db)?;
        if lineage(path)? != pins {
            return Err(stale());
        }
        tx.commit().await.map_err(db)?;
        self.grants
            .lock()
            .map_err(|_| stale())?
            .insert(directory.clone(), pins);
        Ok(
            json!({"project":{"id":project,"name":name,"updatedAt":timestamp},"directory":{"id":directory,"projectId":project,"path":path_text,"updatedAt":timestamp}}),
        )
    }
    pub fn validate_directory(&self, id: &str, path: &Path) -> Result<()> {
        let actual = lineage(path)?;
        if self.grants.lock().map_err(|_| stale())?.get(id) != Some(&actual) {
            return Err(stale());
        }
        Ok(())
    }
    pub fn validate_file(&self, id: &str, path: &Path) -> Result<()> {
        let root = path.parent().ok_or_else(stale)?;
        self.validate_directory(id, root)?;
        if path.file_name().is_none() {
            return Err(stale());
        }
        if let Ok(m) = fs::symlink_metadata(path)
            && (!m.is_file() || m.file_type().is_symlink())
        {
            return Err(stale());
        }
        Ok(())
    }
    /// A convenience hint for already indexed files, never filesystem authority.
    pub async fn touch(&self, id: &str, path: &Path) -> Result<()> {
        self.validate_file(id, path)?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(stale)?;
        let m = fs::symlink_metadata(path)
            .map_err(|e| BackendError::io("Cannot refresh recent file metadata", e))?;
        let modified = m
            .modified()
            .map_err(|e| BackendError::io("Cannot inspect recent file", e))?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128) as i64;
        sqlx::query("UPDATE files SET last_opened_at=?,size=?,modified_at=? WHERE directory_id=? AND relative_path=?").bind(now()).bind(m.len().min(i64::MAX as u64) as i64).bind(modified).bind(id).bind(name).execute(&self.pool).await.map_err(db)?;
        Ok(())
    }
    pub async fn list(&self) -> Result<Value> {
        let projects=sqlx::query("SELECT * FROM projects ORDER BY updated_at DESC LIMIT 32").fetch_all(&self.pool).await.map_err(db)?.iter().map(|r|json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"updatedAt":r.get::<i64,_>("updated_at")})).collect::<Vec<_>>();
        let directories=sqlx::query("SELECT * FROM directories ORDER BY updated_at DESC LIMIT 32").fetch_all(&self.pool).await.map_err(db)?.iter().map(|r|json!({"id":r.get::<String,_>("id"),"projectId":r.get::<String,_>("project_id"),"path":r.get::<String,_>("path"),"updatedAt":r.get::<i64,_>("updated_at")})).collect::<Vec<_>>();
        let files = sqlx::query("SELECT * FROM files WHERE lower(relative_path) LIKE '%.fd' ORDER BY indexed_at DESC,id LIMIT 16384")
            .fetch_all(&self.pool)
            .await
            .map_err(db)?
            .iter()
            .map(file_row)
            .collect::<Vec<_>>();
        Ok(
            json!({"projects":projects,"directories":directories,"files":files,"requiresReselection":true}),
        )
    }
    /// Called only by the serial blocking worker. No recursive traversal or document reads.
    pub async fn scan(&self, id: &str, path: &Path, cancel: &AtomicBool) -> Result<Value> {
        self.validate_directory(id, path)?;
        let mut files = Vec::new();
        let mut truncated = false;
        let entries =
            fs::read_dir(path).map_err(|e| BackendError::io("Cannot scan directory", e))?;
        for (index, entry) in entries.enumerate() {
            if cancel.load(Ordering::Acquire) {
                return Err(BackendError::new(
                    "CANCELLED",
                    "Scan cancelled before catalog commit",
                ));
            }
            if index >= MAX_SCAN_ENTRIES || files.len() >= MAX_FILES {
                truncated = true;
                break;
            }
            self.validate_directory(id, path)?;
            let entry = entry.map_err(|e| BackendError::io("Cannot read directory entry", e))?;
            let file = entry.path();
            if file
                .extension()
                .and_then(|x| x.to_str())
                .is_none_or(|x| !x.eq_ignore_ascii_case("fd"))
            {
                continue;
            }
            let m = fs::symlink_metadata(&file)
                .map_err(|e| BackendError::io("Cannot inspect indexed file", e))?;
            if !m.is_file() || m.file_type().is_symlink() {
                continue;
            }
            let relative = entry
                .file_name()
                .to_str()
                .ok_or_else(|| BackendError::new("INVALID_PATH", "Filename is not UTF-8"))?
                .to_owned();
            if relative.len() > 1024 {
                return Err(BackendError::new(
                    "INVALID_PATH",
                    "Indexed filename exceeds 1024 bytes",
                ));
            }
            let modified = m
                .modified()
                .map_err(|e| BackendError::io("Cannot read modification time", e))?
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(i64::MAX as u128) as i64;
            files.push(json!({"id":hash(format!("{id}/{relative}").as_bytes()),"directoryId":id,"relativePath":relative,"size":m.len().min(i64::MAX as u64),"modifiedAt":modified,"indexedAt":now()}));
        }
        files.sort_by(|a, b| a["relativePath"].as_str().cmp(&b["relativePath"].as_str()));
        let mut tx = self.pool.begin().await.map_err(db)?;
        let recent =
            sqlx::query("SELECT relative_path,last_opened_at FROM files WHERE directory_id=?")
                .bind(id)
                .fetch_all(&mut *tx)
                .await
                .map_err(db)?
                .into_iter()
                .map(|r| {
                    (
                        r.get::<String, _>("relative_path"),
                        r.get::<i64, _>("last_opened_at"),
                    )
                })
                .collect::<HashMap<_, _>>();
        for f in &mut files {
            f["lastOpenedAt"] = json!(
                recent
                    .get(f["relativePath"].as_str().unwrap())
                    .copied()
                    .unwrap_or(0)
            );
        }
        sqlx::query("DELETE FROM files WHERE directory_id=?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        for f in &files {
            sqlx::query("INSERT INTO files VALUES(?,?,?,?,?,?,?)")
                .bind(f["id"].as_str())
                .bind(id)
                .bind(f["relativePath"].as_str())
                .bind(f["size"].as_i64())
                .bind(f["modifiedAt"].as_i64())
                .bind(f["indexedAt"].as_i64())
                .bind(f["lastOpenedAt"].as_i64())
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        self.validate_directory(id, path)?;
        if cancel.load(Ordering::Acquire) {
            return Err(BackendError::new(
                "CANCELLED",
                "Scan cancelled before catalog commit",
            ));
        }
        tx.commit().await.map_err(db)?;
        Ok(json!({"directoryId":id,"files":files,"truncated":truncated}))
    }
}
fn file_row(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":r.get::<String,_>("id"),"directoryId":r.get::<String,_>("directory_id"),"relativePath":r.get::<String,_>("relative_path"),"size":r.get::<i64,_>("size"),"modifiedAt":r.get::<i64,_>("modified_at"),"indexedAt":r.get::<i64,_>("indexed_at"),"lastOpenedAt":r.get::<i64,_>("last_opened_at")})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn recycled_pool_connection_reinstalls_verified_page_budget() {
        let root =
            std::env::temp_dir().join(format!("forma-catalog-recycle-{}", crate::unique_id()));
        fs::create_dir(&root).unwrap();
        // macOS TMPDIR is a /var -> /private/var symlink; the grant identity
        // stores canonicalized paths, so the fixture must start resolved.
        let root = root.canonicalize().unwrap();
        let catalog = Catalog::open(&root.join("catalog.sqlite3")).await.unwrap();
        let mut connection = catalog.pool.acquire().await.unwrap();
        let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
        let expected = (MAX_CATALOG_BYTES / page_size as u64) as i64;
        let first: i64 = sqlx::query_scalar("PRAGMA max_page_count")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
        assert_eq!(first, expected);
        // Explicit close forces a fresh pool connection without a lifetime sleep.
        connection.close().await.unwrap();
        let mut replacement = catalog.pool.acquire().await.unwrap();
        let actual: i64 = sqlx::query_scalar("PRAGMA max_page_count")
            .fetch_one(&mut *replacement)
            .await
            .unwrap();
        assert_eq!(actual, expected);
        drop(replacement);
        catalog.close().await;
        fs::remove_dir_all(root).unwrap();
    }
}
