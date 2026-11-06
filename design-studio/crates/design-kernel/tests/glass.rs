use futureox_design_kernel::{
    Engine, RenderOptions,
    blend::Pixel,
    color::{ColorOutput, ColorSpace, ToneMap},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn fixture(color: &str, managed: bool) -> Value {
    let mut doc = json!({
        "schemaVersion": 3, "id": "glass", "name": "Glass numeric contract",
        "pages": [{"id": "p", "name": "Page", "children": ["bg", "glass"], "background": "#ffffff"}],
        "nodes": {
            "bg": {"id": "bg", "kind": "rectangle", "width": 48, "height": 48,
                "fills": [{"kind": "solid", "color": color}]},
            "glass": {"id": "glass", "kind": "rectangle", "width": 31.5, "height": 31.25,
                "transform": [1, 0, 0, 1, 8.25, 8.5], "radii": [5, 5, 5, 5],
                "effects": [{"kind": "glass", "radius": 0, "amount": 0, "opacity": 0, "color": "#000000"}]}
        }
    });
    if managed {
        doc["colorManagement"] =
            json!({"documentSpace": "srgb", "referenceWhiteNits": 203, "peakLuminanceNits": 1000});
    }
    doc
}

fn options(profile: &str, scale: u32) -> RenderOptions {
    serde_json::from_value(
        json!({"pageId": "p", "width": 48 * scale, "height": 48 * scale,
        "view": {"x": 0, "y": 0, "zoom": scale}, "transparent": true, "rasterProfile": profile}),
    )
    .unwrap()
}

fn engine(doc: &Value) -> Engine {
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    engine
}

#[test]
fn coincident_lenses_preserve_rear_paint_and_restore_optics_on_separation() {
    let mut doc=fixture("#778899",true);
    doc["schemaVersion"]=json!(5);
    let glass=json!({"kind":"glass","color":"#000000","radius":1.5,"glass":{
        "depth":4.,"refraction":0.65,"lightAngle":38.,"lightIntensity":0.7,"dispersion":0.45}});
    doc["nodes"]["glass"]["effects"]=json!([glass]);
    doc["nodes"]["glass"]["fills"]=json!([{"kind":"solid","color":"#ff2018","opacity":0.25}]);
    doc["nodes"]["front"]=doc["nodes"]["glass"].clone();
    doc["nodes"]["front"]["id"]=json!("front");
    doc["nodes"]["front"]["fills"]=json!([]);
    doc["pages"][0]["children"]=json!(["bg","glass","front"]);
    let opts=options("figmaSubpixel",1);
    for front in [glass.clone(),json!({"kind":"background-blur","radius":2.,"color":"#000000"})] {
        doc["nodes"]["front"]["effects"]=json!([front]);
        let mut expected=doc.clone();
        expected["nodes"]["glass"]["effects"]=json!([]);
        let actual=engine(&doc).render_linear(&opts).unwrap();
        assert_eq!(actual,engine(&expected).render_linear(&opts).unwrap());
        expected["nodes"]["glass"]["fills"]=json!([]);
        assert_ne!(actual,engine(&expected).render_linear(&opts).unwrap());
        let compiled=engine(&doc).compile_gpu(&opts).unwrap();
        assert!(compiled.nodes["glass"].effects.is_empty());
        assert_eq!(compiled.nodes["front"].effects.len(),1);
    }
    doc["nodes"]["front"]["transform"][4]=json!(18.25);
    assert_eq!(engine(&doc).compile_gpu(&opts).unwrap().nodes["glass"].effects.len(),1);
    doc["nodes"]["front"]["transform"]=doc["nodes"]["glass"]["transform"].clone();
    doc["nodes"]["glass"]["effects"]=json!([{"kind":"background-blur","radius":3.,"color":"#000000"}]);
    doc["nodes"]["front"]["effects"]=json!([glass]);
    assert_eq!(engine(&doc).compile_gpu(&opts).unwrap().nodes["glass"].effects.len(),1);
    doc["nodes"]["glass"]["effects"]=doc["nodes"]["front"]["effects"].clone();
    doc["designSystem"]=json!({"sketchContainers":{"nodeMetadata":{"glass":{"bindings":{"sketchSourceBlur":"{}"}}}}});
    let imported=engine(&doc).compile_gpu(&opts).unwrap();
    assert_eq!(imported.nodes["glass"].effects.len(),1);
    assert!(imported.nodes["glass"].optical_prefix_next.is_none());
}

#[test]
fn overlapping_unpainted_glass_excludes_only_the_rear_optics_from_the_next_capture() {
    let mut doc=fixture("#556677",true);
    doc["schemaVersion"]=json!(5);
    let material=json!({"kind":"glass","radius":1.,"color":"#000000","glass":{
        "depth":7.,"refraction":0.8,"dispersion":0.65,"lightIntensity":0.9,"lightAngle":205.}});
    doc["nodes"]["glass"]["effects"]=json!([material]);
    let mut front=doc["nodes"]["glass"].clone();
    front["id"]=json!("front");front["transform"][4]=json!(18.25);
    doc["nodes"]["front"]=front;
    doc["pages"][0]["children"]=json!(["bg","glass","front"]);
    let opts=options("figmaSubpixel",1);
    for effect in [material.clone(),json!({"kind":"background-blur","color":"#000000","radius":3.})] {
        doc["nodes"]["front"]["effects"]=json!([effect]);
        let mut rear=doc.clone();rear["nodes"]["front"]["visible"]=json!(false);
        let mut clean=doc.clone();clean["nodes"]["glass"]["effects"]=json!([]);
        let mut tinted=doc.clone();tinted["nodes"]["glass"]["fills"]=json!([{"kind":"solid","color":"#ff0000","opacity":0.4}]);
        let frame=engine(&doc).render_linear(&opts).unwrap();
        let without_front=engine(&rear).render_linear(&opts).unwrap();
        let without_rear=engine(&clean).render_linear(&opts).unwrap();
        for y in 16..31 {for x in 23..45 {let i=y*48+x;assert_eq!(frame[i],without_rear[i]);}}
        for y in 0..48 {for x in 0..16 {let i=y*48+x;assert_eq!(frame[i],without_front[i]);}}
        assert!((0..48).any(|y|(0..16).any(|x|frame[y*48+x]!=without_rear[y*48+x])));
        assert_eq!(engine(&doc).compile_gpu(&opts).unwrap().nodes["glass"].optical_prefix_next.as_deref(),Some("front"));
        assert_eq!(engine(&tinted).compile_gpu(&opts).unwrap().nodes["glass"].optical_prefix_next.as_deref(),Some("front"));
        let painted=engine(&tinted).render_linear(&opts).unwrap();
        tinted["nodes"]["glass"]["effects"]=json!([]);
        let ordinary=engine(&tinted).render_linear(&opts).unwrap();
        for y in 16..31 {for x in 23..45 {let i=y*48+x;assert_eq!(painted[i],ordinary[i]);}}
    }
}

#[test]
fn managed_zero_distortion_glass_preserves_hdr_gamut_and_alpha() {
    // Binary-exact inputs make this an equality contract, without a new
    // tolerance that could conceal RGBA8 clipping or alpha quantization.
    for (components, alpha) in [
        ("4 -0.25 0.125", 0.),
        ("4 -0.25 0.125", 0.000244140625),
        ("4 -0.25 0.125", 0.25),
        ("4 -0.25 0.125", 0.5),
        ("4 -0.25 0.125", 1.),
        ("65504 -65504 0.125", 1.),
    ] {
        let color = format!("color(srgb-linear {components} / {alpha})");
        let doc = fixture(&color, true);
        let mut plain = doc.clone();
        plain["nodes"]["glass"]["effects"] = json!([]);
        for profile in ["figma", "figmaSubpixel"] {
            let options = options(profile, 1);
            let expected = engine(&plain).render_linear(&options).unwrap();
            let actual = engine(&doc).render_linear(&options).unwrap();
            assert_eq!(actual.len(), expected.len());
            for (index, (actual, expected)) in actual.iter().zip(&expected).enumerate() {
                assert_eq!(actual, expected, "{profile}, alpha={alpha}, pixel={index}");
            }
        }
    }
}

#[test]
fn managed_refractive_glass_retains_extended_channels() {
    let mut doc = fixture("color(srgb-linear 8 -2 0.125 / 0.5)", true);
    doc["nodes"]["glass"]["effects"][0] = json!({"kind": "glass", "radius": 2.25,
        "amount": 1.5, "opacity": 0.4, "color": "#000000"});
    for profile in ["figma", "figmaSubpixel"] {
        let pixels = engine(&doc).render_linear(&options(profile, 1)).unwrap();
        let center = pixels[24 * 48 + 24];
        assert_eq!(center, Pixel([4., -1., 0.0625, 0.5]), "{profile}");
        // Fully covered edge pixels exercise nonzero refraction and lighting.
        let edge = pixels[24 * 48 + 9];
        assert!(edge.0[0] > 1. && edge.0[1] < 0., "{profile}: {edge:?}");
        assert!(
            pixels
                .iter()
                .all(|p| p.0.iter().all(|v| v.is_finite()) && (0. ..=1.).contains(&p.0[3]))
        );
    }
}

#[test]
fn managed_glass_crops_match_tiled_frames_at_export_scales() {
    let mut doc = fixture("color(srgb-linear 4 -0.25 0.125 / 0.5)", true);
    doc["nodes"]["bg"]["transform"] = json!([1, 0, 0, 1, 2, 2]);
    doc["nodes"]["bg"]["width"] = json!(44);
    doc["nodes"]["bg"]["height"] = json!(44);
    doc["nodes"]["bg"]["fills"][0]["kind"] = json!("linear");
    doc["nodes"]["bg"]["fills"][0]["stops"] = json!([
        {"offset": 0, "color": "color(srgb-linear 4 -0.25 0.125 / 0.5)"},
        {"offset": 1, "color": "color(srgb-linear 0.25 0.125 2 / 0.25)"}
    ]);
    doc["nodes"]["glass"]["effects"][0]["radius"] = json!(2.25);
    doc["nodes"]["glass"]["transform"] = json!([1, 0, 0, 1, -4, -4]);
    doc["nodes"]["glass"]["width"] = json!(47.5);
    doc["nodes"]["glass"]["height"] = json!(47.25);
    doc["nodes"]["frame"] = json!({"id": "frame", "kind": "frame", "width": 39.5, "height": 38.75,
        "transform": [1, 0, 0, 1, 4.25, 4.5], "clip": true, "children": ["glass"]});
    doc["pages"][0]["children"] = json!(["bg", "frame"]);
    // Refraction/light are zero so this checks crop/blur/coverage placement
    // without adding a new cross-origin f32 sampling tolerance.
    for profile in ["figma", "figmaSubpixel"] {
        for scale in [1, 2, 3] {
            let crop_options = options(profile, scale);
            let mut tiled_options = crop_options.clone();
            let offset = 512 - 24 * scale;
            tiled_options.width = 1024;
            tiled_options.view.x = f64::from(offset);
            let crop = engine(&doc).render_linear(&crop_options).unwrap();
            let tiled = engine(&doc).render_linear(&tiled_options).unwrap();
            for y in 0..crop_options.height as usize {
                let actual = &tiled[y * 1024 + offset as usize
                    ..y * 1024 + offset as usize + crop_options.width as usize];
                let expected =
                    &crop[y * crop_options.width as usize..(y + 1) * crop_options.width as usize];
                assert_eq!(actual, expected, "{profile}, {scale}x, row={y}");
            }
        }
    }
}

#[test]
fn managed_zero_distortion_glass_keeps_16_bit_png_export() {
    let doc = fixture("color(srgb-linear 4 0.25 2 / 0.5)", true);
    let mut plain = doc.clone();
    plain["nodes"]["glass"]["effects"] = json!([]);
    for profile in ["figma", "figmaSubpixel"] {
        for scale in [1, 2, 3] {
            let options = options(profile, scale);
            let output = ColorOutput {
                space: ColorSpace::Pq,
                tone_map: ToneMap::None,
            };
            let png = engine(&doc).render_color_png(&options, output).unwrap();
            let expected = engine(&plain).render_color_png(&options, output).unwrap();
            assert!(png == expected, "16-bit PNG differs: {profile}, {scale}x");
            let reader = png::Decoder::new(std::io::Cursor::new(&png))
                .read_info()
                .unwrap();
            assert_eq!(reader.info().bit_depth, png::BitDepth::Sixteen);
            assert_eq!(
                (reader.info().width, reader.info().height),
                (48 * scale, 48 * scale)
            );
        }
    }
}

#[test]
fn sdr_glass_keeps_the_cross_backend_materialization_baseline() {
    let mut doc = fixture("#80a0c0", false);
    doc["nodes"]["bg"]["fills"][0]["kind"] = json!("linear");
    doc["nodes"]["bg"]["fills"][0]["angle"] = json!(27);
    doc["nodes"]["bg"]["fills"][0]["opacity"] = json!(0.37);
    doc["nodes"]["bg"]["fills"][0]["stops"] = json!([
        {"offset": 0, "color": "#e63d0a"}, {"offset": 1, "color": "#1a80e6"}
    ]);
    doc["nodes"]["glass"]["effects"][0] = json!({"kind": "glass", "radius": 2.25,
        "amount": 1.5, "opacity": 0.4, "color": "#000000"});
    let hashes: Vec<_> = ["analytic", "figma", "figmaSubpixel"]
        .into_iter()
        .map(|profile| {
            let rgba = engine(&doc).render(&options(profile, 1)).unwrap();
            (Sha256::digest(&rgba)).iter().map(|b| format!("{b:02x}")).collect::<String>()
        })
        .collect();
    // The fine profiles materialize refraction and light separately. Their
    // new hashes were verified against actual WebGPU and WebGL2 readbacks,
    // plus the independent integer stage oracle in renderer_tests/memory.rs.
    // Analytic now shares ordered glass and uses exact single-round Gaussian
    // box stages; corpus case 159 verifies this new hash across all backends.
    // The fine-profile hashes include the independently checked four-pass
    // constant-colour export accumulator; case 159 has native CPU/Metal and
    // browser CPU/WebGPU/WebGL2 zero-difference readbacks for this contract.
    // 2026-10-18: the frozen pre-optimization source and actual browser
    // CPU/WebGPU/WebGL2 case 159 agree on these bytes in all three profiles.
    // The old fine-profile digests had drifted before this optimization.
    // These are not Figma-export reference hashes; old values and all nine
    // readbacks are retained in the incremental-rendering review evidence.
    assert_eq!(
        hashes,
        [
            "analytic:726611213ff564976610beffd4ca126369e3c7348e0b38bb19743db52e520c32",
            "figma:9d9683838ef4dc197dde79d554a2eeb4a6158ac068da7d6bb9b2566bc166952f",
            "figmaSubpixel:29af3b84c3446f0556bbeef0f5f111d4ab8cf10001b25c3382e09642f802faad"
        ]
    );
}
