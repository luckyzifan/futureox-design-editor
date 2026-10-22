use base64::Engine as _;
use futureox_design_desktop_backend::{Backend, workspace::WorkspaceStore};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor, sqlite::SqliteConnection};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "forma-assets-{}-{}",
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
fn asset(byte: u8, len: usize) -> String {
    base64::engine::general_purpose::STANDARD.encode(vec![byte; len])
}
fn document(data: &str) -> Value {
    json!({"schemaVersion":6,"id":ID,"name":"resource fixture","pages":[{"id":"10000000-0000-0000-0000-000000000002","name":"Page","background":"#ffffff","children":[]}],"nodes":{},"fonts":{"a/~font":{"family":"Embedded","data":data}},
        "extensionData":{"text":"{\"$asset\":\"must stay literal\"}","unknownImage":"data:image/png;base64,AAAA","numeric":[-0.0,1.23456789012345]}})
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[tokio::test]
async fn image_resources_in_strokes_instance_overrides_styles_and_animation_poses_share_one_original_string()
 {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let image = format!("data:image/png;base64,{}", asset(7, 4096));
    let paint = json!({"kind":"image","color":"#ffffff","image":image});
    let master = "10000000-0000-0000-0000-000000000003";
    let instance = "10000000-0000-0000-0000-000000000004";
    let rectangle = "10000000-0000-0000-0000-000000000005";
    let mut doc = document(&asset(3, 4096));
    doc["pages"][0]["children"] = json!([master, instance, rectangle]);
    doc["nodes"] = json!({
        master:{"id":master,"kind":"frame","width":100,"height":100,"component":{"variants":{},"properties":{}},"styleRefs":{"fills":"paint/~style"}},
        instance:{"id":instance,"kind":"frame","width":100,"height":100,"instance":{"componentId":master,"overrides":{"$root":{"fills":[paint.clone()]}},"propertyValues":{}}},
        rectangle:{"id":rectangle,"kind":"rectangle","width":100,"height":100,"fills":[paint.clone()],"strokes":[{"paint":paint.clone(),"width":2}]}
    });
    doc["designSystem"] = json!({"collections":{},"variables":{},"activeModes":{},"libraries":{},"styles":{"paint/~style":{"kind":"paint","name":"Image","value":[paint.clone()]}}});
    let pose = json!({"kind":"rectangle","transform":[1,0,0,1,0,0],"width":100,"height":100,"opacity":1,"radii":[0,0,0,0],"smoothing":0,"fills":[paint.clone()],"strokes":[{"paint":paint,"width":2}],"effects":[]});
    doc["animations"] = json!([{"id":"clip","name":"Images","pageId":doc["pages"][0]["id"],"durationMs":1000,"tracks":[{"nodeId":rectangle,"keyframes":[{"timeMs":0,"value":pose.clone()},{"timeMs":1000,"value":pose}]}]}]);
    doc["extensionData"]["text"] = json!(image);
    store.commit(&doc, None, "image-locations").await.unwrap();
    assert_eq!(store.read(ID, None).await.unwrap().document, doc);
    let mut conn = f.connection().await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM assets")
            .fetch_one(&mut conn)
            .await
            .unwrap(),
        2
    );
    let bytes: Vec<u8> = sqlx::query_scalar("SELECT snapshot FROM revisions")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    let envelope: Value = serde_json::from_slice(&bytes).unwrap();
    let pointers = envelope["resources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["pointer"].as_str().unwrap())
        .collect::<Vec<_>>();
    for part in [
        "/strokes/0/paint/image",
        "/instance/overrides/$root/fills/0/image",
        "/animations/0/tracks/0/keyframes/0/value/fills/0/image",
        "/designSystem/styles/paint~1~0style/value/0/image",
    ] {
        assert!(pointers.iter().any(|p| p.contains(part)), "missing {part}");
    }
    assert_eq!(
        envelope["document"]["extensionData"]["text"],
        doc["extensionData"]["text"]
    );
    conn.close().await.unwrap();
    store.close().await;
}

#[tokio::test]
async fn repeated_resources_are_single_copy_and_history_export_reconstructs_identical_document_hashes()
 {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let data = asset(21, 256 * 1024);
    let mut doc = document(&data);
    let mut revisions = Vec::new();
    for revision in 1..=6 {
        doc["name"] = json!(format!("revision {revision}"));
        let saved = store
            .commit(
                &doc,
                if revision == 1 {
                    None
                } else {
                    Some(revision - 1)
                },
                &format!("save-{revision}"),
            )
            .await
            .unwrap();
        assert_eq!(saved.hash, sha(&serde_json::to_vec(&doc).unwrap()));
        revisions.push(doc.clone());
    }
    let mut conn = f.connection().await;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM assets")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let snapshots: i64 = sqlx::query_scalar("SELECT sum(length(snapshot)) FROM revisions")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert!(snapshots < 10_000);
    let references: i64 = sqlx::query_scalar("SELECT count(*) FROM revision_assets")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(references, 6);
    conn.close().await.unwrap();
    store.close().await;
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    for (index, expected) in revisions.iter().enumerate() {
        let opened = store.read(ID, Some(index as i64 + 1)).await.unwrap();
        assert_eq!(&opened.document, expected);
        assert_eq!(
            opened.entry.hash,
            sha(&serde_json::to_vec(expected).unwrap())
        );
    }
    let restored = store.restore(ID, 1, 6, "restore-old").await.unwrap();
    assert_eq!(restored.document, revisions[0]);
    let backend = Backend::new(&f.0.join("recovery")).unwrap();
    let portable = f.0.join("export.fd");
    let exported = backend.save(&portable, &restored.document, None).unwrap();
    let bytes = fs::read(&portable).unwrap();
    assert_eq!(&bytes[..4], b"FXDK");
    assert_eq!(exported.hash, sha(&bytes));
    assert_eq!(backend.open(&portable).unwrap().document, restored.document);
    store.close().await;
}

#[tokio::test]
async fn distinct_resource_contents_remain_isolated_and_failed_transaction_leaves_no_orphan_assets()
{
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let mut conn = f.connection().await;
    conn.execute("CREATE TRIGGER fail_receipt BEFORE INSERT ON mutations BEGIN SELECT RAISE(ABORT,'injected'); END").await.unwrap();
    assert!(
        store
            .commit(&document(&asset(1, 4096)), None, "fail")
            .await
            .is_err()
    );
    for sql in [
        "SELECT count(*) FROM assets",
        "SELECT count(*) FROM revision_assets",
        "SELECT count(*) FROM documents",
        "SELECT count(*) FROM revisions",
    ] {
        let count: i64 = sqlx::query_scalar(sql).fetch_one(&mut conn).await.unwrap();
        assert_eq!(count, 0);
    }
    conn.execute("DROP TRIGGER fail_receipt").await.unwrap();
    let a = document(&asset(1, 4096));
    let mut b = document(&asset(2, 4096));
    b["id"] = json!("20000000-0000-0000-0000-000000000001");
    store.commit(&a, None, "a").await.unwrap();
    store.commit(&b, None, "b").await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM assets")
            .fetch_one(&mut conn)
            .await
            .unwrap(),
        2
    );
    assert_eq!(store.read(ID, None).await.unwrap().document, a);
    assert_eq!(
        store
            .read(b["id"].as_str().unwrap(), None)
            .await
            .unwrap()
            .document,
        b
    );
    conn.close().await.unwrap();
    store.close().await;
}

