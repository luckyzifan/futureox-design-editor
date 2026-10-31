use futureox_design_kernel::Engine;
use serde_json::json;

#[test]
fn fine_sdr_layer_blur_activates_at_half_an_output_pixel() {
    // Real browser probes: r=.499 at 1x is unchanged; r=.5 at 1x,
    // r=.25 at 2x and r=.125 at 4x all spread into neighboring pixels.
    for profile in ["figma", "figmaSubpixel"] {
        for zoom in [1., 2., 4.] {
            for radius in [0., 0.1249, 0.125, 0.249, 0.25, 0.499, 0.5] {
                let mut doc = json!({"schemaVersion":4,"id":"d","name":"threshold",
                    "pages":[{"id":"p","name":"p","background":"#000000","children":["a"]}],
                    "nodes":{"a":{"id":"a","kind":"rectangle","width":1,"height":4,
                        "transform":[1,0,0,1,3,2],"fills":[{"kind":"solid","color":"#ffffff"}],
                        "effects":[{"kind":"blur","radius":radius,"color":"#000000"}]}}});
                let mut e = Engine::new();
                e.load_document(&doc.to_string()).unwrap();
                let options = e
                    .parse_options(json!({"pageId":"p","width":(8.*zoom) as u32,
                    "height":(8.*zoom) as u32,"view":{"x":0,"y":0,"zoom":zoom},
                    "rasterProfile":profile}))
                    .unwrap();
                let actual = e.render(&options).unwrap();
                let scene = e.compile_gpu(&options).unwrap();
                let active = radius * zoom >= 0.5;
                assert_eq!(
                    scene.nodes["a"].effects[0].radius > 0.,
                    active,
                    "GPU parameter compiler: {profile}, r={radius}, zoom={zoom}"
                );
                doc["nodes"]["a"]["effects"] = json!([]);
                e.load_document(&doc.to_string()).unwrap();
                let unblurred = e.render(&options).unwrap();
                assert_eq!(
                    actual != unblurred,
                    active,
                    "CPU pixels: {profile}, r={radius}, zoom={zoom}"
                );
            }
        }
    }
}

#[test]
fn managed_blur_does_not_inherit_an_sdr_figma_observation() {
    for profile in ["analytic", "figma", "figmaSubpixel"] {
        let doc = json!({"schemaVersion":4,"id":"d","name":"managed",
            "colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},
            "pages":[{"id":"p","name":"p","background":"#000000","children":["a"]}],
            "nodes":{"a":{"id":"a","kind":"rectangle","width":1,"height":1,
                "fills":[{"kind":"solid","color":"color(srgb-linear 4 0 0)"}],
                "effects":[{"kind":"blur","radius":0.125,"color":"#000000"}]}}});
        let mut e = Engine::new();
        e.load_document(&doc.to_string()).unwrap();
        let options = e
            .parse_options(json!({"pageId":"p","width":4,"height":4,
            "view":{"x":1,"y":1,"zoom":1},"transparent":true,"rasterProfile":profile}))
            .unwrap();
        assert_eq!(
            e.compile_gpu(&options).unwrap().nodes["a"].effects[0].radius,
            0.125
        );
        assert!(
            e.render_linear(&options)
                .unwrap()
                .iter()
                .filter(|p| p.0[0] > 0.)
                .count()
                > 1
        );
    }
}
