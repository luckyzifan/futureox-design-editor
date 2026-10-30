use futureox_design_kernel::sketch::{
    CommandEnvelope, CurveContour, Document, Error, Session, Size, SketchCommand,
};
use serde_json::{Value, json};
use std::io::{Cursor, Write};

fn document(flag: Option<(&str, Value)>, on_parent: bool) -> Document {
    let mut second = json!({"_class":"shapePath","do_objectID":"SECOND",
        "resizingConstraint":63,"frame":{"x":20,"y":20,"width":30,"height":30},
        "isClosed":false,"points":[{"point":"{0, 0}"},{"point":"{1, 1}"}],
        "futureCurve":{"keep":true}});
    let mut parent = json!({"_class":"group","do_objectID":"A",
        "frame":{"x":0,"y":0,"width":100,"height":100}});
    if let Some((key, value)) = flag {
        if on_parent {
            parent[key] = value;
        } else {
            second[key] = value;
        }
    }
    parent["layers"] = json!([
        {"_class":"rectangle","do_objectID":"FIRST","resizingConstraint":63,
            "frame":{"x":10,"y":10,"width":20,"height":20}}, second
    ]);
    let entries = [
        ("meta.json", br#"{"version":146}"#.to_vec()),
        (
            "document.json",
            br#"{"_class":"document","pages":[{"_ref":"pages/P","_ref_class":"MSImmutablePage"}]}"#
                .to_vec(),
        ),
        (
            "pages/P.json",
            serde_json::to_vec(&json!({"_class":"page","do_objectID":"P","layers":[parent]}))
                .unwrap(),
        ),
        ("images/keep", vec![0, 1, 255]),
    ];
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(
            name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
        zip.write_all(&bytes).unwrap();
    }
    Document::from_sketch(&zip.finish().unwrap().into_inner()).unwrap()
}

fn apply(session: &mut Session, command: SketchCommand) -> futureox_design_kernel::sketch::Result<()> {
    session
        .apply(CommandEnvelope {
            owner: session.owner().clone(),
            expected_revision: session.revision(),
            request_id: "flip-boundary".into(),
            command,
        })
        .map(|_| ())
}

#[test]
fn legacy_resize_flip_guard_matches_leaf_admission_and_preserves_atomic_history() {
    for key in ["isFlippedHorizontal", "isFlippedVertical"] {
        for value in [json!(true), json!(null), json!(0), json!("false")] {
            for on_parent in [false, true] {
                let mut document = document(Some((key, value.clone())), on_parent);
                let before = document.to_sketch().unwrap();
                let reloaded = Document::from_sketch(&before).unwrap();
                assert_eq!(reloaded.to_sketch().unwrap(), before);
                assert_eq!(
                    reloaded
                        .layer(if on_parent { "A" } else { "SECOND" })
                        .unwrap()
                        .fields()[key],
                    value
                );
                // Local contours and raw native fields remain readable. This
                // guard does not change archive admission or apply any flip.
                CurveContour::from_layer(reloaded.layer("SECOND").unwrap()).unwrap();
                // Manual frame editing already refuses the same native layer
                // or its flipped parent. Container resize must not bypass that
                // untransformed-layout subset, including malformed BOOL values.
                assert!(matches!(
                    document.editable_leaf_frame("SECOND"),
                    Err(Error::Unsupported(_))
                ));
                let proposal = document
                    .layer(if on_parent { "A" } else { "SECOND" })
                    .unwrap()
                    .frame_for_parent_resize(
                        Size {
                            width: 100.0,
                            height: 100.0,
                        },
                        Size {
                            width: 200.0,
                            height: 200.0,
                        },
                    );
                let result = document.resize_legacy_container("A", 200.0, 150.0);
                assert!(
                    matches!(proposal, Err(Error::Unsupported(_))),
                    "{key}={value}, parent={on_parent}: proposal={proposal:?}, resize={result:?}"
                );
                assert!(
                    matches!(result, Err(Error::Unsupported(_))),
                    "{key}={value}, parent={on_parent}: {result:?}"
                );
                assert_eq!(document.to_sketch().unwrap(), before);

                let mut session = Session::new(document, "doc".into(), 1).unwrap();
                apply(
                    &mut session,
                    SketchCommand::RenameLayer {
                        layer_id: "A".into(),
                        name: "Redo survives".into(),
                    },
                )
                .unwrap();
                apply(&mut session, SketchCommand::Undo).unwrap();
                let before = session.document().to_sketch().unwrap();
                let revision = session.revision();
                let history = session.history_status();
                assert_eq!(history.redo_count, 1);
                assert!(matches!(
                    apply(
                        &mut session,
                        SketchCommand::ResizeLegacyContainer {
                            layer_id: "A".into(),
                            width: 200.0,
                            height: 150.0
                        }
                    ),
                    Err(Error::Unsupported(_))
                ));
                assert_eq!(session.document().to_sketch().unwrap(), before);
                assert_eq!(session.revision(), revision);
                assert_eq!(session.history_status(), history);
                apply(&mut session, SketchCommand::Redo).unwrap();
                assert_eq!(
                    session.document().layer("A").unwrap().fields()["name"],
                    "Redo survives"
                );
            }
        }
    }
}

#[test]
fn legacy_resize_flip_guard_accepts_absent_or_false_without_rewriting_native_fields() {
    for flag in [
        None,
        Some(("isFlippedHorizontal", json!(false))),
        Some(("isFlippedVertical", json!(false))),
    ] {
        for on_parent in [false, true] {
            let document = document(flag.clone(), on_parent);
            let expected_flag = flag.as_ref().map(|(key, value)| (*key, value.clone()));
            let mut session = Session::new(document, "doc".into(), 1).unwrap();
            let before = session.document().to_sketch().unwrap();
            let points = session.document().layer("SECOND").unwrap().fields()["points"].clone();
            apply(
                &mut session,
                SketchCommand::ResizeLegacyContainer {
                    layer_id: "A".into(),
                    width: 200.0,
                    height: 150.0,
                },
            )
            .unwrap();
            let child = session.document().layer("SECOND").unwrap();
            assert_eq!(
                child.fields()["frame"],
                json!({"x":40.0,"y":30.0,"width":60.0,"height":45.0})
            );
            assert_eq!(child.fields()["points"], points);
            assert_eq!(child.fields()["futureCurve"], json!({"keep":true}));
            let fields = session
                .document()
                .layer(if on_parent { "A" } else { "SECOND" })
                .unwrap()
                .fields();
            if let Some((key, value)) = expected_flag {
                assert_eq!(fields.get(key), Some(&value));
            } else {
                assert!(!fields.contains_key("isFlippedHorizontal"));
                assert!(!fields.contains_key("isFlippedVertical"));
            }
            assert_eq!(
                session.document().resource("images/keep"),
                Some([0, 1, 255].as_slice())
            );
            let after = session.document().to_sketch().unwrap();
            apply(&mut session, SketchCommand::Undo).unwrap();
            assert_eq!(session.document().to_sketch().unwrap(), before);
            apply(&mut session, SketchCommand::Redo).unwrap();
            assert_eq!(session.document().to_sketch().unwrap(), after);
            assert_eq!(session.revision(), 3);
        }
    }
}
