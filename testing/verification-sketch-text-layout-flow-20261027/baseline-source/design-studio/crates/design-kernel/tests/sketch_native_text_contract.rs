//! Native dictionary §4 uses UTF-16 run ranges; §5 stringValue is an instance
//! override, not a replacement of its master's attributedString or style runs.
use futureox_design_kernel::sketch::{CommandEnvelope, Document, Error, Session, SketchCommand};
use serde_json::json;
use std::io::{Cursor, Write};
fn document() -> Document {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let attributed = json!({"_class":"attributedString","string":"A😀中e\u{0301}","future":"retain",
        "attributes":[
            {"_class":"stringAttribute","location":0,"length":1,"attributes":{"MSAttributedStringFontAttribute":{"name":"First","size":12}}},
            {"_class":"stringAttribute","location":1,"length":2,"attributes":{"kerning":0.5,"unknownEmojiStyle":true}},
            {"_class":"stringAttribute","location":3,"length":1,"attributes":{"underlineStyle":1}},
            {"_class":"stringAttribute","location":4,"length":2,"attributes":{"paragraphStyle":{"alignment":1},"unknown":17}}]});
    let page = json!({"_class":"page","do_objectID":"P","layers":[
        {"_class":"symbolMaster","do_objectID":"M","symbolID":"S","layers":[
            {"_class":"text","do_objectID":"T","attributedString":attributed,"futureTextField":"保持"}]},
        {"_class":"symbolInstance","do_objectID":"I","symbolID":"S","overrideValues":[
            {"_class":"overrideValue","overrideName":"T_stringValue","value":"before","futureOverride":42}]}]});
    for (name, value) in [
        ("meta.json", json!({"version":146})),
        (
            "document.json",
            json!({"_class":"document","pages":[{"_ref":"pages/P"}]}),
        ),
        ("pages/P.json", page),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    zip.start_file("fonts/opaque", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"opaque font bytes\0\xff").unwrap();
    Document::from_sketch(&zip.finish().unwrap().into_inner()).unwrap()
}
fn apply(session: &mut Session, command: SketchCommand) {
    session
        .apply(CommandEnvelope {
            owner: session.owner().clone(),
            expected_revision: session.revision(),
            request_id: "text-test".into(),
            command,
        })
        .unwrap();
}
#[test]
fn utf16_rich_runs_and_resources_survive_emoji_override_save_undo_redo() {
    let source = document();
    let master = source.layer("M").unwrap().to_native_value();
    let text = &master["layers"][0]["attributedString"];
    assert_eq!(text["string"].as_str().unwrap().encode_utf16().count(), 6);
    assert_eq!(text["attributes"][1]["location"], 1);
    assert_eq!(text["attributes"][1]["length"], 2);
    let mut session = Session::new(source, "text-doc".into(), 1).unwrap();
    let replacement = "👩‍🚀 café\n中文 e\u{0301}";
    apply(
        &mut session,
        SketchCommand::SetTextOverride {
            instance_id: "I".into(),
            target_path: "T".into(),
            text: replacement.into(),
        },
    );
    for expected in [replacement, "before", replacement] {
        let reloaded = Document::from_sketch(&session.document().to_sketch().unwrap()).unwrap();
        assert_eq!(reloaded.layer("M").unwrap().to_native_value(), master);
        let value = &reloaded.layer("I").unwrap().fields()["overrideValues"][0];
        assert_eq!(value["value"], expected);
        assert_eq!(value["futureOverride"], 42);
        assert_eq!(
            reloaded.resource("fonts/opaque"),
            Some(b"opaque font bytes\0\xff".as_slice())
        );
        match expected {
            "before" => apply(&mut session, SketchCommand::Redo),
            _ if session.revision() == 1 => apply(&mut session, SketchCommand::Undo),
            _ => {}
        }
    }
    assert_eq!(session.revision(), 3);
}
#[test]
fn utf16_override_limit_counts_surrogate_pairs_and_rejects_atomically() {
    let mut doc = document();
    let exact = "😀".repeat(50_000);
    assert_eq!(exact.encode_utf16().count(), 100_000);
    doc.set_text_override("I", "T", &exact).unwrap();
    let before = doc.to_sketch().unwrap();
    assert!(matches!(
        doc.set_text_override("I", "T", &(exact.clone() + "x")),
        Err(Error::Limit("override text"))
    ));
    assert_eq!(before, doc.to_sketch().unwrap());
    let restored = Document::from_sketch(&before).unwrap();
    assert_eq!(
        restored.layer("I").unwrap().fields()["overrideValues"][0]["value"],
        exact
    );
}
