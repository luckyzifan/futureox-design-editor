//! Measured Carbon Color-page layerStyle admission.
//!
//! The archive is the public IBM file named by issue #183. This test does not
//! synthesize that file. It windows `document.json` plus the Color page, which
//! is the bounded range whose symbol instances carry shared layerStyle overrides.
use futureox_design_kernel::{components, editing, fidelity::RasterProfile, interop, math::{Point, Transform}, Engine, RenderOptions, View};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::time::Instant;

const COLOR_PAGE: &str = "FF875D36-F229-455C-9D5F-0EA8BDA58E26";
const EDITED: &str = "#0000ff";
const REPORT: &str = "/tmp/carbon-layerstyle-report.json";

fn rss_kib() -> u64 {
    std::fs::read_to_string("/proc/self/status").ok().and_then(|text| {
        text.lines().find_map(|line| line.strip_prefix("VmRSS:").and_then(|rest| rest.split_whitespace().next()).and_then(|v| v.parse().ok()))
    }).unwrap_or(0)
}

fn quantize(channel: f64) -> u8 {
    (channel.clamp(0., 1.) * 255.).round() as u8
}

fn write_report(report: &Value) {
    let bytes = serde_json::to_vec_pretty(report).unwrap_or_default();
    let _ = std::fs::write(REPORT, &bytes);
    println!("{}", String::from_utf8_lossy(&bytes));
}

fn read_member(archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>, name: &str) -> Vec<u8> {
    let mut file = archive.by_name(name).unwrap_or_else(|error| panic!("missing {name}: {error}"));
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    bytes
}

fn style_fill(document: &Value, id: &str) -> Option<[f64; 4]> {
    let containers = [
        document.pointer("/layerStyles/objects"),
        document.get("foreignLayerStyles"),
    ];
    for container in containers.into_iter().flatten() {
        for entry in container.as_array().into_iter().flatten() {
            let local = entry.get("localSharedStyle").unwrap_or(entry);
            if local.get("do_objectID").and_then(Value::as_str) != Some(id) {
                continue;
            }
            let fills = local.pointer("/value/fills").and_then(Value::as_array)?;
            let fill = fills.iter().find(|fill| fill.get("isEnabled").and_then(Value::as_bool).unwrap_or(true))?;
            if fill.get("fillType").and_then(Value::as_i64).unwrap_or(0) != 0 {
                return None;
            }
            let color = fill.get("color")?;
            return Some([
                color.get("red").and_then(Value::as_f64).unwrap_or(0.),
                color.get("green").and_then(Value::as_f64).unwrap_or(0.),
                color.get("blue").and_then(Value::as_f64).unwrap_or(0.),
                color.get("alpha").and_then(Value::as_f64).unwrap_or(1.),
            ]);
        }
    }
    None
}

fn parents(document: &futureox_design_kernel::scene::Document) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for node in document.nodes.values() {
        for child in &node.children {
            map.insert(child.clone(), node.id.clone());
        }
    }
    map
}

fn world(document: &futureox_design_kernel::scene::Document, parents: &BTreeMap<String, String>, id: &str) -> Transform {
    let mut chain = vec![id.to_owned()];
    let mut current = id;
    while let Some(parent) = parents.get(current) {
        chain.push(parent.clone());
        current = parent;
    }
    chain.reverse();
    let mut transform = Transform([1., 0., 0., 1., 0., 0.]);
    for id in chain {
        transform = transform.concat(document.nodes[&id].transform);
    }
    transform
}

fn page_of(document: &futureox_design_kernel::scene::Document, parents: &BTreeMap<String, String>, id: &str) -> String {
    let mut current = id.to_owned();
    while let Some(parent) = parents.get(&current) {
        current = parent.clone();
    }
    document.pages.iter().find(|page| page.children.iter().any(|child| child == &current)).map(|page| page.id.clone()).unwrap_or_else(|| document.pages[0].id.clone())
}

const RASTER: i32 = 48;

fn raster(document: &futureox_design_kernel::scene::Document, page: &str, center: Point) -> Result<Vec<u8>, String> {
    let mut engine = Engine::new();
    let font = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../frontend/design-client/public/fonts/NotoSansSC.ttf")).map_err(|error| error.to_string())?;
    engine.fonts.load(&font)?;
    engine.load_document(&serde_json::to_string(document).map_err(|error| error.to_string())?)?;
    // The analytic camera adds the view after the node matrix. Place the
    // computed center in the middle of the raster so a nearby solid interior
    // is still inside the window.
    let origin = RASTER as f64 / 2.;
    engine.render(&RenderOptions {
        page_id: page.to_owned(),
        width: RASTER as u32,
        height: RASTER as u32,
        view: View { x: origin - center.x, y: origin - center.y, zoom: 1. },
        transparent: true,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: RasterProfile::Analytic,
        interactive_effects: false,
        checkerboard: false,
    })
}

