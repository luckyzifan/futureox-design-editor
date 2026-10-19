use futureox_design_desktop_backend::{Backend, protocol, workspace::WorkspaceStore};
use serde_json::{Value, json};
use sqlx::{Connection, Executor, sqlite::SqliteConnection};
use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "futureox-automation-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        Self(p.canonicalize().unwrap())
    }
    fn db(&self) -> PathBuf {
        self.0.join("workspace.sqlite3")
    }
    async fn backend(&self) -> Arc<Backend> {
        Arc::new(
            Backend::new(&self.0.join("recovery"))
                .unwrap()
                .with_workspace(WorkspaceStore::open(&self.db()).await.unwrap()),
        )
    }
    async fn connection(&self) -> SqliteConnection {
        SqliteConnection::connect(&format!("sqlite://{}", self.db().display()))
            .await
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
async fn request(backend: &Arc<Backend>, method: &str, params: Value) -> protocol::Response {
    let backend = backend.clone();
    let frame = serde_json::to_vec(&json!({"id":"test","method":method,"params":params})).unwrap();
    tokio::task::spawn_blocking(move || protocol::handle_frame(&backend, &frame))
        .await
        .unwrap()
}
async fn ok(backend: &Arc<Backend>, method: &str, params: Value) -> Value {
    let response = request(backend, method, params).await;
    assert!(response.error.is_none(), "{response:?}");
    response.result.unwrap()
}
fn audit(index: usize) -> Value {
    json!({"event":"execute","method":"document.read","requestId":format!("request-{index}"),"documentId":"10000000-0000-0000-0000-000000000001","session":1,"revision":2,"status":"succeeded","durationMs":3,"scope":"read"})
}
fn task(id: &str, status: &str) -> Value {
    json!({"id":id,"method":"document.read","documentId":"10000000-0000-0000-0000-000000000001","session":1,"revision":2,"status":status,"scope":"read"})
}

#[tokio::test]
async fn defaults_and_metadata_survive_restart_without_persisting_authorization() {
    let f = Fixture::new();
    let backend = f.backend().await;
    let status = ok(&backend, "automation.status", json!({})).await;
    assert_eq!(status["config"]["preferredScope"], "read");
    assert_eq!(status["config"]["maxAuditEntries"], 1000);
    assert_eq!(status["authorizationPersisted"], false);
    ok(
        &backend,
        "automation.config.set",
        json!({"preferredScope":"write","retentionDays":14,"maxAuditEntries":200}),
    )
    .await;
    ok(&backend, "automation.audit.append", audit(1)).await;
    ok(&backend, "automation.task.put", task("one", "completed")).await;
    backend.close_stores().await;
    drop(backend);
    let backend = f.backend().await;
    let status = ok(&backend, "automation.status", json!({})).await;
    assert_eq!(status["config"]["preferredScope"], "write");
    assert_eq!(status["auditCount"], 1);
    assert_eq!(status["taskCount"], 1);
    assert_eq!(status["authorizationPersisted"], false);
    assert!(status.get("endpoint").is_none());
    assert!(status.get("token").is_none());
    backend.close_stores().await;
}

#[tokio::test]
async fn unknown_fields_paths_and_unbounded_metadata_are_rejected_without_echoing_secrets() {
    let f = Fixture::new();
    let backend = f.backend().await;
    for field in [
        "token", "endpoint", "prompt", "params", "result", "path", "message",
    ] {
        let mut input = audit(1);
        input[field] = json!("VERY_PRIVATE_SENTINEL");
        let response = request(&backend, "automation.audit.append", input).await;
        assert_eq!(response.error.as_ref().unwrap().code, "INVALID_REQUEST");
        assert!(!format!("{response:?}").contains("VERY_PRIVATE_SENTINEL"));
    }
    for (field, value) in [
        ("method", json!("x".repeat(101))),
        ("requestId", json!("/tmp/private")),
        ("documentId", json!("document\nsecret")),
        ("session", json!(-1)),
        ("revision", json!(9_007_199_254_740_992_i64)),
        ("durationMs", json!(86_400_001)),
        ("code", json!("raw error text")),
        ("scope", json!("admin")),
        ("status", json!("done")),
    ] {
        let mut input = audit(1);
        input[field] = value;
        assert_eq!(
            request(&backend, "automation.audit.append", input)
                .await
                .error
                .unwrap()
                .code,
            "INVALID_REQUEST"
        );
    }
    for input in [
        json!({"retentionDays":0}),
        json!({"retentionDays":91}),
        json!({"maxAuditEntries":10001}),
        json!({"maxAuditEntries":99}),
        json!({"autoEnable":true}),
        json!({"token":"SECRET"}),
    ] {
        assert_eq!(
            request(&backend, "automation.config.set", input)
                .await
                .error
                .unwrap()
                .code,
            "INVALID_REQUEST"
        );
    }
    assert_eq!(
        ok(&backend, "automation.status", json!({})).await["auditCount"],
        0
    );
    backend.close_stores().await;
    assert!(!String::from_utf8_lossy(&fs::read(f.db()).unwrap()).contains("VERY_PRIVATE_SENTINEL"));
}

#[tokio::test]
async fn audit_cap_cursor_pagination_and_disable_are_enforced() {
    let f = Fixture::new();
    let backend = f.backend().await;
    ok(
        &backend,
        "automation.config.set",
        json!({"maxAuditEntries":100}),
    )
    .await;
    for i in 0..125 {
        ok(&backend, "automation.audit.append", audit(i)).await;
    }
    assert_eq!(
        ok(&backend, "automation.status", json!({})).await["auditCount"],
        100
    );
    let first = ok(&backend, "automation.audit.list", json!({"limit":33})).await;
    assert_eq!(first["entries"].as_array().unwrap().len(), 33);
    assert_eq!(first["entries"][0]["requestId"], "request-124");
    let next = ok(
        &backend,
        "automation.audit.list",
        json!({"limit":100,"beforeId":first["nextBeforeId"]}),
    )
    .await;
    assert_eq!(next["entries"].as_array().unwrap().len(), 67);
    assert_eq!(next["hasMore"], false);
    assert_eq!(next["nextBeforeId"], Value::Null);
    ok(
        &backend,
        "automation.config.set",
        json!({"auditEnabled":false}),
    )
    .await;
    assert_eq!(
        ok(&backend, "automation.audit.append", audit(126)).await,
        json!({"recorded":false})
    );
    assert_eq!(
        ok(&backend, "automation.status", json!({})).await["auditCount"],
        100
    );
    assert_eq!(
        request(&backend, "automation.audit.list", json!({"limit":101}))
            .await
            .error
            .unwrap()
            .code,
        "INVALID_REQUEST"
    );
    backend.close_stores().await;
}

#[tokio::test]
async fn retention_removes_only_old_metadata_and_keeps_active_task_records() {
    let f = Fixture::new();
    let backend = f.backend().await;
    ok(&backend, "automation.audit.append", audit(1)).await;
    ok(
        &backend,
        "automation.task.put",
        task("finished", "completed"),
    )
    .await;
    ok(&backend, "automation.task.put", task("active", "running")).await;
    let mut conn = f.connection().await;
    conn.execute("UPDATE automation_audit SET created_at=0")
        .await
        .unwrap();
    conn.execute("UPDATE automation_tasks SET updated_at=0")
        .await
        .unwrap();
    conn.close().await.unwrap();
    ok(
        &backend,
        "automation.config.set",
        json!({"retentionDays":1}),
    )
    .await;
    let status = ok(&backend, "automation.status", json!({})).await;
    assert_eq!(status["auditCount"], 0);
    assert_eq!(status["taskCount"], 1);
    assert_eq!(
        ok(&backend, "automation.task.list", json!({})).await["tasks"][0]["id"],
        "active"
    );
    backend.close_stores().await;
}

#[tokio::test]
async fn task_target_is_immutable_and_terminal_outcome_cannot_restart() {
    let f = Fixture::new();
    let backend = f.backend().await;
    let created = ok(&backend, "automation.task.put", task("one", "running")).await;
    ok(&backend, "automation.task.put", task("one", "needs_input")).await;
    ok(&backend, "automation.task.put", task("one", "running")).await;
    let mut changed = task("one", "running");
    changed["method"] = json!("document.write");
    assert_eq!(
        request(&backend, "automation.task.put", changed)
            .await
            .error
            .unwrap()
            .code,
        "AUTOMATION_CONFLICT"
    );
    let completed = ok(&backend, "automation.task.put", task("one", "completed")).await;
    assert_eq!(completed["task"]["createdAt"], created["task"]["createdAt"]);
    assert_eq!(
        request(&backend, "automation.task.put", task("one", "running"))
            .await
            .error
            .unwrap()
            .code,
        "AUTOMATION_CONFLICT"
    );
    let mut forbidden = task("two", "queued");
    forbidden["prompt"] = json!("secret");
    assert_eq!(
        request(&backend, "automation.task.put", forbidden)
            .await
            .error
            .unwrap()
            .code,
        "INVALID_REQUEST"
    );
    backend.close_stores().await;
}

#[tokio::test]
async fn tasks_are_bounded_and_active_records_are_never_evicted() {
    let f = Fixture::new();
    let backend = f.backend().await;
    for i in 0..256 {
        ok(
            &backend,
            "automation.task.put",
            task(&format!("task-{i:03}"), "running"),
        )
        .await;
    }
    assert_eq!(
        request(&backend, "automation.task.put", task("overflow", "running"))
            .await
            .error
            .unwrap()
            .code,
        "AUTOMATION_LIMIT"
    );
    ok(
        &backend,
        "automation.task.put",
        task("task-000", "completed"),
    )
    .await;
    ok(
        &backend,
        "automation.task.put",
        task("replacement", "queued"),
    )
    .await;
    let list = ok(&backend, "automation.task.list", json!({"limit":256})).await;
    assert_eq!(list["tasks"].as_array().unwrap().len(), 256);
    assert!(
        !list["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == "task-000")
    );
    assert_eq!(
        request(&backend, "automation.task.list", json!({"limit":257}))
            .await
            .error
            .unwrap()
            .code,
        "INVALID_REQUEST"
    );
    backend.close_stores().await;
}

#[tokio::test]
async fn v3_migration_preserves_existing_document_and_is_idempotent() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let id = "10000000-0000-0000-0000-000000000001";
    let document = json!({"schemaVersion":6,"id":id,"name":"Preserved","pages":[{"id":"10000000-0000-0000-0000-000000000002","name":"Page","background":"#ffffff","children":[]}],"nodes":{}});
    store.commit(&document, None, "create-1").await.unwrap();
    store.close().await;
    let mut conn = f.connection().await;
    for sql in [
        "DROP TABLE automation_tasks",
        "DROP TABLE automation_audit",
        "DROP TABLE automation_config",
        "PRAGMA user_version=3",
    ] {
        conn.execute(sql).await.unwrap();
    }
    conn.close().await.unwrap();
    for _ in 0..2 {
        let store = WorkspaceStore::open(&f.db()).await.unwrap();
        assert_eq!(store.read(id, None).await.unwrap().document, document);
        store.close().await;
    }
    let mut conn = f.connection().await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA user_version")
            .fetch_one(&mut conn)
            .await
            .unwrap(),
        5
    );
    conn.close().await.unwrap();
}

