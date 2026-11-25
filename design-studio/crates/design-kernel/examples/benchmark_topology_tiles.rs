//! Real topology tile compiles through Preparation::compile_gpu_packet.
//! Open the Sketch archive with the desktop indexed source backend, or load a
//! previously captured production scene descriptor.
//! No synthetic document and no GPU/GUI claim.
//! Build the desktop backend in the same Cargo profile before running this
//! example. A second argument can retain the resulting scene and descriptor.
use futureox_design_kernel::preparation::Preparation;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Instant,
};

fn hash_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}
fn font() -> Vec<u8> {
    fs::read("frontend/design-client/public/fonts/NotoSansSC.ttf").expect("bundled font")
}
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> io::Result<Self> {
        let path = std::env::temp_dir().join(format!("futureox-topology-{}", std::process::id()));
        fs::create_dir(&path)?;
        Ok(Self(path))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn hash_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

fn backend_request(
    input: &mut impl Write,
    output: &mut impl BufRead,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    serde_json::to_writer(&mut *input, &json!({ "id": id, "method": method, "params": params }))
        .map_err(|error| error.to_string())?;
    input.write_all(b"\n").and_then(|()| input.flush()).map_err(|error| error.to_string())?;
    let mut line = String::new();
    if output.read_line(&mut line).map_err(|error| error.to_string())? == 0 {
        return Err(format!("Desktop backend exited during {method}"));
    }
    let reply: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
    if reply["id"] != id {
        return Err(format!("Desktop backend returned the wrong request identity for {method}"));
    }
    reply.get("result").cloned().ok_or_else(|| format!("{method}: {}", reply["error"]))
}

fn import_store(sketch: &Path, profile: &Scratch, source_sha: &str) -> Result<Value, String> {
    let binary_name = if cfg!(windows) {
        "futureox-design-desktop-backend.exe"
    } else {
        "futureox-design-desktop-backend"
    };
    let backend = match std::env::var_os("TOPOLOGY_DESKTOP_BACKEND") {
        Some(path) => PathBuf::from(path),
        None => std::env::current_exe().map_err(|error| error.to_string())?
            .parent().and_then(Path::parent).ok_or("Cannot locate the Cargo profile directory")?
            .join(binary_name),
    };
    let document_id = format!("topology-{source_sha}");
    let owner = json!({ "documentId": document_id, "sessionEpoch": 1 });
    let mut open = owner.clone();
    open["path"] = json!(sketch);
    let recovery = profile.0.join("recovery");
    let mut child = Command::new(&backend)
        .arg("--recovery-dir").arg(&recovery)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()
        .map_err(|error| format!("{}: {error}. Build -p futureox-design-desktop-backend in the same profile, or set TOPOLOGY_DESKTOP_BACKEND.", backend.display()))?;
    let mut input = child.stdin.take().expect("piped stdin");
    let mut output = BufReader::new(child.stdout.take().expect("piped stdout"));
    eprintln!("indexing {} sha256={source_sha}", sketch.display());
    let started = Instant::now();
    let result = (|| {
        let status = backend_request(&mut input, &mut output, 1, "large.open", open)?;
        if status["owner"] != owner || status["revision"] != 0 || status["format"] != "sketch" {
            return Err("Desktop backend indexed a different source or revision".into());
        }
        let source_copy = recovery.join("large-documents").join(format!("{document_id}-1")).join("source");
        if hash_file(&source_copy).map_err(|error| error.to_string())? != source_sha {
            return Err("Desktop backend copied different source bytes".into());
        }
        let params = json!({ "owner": owner, "expectedRevision": 0 });
        let mut descriptor = backend_request(&mut input, &mut output, 2, "large.canvasSnapshot", params.clone())?;
        if descriptor["owner"] != owner || descriptor["revision"] != 0 {
            return Err("Desktop backend returned a stale source snapshot".into());
        }
        backend_request(&mut input, &mut output, 3, "large.close", params)?;
        descriptor["documentId"] = owner["documentId"].clone();
        descriptor["sourceSha256"] = json!(source_sha);
        descriptor["importMs"] = json!(started.elapsed().as_secs_f64() * 1000.);
        Ok(descriptor)
    })();
    drop(input);
    drop(output);
    let stopped = child.wait().map_err(|error| error.to_string())?;
    if !stopped.success() {
        return Err(format!("Desktop backend exited with {stopped}"));
    }
    result
}

fn save_store(descriptor: &mut Value, path: &Path, meta: &Path) -> io::Result<()> {
    let source = descriptor["path"].as_str().ok_or_else(|| io::Error::other("Missing scene path"))?;
    let mut source = fs::File::open(source)?;
    let mut target = fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    let mut metadata = match fs::OpenOptions::new().write(true).create_new(true).open(meta) {
        Ok(file) => file,
        Err(error) => {
            drop(target);
            let _ = fs::remove_file(path);
            return Err(error);
        }
    };
    descriptor["path"] = json!(path);
    let result = io::copy(&mut source, &mut target)
        .and_then(|_| target.sync_all())
        .and_then(|()| serde_json::to_writer_pretty(&mut metadata, descriptor).map_err(io::Error::other));
    if result.is_err() {
        drop(target);
        drop(metadata);
        let _ = fs::remove_file(meta);
        let _ = fs::remove_file(path);
    }
    result
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
    let mut args = std::env::args_os().skip(1);
    let sketch = PathBuf::from(args.next().unwrap_or_else(|| "testing/fixtures/user-regression-20261109/拓扑素材.sketch".into()));
    let sketch = sketch.canonicalize().map_err(|error| error.to_string())?;
    let store = args.next().map(std::path::absolute).transpose().map_err(|error| error.to_string())?;
    let mut _profile = None;
    let mut descriptor = if sketch.extension().and_then(|ext| ext.to_str()) == Some("json") {
        eprintln!("loading descriptor {}", sketch.display());
        let mut descriptor: Value = serde_json::from_slice(&fs::read(&sketch).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        if let Some(path) = descriptor.get("path").and_then(|v| v.as_str()) {
            if !Path::new(path).exists() && let Some(store) = store.filter(|path| path.is_file()) {
                descriptor["path"] = json!(store);
            }
        }
        descriptor
    } else {
        let source_sha = hash_file(&sketch).map_err(|error| error.to_string())?;
        if let Some(store) = store {
            let mut meta = store.as_os_str().to_owned();
            meta.push(".json");
            let meta = PathBuf::from(meta);
            if store.is_file() && meta.is_file() {
                let mut descriptor: Value = serde_json::from_slice(&fs::read(&meta).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
                if descriptor["sourceSha256"] != source_sha {
                    return Err("Saved scene belongs to another source archive".into());
                }
                descriptor["path"] = json!(store);
                descriptor
            } else {
                let profile = Scratch::new().map_err(|error| error.to_string())?;
                let mut descriptor = import_store(&sketch, &profile, &source_sha)?;
                save_store(&mut descriptor, &store, &meta).map_err(|error| error.to_string())?;
                descriptor
            }
        } else {
            let profile = _profile.insert(Scratch::new().map_err(|error| error.to_string())?);
            import_store(&sketch, profile, &source_sha)?
        }
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
        "scope": "Indexed desktop Sketch scene compiled by native Preparation for fixed and adjacent viewports. CPU packets only.",
        "descriptor": {
            "nodes": source_metadata["nodes"], "roots": source_metadata["roots"],
            "sourceSha256": source_metadata["sourceSha256"], "documentId": descriptor["documentId"],
            "importMs": source_metadata["importMs"],
        },
        "fixed": fixed,
        "adjacent": adjacent,
    })).unwrap());
    Ok(())
}
