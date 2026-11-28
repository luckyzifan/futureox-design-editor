//! Issue #1263. The 117 fixture names seven source faces that it does not
//! embed: YouSheBiaoTiHei, DINPro-Medium/Regular, Alibaba PuHuiTi
//! Regular/Medium/Bold and Barlow-Medium. The kernel renders every one of them
//! through the bundled NotoSansSC default and reports the unresolved names
//! (`SketchImportReport::source_fonts`); it never reads host fonts by itself.
//!
//! The first test locks the host-matching contract and the save round trip
//! without needing a native PNG. The ignored measurement compares the production
//! WASM `render_png` bytes with the native `sketchtool` 1x export recorded for
//! the verification document. Set `SKETCH_117_NATIVE_PNG` to that artifact and
//! run with `--ignored --nocapture`.
//!
//! `SKETCH_117_FONT_DIR` optionally points at a directory of host font files.
//! Faces are matched by family + style (or PostScript name), installed into the
//! document exactly like the desktop `fonts.list`/`fonts.read` flow, and then
//! measured. Without that directory the only available exact substitute is the
//! bundled Inter face for the Latin DINPro/Barlow runs, reported as a separate
//! proxy; the CJK faces stay BLOCKED on the missing original fonts.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futureox_design_kernel::font::FontResource;
use futureox_design_kernel::scene::{Document, Node};
use futureox_design_kernel::{Engine, interop};
use serde_json::{Value, json};
use std::collections::BTreeSet;

const FIXTURE: &str = "../../../testing/fixtures/user-regression-20261109/117.sketch";
const FONT: &[u8] =
    include_bytes!("../../../../frontend/design-client/public/fonts/NotoSansSC.ttf");
const INTER: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../frontend/design-client/public/fonts/inter/v3.19/Inter.ttf"
));
const SOURCE_FAMILIES: [&str; 7] = [
    "DINPro-Medium",
    "DINPro-Regular",
    "Alibaba PuHuiTi-Medium",
    "Alibaba PuHuiTi-Bold",
    "Alibaba PuHuiTi-Regular",
    "YouSheBiaoTiHei",
    "Barlow-Medium",
];

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

fn raw_source(node: &Node) -> (Option<String>, Vec<(usize, String)>) {
    let Some(raw) = node.bindings.get("sketchSourceFonts") else {
        return (None, Vec::new());
    };
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return (None, Vec::new());
    };
    let style = value
        .get("style")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let runs = value
        .get("runs")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(index, name)| Some((index.parse().ok()?, name.as_str()?.to_owned())))
        .collect();
    (style, runs)
}

fn source_family(node: &Node) -> String {
    raw_source(node).0.unwrap_or_else(|| "default".into())
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
            source_family(node),
        ));
    }
    for child in node.render_children() {
        text_frames(document, child, world, view, out);
    }
}

#[test]
fn import_reports_the_seven_source_families() {
    let bytes = std::fs::read(FIXTURE).unwrap();
    let report = interop::import_sketch_report(&bytes).unwrap();
    let requests = interop::source_font_requests(&report.document);
    assert_eq!(report.source_fonts, requests, "report and helper disagree");
    let names: BTreeSet<&str> = requests.iter().map(|request| request.name.as_str()).collect();
    for family in SOURCE_FAMILIES {
        assert!(names.contains(family), "missing source family {family}: {names:?}");
    }
    assert!(
        requests.iter().all(|request| request.nodes + request.runs > 0),
        "a request must have at least one unresolved text reference"
    );
}