#[tokio::test]
async fn failed_v3_migration_rolls_back_new_tables_and_keeps_prior_database() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    store.close().await;
    let mut conn = f.connection().await;
    for sql in [
        "DROP TABLE automation_tasks",
        "DROP TABLE automation_audit",
        "DROP TABLE automation_config",
        "CREATE TABLE automation_audit(marker TEXT)",
        "INSERT INTO automation_audit VALUES('keep-existing')",
        "PRAGMA user_version=3",
    ] {
        conn.execute(sql).await.unwrap();
    }
    conn.close().await.unwrap();
    assert!(WorkspaceStore::open(&f.db()).await.is_err());
    let mut conn = f.connection().await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA user_version")
            .fetch_one(&mut conn)
            .await
            .unwrap(),
        3
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT marker FROM automation_audit")
            .fetch_one(&mut conn)
            .await
            .unwrap(),
        "keep-existing"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM sqlite_master WHERE name='automation_config'"
        )
        .fetch_one(&mut conn)
        .await
        .unwrap(),
        0
    );
    conn.close().await.unwrap();
}

#[tokio::test]
async fn unavailable_workspace_is_explicit_and_does_not_fallback_to_json_files() {
    let f = Fixture::new();
    let backend = Arc::new(Backend::new(&f.0.join("recovery")).unwrap());
    assert_eq!(
        request(&backend, "automation.status", json!({}))
            .await
            .error
            .unwrap()
            .code,
        "WORKSPACE_UNAVAILABLE"
    );
    assert!(!f.db().exists());
}

