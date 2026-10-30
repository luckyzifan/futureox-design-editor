#![cfg(not(target_arch = "wasm32"))]
use futureox_design_kernel::interop::{import_sketch_source_parts, import_sketch_source_window};
use serde_json::json;
use std::collections::BTreeMap;
#[test]
fn parsed_source_uses_the_original_importer_without_a_json_roundtrip() {
    let meta=json!({"version":136,"appVersion":"2026"});
    let document=json!({"_class":"document","colorSpace":2,"pages":[{"_ref":"pages/p"}],"assets":{"colors":[]},"foreignSymbols":[]});
    let page=json!({"_class":"page","do_objectID":"p","name":"Source","layers":[
        {"_class":"rectangle","do_objectID":"rect","name":"Rect","frame":{"x":0.125,"y":-0.375,"width":50.75,"height":20.25},"style":{"fills":[{"isEnabled":true,"fillType":0,"color":{"red":0.7,"green":0.2,"blue":0.1,"alpha":0.5}}],"blur":{"isEnabled":true,"type":0,"radius":3.75}}},
        {"_class":"shapeGroup","do_objectID":"mask","name":"Mask","hasClippingMask":true,"frame":{"x":2,"y":3,"width":40,"height":30},"layers":[]}
    ]});
    let pages=BTreeMap::from([("p".into(),page.clone())]);
    let files=BTreeMap::from([("meta.json".into(),serde_json::to_vec(&meta).unwrap()),("document.json".into(),serde_json::to_vec(&document).unwrap()),("pages/p.json".into(),serde_json::to_vec(&page).unwrap())]);
    let old=import_sketch_source_window(&files).unwrap();
    let new=import_sketch_source_parts(&BTreeMap::new(),&meta,&document,&pages).unwrap();
    assert_eq!(serde_json::to_value(old.document).unwrap(),serde_json::to_value(new.document).unwrap());
    assert_eq!(old.warnings,new.warnings);
    let invalid=json!({"pages":[{"_ref":"pages/missing"}]});
    assert!(import_sketch_source_parts(&BTreeMap::new(),&meta,&invalid,&pages).is_err());
}
