//! Modeled Sketch source-storage regressions, not real-device/GPU acceptance.
use super::*;
use std::sync::atomic::AtomicUsize;

const RECT: &str = "10000000-0000-4000-8000-000000000001";
const OTHER: &str = "10000000-0000-4000-8000-000000000002";
const PAGE: &str = "10000000-0000-4000-8000-000000000010";
const SOURCE_PAGE: &str = r#"{
  "_class":"page", "do_objectID":"10000000-0000-4000-8000-000000000010",
  "name":"source page", "privatePage": { "number":1e+02, "signedZero":-0.0 },
  "layers":[
    {"_class":"rectangle","do_objectID":"10000000-0000-4000-8000-000000000001","name":"original rectangle","frame":{"x":0,"y":0,"width":100,"height":80},"fixedRadius":0,"userInfo": { "com.vendor.raw": { "bytes":1e+02, "zero":-0.0 }, "com.futureox.design-kernel": { "unknownFutureField": [ 1, 2, 3 ] } }},
    {"_class":"rectangle","do_objectID":"10000000-0000-4000-8000-000000000002","name":"cold sibling","frame":{"x":120,"y":0,"width":20,"height":20},"privateUnknown": { "bytes":1e+02 }}
  ]
}"#;

struct Fixture {
    root: PathBuf,
    source: PathBuf,
    members: BTreeMap<String, Vec<u8>>,
    sessions: Sessions,
}
impl Fixture {
    fn new(page: &str) -> (Self, Value) {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!("futureox-source-roundtrip-{}-{}",
            std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&root).unwrap();
        let source = root.join("modeled.sketch");
        let members = BTreeMap::from([
            ("meta.json".into(), br#"{"version":136,"unknownMeta": [ 1, 2 ]}"#.to_vec()),
            ("document.json".into(), format!(r#"{{"colorSpace":1,"pages":[{{"_ref":"pages/{PAGE}"}}]}}"#).into_bytes()),
            (format!("pages/{PAGE}.json"), page.as_bytes().to_vec()),
            ("user.json".into(), br#"{ "opaque": -0.0 }"#.to_vec()),
            ("previews/preview.png".into(), vec![0, 1, 255, 128, 17]),
        ]);
        let mut zip = zip::ZipWriter::new(File::create(&source).unwrap());
        for (name, bytes) in &members {
            zip.start_file(name, zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        let sessions = Sessions::new(root.join("cache"));
        let status = sessions.open(Open { path: source.clone(), document_id: "source-test".into(), session_epoch: 1 }, &AtomicBool::new(false)).unwrap();
        (Self { root, source, members, sessions }, status)
    }
    fn request(status: &Value, extra: Value) -> Request {
        let mut request = json!({"owner":status["owner"], "expectedRevision":status["revision"]});
        request.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        serde_json::from_value(request).unwrap()
    }
    fn call(&self, status: &Value, method: &str, extra: Value) -> Result<Value> {
        self.sessions.dispatch(method, Self::request(status, extra), &AtomicBool::new(false))
    }
    fn key(&self, id: &str) -> String {
        let slot = self.sessions.current.lock().unwrap();
        let session = slot.as_ref().unwrap();
        let matches = session.parts.iter().enumerate().flat_map(|(p, part)|
            part.index.entries.iter().enumerate().filter(move |(_, e)| e.id == id)
                .map(move |(n, _)| format!("{p}:{n}"))).collect::<Vec<_>>();
        assert_eq!(matches.len(), 1);
        matches[0].clone()
    }
    fn snapshot(&self) -> (Vec<u8>, BTreeMap<PathBuf, Vec<u8>>, Value, Option<projection::Projection>) {
        fn collect(root: &Path, directory: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for entry in fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    collect(root, &path, files);
                } else {
                    files.insert(path.strip_prefix(root).unwrap().to_owned(), fs::read(path).unwrap());
                }
            }
        }
        let slot = self.sessions.current.lock().unwrap();
        let s = slot.as_ref().unwrap();
        // Include index/checkpoint/spill files, not only the original part spools.
        let mut files = BTreeMap::new();
        collect(&s.directory, &s.directory, &mut files);
        let scene = s.scene.as_ref().map(|scene| json!({"key":scene.key,"revision":scene.revision,
            "document":scene.document,"bytes":scene.bytes,"hash":scene.hash,
            "initialDto":fs::read(&scene.path).unwrap()})).unwrap_or(Value::Null);
        (serde_json::to_vec(s).unwrap(), files, scene, s.projection.clone())
    }
    fn export_members(&self, status: &Value, name: &str) -> BTreeMap<String, Vec<u8>> {
        let output = self.root.join(name);
        self.call(status, "large.export", json!({"path":output})).unwrap();
        let mut archive = zip::ZipArchive::new(File::open(output).unwrap()).unwrap();
        (0..archive.len()).map(|i| {
            let mut member = archive.by_index(i).unwrap();
            let name = member.name().to_owned();
            let mut bytes = Vec::new();
            member.read_to_end(&mut bytes).unwrap();
            (name, bytes)
        }).collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); }
}

#[test]
fn native_canvas_snapshot_has_one_artboard_and_keeps_all_original_subtrees() {
    let (f, status)=Fixture::new(SOURCE_PAGE);
    let before=f.snapshot();
    let layout=f.call(&status,"large.canvasLayout",json!({})).unwrap();
    let result=f.call(&status,"large.canvasSnapshot",json!({})).unwrap();
    assert_eq!(result["roots"],2);
    let path=PathBuf::from(result["path"].as_str().unwrap());
    let bytes=fs::read(&path).unwrap();assert_eq!(bytes.len() as u64,result["bytes"].as_u64().unwrap());
    assert_eq!(&bytes[..8],b"FXSCENE1");
    let store=serde_json::from_value(result["store"].clone()).unwrap();
    let (doc,_)=futureox_design_kernel::scene_store::Reader::open(&path,&store,&AtomicBool::new(false)).unwrap().into_document(&AtomicBool::new(false)).unwrap();
    let stage=result["stageId"].as_str().unwrap();
    assert_eq!(doc.pages[0].children,vec![stage]);
    assert_eq!(doc.nodes[stage].children,vec![RECT,OTHER]);
    assert_eq!(doc.nodes[stage].kind,"frame");assert!(!doc.nodes[stage].clip);
    assert_eq!(doc.nodes[RECT].name,"original rectangle");assert_eq!(doc.nodes[OTHER].name,"cold sibling");
    for item in layout["items"].as_array().unwrap(){
        let node=&doc.nodes[item["id"].as_str().unwrap()];
        assert_eq!(node.transform.0[4],item["placed"]["x"].as_f64().unwrap());
        assert_eq!(node.transform.0[5],item["placed"]["y"].as_f64().unwrap());
    }
    assert_eq!(f.call(&status,"large.canvasSnapshot",json!({})).unwrap(),result);
    let cancelled=f.sessions.dispatch("large.canvasSnapshot",Fixture::request(&status,json!({})),&AtomicBool::new(true));
    assert!(cancelled.unwrap_err().message.contains("cancelled"));
    assert_eq!(fs::read(&path).unwrap(),bytes);
    assert_eq!(f.export_members(&status,"native-canvas-original.sketch"),f.members);
    // A render projection cannot become the source edit baseline or history.
    let after=f.snapshot();assert_eq!(before.0,after.0);assert_eq!(before.2,after.2);assert_eq!(before.3,after.3);
}

#[test]
fn converted_source_windows_reuse_exact_values_recover_corruption_and_follow_revisions() {
    let (f, status) = Fixture::new(SOURCE_PAGE);
    let key = f.key(RECT);
    let first = f.call(&status, "large.scene", json!({"key":key})).unwrap();
    let (files, initial) = {
        let slot = f.sessions.current.lock().unwrap(); let s = slot.as_ref().unwrap();
        (s.converted_windows.lock().unwrap().files(), s.scene.as_ref().unwrap().document.clone())
    };
    assert_eq!(files.len(),1);
    // Exercise the real conversion-cache adapter, not only the standalone store.
    let mut magic=[0;8];File::open(&files[0]).unwrap().read_exact(&mut magic).unwrap();
    assert_eq!(&magic,b"FXSCENE1");
    let second = f.call(&status, "large.scene", json!({"key":key})).unwrap();
    assert_eq!(second["hash"], first["hash"]);
    { let slot=f.sessions.current.lock().unwrap();let s=slot.as_ref().unwrap();
      assert_eq!(s.converted_windows.lock().unwrap().hits,1); assert_eq!(s.scene.as_ref().unwrap().document,initial); }
    fs::write(&files[0], b"corrupt disposable cache").unwrap();
    let repaired = f.call(&status, "large.scene", json!({"key":key})).unwrap();
    assert_eq!(repaired["hash"],first["hash"]);
    { let slot=f.sessions.current.lock().unwrap();let s=slot.as_ref().unwrap();
      assert_eq!(s.converted_windows.lock().unwrap().hits,1); assert_eq!(s.scene.as_ref().unwrap().document,initial); }
    let cancelled=f.sessions.dispatch("large.scene",Fixture::request(&status,json!({"key":key})),&AtomicBool::new(true));
    assert!(cancelled.unwrap_err().message.contains("cancelled"));
    let changed=f.call(&status,"large.sceneCommit",json!({"key":key,"json":json!({RECT:{"patch":{"name":"new name"}}}).to_string(),"requestId":"cache-edit"})).unwrap();
    f.call(&changed,"large.scene",json!({"key":changed["key"]})).unwrap();
    assert!(files.iter().all(|path|!path.exists()));
    { let slot=f.sessions.current.lock().unwrap();let s=slot.as_ref().unwrap();
      assert_eq!(s.scene.as_ref().unwrap().document.nodes[RECT].name,"new name");
      assert_eq!(s.converted_windows.lock().unwrap().hits,1); }
    // Conversion cache files neither alter nor omit cold source members.
    let exported=f.export_members(&changed,"cache-edited.sketch");
    for (name,bytes) in &f.members {if !name.starts_with("pages/"){assert_eq!(&exported[name],bytes);}}
}

#[test]
fn canvas_catalog_filters_metadata_before_pagination_and_searches_current_scope() {
    let (f, status) = Fixture::new(SOURCE_PAGE);
    let all = f.call(&status,"large.children",json!({})).unwrap();
    assert!(all["total"].as_u64().unwrap()>1);
    let pages = f.call(&status,"large.children",json!({"canvasOnly":true,"limit":1})).unwrap();
    assert_eq!(pages["total"],1);
    assert_eq!(pages["items"][0]["kind"],"page");
    assert_eq!(pages["hasMore"],false);
    assert_eq!(f.call(&status,"large.children",json!({"canvasOnly":true,"offset":1})).unwrap()["items"],json!([]));
    let key=f.key(PAGE);
    let first=f.call(&status,"large.children",json!({"canvasOnly":true,"key":key,"limit":1})).unwrap();
    assert_eq!(first["total"],2);
    assert_eq!(first["items"][0]["id"],RECT);
    assert_eq!(first["hasMore"],true);
    let second=f.call(&status,"large.children",json!({"canvasOnly":true,"key":key,"limit":1,"offset":1})).unwrap();
    assert_eq!(second["items"][0]["id"],OTHER);
    let query=f.call(&status,"large.children",json!({"canvasOnly":true,"key":key,"query":"cold"})).unwrap();
    assert_eq!(query["total"],1);
    assert_eq!(query["items"][0]["id"],OTHER);
    assert_eq!(f.call(&status,"large.children",json!({"canvasOnly":true,"query":"cold"})).unwrap()["total"],0);
    assert_eq!(f.call(&status,"large.children",json!({"canvasOnly":true,"key":f.key(RECT)})).unwrap()["total"],0);
    assert_eq!(f.export_members(&status,"catalog-unchanged.sketch"),f.members);
}

#[test]
fn page_ranges_cover_every_source_root_in_order_and_reject_cancelled_or_invalid_requests() {
    let mut page: Value = serde_json::from_str(SOURCE_PAGE).unwrap();
    let rectangle = page["layers"][0].clone();
    page["layers"] = Value::Array((0..7).map(|n| {
        let mut layer = rectangle.clone();
        layer["do_objectID"] = json!(format!("10000000-0000-4000-8000-{n:012}"));
        layer["name"] = json!(format!("Root {n}"));
        layer
    }).collect());
    let (f, status) = Fixture::new(&page.to_string());
    let key = f.key(PAGE);
    let mut narrowed_roots = Vec::new();
    for offset in [0, 2, 4, 6] {
        let result = f.call(&status, "large.scene", json!({"key":key,"offset":offset,"limit":2})).unwrap();
        assert_eq!(result["pageRange"]["end"], (offset + 2).min(7));
        assert_eq!(result["pageRange"]["totalRoots"], 7);
        let slot = f.sessions.current.lock().unwrap();
        narrowed_roots.extend(slot.as_ref().unwrap().scene.as_ref().unwrap().document.pages[0].children.clone());
    }
    assert_eq!(narrowed_roots.len(), 7);
    assert_eq!(narrowed_roots.iter().collect::<std::collections::HashSet<_>>().len(), 7);
    assert!(f.call(&status, "large.scene", json!({"key":key,"limit":0})).is_err());
    f.call(&status, "large.scene", json!({"key":key})).unwrap();
    let snapshot = f.snapshot();
    {
        let slot = f.sessions.current.lock().unwrap();
        let s = slot.as_ref().unwrap();
        let (p, n) = location(s, Some(&key)).unwrap();
        let (full, _) = scene::build(s, p, n, &AtomicBool::new(false)).unwrap();
        let limit = serde_json::to_vec(&full).unwrap().len() / 2;
        let mut offset = 0;
        let mut roots = Vec::new();
        let mut segments = 0;
        loop {
            let (doc, _, range) = scene::build_range(s, p, n, &AtomicBool::new(false), offset, true, limit, None).unwrap();
            let range = range.unwrap();
            assert_eq!(range.offset, offset);
            assert_eq!(range.total_roots, 7);
            assert!(range.end > offset);
            assert!(serde_json::to_vec(&doc).unwrap().len() <= limit);
            for (id, node) in &doc.nodes { assert_eq!(full.nodes[id], *node); }
            roots.extend(doc.pages[0].children.clone());
            segments += 1;
            match range.next_offset { Some(next) => offset = next, None => break }
        }
        assert!(segments > 1);
        assert_eq!(roots, full.pages[0].children);
        assert!(scene::build_range(s, p, n, &AtomicBool::new(false), 7, true, limit, None).is_err());
        assert!(scene::build_range(s, p, n, &AtomicBool::new(true), 0, true, limit, None).is_err());
        assert!(scene::build_range(s, p, n, &AtomicBool::new(false), 0, false, limit, None).is_err());
    }
    assert_eq!(snapshot, f.snapshot());
    assert_eq!(f.export_members(&status, "complete.sketch"), f.members);
}

#[test]
fn later_page_range_edits_preserve_cold_roots_and_reopen_all_members() {
    let (f, status) = Fixture::new(SOURCE_PAGE);
    let key = f.key(PAGE);
    let loaded = f.call(&status, "large.scene", json!({"key":key,"offset":1})).unwrap();
    assert_eq!(loaded["pageRange"], json!({"offset":1,"end":2,"totalRoots":2,"nextOffset":null}));
    let changed = f.call(&status, "large.sceneCommit", json!({"key":key,"requestId":"range-edit","json":json!({OTHER:{"patch":{"name":"edited later range"}}}).to_string()})).unwrap();
    let members = f.export_members(&changed, "range-edit.sketch");
    for (name, bytes) in &f.members {
        if !name.starts_with("pages/") { assert_eq!(&members[name], bytes); }
    }
    let original: Value = serde_json::from_str(SOURCE_PAGE).unwrap();
    let edited: Value = serde_json::from_slice(&members[&format!("pages/{PAGE}.json")]).unwrap();
    assert_eq!(original["layers"][0], edited["layers"][0]);
    assert_eq!(edited["layers"][1]["name"], "edited later range");
    f.call(&changed, "large.close", json!({})).unwrap();
    let reopened = f.sessions.open(Open { path:f.root.join("range-edit.sketch"), document_id:"range-reopen".into(), session_epoch:2 }, &AtomicBool::new(false)).unwrap();
    let key = f.key(PAGE);
    let loaded = f.call(&reopened, "large.scene", json!({"key":key})).unwrap();
    assert_eq!(loaded["pageRange"]["end"], 2);
    let slot = f.sessions.current.lock().unwrap();
    let doc = &slot.as_ref().unwrap().scene.as_ref().unwrap().document;
    assert_eq!(doc.nodes[RECT].name, "original rectangle");
    assert_eq!(doc.nodes[OTHER].name, "edited later range");
}

#[test]
fn rejected_scene_edits_keep_source_revision_history_and_initial_dto_exact() {
    let (f, status) = Fixture::new(SOURCE_PAGE);
    let key = f.key(PAGE);
    f.call(&status, "large.scene", json!({"key":key})).unwrap();
    let original_archive = fs::read(&f.source).unwrap();
    for (case, updates) in [
        json!({RECT:{"patch":{"smoothing":0.6}}}),
        json!({RECT:{"patch":{"name":"must not save","smoothing":0.6}}}),
        json!({RECT:{"patch":{"name":"first staged edit"}},OTHER:{"patch":{"smoothing":0.4}}}),
    ].into_iter().enumerate() {
        let before = f.snapshot();
        let error = f.call(&status, "large.sceneCommit", json!({"key":key,
            "requestId":"reject-source-edit","json":updates.to_string()})).unwrap_err();
        assert!(error.to_string().contains("Source field smoothing"), "{error}");
        assert_eq!(f.snapshot(), before, "Rejection must not mutate any source/scene/history state");
        assert_eq!(fs::read(&f.source).unwrap(), original_archive);
        assert_eq!(f.export_members(&status, &format!("rejected-{case}.sketch")), f.members);
    }
}

#[test]
fn no_op_returns_current_key_without_invalidating_scene_reads() {
    let (f, status) = Fixture::new(SOURCE_PAGE);
    let key = f.key(RECT);
    f.call(&status, "large.scene", json!({"key":key})).unwrap();
    let before = f.snapshot();
    let result = f.call(&status, "large.sceneCommit", json!({"key":key,
        "requestId":"no-op-source-edit","json":json!({RECT:{"patch":{"smoothing":0}}}).to_string()})).unwrap();
    assert_eq!(result["key"], key);
    assert_eq!(result["revision"], status["revision"]);
    assert_eq!(f.snapshot(), before);
}

#[test]
fn native_edit_preserves_all_untouched_bytes_and_undo_redo_roundtrips() {
    let (f, status) = Fixture::new(SOURCE_PAGE);
    let key = f.key(RECT);
    f.call(&status, "large.scene", json!({"key":key})).unwrap();
    let original_archive = fs::read(&f.source).unwrap();
    let next = f.call(&status, "large.sceneCommit", json!({"key":key,"requestId":"rename-source-edit",
        "json":json!({RECT:{"patch":{"name":"saved rectangle"}}}).to_string()})).unwrap();
    assert_eq!(next["revision"], 1);
    assert_eq!(next["undoCount"], 1);
    assert_eq!(next["key"], f.key(RECT));
    let mut expected = f.members.clone();
    expected.insert(format!("pages/{PAGE}.json"), SOURCE_PAGE.replace("original rectangle", "saved rectangle").into_bytes());
    let saved = f.export_members(&next, "saved.sketch");
    assert_eq!(saved, expected, "Every unaffected source byte/member must remain exact");
    assert_eq!(fs::read(&f.source).unwrap(), original_archive);
    let undone = f.call(&next, "large.undo", json!({})).unwrap();
    assert_eq!(f.export_members(&undone, "undone.sketch"), f.members);
    let redone = f.call(&undone, "large.redo", json!({})).unwrap();
    assert_eq!(f.export_members(&redone, "redone.sketch"), expected);
    let bytes = fs::read(f.root.join("redone.sketch")).unwrap();
    let reopened = futureox_design_kernel::interop::import_sketch_report(&bytes).unwrap().document;
    assert_eq!(reopened.nodes[RECT].name, "saved rectangle");
}

#[test]
fn legacy_subtree_commit_rejects_the_same_false_save_atomically() {
    let (f, status) = Fixture::new(SOURCE_PAGE);
    let key = f.key(RECT);
    let projection = f.call(&status, "large.project", json!({"key":key,
        "workingDocumentId":"10000000-0000-4000-8000-000000000099"})).unwrap();
    let mut document: Document = serde_json::from_str(projection["json"].as_str().unwrap()).unwrap();
    let node = document.nodes.get_mut(RECT).unwrap();
    node.smoothing = 0.5;
    node.name = "must not save".into();
    document.validate().unwrap();
    let before = f.snapshot();
    let error = f.call(&status, "large.commitCanvas", json!({"key":key,
        "requestId":"legacy-rejected-edit","json":serde_json::to_string(&document).unwrap()})).unwrap_err();
    assert!(error.to_string().contains("Source field smoothing"), "{error}");
    assert_eq!(f.snapshot(), before);
    assert_eq!(f.export_members(&status, "legacy-rejected.sketch"), f.members);
}

#[test]
fn supported_dependency_edit_returns_the_selected_identity_for_the_next_save() {
    let page = json!({"_class":"page","do_objectID":PAGE,"layers":[
        {"_class":"symbolMaster","do_objectID":RECT,"symbolID":"10000000-0000-4000-8000-000000000020",
         "name":"dependency","frame":{"x":0,"y":0,"width":100,"height":80},"layers":[]},
        {"_class":"symbolInstance","do_objectID":OTHER,"symbolID":"10000000-0000-4000-8000-000000000020",
         "name":"selected instance","frame":{"x":120,"y":0,"width":100,"height":80}}
    ]}).to_string();
    let (f, status) = Fixture::new(&page);
    let key = f.key(OTHER);
    f.call(&status, "large.scene", json!({"key":key})).unwrap();
    let next = f.call(&status, "large.sceneCommit", json!({"key":key,"requestId":"rename-dependency",
        "json":json!({RECT:{"patch":{"name":"renamed dependency"}}}).to_string()})).unwrap();
    let actual = f.key(OTHER);
    // Property-only edits retain indexed object cardinality at this baseline.
    // This test proves receipt identity, not an invented ordinal shift.
    assert_eq!(actual, key);
    assert_eq!(next["key"], actual);
    let noop = f.call(&next, "large.sceneCommit", json!({"key":actual,
        "requestId":"after-rebind-noop","json":"{}"})).unwrap();
    assert_eq!(noop["key"], actual);
}

#[test]
fn json_subtree_commit_rebinds_root_after_a_preceding_indexed_child_is_removed() {
    let (f, status) = Fixture::new(SOURCE_PAGE);
    f.call(&status, "large.close", json!({})).unwrap();
    let mut child = futureox_design_kernel::facet::sample_node(RECT, "rectangle");
    child.name = "preceding child".into();
    let mut root = futureox_design_kernel::facet::sample_node(OTHER, "group");
    root.children.push(RECT.into());
    let source = json!({"schemaVersion":8,"id":"json-source","name":"JSON source",
        "pages":[{"id":PAGE,"name":"page","background":"#ffffff","children":[OTHER]}],
        "nodes":{RECT:child,OTHER:root},"fonts":{}});
    let path = f.root.join("source.json");
    fs::write(&path, serde_json::to_vec(&source).unwrap()).unwrap();
    let opened = f.sessions.open(Open { path, document_id:"json-source".into(), session_epoch:2 }, &AtomicBool::new(false)).unwrap();
    let key = f.key(OTHER);
    let projected = f.call(&opened, "large.project", json!({"key":key,
        "workingDocumentId":"10000000-0000-4000-8000-000000000099"})).unwrap();
    let mut document: Document = serde_json::from_str(projected["json"].as_str().unwrap()).unwrap();
    // The shared JSON nodes collection is physically keyed in BTree order:
    // RECT precedes OTHER. Deleting this indexed child changes the root ordinal.
    document.nodes.remove(RECT);
    document.nodes.get_mut(OTHER).unwrap().children.clear();
    document.validate().unwrap();
    let next = f.call(&opened, "large.commitCanvas", json!({"key":key,"requestId":"json-remove-child",
        "json":serde_json::to_string(&document).unwrap()})).unwrap();
    let actual = f.key(OTHER);
    assert_ne!(actual, key);
    assert_eq!(next["key"], actual);
    let again = f.call(&next, "large.commitCanvas", json!({"key":actual,"requestId":"json-after-rebind",
        "json":serde_json::to_string(&document).unwrap()})).unwrap();
    assert_eq!(again["key"], actual);
}

#[test]
fn legacy_subtree_keeps_actual_ui_rectangle_creation_and_reopen_behavior() {
    let page = json!({"_class":"page","do_objectID":PAGE,"layers":[
        {"_class":"group","do_objectID":OTHER,"name":"selected group",
         "frame":{"x":0,"y":0,"width":100,"height":80},"layers":[
            {"_class":"rectangle","do_objectID":RECT,"name":"original child",
             "frame":{"x":0,"y":0,"width":20,"height":20}}
         ]}
    ]}).to_string();
    let (f, status) = Fixture::new(&page);
    let key = f.key(OTHER);
    let projected = f.call(&status, "large.project", json!({"key":key,
        "workingDocumentId":"10000000-0000-4000-8000-000000000098"})).unwrap();
    let mut document: Document = serde_json::from_str(projected["json"].as_str().unwrap()).unwrap();
    let id = "10000000-0000-4000-8000-000000000099";
    // Exact constructor defaults from frontend/design-client/src/model.ts
    // node('rectangle') + paint(), baseline f03197e; UUIDs fixed for repeatability.
    // These intentionally differ from Rust sample_node's inactive defaults.
    let node = serde_json::from_value(json!({
        "id":id,"kind":"rectangle","name":"矩形","transform":[1,0,0,1,0,0],
        "width":160,"height":120,"children":[],"visible":true,"locked":false,
        "opacity":1,"blend":"normal","fills":[{
            "id":"10000000-0000-4000-8000-000000000097","kind":"solid",
            "color":"#818cf8","opacity":1,"visible":true,"angle":90,
            "stops":[{"offset":0,"color":"#818cf8"},{"offset":1,"color":"#f5b8dc"}],
            "fit":"cover","blend":"normal"
        }],"strokes":[],"effects":[],"radii":[0,0,0,0],"smoothing":0,
        "clip":false,"mask":false,"points":3,"innerRadius":0.45,
        "text":"双击编辑文字","fontSize":28
    })).unwrap();
    document.nodes.insert(id.into(), node);
    document.nodes.get_mut(OTHER).unwrap().children.push(id.into());
    document.validate().unwrap();
    let next = f.call(&status, "large.commitCanvas", json!({"key":key,"requestId":"add-rectangle",
        "json":serde_json::to_string(&document).unwrap()})).unwrap();
    assert_eq!(next["key"], f.key(OTHER));
    assert_eq!(next["revision"], 1);
    f.export_members(&next, "added-rectangle.sketch");
    let reopened = futureox_design_kernel::interop::import_sketch_report(
        &fs::read(f.root.join("added-rectangle.sketch")).unwrap()).unwrap().document;
    assert_eq!(reopened.nodes[OTHER].children, vec![RECT.to_owned(), id.to_owned()]);
    let added = &reopened.nodes[id];
    assert_eq!(added.name, "矩形");
    assert_eq!(added.kind, "rectangle");
    assert_eq!((added.width, added.height), (160., 120.));
    assert_eq!(added.fills.len(), 1);
    assert_eq!(added.fills[0].color, "#818cf8");
    // Deliberately not a byte-identical/new-node-losslessness assertion:
    // legacy interchange canonicalizes these inactive defaults/paint identity.
}

#[test]
fn scene_commit_keeps_actual_ui_fill_and_stroke_insertion_working() {
    let (f, status) = Fixture::new(SOURCE_PAGE);
    let key = f.key(RECT);
    f.call(&status, "large.scene", json!({"key":key})).unwrap();
    let paint = |id: &str, color: &str| json!({"id":id,"kind":"solid","color":color,
        "opacity":1,"visible":true,"angle":90,"stops":[
            {"offset":0,"color":color},{"offset":1,"color":"#f5b8dc"}],
        "fit":"cover","blend":"normal"});
    let next = f.call(&status, "large.sceneCommit", json!({"key":key,"requestId":"ui-fill-stroke",
        "json":json!({RECT:{"patch":{
            "fills":[paint("ui-fill", "#818cf8")],
            "strokes":[{"id":"ui-stroke","paint":paint("ui-stroke-paint", "#303344"),
                "width":2,"align":"center","cap":"round","join":"round","dash":"","visible":true}]
        }}}).to_string()})).unwrap();
    assert_eq!(next["revision"], 1);
    assert_eq!(next["key"], f.key(RECT));
    let parts = f.export_members(&next, "ui-fill-stroke.sketch");
    let page = std::str::from_utf8(&parts[&format!("pages/{PAGE}.json")]).unwrap();
    assert!(page.contains(r#""privateUnknown": { "bytes":1e+02 }"#));
    assert!(page.contains(r#""com.vendor.raw": { "bytes":1e+02, "zero":-0.0 }"#));
    let reopened = futureox_design_kernel::interop::import_sketch_report(
        &fs::read(f.root.join("ui-fill-stroke.sketch")).unwrap()).unwrap().document;
    let node = &reopened.nodes[RECT];
    assert_eq!(node.fills.len(), 1);
    assert_eq!(node.fills[0].color, "#818cf8");
    assert_eq!(node.strokes.len(), 1);
    assert_eq!(node.strokes[0].paint.color, "#303344");
    assert_eq!(node.strokes[0].width, 2.);
}

#[test]
fn json_case_distinct_node_ids_keep_exact_identity_across_noop_and_edit() {
    let (f, status) = Fixture::new(SOURCE_PAGE);
    f.call(&status, "large.close", json!({})).unwrap();
    let mut selected = futureox_design_kernel::facet::sample_node("node", "rectangle");
    selected.name = "selected lowercase".into();
    let mut other = futureox_design_kernel::facet::sample_node("Node", "rectangle");
    other.name = "untouched uppercase".into();
    let source = json!({"schemaVersion":1,"id":"case-source","name":"Case-sensitive JSON",
        "pages":[{"id":PAGE,"name":"page","background":"#ffffff","children":["node","Node"]}],
        "nodes":{"node":selected,"Node":other},"fonts":{}});
    let source_bytes = serde_json::to_vec(&source).unwrap();
    let untouched_bytes = serde_json::to_vec(&source["nodes"]["Node"]).unwrap();
    let path = f.root.join("case-source.json");
    fs::write(&path, &source_bytes).unwrap();
    let opened = f.sessions.open(Open { path:path.clone(), document_id:"case-source".into(), session_epoch:2 },
        &AtomicBool::new(false)).unwrap();
    let key = f.key("node");
    let other_key = f.key("Node");
    assert_ne!(key, other_key);
    let projected = f.call(&opened, "large.project", json!({"key":key,
        "workingDocumentId":"10000000-0000-4000-8000-000000000099"})).unwrap();
    let mut document: Document = serde_json::from_str(projected["json"].as_str().unwrap()).unwrap();
    assert!(document.nodes.contains_key("node"));
    assert!(!document.nodes.contains_key("Node"));
    let noop = f.call(&opened, "large.commitCanvas", json!({"key":key,"requestId":"case-noop",
        "json":serde_json::to_string(&document).unwrap()})).unwrap();
    assert_eq!(noop["key"], f.key("node"));
    assert_ne!(noop["key"], f.key("Node"));
    let noop_path = f.root.join("case-noop.json");
    f.call(&noop, "large.export", json!({"path":noop_path})).unwrap();
    assert_eq!(fs::read(noop_path).unwrap(), source_bytes);
    document.nodes.get_mut("node").unwrap().name = "edited lowercase".into();
    let edited = f.call(&noop, "large.commitCanvas", json!({"key":noop["key"],"requestId":"case-edit",
        "json":serde_json::to_string(&document).unwrap()})).unwrap();
    assert_eq!(edited["key"], f.key("node"));
    assert_ne!(edited["key"], f.key("Node"));
    let edited_path = f.root.join("case-edited.json");
    f.call(&edited, "large.export", json!({"path":edited_path})).unwrap();
    let bytes = fs::read(edited_path).unwrap();
    let reopened: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(reopened["nodes"]["node"]["name"], "edited lowercase");
    assert_eq!(reopened["nodes"]["Node"], source["nodes"]["Node"]);
    assert!(bytes.windows(untouched_bytes.len()).any(|window| window == untouched_bytes.as_slice()));
    assert_eq!(fs::read(path).unwrap(), source_bytes);
    let again = f.call(&edited, "large.commitCanvas", json!({"key":edited["key"],"requestId":"case-after-edit-noop",
        "json":serde_json::to_string(&document).unwrap()})).unwrap();
    assert_eq!(again["key"], f.key("node"));
    assert_ne!(again["key"], f.key("Node"));
}

const NEW_NODE: &str = "10000000-0000-4000-8000-000000000099";
const NEW_SIBLING: &str = "10000000-0000-4000-8000-000000000095";
const NEW_PARENT: &str = "10000000-0000-4000-8000-000000000096";
const NEW_NODE_SOURCE: &str = include_str!("fixtures/new_node_source_page.json");
const NEW_ROUNDED_RECTANGLE: &str = include_str!("fixtures/new_node_rounded_rectangle.json");

fn project_new_node_fixture(f: &Fixture, status: &Value) -> (String, Document) {
    let key = f.key(OTHER);
    f.call(status, "large.scene", json!({"key":key})).unwrap();
    let projected = f.call(status, "large.project", json!({"key":key,
        "workingDocumentId":"10000000-0000-4000-8000-000000000098"})).unwrap();
    let document: Document = serde_json::from_str(projected["json"].as_str().unwrap()).unwrap();
    // The actual original archive contains a slice BEFORE import/projection.
    // Never raise schemaVersion in the submitted draft: that exercises the
    // unrelated document-metadata refusal instead of the new-node save guard.
    assert_eq!(document.nodes[RECT].kind, "slice");
    assert!(document.schema_version >= 10);
    (key, document)
}

fn ui_new_source_node(id: &str, kind: &str) -> futureox_design_kernel::scene::Node {
    // Same node()/paint() defaults as f03197e model.ts, with fixed UUIDs. The
    // supplied meaningful smoothing fixture becomes the actual constructor
    // default here only by restoring its two deliberately authored properties.
    let mut node: futureox_design_kernel::scene::Node = serde_json::from_str(NEW_ROUNDED_RECTANGLE).unwrap();
    node.id = id.into();
    node.kind = kind.into();
    node.name = format!("new {kind}");
    node.radii = [0.; 4];
    node.smoothing = 0.;
    node.clip = kind == "frame";
    node.points = if kind == "star" { 5 } else { 3 };
    if matches!(kind, "slice" | "group") {
        node.fills.clear();
    } else if kind == "frame" {
        node.fills[0].color = "#ffffff".into();
        node.fills[0].stops[0].color = "#ffffff".into();
    } else if kind == "section" {
        node.fills[0].color = "#e7e8ef".into();
        node.fills[0].stops[0].color = "#e7e8ef".into();
    }
    node
}

fn add_new_source_node(document: &mut Document, parent: &str, node: futureox_design_kernel::scene::Node) {
    let id = node.id.clone();
    assert!(!document.nodes.contains_key(&id));
    document.nodes.insert(id.clone(), node);
    document.nodes.get_mut(parent).unwrap().children.push(id);
}

fn assert_new_source_rejection(f: &Fixture, status: &Value, key: &str, document: &Document, field: &str, export_name: &str) {
    document.validate().unwrap();
    let text = serde_json::to_string(document).unwrap();
    // The same production JSON validator must admit the input before the
    // missing-field guard is expected to refuse source serialization.
    futureox_design_kernel::validate_document_json(&text).unwrap();
    let dto = f.call(status, "large.sceneRead", json!({"key":key})).unwrap();
    let source_dto = f.call(status, "large.read", json!({"key":key})).unwrap();
    let original_archive = fs::read(&f.source).unwrap();
    let status_before = f.call(status, "large.status", json!({})).unwrap();
    let before = f.snapshot();
    let error = f.call(status, "large.commitCanvas", json!({"key":key,
        "requestId":"new-source-rejection","json":text})).unwrap_err();
    assert_eq!(error.code, "LARGE_DOCUMENT_ERROR");
    assert_eq!(error.message, format!("unsupported lossless conversion: Source field {field} is not supported by the Sketch save codec; keep the draft or save a native document"));
    assert_eq!(f.snapshot(), before, "Session, every spool/index/checkpoint, scene DTO and projection must remain unchanged");
    assert_eq!(f.call(status, "large.status", json!({})).unwrap(), status_before);
    assert_eq!(f.call(status, "large.sceneRead", json!({"key":key})).unwrap(), dto);
    assert_eq!(f.call(status, "large.read", json!({"key":key})).unwrap(), source_dto);
    assert_eq!(f.key(OTHER), key);
    assert_eq!(fs::read(&f.source).unwrap(), original_archive);
    assert_eq!(f.export_members(status, export_name), f.members);
}

#[test]
fn new_source_nodes_reject_all_six_omissions_atomically_without_schema_edits() {
    let (f, status) = Fixture::new(NEW_NODE_SOURCE);
    let (key, baseline) = project_new_node_fixture(&f, &status);
    for (case, (kind, field, value)) in [
        ("rectangle", "smoothing", json!(0.6)),
        ("frame", "smoothing", json!(0.6)),
        ("section", "smoothing", json!(0.6)),
        ("slice", "smoothing", json!(0.6)),
        ("group", "clip", json!(true)),
        ("ellipse", "arc", json!({"startAngle":0.25,"sweepAngle":1.5,"innerRadius":0.25})),
        ("ellipse", "arc", json!({"startAngle":0.,"sweepAngle":std::f64::consts::TAU,"innerRadius":0.})),
        ("ellipse", "arc", json!({"startAngle":0.,"sweepAngle":0.,"innerRadius":0.})),
        ("polygon", "cornerRadius", json!(4.)),
        ("star", "cornerRadius", json!(4.)),
        ("frame", "radii", json!([1.,2.,3.,4.])),
        ("section", "radii", json!([1.,2.,3.,4.])),
        ("slice", "radii", json!([1.,2.,3.,4.])),
        ("rectangle", "exportSettings", json!([{"id":"export","format":"png","scale":2.,"suffix":"@2x"}])),
        ("slice", "exportSettings", json!([{"id":"export","format":"pdf","scale":1.,"suffix":""}])),
    ].into_iter().enumerate() {
        for visible in [true, false] {
            let mut document = baseline.clone();
            let mut value_node = serde_json::to_value(ui_new_source_node(NEW_NODE, kind)).unwrap();
            value_node["clip"] = json!(false); // isolate each field, not a hidden UI default whitelist
            value_node[field] = value.clone();
            value_node["visible"] = json!(visible);
            if kind == "rectangle" && field == "smoothing" {
                value_node["radii"] = json!([8.,8.,8.,8.]); // visibly meaningful unsaturated corners
            }
            add_new_source_node(&mut document, OTHER, serde_json::from_value(value_node).unwrap());
            assert_eq!(document.schema_version, baseline.schema_version);
            assert_new_source_rejection(&f, &status, &key, &document, field,
                &format!("new-rejected-{case}-{visible}.sketch"));
        }
    }
}

#[test]
fn new_source_rejection_is_atomic_for_mixed_batches_and_new_grandchildren() {
    let (f, status) = Fixture::new(NEW_NODE_SOURCE);
    let (key, baseline) = project_new_node_fixture(&f, &status);
    for mode in 0..3 {
        let mut document = baseline.clone();
        let bad = serde_json::from_str(NEW_ROUNDED_RECTANGLE).unwrap();
        if mode == 0 {
            document.nodes.get_mut(OTHER).unwrap().name = "must not save this supported rename".into();
            add_new_source_node(&mut document, OTHER, bad);
        } else if mode == 1 {
            // A lexically earlier new ID is valid, but no portion may publish.
            add_new_source_node(&mut document, OTHER, ui_new_source_node(NEW_SIBLING, "ellipse"));
            add_new_source_node(&mut document, OTHER, bad);
        } else {
            add_new_source_node(&mut document, OTHER, ui_new_source_node(NEW_PARENT, "group"));
            add_new_source_node(&mut document, NEW_PARENT, bad);
        }
        assert_new_source_rejection(&f, &status, &key, &document, "smoothing",
            &format!("new-rejected-mixed-{mode}.sketch"));
    }
}

#[test]
fn new_source_clipped_ui_frames_reject_even_when_empty_or_invisible() {
    let (f, status) = Fixture::new(NEW_NODE_SOURCE);
    let (key, baseline) = project_new_node_fixture(&f, &status);
    for visible in [true, false] {
        for overflow in [true, false] {
            let mut document = baseline.clone();
            let mut frame = ui_new_source_node(NEW_PARENT, "frame");
            assert!(frame.clip, "Retain the real UI default instead of whitelisting or clearing it");
            frame.visible = visible;
            add_new_source_node(&mut document, OTHER, frame);
            if overflow {
                let mut child = ui_new_source_node(NEW_NODE, "rectangle");
                child.transform.0[4] = 140.;
                child.width = 100.;
                add_new_source_node(&mut document, NEW_PARENT, child);
            }
            assert_new_source_rejection(&f, &status, &key, &document, "clip",
                &format!("new-clipped-{visible}-{overflow}.sketch"));
        }
    }
}

#[test]
fn new_source_supported_ui_insertions_export_and_reopen() {
    for (case, kind) in ["rectangle", "ellipse", "slice", "frame", "rectangle", "rectangle"].into_iter().enumerate() {
        let (f, status) = Fixture::new(NEW_NODE_SOURCE);
        let (key, mut document) = project_new_node_fixture(&f, &status);
        let mut node = ui_new_source_node(NEW_NODE, kind);
        if kind == "frame" { node.clip = false; } // explicitly unclipped, not the UI default
        if case == 4 { node.radii = [1.,2.,3.,4.]; }
        if case == 5 {
            let paint = |id: &str, color: &str| json!({"id":id,"kind":"solid","color":color,
                "opacity":1,"visible":true,"angle":90,"stops":[
                    {"offset":0,"color":color},{"offset":1,"color":"#f5b8dc"}],
                "fit":"cover","blend":"normal"});
            node.strokes.push(serde_json::from_value(json!({"id":"ui-stroke",
                "paint":paint("ui-stroke-paint", "#303344"),"width":2,"align":"center",
                "cap":"round","join":"round","dash":"","visible":true})).unwrap());
            node.effects.push(serde_json::from_value(json!({"id":"ui-shadow","kind":"shadow",
                "visible":true,"radius":8,"x":0,"y":8,"spread":0,"color":"#172033",
                "opacity":0.25,"amount":0.65})).unwrap());
        }
        let expected = node.clone();
        add_new_source_node(&mut document, OTHER, node);
        document.validate().unwrap();
        let original_archive = fs::read(&f.source).unwrap();
        let next = f.call(&status, "large.commitCanvas", json!({"key":key,
            "requestId":"new-supported-source","json":serde_json::to_string(&document).unwrap()})).unwrap();
        assert_eq!(next["key"], f.key(OTHER));
        assert_eq!(next["revision"], 1);
        assert_eq!(next["undoCount"], 1);
        let filename = format!("new-supported-{case}.sketch");
        let saved = f.export_members(&next, &filename);
        for (member, bytes) in &f.members {
            if member != &format!("pages/{PAGE}.json") { assert_eq!(&saved[member], bytes); }
        }
        assert_eq!(fs::read(&f.source).unwrap(), original_archive);
        let reopened = futureox_design_kernel::interop::import_sketch_report(
            &fs::read(f.root.join(filename)).unwrap()).unwrap().document;
        assert_eq!(reopened.nodes[OTHER].children, vec![RECT.to_owned(), NEW_NODE.to_owned()]);
        let added = &reopened.nodes[NEW_NODE];
        assert_eq!(added.kind, expected.kind);
        assert_eq!(added.name, expected.name);
        assert_eq!((added.width, added.height), (expected.width, expected.height));
        assert_eq!(added.radii, expected.radii);
        assert_eq!(added.smoothing, 0.);
        assert!(!added.clip);
        assert!(added.arc.is_none());
        assert_eq!(added.corner_radius, 0.);
        assert!(added.export_settings.is_empty());
        assert_eq!(added.fills.len(), expected.fills.len());
        if let Some(fill) = expected.fills.first() { assert_eq!(added.fills[0].color, fill.color); }
        if case == 5 {
            assert_eq!(added.strokes.len(), 1);
            assert_eq!(added.strokes[0].width, 2.);
            assert_eq!(added.strokes[0].paint.color, "#303344");
            assert_eq!(added.effects.len(), 1);
            assert_eq!(added.effects[0].kind, "shadow");
            assert_eq!((added.effects[0].radius, added.effects[0].y, added.effects[0].opacity), (8.,8.,0.25));
        }
        // Assert active supported fields, never transient paint IDs, dormant
        // points/text/innerRadius, native-preview equivalence or whole-node losslessness.
        let undone = f.call(&next, "large.undo", json!({})).unwrap();
        assert_eq!(f.export_members(&undone, &format!("new-undone-{case}.sketch")), f.members);
        let redone = f.call(&undone, "large.redo", json!({})).unwrap();
        assert_eq!(f.export_members(&redone, &format!("new-redone-{case}.sketch")), saved);
    }
}

#[test]
fn new_source_refusal_preserves_populated_undo_and_redo_history() {
    let (mut f, status) = Fixture::new(NEW_NODE_SOURCE);
    let (key, _) = project_new_node_fixture(&f, &status);
    let first = f.call(&status, "large.sceneCommit", json!({"key":key,
        "requestId":"history-first","json":json!({OTHER:{"patch":{"name":"first rename"}}}).to_string()})).unwrap();
    let second = f.call(&first, "large.sceneCommit", json!({"key":first["key"],
        "requestId":"history-second","json":json!({OTHER:{"patch":{"name":"second rename"}}}).to_string()})).unwrap();
    let undone = f.call(&second, "large.undo", json!({})).unwrap();
    assert_eq!(undone["revision"], 3);
    assert_eq!(undone["undoCount"], 1);
    assert_eq!(undone["redoCount"], 1);
    // This case's source baseline is an already-edited archive, not the
    // original fixture. The common rejection helper must preserve that state.
    f.members = f.export_members(&undone, "new-history-baseline.sketch");
    let (key, mut document) = project_new_node_fixture(&f, &undone);
    assert_eq!(document.nodes[OTHER].name, "first rename");
    document.nodes.get_mut(OTHER).unwrap().name = "must not overwrite history".into();
    add_new_source_node(&mut document, OTHER, serde_json::from_str(NEW_ROUNDED_RECTANGLE).unwrap());
    assert_new_source_rejection(&f, &undone, &key, &document, "smoothing", "new-history-rejected.sketch");
    // An actual redo remains available after rejection and restores the prior
    // supported second rename, never the rejected draft.
    let redone = f.call(&undone, "large.redo", json!({})).unwrap();
    f.export_members(&redone, "new-history-redone.sketch");
    let reopened = futureox_design_kernel::interop::import_sketch_report(
        &fs::read(f.root.join("new-history-redone.sketch")).unwrap()).unwrap().document;
    assert_eq!(reopened.nodes[OTHER].name, "second rename");
    assert!(!reopened.nodes.contains_key(NEW_NODE));
}

#[test]
fn mixed_name_and_unsupported_path_offset_edit_never_partially_commits() {
    let (f,status)=Fixture::new(NEW_NODE_SOURCE);
    let (key,mut document)=project_new_node_fixture(&f,&status);
    let n=document.nodes.get_mut(OTHER).unwrap();n.name="must not partially save".into();n.path_offset=2.;
    assert_new_source_rejection(&f,&status,&key,&document,"pathOffset","mixed-edit-refused.sketch");
}
