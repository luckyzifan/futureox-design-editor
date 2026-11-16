//! Admission of the 15060% Zoom Blur focus-drag preview on the real 117 archive.
//! The interactive preview and the exact canvas share one camera. This records
//! which request the kernel rejects before any UI change.
use futureox_design_kernel::{
    Engine, interop,
    math::{Point, Transform},
    scene::Document,
};
use serde_json::{Value, json};

fn load_117() -> Document {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../testing/fixtures/user-regression-20261109/117.sketch",
    );
    let bytes = std::fs::read(path).expect("117.sketch");
    assert!(
        !bytes.starts_with(b"version https://git-lfs.github.com"),
        "117.sketch is still an LFS pointer",
    );
    interop::import_sketch_report(&bytes)
        .expect("import 117.sketch")
        .document
}

fn parents(doc: &Document) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    for node in doc.nodes.values() {
        for child in &node.children {
            out.insert(child.clone(), node.id.clone());
        }
    }
    out
}

fn world_matrix(doc: &Document, id: &str) -> Transform {
    let mut chain = Vec::new();
    let mut at = id.to_string();
    let parents = parents(doc);
    loop {
        chain.push(doc.nodes[&at].transform);
        match parents.get(&at) {
            Some(parent) => at = parent.clone(),
            None => break,
        }
    }
    chain
        .into_iter()
        .rev()
        .fold(Transform::default(), |m, local| m.concat(local))
}

fn substitute_unembedded_fonts(doc: &mut Document) {
    let known: std::collections::BTreeSet<String> = doc.fonts.keys().cloned().collect();
    let present = |id: &str| id == "default" || known.contains(id);
    for node in doc.nodes.values_mut() {
        if let Some(style) = node.text_style.as_mut() {
            if !present(&style.font_id) {
                style.font_id = "default".into();
            }
            style.fallbacks.retain(|id| present(id));
        }
        for run in &mut node.text_runs {
            if run.font_id.as_deref().is_some_and(|id| !present(id)) {
                run.font_id = Some("default".into());
            }
        }
    }
}

fn compile(doc: &Document, request: &Value) -> Result<Value, String> {
    let mut prepared = doc.clone();
    substitute_unembedded_fonts(&mut prepared);
    let mut engine = Engine::new();
    let font_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
    );
    if let Ok(font) = std::fs::read(font_path) {
        engine.load_font(&font).map_err(|error| error.to_string())?;
    }
    engine
        .load_document(&serde_json::to_string(&prepared).unwrap())
        .map_err(|error| error.to_string())?;
    engine
        .compile_gpu_request(&request.to_string())
        .map(|scene| serde_json::to_value(scene).unwrap())
}

