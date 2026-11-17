//! CPU timing of the banded zoom-focus settle already on main.
//!
//! This is the 15060% × DPR 2 capture the canvas worker compiles after a
//! Zoom Blur focus release: horizontal bands sharing one prepare window.
//! It does not capture one viewport, and it does not time GPU completion
//! or screen presentation. `117.sketch` must be the real zip, not an LFS pointer.
use futureox_design_kernel::math::{Point, Transform};
use futureox_design_kernel::scene::Document;
use futureox_design_kernel::zoom_blur::{self, ZoomBlur};
use futureox_design_kernel::{editing::DocumentPatch, Engine};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Instant;

const ZOOM: f64 = 301.2;
const BAND_PIXELS: u64 = 1_750_000;
const SINGLE_LIMIT: u64 = 524_288;

struct Layout {
    name: &'static str,
    width: u32,
    height: u32,
}

const LAYOUTS: [Layout; 2] = [
    Layout { name: "sketch", width: 1938, height: 1816 },
    Layout { name: "figma", width: 1936, height: 1844 },
];

fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn bands(width: u32, height: u32) -> Vec<(i32, i32, u32, u32)> {
    let pixels = u64::from(width) * u64::from(height);
    if pixels <= SINGLE_LIMIT {
        return vec![(0, 0, width, height)];
    }
    let rows = (pixels + BAND_PIXELS - 1) / BAND_PIXELS;
    let cell = (u64::from(height) + rows - 1) / rows;
    let mut out = Vec::new();
    let mut y = 0u32;
    while y < height {
        let h = cell.min(u64::from(height - y)) as u32;
        out.push((0, y as i32, width, h));
        y += h;
    }
    out
}

fn parent_of(doc: &Document) -> HashMap<String, String> {
    let mut parents = HashMap::new();
    for (id, node) in &doc.nodes {
        for child in &node.children {
            parents.insert(child.clone(), id.clone());
        }
    }
    parents
}

fn world_matrix(doc: &Document, id: &str, parents: &HashMap<String, String>) -> Transform {
    let mut chain = vec![id.to_owned()];
    while let Some(parent) = parents.get(chain.last().unwrap()) {
        chain.push(parent.clone());
    }
    chain.reverse();
    let mut matrix = Transform([1., 0., 0., 1., 0., 0.]);
    for id in chain {
        matrix = matrix.concat(doc.nodes[&id].transform);
    }
    matrix
}

fn request(page: &str, width: u32, height: u32, view_x: f64, view_y: f64, band: (i32, i32, u32, u32), prepare: (u32, u32)) -> String {
    json!({
        "pageId": page,
        "width": width,
        "height": height,
        "view": { "x": view_x, "y": view_y, "zoom": ZOOM },
        "transparent": false,
        "grid": false,
        "checkerboard": false,
        "rasterProfile": "analytic",
        "gpuPageBackground": true,
        "gpuAnalyticRegions": true,
        "captureViewport": { "x": band.0, "y": band.1, "w": band.2, "h": band.3 },
        "prepareViewport": { "x": 0, "y": 0, "w": prepare.0, "h": prepare.1 },
    })
    .to_string()
}

fn stat_u64(stats: &Value, path: &[&str]) -> u64 {
    let mut cursor = stats;
    for key in path {
        cursor = match cursor.get(*key) {
            Some(value) => value,
            None => return 0,
        };
    }
    cursor.as_u64().unwrap_or(0)
}

