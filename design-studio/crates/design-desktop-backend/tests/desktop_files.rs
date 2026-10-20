use futureox_design_desktop_backend::{Backend, MAX_DOCUMENT_BYTES, MAX_RECOVERIES, protocol};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

struct Fixture {
    root: PathBuf,
    backend: Backend,
}

#[test]
fn legacy_extension_is_not_an_open_or_save_route() {
    let f = Fixture::new();
    for name in ["old.forma", "old.FORMA"] {
        let path = f.root.join(name);
        fs::write(&path, serde_json::to_vec(&document()).unwrap()).unwrap();
        assert_eq!(f.backend.open(&path).unwrap_err().code, "INVALID_PATH");
        assert_eq!(
            f.backend.save(&path, &document(), None).unwrap_err().code,
            "INVALID_PATH"
        );
    }
}
impl Fixture {
    fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "forma-desktop-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let backend = Backend::new(&root.join("recovery")).unwrap();
        Self { root, backend }
    }
    fn path(&self) -> PathBuf {
        self.root.join("设计 – 雪 ❄.fd")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn document() -> Value {
    json!({"schemaVersion":6,"id":"10000000-0000-0000-0000-000000000001","name":"设计 – 雪 ❄",
        "pages":[{"id":"10000000-0000-0000-0000-000000000002","name":"Page","background":"#ffffff","children":[]}],
        "nodes":{}})
}

fn request(backend: &Backend, id: Value, method: &str, params: Value) -> protocol::Response {
    protocol::handle_frame(
        backend,
        &serde_json::to_vec(&json!({"id":id,"method":method,"params":params})).unwrap(),
    )
}

#[test]
fn unicode_open_save_and_repeated_save_keep_compatible_schema_and_unknown_fields() {
    let f = Fixture::new();
    for schema in 1..=6 {
        let mut doc = document();
        doc["schemaVersion"] = json!(schema);
        doc["extensionData"] = json!({"keep":[1,{"未知":"value"}]});
        doc["pages"][0]["extension"] = json!(false);
        let path = f.root.join(format!("设计-{schema}.fd"));
        let first = f.backend.save(&path, &doc, None).unwrap();
        let opened = f.backend.open(&path).unwrap();
        assert_eq!(opened.document, doc);
        assert_eq!(first.hash, opened.hash);
        doc["name"] = json!("Changed");
        let second = f.backend.save(&path, &doc, Some(&opened.hash)).unwrap();
        assert_ne!(first.hash, second.hash);
        let repeated = f.backend.save(&path, &doc, Some(&second.hash)).unwrap();
        assert_eq!(second.hash, repeated.hash);
        assert_eq!(f.backend.open(&path).unwrap().document, doc);
    }
}

#[test]
fn malformed_and_kernel_invalid_documents_preserve_original() {
    let f = Fixture::new();
    let saved = f.backend.save(&f.path(), &document(), None).unwrap();
    let original = fs::read(f.path()).unwrap();
    for malformed in [json!({}), json!({"schemaVersion":7}), {
        let mut doc = document();
        doc["pages"] = json!([]);
        doc
    }] {
        assert_eq!(
            f.backend
                .save(&f.path(), &malformed, Some(&saved.hash))
                .unwrap_err()
                .code,
            "INVALID_DOCUMENT"
        );
        assert_eq!(fs::read(f.path()).unwrap(), original);
    }
    fs::write(f.path(), b"{malformed").unwrap();
    assert_eq!(
        f.backend.open(&f.path()).unwrap_err().code,
        "INVALID_DOCUMENT"
    );
    assert_eq!(fs::read(f.path()).unwrap(), b"{malformed");
    assert!(!fs::read_dir(&f.root).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".fd-write-")
    }));
}

