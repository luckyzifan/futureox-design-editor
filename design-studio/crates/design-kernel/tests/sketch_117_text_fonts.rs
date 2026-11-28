//! Issue #1263. Text-frame residual of the 117 fixture against a native
//! `sketchtool` 1x export. The native PNG is not committed, so this is an
//! ignored measurement: point `SKETCH_117_NATIVE_PNG` at the artifact and run
//! with `--ignored --nocapture`.
use futureox_design_kernel::scene::Document;
use futureox_design_kernel::{interop, Engine};
use serde_json::{json, Value};

const FIXTURE: &str = "../../../testing/fixtures/user-regression-20261109/117.sketch";
const FONT: &[u8] =
    include_bytes!("../../../../frontend/design-client/public/fonts/NotoSansSC.ttf");

fn artboard_117(document: &Document) -> (String, [f64; 6], f64, f64) {
    for page in &document.pages {
        for id in &page.children {
            let node = &document.nodes[id];
            if node.kind == "frame" && node.name == "117" {
                return (page.id.clone(), node.transform.0, node.width, node.height);
            }
        }
    }
    panic!("117 artboard");
}

fn compose(parent: [f64; 6], local: [f64; 6]) -> [f64; 6] {
    [
        parent[0] * local[0] + parent[2] * local[1],
        parent[1] * local[0] + parent[3] * local[1],
        parent[0] * local[2] + parent[2] * local[3],
        parent[1] * local[2] + parent[3] * local[3],
        parent[0] * local[4] + parent[2] * local[5] + parent[4],
        parent[1] * local[4] + parent[3] * local[5] + parent[5],
    ]
}

fn source_family(document: &Document, node: &futureox_design_kernel::scene::Node) -> String {
    let raw = node.bindings.get("sketchSourceFonts").map(String::as_str).or_else(|| {
        document
            .design_system
            .as_ref()?
            .sketch_containers
            .get("nodeMetadata")?
            .get(&node.id)?
            .get("bindings")?
            .get("sketchSourceFonts")?
            .as_str()
    });
    let Some(raw) = raw else {
        return "default".into();
    };
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return "default".into();
    };
    value
        .get("style")
        .and_then(Value::as_str)
        .unwrap_or("default")
        .to_owned()
}

fn text_frames(
    document: &Document,
    id: &str,
    parent: [f64; 6],
    view: (f64, f64),
    out: &mut Vec<(i64, i64, i64, i64, String)>,
) {
    let node = &document.nodes[id];
    if !node.visible {
        return;
    }
    let world = compose(parent, node.transform.0);
    let (x, y) = (world[4] - view.0, world[5] - view.1);
    if node.kind == "text" {
        out.push((
            x.floor() as i64,
            y.floor() as i64,
            (x + node.width).ceil() as i64,
            (y + node.height).ceil() as i64,
            source_family(document, node),
        ));
    }
    for child in node.render_children() {
        text_frames(document, child, world, view, out);
    }
}

struct Metrics {
    frames: usize,
    area: usize,
    differ: u64,
    mean: f64,
    over16: usize,
    over64: usize,
    max: u8,
    sum: usize,
}

fn measure(
    actual: &[u8],
    native: &[u8],
    frames: &[(i64, i64, i64, i64, String)],
    w: u32,
    h: u32,
    only: Option<&str>,
) -> Metrics {
    let rows = h as usize;
    let cols = w as usize;
    // One entry per frame pixel: the issue counts every text frame's area, so
    // overlapping frames are counted once per frame, not once per device pixel.
    let mut covers = vec![0u32; rows * cols];
    let mut metrics = Metrics {
        frames: 0,
        area: 0,
        differ: 0,
        mean: 0.,
        over16: 0,
        over64: 0,
        max: 0,
        sum: 0,
    };
    for (x0, y0, x1, y1, family) in frames {
        if only.is_some_and(|name| name != family) {
            continue;
        }
        metrics.frames += 1;
        metrics.sum += ((x1 - x0).max(0) * (y1 - y0).max(0)) as usize;
        for y in (*y0).max(0)..(*y1).min(rows as i64) {
            for x in (*x0).max(0)..(*x1).min(cols as i64) {
                covers[y as usize * cols + x as usize] += 1;
            }
        }
    }
    let mut sum = 0f64;
    for index in 0..rows * cols {
        let count = covers[index];
        if count == 0 {
            continue;
        }
        metrics.area += count as usize;
        let i = index * 4;
        let delta = (0..4)
            .map(|c| actual[i + c].abs_diff(native[i + c]))
            .max()
            .unwrap();
        metrics.differ += u64::from(delta > 0) * u64::from(count);
        sum += f64::from(delta) * f64::from(count);
        metrics.over16 += usize::from(delta > 16) * count as usize;
        metrics.over64 += usize::from(delta > 64) * count as usize;
        metrics.max = metrics.max.max(delta);
    }
    metrics.mean = sum / metrics.area.max(1) as f64;
    metrics
}

