//! Baseline text contracts, retained after rejecting font-face cache experiments.
use futureox_design_kernel::{font::Fonts, scene::Node};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn fonts() -> Fonts {
    let mut f = Fonts::new();
    f.load(
        &std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
        ))
        .unwrap(),
    )
    .unwrap();
    f
}
fn pressure_node() -> Node {
    serde_json::from_value(json!({"id":"t","kind":"text","text":"中".repeat(80),"fontSize":20,"width":251.375,"height":30,
        "textStyle":{"wrap":true,"paragraphIndent":25,"letterSpacing":-0.375},
        "textRuns":(0..80).map(|i|json!({"start":i,"end":i+1,"weight":100.+(i%40) as f64*20.125,"fontSize":12.+(i%3)as f64*3.125,"color":if i%2==1 {"#112233"}else{"#cc2255"},"underline":i%3==0})).collect::<Vec<_>>()
    })).unwrap()
}
#[test]
fn forty_weight_rich_text_preserves_baseline_geometry_and_outlines() {
    let fonts = fonts();
    let n = pressure_node();
    let layout = fonts.node_layout(&n, Some(n.width)).unwrap();
    // Exact pre-optimization release-WASM output for the pinned repository font.
    assert_eq!(
        format!("{:x}", Sha256::digest(serde_json::to_vec(&layout).unwrap())),
        "5ea0e9e19b71b82493ce2feda0096e29aaae7221df82ae23dca395bd752ee1f2"
    );
    assert_eq!(
        (
            layout.width,
            layout.height,
            layout.lines.len(),
            layout.glyphs.len()
        ),
        (251.125, 135., 5, 80)
    );
    let measured = fonts.node_measure(&n, Some(n.width)).unwrap();
    assert!(measured.path.commands.is_empty());
    assert!(measured.spans.is_empty());
    assert!(measured.bounds.is_none());
    let a = serde_json::to_value(layout).unwrap();
    let b = serde_json::to_value(measured).unwrap();
    for key in ["width", "height", "lines", "glyphs"] {
        assert_eq!(a[key], b[key], "{key}");
    }
}
#[test]
fn each_call_observes_weight_changes_and_preserves_lazy_font_errors() {
    let fonts = fonts();
    let mut n = pressure_node();
    let before = serde_json::to_value(fonts.node_layout(&n, Some(n.width)).unwrap()).unwrap();
    n.text_runs[0].weight = Some(799.125);
    let changed = serde_json::to_value(fonts.node_layout(&n, Some(n.width)).unwrap()).unwrap();
    assert_ne!(before["spans"], changed["spans"]);
    n.text_runs[0].weight = Some(100.);
    assert_eq!(
        before,
        serde_json::to_value(fonts.node_layout(&n, Some(n.width)).unwrap()).unwrap()
    );
    n.text_runs.clear();
    n.text_style.as_mut().unwrap().fallbacks = vec!["missing".into()];
    assert!(fonts.node_measure(&n, None).is_ok());
    n.text = "😀".into();
    // Unresolvable fallbacks degrade to .notdef on the primary face — the
    // historical hard error let one emoji blank an entire document render.
    assert!(fonts.node_measure(&n, None).is_ok());
    n.text.clear();
    n.text_style.as_mut().unwrap().font_id = "missing".into();
    assert_eq!(
        serde_json::to_value(fonts.node_measure(&n, None).unwrap()).unwrap()["glyphs"],
        Value::Array(vec![])
    );
}

