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
