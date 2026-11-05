use super::*;
use serde_json::json;

#[test]
fn deferred_page_and_reused_luminance_mask_match_separate_clear_layers() {
    let mut doc = json!({"id":"d","name":"isolation","schemaVersion":19,
    "colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},
    "pages":[{"id":"p","name":"p","background":"#832517","children":["root"]}],
    "nodes":{
        "root":{"id":"root","kind":"frame","width":540,"height":24,"children":["base","group","glass"]},
        "base":{"id":"base","kind":"rectangle","width":522,"height":19,"opacity":0.3,"fills":[{"kind":"solid","color":"#3580ff"}]},
        "group":{"id":"group","kind":"group","width":535,"height":24,"children":["mask","ink"]},
        "mask":{"id":"mask","kind":"ellipse","width":49,"height":22,"transform":[1,0,0,1,484.125,1],
            "mask":true,"maskType":"luminance","opacity":0.6,"fills":[{"kind":"solid","color":"#8cd340"}]},
        "ink":{"id":"ink","kind":"rectangle","width":535,"height":24,"fills":[{"kind":"solid","color":"color(srgb-linear 3 -0.1 0.8)"}]},
        "glass":{"id":"glass","kind":"rectangle","width":53,"height":17,"transform":[1,0,0,1,482,3],
            "effects":[{"kind":"background-blur","radius":3,"color":"#000000"}]}
    }});
    let mut reused = Engine::new();
    reused.load_document(&doc.to_string()).unwrap();
    // A visible zero-alpha paint forces both conventional isolation buffers.
    for id in ["root", "group"] {
        doc["nodes"][id]["fills"] = json!([{"kind":"solid","color":"#000000","opacity":0.}]);
    }
    let mut ordinary = Engine::new();
    ordinary.load_document(&doc.to_string()).unwrap();
    for transparent in [false, true] {
        let view = reused
            .parse_options(
                json!({"pageId":"p","width":539,"height":29,"transparent":transparent,
            "view":{"x":0.125,"y":0.375,"zoom":1},"rasterProfile":"figmaSubpixel"}),
            )
            .unwrap();
        let actual = reused.render_linear(&view).unwrap();
        let expected = ordinary.render_linear(&view).unwrap();
        for (a, b) in actual.iter().zip(&expected) {
            assert_eq!(a.0.map(f32::to_bits), b.0.map(f32::to_bits));
        }
        assert_ne!(actual[10 * 539 + 510].0, actual[28 * 539 + 538].0);
    }
}

#[test]
fn oversized_backdrop_index_preserves_each_tiles_support_and_budget_error() {
    let mut doc: Document = serde_json::from_value(json!({
        "id":"d","name":"many backdrops","schemaVersion":19,
        "colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":[]}],"nodes":{}
    })).unwrap();
    let base: Node = serde_json::from_value(json!({
        "id":"base","kind":"rectangle","width":8,"height":8,
        "effects":[{"kind":"background-blur","radius":3,"color":"#000000"}]
    }))
    .unwrap();
    for i in 0..4097 {
        let mut node = base.clone();
        node.id = format!("lens-{i}");
        node.transform.0[4] = if i == 0 { 0. } else { 10_000. };
        doc.pages[0].children.push(node.id.clone());
        doc.nodes.insert(node.id.clone(), node);
    }
    let mut engine = Engine::new();
    engine.install_document(doc).unwrap();
    let options = engine
        .parse_options(json!({"pageId":"p","width":64,"height":64,
        "view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figmaSubpixel"}))
        .unwrap();
    let mut frame = CpuFramePlan::new();
    for x in [0, 10_000, 0] {
        let tile = Rect::new(x, 0, 64, 64);
        let expected = crate::export::backdrop_padding(&engine, &options, tile);
        assert_eq!(expected.is_err(), x == 10_000);
        assert_eq!(frame.padding(&engine, &options, tile, 1), expected);
    }
}

#[test]
fn frame_reuse_preserves_guard_culls_segments_and_fractional_camera() {
    let doc = json!({"schemaVersion":19,"id":"d","name":"tile seam",
    "colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},
    "pages":[{"id":"p","name":"p","background":"#112233","children":["stripe","frame","dot"]}],
    "nodes":{
        "stripe":{"id":"stripe","kind":"rectangle","width":1043,"height":6,"fills":[{"kind":"solid","color":"#334455"}]},
        "frame":{"id":"frame","kind":"frame","clip":true,"blend":"normal","transform":[1,0,0,1,514,2],
            "width":20,"height":18,"children":["leaf"]},
        "leaf":{"id":"leaf","kind":"ellipse","width":25,"height":17,"fills":[{"kind":"solid","color":"#eea040"}]},
        "dot":{"id":"dot","kind":"ellipse","transform":[1,0,0,1,1012,4],"width":33,"height":15,
            "fills":[{"kind":"solid","color":"color(srgb-linear 2 0.5 0)"}]}
    }});
    let mut actual = Engine::new();
    actual.load_document(&doc.to_string()).unwrap();
    let mut reference = actual.snapshot_worker();
    for x in [0.25, -7.875, 0.25] {
        let opts: RenderOptions =
            serde_json::from_value(json!({"pageId":"p","width":1041,"height":23,
            "view":{"x":x,"y":0.375,"zoom":1},"rasterProfile":"figmaSubpixel"}))
            .unwrap();
        let image = actual.render_linear(&opts).unwrap();
        reference.prepare_frame(&opts).unwrap();
        let mut segments = 0;
        for left in (0..opts.width).step_by(512) {
            let width = (opts.width - left).min(512);
            let tile = reference
                .linear_rect_pixels(&opts, left, 0, width, opts.height)
                .unwrap();
            segments += reference.stats.path_segments;
            for (y, row) in tile.chunks(width as usize).enumerate() {
                let at = y * opts.width as usize + left as usize;
                for (a, b) in image[at..].iter().zip(row) {
                    assert_eq!(a.0.map(f32::to_bits), b.0.map(f32::to_bits));
                }
            }
        }
        assert_eq!(actual.stats.path_segments, segments);
        assert!(image.iter().any(|p| p.0[0] > 1.));
    }
}