fn compile_bands(engine: &mut Engine, page: &str, layout: &Layout, view_x: f64, view_y: f64) -> Value {
    let regions = bands(layout.width, layout.height);
    let mut bands_out = Vec::new();
    let mut total = 0.0;
    for (index, band) in regions.iter().copied().enumerate() {
        let before = engine.gpu_compile_cache_stats();
        let started = Instant::now();
        let scene = engine
            .compile_gpu_request(&request(page, layout.width, layout.height, view_x, view_y, band, (layout.width, layout.height)))
            .unwrap_or_else(|error| panic!("{layout} band {index} failed: {error}", layout = layout.name));
        let elapsed = ms(started);
        total += elapsed;
        let after = engine.gpu_compile_cache_stats();
        let node = scene.nodes.values().find(|node| {
            node.effects.iter().any(|effect| effect.kind == "zoom-blur" && effect.visible)
        });
        let mut table_ms = 0.0;
        let mut table_bytes = 0usize;
        if let Some(node) = node {
            if let Some(effect) = node.effects.iter().find(|effect| effect.kind == "zoom-blur") {
                if let Some(zoom) = effect.zoom_blur {
                    let started = Instant::now();
                    let table = zoom_blur::coordinates(zoom, node.matrix, node.size, node.rect).expect("coordinate table");
                    table_ms = ms(started);
                    table_bytes = table.len() * 4;
                }
            }
        }
        bands_out.push(json!({
            "index": index,
            "x": band.0,
            "y": band.1,
            "w": band.2,
            "h": band.3,
            "pixels": u64::from(band.2) * u64::from(band.3),
            "compileMs": elapsed,
            "sceneNodes": scene.nodes.len(),
            "zoomRect": node.map(|node| json!({"x": node.rect.x, "y": node.rect.y, "w": node.rect.w, "h": node.rect.h, "pixels": node.rect.pixels()})),
            "coordinateTableMs": table_ms,
            "coordinateTableBytes": table_bytes,
            "programBuilds": stat_u64(&after, &["builds"]).saturating_sub(stat_u64(&before, &["builds"])),
            "programHits": stat_u64(&after, &["hits"]).saturating_sub(stat_u64(&before, &["hits"])),
            "fragmentBuilds": stat_u64(&after, &["fragmentBuilds"]).saturating_sub(stat_u64(&before, &["fragmentBuilds"])),
            "fragmentHits": stat_u64(&after, &["fragmentHits"]).saturating_sub(stat_u64(&before, &["fragmentHits"])),
            "prepareReuses": stat_u64(&after, &["prepareReuses"]).saturating_sub(stat_u64(&before, &["prepareReuses"])),
            "cropHits": stat_u64(&after, &["cameraResidency", "cropHits"]).saturating_sub(stat_u64(&before, &["cameraResidency", "cropHits"])),
        }));
    }
    json!({ "totalCompileMs": total, "bands": bands_out })
}

fn set_center(doc: &mut Document, id: &str, center: [f64; 2]) {
    let node = doc.nodes.get_mut(id).unwrap();
    let effect = node.effects.iter_mut().find(|effect| effect.kind == "zoom-blur").unwrap();
    effect.zoom_blur = Some(ZoomBlur { amount: 10., center });
}

