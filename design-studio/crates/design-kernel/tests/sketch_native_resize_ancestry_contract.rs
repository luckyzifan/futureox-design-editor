//! Conservative geometry-edit admission, not a native Sketch layout oracle.
use futureox_design_kernel::sketch::{CommandEnvelope, Document, Error, Session, SketchCommand};
use serde_json::{Value, json};
use std::io::{Cursor, Write};

fn document(ancestor: Option<Value>, container_fields: Value) -> Document {
    let mut container = json!({
        "_class":"group", "do_objectID":"CONTAINER", "name":"Original container",
        "frame":{"x":0,"y":0,"width":100,"height":100,"futureFrame":"keep"},
        "groupLayout":{"_class":"MSImmutableFreeformGroupLayout"},
        "resizesContent":true,
        "layers":[
            {"_class":"rectangle","do_objectID":"RECT","resizingConstraint":63,
             "frame":{"x":10,"y":10,"width":20,"height":20}},
            {"_class":"shapePath","do_objectID":"PATH","resizingConstraint":63,
             "frame":{"x":40,"y":40,"width":10,"height":10},"isClosed":true,
             "points":[{"point":"{0, 0}","hasCurveFrom":true,"curveFrom":"{0.25, 0.5}"},
                       {"point":"{1, 1}"}],"unknownCurve":{"keep":true}}
        ]
    });
    container
        .as_object_mut()
        .unwrap()
        .extend(container_fields.as_object().unwrap().clone());
    let selected_branch = match ancestor {
        Some(mut ancestor) => {
            ancestor["do_objectID"] = json!("ANCESTOR");
            ancestor["layers"] = json!([container]);
            ancestor
        }
        None => container,
    };
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, value) in [
        ("meta.json", json!({"version":146,"futureMeta":true})),
        (
            "document.json",
            json!({"_class":"document","pages":[{"_ref":"pages/P"}]}),
        ),
        (
            "pages/P.json",
            json!({"_class":"page","do_objectID":"P","layers":[
                {"_class":"symbolMaster","do_objectID":"UNRELATED","isLocked":true,"layers":[]},
                selected_branch
            ]}),
        ),
    ] {
        zip.start_file(
            name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    zip.start_file(
        "images/native-bytes",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    zip.write_all(&[1, 3, 5, 7, 255]).unwrap();
    Document::from_sketch(&zip.finish().unwrap().into_inner()).unwrap()
}

fn apply(
    session: &mut Session,
    command: SketchCommand,
) -> futureox_design_kernel::sketch::Result<futureox_design_kernel::sketch::Applied> {
    session.apply(CommandEnvelope {
        owner: session.owner().clone(),
        expected_revision: session.revision(),
        request_id: "resize-ancestry".into(),
        command,
    })
}
fn resize() -> SketchCommand {
    SketchCommand::ResizeLegacyContainer {
        layer_id: "CONTAINER".into(),
        width: 200.,
        height: 200.,
    }
}

#[test]
fn resize_ancestry_refusal_preserves_native_document_revision_and_redo() {
    let mut contexts = vec![
        (
            Some(json!({"_class":"symbolMaster","symbolID":"S"})),
            json!({}),
        ),
        (
            Some(json!({"_class":"symbolInstance","symbolID":"S"})),
            json!({}),
        ),
        (Some(json!({"_class":"shapeGroup"})), json!({})),
        (Some(json!({"_class":"frame"})), json!({})),
        (Some(json!({"_class":"futureContainer"})), json!({})),
        (
            Some(json!({"_class":"group","groupLayout":{"_class":"MSImmutableFlexGroupLayout"}})),
            json!({}),
        ),
        (
            Some(
                json!({"_class":"group","groupLayout":{"_class":"MSImmutableInferredGroupLayout"}}),
            ),
            json!({}),
        ),
        (
            Some(json!({"_class":"group","groupLayout":null})),
            json!({}),
        ),
        (Some(json!({"_class":"group","rotation":45})), json!({})),
        (Some(json!({"_class":"group","rotation":null})), json!({})),
        (Some(json!({"_class":"group","resizingType":1})), json!({})),
        (
            Some(json!({"_class":"group","__horizontalSizing":0})),
            json!({}),
        ),
        (Some(json!({"_class":"group","flexItem":{}})), json!({})),
        (
            Some(json!({"_class":"group","isFlippedHorizontal":true})),
            json!({}),
        ),
        (
            Some(json!({"_class":"group","isFlippedVertical":"false"})),
            json!({}),
        ),
    ];
    for value in [json!(true), json!(null), json!(0), json!("false")] {
        contexts.push((Some(json!({"_class":"group","isLocked":value})), json!({})));
        contexts.push((None, json!({"isLocked":value})));
    }
    for (index, (ancestor, fields)) in contexts.into_iter().enumerate() {
        let mut document = document(ancestor, fields);
        let before = document.to_sketch().unwrap();
        assert!(
            matches!(
                document.editable_leaf_frame("RECT"),
                Err(Error::Unsupported(_))
            ),
            "leaf context {index}"
        );
        let result = document.resize_legacy_container("CONTAINER", 200., 200.);
        assert!(
            matches!(result, Err(Error::Unsupported(_))),
            "context {index}: {result:?}"
        );
        assert_eq!(
            document.to_sketch().unwrap(),
            before,
            "direct document {index}"
        );
        let mut session = Session::new(document, "ancestry".into(), 1).unwrap();
        apply(
            &mut session,
            SketchCommand::RenameLayer {
                layer_id: "CONTAINER".into(),
                name: "Redo marker".into(),
            },
        )
        .unwrap();
        apply(&mut session, SketchCommand::Undo).unwrap();
        let revision = session.revision();
        let history = session.history_status();
        assert_eq!((history.undo_count, history.redo_count), (0, 1));
        let result = apply(&mut session, resize());
        assert!(
            matches!(result, Err(Error::Unsupported(_))),
            "session context {index}: {result:?}"
        );
        assert_eq!(session.document().to_sketch().unwrap(), before);
        assert_eq!(session.revision(), revision);
        assert_eq!(session.history_status(), history);
        apply(&mut session, SketchCommand::Redo).unwrap();
        assert_eq!(
            session.document().layer("CONTAINER").unwrap().fields()["name"],
            "Redo marker"
        );
        assert_eq!(
            session.document().layer("RECT").unwrap().fields()["frame"]["width"],
            20
        );
    }
}

#[test]
fn resize_ancestry_freeform_controls_keep_native_geometry_and_history() {
    for ancestor in [
        None,
        Some(json!({"_class":"group"})),
        Some(
            json!({"_class":"group","groupLayout":{"_class":"MSImmutableFreeformGroupLayout"},"rotation":0,"resizingType":0,"isLocked":false,"isFlippedHorizontal":false,"isFlippedVertical":false}),
        ),
        Some(
            json!({"_class":"artboard","groupLayout":{"_class":"MSImmutableFreeformGroupLayout"}}),
        ),
    ] {
        let document = document(ancestor, json!({"isLocked":false}));
        let before = document.to_sketch().unwrap();
        let points = document.layer("PATH").unwrap().fields()["points"].clone();
        assert!(document.editable_leaf_frame("RECT").is_ok());
        let mut session = Session::new(document, "freeform".into(), 1).unwrap();
        apply(&mut session, resize()).unwrap();
        assert_eq!(session.revision(), 1);
        assert_eq!(
            (
                session.history_status().undo_count,
                session.history_status().redo_count
            ),
            (1, 0)
        );
        assert_eq!(
            session.document().layer("RECT").unwrap().fields()["frame"],
            json!({"x":20.,"y":20.,"width":40.,"height":40.})
        );
        assert_eq!(
            session.document().layer("PATH").unwrap().fields()["points"],
            points
        );
        assert_eq!(
            session.document().layer("PATH").unwrap().fields()["unknownCurve"],
            json!({"keep":true})
        );
        assert_eq!(
            session.document().layer("CONTAINER").unwrap().fields()["frame"]["futureFrame"],
            "keep"
        );
        assert_eq!(
            session.document().resource("images/native-bytes"),
            Some([1, 3, 5, 7, 255].as_slice())
        );
        let after = session.document().to_sketch().unwrap();
        assert_ne!(after, before);
        apply(&mut session, SketchCommand::Undo).unwrap();
        assert_eq!(session.document().to_sketch().unwrap(), before);
        apply(&mut session, SketchCommand::Redo).unwrap();
        assert_eq!(session.document().to_sketch().unwrap(), after);
    }
}