fn print_metrics(name: &str, m: &Metrics) {
    println!(
        "MEASURE {name} frames={} frameSum={} frameArea={} >0={} mean={:.3} >16={} ({:.2}%) >64={} max={}",
        m.frames,
        m.sum,
        m.area,
        m.differ,
        m.mean,
        m.over16,
        m.over16 as f64 * 100. / m.area.max(1) as f64,
        m.over64,
        m.max
    );
}

fn report(
    name: &str,
    actual: &[u8],
    native: &[u8],
    frames: &[(i64, i64, i64, i64, String)],
    w: u32,
    h: u32,
) {
    print_metrics(name, &measure(actual, native, frames, w, h, None));
    for family in [
        "DINPro-Medium",
        "DINPro-Regular",
        "Alibaba PuHuiTi-Medium",
        "Alibaba PuHuiTi-Bold",
        "Alibaba PuHuiTi-Regular",
        "YouSheBiaoTiHei",
        "Barlow-Medium",
    ] {
        print_metrics(
            &format!("{name}/{family}"),
            &measure(actual, native, frames, w, h, Some(family)),
        );
    }
}

fn render(document: &Document, page: &str, width: f64, height: f64, view: (f64, f64)) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_font(FONT).unwrap();
    engine
        .load_document(&serde_json::to_string(document).unwrap())
        .unwrap();
    let options = engine
        .parse_options(json!({
            "pageId": page,
            "width": width as u32,
            "height": height as u32,
            "view": {"x": view.0, "y": view.1, "zoom": 1},
            "transparent": false,
            "grid": false,
            "rasterProfile": "analytic",
        }))
        .unwrap();
    engine.render(&options).unwrap()
}

#[test]
#[ignore = "requires SKETCH_117_NATIVE_PNG from sketchtool"]
fn text_frames_against_the_native_117_export() {
    let native_path = std::env::var("SKETCH_117_NATIVE_PNG").expect("native PNG");
    let native = image::open(native_path).unwrap().into_rgba8();
    let (w, h) = native.dimensions();
    let bytes = std::fs::read(FIXTURE).unwrap();
    let report_value = interop::import_sketch_report(&bytes).unwrap();
    let document = report_value.document;
    let (page_id, transform, aw, ah) = artboard_117(&document);
    assert_eq!((w, h), (aw as u32, ah as u32));
    let view = (-transform[4], -transform[5]);
    let mut frames = Vec::new();
    for child in &document.pages.iter().find(|p| p.id == page_id).unwrap().children {
        text_frames(&document, child, [1., 0., 0., 1., 0., 0.], view, &mut frames);
    }
    let actual = render(&document, &page_id, aw, ah, view);
    report("default", &actual, native.as_raw(), &frames, w, h);

    let mut fallback = document.clone();
    let bytes_inter = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../frontend/design-client/public/fonts/inter/v3.19/Inter.ttf"
    ))
    .unwrap();
    use base64::Engine as _;
    let id = "inter-fallback-0".to_owned();
    fallback.fonts.insert(
        id.clone(),
        futureox_design_kernel::font::FontResource {
            family: "Inter".into(),
            data: base64::engine::general_purpose::STANDARD.encode(&bytes_inter).into(),
            index: 0,
            postscript: Some("Inter-Regular".into()),
        },
    );
    let latin = ["DINPro", "Barlow"];
    let ids: Vec<String> = fallback
        .nodes
        .values()
        .filter(|node| node.kind == "text")
        .filter(|node| {
            let family = source_family(&fallback, node);
            latin.iter().any(|name| family.starts_with(name))
        })
        .map(|node| node.id.clone())
        .collect();
    for node_id in ids {
        if let Some(style) = fallback.nodes.get_mut(&node_id).unwrap().text_style.as_mut() {
            style.font_id = id.clone();
        }
    }
    let actual = render(&fallback, &page_id, aw, ah, view);
    report("inter", &actual, native.as_raw(), &frames, w, h);
}