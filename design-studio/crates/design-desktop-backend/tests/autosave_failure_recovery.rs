//! Cloud acceptance for autosave crash, storage failure, reopen and migration.
//! These are simulated faults against the desktop backend. They do not exercise
//! a signed release installer, and they are not a confirmed data-loss report.
use futureox_design_desktop_backend::{workspace::WorkspaceStore, Backend};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnection, Connection, Executor};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
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
    let sidecar = std::env::var_os("FUTUREOX_TEST_PACKAGED_AUTOSAVE_SIDECAR")
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_futureox-design-desktop-backend").into());
    let crash_sidecar = sidecar.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let mut child = Command::new(crash_sidecar)
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
    let mut child = Command::new(sidecar)
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

#[test]
fn autosave_recovery_same_millisecond_synced_temp_reopens_last_edit() {
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
    let older: Value = serde_json::from_slice(&fs::read(&published).unwrap()).unwrap();
    // The next autosave can land in the same wall-clock millisecond as the
    // previous publish (close-drain right after an idle autosave). The process
    // then exits after the temporary snapshot was synced but before the atomic
    // rename. The synced temp is provably the last write for this single-writer
    // recovery id, so restart must adopt it even though updatedAt ties.
    backend
        .recovery_write(
            "session-1",
            &document("recovered edit"),
            import.to_str(),
            Some(&import_hash),
        )
        .unwrap();
    let mut newer: Value = serde_json::from_slice(&fs::read(&published).unwrap()).unwrap();
    assert_ne!(newer["document"]["name"], older["document"]["name"]);
    newer["updatedAt"] = older["updatedAt"].clone();
    fs::write(&published, serde_json::to_vec(&older).unwrap()).unwrap();
    fs::write(
        recovery.join(".fd-write-same-ms.tmp"),
        serde_json::to_vec(&newer).unwrap(),
    )
    .unwrap();
    drop(backend);
    let reopened = Backend::new(&recovery).unwrap();
    let restored = reopened.recovery_read("session-1").unwrap();
    eprintln!(
        "MEASURE same_ms_temp older_updated_at={} newer_updated_at={} restored={} import_bytes={}",
        older["updatedAt"],
        newer["updatedAt"],
        restored.document["name"],
        import_bytes.len()
    );
    assert_eq!(restored.document["name"], "recovered edit");
    assert_eq!(restored.document, document("recovered edit"));
    assert_eq!(fs::read(&import).unwrap(), import_bytes);
    assert!(!recovery.join(".fd-write-same-ms.tmp").exists());
    assert_eq!(
        restored.entry.source_hash.as_deref(),
        Some(import_hash.as_str())
    );
}

#[test]
fn autosave_recovery_stale_temp_with_newer_clock_does_not_roll_back_published() {
    let f = Fixture::new();
    let recovery = f.0.join("recovery");
    let backend = Backend::new(&recovery).unwrap();
    backend
        .recovery_write("session-1", &document("stale content"), None, None)
        .unwrap();
    let published = recovery.join("session-1.recovery.json");
    let stale: Value = serde_json::from_slice(&fs::read(&published).unwrap()).unwrap();
    backend
        .recovery_write("session-1", &document("current"), None, None)
        .unwrap();
    let current_bytes = fs::read(&published).unwrap();
    let current: Value = serde_json::from_slice(&current_bytes).unwrap();
    // A leftover temp from an earlier write (lower monotonic sequence) must never
    // replace the newer published snapshot, even if its wall-clock updatedAt is
    // newer (backward clock adjustment or tampered metadata). The single-writer
    // counter is authoritative; updatedAt is only a legacy tie-breaker.
    let mut stale = stale;
    stale["updatedAt"] = json!(current["updatedAt"].as_u64().unwrap() + 1000);
    fs::write(
        recovery.join(".fd-write-stale.tmp"),
        serde_json::to_vec(&stale).unwrap(),
    )
    .unwrap();
    drop(backend);
    let reopened = Backend::new(&recovery).unwrap();
    let restored = reopened.recovery_read("session-1").unwrap();
    eprintln!(
        "MEASURE stale_temp stale_updated_at={} current_updated_at={} restored={}",
        stale["updatedAt"], current["updatedAt"], restored.document["name"]
    );
    assert_eq!(restored.document["name"], "current");
    assert_eq!(restored.document, document("current"));
    assert_eq!(fs::read(&published).unwrap(), current_bytes);
    // The rejected stale temp is retained unchanged, not silently consumed.
    assert_eq!(
        fs::read(recovery.join(".fd-write-stale.tmp")).unwrap(),
        serde_json::to_vec(&stale).unwrap()
    );
}

