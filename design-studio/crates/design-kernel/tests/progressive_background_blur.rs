use futureox_design_kernel::{
    editing::{DocumentEditor, DocumentPatch},
    scene::selected_backdrop,
    Engine, RenderOptions,
};
use serde_json::{json, Value};

fn scene() -> Value {
    json!({
        "schemaVersion":19,"id":"d","name":"Progressive background","rasterProfile":"figma",
        "pages":[{"id":"p","name":"Page","children":["stripe","lens","caption"],"background":"#ffffff"}],
        "nodes":{
            "stripe":{"id":"stripe","kind":"rectangle","width":96,"height":64,"fills":[{"kind":"solid","color":"#3355aa"}]},
            "lens":{"id":"lens","kind":"rectangle","width":64,"height":32,"transform":[1,0,0,1,16,16],
                "fills":[{"kind":"solid","color":"#ffffff","opacity":0.1}],
                "effects":[{"kind":"background-blur","radius":4,"color":"#000000"}]},
            "caption":{"id":"caption","kind":"text","text":"Ag","fontSize":18,"width":28,"height":24,
                "transform":[1,0,0,1,34,18],"fills":[{"kind":"solid","color":"#111111"}]}
        }
    })
}

fn options() -> RenderOptions {
    serde_json::from_value(json!({"pageId":"p","width":96,"height":64,"view":{"x":0,"y":0,"zoom":1},"transparent":true})).unwrap()
}

fn render(document: &Value) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_font(include_bytes!("../../../../frontend/design-client/public/fonts/NotoSansSC.ttf")).unwrap();
    engine.load_document(&document.to_string()).unwrap();
    engine.render(&options()).unwrap()
}

fn pixel(pixels: &[u8], x: usize, y: usize) -> [u8; 4] {
    let i = (y * 96 + x) * 4;
    pixels[i..i + 4].try_into().unwrap()
}

#[test]
fn uniform_background_blur_reopens_and_a_progressive_edit_undoes() {
    let original = scene();
    let bytes = futureox_design_kernel::binfmt::encode_value(&original).unwrap();
    assert_eq!(futureox_design_kernel::binfmt::decode_value(&bytes).unwrap(), original);
    let reopened = render(&original);
    assert_eq!(render(&serde_json::from_str(&original.to_string()).unwrap()), reopened);

    let document = serde_json::from_value(original.clone()).unwrap();
    let mut editor = DocumentEditor::new(document).unwrap();
    let mut lens = editor.document().nodes["lens"].clone();
    lens.effects[0].gradient_blur = Some(serde_json::from_value(json!({
        "start":[0,16],"end":[64,16],"startCount":0,"endCount":8,"smooth":true
    })).unwrap());
    editor.apply(0, DocumentPatch { nodes: [("lens".into(), Some(lens))].into(), ..Default::default() }).unwrap();
    let edited = serde_json::to_value(editor.document()).unwrap();
    assert!(edited["nodes"]["lens"]["effects"][0]["gradientBlur"].is_object());
    assert_ne!(render(&edited), reopened);
    editor.undo().unwrap();
    assert!(editor.document().nodes["lens"].effects[0].gradient_blur.is_none());
    assert_eq!(render(&serde_json::to_value(editor.document()).unwrap()), reopened);
    editor.redo().unwrap();
    assert_eq!(editor.document().nodes["lens"].effects[0].gradient_blur.unwrap().end_count, 8.);
}

#[test]
fn foreground_text_stacks_above_the_progressive_background() {
    let mut document = scene();
    document["nodes"]["lens"]["effects"][0]["gradientBlur"] = json!({
        "start":[0,16],"end":[64,16],"startCount":0,"endCount":8,"smooth":true
    });
    document["nodes"]["lens"]["effects"][0]["radius"] = json!(1);
    let with_text = render(&document);
    let mut bare = document.clone();
    bare["nodes"]["caption"]["visible"] = json!(false);
    let bare = render(&bare);
    let mut differed = false;
    for y in 18..42 {
        for x in 34..62 {
            if pixel(&with_text, x, y) != pixel(&bare, x, y) { differed = true; }
        }
    }
    assert!(differed, "foreground text changes pixels inside its box");
}

#[test]
fn glass_keeps_its_place_ahead_of_progressive_background_blur() {
    let progressive = json!({"kind":"background-blur","radius":1,"color":"#000000",
        "gradientBlur":{"start":[0,16],"end":[48,16],"startCount":0,"endCount":6,"smooth":true}});
    let glass = json!({"kind":"glass","radius":2,"color":"#000000","glass":{
        "depth":4,"refraction":0.4,"dispersion":0.2,"lightAngle":30,"lightIntensity":0.5}});
    let mut document = scene();
    document["nodes"]["lens"]["width"] = json!(48);
    document["nodes"]["lens"]["height"] = json!(32);
    let only = |effect: Value| {
        let mut document = document.clone();
        document["nodes"]["lens"]["effects"] = json!([effect]);
        render(&document)
    };
    let pair = |first: Value, second: Value| {
        let mut document = document.clone();
        document["nodes"]["lens"]["effects"] = json!([first, second]);
        render(&document)
    };
    let progressive_pixels = only(progressive.clone());
    let glass_pixels = only(glass.clone());
    assert_ne!(progressive_pixels, glass_pixels);
    assert_eq!(pair(glass.clone(), progressive.clone()), glass_pixels);
    assert_eq!(pair(progressive.clone(), glass.clone()), progressive_pixels);
    let parsed = |value: Value| serde_json::from_value::<futureox_design_kernel::scene::Effect>(value).unwrap();
    let glass_effect = parsed(glass);
    let progressive_effect = parsed(progressive);
    assert_eq!(selected_backdrop(&[glass_effect.clone(), progressive_effect.clone()]).unwrap().kind, "glass");
    assert_eq!(selected_backdrop(&[progressive_effect.clone(), glass_effect.clone()]).unwrap().kind, "background-blur");
    let mut hidden = glass_effect;
    hidden.visible = false;
    assert_eq!(selected_backdrop(&[hidden, progressive_effect]).unwrap().kind, "background-blur");
}
