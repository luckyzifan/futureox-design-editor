use futureox_design_kernel::{Engine, RenderOptions, color::ColorSettings, math::Rect};
use serde_json::json;

#[test]
fn parent_suffix_preserves_the_complete_backdrop_prefix_and_all_source_rects() {
    let doc = json!({"schemaVersion":16,"id":"suffix","name":"suffix","colorManagement":ColorSettings::default(),
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":["root"]}],
        "nodes":{
            "root":{"id":"root","kind":"frame","width":2000,"height":2000,"children":["before","backdrop","after"]},
            "before":{"id":"before","kind":"rectangle","width":2000,"height":2000,
                "fills":[{"kind":"solid","color":"#4578a9"}]},
            "backdrop":{"id":"backdrop","kind":"ellipse","width":120,"height":90,"transform":[1,0,0,1,500,500],
                "effects":[{"kind":"background-blur","radius":90,"color":"#000000"}]},
            "after":{"id":"after","kind":"rectangle","width":2000,"height":2000,
                "fills":[{"kind":"solid","color":"#abcdef","opacity":0.3}]}
        }});
    let options: RenderOptions = serde_json::from_value(json!({"pageId":"p","width":514,"height":514,
        "view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figmaSubpixel"})).unwrap();
    let mut engine = Engine::new(); engine.load_document(&doc.to_string()).unwrap();
    let scene = engine.compile_gpu_region(&options, Rect::new(300,300,514,514), None).unwrap();
    assert!(scene.nodes["root"].suffix_box.is_some());
    assert!(scene.nodes["after"].suffix_box.is_some());
    assert!(scene.nodes["backdrop"].suffix_box.is_some());
    assert!(scene.nodes["before"].suffix_box.is_none());
    assert_eq!(scene.nodes["before"].rect, scene.nodes["after"].rect);
    assert!(scene.nodes["after"].rect.w > scene.nodes["after"].suffix_box.unwrap()[2] as u32);
    assert!(engine.compile_gpu(&options).unwrap().nodes.values().all(|n|n.suffix_box.is_none()));
    let mut export = options.clone(); export.raster_profile = futureox_design_kernel::fidelity::RasterProfile::Figma;
    assert!(engine.compile_gpu_region(&export,Rect::new(300,300,514,514),None).unwrap().nodes.values().all(|n|n.suffix_box.is_none()));
}
