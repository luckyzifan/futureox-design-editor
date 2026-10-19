use futureox_design_kernel::editing::{DocumentEditor, DocumentPatch};
use serde_json::json;
fn editor() -> DocumentEditor {
    DocumentEditor::new(serde_json::from_value(json!({"schemaVersion":2,"id":"d","name":"edits","pages":[{"id":"p","name":"p","background":"#ffffff","children":["a"]}],"nodes":{"a":{"id":"a","kind":"rectangle","width":40,"height":30}}})).unwrap()).unwrap()
}
fn width(editor: &DocumentEditor, value: f64) -> DocumentPatch {
    let mut n = editor.document().nodes["a"].clone();
    n.width = value;
    DocumentPatch {
        nodes: [("a".into(), Some(n))].into(),
        ..Default::default()
    }
}
#[test]
fn atomic_patch_replay_and_undo_redo_preserve_document_semantics() {
    let mut e = editor();
    let original = e.document().clone();
    let patch = width(&e, 70.);
    let encoded = serde_json::to_string(&patch).unwrap();
    let result = e.apply(0, serde_json::from_str(&encoded).unwrap()).unwrap();
    assert_eq!((result.revision, result.undo_depth), (1, 1));
    assert_eq!(e.document().nodes["a"].width, 70.);
    let mut replay = DocumentEditor::new(original.clone()).unwrap();
    replay.apply(0, patch).unwrap();
    assert_eq!(replay.document(), e.document());
    e.undo().unwrap();
    assert_eq!(e.document(), &original);
    e.redo().unwrap();
    assert_eq!(e.document(), replay.document());
    let before = e.document().clone();
    let revision = e.revision();
    assert_eq!(
        e.apply(0, width(&e, 90.)).unwrap_err().code,
        "stale_revision"
    );
    let bad = DocumentPatch {
        nodes: [("a".into(), None)].into(),
        ..Default::default()
    };
    assert_eq!(e.apply(revision, bad).unwrap_err().code, "invalid_document");
    assert_eq!(e.document(), &before);
    assert_eq!(e.revision(), revision);
}
#[test]
fn previews_commit_as_one_step_and_cancel_does_not_change_history() {
    let mut e = editor();
    let original = e.document().clone();
    e.begin(0).unwrap();
    e.preview(width(&e, 60.)).unwrap();
    e.preview(width(&e, 80.)).unwrap();
    assert_eq!(e.revision(), 0);
    let result = e.commit().unwrap();
    assert_eq!(result.undo_depth, 1);
    e.undo().unwrap();
    assert_eq!(e.document(), &original);
    e.begin(e.revision()).unwrap();
    e.preview(width(&e, 120.)).unwrap();
    let result = e.cancel().unwrap();
    assert_eq!(result.undo_depth, 0);
    assert_eq!(result.redo_depth, 1);
    assert_eq!(e.document(), &original);
    e.redo().unwrap();
    assert_eq!(e.document().nodes["a"].width, 80.);
}
#[test]
fn history_count_is_bounded_and_a_new_edit_discards_only_the_redo_branch() {
    let mut e = editor();
    for i in 1..=90 {
        let result = e.apply(e.revision(), width(&e, 40. + i as f64)).unwrap();
        assert!(result.undo_depth <= 80);
    }
    for _ in 0..80 {
        e.undo().unwrap();
    }
    assert_eq!(e.document().nodes["a"].width, 50.);
    e.apply(e.revision(), width(&e, 99.)).unwrap();
    assert_eq!(e.redo().unwrap().redo_depth, 0);
}
#[test]
fn renderer_patches_apply_to_author_input_and_match_a_fresh_full_load() {
    let mut authored = editor().document().clone();
    let mut engine = futureox_design_kernel::Engine::new();
    let options = serde_json::from_value(json!({"pageId":"p","width":80,"height":64,"transparent":true,"view":{"x":0,"y":0,"zoom":1}})).unwrap();
    engine
        .load_document(&serde_json::to_string(&authored).unwrap())
        .unwrap();
    engine.render(&options).unwrap();
    let before = authored.clone();
    authored.nodes.get_mut("a").unwrap().width = 60.;
    let patch = DocumentPatch::between(&before, &authored).unwrap();
    engine.apply_document_patch(&patch).unwrap();
    let mut fresh = futureox_design_kernel::Engine::new();
    fresh
        .load_document(&serde_json::to_string(&authored).unwrap())
        .unwrap();
    assert_eq!(
        engine.render(&options).unwrap(),
        fresh.render(&options).unwrap()
    );
    let bad = DocumentPatch {
        nodes: [("a".into(), None)].into(),
        ..Default::default()
    };
    assert!(engine.apply_document_patch(&bad).is_err());
    assert_eq!(
        engine.render(&options).unwrap(),
        fresh.render(&options).unwrap()
    );
}
