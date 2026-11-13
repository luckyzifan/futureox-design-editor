//! Cloud acceptance for autosave crash, storage failure, reopen and migration.
//! These are simulated faults against the desktop backend. They do not exercise
//! a signed release installer, and they are not a confirmed data-loss report.
use futureox_design_desktop_backend::{Backend, workspace::WorkspaceStore};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor, sqlite::SqliteConnection};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

struct Fixture(PathBuf);

struct RestorePermissions {
    path: PathBuf,
    permissions: fs::Permissions,
}
impl Drop for RestorePermissions {
    fn drop(&mut self) {
        let _ = fs::set_permissions(&self.path, self.permissions.clone());
    }
}
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
        .execute(
            "UPDATE documents SET head_revision=2 WHERE id='10000000-0000-0000-0000-000000000001'",
        )
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
    let saved = store.commit(&edited, Some(1), "edit-2").await.unwrap();
    edited["name"] = json!("rejected");
    let error = store.commit(&edited, Some(1), "stale-3").await.unwrap_err();
    assert_eq!(error.code, "WORKSPACE_CONFLICT");
    assert!(!error.message.contains("File saved"));
    assert!(!error.message.contains("saved"));
    let current = store.read(ID, None).await.unwrap();
    assert_eq!(current.entry.revision, saved.revision);
    assert_eq!(current.document["name"], "edited");
    store.close().await;
    let reopened = WorkspaceStore::open(&f.db()).await.unwrap();
    assert_eq!(
        reopened.read(ID, None).await.unwrap().document["name"],
        "edited"
    );
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

    let error = WorkspaceStore::open(&f.db())
        .await
        .err()
        .expect("blocked migration must fail");
    assert_eq!(error.code, "WORKSPACE_MIGRATION");
    assert_ne!(error.code, "WORKSPACE_STORAGE_FULL");
    assert!(!error.message.contains("saved"));
    assert!(error.message.contains("unchanged"));
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
    connection.execute("DROP TABLE assets_v6").await.unwrap();
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
        .recovery_write("session-1", &edited, import.to_str(), Some(&import_hash))
        .unwrap();
    fs::write(f.0.join(".fd-write-crashed.tmp"), b"partial replacement").unwrap();
    let original_permissions = fs::metadata(&working).unwrap().permissions();
    let _restore_permissions = RestorePermissions {
        path: working.clone(),
        permissions: original_permissions.clone(),
    };
    let mut read_only = original_permissions;
    read_only.set_readonly(true);
    fs::set_permissions(&working, read_only).unwrap();
    edited["name"] = json!("must not replace");
    let error = backend
        .save(&working, &edited, Some(&saved.hash))
        .unwrap_err();
    assert_eq!(error.code, "READ_ONLY");
    assert!(!error.message.contains("File saved"));
    assert_eq!(fs::read(&import).unwrap(), import_bytes);
    assert_eq!(backend.open(&working).unwrap().document, original);
    assert_eq!(
        fs::read(f.0.join(".fd-write-crashed.tmp")).unwrap(),
        b"partial replacement"
    );

    let reopened = Backend::new(&f.0.join("recovery")).unwrap();
    let restored = reopened.recovery_read("session-1").unwrap();
    assert_eq!(restored.document["name"], "unsaved edit");
    assert_eq!(reopened.open(&working).unwrap().hash, saved.hash);
    assert_eq!(fs::read(&import).unwrap(), import_bytes);
}

#[test]
fn autosave_recovery_synced_temp_reopens_without_touching_import() {
    let f = Fixture::new();
    let import = f.0.join("original-import.fig");
    let import_bytes = b"user-import-bytes-must-stay";
    fs::write(&import, import_bytes).unwrap();
    let import_hash = sha256(import_bytes);
    let recovery = f.0.join("recovery");
    let backend = Backend::new(&recovery).unwrap();
    backend
        .recovery_write(
            "session-1",
            &document("consistent"),
            import.to_str(),
            Some(&import_hash),
        )
        .unwrap();
    let published = recovery.join("session-1.recovery.json");
    let older = fs::read(&published).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    backend
        .recovery_write(
            "session-1",
            &document("recovered edit"),
            import.to_str(),
            Some(&import_hash),
        )
        .unwrap();
    let newer = fs::read(&published).unwrap();
    fs::write(&published, &older).unwrap();
    fs::write(recovery.join(".fd-write-synced.tmp"), &newer).unwrap();
    fs::write(recovery.join(".fd-write-partial.tmp"), b"{").unwrap();
    drop(backend);
    let reopened = Backend::new(&recovery).unwrap();
    let restored = reopened.recovery_read("session-1").unwrap();
    eprintln!(
        "MEASURE synced_temp older_bytes={} newer_bytes={} import_bytes={} restored={}",
        older.len(),
        newer.len(),
        import_bytes.len(),
        restored.document["name"]
    );
    assert_eq!(restored.document["name"], "recovered edit");
    assert_eq!(fs::read(&import).unwrap(), import_bytes);
    assert!(!recovery.join(".fd-write-synced.tmp").exists());
    assert_eq!(
        fs::read(recovery.join(".fd-write-partial.tmp")).unwrap(),
        b"{"
    );
    assert_eq!(
        reopened
            .recovery_read("session-1")
            .unwrap()
            .entry
            .source_hash
            .as_deref(),
        Some(import_hash.as_str())
    );
}

