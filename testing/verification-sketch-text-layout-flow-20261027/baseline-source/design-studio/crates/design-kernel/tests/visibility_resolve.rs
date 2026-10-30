use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::json;
#[test]
fn offscreen_leaf_fill_does_not_change_sampling_or_pixels() {
    let mut doc = json!({"schemaVersion":2,"id":"d","name":"sampling locality","pages":[{"id":"p","name":"Page","children":["curve"],"background":"#ffffff"}],"nodes":{"curve":{"id":"curve","kind":"vector","width":128,"height":128,"fills":[{"kind":"solid","color":"#000000"}],"network":{"fillRule":"nonzero","vertices":[{"id":"a","x":8,"y":8},{"id":"b","x":108,"y":8}],"edges":[{"id":"ab","from":"a","to":"b","c1":{"x":8,"y":108},"c2":{"x":108,"y":108}},{"id":"ba","from":"b","to":"a"}]}}}});
    let options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":128,"height":128,"rasterProfile":"figma","view":{"x":0,"y":0,"zoom":1}})).unwrap();
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    let before = engine.render(&options).unwrap();
    let samples = engine.compile_gpu(&options).unwrap().coherent_samples;
    doc["nodes"]["far"] = json!({"id":"far","kind":"rectangle","width":10,"height":10,"transform":[1,0,0,1,100000,100000],"fills":[{"kind":"solid","color":"#000000"}]});
    doc["pages"][0]["children"]
        .as_array_mut()
        .unwrap()
        .push(json!("far"));
    engine.load_document(&doc.to_string()).unwrap();
    assert_eq!(
        samples,
        engine.compile_gpu(&options).unwrap().coherent_samples
    );
    assert_eq!(before, engine.render(&options).unwrap());
}
