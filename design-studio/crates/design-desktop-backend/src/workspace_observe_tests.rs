//! Real SQLite tests of the production observe path; counters are test-only.
use super::*;
use futureox_design_kernel::protocol::Envelope;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};

const ID: &str = "10000000-0000-0000-0000-000000000001";
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "observe-cache-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
    fn db(&self) -> PathBuf {
        self.0.join("workspace.sqlite3")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn presence(n: usize) -> LocalPresence {
    LocalPresence {
        id: format!("20000000-0000-0000-0000-{n:012x}"),
        name: format!("Window {n}"),
        document_id: ID.into(),
        page_id: "10000000-0000-0000-0000-000000000002".into(),
        view: [0., 0., 1.],
        cursor: Some([1., 2.]),
        selection: vec![],
    }
}
fn document(name: &str) -> Value {
    json!({"schemaVersion":6,"id":ID,"name":name,"pages":[{"id":"10000000-0000-0000-0000-000000000002","name":"Page","background":"#ffffff","children":[]}],"nodes":{}})
}
async fn observe(store: &WorkspaceStore, hash: &str, p: LocalPresence) -> Result<Value> {
    store
        .observe(
            Envelope::Subscribe {
                view_name: "workspace".into(),
                view_hash: hash.into(),
            },
            p,
        )
        .await
}
async fn oracle(store: &WorkspaceStore, supplied_hash: &str, p: LocalPresence) -> Value {
    // This is the exact uncached pre-change list -> Value -> bounded JSON -> hash.
    let documents = store.list(false).await.unwrap();
    let expected =
        hash(&crate::bounded_json(&documents, 32 * 1024 * 1024, "WORKSPACE_ERROR").unwrap());
    let actual = observe(store, supplied_hash, p).await.unwrap();
    assert_eq!(actual["viewHash"], expected);
    assert_eq!(actual["changed"], expected != supplied_hash);
    assert_eq!(
        actual["documents"],
        if expected != supplied_hash {
            documents["documents"].clone()
        } else {
            Value::Null
        }
    );
    actual
}
async fn seed(store: &WorkspaceStore, count: usize) {
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<?) INSERT INTO documents SELECT printf('10000000-0000-0000-0000-%012x',i),1 FROM seq").bind(count as i64).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO revisions(document_id,revision,name,hash,snapshot,updated_at,deleted) SELECT id,1,'Unicode 雪 / \\ \"',printf('%064d',1),x'7b7d',1000,0 FROM documents").execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn observe_work_counts_real_sqlite_1_1000_10000_heads() {
    for count in [1, 1000, 10000] {
        let f = Fixture::new();
        let store = WorkspaceStore::open(&f.db()).await.unwrap();
        seed(&store, count).await;
        let mut hash = String::new();
        for _ in 0..12 {
            let out = oracle(&store, &hash, presence(1)).await;
            hash = out["viewHash"].as_str().unwrap().into();
        }
        let work = store.heads_cache.lock().unwrap().work.clone();
        assert_eq!(work.list_queries, 12);
        assert_eq!(work.list_rows, count * 12);
        assert_eq!(work.serializations, 1);
        assert_eq!(work.hash_calls, 1);
        assert_eq!(work.cache_hits, 11);
        assert!(work.cache_bytes <= MAX_HEADS_CACHE_BYTES);
        println!(
            "OBSERVE_WORK {}",
            json!({"heads":count,"scenario":"unchanged","polls":12,"work":work})
        );
        let writer = WorkspaceStore::open(&f.db()).await.unwrap();
        for scenario in ["presence_only", "each_poll_head_change"] {
            store.heads_cache.lock().unwrap().work = ObserveWork {
                cache_bytes: work.cache_bytes,
                ..ObserveWork::default()
            };
            for tick in 0..12 {
                if scenario == "presence_only" {
                    let mut peer = presence(2);
                    peer.cursor = Some([tick as f64, 42.]);
                    observe(&writer, &hash, peer).await.unwrap();
                } else {
                    sqlx::query("UPDATE revisions SET updated_at=? WHERE document_id=?")
                        .bind(2000 + tick)
                        .bind(ID)
                        .execute(&writer.pool)
                        .await
                        .unwrap();
                }
                let out = oracle(&store, &hash, presence(1)).await;
                assert_eq!(out["changed"], scenario == "each_poll_head_change");
                hash = out["viewHash"].as_str().unwrap().into();
            }
            let work = store.heads_cache.lock().unwrap().work.clone();
            assert_eq!(work.list_queries, 12);
            assert_eq!(work.list_rows, count * 12);
            assert_eq!(
                work.hash_calls,
                if scenario == "presence_only" { 0 } else { 12 }
            );
            assert_eq!(work.serializations, work.hash_calls);
            assert_eq!(work.cache_hits, 12 - work.hash_calls);
            println!(
                "OBSERVE_WORK {}",
                json!({"heads":count,"scenario":scenario,"polls":12,"work":work})
            );
        }
        writer.close().await;
        store.close().await;
    }
}

