//! The desktop's durable document store. Editing remains in Rust/WASM; one
//! SQLite transaction publishes a validated snapshot, revision and retry receipt.
use crate::{BackendError, MAX_PATH_BYTES, Result, document_bytes, hash};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{
    Row, Sqlite, SqlitePool, Transaction,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const SCHEMA_VERSION: i64 = 6;
pub const MAX_DOCUMENTS: i64 = 10_000;
const MAX_REVISION: i64 = 9_007_199_254_740_991;
const HISTORY_PAGE: i64 = 1000;
// Optional, store-local metadata only. Never retain document snapshot BLOBs.
const MAX_HEADS_CACHE_BYTES: usize = 4 * 1024 * 1024;

fn sqlite_primary(error: &sqlx::Error) -> Option<i32> {
    // SQLite extended result codes retain the primary code in the low byte.
    error.as_database_error()
        .and_then(|e| e.code())
        .and_then(|code| code.parse::<i32>().ok())
        .map(|code| code & 0xff)
}
fn db(error: sqlx::Error) -> BackendError {
    // Contention is retryable; preserve the same mutationId after an uncertain
    // response so a committed receipt is replayed instead of duplicating edits.
    // SQLITE_FULL proves the statement rolled back, so it is not that uncertainty.
    let primary = sqlite_primary(&error);
    let (code, message) = if matches!(&error, sqlx::Error::PoolTimedOut) || matches!(primary, Some(5 | 6))
    {
        (
            "WORKSPACE_BUSY",
            format!("Local document transaction failed: {error}"),
        )
    } else if primary == Some(13) {
        (
            "WORKSPACE_STORAGE_FULL",
            format!("Local document storage is full; this change was not written and the last committed revision is unchanged: {error}"),
        )
    } else if matches!(primary, Some(8 | 10)) {
        // SQLITE_READONLY / SQLITE_IOERR. The statement rolled back or never
        // started. This is not a full disk, a migration failure, or a commit.
        (
            "WORKSPACE_WRITE_FAILED",
            format!("Local document storage could not be written; this change was not written and the last committed revision is unchanged: {error}"),
        )
    } else {
        (
            "WORKSPACE_ERROR",
            format!("Local document transaction failed: {error}"),
        )
    };
    BackendError::new(code, message)
}
fn migration_failure(error: BackendError) -> BackendError {
    match error.code {
        "WORKSPACE_STORAGE_FULL" | "WORKSPACE_WRITE_FAILED" | "WORKSPACE_BUSY" | "WORKSPACE_FUTURE_SCHEMA" | "WORKSPACE_MIGRATION" => error,
        _ => BackendError::new(
            "WORKSPACE_MIGRATION",
            format!(
                "Workspace upgrade did not finish; the previous schema and documents are unchanged. {}",
                error.message
            ),
        ),
    }
}
fn migration_step(error: sqlx::Error) -> BackendError {
    migration_failure(db(error))
}
fn invalid(message: &str) -> BackendError {
    BackendError::new("INVALID_REQUEST", message)
}
fn corrupt(message: &str) -> BackendError {
    BackendError::new("WORKSPACE_CORRUPT", message)
}
fn not_found() -> BackendError {
    BackendError::new(
        "WORKSPACE_NOT_FOUND",
        "Local document or revision does not exist",
    )
}
fn conflict() -> BackendError {
    BackendError::new(
        "WORKSPACE_CONFLICT",
        "The local document changed. Keep the current edits and reopen or save a copy.",
    )
}
fn validate_id(id: &str) -> Result<()> {
    if id.len() != 36
        || !id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
    {
        return Err(invalid("Document ID must be a UUID"));
    }
    Ok(())
}
fn validate_mutation(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(invalid(
            "mutationId must contain 1–128 ASCII letters, digits, hyphens or underscores",
        ));
    }
    Ok(())
}
fn validate_revision(revision: i64) -> Result<()> {
    if !(1..=MAX_REVISION).contains(&revision) {
        return Err(invalid(
            "Revision must be a positive JavaScript-safe integer",
        ));
    }
    Ok(())
}
fn now() -> Result<i64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| BackendError::new("IO_ERROR", "System clock is before the Unix epoch"))?
        .as_millis()
        .try_into()
        .map_err(|_| BackendError::new("IO_ERROR", "System clock is out of range"))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub revision: i64,
    pub hash: String,
    pub updated_at: i64,
    pub deleted: bool,
}
#[derive(Debug, Serialize)]
pub struct Opened {
    #[serde(flatten)]
    pub entry: Entry,
    pub document: Value,
}
fn entry(row: &sqlx::sqlite::SqliteRow) -> Result<Entry> {
    Ok(Entry {
        id: row.try_get("document_id").map_err(db)?,
        name: row.try_get("name").map_err(db)?,
        revision: row.try_get("revision").map_err(db)?,
        hash: row.try_get("hash").map_err(db)?,
        updated_at: row.try_get("updated_at").map_err(db)?,
        deleted: row.try_get("deleted").map_err(db)?,
    })
}
async fn opened(
    connection: &mut sqlx::SqliteConnection,
    row: &sqlx::sqlite::SqliteRow,
) -> Result<Opened> {
    let entry = entry(row)?;
    let bytes: Option<Vec<u8>> = row.try_get("snapshot").map_err(db)?;
    let bytes = bytes.ok_or_else(|| {
        BackendError::new(
            "DOCUMENT_RESOURCE_LIMIT",
            "Snapshot exceeds this session's working-memory allowance; stored bytes retained",
        )
    })?;
    let encoding: i64 = row.try_get("encoding").map_err(db)?;
    let document =
        crate::workspace_snapshot::decode(connection, &bytes, encoding, &entry.id, entry.revision)
            .await?;
    let restored = document_bytes(&document)
        .map_err(|_| corrupt("Document snapshot failed validation; stored bytes retained"))?;
    if hash(&restored) != entry.hash {
        return Err(corrupt(
            "Document snapshot hash/size mismatch; stored bytes retained",
        ));
    }
    if document["id"].as_str() != Some(entry.id.as_str())
        || document["name"].as_str() != Some(entry.name.as_str())
    {
        return Err(corrupt(
            "Document snapshot metadata mismatch; stored bytes retained",
        ));
    }
    Ok(Opened { entry, document })
}

