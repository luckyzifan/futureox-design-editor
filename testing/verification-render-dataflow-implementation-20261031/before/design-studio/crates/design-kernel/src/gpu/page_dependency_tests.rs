use super::*;
use serde_json::json;

#[test]
fn unrelated_page_effects_cannot_inflate_the_active_regional_dependency_domain() {
    let mut document=json!({"schemaVersion":3,"id":"d","name":"d",
        "colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},
        "pages":[{"id":"p","name":"p","children":["a"],"background":"#ffffff"}],
        "nodes":{"a":{"id":"a","kind":"rectangle","width":100,"height":100,
            "fills":[{"kind":"linear","color":"#000000","stops":[{"offset":0,"color":"#ff0000"},{"offset":1,"color":"#0000ff"}]}],
            "effects":[{"kind":"blur","radius":60,"visible":true,"color":"#000000","opacity":1,"x":0,"y":0,"spread":0}]}}});
    let options=json!({"pageId":"p","width":64,"height":64,"view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figmaSubpixel",
        "gpuViewport":{"x":0,"y":0,"w":64,"h":64}}).to_string();
    let mut isolated=Engine::new();isolated.load_document(&document.to_string()).unwrap();
    let expected=isolated.compile_gpu_request(&options).unwrap();
    document["pages"].as_array_mut().unwrap().push(json!({"id":"other","name":"other","children":["noise"],"background":"#ffffff"}));
    document["nodes"]["noise"]=json!({"id":"noise","kind":"rectangle","width":100,"height":100,
        "effects":[{"kind":"noise","radius":80,"visible":true,"color":"#000000","opacity":1,"x":0,"y":0,"spread":0}]});
    let mut combined=Engine::new();combined.load_document(&document.to_string()).unwrap();
    let actual=combined.compile_gpu_request(&options).unwrap();
    assert_eq!(serde_json::to_value(actual).unwrap(),serde_json::to_value(expected).unwrap());
}