#[tokio::test]
async fn every_serialized_field_order_and_external_writes_are_authoritative() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let writer = WorkspaceStore::open(&f.db()).await.unwrap();
    seed(&store, 2).await;
    let mut previous = oracle(&store, "", presence(1)).await["viewHash"]
        .as_str()
        .unwrap()
        .to_owned();
    for sql in [
        "UPDATE revisions SET name='new Unicode 雪' WHERE document_id LIKE '%001'",
        "UPDATE revisions SET hash=printf('%064d',2) WHERE document_id LIKE '%001'",
        "UPDATE revisions SET updated_at=999 WHERE document_id LIKE '%001'",
        "UPDATE revisions SET deleted=1 WHERE document_id LIKE '%001'",
        "UPDATE revisions SET deleted=0 WHERE document_id LIKE '%001'",
        "UPDATE revisions SET updated_at=1000 WHERE document_id LIKE '%001'",
    ] {
        sqlx::query(sql).execute(&writer.pool).await.unwrap();
        let response = oracle(&store, &previous, presence(1)).await;
        assert_eq!(response["changed"], true);
        previous = response["viewHash"].as_str().unwrap().into();
    }
    let mut tx = writer.pool.begin().await.unwrap();
    sqlx::query("INSERT INTO revisions(document_id,revision,name,hash,snapshot,updated_at,deleted) SELECT document_id,2,name,hash,snapshot,updated_at,deleted FROM revisions WHERE document_id LIKE '%001'").execute(&mut *tx).await.unwrap();
    sqlx::query("UPDATE documents SET head_revision=2 WHERE id LIKE '%001'")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let out = oracle(&store, &previous, presence(1)).await;
    assert_eq!(out["documents"][0]["revision"], 2);
    // Historical-only metadata changes are not visible in the current list.
    let previous = out["viewHash"].as_str().unwrap();
    sqlx::query(
        "UPDATE revisions SET name='old history' WHERE document_id LIKE '%001' AND revision=1",
    )
    .execute(&writer.pool)
    .await
    .unwrap();
    assert_eq!(
        oracle(&store, previous, presence(1)).await["changed"],
        false
    );
    let out = oracle(&store, "stale", presence(1)).await;
    assert_eq!(out["documents"][0]["id"], ID);
    assert_eq!(out["documents"][0]["name"], "new Unicode 雪");
    assert_eq!(
        oracle(&store, "", presence(1)).await["documents"],
        out["documents"]
    );
    assert_eq!(
        observe(&store, &"x".repeat(129), presence(1))
            .await
            .unwrap_err()
            .code,
        "INVALID_REQUEST"
    );
    // Changing only the stored identity still changes the canonical view. All
    // six serialized fields have now been varied through a real SQLite writer.
    let mut tx = writer.pool.begin().await.unwrap();
    sqlx::query("INSERT INTO documents SELECT '10000000-0000-0000-0000-000000000003',head_revision FROM documents WHERE id=?").bind(ID).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO revisions(document_id,revision,name,hash,snapshot,updated_at,deleted) SELECT '10000000-0000-0000-0000-000000000003',revision,name,hash,snapshot,updated_at,deleted FROM revisions WHERE document_id=?").bind(ID).execute(&mut *tx).await.unwrap();
    sqlx::query("DELETE FROM revisions WHERE document_id=?")
        .bind(ID)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM documents WHERE id=?")
        .bind(ID)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(oracle(&store, previous, presence(1)).await["changed"], true);
    writer.close().await;
    store.close().await;
}