#[test]
fn autosave_recovery_legacy_record_without_sequence_upgrades_and_recovers() {
    let f = Fixture::new();
    let recovery = f.0.join("recovery");
    let backend = Backend::new(&recovery).unwrap();
    backend
        .recovery_write("session-1", &document("legacy"), None, None)
        .unwrap();
    let published = recovery.join("session-1.recovery.json");
    // Simulate a snapshot written by an older app: no monotonic sequence field.
    let mut legacy: Value = serde_json::from_slice(&fs::read(&published).unwrap()).unwrap();
    legacy.as_object_mut().unwrap().remove("sequence");
    fs::write(&published, serde_json::to_vec(&legacy).unwrap()).unwrap();
    drop(backend);
    let reopened = Backend::new(&recovery).unwrap();
    assert_eq!(
        reopened.recovery_read("session-1").unwrap().document,
        document("legacy")
    );
    // A newer edit upgrades the legacy record to sequence 1 without data loss.
    reopened
        .recovery_write("session-1", &document("upgraded"), None, None)
        .unwrap();
    let upgraded: Value = serde_json::from_slice(&fs::read(&published).unwrap()).unwrap();
    assert_eq!(upgraded["sequence"], json!(1));
    assert_eq!(
        reopened.recovery_read("session-1").unwrap().document,
        document("upgraded")
    );
}

#[test]
fn autosave_recovery_legacy_synced_temp_still_adopts_by_timestamp() {
    let f = Fixture::new();
    let recovery = f.0.join("recovery");
    let backend = Backend::new(&recovery).unwrap();
    backend
        .recovery_write("session-1", &document("consistent"), None, None)
        .unwrap();
    let published = recovery.join("session-1.recovery.json");
    let mut older: Value = serde_json::from_slice(&fs::read(&published).unwrap()).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    backend
        .recovery_write("session-1", &document("recovered edit"), None, None)
        .unwrap();
    let mut newer: Value = serde_json::from_slice(&fs::read(&published).unwrap()).unwrap();
    // Both records predate the sequence field; ordering must fall back to
    // updatedAt exactly as before, so legacy crash recovery is unchanged.
    older.as_object_mut().unwrap().remove("sequence");
    newer.as_object_mut().unwrap().remove("sequence");
    fs::write(&published, serde_json::to_vec(&older).unwrap()).unwrap();
    fs::write(
        recovery.join(".fd-write-legacy.tmp"),
        serde_json::to_vec(&newer).unwrap(),
    )
    .unwrap();
    drop(backend);
    let reopened = Backend::new(&recovery).unwrap();
    let restored = reopened.recovery_read("session-1").unwrap();
    assert_eq!(restored.document["name"], "recovered edit");
    assert!(!recovery.join(".fd-write-legacy.tmp").exists());
}