#[tokio::test]
async fn missing_or_corrupt_resources_refuse_reads_restores_and_reuse_without_replacing_bytes() {
    for missing in [false, true] {
        let f = Fixture::new();
        let store = WorkspaceStore::open(&f.db()).await.unwrap();
        let doc = document(&asset(9, 4096));
        store.commit(&doc, None, "a").await.unwrap();
        let mut conn = f.connection().await;
        if missing {
            conn.execute("PRAGMA foreign_keys=OFF").await.unwrap();
            conn.execute("DELETE FROM assets").await.unwrap();
        } else {
            conn.execute("UPDATE assets SET value=x'626164'")
                .await
                .unwrap();
        }
        assert_eq!(
            store.read(ID, None).await.unwrap_err().code,
            "WORKSPACE_CORRUPT"
        );
        assert_eq!(
            store.restore(ID, 1, 1, "restore").await.unwrap_err().code,
            "WORKSPACE_CORRUPT"
        );
        assert_eq!(
            store.commit(&doc, Some(1), "next").await.unwrap_err().code,
            "WORKSPACE_CORRUPT"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM revisions")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            1
        );
        conn.close().await.unwrap();
        store.close().await;
    }
}

#[tokio::test]
async fn version_one_upgrade_retains_original_blob_and_all_history_is_readable() {
    let f = Fixture::new();
    fs::write(f.db(), []).unwrap();
    let mut conn = f.connection().await;
    for sql in [
        "CREATE TABLE documents(id TEXT PRIMARY KEY,head_revision INTEGER NOT NULL)",
        "CREATE TABLE revisions(document_id TEXT NOT NULL REFERENCES documents(id),revision INTEGER NOT NULL,name TEXT NOT NULL,hash TEXT NOT NULL,snapshot BLOB NOT NULL,updated_at INTEGER NOT NULL,deleted INTEGER NOT NULL,PRIMARY KEY(document_id,revision))",
        "CREATE TABLE mutations(mutation_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,document_id TEXT NOT NULL,revision INTEGER NOT NULL,FOREIGN KEY(document_id,revision) REFERENCES revisions(document_id,revision))",
        "PRAGMA user_version=1",
    ] {
        conn.execute(sql).await.unwrap();
    }
    let old = document(&asset(42, 64 * 1024));
    let bytes = serde_json::to_vec(&old).unwrap();
    sqlx::query("INSERT INTO documents VALUES(?,1)")
        .bind(ID)
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query("INSERT INTO revisions VALUES(?,1,?,?,?,1,0)")
        .bind(ID)
        .bind(old["name"].as_str().unwrap())
        .bind(sha(&bytes))
        .bind(&bytes)
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    assert_eq!(store.read(ID, None).await.unwrap().document, old);
    let restored = store.restore(ID, 1, 1, "upgrade-restore").await.unwrap();
    assert_eq!(restored.document, old);
    assert_eq!(restored.entry.hash, sha(&bytes));
    let mut conn = f.connection().await;
    assert_eq!(
        sqlx::query_scalar::<_, Vec<u8>>("SELECT snapshot FROM revisions WHERE revision=1")
            .fetch_one(&mut conn)
            .await
            .unwrap(),
        bytes
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT encoding FROM revisions WHERE revision=1")
            .fetch_one(&mut conn)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT encoding FROM revisions WHERE revision=2")
            .fetch_one(&mut conn)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA user_version")
            .fetch_one(&mut conn)
            .await
            .unwrap(),
        futureox_design_desktop_backend::workspace::SCHEMA_VERSION
    );
    conn.close().await.unwrap();
    store.close().await;
}

