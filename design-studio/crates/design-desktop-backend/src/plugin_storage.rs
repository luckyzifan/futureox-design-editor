//! Local plugin preferences. The desktop main process owns scope admission.
//! The worker validates byte/key quotas and applies one key operation atomically.
use crate::{BackendError, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{
    QueryBuilder, SqliteConnection, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{path::Path, time::Duration};

const APPLICATION_ID: i64 = 0x46585053;
const STORAGE_BYTES: usize = 5 * 1024 * 1024;
const STORAGE_KEYS: i64 = 10_000;
const DATABASE_BYTES: i64 = 256 * 1024 * 1024;

fn invalid(message: &str) -> BackendError {
    BackendError::new("PLUGIN_STORAGE_INVALID", message)
}

fn limit() -> BackendError {
    BackendError::new("PLUGIN_STORAGE_LIMIT", "Plugin storage quota exceeded")
}

fn database(error: sqlx::Error) -> BackendError {
    let code = error.as_database_error().and_then(|error| error.code());
    match code
        .as_deref()
        .and_then(|code| code.parse::<i32>().ok())
        .map(|code| code & 255)
    {
        Some(5 | 6) => BackendError::new("PLUGIN_STORAGE_BUSY", "Plugin storage is busy"),
        Some(13) => limit(),
        _ => BackendError::new("PLUGIN_STORAGE_FAILED", "Plugin storage is unavailable"),
    }
}

async fn storage_schema(connection: &mut SqliteConnection) -> Result<bool> {
    let application: i64 = sqlx::query_scalar("PRAGMA application_id")
        .fetch_one(&mut *connection)
        .await
        .map_err(database)?;
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut *connection)
        .await
        .map_err(database)?;
    if application == APPLICATION_ID && version == 1 {
        return Ok(true);
    }
    if application == 0 && version == 0 {
        let objects: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
                .fetch_one(&mut *connection)
                .await
                .map_err(database)?;
        if objects == 0 {
            return Ok(false);
        }
    }
    Err(BackendError::new(
        "PLUGIN_STORAGE_FAILED",
        "Unsupported plugin storage database. Its contents were retained.",
    ))
}

/// The wire key is lowercase hex over UTF-16 code units. This retains keys
/// containing isolated surrogates and gives Rust the same UTF-8 quota as JS.
fn key_bytes(key: &str) -> Result<usize> {
    if key.is_empty()
        || key.len() > 800
        || !key.len().is_multiple_of(4)
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid("Invalid plugin storage key"));
    }
    let code_units = key.as_bytes().chunks_exact(4).map(|bytes| {
        u16::from_str_radix(std::str::from_utf8(bytes).expect("checked hex"), 16)
            .expect("checked hex")
    });
    let decoded: String = char::decode_utf16(code_units)
        .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect();
    if decoded.bytes().any(|byte| byte < 0x20)
        || matches!(decoded.as_str(), "__proto__" | "constructor" | "prototype")
    {
        return Err(invalid("Invalid plugin storage key"));
    }
    Ok(decoded.len())
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Entry {
    Json {
        json: String,
    },
    Undefined,
    Bytes {
        raw_bytes: usize,
        parts: Vec<String>,
    },
}

