use super::*;
use serde_json::json;

fn scene(offscreen: usize) -> String {
    let mut children = vec!["on".to_string(), "turn".to_string(), "soft".to_string()];
    let mut nodes = serde_json::Map::new();
    nodes.insert(
        "on".into(),
        json!({"id":"on","kind":"rectangle","width":30,"height":20,
        "transform":[1,0,0,1,8,8],"fills":[{"kind":"solid","color":"#224488"}]}),
    );
    nodes.insert(
        "turn".into(),
        json!({"id":"turn","kind":"rectangle","width":24,"height":16,
        "transform":[0.8,-0.6,0.6,0.8,40,30],"fills":[{"kind":"solid","color":"#228844"}]}),
    );
    nodes.insert(
        "soft".into(),
        json!({"id":"soft","kind":"rectangle","width":18,"height":18,
        "transform":[1,0,0,1,70,12],"effects":[{"kind":"blur","radius":2,"color":"#000000"}],
        "fills":[{"kind":"solid","color":"#884422"}]}),
    );
    for i in 0..offscreen {
        let id = format!("off{i:04}");
        children.push(id.clone());
        nodes.insert(
            id.clone(),
            json!({"id":id,"kind":"rectangle","width":12,"height":12,
            "transform":[1,0,0,1, 4000.0 + (i % 60) as f64 * 20.0, (i / 60) as f64 * 20.0],
            "fills":[{"kind":"solid","color":"#cc6644"}]}),
        );
    }
    json!({"schemaVersion":16,"id":"cull","name":"cull",
        "pages":[{"id":"p","name":"p","children":children,"background":"#ffffff"}],
        "nodes":nodes})
    .to_string()
}

fn view(engine: &mut Engine, x: f64, zoom: f64) -> RenderOptions {
    engine
        .parse_options(json!({"pageId":"p","width":160,"height":90,
        "view":{"x":x,"y":0,"zoom":zoom},"rasterProfile":"analytic"}))
        .unwrap()
}

#[test]
fn offscreen_plain_rectangles_keep_visible_pixels_and_skip_their_paths() {
    let mut crowded = Engine::new();
    crowded.load_document(&scene(1800)).unwrap();
    let mut bare = Engine::new();
    bare.load_document(&scene(0)).unwrap();
    let options = view(&mut crowded, 0., 1.);
    let bare_options = view(&mut bare, 0., 1.);
    let crowded_pixels = crowded.render(&options).unwrap();
    let bare_pixels = bare.render(&bare_options).unwrap();
    assert_eq!(crowded_pixels, bare_pixels);
    assert!(
        crowded.stats().culled > 1000,
        "culled {}",
        crowded.stats().culled
    );
    assert_eq!(crowded.stats().path_segments, bare.stats().path_segments);
    let shifted_view = view(&mut crowded, -4010., 1.);
    let shifted = crowded.render(&shifted_view).unwrap();
    assert_ne!(shifted, crowded_pixels);
    let zoomed = view(&mut crowded, 0.5, 1.15);
    let zoomed_bare = view(&mut bare, 0.5, 1.15);
    assert_eq!(
        crowded.render(&zoomed).unwrap(),
        bare.render(&zoomed_bare).unwrap()
    );
}
