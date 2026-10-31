//! Import a real .sketch archive into the shared document model and emit a
//! design-render request (`{"document": …, "options": …}`), so the native
//! benchmark chain runs on user documents instead of synthetic scenes.
use futureox_design_kernel::interop;
use std::time::Instant;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 3 {
        return Err("Usage: sketch_import FILE.sketch OUT_request.json [zoom] [x] [y] [width] [height]".into());
    }
    let bytes = std::fs::read(&args[0])?;
    let number = |i: usize, default: f64| {
        args.get(i)
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(default)
    };
    let started = Instant::now();
    let report = interop::import_sketch_report(&bytes)?;
    let import_ms = started.elapsed().as_secs_f64() * 1000.;
    let document = serde_json::to_value(&report.document)?;
    let counts = count_kinds(&document);
    let page_id = document["pages"][0]["id"]
        .as_str()
        .ok_or("import produced no page")?
        .to_owned();
    let request = serde_json::json!({
        "document": document,
        "options": {
            "pageId": page_id,
            "width": number(5, 1600.) as u32,
            "height": number(6, 1000.) as u32,
            "view": { "x": number(3, 0.), "y": number(4, 0.), "zoom": number(2, 1.) },
            "transparent": false,
            "rasterProfile": "analytic"
        }
    });
    std::fs::write(&args[1], serde_json::to_string(&request)?)?;
    println!(
        "{}",
        serde_json::json!({
            "importMs": import_ms,
            "sourceBytes": bytes.len(),
            "warnings": report.warnings.len(),
            "warningSamples": report.warnings.iter().take(5).collect::<Vec<_>>(),
            "nodes": counts,
        })
    );
    Ok(())
}

fn count_kinds(document: &serde_json::Value) -> serde_json::Value {
    let mut counts = std::collections::BTreeMap::new();
    if let Some(nodes) = document["nodes"].as_object() {
        for node in nodes.values() {
            let kind = node["kind"].as_str().unwrap_or("?");
            *counts.entry(kind.to_owned()).or_insert(0u64) += 1;
        }
    }
    serde_json::to_value(&counts).unwrap_or_default()
}
