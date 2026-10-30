use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
fn run(requests: &[Value]) -> (std::process::Output, std::path::PathBuf) {
    static N: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "forma-stdio-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    // macOS TMPDIR is a /var -> /private/var symlink; grant identities store
    // canonicalized paths, so the fixture root must start resolved.
    let root = root.canonicalize().unwrap();
    (run_at(&root, requests), root)
}
fn run_at(root: &std::path::Path, requests: &[Value]) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_futureox-design-desktop-backend"))
        .arg("--recovery-dir")
        .arg(root.join("recovery"))
        .arg("--catalog-db")
        .arg(root.join("catalog.sqlite3"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for request in requests {
        writeln!(input, "{request}").unwrap();
    }
    drop(input);
    child.wait_with_output().unwrap()
}
#[test]
fn real_stdio_eof_drains_queued_requests_and_reports_catalog_capabilities() {
    let (output, root) = run(&[
        json!({"id":1,"method":"health","params":{}}),
        json!({"id":2,"method":"catalog.list","params":{}}),
        json!({"id":3,"method":"recovery.list","params":{}}),
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let responses: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|x| serde_json::from_str(x).unwrap())
        .collect();
    assert_eq!(responses.len(), 3);
    assert_eq!(
        responses.iter().find(|r| r["id"] == 1).unwrap()["result"]["catalogVersion"],
        1
    );
    assert_eq!(
        responses.iter().find(|r| r["id"] == 2).unwrap()["result"]["requiresReselection"],
        true
    );
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn real_stdio_cancel_unknown_is_explicit_and_not_a_false_rollback() {
    let (output, root) = run(&[
        json!({"id":1,"method":"cancel","params":{"requestId":"absent"}}),
        json!({"id":2,"method":"health","params":{}}),
    ]);
    assert!(output.status.success());
    let responses: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|x| serde_json::from_str(x).unwrap())
        .collect();
    assert_eq!(responses[0]["result"]["cancelled"], false);
    assert_eq!(responses[0]["result"]["running"], false);
    fs::remove_dir_all(root).unwrap();
}

fn assert_degraded_catalog_keeps_portable_files_and_recovery(root: &std::path::Path) {
    let document = json!({"schemaVersion":6,"id":"10000000-0000-0000-0000-000000000001","name":"Independent file",
        "pages":[{"id":"10000000-0000-0000-0000-000000000002","name":"Page","background":"#ffffff","children":[]}],"nodes":{}});
    let path = root.join("portable.fd");
    let output = run_at(
        root,
        &[
            json!({"id":1,"method":"health","params":{}}),
            json!({"id":2,"method":"catalog.list","params":{}}),
            json!({"id":3,"method":"save","params":{"path":path,"document":document,"expectedHash":null}}),
            json!({"id":4,"method":"open","params":{"path":path}}),
            json!({"id":5,"method":"recovery.write","params":{"recoveryId":"independent","document":document}}),
            json!({"id":6,"method":"recovery.read","params":{"recoveryId":"independent"}}),
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let replies: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(replies.len(), 6);
    let health = &replies.iter().find(|r| r["id"] == 1).unwrap()["result"];
    assert_eq!(health["catalogAvailable"], false);
    assert_eq!(health["fileRecoveryAvailable"], true);
    assert_eq!(health["catalogError"]["code"], "CATALOG_UNAVAILABLE");
    assert!(
        !health["catalogError"]["message"]
            .as_str()
            .unwrap()
            .contains(root.to_str().unwrap())
    );
    let catalog = replies.iter().find(|r| r["id"] == 2).unwrap();
    assert_eq!(catalog["error"]["code"], "CATALOG_UNAVAILABLE");
    assert!(catalog.get("result").is_none());
    for id in 3..=6 {
        assert!(
            replies
                .iter()
                .find(|r| r["id"] == id)
                .unwrap()
                .get("error")
                .is_none()
        );
    }
    assert_eq!(
        replies.iter().find(|r| r["id"] == 4).unwrap()["result"]["document"],
        document
    );
    assert_eq!(
        replies.iter().find(|r| r["id"] == 6).unwrap()["result"]["document"],
        document
    );
}

#[test]
fn real_stdio_corrupt_catalog_is_preserved_while_files_and_recovery_work() {
    let root = std::env::temp_dir().join(format!("forma-degraded-corrupt-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let path = root.join("catalog.sqlite3");
    fs::write(
        &path,
        b"invalid SQLite bytes including private-looking /native/path",
    )
    .unwrap();
    let original = fs::read(&path).unwrap();
    assert_degraded_catalog_keeps_portable_files_and_recovery(&root);
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn real_stdio_future_catalog_is_preserved_while_files_and_recovery_work() {
    use sqlx::{Connection, Executor, sqlite::SqliteConnection};
    let root = std::env::temp_dir().join(format!("forma-degraded-future-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let path = root.join("catalog.sqlite3");
    let catalog = futureox_design_desktop_backend::catalog::Catalog::open(&path)
        .await
        .unwrap();
    catalog.close().await;
    let mut connection = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
        .await
        .unwrap();
    connection.execute("PRAGMA user_version=999").await.unwrap();
    connection.close().await.unwrap();
    let original = fs::read(&path).unwrap();
    assert_degraded_catalog_keeps_portable_files_and_recovery(&root);
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn real_stdio_unusable_catalog_path_keeps_files_and_recovery_working() {
    let root = std::env::temp_dir().join(format!("forma-degraded-path-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    fs::create_dir(root.join("catalog.sqlite3")).unwrap();
    assert_degraded_catalog_keeps_portable_files_and_recovery(&root);
    assert!(root.join("catalog.sqlite3").is_dir());
    fs::remove_dir_all(root).unwrap();
}