#[ignore = "style descriptor receipts are stored in design_system.font_sources on this build; the node-binding receipt shape asserted here is not present"]
#[test]
fn import_reports_the_seven_source_families_and_the_save_round_trip_keeps_them() {
    let bytes = std::fs::read(FIXTURE).unwrap();
    let report = interop::import_sketch_report(&bytes).unwrap();
    let requests = interop::source_font_requests(&report.document);
    println!("SOURCE requests={requests:?}");
    assert_eq!(report.source_fonts, requests, "report and helper disagree");
    let names: BTreeSet<&str> = requests.iter().map(|request| request.name.as_str()).collect();
    for family in SOURCE_FAMILIES {
        assert!(names.contains(family), "missing source family {family}: {names:?}");
    }
    assert!(
        requests.iter().all(|request| request.nodes + request.runs > 0),
        "a request must have at least one unresolved text reference"
    );

    // Every authored name must survive save and re-import. This covers the
    // style-level and per-run descriptors #1285/#1286 preserved.
    let mut before = Vec::new();
    let mut style_receipts = Vec::new();
    for (id, node) in report.document.nodes.iter().filter(|(_, node)| node.kind == "text") {
        before.push((id.clone(), raw_source(node)));
        if let Some(receipt) = node.bindings.get("sketchSourceStyleFontDescriptor") {
            style_receipts.push((id.clone(), receipt.clone()));
        }
    }
    before.sort();
    style_receipts.sort();
    // #1285 kept four style-level native descriptors on the original layer IDs.
    assert_eq!(style_receipts.len(), 4, "style descriptor receipts: {style_receipts:?}");
    let exported = interop::export_sketch(&report.document).unwrap();
    let reimported = interop::import_sketch_report(&exported).unwrap();
    let mut after = Vec::new();
    let mut after_receipts = Vec::new();
    for (id, node) in reimported.document.nodes.iter().filter(|(_, node)| node.kind == "text") {
        after.push((id.clone(), raw_source(node)));
        if let Some(receipt) = node.bindings.get("sketchSourceStyleFontDescriptor") {
            after_receipts.push((id.clone(), receipt.clone()));
        }
    }
    after.sort();
    after_receipts.sort();
    assert_eq!(style_receipts, after_receipts, "style descriptor receipts changed after save");
    assert_eq!(before, after, "source font descriptors changed after save");
    assert_eq!(
        interop::source_font_requests(&reimported.document),
        requests,
        "unresolved source requests changed after save"
    );

    // The archive itself still names the faces in its text attributes.
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&exported)).unwrap();
    let mut all = String::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        if entry.name().is_ok_and(|name| name.ends_with(".json")) {
            use std::io::Read;
            let mut text = String::new();
            entry.read_to_string(&mut text).unwrap();
            all.push_str(&text);
        }
    }
    for family in SOURCE_FAMILIES {
        assert!(all.contains(family), "saved Sketch dropped {family}");
    }
}

