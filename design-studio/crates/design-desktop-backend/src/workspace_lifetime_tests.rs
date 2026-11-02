//! Scoped ownership probe, not an allocator/RSS measurement. No unsafe code.
//! The wrapper moves the actual head returned by SQLite, never a clone. Its
//! destructor drops that exact Value before recording the ownership-release event.
use super::*;
use std::{cell::RefCell, ops::Deref, path::PathBuf, sync::atomic::{AtomicUsize, Ordering}};
const ID: &str = "30000000-0000-0000-0000-000000000001";
const MARKER: &str = "lifetimeProbeExtension";
#[derive(Default, Debug)]
struct Probe { enabled: bool, armed: Option<usize>, dropped: Option<usize>, encodes: Vec<bool> }
thread_local! { static PROBE: RefCell<Probe> = RefCell::new(Probe::default()); }
struct Scope;
impl Scope { fn new() -> Self { PROBE.with(|p| *p.borrow_mut() = Probe { enabled: true, ..Probe::default() }); Self } }
impl Drop for Scope { fn drop(&mut self) { PROBE.with(|p| *p.borrow_mut() = Probe::default()); } }
pub(super) struct TrackedHead { value: Option<Opened>, identity: Option<usize> }
impl TrackedHead {
    pub(super) fn new(value: Option<Opened>) -> Self {
        let identity = PROBE.with(|p| {
            let mut p = p.borrow_mut();
            if !p.enabled { return None; }
            let identity = value.as_ref().filter(|o| o.entry.id == ID)
                .and_then(|o| o.document.get(MARKER)).and_then(Value::as_str)
                .map(|s| s.as_ptr() as usize);
            if let Some(identity) = identity { p.armed = Some(identity); p.dropped = None; }
            identity
        });
        Self { value, identity }
    }
}
impl Deref for TrackedHead { type Target = Option<Opened>; fn deref(&self) -> &Self::Target { &self.value } }
impl Drop for TrackedHead {
    fn drop(&mut self) {
        if let Some(identity) = self.identity {
            // Compare only while live. No freed pointer is dereferenced, and the
            // pointer is a label, not an allocator address-reuse detector.
            assert_eq!(self.value.as_ref().unwrap().document[MARKER].as_str().unwrap().as_ptr() as usize, identity);
        }
        drop(self.value.take());
        if let Some(identity) = self.identity { PROBE.with(|p| p.borrow_mut().dropped = Some(identity)); }
    }
}
pub(super) fn before_encode(document: &Value) {
    if document["id"] != ID { return; }
    PROBE.with(|p| { let mut p = p.borrow_mut(); if p.enabled && p.armed.is_some() {
        let released = p.armed == p.dropped;
        p.encodes.push(released);
    }});
}
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!("save-lifetime-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&path).unwrap(); Self(path.canonicalize().unwrap())
    }
    fn db(&self) -> PathBuf { self.0.join("workspace.sqlite3") }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn document(name: &str) -> Value {
    json!({"schemaVersion":6,"id":ID,"name":name,"pages":[{"id":"30000000-0000-0000-0000-000000000002","name":"Page","background":"#ffffff","children":[]}],"nodes":{},"lifetimeProbeExtension":"owned-old-head-".repeat(4096),"unknownExtension":{"null":null,"text":"雪\\\"","array":[1,true,null]}})
}
#[tokio::test(flavor = "current_thread")]
async fn old_head_is_released_before_new_snapshot_encode() {
    let f = Fixture::new(); let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let first = document("first"); store.commit(&first, None, "first").await.unwrap();
    store.close().await;
    // Reopen so this commit has no proof and must decode, then drop, the old head.
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let _scope = Scope::new(); let second = document("second");
    assert_eq!(store.commit(&second, Some(1), "second").await.unwrap().revision, 2);
    PROBE.with(|p| { let p = p.borrow(); assert!(p.armed.is_some(), "real SQLite old head was not observed"); assert_eq!(p.encodes, vec![true], "old SQLite Opened was still alive at snapshot encoding"); assert_eq!(p.armed, p.dropped); });
    assert_eq!(store.read(ID, None).await.unwrap().document, second);
    store.close().await;
}
#[tokio::test(flavor = "current_thread")]
async fn release_preserves_conflict_replay_rollback_deleted_and_unknown_fields() {
    let f = Fixture::new(); let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let first = document("first"); let entry = store.commit(&first, None, "first").await.unwrap();
    assert_eq!(store.commit(&first, None, "first").await.unwrap(), entry);
    assert!(store.commit(&document("changed"), None, "first").await.is_err());
    assert!(store.commit(&document("stale"), Some(99), "stale").await.is_err());
    sqlx::query("CREATE TRIGGER fail_receipt BEFORE INSERT ON mutations WHEN new.mutation_id='fail' BEGIN SELECT RAISE(ABORT,'test rollback'); END").execute(&store.pool).await.unwrap();
    assert!(store.commit(&document("failed"), Some(1), "fail").await.is_err());
    assert_eq!(store.read(ID, None).await.unwrap().document, first);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM revisions").fetch_one(&store.pool).await.unwrap(), 1);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM mutations").fetch_one(&store.pool).await.unwrap(), 1);
    let second = document("second"); let saved = store.commit(&second, Some(1), "second").await.unwrap();
    assert_eq!(store.commit(&second, Some(1), "second").await.unwrap(), saved);
    store.trash(ID, 2, "trash", true).await.unwrap();
    assert_eq!(store.commit(&document("deleted"), Some(3), "deleted").await.unwrap_err().code, "WORKSPACE_DELETED");
    store.close().await;
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    assert_eq!(store.read(ID, Some(2)).await.unwrap().document, second);
    store.close().await;
}
#[tokio::test(flavor = "current_thread")]
async fn release_keeps_old_head_integrity_check_before_any_write() {
    let f = Fixture::new(); let store = WorkspaceStore::open(&f.db()).await.unwrap();
    store.commit(&document("first"), None, "first").await.unwrap();
    sqlx::query("UPDATE revisions SET hash=? WHERE revision=1").bind("0".repeat(64)).execute(&store.pool).await.unwrap();
    assert_eq!(store.commit(&document("next"), Some(1), "next").await.unwrap_err().code, "WORKSPACE_CORRUPT");
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT head_revision FROM documents WHERE id=?").bind(ID).fetch_one(&store.pool).await.unwrap(), 1);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM mutations").fetch_one(&store.pool).await.unwrap(), 1);
    store.close().await;
}
#[tokio::test(flavor = "current_thread")]
async fn warm_head_proof_skips_decode_until_stored_bytes_or_flags_change() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    store.commit(&document("first"), None, "first").await.unwrap();
    assert_eq!(store.head_integrity_decodes(), 0);
    assert_eq!(store.commit(&document("second"), Some(1), "second").await.unwrap().revision, 2);
    assert_eq!(store.head_integrity_decodes(), 0);
    assert_eq!(store.read(ID, Some(1)).await.unwrap().document, document("first"));
    assert_eq!(store.commit(&document("third"), Some(2), "third").await.unwrap().revision, 3);
    assert_eq!(store.head_integrity_decodes(), 0, "an old revision read must not replace the head proof");
    store.close().await;
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    assert_eq!(store.commit(&document("fourth"), Some(3), "fourth").await.unwrap().revision, 4);
    assert_eq!(store.head_integrity_decodes(), 1, "a restarted process validates the stored head once");
    assert_eq!(store.commit(&document("fifth"), Some(4), "fifth").await.unwrap().revision, 5);
    assert_eq!(store.head_integrity_decodes(), 1);
    sqlx::query("UPDATE revisions SET deleted=1 WHERE revision=5").execute(&store.pool).await.unwrap();
    assert_eq!(store.commit(&document("deleted"), Some(5), "deleted").await.unwrap_err().code, "WORKSPACE_DELETED");
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT head_revision FROM documents WHERE id=?").bind(ID).fetch_one(&store.pool).await.unwrap(), 5);
    sqlx::query("UPDATE revisions SET deleted=0, name='tampered' WHERE revision=5").execute(&store.pool).await.unwrap();
    assert_eq!(store.commit(&document("renamed"), Some(5), "renamed").await.unwrap_err().code, "WORKSPACE_CORRUPT");
    let bytes: Vec<u8> = sqlx::query_scalar("SELECT snapshot FROM revisions WHERE revision=5").fetch_one(&store.pool).await.unwrap();
    let mut flipped = bytes.clone();
    flipped[0] ^= 0xff;
    sqlx::query("UPDATE revisions SET name=?, snapshot=? WHERE revision=5").bind("fifth").bind(flipped).execute(&store.pool).await.unwrap();
    assert_eq!(store.commit(&document("sixth"), Some(5), "sixth").await.unwrap_err().code, "WORKSPACE_CORRUPT");
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT head_revision FROM documents WHERE id=?").bind(ID).fetch_one(&store.pool).await.unwrap(), 5);
    assert!(store.head_integrity_decodes() >= 2, "changed snapshot bytes must be decoded, not accepted from the old proof");
    store.close().await;
}
