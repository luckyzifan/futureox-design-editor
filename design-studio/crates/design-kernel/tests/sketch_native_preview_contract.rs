use futureox_design_kernel::{
    area_program::AreaProgram,
    math::{Point, Rect},
    path::Contour,
};
use futureox_design_kernel::sketch::{CommandEnvelope, Document, Error, Session, SketchCommand};
use futureox_design_kernel::sketch::preview::{PreviewRequest, compile_preview};
use serde_json::{Value, json};
use std::io::{Cursor, Write};
fn session(layers: Value) -> Session {
    session_with_color_space(layers, json!(0))
}
fn session_with_color_space(layers: Value, color_space: Value) -> Session {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, value) in [
        ("meta.json", json!({"version":146})),
        (
            "document.json",
            json!({"_class":"document","colorSpace":color_space,"pages":[{"_ref":"pages/P"}]}),
        ),
        (
            "pages/P.json",
            json!({"_class":"page","do_objectID":"P","layers":layers}),
        ),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    Session::new(
        Document::from_sketch(&zip.finish().unwrap().into_inner()).unwrap(),
        "native-doc".into(),
        7,
    )
    .unwrap()
}
fn rectangle() -> Value {
    json!({"_class":"rectangle","do_objectID":"R","frame":{"x":2,"y":3,"width":10,"height":12},
    "style":{"fills":[{"fillType":0,"color":{"red":0.125,"green":0.5,"blue":1,"alpha":1}}]}})
}
fn request(session: &Session) -> PreviewRequest {
    PreviewRequest {
        owner: session.owner().clone(),
        expected_revision: session.revision(),
        page_id: "P".into(),
        width: 64,
        height: 64,
    }
}
#[test]
fn explicit_native_srgb_keeps_preview_colors_and_does_not_admit_p3_as_srgb() {
    let unmanaged = session_with_color_space(json!([rectangle()]), json!(0));
    let srgb = session_with_color_space(json!([rectangle()]), json!(1));
    let original = srgb.document().to_sketch().unwrap();
    let reference = compile_preview(&unmanaged, &request(&unmanaged)).unwrap();
    let actual = compile_preview(&srgb, &request(&srgb)).unwrap();
    assert_eq!(
        serde_json::to_value(&reference).unwrap(),
        serde_json::to_value(&actual).unwrap()
    );
    assert_eq!(original, srgb.document().to_sketch().unwrap());
    for space in [
        json!(2),
        json!(3),
        json!(-1),
        json!(1.5),
        json!("1"),
        Value::Null,
    ] {
        let s = session_with_color_space(json!([rectangle()]), space);
        assert!(matches!(
            compile_preview(&s, &request(&s)),
            Err(Error::Unsupported(_))
        ));
    }
}
#[test]
fn native_geometry_projects_to_real_shared_intervals_without_mutating_archive() {
    let curve = json!({"_class":"shapePath","do_objectID":"C","frame":{"x":0,"y":0,"width":12,"height":12},
        "isClosed":true,"points":[{"point":"{0,0}","hasCurveFrom":true,"curveFrom":"{0.5,0}"},
        {"point":"{1,1}","hasCurveTo":true,"curveTo":"{1,0.5}"},{"point":"{0,1}"}],
        "style":{"windingRule":1,"fills":[{"fillType":0,"color":{"red":1,"green":0,"blue":0}}]}});
    let session = session(
        json!([{"_class":"group","do_objectID":"G","frame":{"x":4,"y":5,"width":32,"height":32},"layers":[rectangle(),curve]}]),
    );
    let before = session.document().to_sketch().unwrap();
    let preview = compile_preview(&session, &request(&session)).unwrap();
    assert_eq!(preview.scene.roots, ["R", "C"]);
    assert_eq!(preview.scene.nodes["R"].matrix.0, [1., 0., 0., 1., 6., 8.]);
    let expected = AreaProgram::compile(
        &[Contour {
            closed: true,
            points: vec![
                Point::new(6., 8.),
                Point::new(16., 8.),
                Point::new(16., 20.),
                Point::new(6., 20.),
            ],
        }],
        Rect::new(0, 0, 64, 64),
        false,
    )
    .unwrap();
    let area = preview.scene.nodes["R"].fill.area.as_ref().unwrap();
    assert!(area.count > 0);
    assert_eq!(
        &preview.scene.curves[(area.first * 4) as usize..((area.first + area.count) * 4) as usize],
        expected.data
    );
    assert!(preview.scene.nodes["C"].fill.area.as_ref().unwrap().count > 0);
    assert_eq!(preview.scene.nodes["R"].fill.rule, "nonzero");
    assert_eq!(preview.scene.nodes["C"].fill.rule, "evenodd");
    assert_eq!(preview.scene.colors.len(), 2);
    preview.assert_current(&session).unwrap();
    assert_eq!(before, session.document().to_sketch().unwrap());
    assert_eq!(session.revision(), 0);
    assert!(
        serde_json::to_value(&preview).unwrap()["scene"]["curves"]
            .as_array()
            .unwrap()
            .len()
            > 4
    );
}
#[test]
fn owner_revision_close_and_unsupported_semantics_fail_closed() {
    let mut s = session(json!([rectangle()]));
    let req = request(&s);
    let preview = compile_preview(&s, &req).unwrap();
    for field in ["kernel", "epoch", "document", "revision"] {
        let mut stale = req.clone();
        match field {
            "kernel" => stale.owner.kernel_id = "figma".into(),
            "epoch" => stale.owner.session_epoch += 1,
            "document" => stale.owner.document_id = "elsewhere".into(),
            _ => stale.expected_revision += 1,
        }
        assert!(compile_preview(&s, &stale).is_err());
    }
    s.apply(CommandEnvelope {
        owner: s.owner().clone(),
        expected_revision: 0,
        request_id: "rename".into(),
        command: SketchCommand::RenameLayer {
            layer_id: "R".into(),
            name: "new".into(),
        },
    })
    .unwrap();
    assert!(preview.assert_current(&s).is_err());
    assert!(compile_preview(&s, &req).is_err());
    let current = request(&s);
    s.close();
    assert!(compile_preview(&s, &current).is_err());
    for unsupported in [
        json!({"rotation":30}),
        json!({"hasClippingMask":true}),
        json!({"unknownRenderFeature":true}),
        json!({"style":{"fills":[{"fillType":1}]}}),
        json!({"style":{"borders":[]}}),
        json!({"style":{"windingRule":2,"fills":[{"color":{}}]}}),
    ] {
        let mut layer = rectangle();
        for (k, v) in unsupported.as_object().unwrap() {
            layer[k] = v.clone();
        }
        let s = session(json!([layer]));
        assert!(matches!(
            compile_preview(&s, &request(&s)),
            Err(Error::Unsupported(_))
        ));
        assert_eq!(s.revision(), 0);
    }
}