fn edit(source: &str, document_id: &str, revision: i64) -> Value {
    json!({"event":"edit","source":source,"summary":"调整布局 · 3 个节点","documentId":document_id,"session":1,"revision":revision,"status":"succeeded"})
}

#[tokio::test]
async fn edit_history_persists_sources_and_filters_with_stable_pagination() {
    let f = Fixture::new();
    let backend = f.backend().await;
    for (source, doc, rev) in [
        ("user", "doc-one", 1),
        ("automation", "doc-one", 2),
        ("user", "doc-two", 1),
        ("user", "doc-one", 3),
    ] {
        ok(&backend, "automation.audit.append", edit(source, doc, rev)).await;
    }
    let first = ok(
        &backend,
        "automation.audit.list",
        json!({"documentId":"doc-one","source":"user","limit":1}),
    )
    .await;
    assert_eq!(first["entries"][0]["revision"], 3);
    assert_eq!(first["entries"][0]["summary"], "调整布局 · 3 个节点");
    assert_eq!(first["hasMore"], true);
    let second = ok(
        &backend,
        "automation.audit.list",
        json!({"documentId":"doc-one","source":"user","limit":1,"beforeId":first["nextBeforeId"]}),
    )
    .await;
    assert_eq!(second["entries"][0]["revision"], 1);
    assert_eq!(second["hasMore"], false);
    assert_eq!(second["nextBeforeId"], Value::Null);
    backend.close_stores().await;
    drop(backend);
    let backend = f.backend().await;
    let automated = ok(
        &backend,
        "automation.audit.list",
        json!({"source":"automation"}),
    )
    .await;
    assert_eq!(automated["entries"].as_array().unwrap().len(), 1);
    assert_eq!(automated["entries"][0]["event"], "edit");
    assert_eq!(automated["entries"][0]["documentId"], "doc-one");
    backend.close_stores().await;
}