#[tokio::test]
async fn presence_only_churn_expiry_and_window_limit_stay_fresh() {
    let f = Fixture::new();
    let a = WorkspaceStore::open(&f.db()).await.unwrap();
    let b = WorkspaceStore::open(&f.db()).await.unwrap();
    a.commit(&document("present"), None, "create")
        .await
        .unwrap();
    let hash = oracle(&a, "", presence(1)).await["viewHash"]
        .as_str()
        .unwrap()
        .to_owned();
    for index in 0..20 {
        let mut p = presence(2);
        p.cursor = Some([index as f64, 42.]);
        observe(&b, &hash, p).await.unwrap();
        let out = oracle(&a, &hash, presence(1)).await;
        assert_eq!(out["peers"][0]["cursor"], json!([index as f64, 42.]));
        assert_eq!(out["changed"], false);
    }
    assert_eq!(a.heads_cache.lock().unwrap().work.hash_calls, 1);
    sqlx::query("UPDATE local_sessions SET updated_at=0 WHERE id=?")
        .bind(presence(2).id)
        .execute(&b.pool)
        .await
        .unwrap();
    assert_eq!(oracle(&a, &hash, presence(1)).await["peers"], json!([]));
    for n in 2..=64 {
        observe(&b, &hash, presence(n)).await.unwrap();
    }
    assert_eq!(
        oracle(&a, &hash, presence(1)).await["peers"]
            .as_array()
            .unwrap()
            .len(),
        63
    );
    assert_eq!(
        observe(&a, &hash, presence(65)).await.unwrap_err().code,
        "INVALID_REQUEST"
    );
    b.leave_session(&presence(2).id).await.unwrap();
    assert_eq!(
        oracle(&a, &hash, presence(1)).await["peers"]
            .as_array()
            .unwrap()
            .len(),
        62
    );
    a.close().await;
    b.close().await;
}

#[tokio::test]
async fn rollback_replay_unknown_outcome_trash_restore_and_restart() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let first = store
        .commit(&document("first"), None, "first")
        .await
        .unwrap();
    let hash = oracle(&store, "", presence(1)).await["viewHash"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("UPDATE revisions SET name='rolled back'")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(oracle(&store, &hash, presence(1)).await["changed"], false);
    assert_eq!(
        store
            .commit(&document("first"), None, "first")
            .await
            .unwrap(),
        first
    );
    assert_eq!(oracle(&store, &hash, presence(1)).await["changed"], false);
    sqlx::query("CREATE TRIGGER fail_receipt BEFORE INSERT ON mutations WHEN new.mutation_id='fail' BEGIN SELECT RAISE(ABORT,'test rollback'); END").execute(&store.pool).await.unwrap();
    assert!(
        store
            .commit(&document("failed"), Some(1), "fail")
            .await
            .is_err()
    );
    assert_eq!(oracle(&store, &hash, presence(1)).await["changed"], false);
    store
        .commit(&document("unknown until retry"), Some(1), "unknown")
        .await
        .unwrap();
    store.close().await;
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let retry = store
        .commit(&document("unknown until retry"), Some(1), "unknown")
        .await
        .unwrap();
    assert_eq!(retry.revision, 2);
    let next = oracle(&store, &hash, presence(1)).await;
    assert_eq!(next["documents"][0]["revision"], 2);
    store.trash(ID, 2, "trash", true).await.unwrap();
    let next = oracle(&store, next["viewHash"].as_str().unwrap(), presence(1)).await;
    assert_eq!(next["documents"], json!([]));
    store.restore(ID, 1, 3, "restore").await.unwrap();
    let next = oracle(&store, next["viewHash"].as_str().unwrap(), presence(1)).await;
    assert_eq!(next["documents"][0]["revision"], 4);
    assert_eq!(next["documents"][0]["name"], "first");
    store.close().await;
}

