use futureox_design_kernel::sketch::{Document, Session};
use futureox_design_kernel::sketch::preview::display_snapshot;
use serde_json::{Value, json};
use std::io::{Cursor, Write};
fn session(layers: Value) -> Session {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, value) in [
        ("meta.json", json!({"version":144})),
        (
            "document.json",
            json!({"_class":"document","colorSpace":1,"pages":[{"_ref":"pages/P"}]}),
        ),
        (
            "pages/P.json",
            json!({"_class":"page","do_objectID":"P","name":"Native","booleanOperation":-1,"exportOptions":{},"horizontalRulerData":{},"layers":layers}),
        ),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    Session::new(
        Document::from_sketch(&zip.finish().unwrap().into_inner()).unwrap(),
        "a531a01d-6bd7-42c4-a30c-8d0d9145df82".into(),
        1,
    )
    .unwrap()
}
fn path(id: &str) -> Value {
    json!({"_class":"shapePath","do_objectID":id,"name":"Triangle","frame":{"x":2,"y":3,"width":40,"height":20},"isClosed":true,"booleanOperation":0,"points":[{"point":"{0,0}","hasCurveFrom":true,"curveFrom":"{0.5,0}"},{"point":"{1,1}","hasCurveTo":true,"curveTo":"{1,0.5}"},{"point":"{0,1}"}],"style":{"windingRule":1,"fills":[{"isEnabled":true,"fillType":0,"color":{"red":0.125,"green":0.5,"blue":1,"alpha":0.25}}]}})
}
#[test]
fn real_page_metadata_and_transformed_curves_are_projected_without_mutating_native_archive() {
    let mut leaf = path("leaf");
    leaf["rotation"] = json!(90);
    leaf["isFlippedHorizontal"] = json!(true);
    let s = session(
        json!([{"_class":"artboard","do_objectID":"A","name":"Artboard","frame":{"x":-100,"y":20,"width":200,"height":100},"hasBackgroundColor":true,"backgroundColor":{"red":0.1,"green":0.2,"blue":0.3,"alpha":1},"layers":[leaf]}]),
    );
    let before = s.document().to_sketch().unwrap();
    let out = display_snapshot(&s, "P").unwrap();
    assert_eq!(s.document().to_sketch().unwrap(), before);
    assert_eq!(out.owner, s.owner().clone());
    assert_eq!(out.artboards, ["A"]);
    let n = &out.document.nodes["leaf"];
    let m = n.transform.0;
    assert!((m[1] - 1.).abs() < 1e-12);
    assert!((m[2] - 1.).abs() < 1e-12);
    assert!((m[4] - 12.).abs() < 1e-12);
    assert!((m[5] + 7.).abs() < 1e-12);
    let g = n.network.as_ref().unwrap();
    assert_eq!(g.edges[0].c1.unwrap().x, 20.);
    assert_eq!(g.edges[0].c2.unwrap().y, 10.);
    assert_eq!(g.vertices[1].x, 40.);
    assert_eq!(n.fills[0].color, "color(srgb 0.125 0.5 1 / 0.25)");
    assert!(out.document.nodes["A"].clip);
}
#[test]
fn uniform_compound_union_uses_one_graph_and_mixed_operations_keep_the_native_fold() {
    let s = session(
        json!([{"_class":"shapeGroup","do_objectID":"G","frame":{"x":0,"y":0,"width":40,"height":20},"layers":[path("a"),path("b"),path("c")]}]),
    );
    let out = display_snapshot(&s, "P").unwrap();
    assert_eq!(out.document.nodes.len(), 4);
    assert_eq!(out.document.nodes["G"].children, ["a", "b", "c"]);
    assert_eq!(
        format!("{:?}", out.document.nodes["G"].boolean_operation),
        "Some(Union)"
    );
    let mut b = path("b");
    b["booleanOperation"] = json!(1);
    let s = session(
        json!([{"_class":"shapeGroup","do_objectID":"G","frame":{"x":0,"y":0,"width":40,"height":20},"layers":[path("a"),b,path("c")]}]),
    );
    let out = display_snapshot(&s, "P").unwrap();
    assert_eq!(out.document.nodes.len(), 5);
    let g = &out.document.nodes["G"];
    assert_eq!(
        format!("{:?}", out.document.nodes[&g.children[0]].boolean_operation),
        "Some(Subtract)"
    );
}
#[test]
fn default_font_policy_keeps_text_and_utf16_ranges_while_reporting_the_source_font() {
    let s = session(
        json!([{"_class":"text","do_objectID":"T","frame":{"x":0,"y":0,"width":100,"height":30},"attributedString":{"string":"A😀","attributes":[{"location":0,"length":4,"attributes":{"MSAttributedStringFontAttribute":{"attributes":{"name":"Unavailable-Bold","size":20}},"MSAttributedStringColorAttribute":{"red":1,"alpha":0.5}}}]}}]),
    );
    let before = s.document().to_sketch().unwrap();
    let out = display_snapshot(&s, "P").unwrap();
    let n = &out.document.nodes["T"];
    assert_eq!(n.text, "A😀");
    assert_eq!((n.text_runs[0].start, n.text_runs[0].end), (0, 3));
    assert_eq!(n.text_style.as_ref().unwrap().font_id, "default");
    assert_eq!(out.source_fonts, ["Unavailable-Bold"]);
    assert!(!out.warnings.is_empty());
    assert_eq!(before, s.document().to_sketch().unwrap());
}

#[test]
fn display_difference_and_intersection_follow_native_enum() {
    for (code,expected) in [(2,"Some(Exclude)"),(3,"Some(Intersect)")] {
        let mut b=path("b");b["booleanOperation"]=json!(code);
        let out=display_snapshot(&session(json!([{"_class":"shapeGroup","do_objectID":"G","frame":{"x":0,"y":0,"width":40,"height":20},"layers":[path("a"),b]}])),"P").unwrap();
        assert_eq!(format!("{:?}",out.document.nodes["G"].boolean_operation),expected);
    }
}
