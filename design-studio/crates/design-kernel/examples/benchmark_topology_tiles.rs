//! Real topology tile compiles through Preparation::compile_gpu_packet.
//! The Sketch archive is the LFS fixture, imported by the production importer.
//! No synthetic document and no GPU/GUI claim.
use futureox_design_kernel::{interop, preparation::Preparation, scene_store};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::PathBuf, sync::atomic::AtomicBool, time::Instant};

fn hash_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}
fn font() -> Vec<u8> {
    fs::read("frontend/design-client/public/fonts/NotoSansSC.ttf").expect("bundled font")
}
fn import_store(sketch: &str, store_path: &str) -> Value {
    eprintln!("reading {sketch}");
    let bytes = fs::read(sketch).unwrap();
    let source_sha = hash_bytes(&bytes);
    eprintln!("importing {} bytes sha256={source_sha}", bytes.len());
    let started = Instant::now();
    let report = interop::import_sketch_report(&bytes).expect("sketch import");
    let import_ms = started.elapsed().as_secs_f64() * 1000.;
    let document = report.document;
    let page = document.pages[0].id.clone();
    let stage = document.pages[0].children[0].clone();
    let roots = document.nodes[&stage].children.len();
    eprintln!("imported nodes={} roots={roots} page={page} stage={stage} import_ms={import_ms:.1} warnings={}",
        document.nodes.len(), report.warnings.len());
    if PathBuf::from(store_path).exists() { fs::remove_file(store_path).unwrap(); }
    let started = Instant::now();
    let desc = scene_store::write(PathBuf::from(store_path).as_path(), "topology:measure", &document, &[], &AtomicBool::new(false)).expect("scene store");
    eprintln!("store write_ms={:.1} bytes={}", started.elapsed().as_secs_f64()*1000., desc.bytes);
    json!({
        "path": store_path,
        "store": desc,
        "documentId": document.id,
        "pageId": page,
        "stageId": stage,
        "nodes": document.nodes.len(),
        "roots": roots,
        "sourceSha256": source_sha,
        "importMs": import_ms,
    })
}
fn tiles(cam_x: f64, cam_y: f64, cols: i32, rows: i32) -> (Value, Vec<(i32, i32)>) {
    let ox = cam_x.floor() as i32;
    let oy = cam_y.floor() as i32;
    let mut origins = Vec::new();
    for row in 0..rows {
        for col in 0..cols {
            origins.push((ox + col * 512, oy + row * 512));
        }
    }
    let right = origins.iter().map(|(x, _)| x + 514).max().unwrap();
    let bottom = origins.iter().map(|(_, y)| y + 514).max().unwrap();
    let prepare = json!({"x": ox, "y": oy, "w": right - ox, "h": bottom - oy});
    (prepare, origins)
}
fn compile_grid(descriptor: &Value, cam_x: f64, cam_y: f64, cols: i32, rows: i32) -> Value {
    let mut native = Preparation::new(&font()).unwrap();
    native.request("canvas", "load_source_snapshot", &[descriptor.clone()]).expect("load snapshot");
    let (prepare, origins) = tiles(cam_x, cam_y, cols, rows);
    let page = descriptor["pageId"].as_str().unwrap();
    let mut tiles_out = Vec::new();
    let wall_started = Instant::now();
    for (x, y) in origins {
        let options = json!({
            "pageId": page, "width": 1024, "height": 768,
            "view": {"x": cam_x, "y": cam_y, "zoom": 1.0},
            "rasterProfile": "figmaSubpixel", "gpuPageBackground": true,
            "gpuViewport": {"x": x, "y": y, "w": 514, "h": 514},
            "prepareViewport": prepare,
        });
        let started = Instant::now();
        let reply = native.request("canvas", "compile_gpu_packet", &[json!(options.to_string())]).expect("compile");
        if let Ok(dir) = std::env::var("TOPOLOGY_SAVE_PACKETS") {
            fs::create_dir_all(&dir).ok();
            fs::write(format!("{dir}/tile-{x}-{y}.bin"), &reply.bytes).unwrap();
        }
        let ms = started.elapsed().as_secs_f64() * 1000.;
        let demand = reply.metadata["compileStats"]["sourceDemand"].clone();
        let source_stats = native.request("canvas", "stats", &[]).expect("source stats");
        let source_stats: Value = serde_json::from_str(source_stats.metadata["value"].as_str().expect("source stats JSON")).expect("source stats value");
        let record = json!({
            "x": x, "y": y, "compileMs": ms, "packetBytes": reply.bytes.len(),
            "packetSha256": hash_bytes(&reply.bytes),
            "mode": demand["mode"], "resolvedCompileNodes": demand["resolvedCompileNodes"],
            "residentAuthoredNodes": demand["residentAuthoredNodes"],
            "projectionDecision": demand["projectionDecision"],
            "projectionRebuilds": demand["projectionRebuilds"],
            "projectionReuses": demand["projectionReuses"],
            "sourceNodes": demand["sourceNodes"],
            "compileStats": reply.metadata["compileStats"],
            "sourceStats": source_stats,
        });
        eprintln!("{}", record);
        tiles_out.push(record);
    }
    json!({
        "camera": [cam_x, cam_y, 1.0],
        "cols": cols, "rows": rows,
        "prepare": prepare,
        "wallMs": wall_started.elapsed().as_secs_f64() * 1000.,
        "tiles": tiles_out,
    })
}
fn word(bytes: &[u8], offset: usize) -> usize { u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap()) as usize }
fn fgsc_value(bytes: &[u8]) -> Value {
    struct Reader<'a> { bytes: &'a [u8], at: usize, strings: Vec<String> }
    impl Reader<'_> {
        fn take(&mut self, n: usize) -> &[u8] { let start = self.at; self.at += n; &self.bytes[start..self.at] }
        fn size(&mut self) -> usize { u32::from_le_bytes(self.take(4).try_into().unwrap()) as usize }
        fn value(&mut self) -> Value {
            match self.take(1)[0] {
                1 => Value::Null, 2 => Value::Bool(false), 3 => Value::Bool(true),
                4 => Value::from(f64::from_le_bytes(self.take(8).try_into().unwrap())),
                5 => { let index = self.size(); Value::String(self.strings[index].clone()) }
                6 => { let n = self.size(); let text = std::str::from_utf8(self.take(n)).unwrap().to_owned(); self.strings.push(text.clone()); Value::String(text) }
                7 => { let mut items = Vec::new(); while self.bytes[self.at] != 0 { items.push(self.value()); } self.at += 1; Value::Array(items) }
                8 => { let mut fields = Map::new(); while self.bytes[self.at] != 0 { let key = self.value().as_str().unwrap().to_owned(); fields.insert(key, self.value()); } self.at += 1; Value::Object(fields) }
                tag => panic!("unknown FGSC tag {tag}"),
            }
        }
    }
    let mut reader = Reader { bytes, at: 0, strings: vec![] };
    let value = reader.value();
    assert_eq!(reader.at, bytes.len());
    value
}
fn geometry_words(packet: &[u8]) -> Vec<u32> {
    assert_eq!(&packet[..4], b"FGSC");
    let start = (24 + word(packet, 8) + 3) & !3;
    let end = start + (word(packet, 12) + word(packet, 16)) * 4;
    packet[start..end].chunks_exact(4).map(|w| u32::from_le_bytes(w.try_into().unwrap())).collect()
}
fn scene(packet: &[u8]) -> Value {
    let mut metadata = fgsc_value(&packet[24..24+word(packet, 8)]);
    let mut at = ((24 + word(packet, 8) + 3) & !3) + (word(packet, 12) + word(packet, 16)) * 4;
    let mut resources = BTreeMap::new();
    while at < packet.len() {
        let id = word(packet, at); let kind = packet[at+4]; let size = word(packet, at+5); at += 9;
        let data = &packet[at..at+size]; at += size;
        let decoded = match kind { 1 => Value::String(std::str::from_utf8(data).unwrap().into()), 2 | 3 => fgsc_value(data), _ => panic!("bad resource") };
        resources.insert(id, (kind, decoded));
    }
    let fields = metadata.as_object_mut().unwrap();
    let bindings = fields.remove("nodeResources").unwrap();
    let mut nodes = Map::new();
    for binding in bindings.as_array().unwrap() {
        let pair = binding.as_array().unwrap();
        let name = pair[0].as_str().unwrap();
        let id = pair[1].as_f64().unwrap() as usize;
        let node = resources[&id].1["node"].clone();
        nodes.insert(name.into(), node);
    }
    fields.remove("resourceScope");
    fields.remove("frameSequence");
    fields.remove("pagePaintRects");
    fields.insert("nodes".into(), Value::Object(nodes));
    metadata
}
fn same_scene(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64().unwrap().to_bits() == b.as_f64().unwrap().to_bits(),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_scene(a, b)),
        (Value::Object(a), Value::Object(b)) => a.len() == b.len() && a.iter().all(|(k, v)| b.get(k).is_some_and(|b| same_scene(v, b))),
        _ => a == b,
    }
}
fn compare_packets(baseline: &str, candidate: &str) -> Result<(), String> {
    let mut names = fs::read_dir(candidate).map_err(|e| e.to_string())?.map(|e| e.unwrap().file_name()).collect::<Vec<_>>();
    names.sort();
    if names.is_empty() { return Err("no candidate packets".into()); }
    for name in names {
        let left = fs::read(format!("{baseline}/{}", name.to_string_lossy())).map_err(|e| e.to_string())?;
        let right = fs::read(format!("{candidate}/{}", name.to_string_lossy())).map_err(|e| e.to_string())?;
        if geometry_words(&left) != geometry_words(&right) || !same_scene(&scene(&left), &scene(&right)) {
            return Err(format!("packet scene changed: {}", name.to_string_lossy()));
        }
    }
    Ok(())
}
fn main() -> Result<(), String> {
    let sketch = std::env::args().nth(1).unwrap_or_else(|| "testing/fixtures/user-regression-20261109/拓扑素材.sketch".into());
    let store = std::env::args().nth(2).unwrap_or_else(|| "/tmp/topology-measure.scene".into());
    let meta_path = format!("{store}.json");
    let mut descriptor = if sketch.ends_with(".json") {
        eprintln!("loading descriptor {sketch}");
        let mut descriptor: Value = serde_json::from_str(&fs::read_to_string(&sketch).unwrap()).unwrap();
        if let Some(path) = descriptor.get("path").and_then(|v| v.as_str()) {
            if !PathBuf::from(path).exists() && PathBuf::from(&store).exists() {
                descriptor["path"] = json!(store);
            }
        }
        descriptor
    } else if PathBuf::from(&store).exists() && PathBuf::from(&meta_path).exists() {
        eprintln!("reusing {store}");
        serde_json::from_str(&fs::read_to_string(&meta_path).unwrap()).unwrap()
    } else {
        let descriptor = import_store(&sketch, &store);
        fs::write(&meta_path, serde_json::to_string_pretty(&descriptor).unwrap()).unwrap();
        descriptor
    };
    if !descriptor.get("documentId").is_some() {
        if let Some(id) = descriptor["store"]["documentId"].as_str() {
            descriptor["documentId"] = json!(id);
        }
    }
    let source_metadata = descriptor.clone();
    descriptor = json!({
        "path": descriptor["path"],
        "store": descriptor["store"],
        "documentId": descriptor["documentId"],
        "pageId": descriptor["pageId"],
        "stageId": descriptor["stageId"],
        "nodes": descriptor["nodes"],
    });
    let grid: i32 = std::env::var("TOPOLOGY_GRID").ok().and_then(|v| v.parse().ok()).unwrap_or(4);
    let local_x = -369.2813895642924;
    let local_y = -642.0;
    let fixed = compile_grid(&descriptor, local_x, local_y, grid, grid);
    let adjacent = if std::env::var("TOPOLOGY_ADJACENT").ok().as_deref()==Some("0") { Value::Null } else {
        compile_grid(&descriptor, local_x - 512.0, local_y - 32.0, grid, grid)
    };
    if let Ok(baseline) = std::env::var("TOPOLOGY_BASELINE_PACKETS") {
        if let Ok(candidate) = std::env::var("TOPOLOGY_SAVE_PACKETS") {
            compare_packets(&baseline, &candidate)?;
            eprintln!("packets match baseline scene geometry and curve words");
        }
    }
    println!("{}", serde_json::to_string_pretty(&json!({
        "scope": "Real LFS topology Sketch imported by import_sketch_report, then native Preparation compile_gpu_packet for a 4x4 fixed viewport and an adjacent pan. Not Electron, Metal, or GUI scanout.",
        "descriptor": {
            "nodes": source_metadata["nodes"], "roots": source_metadata["roots"],
            "sourceSha256": source_metadata["sourceSha256"], "documentId": descriptor["documentId"],
        },
        "fixed": fixed,
        "adjacent": adjacent,
    })).unwrap());
    Ok(())
}
