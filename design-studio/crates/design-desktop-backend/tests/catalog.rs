use futureox_design_desktop_backend::catalog::Catalog;
use sqlx::{Connection, Executor, sqlite::SqliteConnection};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "forma-catalog-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        // macOS TMPDIR is a /var -> /private/var symlink; the grant identity
        // stores canonicalized paths, so the fixture must start resolved.
        Self(p.canonicalize().unwrap())
    }
    fn db(&self) -> PathBuf {
        self.0.join("catalog.sqlite3")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn migration_reopen_idempotence_and_reselection() {
    let f = Fixture::new();
    let c = Catalog::open(&f.db()).await.unwrap();
    let a = c.register(&f.0, Some("设计 Project")).await.unwrap();
    let b = c.register(&f.0, Some("Renamed")).await.unwrap();
    assert_eq!(a["directory"]["id"], b["directory"]["id"]);
    fs::write(f.0.join("雪.fd"), b"metadata only").unwrap();
    let id = a["directory"]["id"].as_str().unwrap();
    let scan = c.scan(id, &f.0, &AtomicBool::new(false)).await.unwrap();
    assert_eq!(scan["files"].as_array().unwrap().len(), 1);
    c.close().await;
    let reopened = Catalog::open(&f.db()).await.unwrap();
    assert_eq!(
        reopened.list().await.unwrap()["projects"][0]["name"],
        "Renamed"
    );
    assert_eq!(
        reopened
            .scan(id, &f.0, &AtomicBool::new(false))
            .await
            .unwrap_err()
            .code,
        "STALE_DIRECTORY"
    );
    reopened.register(&f.0, None).await.unwrap();
    assert!(
        reopened
            .scan(id, &f.0, &AtomicBool::new(false))
            .await
            .is_ok()
    );
    reopened.close().await;
}
#[tokio::test]
async fn cancelled_scan_rolls_back_and_missing_files_are_removed_on_scan() {
    let f = Fixture::new();
    let c = Catalog::open(&f.db()).await.unwrap();
    let r = c.register(&f.0, None).await.unwrap();
    let id = r["directory"]["id"].as_str().unwrap();
    fs::write(f.0.join("a.fd"), b"a").unwrap();
    c.scan(id, &f.0, &AtomicBool::new(false)).await.unwrap();
    fs::remove_file(f.0.join("a.fd")).unwrap();
    assert_eq!(
        c.scan(id, &f.0, &AtomicBool::new(true))
            .await
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    assert_eq!(
        c.list().await.unwrap()["files"].as_array().unwrap().len(),
        1
    );
    c.scan(id, &f.0, &AtomicBool::new(false)).await.unwrap();
    assert!(
        c.list().await.unwrap()["files"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    c.close().await;
}
#[tokio::test]
async fn future_schema_and_corrupt_database_are_preserved() {
    let f = Fixture::new();
    let c = Catalog::open(&f.db()).await.unwrap();
    c.close().await;
    let url = format!("sqlite://{}", f.db().display());
    let mut conn = SqliteConnection::connect(&url).await.unwrap();
    conn.execute("PRAGMA user_version=999").await.unwrap();
    conn.close().await.unwrap();
    let before = fs::read(f.db()).unwrap();
    assert!(Catalog::open(&f.db()).await.is_err());
    assert_eq!(fs::read(f.db()).unwrap(), before);
    let broken = f.0.join("broken.sqlite3");
    fs::write(&broken, b"not a sqlite database").unwrap();
    let before = fs::read(&broken).unwrap();
    assert!(Catalog::open(&broken).await.is_err());
    assert_eq!(fs::read(&broken).unwrap(), before);
}
#[tokio::test]
async fn register_sql_failure_rolls_back_project_update() {
    let f = Fixture::new();
    let c = Catalog::open(&f.db()).await.unwrap();
    c.register(&f.0, Some("Original")).await.unwrap();
    let mut conn = SqliteConnection::connect(&format!("sqlite://{}", f.db().display()))
        .await
        .unwrap();
    conn.execute("CREATE TRIGGER reject_directory BEFORE UPDATE ON directories BEGIN SELECT RAISE(ABORT,'injected'); END").await.unwrap();
    assert!(c.register(&f.0, Some("Must rollback")).await.is_err());
    assert_eq!(c.list().await.unwrap()["projects"][0]["name"], "Original");
    conn.close().await.unwrap();
    c.close().await;
}
#[tokio::test]
async fn scan_has_bounded_results_and_stable_file_ids() {
    let f = Fixture::new();
    let c = Catalog::open(&f.db()).await.unwrap();
    let r = c.register(&f.0, None).await.unwrap();
    let id = r["directory"]["id"].as_str().unwrap();
    for n in 0..514 {
        fs::write(f.0.join(format!("{n}.fd")), b"x").unwrap();
    }
    let scan = c.scan(id, &f.0, &AtomicBool::new(false)).await.unwrap();
    assert_eq!(scan["truncated"], true);
    assert_eq!(scan["files"].as_array().unwrap().len(), 512);
    c.close().await;
}
#[cfg(unix)]
#[tokio::test]
async fn symlinks_and_ancestor_rebind_invalidate_grants() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let root = f.0.join("selected");
    fs::create_dir(&root).unwrap();
    let c = Catalog::open(&f.db()).await.unwrap();
    let r = c.register(&root, None).await.unwrap();
    let id = r["directory"]["id"].as_str().unwrap();
    symlink(f.0.join("outside.fd"), root.join("link.fd")).unwrap();
    assert_eq!(
        c.scan(id, &root, &AtomicBool::new(false)).await.unwrap()["files"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    fs::rename(&root, f.0.join("old")).unwrap();
    fs::create_dir(&root).unwrap();
    assert_eq!(
        c.scan(id, &root, &AtomicBool::new(false))
            .await
            .unwrap_err()
            .code,
        "STALE_DIRECTORY"
    );
    let link = f.0.join("linked");
    symlink(&root, &link).unwrap();
    assert!(c.register(&link, None).await.is_err());
    c.close().await;
}

#[cfg(windows)]
#[tokio::test]
async fn windows_plain_and_verbatim_directory_paths_share_grants_and_ids() {
    let f = Fixture::new();
    let root = f.0.canonicalize().unwrap();
    let spelling = root.to_str().unwrap();
    let plain = if let Some(rest) = spelling.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else {
        PathBuf::from(spelling.strip_prefix(r"\\?\").unwrap_or(spelling))
    };
    let c = Catalog::open(&f.db()).await.unwrap();
    let registration = c.register(&plain, None).await.unwrap();
    let id = registration["directory"]["id"].as_str().unwrap();
    assert!(c.validate_directory(id, &root).is_ok());
    fs::write(root.join("spelling.fd"), b"metadata").unwrap();
    assert!(c.validate_file(id, &root.join("spelling.fd")).is_ok());
    let repeated = c.register(&root, None).await.unwrap();
    assert_eq!(repeated["directory"]["id"], registration["directory"]["id"]);
    c.close().await;
}

#[tokio::test]
async fn oversized_catalog_is_rejected_without_truncation() {
    let f = Fixture::new();
    let file = fs::File::create(f.db()).unwrap();
    file.set_len(futureox_design_desktop_backend::catalog::MAX_CATALOG_BYTES + 1)
        .unwrap();
    drop(file);
    let before = fs::metadata(f.db()).unwrap().len();
    assert!(Catalog::open(&f.db()).await.is_err());
    assert_eq!(fs::metadata(f.db()).unwrap().len(), before);
}