#[tokio::test]
async fn root_isolation_late_publication_and_failed_select_never_reuse_stale_data() {
    let f = Fixture::new();
    let other = Fixture::new();
    let a = WorkspaceStore::open(&f.db()).await.unwrap();
    let b = WorkspaceStore::open(&other.db()).await.unwrap();
    a.commit(&document("root A"), None, "first").await.unwrap();
    b.commit(&document("root B"), None, "first").await.unwrap();
    let before = oracle(&a, "", presence(1)).await;
    assert_ne!(
        oracle(&b, "", presence(1)).await["viewHash"],
        before["viewHash"]
    );
    let old = a.list_entries(false).await.unwrap();
    a.commit(&document("root A newer"), Some(1), "new")
        .await
        .unwrap();
    let new = a.list_entries(false).await.unwrap();
    let newer = a.observe_heads(new, "").unwrap();
    a.observe_heads(old, "").unwrap(); // Delayed old query publishes after the new one.
    assert_eq!(oracle(&a, &newer.0, presence(1)).await["changed"], false);
    // The pool may replace its physical connection without replacing this store.
    a.pool.acquire().await.unwrap().close().await.unwrap();
    assert_eq!(oracle(&a, &newer.0, presence(1)).await["changed"], false);
    sqlx::query("ALTER TABLE revisions RENAME TO revisions_unavailable")
        .execute(&a.pool)
        .await
        .unwrap();
    assert_eq!(
        observe(&a, &newer.0, presence(1)).await.unwrap_err().code,
        "WORKSPACE_ERROR"
    );
    a.close().await;
    b.close().await;
}

#[tokio::test]
async fn bounded_cache_and_original_json_limit_and_list_limit_are_preserved() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    seed(&store, 10001).await;
    let out = oracle(&store, "", presence(1)).await;
    assert_eq!(out["documents"].as_array().unwrap().len(), 10000);
    let h = out["viewHash"].as_str().unwrap();
    sqlx::query("UPDATE revisions SET name='outside limit' WHERE document_id='10000000-0000-0000-0000-000000002711'").execute(&store.pool).await.unwrap();
    assert_eq!(oracle(&store, h, presence(1)).await["changed"], false);
    sqlx::query("UPDATE revisions SET name=? WHERE document_id=?")
        .bind("x".repeat(MAX_HEADS_CACHE_BYTES))
        .bind(ID)
        .execute(&store.pool)
        .await
        .unwrap();
    let out = oracle(&store, h, presence(1)).await;
    assert!(store.heads_cache.lock().unwrap().snapshot.is_none());
    let hashes = store.heads_cache.lock().unwrap().work.hash_calls;
    assert_eq!(
        oracle(&store, out["viewHash"].as_str().unwrap(), presence(1)).await["changed"],
        false
    );
    assert_eq!(
        store.heads_cache.lock().unwrap().work.hash_calls,
        hashes + 1
    );
    sqlx::query("UPDATE revisions SET name=? WHERE document_id=?")
        .bind("x".repeat(32 * 1024 * 1024))
        .bind(ID)
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        observe(&store, "", presence(1)).await.unwrap_err().code,
        "WORKSPACE_ERROR"
    );
    assert!(store.heads_cache.lock().unwrap().snapshot.is_none());
    store.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn overlapping_observes_and_poisoned_cache_keep_exact_hashes() {
    let f = Fixture::new();
    let store = Arc::new(WorkspaceStore::open(&f.db()).await.unwrap());
    store
        .commit(&document("start"), None, "first")
        .await
        .unwrap();
    let mut tasks = Vec::new();
    let writer = store.clone();
    tasks.push(tokio::spawn(async move {
        for revision in 1..=6 {
            writer
                .commit(
                    &document(&format!("concurrent {revision}")),
                    Some(revision),
                    &format!("concurrent-{revision}"),
                )
                .await
                .unwrap();
        }
    }));
    for i in 1..=20 {
        let store = store.clone();
        tasks.push(tokio::spawn(async move {
            let out = observe(&store, "", presence(i)).await.unwrap();
            let expected = hash(
                &crate::bounded_json(
                    &json!({"documents":out["documents"]}),
                    32 * 1024 * 1024,
                    "WORKSPACE_ERROR",
                )
                .unwrap(),
            );
            assert_eq!(out["viewHash"], expected);
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _lock = store.heads_cache.lock().unwrap();
        panic!("test optional cache poisoning");
    }));
    store
        .commit(&document("after poison"), Some(7), "after")
        .await
        .unwrap();
    assert_eq!(
        oracle(&store, "", presence(1)).await["documents"][0]["name"],
        "after poison"
    );
    store.close().await;
}