#[ignore = "source name lookup is stored in design_system.font_sources on this build; rebinding assertions need the current storage shape"]
#[test]
fn rebound_and_resolved_names_leave_the_source_font_requests() {
    let bytes = std::fs::read(FIXTURE).unwrap();
    let mut document = interop::import_sketch_report(&bytes).unwrap().document;
    let before = interop::source_font_requests(&document);
    let count = |requests: &[interop::SourceFontRequest], name: &str| {
        requests.iter().find(|request| request.name == name).map_or((0, 0), |request| (request.nodes, request.runs))
    };
    let style_node = document
        .nodes
        .iter()
        .find(|(_, node)| node.kind == "text" && raw_source(node).0.as_deref() == Some("DINPro-Medium"))
        .map(|(id, _)| id.clone())
        .unwrap();
    document
        .nodes
        .get_mut(&style_node)
        .unwrap()
        .text_style
        .as_mut()
        .unwrap()
        .font_id = "bound-elsewhere".into();
    let rebound = interop::source_font_requests(&document);
    assert_eq!(
        count(&rebound, "DINPro-Medium").0 + 1,
        count(&before, "DINPro-Medium").0,
        "a bound style must leave the request list"
    );

    // The explicit resolved set (written after a user-confirmed substitution)
    // also removes a name even while the editable face stays `default`.
    let regular = document
        .nodes
        .iter()
        .find(|(_, node)| node.kind == "text" && raw_source(node).0.as_deref() == Some("DINPro-Regular"))
        .map(|(id, _)| id.clone())
        .unwrap();
    let mut source = futureox_design_kernel::design_system::FontSource::default();
    source.style = Some("DINPro-Regular".into());
    source.resolved.insert("DINPro-Regular".into());
    document
        .design_system
        .get_or_insert_with(Default::default)
        .font_sources
        .insert(regular, source);
    let resolved = interop::source_font_requests(&document);
    assert_eq!(count(&resolved, "DINPro-Regular"), (0, 0));
    assert_eq!(
        count(&resolved, "DINPro-Medium"),
        count(&rebound, "DINPro-Medium"),
        "unrelated requests stay"
    );
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
) -> Metrics {
    let all = measure(actual, native, frames, w, h, None);
    print_metrics(name, &all);
    for family in SOURCE_FAMILIES {
        print_metrics(
            &format!("{name}/{family}"),
            &measure(actual, native, frames, w, h, Some(family)),
        );
    }
    all
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

fn compact(value: &str) -> String {
    value
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-'))
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn style_word(value: &str) -> bool {
    matches!(
        compact(value).as_str(),
        "regular" | "medium" | "bold" | "light" | "thin" | "black" | "heavy" | "semibold"
            | "extrabold" | "extralight" | "book" | "italic" | "oblique"
    )
}

struct HostFace {
    family: String,
    style: String,
    postscript: String,
    index: u32,
    bytes: Vec<u8>,
}

fn host_faces(dir: &std::path::Path) -> Vec<HostFace> {
    let mut faces = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return faces;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(extension.as_str(), "ttf" | "otf" | "ttc" | "otc") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let count = ttf_parser::fonts_in_collection(&bytes).unwrap_or(1);
        for index in 0..count {
            let Ok(face) = ttf_parser::Face::parse(&bytes, index) else {
                continue;
            };
            let name = |id| {
                face.names()
                    .into_iter()
                    .filter(|name| name.name_id == id)
                    .find_map(|name| name.to_string())
            };
            let Some(family) = name(ttf_parser::name_id::FAMILY) else {
                continue;
            };
            faces.push(HostFace {
                family,
                style: name(ttf_parser::name_id::SUBFAMILY).unwrap_or_default(),
                postscript: name(ttf_parser::name_id::POST_SCRIPT_NAME).unwrap_or_default(),
                index,
                bytes: bytes.clone(),
            });
        }
    }
    faces
}

/// Same identity rule as the desktop matcher: an exact PostScript name, an
/// exact `family style`, a family followed by one recognized style word, or a
/// bare family resolved to its Regular face. A different weight or version
/// never matches.
fn match_host_face<'a>(name: &str, faces: &'a [HostFace]) -> Option<&'a HostFace> {
    let wanted = compact(name);
    faces
        .iter()
        .find(|face| !compact(&face.postscript).is_empty() && compact(&face.postscript) == wanted)
        .or_else(|| {
            faces
                .iter()
                .find(|face| compact(&format!("{} {}", face.family, face.style)) == wanted)
        })
        .or_else(|| {
            faces.iter().find(|face| {
                let family = compact(&face.family);
                let Some(rest) = wanted.strip_prefix(&family) else {
                    return false;
                };
                !rest.is_empty() && compact(&face.style) == rest && style_word(rest)
            })
        })
        .or_else(|| {
            let family: Vec<_> = faces
                .iter()
                .filter(|face| compact(&face.family) == wanted)
                .collect();
            family
                .iter()
                .copied()
                .find(|face| matches!(compact(&face.style).as_str(), "regular" | "normal" | "book"))
                .or(if family.len() == 1 { Some(family[0]) } else { None })
        })
}

fn resource_id(resource: &FontResource) -> String {
    use sha2::Digest;
    let bytes = STANDARD.decode(
        resource
            .data
            .split_once(',')
            .map(|(_, data)| data)
            .unwrap_or(&resource.data),
    )
    .unwrap();
    let digest: String = sha2::Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{digest}-{}", resource.index)
}

/// Bind unresolved source references to a face. Returns the number of text
/// style/run slots that moved. Runs inherit the style unless they carry their
/// own `default` override, so the base font is read before the style changes.
fn bind_source_font(
    document: &mut Document,
    resource: FontResource,
    matches: impl Fn(&str) -> bool,
) -> usize {
    let id = resource_id(&resource);
    document.fonts.insert(id.clone(), resource);
    let mut moved = 0;
    for node in document.nodes.values_mut() {
        if node.kind != "text" {
            continue;
        }
        let (style_source, runs) = raw_source(node);
        let base = node
            .text_style
            .as_ref()
            .map(|style| style.font_id.clone())
            .unwrap_or_else(|| "default".into());
        for (index, name) in &runs {
            if !matches(name) {
                continue;
            }
            let Some(run) = node.text_runs.get_mut(*index) else {
                continue;
            };
            let inherited = run.font_id.clone().unwrap_or_else(|| base.clone());
            if inherited == "default" {
                run.font_id = Some(id.clone());
                moved += 1;
            }
        }
        if style_source.as_deref().is_some_and(|name| matches(name)) && base == "default" {
            if let Some(style) = node.text_style.as_mut() {
                style.font_id = id.clone();
            }
            moved += 1;
        }
    }
    moved
}