#[test]
fn measure_117_zoom_focus_preview_against_exact_tiles() {
    let mut doc = load_117();
    let ellipse = doc
        .nodes
        .values()
        .find(|node| node.name == "椭圆 66")
        .expect("椭圆 66")
        .id
        .clone();
    let before: Vec<_> = doc.nodes[&ellipse].effects.iter().map(|effect| {
        json!({
            "kind": effect.kind,
            "visible": effect.visible,
            "radius": effect.radius,
            "zoom": effect.zoom_blur.map(|zoom| json!({"amount": zoom.amount, "center": zoom.center})),
        })
    }).collect();
    let node = doc.nodes.get_mut(&ellipse).unwrap();
    assert!(
        (node.width - 5.).abs() < 1e-6 && (node.height - 5.).abs() < 1e-6,
        "layer is 5×5"
    );
    // The archive stores a disabled Gaussian on this layer. The reported gesture
    // drags a Zoom Blur focus, which authors the same stored radius and center.
    if !node
        .effects
        .iter()
        .any(|effect| effect.visible && effect.zoom_blur.is_some_and(|zoom| zoom.amount > 0.))
    {
        node.effects.push(
            serde_json::from_value(json!({
                "kind": "zoom-blur", "visible": true, "radius": 0, "color": "#000000",
                "zoomBlur": { "amount": 10, "center": [0.5, 0.5] }
            }))
            .unwrap(),
        );
    }
    let matrix = world_matrix(&doc, &ellipse);
    let node = &doc.nodes[&ellipse];
    let center = matrix.point(Point::new(node.width * 0.5, node.height * 0.5));
    let mut invalid = Vec::new();
    for (id, node) in &doc.nodes {
        let bad_dim = [node.width, node.height, node.font_size]
            .iter()
            .any(|value| !value.is_finite() || *value <= 0. || *value > 1e7);
        let bad_transform = node
            .transform
            .0
            .iter()
            .any(|value| !value.is_finite() || value.abs() > 1e7)
            || node.transform.inverse().is_err();
        if id != &node.id
            || bad_dim
            || bad_transform
            || !node.opacity.is_finite()
            || node.opacity < 0.
            || node.opacity > 1.
            || node.fills.len() > 16
            || node.strokes.len() > 16
            || node.effects.len() > 16
        {
            if invalid.len() < 12 {
                invalid.push(format!("{} {} w={} h={} font={} opacity={} fills={} strokes={} effects={} transform={:?}",
                    id, node.kind, node.width, node.height, node.font_size, node.opacity, node.fills.len(), node.strokes.len(), node.effects.len(), node.transform.0));
            }
        }
    }
    let validity = doc.validate().err();
    let bytes = serde_json::to_string(&doc).unwrap().len();
    let zoom = 150.60 * 2.;
    let frame = (1600u32, 1200u32);
    let view = json!({
        "x": f64::from(frame.0) * 0.5 - center.x * zoom,
        "y": f64::from(frame.1) * 0.5 - center.y * zoom,
        "zoom": zoom,
    });
    let base = json!({
        "pageId": doc.pages[0].id,
        "rasterProfile": "analytic",
        "interactiveEffects": true,
        "transparent": false,
        "grid": false,
        "view": view,
    });
    let mut whole = base.clone();
    whole["width"] = json!(frame.0);
    whole["height"] = json!(frame.1);
    let whole_error = compile(&doc, &whole).expect_err("whole-scene preview");
    let tile_side = 514u32;
    let mut tile = base.clone();
    tile["width"] = json!(tile_side);
    tile["height"] = json!(tile_side);
    tile["gpuAnalyticRegions"] = json!(true);
    tile["gpuViewport"] = json!({
        "x": (f64::from(frame.0) * 0.5).floor() as i32 - (tile_side as i32) / 2,
        "y": (f64::from(frame.1) * 0.5).floor() as i32 - (tile_side as i32) / 2,
        "w": tile_side,
        "h": tile_side,
    });
    // The exact canvas keeps a world-origin camera. Compare that lattice too.
    let mut exact = base.clone();
    exact["width"] = json!(tile_side);
    exact["height"] = json!(tile_side);
    exact["gpuAnalyticRegions"] = json!(true);
    exact["view"] = json!({ "x": 0., "y": 0., "zoom": zoom });
    exact["gpuViewport"] = json!({
        "x": (center.x * zoom).floor() as i32 - (tile_side as i32) / 2,
        "y": (center.y * zoom).floor() as i32 - (tile_side as i32) / 2,
        "w": tile_side,
        "h": tile_side,
    });
    let mut capture = whole.clone();
    capture["gpuAnalyticRegions"] = json!(true);
    capture["captureViewport"] = json!({"x": 0, "y": 0, "w": frame.0, "h": frame.1});
    let capture_result = compile(&doc, &capture);
    let mut flagged = whole.clone();
    flagged["gpuAnalyticRegions"] = json!(true);
    let flagged_error = compile(&doc, &flagged).err();
    let summarize = |scene: &Value| {
        let nodes = scene["nodes"].as_object().unwrap();
        json!({
            "nodes": nodes.len(),
            "wideImageGaussians": nodes.values().filter(|node| node.get("wideImageGaussian").is_some()).count(),
            "zoomBlurs": nodes.values().filter(|node| node["effects"].as_array().is_some_and(|effects| effects.iter().any(|effect| effect.get("zoomBlur").is_some()))).count(),
            "visibleGaussians": nodes.values().filter(|node| node["effects"].as_array().is_some_and(|effects| effects.iter().any(|effect| effect["kind"] == "gaussian-blur" && effect["visible"] != false))).count(),
        })
    };
    let mut small = exact.clone();
    small["width"] = json!(256);
    small["height"] = json!(256);
    let viewport = small["gpuViewport"].as_object_mut().unwrap();
    viewport["w"] = json!(256);
    viewport["h"] = json!(256);
    let tile_result = compile(&doc, &tile);
    let exact_result = compile(&doc, &exact);
    let small_result = compile(&doc, &small);
    let mut moved = doc.clone();
    moved
        .nodes
        .get_mut(&ellipse)
        .unwrap()
        .effects
        .iter_mut()
        .find(|effect| effect.zoom_blur.is_some())
        .unwrap()
        .zoom_blur
        .as_mut()
        .unwrap()
        .center = [0.2, 0.8];
    let moved_exact = compile(&moved, &exact);
    let moved_capture = compile(&moved, &capture);
    let mut guarded = doc.clone();
    let gaussian = doc
        .nodes
        .values()
        .find_map(|node| {
            node.effects
                .iter()
                .find(|effect| {
                    effect.visible && effect.kind == "gaussian-blur" && effect.radius > 9.
                })
                .cloned()
        })
        .expect("wide gaussian");
    guarded
        .nodes
        .get_mut(&ellipse)
        .unwrap()
        .effects
        .insert(0, gaussian);
    let guarded_error = compile(&guarded, &capture).expect_err("zoom-node gaussian stays rejected");
    eprintln!(
        "{}",
        serde_json::json!({
            "fixture": "testing/fixtures/user-regression-20261109/117.sketch",
            "ellipse": ellipse,
            "importedEffects": before,
            "documentJsonBytes": bytes,
            "center": [center.x, center.y],
            "zoom": zoom,
            "colorManaged": doc.color_management.is_some(),
            "schema": doc.schema_version,
            "validity": validity,
            "invalidNodes": invalid,
            "nodes": doc.nodes.len(),
            "wholeSceneError": whole_error,
            "largeCapture": capture_result.as_ref().map(summarize).map_err(|error| error.clone()),
            "flaggedWholeScene": flagged_error,
            "localTile": tile_result.as_ref().map(|scene| scene["nodes"].as_object().map(|nodes| nodes.len())).map_err(|error| error.clone()),
            "exactTile": exact_result.as_ref().map(|scene| {
                let projected = scene["nodes"].as_object().unwrap().values()
                    .filter(|node| node.get("wideImageGaussian").is_some()).count();
                json!({"nodes": scene["nodes"].as_object().unwrap().len(), "wideImageGaussians": projected})
            }).map_err(|error| error.clone()),
            "smallExact": small_result.as_ref().map(|_| "ok").map_err(|error| error.clone()),
            "movedExact": moved_exact.as_ref().map(|_| "ok").map_err(|error| error.clone()),
            "movedCapture": moved_capture.as_ref().map(|_| "ok").map_err(|error| error.clone()),
            "guardedZoomNode": guarded_error,
        })
    );
    assert_eq!(
        whole_error,
        "Zoom source filter halo exceeds 2048 device pixels"
    );
    assert_eq!(
        flagged_error.as_deref(),
        Some("Zoom source filter halo exceeds 2048 device pixels")
    );
    let capture_scene = capture_result.expect("analytic capture");
    assert_eq!(capture_scene["width"], frame.0);
    assert_eq!(capture_scene["height"], frame.1);
    let summary = summarize(&capture_scene);
    assert!(summary["wideImageGaussians"].as_u64().unwrap() >= 1);
    assert!(summary["zoomBlurs"].as_u64().unwrap() >= 1);
    assert!(summary["visibleGaussians"].as_u64().unwrap() >= 1);
    exact_result.expect("exact 514 tile");
    tile_result.expect("local 514 tile");
    small_result.expect("256 tile");
    moved_exact.expect("moved focus tile");
    moved_capture.expect("moved focus capture");
    assert!(
        guarded_error.contains("Zoom source filter halo exceeds 2048 device pixels"),
        "{guarded_error}"
    );
    assert!(bytes > 5_400_000, "full document json is {bytes} bytes");
}
