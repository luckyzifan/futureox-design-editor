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
            "forma-workspace-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        Self(p.canonicalize().unwrap())
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
fn document() -> Value {
    json!({"schemaVersion":6,"id":ID,"name":"本地设计 – 雪 ❄",
        "pages":[{"id":"10000000-0000-0000-0000-000000000002","name":"Page","background":"#ffffff","children":[]}],"nodes":{},
        "extensionData":{"nested":[1.23456789012345,-0.0,{"future-field":"preserve"}]}})
}
async fn request(backend: Arc<Backend>, method: &str, params: Value) -> protocol::Response {
    let frame = serde_json::to_vec(&json!({"id":"rpc","method":method,"params":params})).unwrap();
    tokio::task::spawn_blocking(move || protocol::handle_frame(&backend, &frame))
        .await
        .unwrap()
}

#[tokio::test]
async fn commit_restart_history_and_identical_retry_return_original_revision() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let first = store.commit(&document(), None, "create-1").await.unwrap();
    assert_eq!(first.revision, 1);
    assert_eq!(store.read(ID, None).await.unwrap().document, document());
    let mut next = document();
    next["name"] = json!("第二版");
    let second = store.commit(&next, Some(1), "change-2").await.unwrap();
    assert_eq!(second.revision, 2);
    assert_ne!(first.hash, second.hash);
    assert_eq!(
        store.commit(&document(), None, "create-1").await.unwrap(),
        first
    );
    assert_eq!(store.read(ID, None).await.unwrap().entry.revision, 2);
    store.close().await;
    let reopened = WorkspaceStore::open(&f.db()).await.unwrap();
    assert_eq!(reopened.read(ID, None).await.unwrap().document, next);
    assert_eq!(
        reopened.read(ID, Some(1)).await.unwrap().document,
        document()
    );
    assert_eq!(
        reopened.commit(&next, Some(1), "change-2").await.unwrap(),
        second
    );
    let history = reopened.revisions(ID, None).await.unwrap();
    assert_eq!(history["revisions"].as_array().unwrap().len(), 2);
    assert_eq!(history["revisions"][0]["revision"], 2);
    assert_eq!(history["hasMore"], false);
    reopened.close().await;
}

