//! Bounded automation metadata in the existing private workspace database.
//! Never stores capabilities, endpoints, prompts, parameters, results or paths.
//! This is history/configuration, not an authorization or execution engine.
use crate::{BackendError, Result, workspace::WorkspaceStore};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection, SqlitePool};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_AUDIT_ENTRIES: i64 = 10_000;
pub const MAX_TASKS: i64 = 256;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const DAY_MS: i64 = 86_400_000;

fn invalid() -> BackendError {
    BackendError::new(
        "INVALID_REQUEST",
        "Invalid automation metadata; only bounded allowlisted fields are accepted",
    )
}
fn db(_: sqlx::Error) -> BackendError {
    // Do not expose database paths or SQL values in errors.
    BackendError::new(
        "AUTOMATION_STORAGE_ERROR",
        "Automation metadata could not be stored or read; existing data retained",
    )
}
fn parse<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| invalid())
}
fn now() -> Result<i64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .ok_or_else(|| BackendError::new("IO_ERROR", "System clock is outside the supported range"))
}
fn identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
}
fn method_name(value: &str) -> bool {
    value.len() <= 100
        && value.contains('.')
        && value.split('.').all(|s| {
            !s.is_empty()
                && s.as_bytes()[0].is_ascii_alphabetic()
                && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        })
}
fn safe_number(value: Option<i64>, max: i64) -> bool {
    value.is_none_or(|n| (0..=max).contains(&n))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub audit_enabled: bool,
    pub retention_days: i64,
    pub max_audit_entries: i64,
    pub preferred_scope: String,
    pub updated_at: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigPatch {
    audit_enabled: Option<bool>,
    retention_days: Option<i64>,
    max_audit_entries: Option<i64>,
    preferred_scope: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metadata {
    pub method: Option<String>,
    pub request_id: Option<String>,
    pub document_id: Option<String>,
    pub session: Option<i64>,
    pub revision: Option<i64>,
    pub code: Option<String>,
    pub duration_ms: Option<i64>,
    pub scope: Option<String>,
}
impl Metadata {
    fn validate(&self) -> Result<()> {
        if self.method.as_deref().is_some_and(|v| !method_name(v))
            || self
                .request_id
                .as_deref()
                .is_some_and(|v| !identifier(v, 128))
            || self
                .document_id
                .as_deref()
                .is_some_and(|v| !identifier(v, 256))
            || self.code.as_deref().is_some_and(|v| {
                v.is_empty()
                    || v.len() > 64
                    || !v
                        .bytes()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
            })
            || self
                .scope
                .as_deref()
                .is_some_and(|v| !matches!(v, "read" | "write"))
            || !safe_number(self.session, MAX_SAFE_INTEGER)
            || !safe_number(self.revision, MAX_SAFE_INTEGER)
            || !safe_number(self.duration_ms, DAY_MS)
        {
            return Err(invalid());
        }
        Ok(())
    }
}
// Explicit fields instead of serde(flatten): deny_unknown_fields must reject
// accidental token/prompt/params additions, including on otherwise valid data.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuditInput {
    event: String,
    source: Option<String>,
    summary: Option<String>,
    method: Option<String>,
    request_id: Option<String>,
    document_id: Option<String>,
    session: Option<i64>,
    revision: Option<i64>,
    status: String,
    code: Option<String>,
    duration_ms: Option<i64>,
    scope: Option<String>,
}
impl AuditInput {
    fn metadata(&self) -> Metadata {
        Metadata {
            method: self.method.clone(),
            request_id: self.request_id.clone(),
            document_id: self.document_id.clone(),
            session: self.session,
            revision: self.revision,
            code: self.code.clone(),
            duration_ms: self.duration_ms,
            scope: self.scope.clone(),
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuditList {
    limit: Option<i64>,
    before_id: Option<i64>,
    document_id: Option<String>,
    source: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskInput {
    id: String,
    method: String,
    document_id: Option<String>,
    session: Option<i64>,
    revision: Option<i64>,
    status: String,
    code: Option<String>,
    duration_ms: Option<i64>,
    scope: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskList {
    limit: Option<i64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

pub(crate) async fn migrate(connection: &mut SqliteConnection) -> Result<()> {
    for sql in [
        "CREATE TABLE automation_config(id INTEGER PRIMARY KEY CHECK(id=1),audit_enabled INTEGER NOT NULL CHECK(audit_enabled IN(0,1)),retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 90),max_audit_entries INTEGER NOT NULL CHECK(max_audit_entries BETWEEN 100 AND 10000),preferred_scope TEXT NOT NULL CHECK(preferred_scope IN('read','write')),updated_at INTEGER NOT NULL)",
        "INSERT INTO automation_config VALUES(1,1,30,1000,'read',0)",
        "CREATE TABLE automation_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL CHECK(event IN('grant','revoke','execute')),method TEXT CHECK(length(method)<=100),request_id TEXT CHECK(length(request_id)<=128),document_id TEXT CHECK(length(document_id)<=256),session INTEGER,revision INTEGER,status TEXT NOT NULL CHECK(status IN('succeeded','failed','cancelled','unknown')),code TEXT CHECK(length(code)<=64),duration_ms INTEGER CHECK(duration_ms BETWEEN 0 AND 86400000),scope TEXT CHECK(scope IN('read','write')),created_at INTEGER NOT NULL)",
        "CREATE INDEX automation_audit_time ON automation_audit(created_at)",
        "CREATE TABLE automation_tasks(id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),method TEXT NOT NULL CHECK(length(method)<=100),document_id TEXT CHECK(length(document_id)<=256),session INTEGER,revision INTEGER,status TEXT NOT NULL CHECK(status IN('queued','running','needs_input','completed','failed','cancelled','interrupted')),code TEXT CHECK(length(code)<=64),duration_ms INTEGER CHECK(duration_ms BETWEEN 0 AND 86400000),scope TEXT CHECK(scope IN('read','write')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
        "CREATE INDEX automation_tasks_time ON automation_tasks(updated_at,id)",
    ] {
        sqlx::query(sql)
            .execute(&mut *connection)
            .await
            .map_err(db)?;
    }
    Ok(())
}
/// Runs inside the workspace migration transaction and preserves cursor IDs,
/// including the AUTOINCREMENT high-water mark of an empty, pruned audit.
pub(crate) async fn migrate_edits(connection: &mut SqliteConnection) -> Result<()> {
    for sql in [
        "CREATE TABLE automation_audit_v5(id INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL CHECK(event IN('grant','revoke','execute','edit')),method TEXT CHECK(length(method)<=100),request_id TEXT CHECK(length(request_id)<=128),document_id TEXT CHECK(length(document_id)<=256),session INTEGER,revision INTEGER,status TEXT NOT NULL CHECK(status IN('succeeded','failed','cancelled','unknown')),code TEXT CHECK(length(code)<=64),duration_ms INTEGER CHECK(duration_ms BETWEEN 0 AND 86400000),scope TEXT CHECK(scope IN('read','write')),created_at INTEGER NOT NULL,source TEXT CHECK(source IN('user','automation')),summary TEXT CHECK(length(summary)<=200))",
        "INSERT INTO automation_audit_v5(id,event,method,request_id,document_id,session,revision,status,code,duration_ms,scope,created_at) SELECT id,event,method,request_id,document_id,session,revision,status,code,duration_ms,scope,created_at FROM automation_audit",
        "INSERT INTO sqlite_sequence(name,seq) SELECT 'automation_audit_v5',COALESCE((SELECT seq FROM sqlite_sequence WHERE name='automation_audit'),0) WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='automation_audit_v5')",
        "UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='automation_audit'),0)) WHERE name='automation_audit_v5'",
        "DROP TABLE automation_audit",
        "ALTER TABLE automation_audit_v5 RENAME TO automation_audit",
        "CREATE INDEX automation_audit_time ON automation_audit(created_at)",
        "CREATE INDEX automation_audit_document_source ON automation_audit(document_id,source,id DESC)",
    ] {
        sqlx::query(sql)
            .execute(&mut *connection)
            .await
            .map_err(db)?;
    }
    Ok(())
}
pub(crate) async fn inspect_edits(pool: &SqlitePool) -> Result<()> {
    sqlx::query("SELECT source,summary FROM automation_audit LIMIT 1")
        .fetch_optional(pool)
        .await
        .map_err(|_| {
            BackendError::new(
                "WORKSPACE_CORRUPT",
                "Required edit history schema is missing; database retained",
            )
        })?;
    Ok(())
}
pub(crate) async fn inspect(pool: &SqlitePool) -> Result<()> {
    for sql in [
        "SELECT id,audit_enabled,retention_days,max_audit_entries,preferred_scope,updated_at FROM automation_config WHERE id=1",
        "SELECT id,event,method,request_id,document_id,session,revision,status,code,duration_ms,scope,created_at FROM automation_audit LIMIT 1",
        "SELECT id,method,document_id,session,revision,status,code,duration_ms,scope,created_at,updated_at FROM automation_tasks LIMIT 1",
    ] {
        sqlx::query(sql).fetch_optional(pool).await.map_err(|_| {
            BackendError::new(
                "WORKSPACE_CORRUPT",
                "Required automation metadata schema is missing; database retained",
            )
        })?;
    }
    let config = read_config(&mut *pool.acquire().await.map_err(db)?).await?;
    validate_config(&config)?;
    Ok(())
}
fn validate_config(config: &Config) -> Result<()> {
    if !(1..=90).contains(&config.retention_days)
        || !(100..=MAX_AUDIT_ENTRIES).contains(&config.max_audit_entries)
        || !matches!(config.preferred_scope.as_str(), "read" | "write")
    {
        return Err(invalid());
    }
    Ok(())
}
async fn read_config(connection: &mut SqliteConnection) -> Result<Config> {
    let row = sqlx::query("SELECT audit_enabled,retention_days,max_audit_entries,preferred_scope,updated_at FROM automation_config WHERE id=1").fetch_one(connection).await.map_err(db)?;
    Ok(Config {
        audit_enabled: row.try_get("audit_enabled").map_err(db)?,
        retention_days: row.try_get("retention_days").map_err(db)?,
        max_audit_entries: row.try_get("max_audit_entries").map_err(db)?,
        preferred_scope: row.try_get("preferred_scope").map_err(db)?,
        updated_at: row.try_get("updated_at").map_err(db)?,
    })
}
async fn prune(connection: &mut SqliteConnection, config: &Config, timestamp: i64) -> Result<()> {
    let cutoff = timestamp.saturating_sub(config.retention_days * DAY_MS);
    sqlx::query("DELETE FROM automation_audit WHERE created_at<?")
        .bind(cutoff)
        .execute(&mut *connection)
        .await
        .map_err(db)?;
    sqlx::query("DELETE FROM automation_audit WHERE id NOT IN(SELECT id FROM automation_audit ORDER BY id DESC LIMIT ?)").bind(config.max_audit_entries).execute(&mut *connection).await.map_err(db)?;
    sqlx::query("DELETE FROM automation_tasks WHERE status IN('completed','failed','cancelled','interrupted') AND updated_at<?").bind(cutoff).execute(&mut *connection).await.map_err(db)?;
    Ok(())
}
fn audit_row(row: &sqlx::sqlite::SqliteRow) -> Result<Value> {
    Ok(
        json!({"source":row.try_get::<Option<String>,_>("source").map_err(db)?,"summary":row.try_get::<Option<String>,_>("summary").map_err(db)?,"id":row.try_get::<i64,_>("id").map_err(db)?,"event":row.try_get::<String,_>("event").map_err(db)?,"method":row.try_get::<Option<String>,_>("method").map_err(db)?,"requestId":row.try_get::<Option<String>,_>("request_id").map_err(db)?,"documentId":row.try_get::<Option<String>,_>("document_id").map_err(db)?,"session":row.try_get::<Option<i64>,_>("session").map_err(db)?,"revision":row.try_get::<Option<i64>,_>("revision").map_err(db)?,"status":row.try_get::<String,_>("status").map_err(db)?,"code":row.try_get::<Option<String>,_>("code").map_err(db)?,"durationMs":row.try_get::<Option<i64>,_>("duration_ms").map_err(db)?,"scope":row.try_get::<Option<String>,_>("scope").map_err(db)?,"createdAt":row.try_get::<i64,_>("created_at").map_err(db)?}),
    )
}
fn task_row(row: &sqlx::sqlite::SqliteRow) -> Result<Value> {
    Ok(
        json!({"id":row.try_get::<String,_>("id").map_err(db)?,"method":row.try_get::<String,_>("method").map_err(db)?,"documentId":row.try_get::<Option<String>,_>("document_id").map_err(db)?,"session":row.try_get::<Option<i64>,_>("session").map_err(db)?,"revision":row.try_get::<Option<i64>,_>("revision").map_err(db)?,"status":row.try_get::<String,_>("status").map_err(db)?,"code":row.try_get::<Option<String>,_>("code").map_err(db)?,"durationMs":row.try_get::<Option<i64>,_>("duration_ms").map_err(db)?,"scope":row.try_get::<Option<String>,_>("scope").map_err(db)?,"createdAt":row.try_get::<i64,_>("created_at").map_err(db)?,"updatedAt":row.try_get::<i64,_>("updated_at").map_err(db)?}),
    )
}
fn terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "interrupted")
}

pub(crate) async fn dispatch(store: &WorkspaceStore, method: &str, params: Value) -> Result<Value> {
    let pool = store.automation_pool();
    match method {
        "automation.config.get" | "automation.status" => {
            parse::<Empty>(params)?;
            let mut connection = pool.acquire().await.map_err(db)?;
            let config = read_config(&mut connection).await?;
            if method == "automation.config.get" {
                return Ok(json!(config));
            }
            let audit_count: i64 = sqlx::query_scalar("SELECT count(*) FROM automation_audit")
                .fetch_one(&mut *connection)
                .await
                .map_err(db)?;
            let task_count: i64 = sqlx::query_scalar("SELECT count(*) FROM automation_tasks")
                .fetch_one(&mut *connection)
                .await
                .map_err(db)?;
            Ok(
                json!({"available":true,"config":config,"auditCount":audit_count,"taskCount":task_count,"limits":{"maxAuditEntries":MAX_AUDIT_ENTRIES,"maxTasks":MAX_TASKS,"maxAuditPage":100},"authorizationPersisted":false}),
            )
        }
        "automation.config.set" => {
            let input: ConfigPatch = parse(params)?;
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
            let mut config = read_config(&mut tx).await?;
            if let Some(value) = input.audit_enabled {
                config.audit_enabled = value;
            }
            if let Some(value) = input.retention_days {
                config.retention_days = value;
            }
            if let Some(value) = input.max_audit_entries {
                config.max_audit_entries = value;
            }
            if let Some(value) = input.preferred_scope {
                config.preferred_scope = value;
            }
            validate_config(&config)?;
            config.updated_at = now()?;
            sqlx::query("UPDATE automation_config SET audit_enabled=?,retention_days=?,max_audit_entries=?,preferred_scope=?,updated_at=? WHERE id=1").bind(config.audit_enabled).bind(config.retention_days).bind(config.max_audit_entries).bind(&config.preferred_scope).bind(config.updated_at).execute(&mut *tx).await.map_err(db)?;
            prune(&mut tx, &config, config.updated_at).await?;
            tx.commit().await.map_err(db)?;
            Ok(json!(config))
        }
        "automation.audit.append" => {
            let input: AuditInput = parse(params)?;
            input.metadata().validate()?;
            if !matches!(
                input.event.as_str(),
                "grant" | "revoke" | "execute" | "edit"
            ) || !matches!(
                input.status.as_str(),
                "succeeded" | "failed" | "cancelled" | "unknown"
            ) || (input.event == "execute" && input.method.is_none())
                || input
                    .source
                    .as_deref()
                    .is_some_and(|v| !matches!(v, "user" | "automation"))
                || input.summary.as_deref().is_some_and(|v| {
                    v.is_empty() || v.chars().count() > 200 || v.chars().any(char::is_control)
                })
                || (input.event == "edit"
                    && (input.source.is_none()
                        || input.document_id.is_none()
                        || input.session.is_none()
                        || input.revision.is_none()))
            {
                return Err(invalid());
            }
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
            let config = read_config(&mut tx).await?;
            let timestamp = now()?;
            if !config.audit_enabled {
                prune(&mut tx, &config, timestamp).await?;
                tx.commit().await.map_err(db)?;
                return Ok(json!({"recorded":false}));
            }
            let result = sqlx::query("INSERT INTO automation_audit(event,method,request_id,document_id,session,revision,status,code,duration_ms,scope,created_at,source,summary) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(input.event).bind(input.method).bind(input.request_id).bind(input.document_id).bind(input.session).bind(input.revision).bind(input.status).bind(input.code).bind(input.duration_ms).bind(input.scope).bind(timestamp).bind(input.source).bind(input.summary).execute(&mut *tx).await.map_err(db)?;
            prune(&mut tx, &config, timestamp).await?;
            tx.commit().await.map_err(db)?;
            Ok(json!({"recorded":true,"id":result.last_insert_rowid()}))
        }
        "automation.audit.list" => {
            let input: AuditList = parse(params)?;
            let limit = input.limit.unwrap_or(50);
            if !(1..=100).contains(&limit)
                || input.before_id.is_some_and(|v| v < 1)
                || input
                    .document_id
                    .as_deref()
                    .is_some_and(|v| !identifier(v, 256))
                || input
                    .source
                    .as_deref()
                    .is_some_and(|v| !matches!(v, "user" | "automation"))
            {
                return Err(invalid());
            }
            let rows = sqlx::query(
                "SELECT * FROM automation_audit WHERE (? IS NULL OR id<?) AND (? IS NULL OR document_id=?) AND (? IS NULL OR source=?) ORDER BY id DESC LIMIT ?",
            )
            .bind(input.before_id)
            .bind(input.before_id)
            .bind(&input.document_id)
            .bind(&input.document_id)
            .bind(&input.source)
            .bind(&input.source)
            .bind(limit + 1)
            .fetch_all(pool)
            .await
            .map_err(db)?;
            let has_more = rows.len() > limit as usize;
            let entries = rows
                .iter()
                .take(limit as usize)
                .map(audit_row)
                .collect::<Result<Vec<_>>>()?;
            let next = if has_more {
                entries.last().and_then(|e| e["id"].as_i64())
            } else {
                None
            };
            Ok(json!({"entries":entries,"hasMore":has_more,"nextBeforeId":next}))
        }
        "automation.task.put" => {
            let input: TaskInput = parse(params)?;
            Metadata {
                method: Some(input.method.clone()),
                request_id: None,
                document_id: input.document_id.clone(),
                session: input.session,
                revision: input.revision,
                code: input.code.clone(),
                duration_ms: input.duration_ms,
                scope: input.scope.clone(),
            }
            .validate()?;
            if !identifier(&input.id, 128)
                || !(matches!(input.status.as_str(), "queued" | "running" | "needs_input")
                    || terminal(&input.status))
            {
                return Err(invalid());
            }
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
            let config = read_config(&mut tx).await?;
            let timestamp = now()?;
            prune(&mut tx, &config, timestamp).await?;
            let old = sqlx::query("SELECT * FROM automation_tasks WHERE id=?")
                .bind(&input.id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?;
            if let Some(old) = &old {
                if old.try_get::<String, _>("method").map_err(db)? != input.method
                    || old
                        .try_get::<Option<String>, _>("document_id")
                        .map_err(db)?
                        != input.document_id
                    || old.try_get::<Option<i64>, _>("session").map_err(db)? != input.session
                    || old.try_get::<Option<String>, _>("scope").map_err(db)? != input.scope
                {
                    return Err(BackendError::new(
                        "AUTOMATION_CONFLICT",
                        "A task ID cannot be reused for a different target or method",
                    ));
                }
                let status: String = old.try_get("status").map_err(db)?;
                if terminal(&status) && status != input.status {
                    return Err(BackendError::new(
                        "AUTOMATION_CONFLICT",
                        "A terminal task cannot restart or change outcome",
                    ));
                }
            } else {
                let count: i64 = sqlx::query_scalar("SELECT count(*) FROM automation_tasks")
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(db)?;
                if count >= MAX_TASKS {
                    let remove = count - MAX_TASKS + 1;
                    sqlx::query("DELETE FROM automation_tasks WHERE id IN(SELECT id FROM automation_tasks WHERE status IN('completed','failed','cancelled','interrupted') ORDER BY updated_at,id LIMIT ?)").bind(remove).execute(&mut *tx).await.map_err(db)?;
                    let remaining: i64 =
                        sqlx::query_scalar("SELECT count(*) FROM automation_tasks")
                            .fetch_one(&mut *tx)
                            .await
                            .map_err(db)?;
                    if remaining >= MAX_TASKS {
                        return Err(BackendError::new(
                            "AUTOMATION_LIMIT",
                            "Active task metadata limit reached; existing tasks retained",
                        ));
                    }
                }
            }
            sqlx::query("INSERT INTO automation_tasks(id,method,document_id,session,revision,status,code,duration_ms,scope,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status,code=excluded.code,duration_ms=excluded.duration_ms,updated_at=excluded.updated_at").bind(&input.id).bind(&input.method).bind(&input.document_id).bind(input.session).bind(input.revision).bind(&input.status).bind(&input.code).bind(input.duration_ms).bind(&input.scope).bind(timestamp).bind(timestamp).execute(&mut *tx).await.map_err(db)?;
            let row = sqlx::query("SELECT * FROM automation_tasks WHERE id=?")
                .bind(&input.id)
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
            let task = task_row(&row)?;
            tx.commit().await.map_err(db)?;
            Ok(json!({"task":task}))
        }
        "automation.task.list" => {
            let input: TaskList = parse(params)?;
            let limit = input.limit.unwrap_or(50);
            if !(1..=MAX_TASKS).contains(&limit) {
                return Err(invalid());
            }
            let rows =
                sqlx::query("SELECT * FROM automation_tasks ORDER BY updated_at DESC,id LIMIT ?")
                    .bind(limit + 1)
                    .fetch_all(pool)
                    .await
                    .map_err(db)?;
            let tasks = rows
                .iter()
                .take(limit as usize)
                .map(task_row)
                .collect::<Result<Vec<_>>>()?;
            Ok(json!({"tasks":tasks,"hasMore":rows.len()>limit as usize}))
        }
        _ => Err(BackendError::new(
            "UNKNOWN_METHOD",
            "Unknown automation metadata method",
        )),
    }
}