#[tokio::test]
async fn edit_history_rejects_missing_identity_content_and_invalid_filters() {
    let f = Fixture::new();
    let backend = f.backend().await;
    for missing in ["source", "documentId", "session", "revision"] {
        let mut value = edit("user", "doc-one", 1);
        value.as_object_mut().unwrap().remove(missing);
        assert_eq!(
            request(&backend, "automation.audit.append", value)
                .await
                .error
                .unwrap()
                .code,
            "INVALID_REQUEST"
        );
    }
    for (key, value) in [
        ("source", json!("other")),
        ("summary", json!("字".repeat(201))),
        ("summary", json!("line\ncontent")),
        ("summary", json!("")),
        ("payload", json!({"secret":"PRIVATE_SENTINEL"})),
    ] {
        let mut entry = edit("user", "doc-one", 1);
        entry[key] = value;
        let response = request(&backend, "automation.audit.append", entry).await;
        assert_eq!(response.error.as_ref().unwrap().code, "INVALID_REQUEST");
        assert!(!format!("{response:?}").contains("PRIVATE_SENTINEL"));
    }
    let mut maximal = edit("user", "doc-one", 1);
    maximal["summary"] = json!("字".repeat(200));
    ok(&backend, "automation.audit.append", maximal).await;
    for query in [
        json!({"source":"other"}),
        json!({"documentId":"/tmp/path"}),
        json!({"documentId":"x' OR 1=1"}),
        json!({"summary":"unexpected"}),
    ] {
        assert_eq!(
            request(&backend, "automation.audit.list", query)
                .await
                .error
                .unwrap()
                .code,
            "INVALID_REQUEST"
        );
    }
    backend.close_stores().await;
}