#[test]
fn repeated_glyphs_reuse_font_unit_outlines_without_moving_layout() {
    let fonts = fonts(); let node = pressure_node();
    let before = serde_json::to_vec(&fonts.node_layout(&node, Some(node.width)).unwrap()).unwrap();
    let first = fonts.glyph_cache_stats();
    let after = serde_json::to_vec(&fonts.node_layout(&node, Some(node.width)).unwrap()).unwrap();
    let repeated = fonts.glyph_cache_stats();
    assert_eq!(before, after);
    assert_eq!(fonts.node_path(&node).unwrap(), fonts.node_layout(&node, Some(node.width)).unwrap().path);
    assert_eq!(first["builds"], repeated["builds"]);
    assert!(repeated["hits"].as_u64().unwrap() > first["hits"].as_u64().unwrap());
    assert!(repeated["bytes"].as_u64().unwrap() <= repeated["limit"].as_u64().unwrap());
}

#[test]
fn concurrent_text_cache_misses_publish_one_exact_shared_path() {
    let fonts = fonts(); let node = pressure_node();
    let expected = fonts.node_layout(&node, Some(node.width)).unwrap().path;
    let barrier = std::sync::Barrier::new(8);
    let paths = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8).map(|_| scope.spawn(|| {
            barrier.wait();
            fonts.node_path_shared(&node).unwrap()
        })).collect();
        handles.into_iter().map(|handle| handle.join().unwrap()).collect::<Vec<_>>()
    });
    assert_eq!(*paths[0], expected);
    for path in &paths { assert!(std::sync::Arc::ptr_eq(&paths[0], path)); }
    assert_eq!(fonts.text_path_cache_stats()["entries"], 1);
    assert!(fonts.glyph_cache_stats()["bytes"].as_u64().unwrap() <= 16 * 1024 * 1024);
}

#[test]
fn changing_a_collection_face_index_never_reuses_the_old_resource() {
    use base64::Engine as _;
    let fonts = fonts();
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"),"/../../../frontend/design-client/public/fonts/NotoSansSC.ttf")).unwrap();
    let mut resources = std::collections::BTreeMap::from([("font-test".into(),futureox_design_kernel::font::FontResource {
        family:"test".into(),data:base64::engine::general_purpose::STANDARD.encode(bytes).into(),index:0,postscript:None })]);
    let loaded = fonts.with_resources(&resources).unwrap();
    resources.get_mut("font-test").unwrap().index = 1;
    assert!(loaded.with_resources(&resources).is_err(), "this TTF has only face zero");
}

#[test]
fn local_text_paths_share_only_complete_layout_inputs_and_font_lineage() {
    let mut fonts=fonts();let n=pressure_node();
    let first=fonts.node_path(&n).unwrap();let mut moved=n.clone();moved.id="another-node".into();moved.transform.0[4]=123.375;
    assert_eq!(first,fonts.node_path(&moved).unwrap());
    assert_eq!(fonts.text_path_cache_stats()["hits"],1);
    for kind in 0..4 {
        let mut changed=n.clone();
        match kind {0=>changed.width+=30.,1=>changed.text_runs[0].weight=Some(800.),
            2=>changed.text_style.as_mut().unwrap().letter_spacing+=0.375,_=>changed.font_size+=2.}
        assert_eq!(fonts.node_path(&changed).unwrap(),fonts.node_layout(&changed,Some(changed.width)).unwrap().path);
    }
    fonts.set_glyph_origin_quantization(true);
    assert_eq!(fonts.node_path(&n).unwrap(),fonts.node_layout(&n,Some(n.width)).unwrap().path);
    fonts.set_glyph_origin_quantization(false);assert_eq!(fonts.node_path(&n).unwrap(),first);
    let same=fonts.with_resources(&Default::default()).unwrap();
    assert_eq!(same.node_path(&n).unwrap(),first);
    let bytes=std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"),"/../../../frontend/design-client/public/fonts/NotoSansSC.ttf")).unwrap();
    fonts.load(&bytes).unwrap();assert_eq!(fonts.text_path_cache_stats()["entries"],0);
    assert_eq!(fonts.node_path(&n).unwrap(),first);
    assert!(fonts.text_path_cache_stats()["bytes"].as_u64().unwrap()<=16*1024*1024);
}