struct Volume {
    image: PathBuf,
    mount: PathBuf,
}
impl Volume {
    fn new(megabytes: u64) -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let image =
            std::env::temp_dir().join(format!("futureox-full-{n}-{}.img", std::process::id()));
        let mount = std::env::temp_dir().join(format!("futureox-full-{n}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&mount);
        fs::create_dir_all(&mount).unwrap();
        let status = Command::new("fallocate")
            .args(["-l", &format!("{megabytes}M"), image.to_str().unwrap()])
            .status()
            .unwrap();
        assert!(status.success(), "fallocate failed");
        let status = Command::new("mkfs.ext4")
            .args(["-F", "-q", image.to_str().unwrap()])
            .status()
            .unwrap();
        assert!(status.success(), "mkfs.ext4 failed");
        let mounted = Command::new("sudo")
            .args([
                "-n",
                "mount",
                "-o",
                "loop",
                image.to_str().unwrap(),
                mount.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(
            mounted.status.success(),
            "mount failed: {}",
            String::from_utf8_lossy(&mounted.stderr)
        );
        let uid = Command::new("id").arg("-u").output().unwrap();
        let gid = Command::new("id").arg("-g").output().unwrap();
        let owner = format!(
            "{}:{}",
            String::from_utf8(uid.stdout).unwrap().trim(),
            String::from_utf8(gid.stdout).unwrap().trim()
        );
        let chowned = Command::new("sudo")
            .args(["-n", "chown", &owner, mount.to_str().unwrap()])
            .status()
            .unwrap();
        assert!(chowned.success(), "chown failed");
        Self { image, mount }
    }
    fn fill(&self) {
        let path = self.mount.join("filler");
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .unwrap();
        let chunk = vec![0u8; 64 * 1024];
        while file.write_all(&chunk).is_ok() {}
        let _ = file.sync_all();
    }
}
impl Drop for Volume {
    fn drop(&mut self) {
        let _ = Command::new("sudo")
            .args(["-n", "umount", self.mount.to_str().unwrap()])
            .status();
        let _ = fs::remove_dir_all(&self.mount);
        let _ = fs::remove_file(&self.image);
    }
}

struct Rpc {
    child: Option<std::process::Child>,
    input: Option<std::process::ChildStdin>,
    output: BufReader<std::process::ChildStdout>,
}
impl Rpc {
    fn start(root: &Path) -> Self {
        let bin = env!("CARGO_BIN_EXE_futureox-design-desktop-backend");
        let mut child = Command::new(bin)
            .args([
                "--recovery-dir",
                root.join("recovery").to_str().unwrap(),
                "--workspace-db",
                root.join("workspace.sqlite3").to_str().unwrap(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child: Some(child),
            input: Some(input),
            output,
        }
    }
    fn call(&mut self, id: &str, method: &str, params: Value) -> Value {
        let input = self.input.as_mut().unwrap();
        writeln!(
            input,
            "{}",
            json!({"id": id, "method": method, "params": params})
        )
        .unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        serde_json::from_str(line.trim()).unwrap_or_else(|_| panic!("bad reply {line}"))
    }
    fn finish(&mut self) {
        drop(self.input.take());
        let status = self.child.take().unwrap().wait().unwrap();
        assert!(status.success(), "backend exit {status}");
    }
}
impl Drop for Rpc {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn collect_index_data(dir: &Path, names: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_index_data(&path, names);
        } else if entry
            .file_name()
            .to_string_lossy()
            .starts_with("index-data-")
        {
            names.push(path.display().to_string());
        }
    }
}
fn index_data_files(root: &Path) -> Vec<String> {
    let mut names = Vec::new();
    collect_index_data(root, &mut names);
    names.sort();
    names
}

fn source_document() -> Value {
    json!({"schemaVersion":6,"id":"20000000-0000-0000-0000-000000000001","name":"before",
        "pages":[{"id":"20000000-0000-0000-0000-000000000002","name":"Page","background":"#ffffff","children":[]}],
        "nodes":{}})
}

#[test]
fn autosave_recovery_real_disk_full_reopens_last_consistent_copy() {
    let volume = Volume::new(32);
    fs::create_dir(volume.mount.join("recovery")).unwrap();
    let source = std::env::temp_dir().join(format!(
        "futureox-source-{}-{}.json",
        std::process::id(),
        volume.mount.file_name().unwrap().to_string_lossy()
    ));
    let source_bytes = serde_json::to_vec(&source_document()).unwrap();
    fs::write(&source, &source_bytes).unwrap();
    let mut rpc = Rpc::start(&volume.mount);
    let health = rpc.call("health", "health", json!({}));
    assert_eq!(health["result"]["workspaceAvailable"], true, "{health}");
    let created = rpc.call(
        "commit",
        "workspace.commit",
        json!({"document": document("consistent"), "expectedRevision": null, "mutationId": "create-real-full"}),
    );
    assert_eq!(created["result"]["revision"], 1, "{created}");
    let opened = rpc.call(
        "open",
        "large.open",
        json!({"path": source, "documentId": "20000000-0000-0000-0000-000000000001", "sessionEpoch": 1}),
    );
    assert!(opened.get("error").is_none(), "{opened}");
    let owner = opened["result"]["owner"].clone();
    let read = rpc.call(
        "read",
        "large.read",
        json!({"owner": owner, "expectedRevision": 0, "key": "0:0"}),
    );
    assert!(read.get("error").is_none(), "{read}");
    let edited = read["result"]["json"]
        .as_str()
        .unwrap()
        .replace("before", "afterX");
    let applied = rpc.call(
        "apply",
        "large.apply",
        json!({"owner": owner, "expectedRevision": 0, "key": "0:0", "json": edited, "expectedHash": read["result"]["hash"], "requestId": "real-full-edit"}),
    );
    assert_eq!(applied["result"]["revision"], 1, "{applied}");
    rpc.finish();
    let indexes = index_data_files(&volume.mount.join("recovery"));
    assert!(
        !indexes.is_empty(),
        "the saved source index must already be on disk"
    );
    volume.fill();
    let started = Instant::now();
    let mut rpc = Rpc::start(&volume.mount);
    let health = rpc.call("health", "health", json!({}));
    assert_eq!(health["result"]["workspaceAvailable"], true, "{health}");
    assert!(health["result"]["workspaceError"].is_null(), "{health}");
    let again = rpc.call("open-db", "workspace.open", json!({"id": ID}));
    assert_eq!(again["result"]["document"]["name"], "consistent", "{again}");
    assert_eq!(again["result"]["revision"], 1, "{again}");
    let reopened = rpc.call(
        "reopen",
        "large.open",
        json!({"path": source, "documentId": "20000000-0000-0000-0000-000000000009", "sessionEpoch": 2}),
    );
    let elapsed = started.elapsed();
    assert!(reopened.get("error").is_none(), "{reopened}");
    assert_eq!(reopened["result"]["revision"], 1, "{reopened}");
    let owner = reopened["result"]["owner"].clone();
    let reread = rpc.call(
        "reread",
        "large.read",
        json!({"owner": owner, "expectedRevision": 1, "key": "0:0"}),
    );
    assert!(
        reread["result"]["json"]
            .as_str()
            .unwrap()
            .contains("afterX"),
        "{reread}"
    );
    assert_eq!(fs::read(&source).unwrap(), source_bytes);
    assert_eq!(index_data_files(&volume.mount.join("recovery")), indexes);
    // Reopen may spend the reserve. Fill again so the next save has nowhere to grow.
    volume.fill();
    let mut bulky = document("must-not-commit");
    bulky["pages"][0]["name"] = json!("p".repeat(200_000));
    let rejected = rpc.call(
        "edit",
        "workspace.commit",
        json!({"document": bulky, "expectedRevision": 1, "mutationId": "edit-real-full"}),
    );
    assert_eq!(
        rejected["error"]["code"], "WORKSPACE_STORAGE_FULL",
        "{rejected}"
    );
    assert_ne!(rejected["error"]["code"], "WORKSPACE_CORRUPT", "{rejected}");
    assert_ne!(
        rejected["error"]["code"], "WORKSPACE_MIGRATION",
        "{rejected}"
    );
    let message = rejected["error"]["message"].as_str().unwrap();
    assert!(message.contains("not written"), "{message}");
    assert!(message.contains("unchanged"), "{message}");
    assert!(!message.contains("saved"), "{message}");
    let still = rpc.call("open-db-2", "workspace.open", json!({"id": ID}));
    assert_eq!(still["result"]["document"]["name"], "consistent", "{still}");
    assert_eq!(still["result"]["revision"], 1, "{still}");
    eprintln!(
        "MEASURE real_disk_full reopen_ms={} index_files={} workspace_code={}",
        elapsed.as_millis(),
        indexes.len(),
        rejected["error"]["code"]
    );
    rpc.finish();
    let _ = fs::remove_file(&source);
}

#[tokio::test]
async fn autosave_recovery_real_disk_full_upgrade_keeps_prior_schema_then_retries() {
    let volume = Volume::new(48);
    fs::create_dir(volume.mount.join("recovery")).unwrap();
    let font = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        vec![7u8; 800 * 1024],
    );
    let mut stored = document("before-upgrade");
    stored["fonts"] = json!({"a/~font": {"family": "Embedded", "data": font}});
    let mut rpc = Rpc::start(&volume.mount);
    let saved = rpc.call(
        "commit",
        "workspace.commit",
        json!({"document": stored, "expectedRevision": null, "mutationId": "before-upgrade"}),
    );
    assert_eq!(saved["result"]["revision"], 1, "{saved}");
    let saved_hash = saved["result"]["hash"].as_str().unwrap().to_owned();
    rpc.finish();
    let mut connection = SqliteConnection::connect(&format!(
        "sqlite://{}",
        volume.mount.join("workspace.sqlite3").display()
    ))
    .await
    .unwrap();
    connection.execute("BEGIN IMMEDIATE").await.unwrap();
    for sql in [
        "CREATE TABLE assets_v5(hash TEXT PRIMARY KEY CHECK(length(hash)=64),kind TEXT NOT NULL CHECK(kind IN('font','image')),value BLOB NOT NULL,byte_length INTEGER NOT NULL CHECK(byte_length>=0 AND byte_length<=33554432))",
        "INSERT INTO assets_v5 SELECT * FROM assets",
        "CREATE TABLE revision_assets_v5(document_id TEXT NOT NULL,revision INTEGER NOT NULL,asset_hash TEXT NOT NULL REFERENCES assets_v5(hash),PRIMARY KEY(document_id,revision,asset_hash),FOREIGN KEY(document_id,revision) REFERENCES revisions(document_id,revision))",
        "INSERT INTO revision_assets_v5 SELECT * FROM revision_assets",
        "DROP TABLE revision_assets",
        "DROP TABLE assets",
        "ALTER TABLE assets_v5 RENAME TO assets",
        "ALTER TABLE revision_assets_v5 RENAME TO revision_assets",
        "PRAGMA user_version=5",
        "COMMIT",
    ] {
        connection.execute(sql).await.unwrap();
    }
    let asset_before: i64 = sqlx::query_scalar("SELECT coalesce(sum(length(value)),0) FROM assets")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert!(asset_before > 700_000, "asset bytes {asset_before}");
    connection.close().await.unwrap();
    volume.fill();
    let mut rpc = Rpc::start(&volume.mount);
    let health = rpc.call("health", "health", json!({}));
    assert_eq!(health["result"]["workspaceAvailable"], false, "{health}");
    let message = health["result"]["workspaceError"]["message"]
        .as_str()
        .unwrap();
    assert!(message.contains("WORKSPACE_STORAGE_FULL"), "{health}");
    assert!(!message.contains("WORKSPACE_CORRUPT"), "{health}");
    assert!(!message.contains("saved"), "{message}");
    rpc.finish();
    let mut connection = SqliteConnection::connect(&format!(
        "sqlite://{}",
        volume.mount.join("workspace.sqlite3").display()
    ))
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA user_version")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        5
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT coalesce(sum(length(value)),0) FROM assets")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        asset_before
    );
    connection.close().await.unwrap();
    // Free enough of the filler for the asset copy, then the upgrade must finish.
    let filler = volume.mount.join("filler");
    let bytes = fs::read(&filler).unwrap();
    fs::write(
        &filler,
        &bytes[..bytes.len().saturating_sub(4 * 1024 * 1024)],
    )
    .unwrap();
    let mut rpc = Rpc::start(&volume.mount);
    let health = rpc.call("health", "health", json!({}));
    assert_eq!(health["result"]["workspaceAvailable"], true, "{health}");
    let opened = rpc.call("open", "workspace.open", json!({"id": ID}));
    assert_eq!(
        opened["result"]["document"]["name"], "before-upgrade",
        "{opened}"
    );
    assert_eq!(opened["result"]["hash"], saved_hash, "{opened}");
    rpc.finish();
    let mut connection = SqliteConnection::connect(&format!(
        "sqlite://{}",
        volume.mount.join("workspace.sqlite3").display()
    ))
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA user_version")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        futureox_design_desktop_backend::workspace::SCHEMA_VERSION
    );
    connection.close().await.unwrap();
    eprintln!("MEASURE real_disk_full_upgrade asset_bytes={asset_before} retried=ok");
}
