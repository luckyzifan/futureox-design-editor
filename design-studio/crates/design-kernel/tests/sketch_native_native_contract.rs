use futureox_design_kernel::sketch::{CurveContour, Document, Error, LayerKind, PathSink, Point};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{Cursor, Read, Write},
};

fn archive(entries: Vec<(String, Vec<u8>)>, compressed: bool) -> Vec<u8> {
    let mut z = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(if compressed {
        zip::CompressionMethod::Deflated
    } else {
        zip::CompressionMethod::Stored
    });
    for (name, bytes) in entries {
        z.start_file(name, options).unwrap();
        z.write_all(&bytes).unwrap();
    }
    z.finish().unwrap().into_inner()
}
fn parts(layers: Vec<Value>) -> Vec<(String, Vec<u8>)> {
    vec![
        ("meta.json".into(),br#"{"version":146,"futureMeta":{"keep":true}}"#.to_vec()),
        ("document.json".into(),serde_json::to_vec(&json!({"_class":"document","pages":[{"_ref":"pages/P","_ref_class":"MSImmutablePage"}],"sharedLayerStyles":{"objects":[]},"futureDocument":{"retain":[1,2]}})).unwrap()),
        ("pages/P.json".into(),serde_json::to_vec(&json!({"_class":"page","do_objectID":"P","layers":layers,"nativePageExtra":42})).unwrap()),
        ("images/image-hash".into(),vec![0,1,2,3,255]),
        ("user.json".into(),br#"{ "zoom": 1.25 }"#.to_vec()),
        ("unknown/native-part.bin".into(),vec![9,8,7]),
    ]
}
fn unpack(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut out = BTreeMap::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let mut b = Vec::new();
        f.read_to_end(&mut b).unwrap();
        out.insert(String::from_utf8_lossy(f.name_raw()).into_owned(), b);
    }
    out
}
fn symbols() -> Vec<Value> {
    vec![
        json!({"_class":"symbolMaster","do_objectID":"MASTER","symbolID":"S","layers":[{"_class":"group","do_objectID":"G","layers":[{"_class":"text","do_objectID":"TEXT","attributedString":{"string":"original"},"fontDescriptor":{"native":"unmodified"}}]}]}),
        json!({"_class":"symbolInstance","do_objectID":"INSTANCE","symbolID":"S","resizingConstraint":45,"overrideValues":[{"_class":"overrideValue","overrideName":"G/TEXT_stringValue","value":"before","unknownOverride":true}],"futureInstance":17}),
    ]
}
#[test]
fn native_page_tree_and_unknown_payloads_roundtrip_without_foreign_model() {
    let source = archive(parts(symbols()), false);
    let doc = Document::from_sketch(&source).unwrap();
    assert_eq!(doc.pages()[0].root().kind(), LayerKind::Page);
    assert_eq!(doc.pages()[0].root().children().len(), 2);
    assert_eq!(unpack(&source), unpack(&doc.to_sketch().unwrap()));
    let pins = doc
        .layer("INSTANCE")
        .unwrap()
        .resizing_constraints()
        .unwrap()
        .unwrap();
    assert_eq!((pins.horizontal, pins.vertical), (5, 5));
}
#[test]
fn symbol_text_override_edits_instance_not_master_and_preserves_unknowns() {
    let mut doc = Document::from_sketch(&archive(parts(symbols()), false)).unwrap();
    let master = doc.layer("MASTER").unwrap().to_native_value();
    doc.set_text_override("INSTANCE", "G/TEXT", "你好 👩‍🚀")
        .unwrap();
    doc.rename_layer("INSTANCE", "Named instance").unwrap();
    let reloaded = Document::from_sketch(&doc.to_sketch().unwrap()).unwrap();
    assert_eq!(reloaded.layer("MASTER").unwrap().to_native_value(), master);
    assert!(reloaded.resource("pages/P.json").is_none());
    assert!(reloaded.resource("document.json").is_none());
    let instance = reloaded.layer("INSTANCE").unwrap().fields();
    assert_eq!(instance["overrideValues"][0]["value"], "你好 👩‍🚀");
    assert_eq!(instance["overrideValues"][0]["unknownOverride"], true);
    assert_eq!(instance["futureInstance"], 17);
    assert_eq!(
        reloaded.resource("images/image-hash"),
        Some([0, 1, 2, 3, 255].as_slice())
    );
}
#[test]
fn ambiguous_master_or_override_and_nontext_target_fail_without_mutation() {
    for mode in 0..4 {
        let mut layers = symbols();
        if mode == 0 {
            let mut duplicate = layers[0].clone();
            duplicate["do_objectID"] = json!("OTHER_MASTER");
            duplicate["layers"] = json!([]);
            layers.push(duplicate);
        }
        if mode == 1 {
            let duplicate = layers[1]["overrideValues"][0].clone();
            layers[1]["overrideValues"]
                .as_array_mut()
                .unwrap()
                .push(duplicate);
        }
        let mut doc = Document::from_sketch(&archive(parts(layers), false)).unwrap();
        let before = doc.to_sketch().unwrap();
        let path = match mode {
            2 => "G",
            3 => "TEXT",
            _ => "G/TEXT",
        };
        assert!(doc.set_text_override("INSTANCE", path, "change").is_err());
        assert_eq!(doc.to_sketch().unwrap(), before);
    }
}
#[test]
fn duplicate_native_identity_and_dangling_page_ref_are_rejected() {
    let layer = json!({"_class":"rectangle","do_objectID":"A"});
    assert!(matches!(
        Document::from_sketch(&archive(parts(vec![layer.clone(), layer]), false)),
        Err(Error::Ambiguous(_))
    ));
    let mut entries = parts(vec![]);
    entries.retain(|(n, _)| n != "pages/P.json");
    assert!(matches!(
        Document::from_sketch(&archive(entries, false)),
        Err(Error::Missing(_))
    ));
}
fn path_layer(closed: bool) -> Value {
    json!({"_class":"shapePath","do_objectID":"PATH","frame":{"x":10,"y":20,"width":200,"height":100},"isClosed":closed,"points":[
        {"point":"{0, 0.5}","hasCurveFrom":true,"curveFrom":"{0.25, 0}","hasCurveTo":false},
        {"point":{"x":1,"y":0.5},"hasCurveFrom":false,"hasCurveTo":true,"curveTo":"{0.75, 1}"}
    ]})
}
#[derive(Default)]
struct Sink(Vec<String>);
impl PathSink for Sink {
    type Error = ();
    fn move_to(&mut self, p: Point) -> Result<(), ()> {
        self.0.push(format!("M{p:?}"));
        Ok(())
    }
    fn line_to(&mut self, p: Point) -> Result<(), ()> {
        self.0.push(format!("L{p:?}"));
        Ok(())
    }
    fn cubic_to(&mut self, a: Point, b: Point, p: Point) -> Result<(), ()> {
        self.0.push(format!("C{a:?}{b:?}{p:?}"));
        Ok(())
    }
    fn close(&mut self) -> Result<(), ()> {
        self.0.push("Z".into());
        Ok(())
    }
}
#[test]
fn normalized_handles_scale_by_frame_and_open_contour_stays_open() {
    let doc = Document::from_sketch(&archive(parts(vec![path_layer(false)]), false)).unwrap();
    let curve = CurveContour::from_layer(doc.layer("PATH").unwrap()).unwrap();
    assert_eq!(curve.points()[0].point, [0., 50.]);
    assert_eq!(curve.points()[0].outgoing, Some([50., 0.]));
    assert_eq!(curve.points()[1].incoming, Some([150., 100.]));
    let mut sink = Sink::default();
    curve.emit(&mut sink).unwrap();
    assert_eq!(
        sink.0,
        vec!["M[0.0, 50.0]", "C[50.0, 0.0][150.0, 100.0][200.0, 50.0]"]
    );
}
#[test]
fn closed_contour_emits_final_edge_and_close() {
    let doc = Document::from_sketch(&archive(parts(vec![path_layer(true)]), false)).unwrap();
    let mut sink = Sink::default();
    CurveContour::from_layer(doc.layer("PATH").unwrap())
        .unwrap()
        .emit(&mut sink)
        .unwrap();
    assert_eq!(sink.0.len(), 4);
    assert_eq!(sink.0[2], "L[0.0, 50.0]");
    assert_eq!(sink.0[3], "Z");
}
#[test]
fn malformed_enabled_handles_fail_without_nan_or_silent_default() {
    for bad in [json!("{NaN, 1}"), json!({"x":1}), json!("not a point")] {
        let mut layer = path_layer(false);
        layer["points"][0]["curveFrom"] = bad;
        let doc = Document::from_sketch(&archive(parts(vec![layer]), false)).unwrap();
        assert!(CurveContour::from_layer(doc.layer("PATH").unwrap()).is_err());
    }
}
#[test]
fn zip_traversal_duplicate_entries_and_expansion_ratio_fail_closed() {
    for path in [
        "../escape",
        "/absolute",
        "a/../b",
        "a\\b",
        "C:drive",
        "a//b",
    ] {
        let mut entries = parts(vec![]);
        entries.push((path.into(), vec![1]));
        assert!(
            Document::from_sketch(&archive(entries, false)).is_err(),
            "{path}"
        );
    }
    // ZIP writer rejects duplicate names; mutate equal-length central/local names
    // to construct a duplicate fixture without weakening the production reader.
    let mut entries = parts(vec![]);
    entries.push(("sameA".into(), vec![1]));
    entries.push(("sameB".into(), vec![2]));
    let mut bytes = archive(entries, false);
    for i in 0..bytes.len() - 5 {
        if &bytes[i..i + 5] == b"sameB" {
            bytes[i + 4] = b'A';
        }
    }
    assert!(Document::from_sketch(&bytes).is_err());
    let mut entries = parts(vec![]);
    entries.push(("bomb".into(), vec![0; 1_000_000]));
    assert!(matches!(
        Document::from_sketch(&archive(entries, true)),
        Err(Error::Limit("compression ratio"))
    ));
}
#[test]
fn kernel_session_owner_revision_and_closed_epoch_fence_native_edits() {
    use futureox_design_kernel::sketch::{CommandEnvelope, Session, SketchCommand};
    let document = Document::from_sketch(&archive(parts(symbols()), false)).unwrap();
    let mut session = Session::new(document, "document-1".into(), 7).unwrap();
    let command = CommandEnvelope {
        owner: session.owner().clone(),
        expected_revision: 0,
        request_id: "request-1".into(),
        command: SketchCommand::RenameLayer {
            layer_id: "INSTANCE".into(),
            name: "New".into(),
        },
    };
    let before = session.document().to_sketch().unwrap();
    for mode in 0..5 {
        let mut wrong = command.clone();
        match mode {
            0 => wrong.owner.kernel_id = "figma".into(),
            1 => wrong.owner.document_schema = "design-document".into(),
            2 => wrong.owner.document_id = "other".into(),
            3 => wrong.owner.session_epoch = 6,
            _ => wrong.expected_revision = 1,
        };
        assert!(session.apply(wrong).is_err());
        assert_eq!(session.revision(), 0);
        assert_eq!(session.document().to_sketch().unwrap(), before);
    }
    let applied = session.apply(command.clone()).unwrap();
    assert_eq!(applied.revision, 1);
    assert!(session.apply(command.clone()).is_err());
    let mut next = command;
    next.expected_revision = 1;
    session.close();
    assert!(session.apply(next).is_err());
    assert_eq!(session.revision(), 1);
    assert!(
        serde_json::from_value::<SketchCommand>(json!({"kind":"apply_figma_ops","ops":[]}))
            .is_err()
    );
}

#[test]
fn unknown_numeric_fields_survive_an_unrelated_native_layer_edit_exactly() {
    // Raw source is essential: creating a Value from an f64 would already lose
    // the precision this native archive boundary must preserve.
    let page = br#"{"_class":"page","do_objectID":"P","layers":[{"_class":"rectangle","do_objectID":"A","name":"Old","futureNumber":18446744073709551617,"futureFraction":0.12345678901234567890123456789}]}"#;
    let mut entries = parts(vec![]);
    entries
        .iter_mut()
        .find(|(name, _)| name == "pages/P.json")
        .unwrap()
        .1 = page.to_vec();
    let mut document = Document::from_sketch(&archive(entries, false)).unwrap();
    document.rename_layer("A", "New").unwrap();
    let output = document.to_sketch().unwrap();
    let native = unpack(&output);
    let page: Value = serde_json::from_slice(&native["pages/P.json"]).unwrap();
    let raw: BTreeMap<String, Box<serde_json::value::RawValue>> =
        serde_json::from_slice(&native["pages/P.json"]).unwrap();
    let layers: Vec<Box<serde_json::value::RawValue>> =
        serde_json::from_str(raw["layers"].get()).unwrap();
    let layer: BTreeMap<String, Box<serde_json::value::RawValue>> =
        serde_json::from_str(layers[0].get()).unwrap();
    assert_eq!(layer["futureNumber"].get(), "18446744073709551617");
    assert_eq!(
        layer["futureFraction"].get(),
        "0.12345678901234567890123456789"
    );
    assert_eq!(page["layers"][0]["name"], "New");
    let reloaded = Document::from_sketch(&output).unwrap();
    assert_eq!(
        reloaded
            .layer("A")
            .unwrap()
            .native_field_json("futureNumber")
            .unwrap()
            .unwrap(),
        "18446744073709551617"
    );
    assert_eq!(
        reloaded
            .layer("A")
            .unwrap()
            .native_field_json("futureFraction")
            .unwrap()
            .unwrap(),
        "0.12345678901234567890123456789"
    );
}

#[test]
fn legacy_parent_resize_proposes_native_edges_sizes_and_relative_centers() {
    use futureox_design_kernel::sketch::Size;
    // Asymmetric frame distinguishes center-proportional from free-margin-ratio
    // positioning, and single-pin sizing from whole-parent proportional sizing.
    let expected = [
        (1, 20.0, 30.0),
        (2, 20.0, 130.0),
        (3, 20.0, 67.5),
        (4, 120.0, 30.0),
        (5, 55.0, 30.0),
        (6, 60.0, 90.0),
        (7, 40.0, 60.0),
    ];
    for (bits, position, extent) in expected {
        let source = archive(
            parts(vec![json!({"_class":"rectangle","do_objectID":"R",
            "resizingConstraint": bits | (bits << 3), "resizingType":0,
            "frame":{"x":20,"y":20,"width":30,"height":30,"constrainProportions":false},
            "futureResize":{"keep":true}})]),
            false,
        );
        let doc = Document::from_sketch(&source).unwrap();
        let layer = doc.layer("R").unwrap();
        let f = layer
            .frame_for_parent_resize(
                Size {
                    width: 100.0,
                    height: 100.0,
                },
                Size {
                    width: 200.0,
                    height: 200.0,
                },
            )
            .unwrap();
        assert_eq!(
            (f.x, f.y, f.width, f.height),
            (position, position, extent, extent),
            "mask {bits}"
        );
        assert_eq!(unpack(&source), unpack(&doc.to_sketch().unwrap()));
    }

    let source = archive(
        parts(vec![json!({"_class":"rectangle","do_objectID":"R",
        "resizingConstraint": 2 | (5 << 3),
        "frame":{"x":20,"y":20,"width":30,"height":30}})]),
        false,
    );
    let doc = Document::from_sketch(&source).unwrap();
    let layer = doc.layer("R").unwrap();
    let f = layer
        .frame_for_parent_resize(
            Size {
                width: 100.0,
                height: 100.0,
            },
            Size {
                width: 80.0,
                height: 60.0,
            },
        )
        .unwrap();
    assert_eq!((f.x, f.width, f.y, f.height), (20.0, 10.0, 6.0, 30.0));
    // Pinning cannot fit the requested shrink; never silently flip or clamp.
    assert!(matches!(
        layer.frame_for_parent_resize(
            Size {
                width: 100.0,
                height: 100.0
            },
            Size {
                width: 50.0,
                height: 100.0
            }
        ),
        Err(Error::Unsupported(_))
    ));
}

#[test]
fn legacy_parent_resize_refuses_unsupported_semantics_without_changing_native_data() {
    use futureox_design_kernel::sketch::Size;
    let base = json!({"_class":"rectangle","do_objectID":"R","resizingConstraint":63,
        "frame":{"x":20,"y":20,"width":30,"height":30}});
    let mut variants = Vec::new();
    for (key, value) in [
        ("horizontalPins", json!(0)),
        ("__verticalSizing", json!(999)),
        ("rotation", json!(45)),
        ("resizingType", json!(1)),
        ("resizingConstraint", json!(0)),
    ] {
        let mut v = base.clone();
        v[key] = value;
        variants.push(v);
    }
    let mut aspect = base.clone();
    aspect["frame"]["constrainProportions"] = json!(true);
    variants.push(aspect);
    for value in variants {
        let source = archive(parts(vec![value]), false);
        let doc = Document::from_sketch(&source).unwrap();
        assert!(matches!(
            doc.layer("R").unwrap().frame_for_parent_resize(
                Size {
                    width: 100.0,
                    height: 100.0
                },
                Size {
                    width: 200.0,
                    height: 200.0
                }
            ),
            Err(Error::Unsupported(_))
        ));
        assert_eq!(unpack(&source), unpack(&doc.to_sketch().unwrap()));
    }
    let doc = Document::from_sketch(&archive(parts(vec![base]), false)).unwrap();
    for old in [0.0, f64::NAN, 1e100] {
        assert!(
            doc.layer("R")
                .unwrap()
                .frame_for_parent_resize(
                    Size {
                        width: old,
                        height: 100.0
                    },
                    Size {
                        width: 200.0,
                        height: 200.0
                    }
                )
                .is_err()
        );
    }
}

#[test]
fn session_legacy_resize_is_fenced_and_commits_parent_and_direct_children_together() {
    use futureox_design_kernel::sketch::{CommandEnvelope, Session, SketchCommand};
    let parent = json!({"_class":"artboard","do_objectID":"A","resizesContent":true,
        "groupLayout":{"_class":"MSImmutableFreeformGroupLayout"},
        "frame":{"x":400,"y":300,"width":100,"height":100,"futureFrame":"keep"},
        "layers":[{"_class":"rectangle","do_objectID":"R","resizingConstraint":9,
            "frame":{"x":20,"y":20,"width":30,"height":30,"unknown":42}},
            {"_class":"shapePath","do_objectID":"S","resizingConstraint":63,
            "frame":{"x":20,"y":20,"width":30,"height":30},"points":[{"point":"{0.5, 0.5}"}]}]});
    let doc = Document::from_sketch(&archive(parts(vec![parent]), false)).unwrap();
    let mut session = Session::new(doc, "document".into(), 7).unwrap();
    let command = CommandEnvelope {
        owner: session.owner().clone(),
        expected_revision: 0,
        request_id: "resize".into(),
        command: SketchCommand::ResizeLegacyContainer {
            layer_id: "A".into(),
            width: 200.0,
            height: 150.0,
        },
    };
    let before = session.document().to_sketch().unwrap();
    for kind in 0..3 {
        let mut wrong = command.clone();
        match kind {
            0 => wrong.owner.kernel_id = "figma".into(),
            1 => wrong.owner.session_epoch = 8,
            _ => wrong.expected_revision = 1,
        }
        assert!(session.apply(wrong).is_err());
        assert_eq!(session.revision(), 0);
        assert_eq!(session.document().to_sketch().unwrap(), before);
    }
    session.apply(command.clone()).unwrap();
    assert_eq!(session.revision(), 1);
    let doc = Document::from_sketch(&session.document().to_sketch().unwrap()).unwrap();
    assert_eq!(
        doc.layer("A").unwrap().fields()["frame"],
        json!({"x":400,"y":300,"width":200.0,"height":150.0,"futureFrame":"keep"})
    );
    assert_eq!(
        doc.layer("R").unwrap().fields()["frame"],
        json!({"x":20.0,"y":20.0,"width":30.0,"height":30.0,"unknown":42})
    );
    assert_eq!(
        doc.layer("S").unwrap().fields()["frame"],
        json!({"x":40.0,"y":30.0,"width":60.0,"height":45.0})
    );
    assert_eq!(
        doc.layer("S").unwrap().fields()["points"],
        json!([{"point":"{0.5, 0.5}"}])
    );
    assert!(session.apply(command).is_err());
    assert_eq!(session.revision(), 1);
}

#[test]
fn session_legacy_resize_rejects_later_unsupported_child_with_zero_partial_writes() {
    use futureox_design_kernel::sketch::{CommandEnvelope, Session, SketchCommand};
    for extra in [
        json!({"horizontalPins":0}),
        json!({"rotation":45}),
        json!({"layers":[{"_class":"rectangle","do_objectID":"N"}]}),
    ] {
        let mut second = json!({"_class":"rectangle","do_objectID":"SECOND","resizingConstraint":63,
            "frame":{"x":10,"y":10,"width":20,"height":20}});
        second
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let parent = json!({"_class":"group","do_objectID":"A","frame":{"x":0,"y":0,"width":100,"height":100},
            "layers":[{"_class":"rectangle","do_objectID":"FIRST","resizingConstraint":63,
                "frame":{"x":10,"y":10,"width":20,"height":20}},second]});
        let doc = Document::from_sketch(&archive(parts(vec![parent]), false)).unwrap();
        let mut session = Session::new(doc, "document".into(), 1).unwrap();
        let before = session.document().to_sketch().unwrap();
        let result = session.apply(CommandEnvelope {
            owner: session.owner().clone(),
            expected_revision: 0,
            request_id: "resize".into(),
            command: SketchCommand::ResizeLegacyContainer {
                layer_id: "A".into(),
                width: 200.0,
                height: 200.0,
            },
        });
        assert!(matches!(result, Err(Error::Unsupported(_))));
        assert_eq!(session.revision(), 0);
        assert_eq!(session.document().to_sketch().unwrap(), before);
    }
}

fn resize_curve_projection_document(axis: usize, handle: &str, coordinate: f64) -> Document {
    let mut control = [0.5, 0.5];
    control[axis] = coordinate;
    let mut point = json!({"point":"{0.5, 0.5}"});
    point[handle] = json!({"x":control[0],"y":control[1]});
    point[if handle == "curveFrom" {
        "hasCurveFrom"
    } else {
        "hasCurveTo"
    }] = json!(true);
    let parent = json!({"_class":"group","do_objectID":"A",
        "frame":{"x":0,"y":0,"width":2_000_000,"height":2_000_000},
        "layers":[{"_class":"rectangle","do_objectID":"FIRST","resizingConstraint":63,
            "frame":{"x":10,"y":10,"width":20,"height":20}},
            {"_class":"shapePath","do_objectID":"CURVE","resizingConstraint":63,
            "frame":{"x":0,"y":0,"width":1_000_000,"height":1_000_000},
            "points":[point],"futureCurve":{"keep":true}}]});
    Document::from_sketch(&archive(parts(vec![parent]), false)).unwrap()
}

#[test]
fn resize_curve_projection_rejects_oversized_handles_atomically() {
    use futureox_design_kernel::sketch::{Session, SketchCommand};
    // These are the implementation's accepted-coordinate bounds, not a claim
    // about Sketch's file-format limits. Both source contours are accepted.
    for axis in 0..2 {
        for handle in ["curveFrom", "curveTo"] {
            for coordinate in [-5.0, 5.0] {
                let mut document = resize_curve_projection_document(axis, handle, coordinate);
                CurveContour::from_layer(document.layer("CURVE").unwrap()).unwrap();
                let before = document.to_sketch().unwrap();
                let mut size = [2_000_000.0; 2];
                size[axis] = 6_000_000.0;
                // The frame remains valid, but the 3x control projection would
                // become +/-15,000,000, beyond CurveContour's +/-10,000,000.
                let result = document.resize_legacy_container("A", size[0], size[1]);
                assert!(
                    matches!(&result, Err(Error::Limit("local coordinate"))),
                    "resize result: {result:?}; resulting contour: {:?}",
                    CurveContour::from_layer(document.layer("CURVE").unwrap())
                );
                assert_eq!(document.to_sketch().unwrap(), before);

                let mut session = Session::new(document, "doc".into(), 1).unwrap();
                history_apply(
                    &mut session,
                    SketchCommand::RenameLayer {
                        layer_id: "A".into(),
                        name: "Preserved redo".into(),
                    },
                )
                .unwrap();
                history_apply(&mut session, SketchCommand::Undo).unwrap();
                let before = session.document().to_sketch().unwrap();
                let revision = session.revision();
                let history = session.history_status();
                assert_eq!(history.redo_count, 1);
                assert!(matches!(
                    history_apply(
                        &mut session,
                        SketchCommand::ResizeLegacyContainer {
                            layer_id: "A".into(),
                            width: size[0],
                            height: size[1],
                        }
                    ),
                    Err(Error::Limit("local coordinate"))
                ));
                assert_eq!(session.document().to_sketch().unwrap(), before);
                assert_eq!(session.revision(), revision);
                assert_eq!(session.history_status(), history);
                history_apply(&mut session, SketchCommand::Redo).unwrap();
                assert_eq!(
                    session.document().layer("A").unwrap().fields()["name"],
                    "Preserved redo"
                );
            }
        }
    }
}

#[test]
fn resize_curve_projection_keeps_exact_bound_and_native_history() {
    use futureox_design_kernel::sketch::{Session, SketchCommand};
    for axis in 0..2 {
        for handle in ["curveFrom", "curveTo"] {
            let document = resize_curve_projection_document(axis, handle, 5.0);
            let mut session = Session::new(document, "doc".into(), 1).unwrap();
            let before = unpack(&session.document().to_sketch().unwrap());
            let points = session.document().layer("CURVE").unwrap().fields()["points"].clone();
            let mut size = [2_000_000.0; 2];
            size[axis] = 4_000_000.0;
            history_apply(
                &mut session,
                SketchCommand::ResizeLegacyContainer {
                    layer_id: "A".into(),
                    width: size[0],
                    height: size[1],
                },
            )
            .unwrap();
            let layer = session.document().layer("CURVE").unwrap();
            let contour = CurveContour::from_layer(layer).unwrap();
            let control = if handle == "curveFrom" {
                contour.points()[0].outgoing.unwrap()
            } else {
                contour.points()[0].incoming.unwrap()
            };
            assert_eq!(control[axis], 10_000_000.0);
            assert_eq!(layer.fields()["points"], points);
            assert_eq!(layer.fields()["futureCurve"], json!({"keep":true}));
            assert_eq!(
                session.document().resource("images/image-hash"),
                Some([0, 1, 2, 3, 255].as_slice())
            );
            let edited = unpack(&session.document().to_sketch().unwrap());
            history_apply(&mut session, SketchCommand::Undo).unwrap();
            assert_eq!(unpack(&session.document().to_sketch().unwrap()), before);
            history_apply(&mut session, SketchCommand::Redo).unwrap();
            assert_eq!(unpack(&session.document().to_sketch().unwrap()), edited);
            CurveContour::from_layer(session.document().layer("CURVE").unwrap()).unwrap();
            assert_eq!(session.revision(), 3);
        }
    }
}

fn nested_symbols() -> Vec<Value> {
    vec![
        json!({"_class":"symbolMaster","do_objectID":"OUTER","symbolID":"OUT",
            "layers":[{"_class":"symbolInstance","do_objectID":"NESTED","symbolID":"INNER","overrideValues":[]}]}),
        json!({"_class":"symbolMaster","do_objectID":"INNER-MASTER","symbolID":"INNER",
            "layers":[{"_class":"text","do_objectID":"LABEL","attributedString":{"string":"master text"}}]}),
        json!({"_class":"symbolInstance","do_objectID":"ONE","symbolID":"OUT",
            "overrideValues":[{"_class":"overrideValue","overrideName":"NESTED/LABEL_stringValue","value":"old","future":17}]}),
        json!({"_class":"symbolInstance","do_objectID":"TWO","symbolID":"OUT","overrideValues":[]}),
    ]
}
#[test]
fn nested_text_override_targets_outer_instance_and_preserves_native_masters_and_peer() {
    let mut doc = Document::from_sketch(&archive(parts(nested_symbols()), false)).unwrap();
    let untouched: [Value; 4] = ["OUTER", "INNER-MASTER", "NESTED", "TWO"]
        .map(|id| doc.layer(id).unwrap().to_native_value());
    doc.set_text_override("ONE", "NESTED/LABEL", "nested text")
        .unwrap();
    let reloaded = Document::from_sketch(&doc.to_sketch().unwrap()).unwrap();
    for (id, original) in ["OUTER", "INNER-MASTER", "NESTED", "TWO"]
        .into_iter()
        .zip(untouched)
    {
        assert_eq!(reloaded.layer(id).unwrap().to_native_value(), original);
    }
    assert_eq!(
        reloaded.layer("ONE").unwrap().fields()["overrideValues"],
        json!([
        {"_class":"overrideValue","overrideName":"NESTED/LABEL_stringValue","value":"nested text","future":17}])
    );
}
#[test]
fn nested_text_override_refuses_swaps_ambiguous_masters_cycles_and_missing_targets_atomically() {
    for case in 0..7 {
        let mut layers = nested_symbols();
        let path = if case == 4 {
            "NESTED/NESTED/LABEL"
        } else {
            "NESTED/LABEL"
        };
        match case {
            0=>layers[2]["overrideValues"].as_array_mut().unwrap().push(json!({"overrideName":"NESTED_symbolID","value":"OTHER"})),
            1=>layers[0]["layers"][0]["overrideValues"]=json!([{"overrideName":"CHILD_symbolID","value":"OTHER"}]),
            2=>layers.push(json!({"_class":"symbolMaster","do_objectID":"DUP-MASTER","symbolID":"INNER","layers":[]})),
            3=>layers[0]["layers"][0]["symbolID"]=json!("EXTERNAL"),
            4=>layers[0]["layers"][0]["symbolID"]=json!("OUT"),
            5=>layers[1]["layers"][0]["do_objectID"]=json!("DIFFERENT"),
            _=>layers[2]["overrideValues"].as_array_mut().unwrap().push(json!({"overrideName":"NESTED/LABEL_stringValue","value":"duplicate"})),
        }
        let mut doc = Document::from_sketch(&archive(parts(layers), false)).unwrap();
        let before = doc.to_sketch().unwrap();
        assert!(
            doc.set_text_override("ONE", path, "must not write")
                .is_err(),
            "case {case}"
        );
        assert_eq!(doc.to_sketch().unwrap(), before, "case {case}");
    }
    let mut duplicate = nested_symbols();
    duplicate[1]["layers"]
        .as_array_mut()
        .unwrap()
        .push(json!({"_class":"text","do_objectID":"LABEL"}));
    assert!(matches!(
        Document::from_sketch(&archive(parts(duplicate), false)),
        Err(Error::Ambiguous(_))
    ));
}

fn history_apply(
    session: &mut futureox_design_kernel::sketch::Session,
    command: futureox_design_kernel::sketch::SketchCommand,
) -> futureox_design_kernel::sketch::Result<futureox_design_kernel::sketch::Applied> {
    session.apply(futureox_design_kernel::sketch::CommandEnvelope {
        owner: session.owner().clone(),
        expected_revision: session.revision(),
        request_id: "edit".into(),
        command,
    })
}
#[test]
fn native_history_undo_redo_restores_all_three_edits_and_opaque_resources() {
    use futureox_design_kernel::sketch::{Session, SketchCommand};
    let mut layers = symbols();
    layers.push(json!({"_class":"group","do_objectID":"BOX","frame":{"x":0,"y":0,"width":100,"height":100},
        "layers":[{"_class":"rectangle","do_objectID":"RECT","resizingConstraint":63,"frame":{"x":10,"y":10,"width":20,"height":20},"future":{"keep":true}}]}));
    let mut session = Session::new(
        Document::from_sketch(&archive(parts(layers), false)).unwrap(),
        "doc".into(),
        1,
    )
    .unwrap();
    let mut states = vec![unpack(&session.document().to_sketch().unwrap())];
    for command in [
        SketchCommand::RenameLayer {
            layer_id: "RECT".into(),
            name: "new name".into(),
        },
        SketchCommand::SetTextOverride {
            instance_id: "INSTANCE".into(),
            target_path: "G/TEXT".into(),
            text: "override".into(),
        },
        SketchCommand::ResizeLegacyContainer {
            layer_id: "BOX".into(),
            width: 200.0,
            height: 200.0,
        },
    ] {
        history_apply(&mut session, command).unwrap();
        states.push(unpack(&session.document().to_sketch().unwrap()));
    }
    for state in states[..3].iter().rev() {
        history_apply(&mut session, SketchCommand::Undo).unwrap();
        assert_eq!(&unpack(&session.document().to_sketch().unwrap()), state);
    }
    assert_eq!(session.revision(), 6);
    for state in &states[1..] {
        history_apply(&mut session, SketchCommand::Redo).unwrap();
        assert_eq!(&unpack(&session.document().to_sketch().unwrap()), state);
    }
    assert_eq!(session.revision(), 9);
    assert_eq!(session.history_status().undo_count, 3);
    assert_eq!(session.history_status().redo_count, 0);
}
#[test]
fn native_history_rejects_failed_stale_and_closed_edits_and_new_branch_clears_redo() {
    use futureox_design_kernel::sketch::{CommandEnvelope, Session, SketchCommand};
    let mut session = Session::new(
        Document::from_sketch(&archive(parts(symbols()), false)).unwrap(),
        "doc".into(),
        7,
    )
    .unwrap();
    history_apply(
        &mut session,
        SketchCommand::RenameLayer {
            layer_id: "INSTANCE".into(),
            name: "first".into(),
        },
    )
    .unwrap();
    history_apply(&mut session, SketchCommand::Undo).unwrap();
    let status = session.history_status();
    let revision = session.revision();
    let data = session.document().to_sketch().unwrap();
    assert!(
        history_apply(
            &mut session,
            SketchCommand::RenameLayer {
                layer_id: "MISSING".into(),
                name: "error".into()
            }
        )
        .is_err()
    );
    for variant in 0..3 {
        let mut e = CommandEnvelope {
            owner: session.owner().clone(),
            expected_revision: revision,
            request_id: "edit".into(),
            command: SketchCommand::Redo,
        };
        match variant {
            0 => e.owner.session_epoch += 1,
            1 => e.expected_revision -= 1,
            _ => e.request_id.clear(),
        }
        assert!(session.apply(e).is_err());
    }
    assert_eq!(session.history_status(), status);
    assert_eq!(session.revision(), revision);
    assert_eq!(session.document().to_sketch().unwrap(), data);
    history_apply(
        &mut session,
        SketchCommand::RenameLayer {
            layer_id: "INSTANCE".into(),
            name: "branch".into(),
        },
    )
    .unwrap();
    assert_eq!(session.history_status().redo_count, 0);
    assert!(history_apply(&mut session, SketchCommand::Redo).is_err());
    let status = session.history_status();
    let revision = session.revision();
    let data = session.document().to_sketch().unwrap();
    session.close();
    assert!(history_apply(&mut session, SketchCommand::Undo).is_err());
    assert_eq!(session.history_status(), status);
    assert_eq!(session.revision(), revision);
    assert_eq!(session.document().to_sketch().unwrap(), data);
}
#[test]
fn native_history_bounds_entries_and_payload_bytes_without_untracked_mutation() {
    use futureox_design_kernel::sketch::{MAX_HISTORY_BYTES, Session, SketchCommand};
    let document = Document::from_sketch(&archive(parts(symbols()), false)).unwrap();
    let rename = |n| SketchCommand::RenameLayer {
        layer_id: "INSTANCE".into(),
        name: format!("name{n}"),
    };
    let mut session =
        Session::with_history_limits(document.clone(), "doc".into(), 1, 2, MAX_HISTORY_BYTES)
            .unwrap();
    for n in 0..3 {
        history_apply(&mut session, rename(n)).unwrap();
    }
    assert_eq!(session.history_status().undo_count, 2);
    for _ in 0..2 {
        history_apply(&mut session, SketchCommand::Undo).unwrap();
    }
    assert!(history_apply(&mut session, SketchCommand::Undo).is_err());
    assert_eq!(
        session.document().layer("INSTANCE").unwrap().fields()["name"],
        "name0"
    );
    let mut probe = Session::new(document.clone(), "doc".into(), 1).unwrap();
    history_apply(&mut probe, rename(0)).unwrap();
    let budget = probe.history_status().retained_bytes + 100;
    let mut bounded =
        Session::with_history_limits(document.clone(), "doc".into(), 1, 32, budget).unwrap();
    for n in 0..3 {
        history_apply(&mut bounded, rename(n)).unwrap();
    }
    assert_eq!(bounded.history_status().undo_count, 1);
    assert!(bounded.history_status().retained_bytes <= budget);
    let mut tiny = Session::with_history_limits(document, "doc".into(), 1, 2, 1).unwrap();
    let before = tiny.document().to_sketch().unwrap();
    assert!(matches!(
        history_apply(&mut tiny, rename(0)),
        Err(Error::Limit("history bytes"))
    ));
    assert_eq!(tiny.revision(), 0);
    assert_eq!(tiny.history_status().retained_bytes, 0);
    assert_eq!(tiny.document().to_sketch().unwrap(), before);
}

#[test]
fn leaf_frame_edit_uses_native_coordinates_and_existing_history_without_touching_resources() {
    use futureox_design_kernel::sketch::{Session, SketchCommand};
    for kind in ["rectangle", "oval", "bitmap", "shapePath"] {
        let mut leaf = path_layer(false);
        leaf["_class"] = json!(kind);
        leaf["resizingConstraint"] = json!(63);
        leaf["frame"]["futureFrame"] = json!({"keep":17});
        if kind != "shapePath" {
            leaf.as_object_mut().unwrap().remove("points");
        }
        let points = leaf.get("points").cloned();
        let doc = Document::from_sketch(&archive(parts(vec![leaf]), false)).unwrap();
        let mut session = Session::new(doc, "doc".into(), 1).unwrap();
        let before = unpack(&session.document().to_sketch().unwrap());
        history_apply(
            &mut session,
            SketchCommand::SetLeafFrame {
                layer_id: "PATH".into(),
                x: -30.0,
                y: 15.0,
                width: 400.0,
                height: 200.0,
            },
        )
        .unwrap();
        let layer = session.document().layer("PATH").unwrap();
        assert_eq!(
            layer.fields()["frame"],
            json!({"x":-30.0,"y":15.0,"width":400.0,"height":200.0,"futureFrame":{"keep":17}})
        );
        assert_eq!(layer.fields().get("points"), points.as_ref());
        if kind == "shapePath" {
            let curve = CurveContour::from_layer(layer).unwrap();
            assert_eq!(curve.points()[0].point, [0.0, 100.0]);
            assert_eq!(curve.points()[0].outgoing, Some([100.0, 0.0]));
            assert!(!curve.is_closed());
        }
        assert_eq!(
            session.document().resource("images/image-hash"),
            Some([0, 1, 2, 3, 255].as_slice())
        );
        let edited = unpack(&session.document().to_sketch().unwrap());
        history_apply(&mut session, SketchCommand::Undo).unwrap();
        assert_eq!(unpack(&session.document().to_sketch().unwrap()), before);
        history_apply(&mut session, SketchCommand::Redo).unwrap();
        assert_eq!(unpack(&session.document().to_sketch().unwrap()), edited);
        assert_eq!(session.revision(), 3);
    }
}
#[test]
fn leaf_frame_edit_invalid_or_unsupported_targets_preserve_document_revision_and_history() {
    use futureox_design_kernel::sketch::{Session, SketchCommand};
    for case in 0..13 {
        let mut leaf = json!({"_class":"rectangle","do_objectID":"L","resizingConstraint":63,"frame":{"x":0,"y":0,"width":20,"height":20}});
        let mut parent = json!({"_class":"group","do_objectID":"G"});
        match case {
            0 => leaf["rotation"] = json!(45),
            1 => leaf["horizontalPins"] = json!(0),
            2 => leaf["frame"]["constrainProportions"] = json!(true),
            3 => leaf["_class"] = json!("symbolInstance"),
            4 => parent["_class"] = json!("symbolMaster"),
            5 => parent["groupLayout"] = json!({"_class":"MSImmutableFlexGroupLayout"}),
            6 => leaf["resizingConstraint"] = json!(64),
            7 => leaf["resizingConstraint"] = json!(0),
            8 => parent["isLocked"] = json!(true),
            9 => leaf["isFlippedHorizontal"] = json!(true),
            _ => {}
        }
        parent["layers"] = json!([leaf]);
        let mut session = Session::new(
            Document::from_sketch(&archive(parts(vec![parent]), false)).unwrap(),
            "doc".into(),
            1,
        )
        .unwrap();
        let before = session.document().to_sketch().unwrap();
        let history = session.history_status();
        let x = if case == 10 { f64::NAN } else { 1.0 };
        let width = match case {
            11 => -1.0,
            12 => 1e100,
            _ => 30.0,
        };
        assert!(
            history_apply(
                &mut session,
                SketchCommand::SetLeafFrame {
                    layer_id: "L".into(),
                    x,
                    y: 2.0,
                    width,
                    height: 30.0
                }
            )
            .is_err(),
            "case {case}"
        );
        assert_eq!(session.document().to_sketch().unwrap(), before);
        assert_eq!(session.revision(), 0);
        assert_eq!(session.history_status(), history);
    }
}