fn pixel(bytes: &[u8], x: i32, y: i32) -> [u8; 4] {
    let index = ((y * RASTER + x) * 4) as usize;
    [bytes[index], bytes[index + 1], bytes[index + 2], bytes[index + 3]]
}

fn nearest(bytes: &[u8], expected: [u8; 4]) -> (i32, i32, [u8; 4], i32) {
    let mut best = (RASTER / 2, RASTER / 2, pixel(bytes, RASTER / 2, RASTER / 2), i32::MAX);
    for y in 0..RASTER {
        for x in 0..RASTER {
            let sample = pixel(bytes, x, y);
            let error = expected.iter().zip(sample).map(|(a, b)| (*a as i32 - b as i32).abs()).sum();
            if error < best.3 {
                best = (x, y, sample, error);
            }
        }
    }
    best
}

fn resample(document: &futureox_design_kernel::scene::Document, sample: Option<&Value>) -> Option<[u8; 4]> {
    let sample = sample?;
    let instance = sample.get("instance").and_then(Value::as_str)?;
    let layer = sample.get("layer").and_then(Value::as_str)?;
    let offset = sample.get("offset").and_then(Value::as_array)?;
    let x = offset.first().and_then(Value::as_i64)? as i32;
    let y = offset.get(1).and_then(Value::as_i64)? as i32;
    let node = document.nodes.values().find(|node| node.instance_origin.as_ref().is_some_and(|origin| origin.owner == instance && origin.source == layer))?;
    let ancestry = parents(document);
    let center = world(document, &ancestry, &node.id).point(Point::new(node.width / 2., node.height / 2.));
    let page_id = page_of(document, &ancestry, &node.id);
    raster(document, &page_id, center).ok().map(|bytes| pixel(&bytes, x, y))
}

fn rigid(transform: Transform) -> bool {
    let [a, b, c, d, ..] = transform.0;
    (a - 1.).abs() < 1e-6 && b.abs() < 1e-6 && c.abs() < 1e-6 && (d - 1.).abs() < 1e-6
}