#[tokio::test]
async fn references_cannot_reinterpret_unknown_text_fields_as_resource_placeholders() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let doc = document(&asset(55, 4096));
    store.commit(&doc, None, "one").await.unwrap();
    let mut conn = f.connection().await;
    let bytes: Vec<u8> = sqlx::query_scalar("SELECT snapshot FROM revisions WHERE revision=1")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    let mut envelope: Value = serde_json::from_slice(&bytes).unwrap();
    envelope["resources"][0]["pointer"] = json!("/extensionData/text");
    envelope["document"]["extensionData"]["text"] = Value::Null;
    sqlx::query("UPDATE revisions SET snapshot=? WHERE revision=1")
        .bind(serde_json::to_vec(&envelope).unwrap())
        .execute(&mut conn)
        .await
        .unwrap();
    assert_eq!(
        store.read(ID, None).await.unwrap_err().code,
        "WORKSPACE_CORRUPT"
    );
    conn.close().await.unwrap();
    store.close().await;
}

#[tokio::test]
#[ignore = "explicit local size/time benchmark with the bundled full CJK font"]
async fn cjk_font_multiple_revision_size_and_time_benchmark() {
    let f = Fixture::new();
    let store = WorkspaceStore::open(&f.db()).await.unwrap();
    let font = fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../frontend/design-client/public/fonts/NotoSansSC.ttf"),
    )
    .unwrap();
    let encoded = base64::engine::general_purpose::STANDARD.encode(&font);
    let mut doc = document(&encoded);
    let raw = serde_json::to_vec(&doc).unwrap().len();
    let started = Instant::now();
    let mut times = Vec::new();
    for revision in 1..=12 {
        doc["name"] = json!(format!("CJK edit {revision}"));
        let now = Instant::now();
        store
            .commit(
                &doc,
                if revision == 1 {
                    None
                } else {
                    Some(revision - 1)
                },
                &format!("edit-{revision}"),
            )
            .await
            .unwrap();
        times.push(now.elapsed().as_millis());
    }
    let mut conn = f.connection().await;
    let assets: i64 = sqlx::query_scalar("SELECT count(*) FROM assets")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    let snapshots: i64 = sqlx::query_scalar("SELECT sum(length(snapshot)) FROM revisions")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(assets, 1);
    assert!(snapshots < 32_000);
    conn.close().await.unwrap();
    store.close().await;
    let file_bytes = fs::metadata(f.db()).unwrap().len();
    assert!(file_bytes < (raw * 2) as u64);
    eprintln!(
        "WORKSPACE_CJK_BENCH {{ profile: {:?}, revisions: 12, fontBytes: {}, originalJsonBytes: {}, assets: {}, snapshotBytes: {}, databaseBytes: {}, oldFullSnapshotBytes: {}, elapsedMs: {}, commitMs: {:?} }}",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        font.len(),
        raw,
        assets,
        snapshots,
        file_bytes,
        raw * 12,
        started.elapsed().as_millis(),
        times
    );
}