async fn downgrade_audit_to_v4(connection: &mut SqliteConnection) {
    for sql in [
        "CREATE TABLE automation_audit_v4(id INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL CHECK(event IN('grant','revoke','execute')),method TEXT,request_id TEXT,document_id TEXT,session INTEGER,revision INTEGER,status TEXT NOT NULL,code TEXT,duration_ms INTEGER,scope TEXT,created_at INTEGER NOT NULL)",
        "INSERT INTO automation_audit_v4 SELECT id,event,method,request_id,document_id,session,revision,status,code,duration_ms,scope,created_at FROM automation_audit",
        "DROP TABLE automation_audit",
        "ALTER TABLE automation_audit_v4 RENAME TO automation_audit",
        "CREATE INDEX automation_audit_time ON automation_audit(created_at)",
        "UPDATE sqlite_sequence SET seq=42 WHERE name='automation_audit'",
        "PRAGMA user_version=4",
    ] {
        connection.execute(sql).await.unwrap();
    }
}

#[tokio::test]
async fn v4_migration_preserves_legacy_rows_and_cursor_sequence_even_when_empty() {
    for empty in [false, true] {
        let f = Fixture::new();
        let backend = f.backend().await;
        ok(&backend, "automation.audit.append", audit(1)).await;
        backend.close_stores().await;
        drop(backend);
        let mut connection = f.connection().await;
        downgrade_audit_to_v4(&mut connection).await;
        if empty {
            connection
                .execute("DELETE FROM automation_audit")
                .await
                .unwrap();
        }
        connection.close().await.unwrap();
        let backend = f.backend().await;
        let old = ok(&backend, "automation.audit.list", json!({})).await;
        assert_eq!(
            old["entries"].as_array().unwrap().len(),
            usize::from(!empty)
        );
        if !empty {
            assert_eq!(old["entries"][0]["id"], 1);
            assert_eq!(old["entries"][0]["source"], Value::Null);
            assert_eq!(old["entries"][0]["summary"], Value::Null);
        }
        let added = ok(
            &backend,
            "automation.audit.append",
            edit("user", "doc-one", 1),
        )
        .await;
        assert_eq!(added["id"], 43);
        backend.close_stores().await;
        let mut connection = f.connection().await;
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA user_version")
                .fetch_one(&mut connection)
                .await
                .unwrap(),
            5
        );
        connection.close().await.unwrap();
    }
}

#[tokio::test]
async fn failed_v4_migration_retains_all_prior_rows_and_schema() {
    let f = Fixture::new();
    let backend = f.backend().await;
    ok(&backend, "automation.audit.append", audit(1)).await;
    backend.close_stores().await;
    drop(backend);
    let mut connection = f.connection().await;
    downgrade_audit_to_v4(&mut connection).await;
    connection
        .execute("CREATE TABLE automation_audit_v5(marker TEXT)")
        .await
        .unwrap();
    connection
        .execute("INSERT INTO automation_audit_v5 VALUES('keep-existing')")
        .await
        .unwrap();
    connection.close().await.unwrap();
    assert!(WorkspaceStore::open(&f.db()).await.is_err());
    let mut connection = f.connection().await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA user_version")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        4
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM automation_audit")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT marker FROM automation_audit_v5")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        "keep-existing"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT seq FROM sqlite_sequence WHERE name='automation_audit'"
        )
        .fetch_one(&mut connection)
        .await
        .unwrap(),
        42
    );
    connection.close().await.unwrap();
}
