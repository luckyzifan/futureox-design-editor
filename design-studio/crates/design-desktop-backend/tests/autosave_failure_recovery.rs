//! Cloud acceptance for autosave crash, storage failure, reopen and migration.
//! These are simulated faults against the desktop backend. They do not exercise
//! a signed release installer, and they are not a confirmed data-loss report.
use futureox_design_desktop_backend::{workspace::WorkspaceStore, Backend};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor, sqlite::SqliteConnection};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "futureox-autosave-recovery-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
    fn db(&self) -> PathBuf {
        self.0.join("workspace.sqlite3")
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

const ID: &str = "10000000-0000-0000-0000-000000000001";

fn document(name: &str) -> Value {
    json!({"schemaVersion":6,"id":ID,"name":name,
        "pages":[{"id":"10000000-0000-0000-0000-000000000002","name":"Page","background":"#ffffff","children":[]}],
        "nodes":{}})
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[tokio::test]
async fn autosave_recovery_uncommitted_exit_reopens_last_commit() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let first = store
        .commit(&document("consistent"), None, "create-1")
        .await
        .unwrap();
    store.close().await;

    let mut connection = f.connection().await;
    connection.execute("BEGIN IMMEDIATE").await.unwrap();
    connection
        .execute("UPDATE documents SET head_revision=2 WHERE id='10000000-0000-0000-0000-000000000001'")
        .await
        .unwrap();
    drop(connection);

    let reopened = WorkspaceStore::open(&f.db()).await.unwrap();
    let current = reopened.read(ID, None).await.unwrap();
    assert_eq!(current.entry.revision, 1);
    assert_eq!(current.entry.hash, first.hash);
    assert_eq!(current.document, document("consistent"));
    assert_eq!(
        reopened.read(ID, Some(2)).await.unwrap_err().code,
        "WORKSPACE_NOT_FOUND"
    );
    reopened.close().await;
}

#[tokio::test]
async fn autosave_recovery_conflict_is_not_reported_saved() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    store
        .commit(&document("consistent"), None, "create-1")
        .await
        .unwrap();
    let mut edited = document("edited");
    let saved = store
        .commit(&edited, Some(1), "edit-2")
        .await
        .unwrap();
    edited["name"] = json!("rejected");
    let error = store
        .commit(&edited, Some(1), "stale-3")
        .await
        .unwrap_err();
    assert_eq!(error.code, "WORKSPACE_CONFLICT");
    assert!(!error.message.contains("File saved"));
    assert!(!error.message.contains("saved"));
    let current = store.read(ID, None).await.unwrap();
    assert_eq!(current.entry.revision, saved.revision);
    assert_eq!(current.document["name"], "edited");
    store.close().await;
    let reopened = WorkspaceStore::open(&f.db()).await.unwrap();
    assert_eq!(reopened.read(ID, None).await.unwrap().document["name"], "edited");
    reopened.close().await;
}

#[tokio::test]
async fn autosave_recovery_failed_upgrade_keeps_prior_schema_then_retries() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let saved = store
        .commit(&document("before-upgrade"), None, "before-upgrade")
        .await
        .unwrap();
    store.close().await;
    let mut connection = f.connection().await;
    connection
        .execute("CREATE TABLE assets_v6(blocked TEXT)")
        .await
        .unwrap();
    connection.execute("PRAGMA user_version=5").await.unwrap();
    connection.close().await.unwrap();

    let error = WorkspaceStore::open(&f.db()).await.err().expect("blocked migration must fail");
    assert_eq!(error.code, "WORKSPACE_ERROR");
    assert!(!error.message.contains("File saved"));
    let mut connection = f.connection().await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA user_version")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        5
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM documents")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        1
    );
    connection
        .execute("DROP TABLE assets_v6")
        .await
        .unwrap();
    connection.close().await.unwrap();

    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let current = store.read(ID, None).await.unwrap();
    assert_eq!(current.document, document("before-upgrade"));
    assert_eq!(current.entry.hash, saved.hash);
    let mut connection = f.connection().await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA user_version")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        futureox_design_desktop_backend::workspace::SCHEMA_VERSION
    );
    connection.close().await.unwrap();
    store.close().await;
}

#[test]
fn autosave_recovery_readonly_and_leftover_temp_keep_import_and_recovery() {
    let f = Fixture::new();
    let backend = Backend::new(&f.0.join("recovery")).unwrap();
    let import = f.0.join("original-import.fig");
    let import_bytes = b"user-import-bytes-must-stay";
    fs::write(&import, import_bytes).unwrap();
    let import_hash = sha256(import_bytes);
    let working = f.0.join("working-copy.fd");
    let original = document("imported");
    let saved = backend.save(&working, &original, None).unwrap();
    assert!(saved.warning.is_none());
    let mut edited = document("unsaved edit");
    backend
        .recovery_write(
            "session-1",
            &edited,
            import.to_str(),
            Some(&import_hash),
        )
        .unwrap();
    fs::write(f.0.join(".fd-write-crashed.tmp"), b"partial replacement").unwrap();
    fs::set_permissions(&working, fs::Permissions::from_mode(0o444)).unwrap();
    edited["name"] = json!("must not replace");
    let error = backend
        .save(&working, &edited, Some(&saved.hash))
        .unwrap_err();
    assert_eq!(error.code, "READ_ONLY");
    assert!(!error.message.contains("File saved"));
    assert_eq!(fs::read(&import).unwrap(), import_bytes);
    assert_eq!(backend.open(&working).unwrap().document, original);
    assert_eq!(fs::read(f.0.join(".fd-write-crashed.tmp")).unwrap(), b"partial replacement");

    let reopened = Backend::new(&f.0.join("recovery")).unwrap();
    let restored = reopened.recovery_read("session-1").unwrap();
    assert_eq!(restored.document["name"], "unsaved edit");
    assert_eq!(reopened.open(&working).unwrap().hash, saved.hash);
    assert_eq!(fs::read(&import).unwrap(), import_bytes);
}