#[test]
#[ignore = "public Carbon_DataViz_Master_v2.sketch via SKETCH_CARBON or /tmp/sketch-official"]
fn carbon_color_page_layer_style_matches_authored_color_through_edit_undo_and_reopen() {
    let path = std::env::var("SKETCH_CARBON").unwrap_or_else(|_| "/tmp/sketch-official/Carbon_DataViz_Master_v2.sketch".into());
    let bytes = std::fs::read(&path).unwrap_or_else(|error| panic!("Carbon archive unavailable at {path}: {error}"));
    let digest = String::from_utf8(std::process::Command::new("sha256sum").arg(&path).output().unwrap().stdout).unwrap();
    let mut report = json!({
        "source": path,
        "bytes": bytes.len(),
        "sha256": digest.split_whitespace().next().unwrap_or(""),
        "git": std::env::var("GIT_COMMIT").unwrap_or_else(|_| "unspecified".into()),
        "renderer": "cpu-analytic",
        "platform": "linux-cloud-vm",
        "metal": "NOT_RUN",
        "electron": "NOT_RUN",
        "rssKibStart": rss_kib(),
    });
    let started = Instant::now();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes.as_slice())).unwrap();
    let meta: Value = serde_json::from_slice(&read_member(&mut archive, "meta.json")).unwrap();
    let mut document: Value = serde_json::from_slice(&read_member(&mut archive, "document.json")).unwrap();
    let page: Value = serde_json::from_slice(&read_member(&mut archive, &format!("pages/{COLOR_PAGE}.json"))).unwrap();
    report["extractMs"] = json!(started.elapsed().as_millis());
    assert_eq!(page["name"], "Color");
    document["pages"] = json!([{"_class":"MSJSONFileReference","_ref":format!("pages/{COLOR_PAGE}")}]);
    let mut overrides = Vec::new();
    fn walk(layer: &Value, out: &mut Vec<(String, String, String)>) {
        if layer["_class"] == "symbolInstance" {
            let instance = layer["do_objectID"].as_str().unwrap_or("").to_owned();
            for value in layer["overrideValues"].as_array().into_iter().flatten() {
                let name = value["overrideName"].as_str().unwrap_or("");
                if let Some(layer_id) = name.strip_suffix("_layerStyle") {
                    let style = value["value"].as_str().unwrap_or("").to_owned();
                    out.push((instance.clone(), layer_id.to_owned(), style));
                }
            }
        }
        for child in layer["layers"].as_array().into_iter().flatten() {
            walk(child, out);
        }
    }
    for layer in page["layers"].as_array().unwrap() {
        walk(layer, &mut overrides);
    }
    report["layerStyleOverrides"] = json!(overrides.len());
    let references: Vec<Value> = overrides.iter().map(|(instance, layer, style)| {
        let fill = style_fill(&document, style);
        json!({"instance": instance, "layer": layer, "style": style, "authored": fill.map(|c| c.iter().map(|v| quantize(*v)).collect::<Vec<_>>())})
    }).collect();
    report["references"] = json!(references);

    let import_started = Instant::now();
    let pages = BTreeMap::from([(COLOR_PAGE.to_owned(), page)]);
    let imported = interop::import_sketch_source_parts(&BTreeMap::new(), &meta, &document, &pages);
    report["importMs"] = json!(import_started.elapsed().as_millis());
    report["rssKibAfterImport"] = json!(rss_kib());
    let imported = match imported {
        Ok(report_value) => report_value.document,
        Err(error) => {
            report["importError"] = json!(error.to_string());
            write_report(&report);
            panic!("Color page admission failed: {error}");
        }
    };
    let style_links = imported.nodes.values().filter(|node| node.instance.as_ref().is_some_and(|instance| {
        instance.overrides.values().any(|fields| fields.get("styleRefs").and_then(|refs| refs.get("fills")).is_some())
    })).count();
    report["instancesWithStyleRefs"] = json!(style_links);
    let resolve_started = Instant::now();
    let mut resolved = imported.clone();
    if let Err(error) = components::resolve(&mut resolved) {
        report["resolveError"] = json!(error);
        write_report(&report);
        panic!("resolve failed: {error}");
    }
    report["resolveMs"] = json!(resolve_started.elapsed().as_millis());
    report["resolvedNodes"] = json!(resolved.nodes.len());
    let ancestry = parents(&resolved);
    let mut samples = Vec::new();
    for (instance, layer, style) in &overrides {
        let Some(fill) = style_fill(&document, style) else {
            samples.push(json!({"instance": instance, "layer": layer, "style": style, "status": "non-solid-or-missing"}));
            continue;
        };
        let expected = [quantize(fill[0]), quantize(fill[1]), quantize(fill[2]), quantize(fill[3])];
        let Some(node) = resolved.nodes.values().find(|node| node.instance_origin.as_ref().is_some_and(|origin| &origin.owner == instance && &origin.source == layer)) else {
            samples.push(json!({"instance": instance, "layer": layer, "style": style, "expected": expected, "status": "resolved-node-missing"}));
            continue;
        };
        let transform = world(&resolved, &ancestry, &node.id);
        let center = transform.point(Point::new(node.width / 2., node.height / 2.));
        let page_id = page_of(&resolved, &ancestry, &node.id);
        let render_started = Instant::now();
        let actual = raster(&resolved, &page_id, center);
        let sample = match actual {
            Ok(bytes) => {
                let (x, y, sample, error) = nearest(&bytes, expected);
                json!({"instance": instance, "layer": layer, "style": style, "name": node.name, "size": [node.width, node.height], "center": [center.x, center.y], "page": page_id, "rigid": rigid(transform), "expected": expected, "actual": sample, "offset": [x, y], "error": error, "renderMs": render_started.elapsed().as_millis(), "match": sample == expected, "fill": node.fills.first().map(|paint| paint.color.clone())})
            }
            Err(error) => json!({"instance": instance, "layer": layer, "style": style, "renderError": error}),
        };
        samples.push(sample);
    }
    report["samples"] = json!(samples);
    report["rssKibAfterPixels"] = json!(rss_kib());

    let style_id = "0EEA1B37-C6C2-4DA4-A6D4-8A4D44BA2020";
    let mut editor = match editing::DocumentEditor::new(imported.clone()) {
        Ok(editor) => editor,
        Err(error) => {
            report["editorError"] = json!(error.to_string());
            write_report(&report);
            panic!("editor admission failed: {error}");
        }
    };
    let mut system = editor.document().design_system.clone().unwrap();
    let before = system.styles[style_id].value[0]["color"].clone();
    system.styles.get_mut(style_id).unwrap().value[0]["color"] = json!(EDITED);
    let edited = editing::DocumentPatch {
        nodes: BTreeMap::new(),
        fields: BTreeMap::from([("designSystem".into(), serde_json::to_value(system).unwrap())]),
    };
    editor.apply(editor.revision(), edited).unwrap();
    let mut edited_resolved = editor.document().clone();
    components::resolve(&mut edited_resolved).unwrap();
    let edited_pixel = samples.iter().find(|sample| sample["style"] == style_id && sample["rigid"] == true && sample["size"][0].as_f64().unwrap_or(0.) >= 4.).cloned();
    let edited_pixel = edited_pixel.or_else(|| samples.iter().find(|sample| sample["style"] == style_id).cloned());
    let edited_view = resample(&edited_resolved, edited_pixel.as_ref());
    report["editedStyleBefore"] = before;
    report["editedPixel"] = json!(edited_view);
    editor.undo().unwrap();
    let mut undone = editor.document().clone();
    components::resolve(&mut undone).unwrap();
    let undone_pixel = resample(&undone, edited_pixel.as_ref());
    report["undoPixel"] = json!(undone_pixel);
    editor.redo().unwrap();
    let export_started = Instant::now();
    let exported = interop::export_sketch(editor.document());
    report["exportMs"] = json!(export_started.elapsed().as_millis());
    match exported {
        Err(error) => {
            report["exportError"] = json!(error.to_string());
            write_report(&report);
            panic!("save failed: {error}");
        }
        Ok(bytes) => {
            report["exportBytes"] = json!(bytes.len());
            let files = interop::read_zip_public(&bytes).unwrap();
            let native: Value = serde_json::from_slice(&files["document.json"]).unwrap();
            let foreign = native["foreignLayerStyles"].as_array().into_iter().flatten().find(|entry| entry.pointer("/localSharedStyle/do_objectID").and_then(Value::as_str) == Some(style_id));
            report["reopenForeignFill"] = json!(foreign.and_then(|entry| entry.pointer("/localSharedStyle/value/fills/0/color").cloned()));
            let mut exported_overrides = Vec::new();
            fn collect_overrides(layer: &Value, out: &mut Vec<Value>) {
                for value in layer["overrideValues"].as_array().into_iter().flatten() {
                    if value["overrideName"].as_str().unwrap_or("").ends_with("_layerStyle") {
                        out.push(value.clone());
                    }
                }
                for child in layer["layers"].as_array().into_iter().flatten() {
                    collect_overrides(child, out);
                }
            }
            for (name, bytes) in files.iter().filter(|(name, _)| name.starts_with("pages/")) {
                let page: Value = serde_json::from_slice(bytes).unwrap();
                let mut values = Vec::new();
                for layer in page["layers"].as_array().into_iter().flatten() {
                    collect_overrides(layer, &mut values);
                }
                exported_overrides.push(json!({"page": name, "layerStyles": values}));
            }
            report["exportedLayerStyles"] = json!(exported_overrides);
            let kept_reference = exported_overrides.iter().any(|page| page["layerStyles"].as_array().is_some_and(|values| values.iter().any(|value| value["value"].as_str() == Some(style_id))));
            report["reopenKeepsStyleReference"] = json!(kept_reference);
            let reopen_started = Instant::now();
            let mut reopened = interop::import_sketch_report(&bytes).unwrap().document;
            components::resolve(&mut reopened).unwrap();
            report["reopenMs"] = json!(reopen_started.elapsed().as_millis());
            let reopened_pixel = resample(&reopened, edited_pixel.as_ref());
            report["reopenPixel"] = json!(reopened_pixel);
            report["rssKibEnd"] = json!(rss_kib());
            report["totalMs"] = json!(started.elapsed().as_millis());
            write_report(&report);
            let large_miss = samples.iter().filter(|sample| sample["size"][0].as_f64().unwrap_or(0.) >= 14. && sample["match"] != true).count();
            let large = samples.iter().filter(|sample| sample["size"][0].as_f64().unwrap_or(0.) >= 14.).count();
            assert!(large > 0 && large_miss == 0, "authored layerStyle colors did not reach the solid icon interiors: {large_miss}/{large} missed");
            assert_eq!(edited_view, Some([0, 0, 255, 255]), "editing the shared layer style did not change the instance pixel");
            assert_eq!(undone_pixel, samples.iter().find(|sample| sample["style"] == style_id).and_then(|sample| sample["actual"].as_array()).map(|pixel| [pixel[0].as_u64().unwrap() as u8, pixel[1].as_u64().unwrap() as u8, pixel[2].as_u64().unwrap() as u8, pixel[3].as_u64().unwrap() as u8]));
            assert!(kept_reference, "save dropped the instance's shared layerStyle relationship");
            assert_eq!(reopened_pixel, Some([0, 0, 255, 255]), "save/reopen lost the edited shared layerStyle color");
        }
    }
}
