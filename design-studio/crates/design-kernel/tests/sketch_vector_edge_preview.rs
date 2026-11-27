//! Issue #891. Pure-colour vector edges on the archived 1x previews of two
//! public Sketch archives. The reference is `previews/preview.png` inside the
//! archive (Sketch's own 1x raster), not this renderer.
//!
//! Measured on 2026-11-28, `origin/main` daf00d556, analytic profile, zoom 1,
//! viewport aligned to the visible content bounds, opaque white page
//! background, no grid:
//!
//!   Emergency icons.sketch, union of the six groups at (141, 682), 63x58
//!     159 of 3654 pixels differ (4.35%), 3 above 16 codes, max 20.
//!     Worst (43,27) current [231,128,92,255] native [232,143,112,255].
//!   [Legacy] WFP Icons.sketch, blue icons in (360,115)-(440,195) of the
//!   500x300 page: 63 differ, none above 16 codes, max 15.
//!
//! Attribution measured with the analytic area band count as the only
//! variable (2/8/16/32 bands): the 63x58 table moves 164->159->159->160
//! differing pixels and 21->3->3->3 above 16 codes, but the three worst
//! pixels keep the same current/native pairs at every count. Vertical
//! coverage resolution is therefore not what separates them; they stay
//! reproducible here until that composite is attributed.
//!
//! The page text on the WFP board uses OpenSans, which is not loaded here, so
//! every text pixel is excluded by the region. #177 shadows, #473 gradients,
//! the missing camp archive, Mac Sketch, Metal and WebGPU are NOT_RUN.
use futureox_design_kernel::{interop, Engine, RenderOptions};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;

const EMERGENCY: &str =
    "../../../testing/fixtures/sketch-public-20261105/ui-design-kit/Emergency icons.sketch";
const WFP: &str =
    "../../../testing/fixtures/sketch-public-20261105/ui-design-kit/[Legacy] WFP Icons.sketch";
const EMERGENCY_PREVIEW_SHA256: &str =
    "367aee4ebb9dca0d081bbe97ce4f74dd33ddf68fb81800cfdb7f30915260543a";
const WFP_PREVIEW_SHA256: &str = "4e800ba19c706ae8867cb039f9fc0d6e8beef5945be4a3e68a1b28b1c9405795";
const FONT: &[u8] =
    include_bytes!("../../../../frontend/design-client/public/fonts/NotoSansSC.ttf");

fn preview(bytes: &[u8]) -> image::RgbaImage {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut file = archive.by_name("previews/preview.png").unwrap();
    let mut png = Vec::new();
    file.read_to_end(&mut png).unwrap();
    let digest = Sha256::digest(&png);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    assert!(
        hex == EMERGENCY_PREVIEW_SHA256 || hex == WFP_PREVIEW_SHA256,
        "archive preview changed: {hex}"
    );
    image::load_from_memory(&png).unwrap().into_rgba8()
}

fn world_rect(node: &Value, parent: [f64; 6]) -> (f64, f64, f64, f64) {
    let compose = |m: &Value| {
        m["transform"].as_array().map(|t| {
            let v: Vec<f64> = t.iter().map(|x| x.as_f64().unwrap()).collect();
            [v[0], v[1], v[2], v[3], v[4], v[5]]
        })
    };
    let local = compose(node).unwrap_or([1., 0., 0., 1., 0., 0.]);
    let t = [
        parent[0] * local[0] + parent[2] * local[1],
        parent[1] * local[0] + parent[3] * local[1],
        parent[0] * local[2] + parent[2] * local[3],
        parent[1] * local[2] + parent[3] * local[3],
        parent[0] * local[4] + parent[2] * local[5] + parent[4],
        parent[1] * local[4] + parent[3] * local[5] + parent[5],
    ];
    let w = node["width"].as_f64().unwrap_or(0.);
    let h = node["height"].as_f64().unwrap_or(0.);
    let mut rect = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for (x, y) in [(0., 0.), (w, 0.), (0., h), (w, h)] {
        let px = t[0] * x + t[2] * y + t[4];
        let py = t[1] * x + t[3] * y + t[5];
        rect.0 = rect.0.min(px);
        rect.1 = rect.1.min(py);
        rect.2 = rect.2.max(px);
        rect.3 = rect.3.max(py);
    }
    rect
}

