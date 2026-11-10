//! A wider prepare window retains flattened geometry for the whole request.
//! `flatten_for_fill` turns curves outside that window into chords, so the
//! published node rect can change. Tile 0 of `01有料素材 (Copy).fig` moved
//! `fig-0-8200` from `{x:427,y:131,w:87,h:195}` to `{x:427,y:90,w:87,h:236}`
//! while the transform origin stayed `(433, 97)`. Emission must match the
//! per-tile guard. The low-zoom local window stays the display default.
use futureox_design_kernel::{Engine, RenderOptions, math::Rect};
use serde_json::{Map, Value, json};

fn document(nodes: Map<String, Value>) -> String {
    json!({"schemaVersion": 5, "id": "d", "name": "tiles",
        "colorManagement": {"documentSpace": "srgb", "referenceWhiteNits": 203.0, "peakLuminanceNits": 1000.0},
        "pages": [{"id": "p", "name": "p", "background": "#808080", "children": ["frame"]}],
        "nodes": nodes}).to_string()
}

fn frame(children: Vec<String>, nodes: &mut Map<String, Value>) {
    nodes.insert(
        "frame".into(),
        json!({
            "id": "frame", "kind": "frame", "width": 1200.0, "height": 800.0, "children": children,
            "fills": [{"kind": "solid", "color": "#f4f1ea"}]
        }),
    );
}

fn scenes(document: &str, font: Option<&[u8]>, page_id: &str, prepare_each: bool) -> Vec<String> {
    let options: RenderOptions = serde_json::from_value(json!({"pageId": page_id,
        "width": 514, "height": 514, "view": {"x": 0.0, "y": 0.0, "zoom": 1.0},
        "rasterProfile": "figmaSubpixel", "grid": false}))
    .unwrap();
    let regions = [
        Rect::new(0, 0, 514, 514),
        Rect::new(512, 0, 514, 514),
        Rect::new(0, 512, 514, 514),
        Rect::new(512, 512, 514, 514),
    ];
    let union = Rect::new(0, 0, 1026, 1026);
    let mut engine = Engine::new();
    if let Some(font) = font {
        engine.load_font(font).unwrap();
    }
    engine.load_document(document).unwrap();
    regions
        .iter()
        .map(|region| {
            let prepare = if prepare_each { *region } else { union };
            serde_json::to_string(
                &engine
                    .compile_gpu_region(&options, *region, Some(prepare))
                    .unwrap(),
            )
            .unwrap()
        })
        .collect()
}

fn assert_same_scenes(label: &str, document: &str, font: Option<&[u8]>, page_id: &str) {
    let local = scenes(document, font, page_id, true);
    let shared = scenes(document, font, page_id, false);
    for (index, (local_scene, shared_scene)) in local.iter().zip(&shared).enumerate() {
        if local_scene == shared_scene {
            continue;
        }
        let (a, b) = (local_scene.as_bytes(), shared_scene.as_bytes());
        let at = a
            .iter()
            .zip(b.iter())
            .position(|(x, y)| x != y)
            .unwrap_or(a.len().min(b.len()));
        let start = at.saturating_sub(80);
        let end = (at + 120).min(a.len()).min(b.len());
        panic!(
            "PREPARE_AB diverge label={label} tile={index} at={at} local={} shared={}",
            String::from_utf8_lossy(&a[start..end]),
            String::from_utf8_lossy(&b[start..end])
        );
    }
}

#[test]
fn adjacent_tiles_share_prepare_without_changing_scene_bytes() {
    let mut spread = Map::new();
    let mut children = Vec::new();
    for i in 0..2400u32 {
        let id = format!("n{i:04}");
        children.push(id.clone());
        spread.insert(
            id.clone(),
            json!({
                "id": id, "kind": "rectangle", "width": 10.0, "height": 8.0,
                "transform": [1.0, 0.0, 0.0, 1.0, (i % 60) as f64 * 18.0, (i / 60) as f64 * 16.0],
                "fills": [{"kind": "solid", "color": "#3377cc"}],
                "strokes": [{"width": 1.0, "paint": {"kind": "solid", "color": "#102030"}}]
            }),
        );
    }
    frame(children, &mut spread);
    assert_same_scenes("spread", &document(spread), None, "p");
}

#[test]
fn smoothed_corner_crossing_the_tile_keeps_per_tile_scene_bytes() {
    let mut nodes = Map::new();
    frame(vec!["round".into()], &mut nodes);
    nodes.insert(
        "round".into(),
        json!({
            "id": "round", "kind": "rectangle", "width": 180.0, "height": 140.0,
            "transform": [1.0, 0.0, 0.0, 1.0, 420.0, 460.0],
            "radii": [48.0, 48.0, 48.0, 48.0], "smoothing": 0.6,
            "fills": [{"kind": "solid", "color": "#3377cc"}]
        }),
    );
    assert_same_scenes("smooth", &document(nodes), None, "p");
}

#[test]
fn real_fig_shared_prepare_keeps_per_tile_scene_bytes() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let font =
        std::fs::read(root.join("frontend/design-client/public/fonts/NotoSansSC.ttf")).unwrap();
    for name in ["01有料素材.fig", "01有料素材 (Copy).fig"] {
        let path = root
            .join("testing/fixtures/user-regression-20261109")
            .join(name);
        let bytes = std::fs::read(&path).unwrap();
        let imported = futureox_design_kernel::interop::import_fig(&bytes).unwrap();
        let page = imported.pages[0].id.clone();
        let document = serde_json::to_string(&imported).unwrap();
        assert_same_scenes(name, &document, Some(&font), &page);
    }
}
