//! Authored source regressions only. All tests in this file are NOT_RUN.
//! The shared parent requires the UNDELIVERED journal scope-A candidate.
use super::*;
use std::sync::atomic::AtomicUsize;

const SOURCE: &[u8] = br#"{ "edit" : {"name":"before","payload":0}, "cold":1844674407370955161600000, "signed":-0.0 }"#;

struct Fixture {
    root: PathBuf,
    source: PathBuf,
    sessions: Sessions,
    status: Value,
}
impl Fixture {
    fn new(source_bytes: &[u8]) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "futureox-fragment-duplicates-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let source = root.join("source.json");
        fs::write(&source, source_bytes).unwrap();
        let sessions = Sessions::new(root.join("cache"));
        let status = sessions.open(
            Open { opening_preview:false, path: source.clone(), document_id: "fragment-test".into(), session_epoch: 1 },
            &AtomicBool::new(false),
        ).unwrap();
        Self { root, source, sessions, status }
    }
    fn request(&self, extra: Value) -> Request {
        let mut value = json!({"owner":self.status["owner"],"expectedRevision":self.status["revision"]});
        value.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }
    fn call(&self, method: &str, extra: Value) -> Value {
        self.sessions.dispatch(method, self.request(extra), &AtomicBool::new(false)).unwrap()
    }
    fn read(&self) -> Value {
        self.call("large.read", json!({"key":"0:1"}))
    }
    fn apply(&mut self, text: &str, request_id: &str) {
        let read = self.read();
        self.status = self.call("large.apply", json!({
            "key":"0:1", "json":text, "expectedHash":read["hash"], "requestId":request_id
        }));
    }
    fn snapshot(&self) -> (Vec<u8>, BTreeMap<PathBuf, Vec<u8>>) {
        let slot = self.sessions.current.lock().unwrap();
        let session = slot.as_ref().unwrap();
        (serde_json::to_vec(session).unwrap(), directory_bytes(&session.directory))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn directory_bytes(directory: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn visit(root: &Path, path: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                visit(root, &entry.path(), files);
            } else {
                assert!(kind.is_file(), "test session unexpectedly contains a non-file");
                files.insert(entry.path().strip_prefix(root).unwrap().to_owned(), fs::read(entry.path()).unwrap());
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(directory, directory, &mut result);
    result
}

fn assert_duplicate_refusal(f: &Fixture, text: &str, request_id: &str) {
    let read = f.read();
    let state_and_files = f.snapshot();
    let draft = text.to_owned();
    let original = fs::read(&f.source).unwrap();
    let error = f.sessions.dispatch(
        "large.apply",
        f.request(json!({"key":"0:1","json":draft,"expectedHash":read["hash"],"requestId":request_id})),
        &AtomicBool::new(false),
    ).unwrap_err();
    assert_eq!(error.code, "LARGE_DOCUMENT_ERROR");
    assert_eq!(error.message, "Duplicate JSON object key in edit fragment");
    assert_eq!(draft, text, "validation must not rewrite the submitted draft");
    // Includes current/undo/redo, revision, saved marker, index locators and
    // additions; every source/spool/index/journal byte and filename is compared.
    assert_eq!(f.snapshot(), state_and_files);
    assert_eq!(fs::read(&f.source).unwrap(), original);
    assert_eq!(f.read(), read);
    assert_eq!(f.call("large.status", json!({})), f.status);
}

#[test]
fn unindexed_duplicate_rejects_before_map_collapse_and_any_publication() {
    let mut f = Fixture::new(SOURCE);
    f.apply(r#"{"name":"one","payload":0}"#, "prepare-one");
    f.apply(r#"{"name":"two","payload":0}"#, "prepare-two");
    f.status = f.call("large.undo", json!({}));
    assert_eq!(f.status["undoCount"], 1);
    assert_eq!(f.status["redoCount"], 1);
    let before_export = f.root.join("before.json");
    f.call("large.export", json!({"path":before_export}));
    f.status = f.call("large.status", json!({}));
    let draft = r#"{"name":"one","payload":{"outer":{"inner":{"x":1,"\u0078":2}}}}"#;
    // Prove this valid JSON reaches the new rule, not an unrelated old parse,
    // key-set, identity, size, or navigation admission error.
    large_json::index(draft.as_bytes(), MAX_FRAGMENT_BYTES).unwrap();
    let raw: BTreeMap<String, Box<RawValue>> = serde_json::from_str(draft).unwrap();
    assert_eq!(raw.keys().map(String::as_str).collect::<Vec<_>>(), vec!["name", "payload"]);
    let collapsed: Value = serde_json::from_str(raw["payload"].get()).unwrap();
    assert_eq!(collapsed["outer"]["inner"]["x"], 2);
    assert_duplicate_refusal(&f, draft, "reject-nested");
    let after_export = f.root.join("after.json");
    f.call("large.export", json!({"path":after_export}));
    assert_eq!(fs::read(before_export).unwrap(), fs::read(after_export).unwrap());
    assert_eq!(fs::read(&f.source).unwrap(), SOURCE);
    let slot = f.sessions.current.lock().unwrap();
    let s = slot.as_ref().unwrap();
    let recovered = recover(&f.root.join("cache"), &f.root.join("not-a-session"), &s.source_hash, s.max_expanded_bytes, &AtomicBool::new(false)).unwrap().unwrap();
    assert_eq!(recovered.revision, s.revision);
    assert_eq!(serde_json::to_vec(&recovered.state).unwrap(), serde_json::to_vec(&s.state).unwrap());
    assert_eq!(serde_json::to_vec(&recovered.undo).unwrap(), serde_json::to_vec(&s.undo).unwrap());
    assert_eq!(serde_json::to_vec(&recovered.redo).unwrap(), serde_json::to_vec(&s.redo).unwrap());
}

#[test]
fn duplicate_top_level_property_refuses_before_raw_map_can_choose_one() {
    let f = Fixture::new(SOURCE);
    let draft = r#"{"name":"before","payload":1,"pay\u006coad":2}"#;
    let collapsed: BTreeMap<String, Box<RawValue>> = serde_json::from_str(draft).unwrap();
    assert_eq!(collapsed.len(), 2);
    assert_eq!(collapsed["payload"].get(), "2");
    assert_duplicate_refusal(&f, draft, "reject-top");
}

#[test]
fn duplicate_rule_diagnostics_do_not_echo_arbitrary_key_or_value_content() {
    let f = Fixture::new(SOURCE);
    let draft = r#"{"name":"before","payload":{"private-key-never-echo":"private-value-one","private-key-never-echo":"private-value-two"}}"#;
    assert_duplicate_refusal(&f, draft, "reject-private");
}

#[test]
fn legacy_duplicate_source_opens_but_resubmitted_ambiguous_fragment_refuses() {
    let legacy = br#"{"edit":{"name":"before","payload":{"deep":{"x":1,"\u0078":2}}},"cold":-0.0}"#;
    let f = Fixture::new(legacy);
    let draft = f.read()["json"].as_str().unwrap().replace("before", "after");
    // The unchanged duplicate-bearing value is deliberately not normalized or
    // silently dropped merely to allow the surrounding property edit.
    assert_duplicate_refusal(&f, &draft, "reject-legacy-resubmit");
    let output = f.root.join("legacy-copy.json");
    f.call("large.export", json!({"path":output}));
    assert_eq!(fs::read(output).unwrap(), legacy);
    assert_eq!(fs::read(&f.source).unwrap(), legacy);
}

#[test]
fn valid_nested_raw_numbers_and_escapes_survive_apply_history_export_and_reopen() {
    let mut f = Fixture::new(SOURCE);
    let payload = r#"{"\u0078":[-0,1E+00,9007199254740993,1844674407370955161600000,1e999999,1e-999999],"雪":"\u96ea\/😀","a":{"x":1},"b":{"\u0078":2}}"#;
    let draft = format!(r#"{{"name":"before","payload":{payload}}}"#);
    f.apply(&draft, "lexical-edit");
    f.status = f.call("large.undo", json!({}));
    let undone = f.root.join("undone.json");
    f.call("large.export", json!({"path":undone}));
    assert_eq!(fs::read(undone).unwrap(), SOURCE);
    f.status = f.call("large.redo", json!({}));
    let output = f.root.join("edited.json");
    f.call("large.export", json!({"path":output}));
    let expected = std::str::from_utf8(SOURCE).unwrap().replace("\"payload\":0", &format!("\"payload\":{payload}"));
    assert_eq!(fs::read(&output).unwrap(), expected.as_bytes());
    assert_eq!(fs::read(&f.source).unwrap(), SOURCE);
    f.call("large.close", json!({}));
    f.status = f.sessions.open(Open { opening_preview:false, path: output.clone(), document_id: "fragment-reopen".into(), session_epoch: 2 }, &AtomicBool::new(false)).unwrap();
    let reopened_output = f.root.join("reopened-copy.json");
    f.call("large.export", json!({"path":reopened_output}));
    assert_eq!(fs::read(reopened_output).unwrap(), expected.as_bytes());
    assert_eq!(fs::read(output).unwrap(), expected.as_bytes());
}

#[test]
fn two_mib_edit_limit_is_inclusive_and_oversize_refusal_is_atomic() {
    let mut f = Fixture::new(SOURCE);
    let prefix = r#"{"name":"before","payload":""#;
    let suffix = "\"}";
    let limit = (MAX_FRAGMENT_BYTES / 2) as usize;
    let exact = format!("{prefix}{}{suffix}", "v".repeat(limit - prefix.len() - suffix.len()));
    assert_eq!(exact.len(), limit);
    let over = format!("{exact} ");
    let read = f.read();
    let before = f.snapshot();
    let error = f.sessions.dispatch("large.apply", f.request(json!({
        "key":"0:1","json":over,"expectedHash":read["hash"],"requestId":"size-over"
    })), &AtomicBool::new(false)).unwrap_err();
    assert_eq!(error.message, "JSON edit fragment exceeds 2 MiB");
    assert_eq!(f.snapshot(), before);
    assert_eq!(fs::read(&f.source).unwrap(), SOURCE);
    f.apply(&exact, "size-exact");
    assert_eq!(f.status["revision"], 1);
    let output = f.root.join("exact-size.json");
    f.call("large.export", json!({"path":output}));
    let payload = &exact[prefix.len() - 1..exact.len() - 1];
    let expected = std::str::from_utf8(SOURCE).unwrap().replace("\"payload\":0", &format!("\"payload\":{payload}"));
    assert_eq!(fs::read(output).unwrap(), expected.as_bytes());
}
