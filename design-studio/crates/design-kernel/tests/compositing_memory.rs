use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::json;

#[test]
fn the_root_surface_is_included_in_allocation_and_peak_statistics() {
    let mut engine = Engine::new();
    engine
        .load_document(
            &json!({
                "schemaVersion":1,"id":"d","name":"Empty page",
                "pages":[{"id":"p","name":"p","children":[],"background":"#ffffff"}],"nodes":{}
            })
            .to_string(),
        )
        .unwrap();
    let options: RenderOptions = serde_json::from_value(json!({
        "pageId":"p","width":3,"height":2,"transparent":true,
        "view":{"x":0,"y":0,"zoom":1},"rasterProfile":"analytic"
    }))
    .unwrap();
    assert_eq!(engine.render(&options).unwrap(), vec![0; 24]);
    assert_eq!(engine.stats().allocated_layer_pixels, 6);
    assert_eq!(engine.stats().peak_layer_pixels, 6);
}