fn main() {
    if std::env::var("ZOOM_FOCUS_BANDED").ok().as_deref() != Some("1") {
        eprintln!("set ZOOM_FOCUS_BANDED=1");
        return;
    }
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../testing/fixtures/user-regression-20261109/117.sketch"
    );
    let bytes = std::fs::read(path).expect("117.sketch");
    assert!(!bytes.starts_with(b"version https://git-lfs.github.com"), "117.sketch is still an LFS pointer");
    assert_eq!(bytes.len(), 5_013_257, "unexpected 117.sketch size");
    let font = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
    ))
    .expect("font");
    let imported = Instant::now();
    let mut doc = futureox_design_kernel::interop::import_sketch_report(&bytes).expect("import").document;
    let import_ms = ms(imported);
    let id = doc
        .nodes
        .iter()
        .find(|(_, node)| node.name == "椭圆 66")
        .map(|(id, _)| id.clone())
        .expect("椭圆 66");
    let kind = doc.nodes[&id].kind.clone();
    let size = [doc.nodes[&id].width, doc.nodes[&id].height];
    let page = doc.pages.iter().find(|page| {
        let parents = parent_of(&doc);
        let mut cursor = Some(id.as_str());
        let roots: std::collections::HashSet<&str> = page.children.iter().map(String::as_str).collect();
        while let Some(current) = cursor {
            if roots.contains(current) {
                return true;
            }
            cursor = parents.get(current).map(String::as_str);
        }
        false
    }).map(|page| page.id.clone()).expect("page");
    let parents = parent_of(&doc);
    let world = world_matrix(&doc, &id, &parents);
    let center = world.point(Point::new(size[0] / 2., size[1] / 2.));
    let node = doc.nodes.get_mut(&id).unwrap();
    node.effects.retain(|effect| effect.kind != "zoom-blur");
    node.effects.push(serde_json::from_value(json!({
        "id": "zoom-focus",
        "kind": "zoom-blur",
        "visible": true,
        "radius": 0.0,
        "color": "#000000",
        "opacity": 1.0,
        "zoomBlur": { "amount": 10.0, "center": [0.5, 0.5] }
    })).unwrap());
    let css_zoom = ZOOM / 2.;
    let dx = 18. / css_zoom / size[0];
    let dy = 7. / css_zoom / size[1];
    let centers = [
        [0.5, 0.5],
        [0.5 + dx, 0.5 + dy],
        [0.5 - dx, 0.5 - dy],
        [0.5 + dx, 0.5 - dy],
        [0.5 - dx, 0.5 + dy],
        [0.5 + dx * 0.5, 0.5 + dy * 0.5],
        [0.53, 0.49],
    ];
    let mut report = json!({
        "scope": "CPU compile of the on-main banded settle plus the zoom coordinate table. Not GPU completion, Electron, Metal, or screen presentation.",
        "fixtureBytes": bytes.len(),
        "importMs": import_ms,
        "nodes": doc.nodes.len(),
        "target": { "id": id, "kind": kind, "width": size[0], "height": size[1], "worldCenter": [center.x, center.y], "page": page },
        "focusStep": { "cssPx": [18.0, 7.0], "centerDelta": [dx, dy] },
        "layouts": {}
    });
    for layout in LAYOUTS {
        let view_x = layout.width as f64 / 2. - center.x * ZOOM;
        let view_y = layout.height as f64 / 2. - center.y * ZOOM;
        let mut engine = Engine::new();
        engine.load_font(&font).unwrap();
        let mut current = doc.clone();
        set_center(&mut current, &id, centers[0]);
        engine.load_document(&serde_json::to_string(&current).unwrap()).unwrap();
        engine.load_font(&font).unwrap();
        let warmup = compile_bands(&mut engine, &page, &layout, view_x, view_y);
        let mut samples = Vec::new();
        for center in centers.iter().skip(1) {
            let mut next = current.clone();
            set_center(&mut next, &id, *center);
            let patch = DocumentPatch::between(&current, &next).expect("focus patch");
            let patch_started = Instant::now();
            let damage = engine.apply_document_patch_with_damage(&patch).expect("apply focus");
            let patch_ms = ms(patch_started);
            let compiled = compile_bands(&mut engine, &page, &layout, view_x, view_y);
            let mut fresh = Engine::new();
            fresh.load_font(&font).unwrap();
            fresh.load_document(&serde_json::to_string(&next).unwrap()).unwrap();
            fresh.load_font(&font).unwrap();
            let band = bands(layout.width, layout.height)[0];
            let expected = fresh
                .compile_gpu_request(&request(&page, layout.width, layout.height, view_x, view_y, band, (layout.width, layout.height)))
                .expect("fresh band");
            let actual = engine
                .compile_gpu_request(&request(&page, layout.width, layout.height, view_x, view_y, band, (layout.width, layout.height)))
                .expect("replay band");
            let actual_json = serde_json::to_value(&actual).unwrap();
            let expected_json = serde_json::to_value(&expected).unwrap();
            if actual_json != expected_json {
                let mut diffs = Vec::new();
                fn walk(path: String, left: &serde_json::Value, right: &serde_json::Value, diffs: &mut Vec<String>) {
                    if diffs.len() >= 12 || left == right { return; }
                    match (left, right) {
                        (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
                            let mut keys: Vec<_> = a.keys().chain(b.keys()).collect();
                            keys.sort();
                            keys.dedup();
                            for key in keys {
                                walk(format!("{path}.{key}"), a.get(key).unwrap_or(&serde_json::Value::Null), b.get(key).unwrap_or(&serde_json::Value::Null), diffs);
                            }
                        }
                        (serde_json::Value::Array(a), serde_json::Value::Array(b)) if a.len() == b.len() && a.len() < 8 => {
                            for (index, (left, right)) in a.iter().zip(b).enumerate() {
                                walk(format!("{path}[{index}]"), left, right, diffs);
                            }
                        }
                        _ => {
                            let preview = |value: &serde_json::Value| {
                                let text = value.to_string();
                                if text.len() > 180 { format!("{}…", &text[..180]) } else { text }
                            };
                            diffs.push(format!("{path} warm={} fresh={}", preview(left), preview(right)));
                        }
                    }
                }
                walk(String::new(), &actual_json, &expected_json, &mut diffs);
                panic!("{} focus {:?} band 0 diverged:\n{}", layout.name, center, diffs.join("\n"));
            }
            samples.push(json!({
                "center": center,
                "patchMs": patch_ms,
                "damageFull": damage.full,
                "damageReason": damage.reason,
                "compile": compiled,
            }));
            current = next;
        }
        let totals: Vec<f64> = samples.iter().map(|sample| sample["compile"]["totalCompileMs"].as_f64().unwrap()).collect();
        report["layouts"][layout.name] = json!({
            "width": layout.width,
            "height": layout.height,
            "view": [view_x, view_y, ZOOM],
            "bandCount": bands(layout.width, layout.height).len(),
            "warmup": warmup,
            "medianTotalCompileMs": median(totals.clone()),
            "samples": samples,
        });
    }
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}