fn prepare_database_file(path: &Path) -> Result<()> {
    if !path.is_absolute() || path.as_os_str().len() > MAX_PATH_BYTES {
        return Err(invalid(
            "Workspace requires a bounded absolute app-owned path",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| invalid("Workspace parent is missing"))?;
    if parent
        .canonicalize()
        .map_err(|e| BackendError::io("Cannot resolve workspace parent", e))?
        != parent
        || !parent.is_dir()
    {
        return Err(invalid("Workspace parent must be a canonical directory"));
    }
    // SQLite may create journal/WAL files; never follow pre-existing leaf links.
    for candidate in [
        path.to_path_buf(),
        path.with_file_name(format!(
            "{}-wal",
            path.file_name().unwrap().to_string_lossy()
        )),
        path.with_file_name(format!(
            "{}-shm",
            path.file_name().unwrap().to_string_lossy()
        )),
        path.with_file_name(format!(
            "{}-journal",
            path.file_name().unwrap().to_string_lossy()
        )),
    ] {
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
                return Err(invalid(
                    "Workspace database and journals must be regular files",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(BackendError::io("Cannot inspect workspace file", error)),
        }
    }
    let mut create = fs::OpenOptions::new();
    create.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        create.mode(0o600);
    }
    match create.open(path) {
        Ok(file) => {
            file.sync_all()
                .map_err(|e| BackendError::io("Cannot sync workspace file", e))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(BackendError::io("Cannot create private workspace", error)),
    }
    Ok(())
}

pub struct WorkspaceStore {
    pool: SqlitePool,
    heads_cache: Mutex<HeadsCache>,
}

#[derive(Default)]
struct HeadsCache {
    snapshot: Option<Arc<HeadsSnapshot>>,
    #[cfg(test)]
    work: ObserveWork,
}
struct HeadsSnapshot {
    entries: Vec<Entry>,
    hash: String,
}
impl HeadsSnapshot {
    fn retained_bytes(entries: &Vec<Entry>, hash: &String) -> Option<usize> {
        let bytes = std::mem::size_of::<Self>()
            .checked_add(2 * std::mem::size_of::<usize>())?
            .checked_add(
                entries
                    .capacity()
                    .checked_mul(std::mem::size_of::<Entry>())?,
            )?
            .checked_add(hash.capacity())?;
        entries.iter().try_fold(bytes, |bytes, entry| {
            bytes
                .checked_add(entry.id.capacity())?
                .checked_add(entry.name.capacity())?
                .checked_add(entry.hash.capacity())
        })
    }
}
#[cfg(test)]
#[derive(Clone, Debug, Default, Serialize)]
struct ObserveWork {
    list_queries: usize,
    list_rows: usize,
    cache_hits: usize,
    serializations: usize,
    hash_calls: usize,
    serialized_bytes: usize,
    cache_bytes: usize,
}
impl WorkspaceStore {
    /// The app chooses this path; it is never accepted from authored documents.
    /// Opening a corrupt, unrelated or future-version DB does not repair/reset it.
    pub async fn open(path: &Path) -> Result<Self> {
        // Filesystem metadata, creation and fsync must not block a Tokio worker,
        // including callers other than the desktop executable.
        let owned_path = path.to_path_buf();
        tokio::task::spawn_blocking(move || prepare_database_file(&owned_path))
            .await
            .map_err(|error| {
                BackendError::new(
                    "WORKSPACE_ERROR",
                    format!("Database preflight task failed: {error}"),
                )
            })??;
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(2));
        // Read-only preflight precedes journal-mode changes, including future DBs.
        let preflight = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options.clone().read_only(true))
            .await
            .map_err(|e| corrupt(&e.to_string()))?;
        let check = Self::inspect(&preflight).await;
        preflight.close().await;
        check?;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .min_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .after_connect(|connection, _| {
                Box::pin(async move {
                    sqlx::query("PRAGMA synchronous=FULL")
                        .execute(&mut *connection)
                        .await?;
                    sqlx::query("PRAGMA wal_autocheckpoint=1000")
                        .execute(&mut *connection)
                        .await?;
                    // No product-size ceiling. SQLite's own representable-page
                    // limit and actual disk errors remain authoritative; failed
                    // writes roll back under the existing immediate transaction.
                    Ok(())
                })
            })
            .connect_with(options)
            .await
            .map_err(db)?;
        let setup = async {
            Self::migrate(&pool).await?;
            let journal: String = sqlx::query_scalar("PRAGMA journal_mode=WAL")
                .fetch_one(&pool)
                .await
                .map_err(db)?;
            if !journal.eq_ignore_ascii_case("wal") {
                return Err(BackendError::new(
                    "WORKSPACE_ERROR",
                    "WAL journal mode is unavailable; workspace retained",
                ));
            }
            Ok(())
        }
        .await;
        if let Err(error) = setup {
            pool.close().await;
            return Err(error);
        }
        Ok(Self {
            pool,
            heads_cache: Mutex::new(HeadsCache::default()),
        })
    }
    async fn inspect(pool: &SqlitePool) -> Result<i64> {
        let check: String = sqlx::query_scalar("PRAGMA quick_check")
            .fetch_one(pool)
            .await
            .map_err(|e| corrupt(&e.to_string()))?;
        if check != "ok" {
            return Err(corrupt(&check));
        }
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(pool)
            .await
            .map_err(db)?;
        if !(0..=SCHEMA_VERSION).contains(&version) {
            return Err(BackendError::new(
                "WORKSPACE_FUTURE_SCHEMA",
                "Unsupported workspace schema; database retained",
            ));
        }
        if version == 0 {
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
            )
            .fetch_one(pool)
            .await
            .map_err(db)?;
            if count != 0 {
                return Err(corrupt("Unversioned nonempty database retained"));
            }
        } else {
            // Metadata is checked at startup; snapshot hashes/validation on read.
            sqlx::query("SELECT d.id,d.head_revision,r.document_id,r.revision,r.name,r.hash,length(r.snapshot),r.updated_at,r.deleted,m.mutation_id,m.request_hash,m.document_id,m.revision FROM documents d LEFT JOIN revisions r ON r.document_id=d.id AND r.revision=d.head_revision LEFT JOIN mutations m ON m.document_id=d.id LIMIT 1").fetch_optional(pool).await.map_err(|_| corrupt("Required workspace schema is missing or changed"))?;
            if version >= 2 {
                sqlx::query("SELECT r.encoding,a.hash,a.kind,length(a.value),a.byte_length,ra.asset_hash FROM revisions r LEFT JOIN revision_assets ra ON ra.document_id=r.document_id AND ra.revision=r.revision LEFT JOIN assets a ON a.hash=ra.asset_hash LIMIT 1").fetch_optional(pool).await.map_err(|_|corrupt("Required resource schema is missing or changed"))?;
            }
            if version >= 3 {
                sqlx::query("SELECT id,document_id,payload,updated_at FROM local_sessions LIMIT 1")
                    .fetch_optional(pool)
                    .await
                    .map_err(|_| corrupt("Required local session schema is missing"))?;
            }
            if version >= 4 {
                crate::automation::inspect(pool).await?;
            }
            if version >= 5 {
                crate::automation::inspect_edits(pool).await?;
            }
            let broken: i64 = sqlx::query_scalar("SELECT count(*) FROM documents d LEFT JOIN revisions r ON r.document_id=d.id AND r.revision=d.head_revision WHERE r.revision IS NULL").fetch_one(pool).await.map_err(db)?;
            if broken != 0 {
                return Err(corrupt("Workspace head references a missing revision"));
            }
            if sqlx::query("PRAGMA foreign_key_check")
                .fetch_optional(pool)
                .await
                .map_err(db)?
                .is_some()
            {
                return Err(corrupt("Workspace foreign-key integrity failed"));
            }
        }
        Ok(version)
    }
    async fn migrate(pool: &SqlitePool) -> Result<()> {
        if Self::inspect(pool).await? == SCHEMA_VERSION {
            return Ok(());
        }
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(migration_step)?;
        // Recheck under the writer lock: a second process may have just migrated.
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut *tx)
            .await
            .map_err(migration_step)?;
        if version == 0 {
            for sql in [
                "CREATE TABLE documents(id TEXT PRIMARY KEY,head_revision INTEGER NOT NULL CHECK(head_revision>0))",
                "CREATE TABLE revisions(document_id TEXT NOT NULL REFERENCES documents(id),revision INTEGER NOT NULL CHECK(revision>0),name TEXT NOT NULL,hash TEXT NOT NULL CHECK(length(hash)=64),snapshot BLOB NOT NULL,updated_at INTEGER NOT NULL,deleted INTEGER NOT NULL CHECK(deleted IN(0,1)),PRIMARY KEY(document_id,revision))",
                "CREATE TABLE mutations(mutation_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL CHECK(length(request_hash)=64),document_id TEXT NOT NULL,revision INTEGER NOT NULL,FOREIGN KEY(document_id,revision) REFERENCES revisions(document_id,revision))",
                "PRAGMA user_version=1",
            ] {
                sqlx::query(sql).execute(&mut *tx).await.map_err(migration_step)?;
            }
        } else if !(1..=SCHEMA_VERSION).contains(&version) {
            return Err(BackendError::new(
                "WORKSPACE_FUTURE_SCHEMA",
                "Workspace schema changed during migration; database retained",
            ));
        }
        if version < 2 {
            for sql in [
                "ALTER TABLE revisions ADD COLUMN encoding INTEGER NOT NULL DEFAULT 1 CHECK(encoding IN(1,2))",
                "CREATE TABLE assets(hash TEXT PRIMARY KEY CHECK(length(hash)=64),kind TEXT NOT NULL CHECK(kind IN('font','image')),value BLOB NOT NULL,byte_length INTEGER NOT NULL CHECK(byte_length>=0 AND byte_length<=33554432))",
                "CREATE TABLE revision_assets(document_id TEXT NOT NULL,revision INTEGER NOT NULL,asset_hash TEXT NOT NULL REFERENCES assets(hash),PRIMARY KEY(document_id,revision,asset_hash),FOREIGN KEY(document_id,revision) REFERENCES revisions(document_id,revision))",
                "PRAGMA user_version=2",
            ] {
                sqlx::query(sql).execute(&mut *tx).await.map_err(migration_step)?;
            }
        }
        if version < 3 {
            sqlx::query("CREATE TABLE local_sessions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,payload BLOB NOT NULL CHECK(length(payload)<=262144),updated_at INTEGER NOT NULL)").execute(&mut *tx).await.map_err(migration_step)?;
            sqlx::query(
                "CREATE INDEX local_sessions_document ON local_sessions(document_id,updated_at)",
            )
            .execute(&mut *tx)
            .await
            .map_err(migration_step)?;
            sqlx::query("PRAGMA user_version=3")
                .execute(&mut *tx)
                .await
                .map_err(migration_step)?;
        }
        if version < 4 {
            crate::automation::migrate(&mut tx).await.map_err(migration_failure)?;
            sqlx::query("PRAGMA user_version=4")
                .execute(&mut *tx)
                .await
                .map_err(migration_step)?;
        }
        if version < 5 {
            crate::automation::migrate_edits(&mut tx).await.map_err(migration_failure)?;
            sqlx::query("PRAGMA user_version=5")
                .execute(&mut *tx)
                .await
                .map_err(migration_step)?;
        }
        if version < 6 {
            for sql in [
                "CREATE TABLE assets_v6(hash TEXT PRIMARY KEY CHECK(length(hash)=64),kind TEXT NOT NULL CHECK(kind IN('font','image')),value BLOB NOT NULL,byte_length INTEGER NOT NULL CHECK(byte_length>=0 AND byte_length=length(value)))",
                "INSERT INTO assets_v6 SELECT hash,kind,value,byte_length FROM assets",
                "CREATE TABLE revision_assets_v6(document_id TEXT NOT NULL,revision INTEGER NOT NULL,asset_hash TEXT NOT NULL REFERENCES assets_v6(hash),PRIMARY KEY(document_id,revision,asset_hash),FOREIGN KEY(document_id,revision) REFERENCES revisions(document_id,revision))",
                "INSERT INTO revision_assets_v6 SELECT document_id,revision,asset_hash FROM revision_assets",
                "DROP TABLE revision_assets",
                "DROP TABLE assets",
                "ALTER TABLE assets_v6 RENAME TO assets",
                "ALTER TABLE revision_assets_v6 RENAME TO revision_assets",
                "PRAGMA user_version=6",
            ] {
                sqlx::query(sql).execute(&mut *tx).await.map_err(migration_step)?;
            }
        }
        tx.commit().await.map_err(migration_step)
    }
    pub(crate) fn automation_pool(&self) -> &SqlitePool {
        &self.pool
    }
    pub async fn close(&self) {
        self.pool.close().await;
    }
    pub async fn list(&self, include_deleted: bool) -> Result<Value> {
        Ok(json!({"documents":self.list_entries(include_deleted).await?}))
    }
    async fn list_entries(&self, include_deleted: bool) -> Result<Vec<Entry>> {
        let rows = sqlx::query("SELECT r.document_id,r.revision,r.name,r.hash,r.updated_at,r.deleted FROM documents d JOIN revisions r ON r.document_id=d.id AND r.revision=d.head_revision WHERE (? OR r.deleted=0) ORDER BY r.updated_at DESC,d.id LIMIT 10000")
            .bind(include_deleted).fetch_all(&self.pool).await.map_err(db)?;
        rows.iter().map(entry).collect()
    }
    fn observe_heads(
        &self,
        entries: Vec<Entry>,
        view_hash: &str,
    ) -> Result<(String, Option<Value>)> {
        // The complete ordered SELECT is still authoritative on every poll. Entry
        // equality covers every serialized field, including name, time and deleted.
        // This works with other processes and older writers without a schema change
        // or treating presence-only data_version changes as document changes.
        let snapshot = self
            .heads_cache
            .lock()
            .ok()
            .and_then(|cache| cache.snapshot.clone());
        let cached_hash = snapshot
            .as_ref()
            .filter(|snapshot| snapshot.entries == entries)
            .map(|snapshot| snapshot.hash.clone());
        drop(snapshot);
        if let Some(hash) = cached_hash {
            #[cfg(test)]
            if let Ok(mut cache) = self.heads_cache.lock() {
                cache.work.cache_hits += 1;
            }
            let documents = (hash != view_hash).then(|| json!(entries));
            return Ok((hash, documents));
        }

        // Preserve the existing Value representation (and its object-key order),
        // byte limit and content hash; directly serializing Vec<Entry> is different.
        let mut documents = json!({"documents":&entries});
        let bytes = crate::bounded_json(&documents, 32 * 1024 * 1024, "WORKSPACE_ERROR")?;
        let hash = hash(&bytes);
        let response = (hash != view_hash).then(|| documents["documents"].take());
        let retained_bytes = HeadsSnapshot::retained_bytes(&entries, &hash);
        let snapshot = retained_bytes
            .filter(|bytes| *bytes <= MAX_HEADS_CACHE_BYTES)
            .map(|_| {
                Arc::new(HeadsSnapshot {
                    entries,
                    hash: hash.clone(),
                })
            });
        // No mutex is held over SQL, JSON construction or hashing. Concurrent
        // publication may replace a newer snapshot with an older one, but each
        // entries/hash pair stays intact and the next exact comparison is safe.
        // A poisoned optional cache is bypassed rather than changing API behavior.
        if let Ok(mut cache) = self.heads_cache.lock() {
            #[cfg(test)]
            {
                cache.work.serializations += 1;
                cache.work.hash_calls += 1;
                cache.work.serialized_bytes += bytes.len();
                cache.work.cache_bytes = retained_bytes
                    .filter(|bytes| *bytes <= MAX_HEADS_CACHE_BYTES)
                    .unwrap_or(0);
            }
            let retired = std::mem::replace(&mut cache.snapshot, snapshot);
            drop(cache);
            drop(retired);
        }
        Ok((hash, response))
    }
    pub async fn read(&self, id: &str, revision: Option<i64>) -> Result<Opened> {
        validate_id(id)?;
        if let Some(revision) = revision {
            validate_revision(revision)?;
        }
        let mut connection = self.pool.acquire().await.map_err(db)?;
        let row = sqlx::query("SELECT r.document_id,r.revision,r.name,r.hash,r.updated_at,r.deleted,r.encoding,CASE WHEN length(r.snapshot)<=? THEN r.snapshot ELSE NULL END AS snapshot FROM revisions r JOIN documents d ON d.id=r.document_id WHERE r.document_id=? AND r.revision=COALESCE(?,d.head_revision)")
            .bind(crate::workspace_snapshot::snapshot_byte_limit() as i64).bind(id).bind(revision).fetch_optional(&mut *connection).await.map_err(db)?.ok_or_else(not_found)?;
        opened(&mut connection, &row).await
    }
    pub async fn revisions(&self, id: &str, before_revision: Option<i64>) -> Result<Value> {
        validate_id(id)?;
        if let Some(revision) = before_revision {
            validate_revision(revision)?;
        }
        if sqlx::query_scalar::<_, i64>("SELECT head_revision FROM documents WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?
            .is_none()
        {
            return Err(not_found());
        }
        let rows = sqlx::query("SELECT document_id,revision,name,hash,updated_at,deleted FROM revisions WHERE document_id=? AND (? IS NULL OR revision<?) ORDER BY revision DESC LIMIT ?")
            .bind(id).bind(before_revision).bind(before_revision).bind(HISTORY_PAGE + 1).fetch_all(&self.pool).await.map_err(db)?;
        let has_more = rows.len() > HISTORY_PAGE as usize;
        let entries = rows
            .iter()
            .take(HISTORY_PAGE as usize)
            .map(entry)
            .collect::<Result<Vec<_>>>()?;
        Ok(
            json!({"revisions":entries,"hasMore":has_more,"nextBeforeRevision":if has_more {entries.last().map(|e|e.revision)} else {None}}),
        )
    }
    async fn replay(
        tx: &mut Transaction<'_, Sqlite>,
        mutation: &str,
        request_hash: &str,
    ) -> Result<Option<Opened>> {
        let row = sqlx::query("SELECT m.request_hash,r.document_id,r.revision,r.name,r.hash,r.updated_at,r.deleted,r.encoding,CASE WHEN length(r.snapshot)<=? THEN r.snapshot ELSE NULL END AS snapshot FROM mutations m JOIN revisions r ON r.document_id=m.document_id AND r.revision=m.revision WHERE m.mutation_id=?").bind(crate::workspace_snapshot::snapshot_byte_limit() as i64).bind(mutation).fetch_optional(&mut **tx).await.map_err(db)?;
        match row {
            Some(row) if row.try_get::<String, _>("request_hash").map_err(db)? != request_hash => {
                Err(BackendError::new(
                    "WORKSPACE_MUTATION_CONFLICT",
                    "mutationId was already used for different content; retry the identical request or choose a new mutationId",
                ))
            }
            Some(row) => opened(tx, &row).await.map(Some),
            None => Ok(None),
        }
    }
    async fn head(
        tx: &mut Transaction<'_, Sqlite>,
        id: &str,
        expected: Option<i64>,
    ) -> Result<Option<Opened>> {
        let row = sqlx::query("SELECT r.document_id,r.revision,r.name,r.hash,r.updated_at,r.deleted,r.encoding,CASE WHEN length(r.snapshot)<=? THEN r.snapshot ELSE NULL END AS snapshot FROM documents d JOIN revisions r ON r.document_id=d.id AND r.revision=d.head_revision WHERE d.id=?").bind(crate::workspace_snapshot::snapshot_byte_limit() as i64).bind(id).fetch_optional(&mut **tx).await.map_err(db)?;
        let result = match row {
            Some(row) => Some(opened(tx, &row).await?),
            None => None,
        };
        if result.as_ref().map(|r| r.entry.revision) != expected {
            return Err(conflict());
        }
        Ok(result)
    }
    async fn write_revision(
        tx: &mut Transaction<'_, Sqlite>,
        document: &Value,
        bytes: &[u8],
        expected: Option<i64>,
        deleted: bool,
        mutation: &str,
        request_hash: &str,
    ) -> Result<Entry> {
        let id = document["id"]
            .as_str()
            .ok_or_else(|| invalid("Missing document ID"))?;
        let name = document["name"]
            .as_str()
            .ok_or_else(|| invalid("Missing document name"))?;
        let revision = expected
            .unwrap_or(0)
            .checked_add(1)
            .filter(|n| *n <= MAX_REVISION)
            .ok_or_else(|| {
                BackendError::new("WORKSPACE_FULL", "Document revision capacity reached")
            })?;
        let entry = Entry {
            id: id.into(),
            name: name.into(),
            revision,
            hash: hash(bytes),
            updated_at: now()?,
            deleted,
        };
        if expected.is_none() {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM documents")
                .fetch_one(&mut **tx)
                .await
                .map_err(db)?;
            if count >= MAX_DOCUMENTS {
                return Err(BackendError::new(
                    "WORKSPACE_FULL",
                    "Local document capacity reached; existing documents retained",
                ));
            }
            sqlx::query("INSERT INTO documents(id,head_revision) VALUES(?,?)")
                .bind(id)
                .bind(revision)
                .execute(&mut **tx)
                .await
                .map_err(db)?;
        } else {
            let changed =
                sqlx::query("UPDATE documents SET head_revision=? WHERE id=? AND head_revision=?")
                    .bind(revision)
                    .bind(id)
                    .bind(expected)
                    .execute(&mut **tx)
                    .await
                    .map_err(db)?
                    .rows_affected();
            if changed != 1 {
                return Err(conflict());
            }
        }
        #[cfg(test)]
        lifetime_tests::before_encode(document);
        let encoded = crate::workspace_snapshot::encode(document)?;
        for asset in encoded.assets.values() {
            let inserted = sqlx::query("INSERT INTO assets(hash,kind,value,byte_length) VALUES(?,?,?,?) ON CONFLICT(hash) DO NOTHING")
                .bind(&asset.hash).bind(asset.kind.label()).bind(asset.value.as_bytes()).bind(asset.value.len() as i64).execute(&mut **tx).await.map_err(db)?.rows_affected();
            if inserted == 0 {
                crate::workspace_snapshot::checked_asset(tx, &asset.hash, asset.kind).await?;
            }
        }
        sqlx::query("INSERT INTO revisions(document_id,revision,name,hash,snapshot,updated_at,deleted,encoding) VALUES(?,?,?,?,?,?,?,2)")
            .bind(id).bind(revision).bind(name).bind(&entry.hash).bind(&encoded.bytes).bind(entry.updated_at).bind(deleted).execute(&mut **tx).await.map_err(db)?;
        for asset in encoded.assets.values() {
            sqlx::query(
                "INSERT INTO revision_assets(document_id,revision,asset_hash) VALUES(?,?,?)",
            )
            .bind(id)
            .bind(revision)
            .bind(&asset.hash)
            .execute(&mut **tx)
            .await
            .map_err(db)?;
        }
        sqlx::query(
            "INSERT INTO mutations(mutation_id,request_hash,document_id,revision) VALUES(?,?,?,?)",
        )
        .bind(mutation)
        .bind(request_hash)
        .bind(id)
        .bind(revision)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
        Ok(entry)
    }
    /// Identify the SQLite revision for an already committed mutation. Cloud
    /// adoption uses this receipt to recover the exact local write on restart.
    pub async fn mutation_revision(&self, id: &str, mutation: &str) -> Result<Option<i64>> {
        validate_id(id)?;
        validate_mutation(mutation)?;
        sqlx::query_scalar("SELECT revision FROM mutations WHERE mutation_id=? AND document_id=?")
            .bind(mutation)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)
    }

    pub async fn commit(
        &self,
        document: &Value,
        expected: Option<i64>,
        mutation: &str,
    ) -> Result<Entry> {
        validate_mutation(mutation)?;
        if let Some(revision) = expected {
            validate_revision(revision)?;
        }
        let bytes = document_bytes(document)?;
        let id = document["id"]
            .as_str()
            .ok_or_else(|| invalid("Missing document ID"))?;
        let request_hash = hash(
            serde_json::to_string(&json!(["commit", expected, hash(&bytes)]))
                .unwrap()
                .as_bytes(),
        );
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        if let Some(replayed) = Self::replay(&mut tx, mutation, &request_hash).await? {
            tx.commit().await.map_err(db)?;
            return Ok(replayed.entry);
        }
        let old = Self::head(&mut tx, id, expected).await?;
        #[cfg(test)]
        let old = lifetime_tests::TrackedHead::new(old);
        if old.as_ref().is_some_and(|r| r.entry.deleted) {
            return Err(BackendError::new(
                "WORKSPACE_DELETED",
                "Restore this deleted document before editing it",
            ));
        }
        // The prior head was fully validated above. Do not retain its authored
        // graph while encoding the new snapshot; transaction/CAS checks stay intact.
        drop(old);
        let entry = Self::write_revision(
            &mut tx,
            document,
            &bytes,
            expected,
            false,
            mutation,
            &request_hash,
        )
        .await?;
        tx.commit().await.map_err(db)?;
        Ok(entry)
    }
    pub async fn trash(
        &self,
        id: &str,
        expected: i64,
        mutation: &str,
        deleted: bool,
    ) -> Result<Entry> {
        validate_id(id)?;
        validate_revision(expected)?;
        validate_mutation(mutation)?;
        let request_hash = hash(
            serde_json::to_string(&json!(["trash", id, expected, deleted]))
                .unwrap()
                .as_bytes(),
        );
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        if let Some(replayed) = Self::replay(&mut tx, mutation, &request_hash).await? {
            tx.commit().await.map_err(db)?;
            return Ok(replayed.entry);
        }
        let old = Self::head(&mut tx, id, Some(expected))
            .await?
            .ok_or_else(not_found)?;
        let bytes = document_bytes(&old.document)?;
        let entry = Self::write_revision(
            &mut tx,
            &old.document,
            &bytes,
            Some(expected),
            deleted,
            mutation,
            &request_hash,
        )
        .await?;
        tx.commit().await.map_err(db)?;
        Ok(entry)
    }
    pub async fn restore(
        &self,
        id: &str,
        revision: i64,
        expected: i64,
        mutation: &str,
    ) -> Result<Opened> {
        validate_id(id)?;
        validate_revision(revision)?;
        validate_revision(expected)?;
        validate_mutation(mutation)?;
        let request_hash = hash(
            serde_json::to_string(&json!(["restore", id, revision, expected]))
                .unwrap()
                .as_bytes(),
        );
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        if let Some(replayed) = Self::replay(&mut tx, mutation, &request_hash).await? {
            tx.commit().await.map_err(db)?;
            return Ok(replayed);
        }
        Self::head(&mut tx, id, Some(expected))
            .await?
            .ok_or_else(not_found)?;
        let row = sqlx::query("SELECT document_id,revision,name,hash,updated_at,deleted,encoding,CASE WHEN length(snapshot)<=? THEN snapshot ELSE NULL END AS snapshot FROM revisions WHERE document_id=? AND revision=?")
            .bind(crate::workspace_snapshot::snapshot_byte_limit() as i64).bind(id)
            .bind(revision)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or_else(not_found)?;
        let source = opened(&mut tx, &row).await?;
        let bytes = document_bytes(&source.document)?;
        let entry = Self::write_revision(
            &mut tx,
            &source.document,
            &bytes,
            Some(expected),
            false,
            mutation,
            &request_hash,
        )
        .await?;
        tx.commit().await.map_err(db)?;
        Ok(Opened {
            entry,
            document: source.document,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalPresence {
    pub id: String,
    pub name: String,
    pub document_id: String,
    pub page_id: String,
    pub view: [f64; 3],
    pub cursor: Option<[f64; 2]>,
    pub selection: Vec<String>,
}
impl WorkspaceStore {
    /// A local subscription: no cloud endpoint, credentials or shared global DB.
    pub async fn observe(
        &self,
        control: futureox_design_kernel::protocol::Envelope,
        presence: LocalPresence,
    ) -> Result<Value> {
        use futureox_design_kernel::protocol::Envelope;
        let Envelope::Subscribe {
            view_name,
            view_hash,
        } = control
        else {
            return Err(invalid("Expected a subscription"));
        };
        if view_name != "workspace" || view_hash.len() > 128 {
            return Err(invalid("Unknown local view"));
        }
        for id in [&presence.id, &presence.document_id, &presence.page_id] {
            validate_id(id)?
        }
        if presence.name.is_empty()
            || presence.name.len() > 200
            || presence.selection.len() > 1000
            || presence
                .view
                .iter()
                .any(|n| !n.is_finite() || n.abs() > 1e9)
            || !(0.001..=1000.).contains(&presence.view[2])
            || presence
                .cursor
                .is_some_and(|p| p.iter().any(|n| !n.is_finite() || n.abs() > 1e9))
        {
            return Err(invalid("Invalid local presence"));
        }
        for id in &presence.selection {
            validate_id(id)?
        }
        let time = now()?;
        let bytes = crate::bounded_json(&presence, 256 * 1024, "INVALID_REQUEST")?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        sqlx::query("DELETE FROM local_sessions WHERE updated_at < ?")
            .bind(time - 15000)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM local_sessions WHERE id != ?")
            .bind(&presence.id)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        if count >= 64 {
            return Err(invalid("Local window limit reached"));
        }
        sqlx::query("INSERT INTO local_sessions(id,document_id,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET document_id=excluded.document_id,payload=excluded.payload,updated_at=excluded.updated_at").bind(&presence.id).bind(&presence.document_id).bind(bytes).bind(time).execute(&mut *tx).await.map_err(db)?;
        let rows = sqlx::query(
            "SELECT payload FROM local_sessions WHERE id!=? AND document_id=? ORDER BY id",
        )
        .bind(&presence.id)
        .bind(&presence.document_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db)?;
        let peers = rows
            .iter()
            .map(|r| {
                let bytes: Vec<u8> = r.try_get("payload").map_err(db)?;
                serde_json::from_slice::<LocalPresence>(&bytes)
                    .map_err(|_| corrupt("Invalid local session"))
            })
            .collect::<Result<Vec<_>>>()?;
        tx.commit().await.map_err(db)?;
        let entries = self.list_entries(false).await?;
        #[cfg(test)]
        if let Ok(mut cache) = self.heads_cache.lock() {
            cache.work.list_queries += 1;
            cache.work.list_rows += entries.len();
        }
        let (hash, documents) = self.observe_heads(entries, &view_hash)?;
        let changed = hash != view_hash;
        // Bind the existing presence/control envelope vocabulary to actual local data.
        let session = u64::from(
            u32::from_str_radix(&presence.id[..8], 16).map_err(|_| invalid("Invalid session"))?,
        );
        Ok(
            json!({"viewHash":hash,"changed":changed,"control":Envelope::ViewLoaded{view_name},"presenceControl":Envelope::Presence{session},"peers":peers,"documents":documents}),
        )
    }
    pub async fn leave_session(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        sqlx::query("DELETE FROM local_sessions WHERE id=?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }
}

#[cfg(test)]
mod autosave_recovery_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    const ID: &str = "10000000-0000-0000-0000-0000000000a1";

    fn document(name: &str) -> Value {
        json!({
            "schemaVersion": 6,
            "id": ID,
            "name": name,
            "pages": [{
                "id": "10000000-0000-0000-0000-0000000000a2",
                "name": "Page",
                "background": "#ffffff",
                "children": []
            }],
            "nodes": {}
        })
    }

    #[tokio::test]
    async fn autosave_recovery_sqlite_storage_full_keeps_last_commit() {
        static N: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "futureox-sqlite-full-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let db = root.join("workspace.sqlite3");
        let store = WorkspaceStore::open(&db).await.unwrap();
        let saved = store.commit(&document("consistent"), None, "create-full").await.unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE page_fill(payload BLOB NOT NULL)")
            .execute(&store.pool)
            .await
            .unwrap();
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode=DELETE")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        let pages_before: i64 = sqlx::query_scalar("PRAGMA page_count")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        // Clamp to the current file. Further page allocation is SQLITE_FULL.
        let applied: i64 = sqlx::query_scalar("PRAGMA max_page_count=1")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        let mut fills = 0u32;
        let mut fill_error = String::new();
        loop {
            match sqlx::query("INSERT INTO page_fill(payload) VALUES (zeroblob(32))")
                .execute(&store.pool)
                .await
            {
                Ok(_) => {
                    fills += 1;
                    if fills > 20000 {
                        break;
                    }
                }
                Err(error) => {
                    fill_error = error.to_string();
                    break;
                }
            }
        }
        let mut bulky = document("must-not-commit");
        bulky["pages"][0]["name"] = json!("p".repeat(9000));
        let error = store
            .commit(&bulky, Some(saved.revision), "edit-full")
            .await;
        eprintln!(
            "MEASURE sqlite_storage_full journal_mode={mode} pages_before={pages_before} max_page_count={applied} fill_rows={fills} fill_error={fill_error} status={}",
            error.as_ref().map(|entry| format!("ok revision={}", entry.revision)).unwrap_or_else(|error| format!("error {}: {}", error.code, error.message))
        );
        let error = error.expect_err("a full database must not report the new revision as saved");
        assert_eq!(error.code, "WORKSPACE_STORAGE_FULL");
        assert_ne!(error.code, "WORKSPACE_MIGRATION");
        assert!(!error.message.contains("saved"));
        assert!(error.message.contains("not written") || error.message.contains("unchanged"));
        let current = store.read(ID, None).await.unwrap();
        assert_eq!(current.entry.revision, saved.revision);
        assert_eq!(current.entry.hash, saved.hash);
        assert_eq!(current.document["name"], "consistent");
        store.close().await;
        let reopened = WorkspaceStore::open(&db).await.unwrap();
        let current = reopened.read(ID, None).await.unwrap();
        assert_eq!(current.entry.revision, saved.revision);
        assert_eq!(current.document, document("consistent"));
        reopened.close().await;
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn autosave_recovery_sqlite_readonly_is_not_saved() {
        static N: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "futureox-sqlite-ro-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let db = root.join("workspace.sqlite3");
        let store = WorkspaceStore::open(&db).await.unwrap();
        let saved = store
            .commit(&document("consistent"), None, "create-ro")
            .await
            .unwrap();
        store.close().await;
        let mut paths = vec![db.clone()];
        for suffix in ["-wal", "-shm", "-journal"] {
            let extra = PathBuf::from(format!("{}{suffix}", db.display()));
            if extra.exists() {
                paths.push(extra);
            }
        }
        let saved_permissions: Vec<_> = paths
            .iter()
            .map(|path| (path.clone(), fs::metadata(path).unwrap().permissions()))
            .collect();
        for path in &paths {
            let mut readonly = fs::metadata(path).unwrap().permissions();
            readonly.set_readonly(true);
            fs::set_permissions(path, readonly).unwrap();
        }
        let opened = WorkspaceStore::open(&db).await;
        let error = match opened {
            Ok(store) => {
                let error = store
                    .commit(
                        &document("must-not-commit"),
                        Some(saved.revision),
                        "edit-ro",
                    )
                    .await
                    .expect_err("a read-only database must not report the edit as saved");
                store.close().await;
                error
            }
            Err(error) => error,
        };
        eprintln!(
            "MEASURE sqlite_readonly status=error {}: {}",
            error.code, error.message
        );
        for (path, permissions) in &saved_permissions {
            fs::set_permissions(path, permissions.clone()).unwrap();
        }
        assert_eq!(error.code, "WORKSPACE_WRITE_FAILED");
        assert_ne!(error.code, "WORKSPACE_STORAGE_FULL");
        assert_ne!(error.code, "WORKSPACE_MIGRATION");
        assert_ne!(error.code, "WORKSPACE_CORRUPT");
        assert!(error.message.contains("not written"));
        assert!(error.message.contains("unchanged"));
        assert!(!error.message.contains("saved"));
        let reopened = WorkspaceStore::open(&db).await.unwrap();
        let current = reopened.read(ID, None).await.unwrap();
        assert_eq!(current.entry.revision, saved.revision);
        assert_eq!(current.entry.hash, saved.hash);
        assert_eq!(current.document, document("consistent"));
        reopened.close().await;
        let _ = fs::remove_dir_all(&root);
    }

}

#[cfg(test)]
#[path = "workspace_observe_tests.rs"]
mod observe_tests;

#[cfg(test)]
#[path = "workspace_lifetime_tests.rs"]
mod lifetime_tests;