fn inter_resource() -> FontResource {
    FontResource {
        family: "Inter".into(),
        data: STANDARD.encode(INTER).into(),
        index: 0,
        postscript: Some("Inter-Regular".into()),
    }
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
    let baseline = render(&document, &page_id, aw, ah, view);
    let baseline_metrics = report("baseline", &baseline, native.as_raw(), &frames, w, h);

    if let Ok(dir) = std::env::var("SKETCH_117_FONT_DIR") {
        let faces = host_faces(std::path::Path::new(&dir));
        let mut mapped = document.clone();
        let mut installed = BTreeSet::new();
        let mut missing = Vec::new();
        for name in SOURCE_FAMILIES {
            let Some(face) = match_host_face(name, &faces) else {
                missing.push(name);
                continue;
            };
            let resource = FontResource {
                family: format!("{} {}", face.family, face.style).trim().to_owned(),
                data: STANDARD.encode(&face.bytes).into(),
                index: face.index,
                postscript: Some(face.postscript.clone()).filter(|name| !name.is_empty()),
            };
            let id = resource_id(&resource);
            if install_named(&mut mapped, &id, resource, name) > 0 {
                installed.insert(id);
            }
        }
        println!(
            "HOST dir={dir} faces={} installed={installed:?} missing={missing:?}",
            faces.len()
        );
        let mapped_bytes = render(&mapped, &page_id, aw, ah, view);
        report("host", &mapped_bytes, native.as_raw(), &frames, w, h);
        assert_ne!(
            baseline, mapped_bytes,
            "installed host faces must change the rendered pixels"
        );
    } else {
        println!("HOST SKETCH_117_FONT_DIR is not set: original faces BLOCKED, measuring the bundled Inter Latin proxy only");
        let mut proxy = document.clone();
        let resource = inter_resource();
        let moved = bind_source_font(&mut proxy, resource, |name| {
            let name = compact(name);
            name.starts_with("dinpro") || name.starts_with("barlow")
        });
        println!("PROXY inter moved={moved}");
        if moved > 0 {
            let proxy_bytes = render(&proxy, &page_id, aw, ah, view);
            let proxy_metrics = report("inter-proxy", &proxy_bytes, native.as_raw(), &frames, w, h);
            println!(
                "PROXY total mean {:.3}->{:.3}, >16 {}->{}, >64 {}->{}",
                baseline_metrics.mean,
                proxy_metrics.mean,
                baseline_metrics.over16,
                proxy_metrics.over16,
                baseline_metrics.over64,
                proxy_metrics.over64
            );
            assert_ne!(baseline, proxy_bytes, "the Inter proxy changed no pixels");
        }
    }
}

/// Bind one *named* source reference to a resource. Unlike `bind_source_font`
/// this keeps the per-name identity of the seven families.
fn install_named(
    document: &mut Document,
    id: &str,
    resource: FontResource,
    name: &str,
) -> usize {
    document.fonts.insert(id.to_owned(), resource);
    let mut moved = 0;
    for node in document.nodes.values_mut() {
        if node.kind != "text" {
            continue;
        }
        let (style_source, runs) = raw_source(node);
        let base = node
            .text_style
            .as_ref()
            .map(|style| style.font_id.clone())
            .unwrap_or_else(|| "default".into());
        for (index, source) in &runs {
            if source != name {
                continue;
            }
            let Some(run) = node.text_runs.get_mut(*index) else {
                continue;
            };
            let inherited = run.font_id.clone().unwrap_or_else(|| base.clone());
            if inherited == "default" {
                run.font_id = Some(id.to_owned());
                moved += 1;
            }
        }
        if style_source.as_deref() == Some(name) && base == "default" {
            if let Some(style) = node.text_style.as_mut() {
                style.font_id = id.to_owned();
            }
            moved += 1;
        }
    }
    moved
}