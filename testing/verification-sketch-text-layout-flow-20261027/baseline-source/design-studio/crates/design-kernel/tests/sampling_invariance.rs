use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::{Value, json};

fn fixture() -> Value {
    json!({"schemaVersion":4,"id":"d","name":"Sampling locality",
        "pages":[{"id":"p","name":"p","children":["a"],"background":"#ffffff"}],
        "nodes":{"a":{"id":"a","kind":"ellipse","width":29.5,"height":25.25,
            "transform":[1,0,0,1,7.125,6.375],"opacity":0.63,
            "fills":[{"kind":"solid","color":"#8063c2","opacity":0.72}]}}})
}
fn render(doc: &Value, profile: &str) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    let opts: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":48,"height":40,
        "transparent":true,"rasterProfile":profile,"view":{"x":0,"y":0,"zoom":1}}))
    .unwrap();
    engine.render(&opts).unwrap()
}

#[test]
fn offscreen_effects_cannot_change_other_pixels() {
    for profile in ["figma", "figmaSubpixel"] {
        let base = fixture();
        let expected = render(&base, profile);
        for extra in [
            json!({"id":"b","kind":"rectangle","width":3,"height":3,"transform":[1,0,0,1,1000,1000],"fills":[{"kind":"solid","color":"#ff0000"}],"effects":[{"kind":"noise","amount":0.5,"opacity":0.4,"color":"#000000"}]}),
            json!({"id":"b","kind":"rectangle","width":3,"height":3,"transform":[1,0,0,1,1000,1000],"effects":[{"kind":"background-blur","radius":1,"color":"#000000"}]}),
        ] {
            let mut changed = base.clone();
            changed["nodes"]["b"] = extra;
            changed["pages"][0]["children"]
                .as_array_mut()
                .unwrap()
                .push(json!("b"));
            let actual = render(&changed, profile);
            assert_eq!(
                actual, expected,
                "{profile}: unrelated node changed existing pixels"
            );
        }
    }
}