#[tokio::test]
async fn revision_conflicts_and_mutation_reuse_do_not_change_durable_head() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    store.commit(&document(), None, "same").await.unwrap();
    let mut changed = document();
    changed["name"] = json!("different");
    assert_eq!(
        store.commit(&changed, None, "same").await.unwrap_err().code,
        "WORKSPACE_MUTATION_CONFLICT"
    );
    assert_eq!(
        store
            .commit(&document(), Some(1), "same")
            .await
            .unwrap_err()
            .code,
        "WORKSPACE_MUTATION_CONFLICT"
    );
    assert_eq!(
        store.commit(&changed, None, "new").await.unwrap_err().code,
        "WORKSPACE_CONFLICT"
    );
    assert_eq!(
        store
            .commit(&changed, Some(2), "new")
            .await
            .unwrap_err()
            .code,
        "WORKSPACE_CONFLICT"
    );
    assert_eq!(store.read(ID, None).await.unwrap().document, document());
    assert_eq!(
        store.revisions(ID, None).await.unwrap()["revisions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    store.close().await;
}

#[tokio::test]
async fn trash_undelete_and_history_restore_create_new_revisions_with_cas() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    store.commit(&document(), None, "c1").await.unwrap();
    let mut next = document();
    next["name"] = json!("edit");
    store.commit(&next, Some(1), "c2").await.unwrap();
    let trashed = store.trash(ID, 2, "trash", true).await.unwrap();
    assert!(trashed.deleted);
    assert_eq!(trashed.revision, 3);
    assert_eq!(store.trash(ID, 2, "trash", true).await.unwrap(), trashed);
    assert!(
        store.list(false).await.unwrap()["documents"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.list(true).await.unwrap()["documents"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store.commit(&next, Some(3), "c3").await.unwrap_err().code,
        "WORKSPACE_DELETED"
    );
    assert_eq!(
        store.restore(ID, 1, 2, "restore").await.unwrap_err().code,
        "WORKSPACE_CONFLICT"
    );
    let restored = store.restore(ID, 1, 3, "restore").await.unwrap();
    assert_eq!(restored.entry.revision, 4);
    assert!(!restored.entry.deleted);
    assert_eq!(restored.document, document());
    assert_eq!(
        store.restore(ID, 1, 3, "restore").await.unwrap().entry,
        restored.entry
    );
    assert_eq!(
        store.revisions(ID, Some(3)).await.unwrap()["revisions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    store.trash(ID, 4, "trash2", true).await.unwrap();
    let undeleted = store.trash(ID, 5, "undelete", false).await.unwrap();
    assert!(!undeleted.deleted);
    assert_eq!(undeleted.revision, 6);
    assert_eq!(
        store
            .trash("20000000-0000-0000-0000-000000000001", 1, "missing", true)
            .await
            .unwrap_err()
            .code,
        "WORKSPACE_CONFLICT"
    );
    assert_eq!(
        store.list(true).await.unwrap()["documents"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    store.close().await;
}

#[tokio::test]
async fn failed_sql_commit_rolls_back_snapshot_head_and_idempotency_receipt() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    store.commit(&document(), None, "c1").await.unwrap();
    let mut conn = f.connection().await;
    conn.execute("CREATE TRIGGER fail_receipt BEFORE INSERT ON mutations BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END").await.unwrap();
    let mut next = document();
    next["name"] = json!("must rollback");
    assert!(store.commit(&next, Some(1), "c2").await.is_err());
    assert_eq!(store.read(ID, None).await.unwrap().document, document());
    assert_eq!(
        store.revisions(ID, None).await.unwrap()["revisions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    conn.execute("DROP TRIGGER fail_receipt").await.unwrap();
    assert_eq!(
        store.commit(&next, Some(1), "c2").await.unwrap().revision,
        2
    );
    conn.close().await.unwrap();
    store.close().await;
}

#[tokio::test]
async fn concurrent_stores_have_only_one_successful_writer_for_a_revision() {
    let f = Fixture::new();
    let a = WorkspaceStore::open(&f.db()).await.unwrap();
    a.commit(&document(), None, "c1").await.unwrap();
    let b = WorkspaceStore::open(&f.db()).await.unwrap();
    let mut left = document();
    left["name"] = json!("left");
    let mut right = document();
    right["name"] = json!("right");
    let (l, r) = tokio::join!(
        a.commit(&left, Some(1), "left"),
        b.commit(&right, Some(1), "right")
    );
    assert_eq!(usize::from(l.is_ok()) + usize::from(r.is_ok()), 1);
    assert_eq!(
        l.err().or_else(|| r.err()).unwrap().code,
        "WORKSPACE_CONFLICT"
    );
    assert_eq!(a.read(ID, None).await.unwrap().entry.revision, 2);
    a.close().await;
    b.close().await;
}

#[tokio::test]
async fn invalid_kernel_input_and_invalid_requests_never_create_documents() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let mut invalid = document();
    invalid["pages"] = json!([]);
    assert_eq!(
        store.commit(&invalid, None, "bad").await.unwrap_err().code,
        "INVALID_DOCUMENT"
    );
    assert_eq!(
        store
            .commit(&document(), Some(0), "bad")
            .await
            .unwrap_err()
            .code,
        "INVALID_REQUEST"
    );
    assert_eq!(
        store
            .commit(&document(), None, "../bad")
            .await
            .unwrap_err()
            .code,
        "INVALID_REQUEST"
    );
    assert_eq!(
        store.read("../path", None).await.unwrap_err().code,
        "INVALID_REQUEST"
    );
    assert_eq!(
        store.read(ID, Some(0)).await.unwrap_err().code,
        "INVALID_REQUEST"
    );
    assert!(
        store.list(true).await.unwrap()["documents"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    store.close().await;
}

#[tokio::test]
async fn future_corrupt_and_unrelated_databases_are_retained_without_reset() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    store.commit(&document(), None, "c1").await.unwrap();
    store.close().await;
    let mut conn = f.connection().await;
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        .await
        .unwrap();
    conn.execute("PRAGMA user_version=99").await.unwrap();
    conn.close().await.unwrap();
    let original = fs::read(f.db()).unwrap();
    let error = WorkspaceStore::open(&f.db()).await.err().unwrap();
    assert_eq!(error.code, "WORKSPACE_FUTURE_SCHEMA");
    assert_eq!(fs::read(f.db()).unwrap(), original);
    let broken = f.0.join("broken.sqlite3");
    fs::write(&broken, b"retained invalid database").unwrap();
    assert_eq!(
        WorkspaceStore::open(&broken).await.err().unwrap().code,
        "WORKSPACE_CORRUPT"
    );
    assert_eq!(fs::read(&broken).unwrap(), b"retained invalid database");
    let unrelated = f.0.join("unrelated.sqlite3");
    fs::write(&unrelated, []).unwrap();
    let mut conn = SqliteConnection::connect(&format!("sqlite://{}", unrelated.display()))
        .await
        .unwrap();
    conn.execute("CREATE TABLE keep_me(value TEXT)")
        .await
        .unwrap();
    conn.close().await.unwrap();
    let original = fs::read(&unrelated).unwrap();
    assert_eq!(
        WorkspaceStore::open(&unrelated).await.err().unwrap().code,
        "WORKSPACE_CORRUPT"
    );
    assert_eq!(fs::read(unrelated).unwrap(), original);
}

#[tokio::test]
async fn snapshot_corruption_is_reported_and_never_overwritten_by_commit_or_restore() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    store.commit(&document(), None, "c1").await.unwrap();
    let mut conn = f.connection().await;
    conn.execute("UPDATE revisions SET snapshot=x'7b7d' WHERE revision=1")
        .await
        .unwrap();
    assert_eq!(
        store.read(ID, None).await.unwrap_err().code,
        "WORKSPACE_CORRUPT"
    );
    assert_eq!(
        store
            .commit(&document(), Some(1), "c2")
            .await
            .unwrap_err()
            .code,
        "WORKSPACE_CORRUPT"
    );
    assert_eq!(
        store.restore(ID, 1, 1, "r").await.unwrap_err().code,
        "WORKSPACE_CORRUPT"
    );
    let bytes: Vec<u8> = sqlx::query_scalar("SELECT snapshot FROM revisions WHERE revision=1")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(bytes, b"{}");
    conn.close().await.unwrap();
    store.close().await;
}

#[tokio::test]
async fn embedded_resource_strings_and_float_bits_survive_commit_restart_and_restore() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let mut doc = document();
    // This verifies storage bytes, not font decoding or image rendering. Actual
    // model resource fields and unknown compatible fields are all preserved.
    doc["fonts"] = json!({"embedded-font":{"family":"Fixture","data":"AAEC/f7/AA=="}});
    let node = "10000000-0000-0000-0000-000000000003";
    doc["pages"][0]["children"] = json!([node]);
    doc["nodes"][node] = json!({"id":node,"kind":"rectangle","width":1.23456789012345,"height":20,
        "fills":[{"kind":"image","color":"#ffffff","image":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD9sAAAAASUVORK5CYII="}]});
    let bytes = serde_json::to_vec(&doc).unwrap();
    store.commit(&doc, None, "assets").await.unwrap();
    store.close().await;
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let reopened = store.read(ID, None).await.unwrap();
    assert_eq!(serde_json::to_vec(&reopened.document).unwrap(), bytes);
    for index in [0, 1] {
        assert_eq!(
            reopened.document["extensionData"]["nested"][index]
                .as_f64()
                .unwrap()
                .to_bits(),
            doc["extensionData"]["nested"][index]
                .as_f64()
                .unwrap()
                .to_bits()
        );
    }
    let restored = store.restore(ID, 1, 1, "restore-assets").await.unwrap();
    assert_eq!(serde_json::to_vec(&restored.document).unwrap(), bytes);
    store.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn protocol_enforces_required_revision_and_reports_optional_store_health() {
    let f = Fixture::new();
    let absent = Arc::new(Backend::new(&f.0.join("recovery-old")).unwrap());
    let health = request(absent.clone(), "health", json!({}))
        .await
        .result
        .unwrap();
    assert_eq!(health["workspaceAvailable"], false);
    assert_eq!(
        request(absent, "workspace.list", json!({}))
            .await
            .error
            .unwrap()
            .code,
        "WORKSPACE_UNAVAILABLE"
    );
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let backend = Arc::new(
        Backend::new(&f.0.join("recovery"))
            .unwrap()
            .with_workspace(store),
    );
    assert_eq!(
        request(backend.clone(), "health", json!({}))
            .await
            .result
            .unwrap()["workspaceAvailable"],
        true
    );
    let missing = request(
        backend.clone(),
        "workspace.commit",
        json!({"document":document(),"mutationId":"a"}),
    )
    .await;
    assert_eq!(missing.error.unwrap().code, "INVALID_REQUEST");
    let created = request(
        backend.clone(),
        "workspace.commit",
        json!({"document":document(),"expectedRevision":null,"mutationId":"a"}),
    )
    .await;
    assert_eq!(created.result.unwrap()["revision"], 1);
    assert_eq!(
        request(backend.clone(), "workspace.open", json!({"id":ID}))
            .await
            .result
            .unwrap()["document"],
        document()
    );
    assert_eq!(
        request(backend.clone(), "workspace.list", json!({}))
            .await
            .result
            .unwrap()["documents"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    backend.close_stores().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_stdio_process_commits_drains_and_reopens_the_same_workspace() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let f = Fixture::new();
    for pass in 0..2 {
        let root = f.0.clone();
        let output = tokio::task::spawn_blocking(move || {
            let mut child = Command::new(env!("CARGO_BIN_EXE_futureox-design-desktop-backend"))
                .args(["--recovery-dir", root.join("recovery").to_str().unwrap(), "--workspace-db", root.join("workspace.sqlite3").to_str().unwrap()])
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
            let mut input = child.stdin.take().unwrap();
            writeln!(input, "{}", json!({"id":"health","method":"health","params":{}})).unwrap();
            if pass == 0 { writeln!(input, "{}", json!({"id":"commit","method":"workspace.commit","params":{"document":document(),"expectedRevision":null,"mutationId":"process-create"}})).unwrap(); }
            writeln!(input, "{}", json!({"id":"open","method":"workspace.open","params":{"id":ID}})).unwrap();
            drop(input);
            child.wait_with_output().unwrap()
        }).await.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let replies = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            replies.iter().find(|r| r["id"] == "health").unwrap()["result"]["workspaceAvailable"],
            true
        );
        assert_eq!(
            replies.iter().find(|r| r["id"] == "open").unwrap()["result"]["document"],
            document()
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn database_and_journal_symlinks_are_rejected() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let f = Fixture::new();
    let target = f.0.join("target");
    fs::write(&target, b"leave alone").unwrap();
    symlink(&target, f.db()).unwrap();
    assert!(WorkspaceStore::open(&f.db()).await.is_err());
    assert_eq!(fs::read(&target).unwrap(), b"leave alone");
    fs::remove_file(f.db()).unwrap();
    symlink(&target, f.0.join("workspace.sqlite3-wal")).unwrap();
    assert!(WorkspaceStore::open(&f.db()).await.is_err());
    assert_eq!(fs::read(&target).unwrap(), b"leave alone");
    fs::remove_file(f.0.join("workspace.sqlite3-wal")).unwrap();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    assert_eq!(
        fs::metadata(f.db()).unwrap().permissions().mode() & 0o777,
        0o600
    );
    store.close().await;
}

#[tokio::test]
async fn local_views_publish_peer_cursors_and_change_notifications_across_stores() {
    use futureox_design_desktop_backend::workspace::LocalPresence;
    use futureox_design_kernel::protocol::Envelope;
    let f = Fixture::new();
    let a = WorkspaceStore::open(&f.db()).await.unwrap();
    let b = WorkspaceStore::open(&f.db()).await.unwrap();
    a.commit(&document(), None, "create-live").await.unwrap();
    let p = LocalPresence {
        id: "10000000-0000-0000-0000-000000000011".into(),
        name: "Window A".into(),
        document_id: ID.into(),
        page_id: "10000000-0000-0000-0000-000000000002".into(),
        view: [0., 0., 1.],
        cursor: Some([12.25, 16.125]),
        selection: vec![],
    };
    let first = a
        .observe(
            Envelope::Subscribe {
                view_name: "workspace".into(),
                view_hash: String::new(),
            },
            p.clone(),
        )
        .await
        .unwrap();
    assert_eq!(first["changed"], true);
    assert_eq!(first["peers"].as_array().unwrap().len(), 0);
    let mut q = p.clone();
    q.id = "10000000-0000-0000-0000-000000000012".into();
    q.name = "Window B".into();
    q.cursor = Some([31., 42.]);
    let second = b
        .observe(
            Envelope::Subscribe {
                view_name: "workspace".into(),
                view_hash: first["viewHash"].as_str().unwrap().into(),
            },
            q.clone(),
        )
        .await
        .unwrap();
    assert_eq!(second["changed"], false);
    assert_eq!(second["peers"][0]["cursor"], json!([12.25, 16.125]));
    assert!(second["documents"].is_null());
    let mut edited = document();
    edited["name"] = json!("Changed in second window");
    b.commit(&edited, Some(1), "second-window-edit")
        .await
        .unwrap();
    let update = a
        .observe(
            Envelope::Subscribe {
                view_name: "workspace".into(),
                view_hash: first["viewHash"].as_str().unwrap().into(),
            },
            p.clone(),
        )
        .await
        .unwrap();
    assert_eq!(update["changed"], true);
    assert_eq!(update["documents"][0]["revision"], 2);
    assert_eq!(update["peers"][0]["id"], q.id);
    b.leave_session(&q.id).await.unwrap();
    let update = a
        .observe(
            Envelope::Subscribe {
                view_name: "workspace".into(),
                view_hash: update["viewHash"].as_str().unwrap().into(),
            },
            p,
        )
        .await
        .unwrap();
    assert_eq!(update["peers"].as_array().unwrap().len(), 0);
    a.close().await;
    b.close().await;
}