#[test]
fn validates_uuid_ids_and_repeated_pages() {
    let f = Fixture::new();
    let mut invalid = document();
    invalid["id"] = json!("../not-a-document-id");
    assert_eq!(
        f.backend.save(&f.path(), &invalid, None).unwrap_err().code,
        "INVALID_DOCUMENT"
    );
    let mut invalid = document();
    let duplicate = invalid["pages"][0].clone();
    invalid["pages"].as_array_mut().unwrap().push(duplicate);
    assert_eq!(
        f.backend.save(&f.path(), &invalid, None).unwrap_err().code,
        "INVALID_DOCUMENT"
    );
}

#[test]
fn kernel_enforces_schema_six_variable_modes_on_native_boundary() {
    let f = Fixture::new();
    let mut doc = document();
    let node_id = "10000000-0000-0000-0000-000000000003";
    doc["designSystem"] = json!({"collections":{"theme":{"name":"Theme","modes":["light","dark"],"defaultMode":"light"}},"variables":{},"styles":{}});
    doc["pages"][0]["children"] = json!([node_id]);
    doc["nodes"][node_id] = json!({"id":node_id,"kind":"rectangle","width":10,"height":10,"variableModes":{"theme":"dark"}});
    let saved = f.backend.save(&f.path(), &doc, None).unwrap();
    assert_eq!(f.backend.open(&f.path()).unwrap().document, doc);
    doc["schemaVersion"] = json!(5);
    assert_eq!(
        f.backend
            .save(&f.path(), &doc, Some(&saved.hash))
            .unwrap_err()
            .code,
        "INVALID_DOCUMENT"
    );
    doc["schemaVersion"] = json!(6);
    doc["nodes"][node_id]["variableModes"]["theme"] = json!("missing");
    assert_eq!(
        f.backend
            .save(&f.path(), &doc, Some(&saved.hash))
            .unwrap_err()
            .code,
        "INVALID_DOCUMENT"
    );
}

