use futureox_design_kernel::interop::{export_sketch, export_sketch_layer_fields, import_sketch_report};
use serde_json::json;
use std::io::{Cursor, Write};

#[test]
fn sketch_frame_and_graphic_templates_round_trip_as_distinct_assets() {
    let page = json!({
        "_class": "page",
        "do_objectID": "p",
        "layers": [
            {"_class":"group","do_objectID":"frame","name":"Frame Template","groupBehavior":1,"isTemplate":true,
             "frame":{"width":400,"height":320}},
            {"_class":"group","do_objectID":"graphic","name":"Graphic Template","groupBehavior":2,"isTemplate":true,
             "frame":{"width":64,"height":64}},
            {"_class":"group","do_objectID":"plain","name":"Ordinary Frame","groupBehavior":1,
             "frame":{"width":400,"height":320}}
        ]
    });
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, contents) in [
        ("meta.json", json!({"version":168})),
        ("document.json", json!({"pages":[{"_ref":"pages/p"}]})),
        ("pages/p.json", page),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(contents.to_string().as_bytes()).unwrap();
    }
    let doc = import_sketch_report(&zip.finish().unwrap().into_inner()).unwrap().document;
    assert_eq!(doc.schema_version, 32);
    assert!(doc.nodes["frame"].sketch_template);
    assert!(!doc.nodes["frame"].graphic);
    assert!(doc.nodes["graphic"].sketch_template);
    assert!(doc.nodes["graphic"].graphic);
    assert!(!doc.nodes["plain"].sketch_template);
    for id in ["frame", "graphic"] {
        assert_eq!(export_sketch_layer_fields(&doc, id).unwrap()["isTemplate"], true);
    }
    let reopened = import_sketch_report(&export_sketch(&doc).unwrap()).unwrap().document;
    assert!(reopened.nodes["frame"].sketch_template && !reopened.nodes["frame"].graphic);
    assert!(reopened.nodes["graphic"].sketch_template && reopened.nodes["graphic"].graphic);
    assert!(!reopened.nodes["plain"].sketch_template);
}
