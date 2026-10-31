use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::json;
#[test]
fn fractional_mask_is_applied_once_to_overlapping_children_in_all_precisions() {
    for (profile, managed) in [("analytic", false), ("figma", false), ("figma", true)] {
        let rect = |id: &str, color: &str| json!({"id":id,"kind":"rectangle","width":16,"height":16,"fills":[{"kind":"solid","color":color}]});
        let mut mask = rect("mask", "#ffffff");
        mask["mask"] = json!(true);
        mask["opacity"] = json!(0.5);
        let mut doc = json!({"schemaVersion":2,"id":"d","name":"mask once","pages":[{"id":"p","name":"p","background":"#ffffff","children":["g"]}],"nodes":{"g":{"id":"g","kind":"group","width":16,"height":16,"children":["mask","a","b"]},"mask":mask,"a":rect("a","#ff0000"),"b":rect("b","#0000ff")}});
        if managed {
            doc["schemaVersion"] = json!(3);
            doc["colorManagement"] =
                serde_json::to_value(futureox_design_kernel::color::ColorSettings::default())
                    .unwrap();
        }
        let options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":24,"height":24,"view":{"x":0,"y":0,"zoom":1},"transparent":true,"rasterProfile":profile})).unwrap();
        let mut engine = Engine::new();
        engine.load_document(&doc.to_string()).unwrap();
        let rgba = engine.render(&options).unwrap();
        let index = (5 * 24 + 5) * 4;
        assert_eq!(
            &rgba[index..index + 4],
            &[0, 0, 255, 128],
            "{profile} managed={managed}"
        );
    }
}