#[test]
fn observed_external_modification_and_create_collision_are_conflicts() {
    let f = Fixture::new();
    let original = f.backend.save(&f.path(), &document(), None).unwrap();
    assert_eq!(
        f.backend
            .save(&f.path(), &document(), None)
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    let mut external = document();
    external["name"] = json!("External editor");
    fs::write(f.path(), serde_json::to_vec(&external).unwrap()).unwrap();
    let bytes = fs::read(f.path()).unwrap();
    assert_eq!(
        f.backend
            .save(&f.path(), &document(), Some(&original.hash))
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    assert_eq!(fs::read(f.path()).unwrap(), bytes);
    fs::remove_file(f.path()).unwrap();
    assert_eq!(
        f.backend
            .save(&f.path(), &document(), Some(&original.hash))
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    assert!(!f.path().exists());
}

#[test]
fn stat_captures_explicit_overwrite_baseline_without_parsing_destination() {
    let f = Fixture::new();
    assert!(f.backend.stat(&f.path()).unwrap().hash.is_none());
    fs::write(
        f.path(),
        b"older invalid file kept until user approves overwrite",
    )
    .unwrap();
    let baseline = f.backend.stat(&f.path()).unwrap().hash.unwrap();
    f.backend
        .save(&f.path(), &document(), Some(&baseline))
        .unwrap();
    assert_eq!(f.backend.open(&f.path()).unwrap().document, document());
}

#[test]
fn rejects_oversized_files_before_read_and_oversized_save_before_replacement() {
    let f = Fixture::new();
    let file = fs::File::create(f.path()).unwrap();
    file.set_len(MAX_DOCUMENT_BYTES as u64 + 1).unwrap();
    assert_eq!(
        f.backend.open(&f.path()).unwrap_err().code,
        "DOCUMENT_TOO_LARGE"
    );
    fs::remove_file(f.path()).unwrap();
    let saved = f.backend.save(&f.path(), &document(), None).unwrap();
    let mut oversized = document();
    oversized["extension"] = json!("x".repeat(MAX_DOCUMENT_BYTES));
    assert_eq!(
        f.backend
            .save(&f.path(), &oversized, Some(&saved.hash))
            .unwrap_err()
            .code,
        "DOCUMENT_TOO_LARGE"
    );
    assert_eq!(f.backend.open(&f.path()).unwrap().hash, saved.hash);
}

#[test]
fn documents_between_sixteen_and_thirty_two_mib_remain_supported() {
    let f = Fixture::new();
    let mut large = document();
    large["embeddedExtension"] = json!("x".repeat(17 * 1024 * 1024));
    f.backend.save(&f.path(), &large, None).unwrap();
    assert_eq!(f.backend.open(&f.path()).unwrap().document, large);
}

#[test]
fn rejects_relative_non_forma_directory_and_bad_hash_inputs() {
    let f = Fixture::new();
    for path in [PathBuf::from("relative.fd"), f.root.join("file.txt")] {
        assert_eq!(
            f.backend.save(&path, &document(), None).unwrap_err().code,
            "INVALID_PATH"
        );
    }
    fs::create_dir(f.path()).unwrap();
    assert_eq!(f.backend.open(&f.path()).unwrap_err().code, "INVALID_PATH");
    assert_eq!(
        f.backend
            .save(&f.root.join("other.fd"), &document(), Some("wrong"))
            .unwrap_err()
            .code,
        "INVALID_REQUEST"
    );
}

#[cfg(unix)]
#[test]
fn refuses_leaf_symlinks_and_readonly_originals() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let f = Fixture::new();
    let other = f.root.join("other.fd");
    f.backend.save(&other, &document(), None).unwrap();
    symlink(&other, f.path()).unwrap();
    for result in [
        f.backend.open(&f.path()).map(|_| ()),
        f.backend.save(&f.path(), &document(), None).map(|_| ()),
    ] {
        assert_eq!(result.unwrap_err().code, "INVALID_PATH");
    }
    let baseline = f.backend.stat(&other).unwrap().hash.unwrap();
    fs::set_permissions(&other, fs::Permissions::from_mode(0o400)).unwrap();
    assert_eq!(
        f.backend
            .save(&other, &document(), Some(&baseline))
            .unwrap_err()
            .code,
        "READ_ONLY"
    );
    assert_eq!(f.backend.open(&other).unwrap().hash, baseline);
}

#[test]
fn recovery_survives_restart_requires_explicit_restore_and_never_changes_source() {
    let f = Fixture::new();
    let source = f.backend.save(&f.path(), &document(), None).unwrap();
    let mut edited = document();
    edited["name"] = json!("Unsaved work");
    let snapshot = f
        .backend
        .recovery_write("session-A", &edited, f.path().to_str(), Some(&source.hash))
        .unwrap();
    let reopened = Backend::new(&f.root.join("recovery")).unwrap();
    let list = reopened.recovery_list().unwrap();
    assert_eq!(list.entries.len(), 1);
    assert!(list.issues.is_empty());
    assert_eq!(list.entries[0].hash, snapshot.hash);
    assert_eq!(
        reopened.recovery_read("session-A").unwrap().document,
        edited
    );
    assert_eq!(reopened.open(&f.path()).unwrap().document, document());
    edited["name"] = json!("Newer unsaved work");
    reopened
        .recovery_write("session-A", &edited, f.path().to_str(), Some(&source.hash))
        .unwrap();
    assert_eq!(
        reopened.recovery_read("session-A").unwrap().document,
        edited
    );
    reopened
        .save(&f.path(), &edited, Some(&source.hash))
        .unwrap();
    assert_eq!(
        reopened.recovery_list().unwrap().entries.len(),
        1,
        "save cannot silently discard recovery"
    );
    assert!(reopened.recovery_remove("session-A").unwrap());
    assert!(!reopened.recovery_remove("session-A").unwrap());
}

#[test]
fn corrupt_recovery_is_reported_and_retained_while_other_snapshots_remain_usable() {
    let f = Fixture::new();
    f.backend
        .recovery_write("good", &document(), None, None)
        .unwrap();
    let bad = f.root.join("recovery/bad.recovery.json");
    fs::write(&bad, b"broken snapshot").unwrap();
    let list = f.backend.recovery_list().unwrap();
    assert_eq!(list.entries.len(), 1);
    assert_eq!(list.issues.len(), 1);
    assert_eq!(list.issues[0].recovery_id, "bad");
    assert_eq!(
        f.backend
            .recovery_write("bad", &document(), None, None)
            .unwrap_err()
            .code,
        "INVALID_RECOVERY"
    );
    assert_eq!(fs::read(bad).unwrap(), b"broken snapshot");
}

#[test]
fn recovery_hash_tampering_is_detected_and_not_overwritten() {
    let f = Fixture::new();
    f.backend
        .recovery_write("session", &document(), None, None)
        .unwrap();
    let path = f.root.join("recovery/session.recovery.json");
    let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["document"]["name"] = json!("tampered");
    fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    assert_eq!(
        f.backend.recovery_read("session").unwrap_err().code,
        "INVALID_RECOVERY"
    );
    assert_eq!(
        f.backend
            .recovery_write("session", &document(), None, None)
            .unwrap_err()
            .code,
        "INVALID_RECOVERY"
    );
}

#[test]
fn recovery_list_does_not_reflect_untrusted_persisted_warnings() {
    let f = Fixture::new();
    f.backend
        .recovery_write("session", &document(), None, None)
        .unwrap();
    let path = f.root.join("recovery/session.recovery.json");
    let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["warning"] = json!("untrusted metadata".repeat(1000));
    fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    let list = f.backend.recovery_list().unwrap();
    assert!(list.issues.is_empty());
    assert!(list.entries[0].warning.is_none());
}

#[test]
fn recovery_ids_are_not_paths_and_snapshots_are_never_automatically_evicted() {
    let f = Fixture::new();
    for id in ["../escape", "x/y", "", "雪"] {
        assert_eq!(
            f.backend
                .recovery_write(id, &document(), None, None)
                .unwrap_err()
                .code,
            "INVALID_REQUEST"
        );
    }
    for index in 0..MAX_RECOVERIES {
        f.backend
            .recovery_write(&format!("session-{index}"), &document(), None, None)
            .unwrap();
    }
    assert_eq!(
        f.backend
            .recovery_write("extra", &document(), None, None)
            .unwrap_err()
            .code,
        "RECOVERY_LIMIT"
    );
    assert_eq!(
        f.backend.recovery_list().unwrap().entries.len(),
        MAX_RECOVERIES
    );
    f.backend
        .recovery_write("session-0", &document(), None, None)
        .unwrap();
    f.backend.recovery_remove("session-0").unwrap();
    f.backend
        .recovery_write("extra", &document(), None, None)
        .unwrap();
}

#[test]
fn protocol_is_correlated_strict_and_recovers_after_invalid_requests() {
    let f = Fixture::new();
    assert_eq!(
        protocol::handle_frame(&f.backend, b"not-json")
            .error
            .unwrap()
            .code,
        "INVALID_JSON"
    );
    let response = request(&f.backend, json!("r1"), "unknown", json!({}));
    assert_eq!(response.id, json!("r1"));
    assert_eq!(response.error.unwrap().code, "UNKNOWN_METHOD");
    for params in [
        json!({"path":f.path(),"document":document()}),
        json!({"path":f.path(),"document":document(),"expectedHash":false}),
    ] {
        assert_eq!(
            request(&f.backend, json!(1), "save", params)
                .error
                .unwrap()
                .code,
            "INVALID_REQUEST"
        );
    }
    assert_eq!(
        request(&f.backend, json!({"nested":"id"}), "health", json!({}))
            .error
            .unwrap()
            .code,
        "INVALID_REQUEST"
    );
    assert_eq!(
        request(&f.backend, json!(1), "health", json!({"unexpected":true}))
            .error
            .unwrap()
            .code,
        "INVALID_REQUEST"
    );
    let response = request(&f.backend, json!(2), "health", json!({}));
    assert_eq!(response.id, json!(2));
    assert_eq!(
        response.result.unwrap()["maxDocumentBytes"],
        MAX_DOCUMENT_BYTES
    );
    assert!(!f.path().exists());
}

#[test]
fn actual_stdio_process_returns_only_json_responses_and_exits_on_eof() {
    let f = Fixture::new();
    let mut child = Command::new(env!("CARGO_BIN_EXE_futureox-design-desktop-backend"))
        .arg("--recovery-dir")
        .arg(f.root.join("child-recovery"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "not json").unwrap();
    for request in [
        json!({"id":1,"method":"save","params":{"path":f.path(),"document":document(),"expectedHash":null}}),
        json!({"id":2,"method":"open","params":{"path":f.path()}}),
        json!({"id":"final","method":"health","params":{}}),
    ] {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let lines: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 4);
    assert_eq!(lines[0]["error"]["code"], "INVALID_JSON");
    // Control responses may bypass filesystem work; mutation jobs remain FIFO.
    let save = lines.iter().position(|line| line["id"] == 1).unwrap();
    let open = lines.iter().position(|line| line["id"] == 2).unwrap();
    assert!(save < open);
    assert!(lines[save].get("error").is_none());
    assert_eq!(lines[open]["result"]["document"], document());
    assert!(lines.iter().any(|line| line["id"] == "final"));
}

#[test]
fn startup_requires_an_explicit_app_owned_recovery_directory() {
    let output = Command::new(env!("CARGO_BIN_EXE_futureox-design-desktop-backend"))
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("--recovery-dir")
    );
    assert!(Backend::new(Path::new("relative")).is_err());
}

#[test]
fn binary_forma_is_default_and_legacy_json_is_still_opened_losslessly() {
    let f = Fixture::new();
    let mut doc = document();
    doc["extensions"] = json!({"empty":null,"value":0.12345678901234567,"unicode":"渐变纹理🖌"});
    fs::write(f.path(), serde_json::to_vec(&doc).unwrap()).unwrap();
    let before = f.backend.open(&f.path()).unwrap();
    f.backend.save(&f.path(), &doc, Some(&before.hash)).unwrap();
    let bytes = fs::read(f.path()).unwrap();
    assert_eq!(&bytes[..4], b"FXDK");
    assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), 2);
    assert_eq!(f.backend.open(&f.path()).unwrap().document, doc);
    let mut corrupt = bytes;
    let i = corrupt
        .windows(10)
        .position(|v| v == b"extensions")
        .unwrap();
    corrupt[i] = b'X';
    fs::write(f.path(), &corrupt).unwrap();
    assert_eq!(
        f.backend.open(&f.path()).unwrap_err().code,
        "INVALID_DOCUMENT"
    );
}

#[test]
fn fd_extension_metadata_roundtrips_and_required_semantics_never_replace_original() {
    let f = Fixture::new();
    let mut doc = document();
    doc["fdCompatibility"] = json!({"contractVersion":1,"requiredCapabilities":[],"extensions":{
        "org.example/metadata":{"nested":[null,true,1.25,"文字"],"url":"file:///inert"}
    }});
    let saved = f.backend.save(&f.path(), &doc, None).unwrap();
    assert_eq!(f.backend.open(&f.path()).unwrap().document, doc);
    let original = fs::read(f.path()).unwrap();
    doc["fdCompatibility"]["requiredCapabilities"] = json!(["org.example/render"]);
    assert_eq!(f.backend.save(&f.path(), &doc, Some(&saved.hash)).unwrap_err().code, "INVALID_DOCUMENT");
    assert_eq!(fs::read(f.path()).unwrap(), original);
    let incoming = f.root.join("unknown-required.fd");
    fs::write(&incoming, serde_json::to_vec(&doc).unwrap()).unwrap();
    assert_eq!(f.backend.open(&incoming).unwrap_err().code, "INVALID_DOCUMENT");
}