#[tokio::test]
async fn autosave_recovery_killed_process_reopens_last_commit() {
    use std::{
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
        sync::mpsc,
        time::Duration,
    };
    let f = Fixture::new();
    let import = f.0.join("original-import.fig");
    let import_bytes = b"user-import-bytes-must-stay".to_vec();
    fs::write(&import, &import_bytes).unwrap();
    let root = f.0.clone();
    let db = f.db();
    let edited = document("must-not-commit");
    let outcome = tokio::task::spawn_blocking(move || {
        let mut child = Command::new(env!("CARGO_BIN_EXE_futureox-design-desktop-backend"))
            .args([
                "--recovery-dir",
                root.join("recovery").to_str().unwrap(),
                "--workspace-db",
                db.to_str().unwrap(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut stderr = child.stderr.take().unwrap();
        let stderr_thread = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = std::io::Read::read_to_end(&mut stderr, &mut bytes);
            bytes
        });
        let mut line = String::new();
        let send = |input: &mut std::process::ChildStdin, value: serde_json::Value| {
            writeln!(input, "{value}").unwrap();
            input.flush().unwrap();
        };
        send(
            &mut input,
            json!({"id":"health","method":"health","params":{}}),
        );
        output.read_line(&mut line).unwrap();
        let health: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(health["result"]["workspaceAvailable"], true);
        line.clear();
        send(
            &mut input,
            json!({"id":"commit","method":"workspace.commit","params":{"document":document("consistent"),"expectedRevision":null,"mutationId":"process-create"}}),
        );
        output.read_line(&mut line).unwrap();
        let created: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(created["result"]["revision"], 1, "{created}");
        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let locked_db = db.clone();
        let locker = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let mut connection = SqliteConnection::connect(&format!(
                    "sqlite://{}",
                    locked_db.display()
                ))
                .await
                .unwrap();
                connection.execute("BEGIN IMMEDIATE").await.unwrap();
                locked_tx.send(()).unwrap();
                let _ = release_rx.recv();
                drop(connection);
            });
        });
        locked_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("external writer did not lock the workspace");
        send(
            &mut input,
            json!({"id":"commit-2","method":"workspace.commit","params":{"document":edited,"expectedRevision":1,"mutationId":"process-edit"}}),
        );
        std::thread::sleep(Duration::from_millis(300));
        child.kill().unwrap();
        let status = child.wait().unwrap();
        release_tx.send(()).unwrap();
        locker.join().unwrap();
        let stderr = String::from_utf8_lossy(&stderr_thread.join().unwrap()).into_owned();
        (status.success(), stderr)
    })
    .await
    .unwrap();
    assert!(
        !outcome.0,
        "killed backend should not exit cleanly: {}",
        outcome.1
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_futureox-design-desktop-backend"))
        .args([
            "--recovery-dir",
            f.0.join("recovery").to_str().unwrap(),
            "--workspace-db",
            f.db().to_str().unwrap(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(
        input,
        "{}",
        json!({"id":"open","method":"workspace.open","params":{"id":ID}})
    )
    .unwrap();
    drop(input);
    let finished = child.wait_with_output().unwrap();
    assert!(
        finished.status.success(),
        "{}",
        String::from_utf8_lossy(&finished.stderr)
    );
    let replies = String::from_utf8(finished.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let opened = replies.iter().find(|reply| reply["id"] == "open").unwrap();
    eprintln!(
        "MEASURE killed_process import_bytes={} reopened={} stderr_bytes={}",
        import_bytes.len(),
        opened["result"]["document"]["name"],
        outcome.1.len()
    );
    assert!(
        opened.get("error").is_none() || opened["error"].is_null(),
        "{opened}"
    );
    assert_eq!(opened["result"]["revision"], 1);
    assert_eq!(opened["result"]["document"], document("consistent"));
    assert_eq!(fs::read(&import).unwrap(), import_bytes);
}
