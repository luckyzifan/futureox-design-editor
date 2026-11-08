use futureox_design_kernel::renderer::{Engine, RenderOptions};
use sha2::{Digest, Sha256};

fn digest(zoom: f64, opacity: &str) -> String {
    let mut engine = Engine::new();
    let doc = format!(
        r###"{{
            "schemaVersion":5,"id":"d","name":"shadow",
            "pages":[{{"id":"p","name":"p","children":["a"],"background":"#ffffff"}}],
            "nodes":{{
              "a":{{"id":"a","kind":"rectangle","name":"card","transform":[1,0,0,1,8,6],
                "width":180,"height":120,"radii":[18,18,18,18],
                "fills":[{{"kind":"solid","color":"#808080","opacity":{opacity}}}],
                "effects":[{{"kind":"shadow","radius":8,"x":2,"y":3,"spread":0,"color":"#204060","opacity":0.85}}]}}
            }}
        }}"###
    );
    engine.load_document(&doc).unwrap();
    let options: RenderOptions = serde_json::from_value(serde_json::json!({
        "pageId":"p","width":160,"height":120,"transparent":true,
        "rasterProfile":"analytic","view":{"zoom":zoom,"x":4.0,"y":3.0}
    }))
    .unwrap();
    let pixels = engine.render(&options).unwrap();
    let bytes: [u8; 32] = Sha256::digest(pixels).into();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn direct_box_cast_matches_the_certified_shadow_frames() {
    assert_eq!(digest(1.0, "1"), "b18c1b3a3adf2fa5a9fda1668f79f0918806b436571bf761391f3586958b94e6");
    assert_eq!(digest(3.2, "1"), "df930044bec8a9fdefa5ac4a2016063260bc223282f5d44b2c0194443f1b143d");
    assert_eq!(digest(1.0, "0.35"), "0ed073513eb78b4388c7aa1752fc7c67ff46bf3b35453528e882571a00b5e477");
    assert_eq!(digest(3.2, "0.35"), "07ed304c2e75d34e551fa7c88e846c3ff68a03227f326aa4e62654a8d709a6fb");
    assert_eq!(digest(1.0, "0.08"), "7774e9c0b9ecb7a744194c436293140e6d26c9835c5b5a2452593af3b8566cb4");
    assert_eq!(digest(3.2, "0.08"), "85fb5d3bc7f98fbbcf4de5473d8a99b4cf6e29c2d31fe0587c8d61931f5d8fd9");
}