impl Entry {
    fn cost(&self) -> Result<usize> {
        match self {
            // This is a raw serialization of a guest value. The renderer
            // does JSON admission, including JS's escaped UTF-16 strings.
            Self::Json { json } if !json.is_empty() && json.len() <= STORAGE_BYTES => {
                Ok(json.len())
            }
            Self::Json { .. } => Err(limit()),
            Self::Undefined => Ok(0),
            Self::Bytes { raw_bytes, parts } => {
                if *raw_bytes > STORAGE_BYTES || parts.is_empty() || parts.len() > 48 {
                    return Err(limit());
                }
                let mut length = 0;
                for part in parts {
                    if part.len() > 200_000 {
                        return Err(limit());
                    }
                    length += STANDARD
                        .decode(part)
                        .map_err(|_| invalid("Invalid plugin storage bytes"))?
                        .len();
                    if length > *raw_bytes {
                        return Err(invalid("Incorrect plugin storage byte length"));
                    }
                }
                if length != *raw_bytes {
                    return Err(invalid("Incorrect plugin storage byte length"));
                }
                Ok(length)
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Operation {
    Get { key: String },
    Keys,
    Set { key: String, value: Entry },
    Delete { key: String },
}

pub struct PluginStorage {
    pool: SqlitePool,
}

impl PluginStorage {
    pub async fn open(path: &Path) -> Result<Self> {
        let path_owned = path.to_owned();
        tokio::task::spawn_blocking(move || crate::workspace::prepare_database_file(&path_owned))
            .await
            .map_err(|_| invalid("Could not prepare plugin storage"))?
            .map_err(|_| invalid("Could not prepare plugin storage"))?;
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false)
            .busy_timeout(Duration::from_secs(2));
        let preflight = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options.clone().read_only(true))
            .await
            .map_err(database)?;
        let mut reader = preflight.acquire().await.map_err(database)?;
        let checked = storage_schema(&mut reader).await;
        drop(reader);
        preflight.close().await;
        checked?;

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .min_connections(1)
            .acquire_timeout(Duration::from_secs(4))
            .after_connect(|connection, _| {
                Box::pin(async move {
                    sqlx::query("PRAGMA synchronous=FULL")
                        .execute(&mut *connection)
                        .await?;
                    let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
                        .fetch_one(&mut *connection)
                        .await?;
                    QueryBuilder::new("PRAGMA max_page_count=")
                        .push(DATABASE_BYTES / page_size)
                        .build()
                        .execute(&mut *connection)
                        .await?;
                    Ok(())
                })
            })
            .connect_with(options)
            .await
            .map_err(database)?;
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(database)?;
        if !storage_schema(&mut tx).await? {
            sqlx::query("CREATE TABLE plugin_values (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, cost INTEGER NOT NULL CHECK(cost >= 0), PRIMARY KEY(scope, key)) WITHOUT ROWID")
                .execute(&mut *tx).await.map_err(database)?;
            QueryBuilder::new("PRAGMA application_id=")
                .push(APPLICATION_ID)
                .build()
                .execute(&mut *tx)
                .await
                .map_err(database)?;
            sqlx::query("PRAGMA user_version=1")
                .execute(&mut *tx)
                .await
                .map_err(database)?;
        }
        tx.commit().await.map_err(database)?;
        let journal: String = sqlx::query_scalar("PRAGMA journal_mode=WAL")
            .fetch_one(&pool)
            .await
            .map_err(database)?;
        if !journal.eq_ignore_ascii_case("wal") {
            return Err(BackendError::new(
                "PLUGIN_STORAGE_FAILED",
                "Plugin storage requires WAL",
            ));
        }
        Ok(Self { pool })
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub(crate) async fn perform(&self, scope: &str, op: Operation, write: bool) -> Result<Value> {
        if scope.len() != 64
            || !scope
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(invalid("Invalid plugin storage scope"));
        }
        match (op, write) {
            (Operation::Get { key }, false) => {
                key_bytes(&key)?;
                let value: Option<String> = sqlx::query_scalar(
                    "SELECT value FROM plugin_values WHERE scope = ? AND key = ?",
                )
                .bind(scope)
                .bind(key)
                .fetch_optional(&self.pool)
                .await
                .map_err(database)?;
                value.map_or(Ok(Value::Null), |value| {
                    serde_json::from_str::<Entry>(&value)
                        .map(|entry| json!(entry))
                        .map_err(|_| invalid("Invalid stored plugin value"))
                })
            }
            (Operation::Keys, false) => {
                let keys: Vec<String> = sqlx::query_scalar(
                    "SELECT key FROM plugin_values WHERE scope = ? ORDER BY key",
                )
                .bind(scope)
                .fetch_all(&self.pool)
                .await
                .map_err(database)?;
                Ok(json!(keys))
            }
            (Operation::Delete { key }, true) => {
                key_bytes(&key)?;
                sqlx::query("DELETE FROM plugin_values WHERE scope = ? AND key = ?")
                    .bind(scope)
                    .bind(key)
                    .execute(&self.pool)
                    .await
                    .map_err(database)?;
                Ok(Value::Null)
            }
            (Operation::Set { key, value }, true) => {
                let cost = (key_bytes(&key)? + value.cost()?) as i64;
                let serialized = serde_json::to_string(&value)
                    .map_err(|_| invalid("Invalid plugin storage value"))?;
                let mut tx = self
                    .pool
                    .begin_with("BEGIN IMMEDIATE")
                    .await
                    .map_err(database)?;
                let (count, total): (i64, i64) = sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(cost), 0) FROM plugin_values WHERE scope = ? AND key != ?")
                    .bind(scope).bind(&key).fetch_one(&mut *tx).await.map_err(database)?;
                if count >= STORAGE_KEYS || total.saturating_add(cost) > STORAGE_BYTES as i64 {
                    return Err(limit());
                }
                sqlx::query("INSERT INTO plugin_values(scope, key, value, cost) VALUES(?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value=excluded.value, cost=excluded.cost")
                    .bind(scope).bind(key).bind(serialized).bind(cost).execute(&mut *tx).await.map_err(database)?;
                tx.commit().await.map_err(database)?;
                Ok(Value::Null)
            }
            _ => Err(invalid("Invalid plugin storage operation")),
        }
    }
}
