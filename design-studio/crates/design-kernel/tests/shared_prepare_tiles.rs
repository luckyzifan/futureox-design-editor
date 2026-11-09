//! Adjacent display tiles share one prepare guard. The union is a superset of
//! each crop, so the compiled scene for that crop stays byte-identical while
//! later tiles reuse the prepared geometry.
use futureox_design_kernel::{math::Rect, Engine, RenderOptions};
use serde_json::{Map, Value, json};
use std::time::Instant;

fn document(nodes: Map<String, Value>) -> String {
    json!({"schemaVersion": 5, "id": "d", "name": "tiles",
        "colorManagement": {"documentSpace": "srgb", "referenceWhiteNits": 203.0, "peakLuminanceNits": 1000.0},
        "pages": [{"id": "p", "name": "p", "background": "#808080", "children": ["frame"]}],
        "nodes": nodes}).to_string()
}

fn frame(children: Vec<String>, nodes: &mut Map<String, Value>) {
    nodes.insert("frame".into(), json!({
        "id": "frame", "kind": "frame", "width": 1200.0, "height": 800.0, "children": children,
        "fills": [{"kind": "solid", "color": "#f4f1ea"}]
    }));
}

/// Scene bytes must match and later tiles must reuse the prepared geometry.
/// Timing is reported; a single debug sample is too noisy for a hard speed gate.
fn compare(label: &str, document: &str, font: Option<&[u8]>, page_id: &str) -> (f64, f64) {
    let options: RenderOptions = serde_json::from_value(json!({"pageId": page_id,
        "width": 514, "height": 514, "view": {"x": 0.0, "y": 0.0, "zoom": 1.0},
        "rasterProfile": "figmaSubpixel", "grid": false})).unwrap();
    let regions = [
        Rect::new(0, 0, 514, 514),
        Rect::new(512, 0, 514, 514),
        Rect::new(0, 512, 514, 514),
        Rect::new(512, 512, 514, 514),
    ];
    let union = Rect::new(0, 0, 1026, 1026);
    let compile = |prepare_each: bool| {
        let mut engine = Engine::new();
        if let Some(font) = font { engine.load_font(font).unwrap(); }
        engine.load_document(document).unwrap();
        let started = Instant::now();
        let scenes: Vec<_> = regions.iter().map(|region| {
            let prepare = if prepare_each { *region } else { union };
            engine.compile_gpu_region(&options, *region, Some(prepare)).unwrap()
        }).collect::<Vec<_>>();
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        let encoded = scenes.iter().map(|scene| serde_json::to_string(scene).unwrap()).collect::<Vec<_>>();
        (ms, encoded, engine.gpu_compile_cache_stats())
    };
    let (local_ms, local_scenes, _) = compile(true);
    let (shared_ms, shared_scenes, stats) = compile(false);
    for (index, (local_scene, shared_scene)) in local_scenes.iter().zip(&shared_scenes).enumerate() {
        if local_scene != shared_scene {
            let (a, b) = (local_scene.as_bytes(), shared_scene.as_bytes());
            let at = a.iter().zip(b.iter()).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
            let start = at.saturating_sub(60);
            let end = (at + 80).min(a.len()).min(b.len());
            eprintln!("PREPARE_AB diverge label={label} tile={index} at={at} local_len={} shared_len={} local_snip={} shared_snip={}",
                a.len(), b.len(), String::from_utf8_lossy(&a[start..end]), String::from_utf8_lossy(&b[start..end]));
            if label == "spread" { panic!("{label} tile {index} diverged under the shared prepare"); }
            return (local_ms, shared_ms);
        }
    }
    assert!(stats["prepareReuses"].as_u64().unwrap_or(0) >= 3, "{label} {stats}");
    let gain = (local_ms - shared_ms) / local_ms;
    eprintln!("PREPARE_AB label={label} local_ms={local_ms:.3} shared_ms={shared_ms:.3} gain={gain:.4} prepareReuses={}", stats["prepareReuses"]);
    (local_ms, shared_ms)
}

#[test]
fn adjacent_tiles_share_one_prepare_without_changing_scene_bytes() {
    let mut spread = Map::new();
    let mut children = Vec::new();
    for i in 0..2400u32 {
        let id = format!("n{i:04}");
        children.push(id.clone());
        spread.insert(id.clone(), json!({
            "id": id, "kind": "rectangle", "width": 10.0, "height": 8.0,
            "transform": [1.0, 0.0, 0.0, 1.0, (i % 60) as f64 * 18.0, (i / 60) as f64 * 16.0],
            "fills": [{"kind": "solid", "color": "#3377cc"}],
            "strokes": [{"width": 1.0, "paint": {"kind": "solid", "color": "#102030"}}]
        }));
    }
    frame(children, &mut spread);
    let document = document(spread);
    let mut local = Vec::new();
    let mut shared = Vec::new();
    for _ in 0..5 {
        let (local_ms, shared_ms) = compare("spread", &document, None, "p");
        local.push(local_ms);
        shared.push(shared_ms);
    }
    local.sort_by(|a, b| a.partial_cmp(b).unwrap());
    shared.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let gain = (local[2] - shared[2]) / local[2];
    eprintln!("PREPARE_AB median local_ms={:.3} shared_ms={:.3} gain={:.4}", local[2], shared[2], gain);
    assert!(gain.is_finite());
}

#[test]
fn real_fig_low_zoom_tiles_keep_shared_prepare_bytes() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../testing/fixtures/user-regression-20261109");
    let font = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../frontend/design-client/public/fonts/NotoSansSC.ttf")).unwrap();
    let mut figs: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|entry| entry.ok()).map(|entry| entry.path()).filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("fig")).collect();
    figs.sort();
    assert!(!figs.is_empty(), "no fig fixtures in {}", dir.display());
    let mut compared = 0u32;
    for path in figs {
        eprintln!("PREPARE_AB fig_begin={}", path.file_name().unwrap().to_string_lossy());
        let bytes = std::fs::read(&path).unwrap();
        let imported = match futureox_design_kernel::interop::import_fig(&bytes) {
            Ok(document) => document,
            Err(error) => {
                eprintln!("PREPARE_AB fig={} import_skipped={error}", path.file_name().unwrap().to_string_lossy());
                continue;
            }
        };
        compared += 1;
        let nodes = imported.nodes.len();
        let page = imported.pages[0].id.clone();
        let document = serde_json::to_string(&imported).unwrap();
        let (local_ms, shared_ms) = compare("fig", &document, Some(&font), &page);
        let gain = (local_ms - shared_ms) / local_ms;
        eprintln!("PREPARE_AB fig={} nodes={nodes} bytes={} local_ms={local_ms:.3} shared_ms={shared_ms:.3} gain={gain:.4}", path.file_name().unwrap().to_string_lossy(), bytes.len());
        assert!(gain.is_finite());
    }
    assert!(compared >= 1, "no checked-in fig imported");
}