fn bounds(
    nodes: &serde_json::Map<String, Value>,
    id: &str,
    parent: [f64; 6],
    acc: &mut (f64, f64, f64, f64),
) {
    let Some(node) = nodes.get(id) else { return };
    if node["visible"].as_bool() == Some(false) {
        return;
    }
    let rect = world_rect(node, parent);
    acc.0 = acc.0.min(rect.0);
    acc.1 = acc.1.min(rect.1);
    acc.2 = acc.2.max(rect.2);
    acc.3 = acc.3.max(rect.3);
    let m = node["transform"]
        .as_array()
        .map(|t| {
            let v: Vec<f64> = t.iter().map(|x| x.as_f64().unwrap()).collect();
            [v[0], v[1], v[2], v[3], v[4], v[5]]
        })
        .unwrap_or([1., 0., 0., 1., 0., 0.]);
    let composed = [
        parent[0] * m[0] + parent[2] * m[1],
        parent[1] * m[0] + parent[3] * m[1],
        parent[0] * m[2] + parent[2] * m[3],
        parent[1] * m[2] + parent[3] * m[3],
        parent[0] * m[4] + parent[2] * m[5] + parent[4],
        parent[1] * m[4] + parent[3] * m[5] + parent[5],
    ];
    for child in node["children"].as_array().into_iter().flatten() {
        if let Some(child) = child.as_str() {
            bounds(nodes, child, composed, acc);
        }
    }
}

struct Table {
    differ: usize,
    over16: usize,
    max: u8,
    worst: Vec<(u32, u32, [u8; 4], [u8; 4])>,
}

fn compare(bytes: &[u8], region: Option<(u32, u32, u32, u32)>) -> Table {
    let report = interop::import_sketch_report(bytes).unwrap();
    let document = serde_json::to_value(&report.document).unwrap();
    let page_id = document["pages"][0]["id"].as_str().unwrap().to_owned();
    let nodes = document["nodes"].as_object().unwrap();
    let mut acc = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for child in document["pages"][0]["children"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if let Some(child) = child.as_str() {
            bounds(nodes, child, [1., 0., 0., 1., 0., 0.], &mut acc);
        }
    }
    let native = preview(bytes);
    let (w, h) = (native.width(), native.height());
    let options: RenderOptions = serde_json::from_value(serde_json::json!({
        "pageId": page_id,
        "width": w,
        "height": h,
        "view": {"x": -acc.0, "y": -acc.1, "zoom": 1.0},
        "transparent": false,
        "grid": false,
        "rasterProfile": "analytic",
    }))
    .unwrap();
    let mut engine = Engine::new();
    engine.load_font(FONT).unwrap();
    engine.load_document(&document.to_string()).unwrap();
    let actual = engine.render(&options).unwrap();
    let mut table = Table {
        differ: 0,
        over16: 0,
        max: 0,
        worst: Vec::new(),
    };
    for y in 0..h {
        for x in 0..w {
            if region.is_some_and(|r| x < r.0 || y < r.1 || x >= r.2 || y >= r.3) {
                continue;
            }
            let i = ((y * w + x) * 4) as usize;
            let current: [u8; 4] = actual[i..i + 4].try_into().unwrap();
            let reference: [u8; 4] = native.as_raw()[i..i + 4].try_into().unwrap();
            let delta = (0..4)
                .map(|c| current[c].abs_diff(reference[c]))
                .max()
                .unwrap();
            if delta == 0 {
                continue;
            }
            table.differ += 1;
            table.max = table.max.max(delta);
            if delta > 16 {
                table.over16 += 1;
            }
            table.worst.push((x, y, current, reference));
        }
    }
    table
        .worst
        .sort_by_key(|w| std::cmp::Reverse((0..4).map(|c| w.2[c].abs_diff(w.3[c])).max().unwrap()));
    table.worst.truncate(4);
    table
}

#[test]
fn emergency_icons_vector_edges_match_the_archived_preview_table() {
    let bytes = std::fs::read(EMERGENCY).unwrap();
    let table = compare(&bytes, None);
    println!(
        "MEASURE emergency differ={} over16={} max={} worst={:?}",
        table.differ, table.over16, table.max, table.worst
    );
    assert_eq!(table.differ, 159, "differing pixels moved");
    assert_eq!(table.over16, 3, "pixels above 16 codes moved");
    assert_eq!(table.max, 20, "max channel delta moved");
    assert_eq!(
        table.worst[0],
        (43, 27, [231, 128, 92, 255], [232, 143, 112, 255])
    );
}

#[test]
fn wfp_blue_icon_edges_match_the_archived_preview_table() {
    let bytes = std::fs::read(WFP).unwrap();
    let table = compare(&bytes, Some((360, 115, 440, 195)));
    println!(
        "MEASURE wfp differ={} over16={} max={} worst={:?}",
        table.differ, table.over16, table.max, table.worst
    );
    assert_eq!(table.differ, 63, "differing pixels moved");
    assert_eq!(table.over16, 0, "a blue icon pixel crossed 16 codes");
    assert_eq!(table.max, 15, "max channel delta moved");
}
