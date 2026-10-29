use futureox_design_kernel::{noise_fill,interop,scene::Document};
use serde_json::json;
#[test]fn noise_image_preset_has_normal_editable_pattern_semantics_and_roundtrips() {
    let paint=noise_fill::preset().unwrap();
    let mut doc:Document=serde_json::from_value(json!({"schemaVersion":14,"id":"noise","name":"Noise",
        "pages":[{"id":"p","name":"P","children":["n"],"background":"#ffffff"}],
        "nodes":{"n":{"id":"n","kind":"rectangle","width":96,"height":96,"fills":[paint]}}})).unwrap();
    doc.validate().unwrap();let back=interop::import_sketch_report(&interop::export_sketch(&doc).unwrap()).unwrap().document;
    let original=&doc.nodes["n"].fills[0];let actual=&back.nodes["n"].fills[0];
    assert_eq!(actual.image,original.image);assert_eq!(actual.tile,original.tile);assert_eq!(actual.opacity,original.opacity);
    assert!(!back.nodes["n"].bindings.contains_key("sketchSourceNoiseFills"));
    doc.nodes.get_mut("n").unwrap().fills[0].tile.as_mut().unwrap().size=[128.,128.];
    doc.nodes.get_mut("n").unwrap().fills[0].opacity=0.4;
    let back=interop::import_sketch_report(&interop::export_sketch(&doc).unwrap()).unwrap().document;
    assert_eq!(back.nodes["n"].fills[0].tile.as_ref().unwrap().size,[128.,128.]);assert_eq!(back.nodes["n"].fills[0].opacity,0.4);
}
