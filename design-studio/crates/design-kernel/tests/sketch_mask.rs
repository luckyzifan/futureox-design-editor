use futureox_design_kernel::{Engine, RenderOptions, editing::DocumentPatch};
use serde_json::{Value, json};

fn rect(id: &str, x: usize, y: usize, w: usize, h: usize, color: &str) -> Value {
    json!({"id":id,"kind":"rectangle","transform":[1,0,0,1,x,y],"width":w,"height":h,
           "fills":[{"kind":"solid","color":color}]})
}

fn document(nested: bool) -> Value {
    let mut mask = rect("mask", 10, 0, 30, 30, "#00ff00");
    mask["mask"] = json!(true);
    mask["maskType"] = json!("shape");
    let mut next = rect("next", 30, 10, 30, 15, "#ffff00");
    next["mask"] = json!(true);
    next["maskType"] = json!("shape");
    let mut stop = rect("ignore", 70, 0, 10, 30, "#ff00ff");
    stop["maskChain"] = json!("break");
    let layers = [
        rect("prior", 0, 0, 110, 30, "#ff0000"),
        mask,
        rect("first", 0, 5, 90, 5, "#0000ff"),
        next,
        rect("second", 0, 20, 90, 5, "#00ffff"),
        stop,
        rect("last", 85, 0, 15, 30, "#000000"),
    ];
    let mut ids: Vec<_> = layers.iter().map(|n| n["id"].clone()).collect();
    let mut nodes = serde_json::Map::new();
    for n in layers {
        nodes.insert(n["id"].as_str().unwrap().into(), n);
    }
    if nested {
        nodes.insert(
            "g".into(),
            json!({"id":"g","kind":"group","width":110,"height":30,"children":ids}),
        );
        ids = vec![json!("g")];
    }
    json!({"schemaVersion":4,"id":"d","name":"chain","nodes":nodes,
           "pages":[{"id":"p","name":"p","background":"#ffffff","children":ids}]})
}

fn options(profile: &str) -> RenderOptions {
    serde_json::from_value(json!({"pageId":"p","width":110,"height":30,
        "view":{"x":0,"y":0,"zoom":1},"rasterProfile":profile}))
    .unwrap()
}
fn pixel(image: &[u8], x: usize, y: usize) -> &[u8] {
    &image[(y * 110 + x) * 4..(y * 110 + x) * 4 + 3]
}
fn patch(e: &mut Engine, id: &str, n: &Value) {
    let p: DocumentPatch = serde_json::from_value(json!({"nodes":{id:n},"fields":{}})).unwrap();
    e.apply_document_patch(&p).unwrap();
}

#[test]
fn painted_outline_matches_sketch_sibling_order_in_group_and_on_page() {
    for nested in [false, true] {
        let doc = document(nested);
        let mut e = Engine::new();
        e.load_document(&doc.to_string()).unwrap();
        for profile in ["analytic", "figma", "figmaSubpixel"] {
            let opts = options(profile);
            let image = e.render(&opts).unwrap();
            // Interior samples from the independent Sketch export of this arrangement.
            for (x, y, rgb) in [
                (5, 2, [255, 0, 0]),
                (15, 2, [0, 255, 0]),
                (15, 7, [0, 0, 255]),
                (45, 7, [255, 0, 0]),
                (35, 13, [255, 255, 0]),
                (45, 13, [255, 255, 0]),
                (15, 22, [0, 255, 0]),
                (45, 22, [0, 255, 255]),
                (65, 22, [255, 0, 0]),
                (75, 22, [255, 0, 255]),
                (90, 22, [0, 0, 0]),
            ] {
                assert_eq!(
                    pixel(&image, x, y),
                    rgb,
                    "{profile} nested={nested} ({x},{y})"
                );
            }
            let scene = e.compile_gpu(&opts).unwrap();
            assert_eq!(scene.nodes["mask"].fills[0].color, "#00ff00");
            assert!(!scene.nodes["mask"].mask);
            let group = scene
                .nodes
                .values()
                .find(|n| n.children.iter().any(|id| id == "first"))
                .unwrap();
            let coverage = &scene.nodes[group.mask_id.as_ref().unwrap()];
            assert!(coverage.mask);
            assert_eq!(coverage.fills[0].color, "#ffffff");
        }
    }
}

#[test]
fn transparent_hidden_and_moved_masks_preserve_clip_and_undo_pixels() {
    let original = document(true);
    let mut e = Engine::new();
    e.load_document(&original.to_string()).unwrap();
    let opts = options("figmaSubpixel");
    let baseline = e.render(&opts).unwrap();
    for key in ["fill", "opacity", "hidden"] {
        let mut n = original["nodes"]["mask"].clone();
        match key {
            "fill" => n["fills"] = json!([]),
            "opacity" => n["opacity"] = json!(0.),
            _ => n["visible"] = json!(false),
        }
        patch(&mut e, "mask", &n);
        let image = e.render(&opts).unwrap();
        assert_eq!(pixel(&image, 15, 2), [255, 0, 0], "{key}");
        assert_eq!(pixel(&image, 15, 7), [0, 0, 255], "{key}");
        assert_eq!(pixel(&image, 45, 7), [255, 0, 0], "{key}");
    }
    let mut moved = original["nodes"]["mask"].clone();
    moved["transform"][4] = json!(42);
    patch(&mut e, "mask", &moved);
    let image = e.render(&opts).unwrap();
    assert_eq!(pixel(&image, 15, 7), [255, 0, 0]);
    assert_eq!(pixel(&image, 45, 7), [0, 0, 255]);
    patch(&mut e, "mask", &original["nodes"]["mask"]);
    assert_eq!(e.render(&opts).unwrap(), baseline);

    let mut alpha = original["nodes"]["next"].clone();
    alpha["maskType"] = json!("alpha");
    alpha["maskChain"] = json!("start");
    patch(&mut e, "next", &alpha);
    let image = e.render(&opts).unwrap();
    assert_eq!(pixel(&image, 45, 13), [255, 0, 0]);
    assert_eq!(pixel(&image, 45, 22), [0, 255, 255]);
    patch(&mut e, "next", &original["nodes"]["next"]);
    assert_eq!(e.render(&opts).unwrap(), baseline);
}
