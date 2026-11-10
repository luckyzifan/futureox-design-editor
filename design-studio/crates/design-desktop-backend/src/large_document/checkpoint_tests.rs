//! Scope-A regression drafts. These tests have NOT BEEN RUN for this candidate.
use super::*;
use std::sync::atomic::AtomicUsize;

const SOURCE: &[u8] =
    br#"{"name":"before","unknown":-0.0,"big":9007199254740993}"#;

struct Fixture {
    root: PathBuf,
    source: PathBuf,
    sessions: Sessions,
    status: Value,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "futureox-checkpoint-cap-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let source = root.join("source.json");
        fs::write(&source, SOURCE).unwrap();
        let sessions = Sessions::new(root.join("cache"));
        let status = sessions
            .open(
                Open {
                    opening_preview:false, path: source.clone(),
                    document_id: "checkpoint-test".into(),
                    session_epoch: 1,
                },
                &AtomicBool::new(false),
            )
            .unwrap();
        Self {
            root,
            source,
            sessions,
            status,
        }
    }
    fn request(&self, extra: Value) -> Request {
        request(&self.status, extra)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn request(status: &Value, extra: Value) -> Request {
    let mut value = json!({"owner":status["owner"],"expectedRevision":status["revision"]});
    value
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(value).unwrap()
}

// Only test metadata is padded. Authored source fixtures stay tiny and exact.
// All original names and the replacement contain ASCII needing no JSON escape.
fn pad_checkpoint(s: &mut Session, target: u64) {
    persist(s).unwrap();
    let current = fs::metadata(s.directory.join("journal.json")).unwrap().len();
    let overhead = current - s.name.len() as u64;
    s.name = "p".repeat((target - overhead) as usize);
}

#[test]
fn checkpoint_writer_counts_serialized_utf8_and_escapes_not_characters() {
    let value = json!({"name":"é😀\n\"\\\u{0000}","revision":u64::MAX});
    let expected = serde_json::to_vec(&value).unwrap();
    let mut counter = CheckpointWriter::new(io::sink());
    serde_json::to_writer(&mut counter, &value).unwrap();
    assert_eq!(counter.written_bytes(), expected.len() as u64);
    let mut writer = CheckpointWriter::new(Vec::new());
    serde_json::to_writer(&mut writer, &value).unwrap();
    assert_eq!(writer.get_ref(), &expected);
    assert_eq!(writer.written_bytes(), counter.written_bytes());
}

#[test]
fn serde_checkpoint_writer_propagates_io_failure_as_error() {
    struct FailingWriter;
    impl Write for FailingWriter {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("injected checkpoint write failure"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut writer = CheckpointWriter::new(FailingWriter);
    let error = serde_json::to_writer(&mut writer, &json!({"revision":1})).unwrap_err();
    assert!(error.is_io());
    assert!(error.to_string().contains("injected checkpoint write failure"));
    assert_eq!(writer.written_bytes(), 0);
}

#[test]
fn oversize_preflight_does_not_create_index_or_touch_either_journal() {
    let f = Fixture::new();
    let mut slot = f.sessions.current.lock().unwrap();
    let s = slot.as_mut().unwrap();
    let journal = s.directory.join("journal.json");
    let previous = fs::read(&journal).unwrap();
    let next = s.directory.join("journal.next");
    fs::write(&next, b"retain-existing-temporary").unwrap();
    let index = s.directory.join("index.json");
    fs::remove_file(&index).unwrap();
    s.name = "p".repeat(MAX_CHECKPOINT_BYTES as usize);
    let error = persist(s).unwrap_err();
    assert!(error.message.contains("16 MiB recovery limit"));
    assert!(!index.exists());
    assert_eq!(fs::read(&journal).unwrap(), previous);
    assert_eq!(fs::read(&next).unwrap(), b"retain-existing-temporary");
    fs::remove_file(&next).unwrap();
    assert!(persist(s).is_err());
    assert!(!next.exists());
    assert!(!index.exists());
    assert_eq!(fs::read(&f.source).unwrap(), SOURCE);
}

#[test]
fn exact_limit_publishes_and_recovers_but_one_byte_over_does_not_replace_it() {
    let f = Fixture::new();
    let mut slot = f.sessions.current.lock().unwrap();
    let s = slot.as_mut().unwrap();
    pad_checkpoint(s, MAX_CHECKPOINT_BYTES);
    persist(s).unwrap();
    let journal = s.directory.join("journal.json");
    assert_eq!(fs::metadata(&journal).unwrap().len(), MAX_CHECKPOINT_BYTES);
    let previous_hash = hash_file(&journal, &AtomicBool::new(false)).unwrap();
    s.name.push('x');
    assert!(persist(s).unwrap_err().message.contains("16 MiB recovery limit"));
    assert_eq!(hash_file(&journal, &AtomicBool::new(false)).unwrap(), previous_hash);
    assert!(!s.directory.join("journal.next").exists());
    let recovered = recover(
        &f.root.join("cache"),
        &f.root.join("not-a-session"),
        &s.source_hash,
        s.max_expanded_bytes,
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    assert_eq!(recovered.revision, s.revision);
    assert_eq!(recovered.name.len() + 1, s.name.len());
}

#[test]
fn rejected_apply_preserves_revision_history_index_source_and_recoverable_journal() {
    let f = Fixture::new();
    let cancel = AtomicBool::new(false);
    let read = f
        .sessions
        .dispatch("large.read", f.request(json!({"key":"0:0"})), &cancel)
        .unwrap();
    let (directory, source_hash, journal_hash, state, undo, redo, index, additions) = {
        let mut slot = f.sessions.current.lock().unwrap();
        let s = slot.as_mut().unwrap();
        pad_checkpoint(s, MAX_CHECKPOINT_BYTES);
        persist(s).unwrap();
        (
            s.directory.clone(),
            s.source_hash.clone(),
            hash_file(&s.directory.join("journal.json"), &cancel).unwrap(),
            serde_json::to_vec(&s.state).unwrap(),
            serde_json::to_vec(&s.undo).unwrap(),
            serde_json::to_vec(&s.redo).unwrap(),
            serde_json::to_vec(&s.parts[0].index).unwrap(),
            serde_json::to_vec(&s.parts[0].additions).unwrap(),
        )
    };
    let changed = read["json"].as_str().unwrap().replace("before", "after-longer");
    let error = f
        .sessions
        .dispatch(
            "large.apply",
            f.request(json!({"key":"0:0","json":changed,"expectedHash":read["hash"],"requestId":"cap-reject"})),
            &cancel,
        )
        .unwrap_err();
    assert!(error.message.contains("16 MiB recovery limit"));
    {
        let slot = f.sessions.current.lock().unwrap();
        let s = slot.as_ref().unwrap();
        assert_eq!(s.revision, 0);
        assert_eq!(s.saved_revision, 0);
        assert_eq!(serde_json::to_vec(&s.state).unwrap(), state);
        assert_eq!(serde_json::to_vec(&s.undo).unwrap(), undo);
        assert_eq!(serde_json::to_vec(&s.redo).unwrap(), redo);
        assert_eq!(serde_json::to_vec(&s.parts[0].index).unwrap(), index);
        assert_eq!(serde_json::to_vec(&s.parts[0].additions).unwrap(), additions);
    }
    assert_eq!(hash_file(&directory.join("journal.json"), &cancel).unwrap(), journal_hash);
    assert_eq!(fs::read(&f.source).unwrap(), SOURCE);
    // Scope A preserves the committed prefix, not guaranteed physical tail length.
    let mut prefix = vec![0; SOURCE.len()];
    File::open(directory.join("source")).unwrap().read_exact(&mut prefix).unwrap();
    assert_eq!(prefix, SOURCE);
    assert_eq!(
        f.sessions
            .dispatch("large.read", f.request(json!({"key":"0:0"})), &cancel)
            .unwrap()["json"],
        read["json"]
    );
    let recovered = recover(
        &f.root.join("cache"),
        &f.root.join("not-a-session"),
        &source_hash,
        capacity::source_limit(&f.root).unwrap(),
        &cancel,
    )
    .unwrap()
    .unwrap();
    assert_eq!(recovered.revision, 0);
    assert_eq!(serde_json::to_vec(&recovered.state).unwrap(), state);
}

#[test]
fn autosave_recovery_interrupted_journal_next_is_not_saved() {
    let f = Fixture::new();
    let slot = f.sessions.current.lock().unwrap();
    let s = slot.as_ref().unwrap();
    let journal = fs::read(s.directory.join("journal.json")).unwrap();
    let source_bytes = fs::read(&f.source).unwrap();
    let source_hash = s.source_hash.clone();
    let revision = s.revision;
    let directory = s.directory.clone();
    fs::write(directory.join("journal.next"), b"{\"truncated\":").unwrap();
    drop(slot);
    let recovered = recover(
        &f.root.join("cache"),
        &f.root.join("not-a-session"),
        &source_hash,
        capacity::source_limit(&f.root).unwrap(),
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    assert_eq!(recovered.revision, revision);
    assert_eq!(fs::read(directory.join("journal.json")).unwrap(), journal);
    assert_eq!(fs::read(directory.join("journal.next")).unwrap(), b"{\"truncated\":");
    assert_eq!(fs::read(&f.source).unwrap(), source_bytes);
}

#[test]
fn prepublication_io_failure_still_preserves_the_previous_journal() {
    let f = Fixture::new();
    let slot = f.sessions.current.lock().unwrap();
    let s = slot.as_ref().unwrap();
    let journal = s.directory.join("journal.json");
    let previous = fs::read(&journal).unwrap();
    // File::create must fail for this directory on supported host platforms.
    fs::create_dir(s.directory.join("journal.next")).unwrap();
    assert!(persist(s).is_err());
    assert_eq!(fs::read(journal).unwrap(), previous);
}

fn assert_history_size_failure(method: &str) {
    let mut f = Fixture::new();
    let cancel = AtomicBool::new(false);
    let (directory, previous_hash, state, undo, redo, index) = {
        let mut slot = f.sessions.current.lock().unwrap();
        let s = slot.as_mut().unwrap();
        // Moving one identical state between history stacks preserves its byte
        // count. Advancing revision 9 to 10 is the sole extra serialized byte.
        s.revision = 9;
        if method == "large.undo" {
            s.undo.push(s.state.clone());
        } else {
            s.redo.push(s.state.clone());
        }
        pad_checkpoint(s, MAX_CHECKPOINT_BYTES);
        persist(s).unwrap();
        (
            s.directory.clone(),
            hash_file(&s.directory.join("journal.json"), &cancel).unwrap(),
            serde_json::to_vec(&s.state).unwrap(),
            serde_json::to_vec(&s.undo).unwrap(),
            serde_json::to_vec(&s.redo).unwrap(),
            serde_json::to_vec(&s.parts[0].index).unwrap(),
        )
    };
    f.status["revision"] = json!(9);
    let error = f.sessions.dispatch(method, f.request(json!({})), &cancel).unwrap_err();
    assert!(error.message.contains("16 MiB recovery limit"));
    let slot = f.sessions.current.lock().unwrap();
    let s = slot.as_ref().unwrap();
    assert_eq!(s.revision, 9);
    assert_eq!(serde_json::to_vec(&s.state).unwrap(), state);
    assert_eq!(serde_json::to_vec(&s.undo).unwrap(), undo);
    assert_eq!(serde_json::to_vec(&s.redo).unwrap(), redo);
    assert_eq!(serde_json::to_vec(&s.parts[0].index).unwrap(), index);
    assert_eq!(hash_file(&directory.join("journal.json"), &cancel).unwrap(), previous_hash);
    assert_eq!(fs::read(&f.source).unwrap(), SOURCE);
}

#[test]
fn rejected_undo_preserves_both_history_stacks_and_index() {
    assert_history_size_failure("large.undo");
}

#[test]
fn rejected_redo_preserves_both_history_stacks_and_index() {
    assert_history_size_failure("large.redo");
}

#[test]
fn published_export_keeps_success_and_saved_marker_warning_if_checkpoint_grows_over_limit() {
    let mut f = Fixture::new();
    let cancel = AtomicBool::new(false);
    let (directory, source_hash, previous_hash) = {
        let mut slot = f.sessions.current.lock().unwrap();
        let s = slot.as_mut().unwrap();
        // A two-digit saved revision adds exactly one byte to the checkpoint.
        s.revision = 10;
        s.saved_revision = 0;
        pad_checkpoint(s, MAX_CHECKPOINT_BYTES);
        persist(s).unwrap();
        (
            s.directory.clone(),
            s.source_hash.clone(),
            hash_file(&s.directory.join("journal.json"), &cancel).unwrap(),
        )
    };
    f.status["revision"] = json!(10);
    let output = f.root.join("output.json");
    let result = f
        .sessions
        .dispatch("large.export", f.request(json!({"path":output})), &cancel)
        .unwrap();
    assert_eq!(result["exported"], true);
    assert_eq!(result["exportedRevision"], 10);
    assert_eq!(result["document"]["dirty"], false);
    assert!(result["warning"].as_str().unwrap().contains("Export was published"));
    assert_eq!(fs::read(&output).unwrap(), SOURCE);
    assert_eq!(fs::read(&f.source).unwrap(), SOURCE);
    assert_eq!(
        hash_file(&directory.join("journal.json"), &cancel).unwrap(),
        previous_hash
    );
    assert_eq!(
        f.sessions.current.lock().unwrap().as_ref().unwrap().saved_revision,
        10
    );
    let recovered = recover(
        &f.root.join("cache"),
        &f.root.join("not-a-session"),
        &source_hash,
        capacity::source_limit(&f.root).unwrap(),
        &cancel,
    )
    .unwrap()
    .unwrap();
    assert_eq!(recovered.revision, 10);
    assert_eq!(recovered.saved_revision, 0);
}

fn source_spool_bytes(root: &Path) -> Vec<u64> {
    let mut sizes = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return sizes;
    };
    for entry in entries.flatten() {
        let source = entry.path().join("source");
        if let Ok(meta) = fs::symlink_metadata(&source) {
            if meta.is_file() && !meta.file_type().is_symlink() {
                sizes.push(meta.len());
            }
        }
    }
    sizes.sort_unstable();
    sizes
}

fn close_session(f: &Fixture) {
    f.sessions
        .dispatch("large.close", f.request(json!({})), &AtomicBool::new(false))
        .unwrap();
}

#[test]
fn autosave_recovery_reopen_skips_second_copy_when_allocation_is_blocked() {
    let f = Fixture::new();
    let original = fs::read(&f.source).unwrap();
    let journal_dir = f.sessions.current.lock().unwrap().as_ref().unwrap().directory.clone();
    let journal_before = fs::read(journal_dir.join("journal.json")).unwrap();
    let copies_before = source_spool_bytes(&f.root.join("cache"));
    close_session(&f);
    let blocker = f.root.join("cache").join("reopen-2");
    fs::write(&blocker, b"not-a-session-directory").unwrap();
    let opened = f.sessions.open(
        Open {
            opening_preview: false,
            path: f.source.clone(),
            document_id: "reopen".into(),
            session_epoch: 2,
        },
        &AtomicBool::new(false),
    );
    let copies_after = source_spool_bytes(&f.root.join("cache"));
    eprintln!(
        "MEASURE reopen_blocked_allocation source_bytes={} journal_bytes={} copies_before={copies_before:?} copies_after={copies_after:?} blocker_bytes={} original_bytes={} status={}",
        original.len(),
        journal_before.len(),
        fs::metadata(&blocker).unwrap().len(),
        fs::read(&f.source).unwrap().len(),
        opened.as_ref().map(|value| format!("ok revision={}", value["revision"])).unwrap_or_else(|error| format!("error {}: {}", error.code, error.message))
    );
    let opened = opened.expect("last consistent session reopens without a second source copy");
    assert_eq!(opened["revision"], 0);
    assert!(opened.get("saveWarning").is_none());
    assert_eq!(fs::read(&f.source).unwrap(), original);
    let journal_after: Value = serde_json::from_slice(&fs::read(journal_dir.join("journal.json")).unwrap()).unwrap();
    let journal_before: Value = serde_json::from_slice(&journal_before).unwrap();
    assert_eq!(journal_after["sourceHash"], journal_before["sourceHash"]);
    assert_eq!(journal_after["revision"], journal_before["revision"]);
    assert_eq!(journal_after["state"], journal_before["state"]);
    assert_eq!(journal_after["owner"]["documentId"], "reopen");
    assert_eq!(fs::read(&blocker).unwrap(), b"not-a-session-directory");
    assert_eq!(copies_after, copies_before);
    assert_eq!(copies_after.len(), 1);
    assert_eq!(copies_after[0], original.len() as u64);
}

#[test]
fn autosave_recovery_checkpoint_refresh_failure_reopens_last_journal() {
    let f = Fixture::new();
    let original = fs::read(&f.source).unwrap();
    let journal_dir = f.sessions.current.lock().unwrap().as_ref().unwrap().directory.clone();
    close_session(&f);
    let journal_before = fs::read(journal_dir.join("journal.json")).unwrap();
    fs::create_dir(journal_dir.join("journal.next")).unwrap();
    let opened = f.sessions.open(
        Open {
            opening_preview: false,
            path: f.source.clone(),
            document_id: "refresh".into(),
            session_epoch: 2,
        },
        &AtomicBool::new(false),
    );
    eprintln!(
        "MEASURE checkpoint_refresh journal_bytes={} original_bytes={} journal_next_is_dir={} status={}",
        journal_before.len(),
        original.len(),
        journal_dir.join("journal.next").is_dir(),
        opened.as_ref().map(|value| format!("ok warning={}", value.get("saveWarning").and_then(|v| v.as_str()).unwrap_or(""))).unwrap_or_else(|error| format!("error {}: {}", error.code, error.message))
    );
    let opened = opened.expect("write failure while refreshing a checkpoint still reopens it");
    let warning = opened["saveWarning"].as_str().unwrap();
    assert!(warning.contains("SOURCE_WRITE_FAILED"));
    assert!(warning.contains("not written"));
    assert!(!warning.contains("saved"));
    assert_eq!(opened["revision"], 0);
    assert_eq!(fs::read(&f.source).unwrap(), original);
    assert_eq!(fs::read(journal_dir.join("journal.json")).unwrap(), journal_before);
    assert!(journal_dir.join("journal.next").is_dir());
    let status = f
        .sessions
        .dispatch("large.status", request(&opened, json!({})), &AtomicBool::new(false))
        .unwrap();
    assert_eq!(status["revision"], opened["revision"]);
    assert_eq!(status["dirty"], false);
}

#[test]
fn autosave_recovery_unpublished_crash_copy_is_discarded() {
    let root = std::env::temp_dir().join(format!(
        "futureox-crash-copy-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let cache = root.join("cache");
    fs::create_dir(&cache).unwrap();
    let leaked = cache.join("leak-1");
    fs::create_dir(&leaked).unwrap();
    let partial = vec![b'x'; 12345];
    fs::write(leaked.join("source"), &partial).unwrap();
    let source = root.join("original.json");
    fs::write(&source, SOURCE).unwrap();
    let sessions = Sessions::new(cache);
    let opened = sessions.open(
        Open {
            opening_preview: false,
            path: source.clone(),
            document_id: "kept".into(),
            session_epoch: 1,
        },
        &AtomicBool::new(false),
    );
    let leaked_after = fs::symlink_metadata(leaked.join("source")).map(|meta| meta.len()).unwrap_or(0);
    eprintln!(
        "MEASURE unpublished_crash leaked_bytes_before=12345 leaked_bytes_after={leaked_after} original_bytes={} status={}",
        fs::read(&source).unwrap().len(),
        opened.as_ref().map(|value| format!("ok revision={}", value["revision"])).unwrap_or_else(|error| format!("error {}: {}", error.code, error.message))
    );
    assert!(opened.is_ok());
    assert_eq!(leaked_after, 0);
    assert!(!leaked.exists());
    assert_eq!(fs::read(&source).unwrap(), SOURCE);
    let _ = fs::remove_dir_all(&root);
}