fn alpha_gradient_fill() -> Value {
    json!({"fillType":1,"contextSettings":{"opacity":0.4},"gradient":{"gradientType":0,
        "from":"{0, 0.5}","to":"{1, 0.5}","elipseLength":0,
        "stops":[{"position":1,"color":{"red":0.25,"green":0.5,"blue":0.75,"alpha":1}},
                 {"position":0,"color":{"red":0.25,"green":0.5,"blue":0.75,"alpha":0}}]}})
}
#[test]
fn alpha_gradient_uses_shared_coordinates_and_preserves_stops_and_opacity() {
    for (from, to, start, end) in [
        ("{0, 0.5}", "{1, 0.5}", [0., 6.], [10., 6.]),
        ("{1, 0.5}", "{0, 0.5}", [10., 6.], [0., 6.]),
        ("{0.5, 0}", "{0.5, 1}", [5., 0.], [5., 12.]),
    ] {
        let mut fill = alpha_gradient_fill();
        fill["gradient"]["from"] = json!(from);
        fill["gradient"]["to"] = json!(to);
        let mut layer = rectangle();
        layer["style"] = json!({"contextSettings":{"opacity":0.5},"fills":[fill]});
        let s = session(json!([layer]));
        let before = s.document().to_sketch().unwrap();
        let result = compile_preview(&s, &request(&s)).unwrap();
        let node = &result.scene.nodes["R"];
        let paint = &node.fills[0];
        assert_eq!(paint.paint.kind, "linear");
        assert_eq!(paint.paint.opacity, 0.4);
        assert_eq!(node.opacity, 0.5);
        assert!(paint.constant_color.is_none());
        assert_eq!(
            paint
                .paint
                .stops
                .iter()
                .map(|s| s.offset)
                .collect::<Vec<_>>(),
            vec![0., 1.]
        );
        let colors = &result.scene.colors;
        let a = colors[&paint.paint.stops[0].color];
        let b = colors[&paint.paint.stops[1].color];
        assert_eq!(&a[..3], &b[..3]);
        assert_eq!((a[3], b[3]), (0., 1.));
        let shared = paint
            .fixed_gradient
            .as_ref()
            .expect("shared fixed-gradient compiler");
        for (p, t) in [
            (start, 0.),
            (end, 1.),
            ([(start[0] + end[0]) / 2., (start[1] + end[1]) / 2.], 0.5),
        ] {
            let world = node.matrix.point(Point::new(p[0], p[1]));
            assert!((shared.parameter(world) - t).abs() < 1e-6);
        }
        assert_eq!(before, s.document().to_sketch().unwrap());
    }
}
#[test]
fn alpha_gradient_rejects_ambiguous_native_semantics() {
    for variant in 0..7 {
        let mut fill = alpha_gradient_fill();
        match variant {
            0 => fill["gradient"]["gradientType"] = json!(1),
            1 => fill["gradient"]["to"] = json!("{1,1}"),
            2 => fill["gradient"]["stops"][0]["color"]["red"] = json!(0.75),
            3 => fill["gradient"]["stops"][0]["position"] = json!(0),
            4 => fill["gradient"]["stops"][0]["color"]["colorSpace"] = json!("display-p3"),
            5 => fill["gradient"]["interpolation"] = json!("custom"),
            _ => fill["gradient"]["to"] = json!("{0,0.5}"),
        }
        let mut layer = rectangle();
        layer["style"]["fills"] = json!([fill]);
        let s = session(json!([layer]));
        assert!(matches!(
            compile_preview(&s, &request(&s)),
            Err(Error::Unsupported(_))
        ));
        assert_eq!(s.revision(), 0);
    }
}
