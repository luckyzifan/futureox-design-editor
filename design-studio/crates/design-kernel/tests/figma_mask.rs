use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::json;
#[test]
fn native_figma_alpha_mask_exports_match_at_overlap_and_outside_viewport() {
    for (name, x) in [("mask-overlap", 16), ("mask-outside", 1000)] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
            "../../../frontend/design-client/public/fidelity/{name}.png"
        ));
        let reference = image::load_from_memory(&std::fs::read(path).unwrap())
            .unwrap()
            .to_rgba8()
            .into_raw();
        let d = json!({"schemaVersion":2,"id":"d","name":name,"pages":[{"id":"p","name":"p","background":"#ffffff","children":["f"]}],"nodes":{
            "f":{"id":"f","kind":"frame","width":128,"height":128,"clip":true,"fills":[{"kind":"solid","color":"#ffffff"}],"children":["m","c"]},
            "m":{"id":"m","kind":"rectangle","width":64,"height":64,"mask":true,"transform":[1,0,0,1,x,16],"fills":[{"kind":"solid","color":"#d9d9d9"}]},
            "c":{"id":"c","kind":"rectangle","width":64,"height":64,"transform":[1,0,0,1,16,16],"fills":[{"kind":"solid","color":"#ff0000"}]}}});
        let mut engine = Engine::new();
        engine.load_document(&d.to_string()).unwrap();
        for profile in ["analytic", "figma"] {
            let o:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":128,"height":128,"view":{"x":0,"y":0,"zoom":1},"rasterProfile":profile})).unwrap();
            assert_eq!(engine.render(&o).unwrap(), reference, "{name} {profile}");
        }
    }
}

#[test]
fn outline_masks_use_visible_fill_and_stroke_geometry_without_color_alpha_or_effects() {
    for profile in ["analytic","figma","figmaSoftware","figmaSubpixel"] {
        for (fill,stroke) in [(true,false),(false,true),(true,true),(false,false)] {
            let d=json!({"schemaVersion":4,"id":"d","name":"outline","pages":[{"id":"p","name":"p","children":["g"],"background":"#ffffff"}],"nodes":{
                "g":{"id":"g","kind":"group","width":48,"height":48,"children":["m","c"]},
                "m":{"id":"m","kind":"rectangle","mask":true,"maskType":"outline","width":20,"height":20,"transform":[1,0,0,1,12,12],"opacity":0.2,
                    "fills":[{"kind":"solid","color":"color(srgb 0 0 0 / 0.1)","opacity":0.1,"visible":fill}],
                    "strokes":[{"visible":stroke,"width":4,"align":"outside","paint":{"kind":"solid","color":"#000000","opacity":0.1}}],
                    "effects":[{"kind":"blur","radius":5,"color":"#000000","opacity":1}]},
                "c":{"id":"c","kind":"rectangle","width":48,"height":48,"fills":[{"kind":"solid","color":"#ff0000"}]}
            }});
            let mut engine=Engine::new();engine.load_document(&d.to_string()).unwrap();
            let options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":48,"height":48,"view":{"x":0,"y":0,"zoom":1},"transparent":true,"rasterProfile":profile})).unwrap();
            let pixels=engine.render(&options).unwrap();let alpha=|x:usize,y:usize|pixels[(y*48+x)*4+3];
            assert_eq!(alpha(20,20),if fill {255} else {0},"fill {profile}");
            assert_eq!(alpha(10,20),if stroke {255} else {0},"stroke {profile}");
            assert_eq!(alpha(4,20),0,"effects must not enlarge outline {profile}");
            let scene=engine.compile_gpu(&options).unwrap();let mask=&scene.nodes["m"];
            assert_eq!(mask.opacity,1.);assert!(mask.effects.is_empty());assert_eq!(mask.fills.len(),usize::from(fill));
            assert!(mask.fills.iter().all(|p|p.color=="#ffffff"&&p.opacity==1.));
            assert!(mask.strokes.iter().all(|s|s.paint.color=="#ffffff"&&s.paint.opacity==1.));
        }
    }
}

#[test]
fn container_outline_masks_inherit_geometric_paints_and_invalidate_cached_descendants() {
    let mut d=json!({"schemaVersion":4,"id":"d","name":"container outline","pages":[{"id":"p","name":"p","children":["g"],"background":"#ffffff"}],"nodes":{
        "g":{"id":"g","kind":"group","width":48,"height":48,"children":["m","c"]},
        "m":{"id":"m","kind":"frame","mask":true,"maskType":"outline","clip":true,"width":48,"height":48,"children":["leaf"]},
        "leaf":{"id":"leaf","kind":"rectangle","width":20,"height":20,"transform":[1,0,0,1,12,12],"opacity":0.25,
            "fills":[{"kind":"solid","color":"color(srgb 0 0 0 / 0.1)","opacity":0.1}]},
        "c":{"id":"c","kind":"rectangle","width":48,"height":48,"fills":[{"kind":"solid","color":"#ff0000"}]}
    }});
    let mut engine=Engine::new();engine.load_document(&d.to_string()).unwrap();
    let options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":48,"height":48,"view":{"x":0,"y":0,"zoom":1},"transparent":true,"rasterProfile":"figma"})).unwrap();
    for mode in ["outline","alpha","outline"] {
        d["nodes"]["m"]["maskType"]=json!(mode);
        engine.apply_document_patch(&serde_json::from_value(json!({"nodes":{"m":d["nodes"]["m"].clone()},"fields":{}})).unwrap()).unwrap();
        let scene=engine.compile_gpu(&options).unwrap();
        assert_eq!(scene.nodes["leaf"].opacity,if mode=="outline" {1.} else {0.25});
        let pixels=engine.render(&options).unwrap();let center=pixels[(20*48+20)*4+3];
        if mode=="outline" {assert_eq!(center,255)}else{assert!(center<10)}
        assert_eq!(pixels[(4*48+4)*4+3],0);
    }
}
