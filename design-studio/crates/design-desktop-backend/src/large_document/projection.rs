//! Small, admitted working sets use the existing scene codec and editor. Cold
//! source data remains in the source spool; it is never represented as missing
//! live scene nodes or implicitly deleted by a working-set commit.
use super::*;
use futureox_design_kernel::{interop, scene::Document};
use std::collections::HashMap;
use std::sync::OnceLock;

/// Shared only within one immutable source revision/build. The metadata and
/// symbol locator cache never survive a save, undo or source replacement.
pub(super) struct SketchContext {
    document: Value,
    symbols: OnceLock<std::result::Result<super::symbol_index::Symbols,String>>,
    revision: u64,
    directory: PathBuf,
}
impl SketchContext {
    pub fn new(s: &Session) -> Result<Self> {
        Ok(Self { document: json_part(s, "document.json")?, symbols: OnceLock::new(), revision:s.revision, directory:s.directory.clone() })
    }
    pub(super) fn symbol(&self, s: &Session, symbol: &str, cancel:&AtomicBool) -> Result<Option<(usize, usize)>> {
        check_cancel(cancel).map_err(issue)?;
        if s.revision!=self.revision || s.directory!=self.directory {return Err(issue("Symbol source revision changed"));}
        let lookup = self.symbols.get_or_init(|| {
            let mut result=super::symbol_index::Symbols::new(&s.directory);
            for (p, part) in s.parts.iter().enumerate() {
                check_cancel(cancel).map_err(|e|e.to_string())?;
                let Ok(mut records)=part.index.records(&s.directory) else {continue;};
                let Ok(mut source)=File::open(s.directory.join(&part.file)) else {continue;};
                for (n, _) in part.index.entries.iter().enumerate().filter(|(_, e)| e.kind == "symbolMaster") {
                    check_cancel(cancel).map_err(|e|e.to_string())?;
                    let Ok(record)=records.entry(n) else {continue;};
                    let Some(span)=record.fields.iter().find(|f|f.key=="symbolID").map(|f|f.value) else {continue;};
                    let Some(id)=s.state.changes[p].fragment(&mut source,span,part.base_bytes).ok()
                        .and_then(|bytes|serde_json::from_slice::<String>(&bytes).ok()) else {continue;};
                    result.insert(id,(p,n),||{
                        // Count lightweight rows only if the RAM catalog spills.
                        // Small imports do not pay for a second metadata scan.
                        let mut count=0u64;
                        for part in &s.parts {for row in &part.index.entries {
                            check_cancel(cancel)?;
                            if row.kind=="symbolMaster" {count=count.checked_add(1).ok_or_else(||io::Error::other("Symbol count overflow"))?;}
                        }}
                        Ok(count)
                    },cancel).map_err(|e|e.to_string())?;
                }
            }
            Ok(result)
        });
        let lookup=lookup.as_ref().map_err(issue)?;
        let found=lookup.get(symbol,cancel).map_err(issue)?;
        if lookup.on_disk() {if let Some((p,n))=found {
            if s.parts.get(p).and_then(|p|p.index.entries.get(n)).is_none_or(|row|row.kind!="symbolMaster") ||
                field(s,p,n,"symbolID").ok().and_then(|v|serde_json::from_slice::<String>(&v).ok()).as_deref()!=Some(symbol) {
                return Err(issue("Symbol locator no longer matches its source"));
            }
        }}
        Ok(found)
    }
}

#[cfg_attr(test, derive(Clone, Debug, PartialEq))]
pub(super) struct Projection {
    key: String,
    revision: u64,
    document: Document,
}
fn read_span(s: &Session, p: usize, span: Span) -> Result<Vec<u8>> {
    let mut file = File::open(s.directory.join(&s.parts[p].file)).map_err(issue)?;
    s.state.changes[p]
        .fragment(&mut file, span, s.parts[p].base_bytes)
        .map_err(issue)
}
pub(super) fn read_window(s: &Session, p: usize, span: Span, limit: u64) -> Result<Vec<u8>> {
    if span.len() > limit {
        return Err(issue(
            "Source subtree exceeds the bounded conversion window; select a smaller subtree",
        ));
    }
    let mut file = File::open(s.directory.join(&s.parts[p].file)).map_err(issue)?;
    let mut source = s.state.changes[p]
        .reader(&mut file, s.parts[p].base_bytes)
        .map_err(issue)?;
    source.seek(SeekFrom::Start(span.start)).map_err(issue)?;
    let mut bytes = Vec::with_capacity(span.len() as usize);
    source
        .take(span.len())
        .read_to_end(&mut bytes)
        .map_err(issue)?;
    if bytes.len() as u64 != span.len() {
        return Err(issue("Truncated source window"));
    }
    Ok(bytes)
}
pub(super) fn field(s: &Session, p: usize, n: usize, key: &str) -> Result<Vec<u8>> {
    let record = s.parts[p].index.entry(n, &s.directory)?;
    let span = record
        .fields
        .iter()
        .find(|f| f.key == key)
        .ok_or_else(|| issue("Source property is unavailable"))?
        .value;
    read_span(s, p, span)
}
pub(super) fn json_part(s: &Session, name: &str) -> Result<Value> {
    let (p, part) = s
        .parts
        .iter()
        .enumerate()
        .find(|(_, p)| p.name == name)
        .ok_or_else(|| issue("Source metadata is unavailable"))?;
    serde_json::from_slice(&read_span(
        s,
        p,
        Span {
            start: 0,
            end: part.index.bytes,
        },
    )?)
    .map_err(issue)
}
#[derive(Default, Debug, PartialEq)]
struct RootFacts {
    symbols: HashSet<String>,
    images: HashSet<String>,
    has_component: bool,
    has_private_compatibility: bool,
}
impl RootFacts {
    fn scan(root: &Value) -> Self {
        // References occur in arbitrary metadata. Admission flags belong only
        // to layer objects reached through actual `layers` arrays. Keep that
        // distinction even for malformed nested arrays and unknown fields.
        #[derive(Clone, Copy)]
        enum Context { Layer, Layers, Other }
        // Retain the original parser-bounded recursion depth instead of
        // allocating a breadth-sized stack for wide source trees.
        fn visit(value: &Value, context: Context, result: &mut RootFacts) {
            match value {
                Value::Object(map) => {
                    let class = map.get("_class").and_then(Value::as_str);
                    if class == Some("symbolInstance") {
                        if let Some(id) = map.get("symbolID").and_then(Value::as_str) { result.symbols.insert(id.into()); }
                    }
                    if let Some(reference) = map.get("_ref").and_then(Value::as_str).filter(|r| r.starts_with("images/")) {
                        result.images.insert(reference.into());
                    }
                    let layer = matches!(context, Context::Layer);
                    if layer {
                        result.has_component |= class == Some("symbolMaster");
                        result.has_private_compatibility |= value.pointer("/userInfo/com.futureox.design-kernel").is_some();
                    }
                    for (key, value) in map {
                        visit(value, if layer && key == "layers" && value.is_array() { Context::Layers } else { Context::Other }, result);
                    }
                }
                Value::Array(items) => for value in items {
                    visit(value, if matches!(context, Context::Layers) { Context::Layer } else { Context::Other }, result);
                },
                _ => {}
            }
        }
        let mut result = Self::default();
        visit(root, Context::Layer, &mut result);
        result
    }
    fn policy(&self) -> Option<bool> {
        (!self.has_private_compatibility).then_some(self.has_component || !self.symbols.is_empty())
    }
    fn append(&mut self, facts: Self) {
        self.symbols.extend(facts.symbols); self.images.extend(facts.images);
        self.has_component |= facts.has_component;
        self.has_private_compatibility |= facts.has_private_compatibility;
    }
}
fn legacy_refs(value: &Value, symbols: &mut HashSet<String>, images: &mut HashSet<String>) {
    match value {
        Value::Object(map) => {
            if map.get("_class").and_then(Value::as_str) == Some("symbolInstance") {
                if let Some(id) = map.get("symbolID").and_then(Value::as_str) { symbols.insert(id.into()); }
            }
            if let Some(reference) = map.get("_ref").and_then(Value::as_str).filter(|r| r.starts_with("images/")) {
                images.insert(reference.into());
            }
            for value in map.values() { legacy_refs(value, symbols, images); }
        }
        Value::Array(items) => for item in items { legacy_refs(item, symbols, images); },
        _ => {}
    }
}
fn legacy_policy(root: &Value) -> Option<bool> {
    let mut symbols = HashSet::new();
    let mut images = HashSet::new();
    legacy_refs(root, &mut symbols, &mut images);
    let mut component = !symbols.is_empty();
    let mut pending = vec![root];
    while let Some(layer) = pending.pop() {
        if layer.pointer("/userInfo/com.futureox.design-kernel").is_some() { return None; }
        component |= layer.get("_class").and_then(Value::as_str) == Some("symbolMaster");
        if let Some(children) = layer.get("layers").and_then(Value::as_array) { pending.extend(children); }
    }
    Some(component)
}
pub(super) fn legacy_refs_enabled() -> bool {
    std::env::var("CORE_SOURCE_LEGACY_REFS").is_ok_and(|value| value == "1")
}
fn sketch_projection(s: &Session, p: usize, n: usize) -> Result<(Document, Vec<String>)> {
    sketch_window(s, p, n, MAX_FRAGMENT_BYTES)
}
pub(super) fn sketch_window(
    s: &Session,
    p: usize,
    n: usize,
    limit: u64,
) -> Result<(Document, Vec<String>)> {
    sketch_window_in(s, p, n, limit, &SketchContext::new(s)?, &AtomicBool::new(false))
}
pub(super) fn sketch_window_in(
    s: &Session,
    p: usize,
    n: usize,
    limit: u64,
    context: &SketchContext,
    cancel: &AtomicBool,
) -> Result<(Document, Vec<String>)> {
    check_cancel(cancel).map_err(issue)?;
    let source_bytes = s.parts[p].index.entries[n].span.len();
    let root: Value =
        serde_json::from_slice(&read_window(s, p, s.parts[p].index.entries[n].span, limit)?)
            .map_err(issue)?;
    if root.get("do_objectID").and_then(Value::as_str).is_none()
        || matches!(
            root.get("_class").and_then(Value::as_str),
            None | Some("page" | "document")
        )
    {
        return Err(issue("Select a layer/subtree for canvas editing"));
    }
    if legacy_refs_enabled() {
        let mut facts = RootFacts::default();
        legacy_refs(&root, &mut facts.symbols, &mut facts.images);
        return sketch_roots_in(s, vec![root.clone()], facts, source_bytes, limit, context,cancel);
    }
    let facts = RootFacts::scan(&root);
    sketch_roots_in(s, vec![root], facts, source_bytes, limit, context,cancel)
}
/// A bounded conversion batch shares archive metadata and dependency decoding.
/// It is still the same importer and original source, never an editing baseline.
pub(super) fn sketch_batch_in(s:&Session,locations:&[(usize,usize)],limit:u64,cancel:&AtomicBool,context:&SketchContext)->Result<(Document,Vec<String>)> {
    let mut roots=Vec::new();let mut bytes=0u64;
    let mut facts = RootFacts::default();
    let mut first_policy = None;
    let mut compatible = true;
    let legacy = legacy_refs_enabled();
    for &(p,n) in locations {
        check_cancel(cancel).map_err(issue)?;
        let span=s.parts[p].index.entries[n].span;
        bytes=bytes.checked_add(span.len()).ok_or_else(||issue("Source batch size overflow"))?;
        if bytes>limit{return Err(issue("Source batch exceeds conversion window"));}
        let root:Value=serde_json::from_slice(&read_window(s,p,span,limit)?).map_err(issue)?;
        if root.get("do_objectID").and_then(Value::as_str).is_none() || matches!(root.get("_class").and_then(Value::as_str),None|Some("page"|"document")) {
            return Err(issue("Select a layer/subtree for canvas editing"));
        }
        let root_facts = if legacy {
            let policy = legacy_policy(&root);
            if roots.is_empty() { first_policy = policy; }
            compatible &= policy.is_some() && policy == first_policy;
            let mut facts = RootFacts::default();
            legacy_refs(&root, &mut facts.symbols, &mut facts.images);
            facts
        } else {
            let facts = RootFacts::scan(&root);
            let policy = facts.policy();
            if roots.is_empty() { first_policy = policy; }
            compatible &= policy.is_some() && policy == first_policy;
            facts
        };
        facts.append(root_facts);
        roots.push(root);
    }
    if roots.is_empty(){return Err(issue("Empty source conversion batch"));}
    if roots.len()>1 {
        // Symbol admission assigns stable keys to the entire conversion
        // window. Mixing independent plain roots with component roots would
        // add keys that their original singleton conversion did not have.
        // Unknown private compatibility semantics keep the singleton path.
        if !compatible { return Err(issue("Source batch requires independent component admission")); }
    }
    sketch_roots_in(s,roots,facts,bytes,limit,context,cancel)
}
fn sketch_roots_in(s:&Session,roots:Vec<Value>,facts:RootFacts,mut source_bytes:u64,limit:u64,context:&SketchContext,cancel:&AtomicBool)->Result<(Document,Vec<String>)> {
    let document = &context.document;
    let RootFacts { symbols, mut images, .. } = facts;
    let mut masters = BTreeMap::new();
    let mut unresolved = symbols;
    while let Some(symbol) = unresolved.iter().next().cloned() {
        check_cancel(cancel).map_err(issue)?;
        unresolved.remove(&symbol);
        if masters.contains_key(&symbol) {
            continue;
        }
        let found = if let Some((p, n)) = context.symbol(s, &symbol,cancel)? {
                    let entry = &s.parts[p].index.entries[n];
                    source_bytes = source_bytes.saturating_add(entry.span.len());
                    if source_bytes > limit {
                        return Err(issue("Choose a smaller component dependency working set"));
                    }
                    Some(
                        serde_json::from_slice::<Value>(&read_span(s, p, entry.span)?)
                            .map_err(issue)?,
                    )
        } else { None };
        if let Some(master) = found {
            let facts = RootFacts::scan(&master);
            unresolved.extend(facts.symbols); images.extend(facts.images);
            masters.insert(symbol, master);
        }
        // Embedded foreign masters are already retained in document.json and
        // admitted by the existing interop symbol implementation.
        if masters.len() > 512 {
            return Err(issue("Select a smaller component dependency working set"));
        }
    }
    import_source_roots(roots, masters, images, document, &s.directory.join("source"), false)
}

pub(super) fn preview_dependencies(root: &Value) -> (HashSet<String>, HashSet<String>) {
    let facts = RootFacts::scan(root);
    (facts.symbols, facts.images)
}

pub(super) fn import_source_roots(roots: Vec<Value>, masters: BTreeMap<String,Value>,
    images: HashSet<String>, document: &Value, archive_path: &Path, thumbnail: bool) -> Result<(Document,Vec<String>)> {
    let page_id = "00000000-0000-4000-8000-000000000001";
    let dependency_page_id = "00000000-0000-4000-8000-000000000002";
    // Sketch interop derives page IDs from member references. Keep those IDs
    // UUIDs as required by the shared frontend scene contract.
    let page_references=json!([{"_ref":format!("pages/{page_id}")},{"_ref":format!("pages/{dependency_page_id}")}]);
    let mut page = json!({"_class":"page","do_objectID":page_id,"name":"当前对象"});
    page["layers"]=Value::Array(roots);
    let dependencies = json!({"_class":"page","do_objectID":"00000000-0000-4000-8000-000000000002","name":"组件依赖","layers":masters.into_values().collect::<Vec<_>>()});
    let pages = BTreeMap::from([(page_id.to_owned(),page),(dependency_page_id.to_owned(),dependencies)]);
    let mut entries = BTreeMap::new();
    // File-backed embedded fonts belong to the same bounded archive workset as images.
    let mut resources = images;
    for reference in document.get("fontReferences").and_then(Value::as_array).into_iter().flatten() {
        let data = &reference["fontData"];
        if data["_class"] == "MSJSONFileReference" && data["_ref_class"] == "MSFontData" {
            if let Some(path) = data["_ref"].as_str().filter(|p| p.starts_with("fonts/")) {
                resources.insert(path.to_owned());
            }
        }
    }
    let mut bitmaps=interop::SourceBitmapRefs::new();
    if !resources.is_empty() {
        let mut archive =
            zip::ZipArchive::new(File::open(archive_path).map_err(issue)?)
                .map_err(issue)?;
        let mut image_bytes=0u64;
        for i in 0..archive.len() {
            let file=archive.by_index_raw(i).map_err(issue)?;
            if file.name().starts_with("images/"){image_bytes=image_bytes.saturating_add(file.size());}
            if image_bytes>16*1024*1024{break;}
        }
        let large=image_bytes>16*1024*1024;
        let mut size = 0u64;
        for resource in resources {
            let mut entry = archive.by_name(&resource).map_err(issue)?;
            if large && resource.starts_with("images/") && resource.to_ascii_lowercase().ends_with(".png") {
                if let Some((uri,dims))=super::bitmaps::project(archive_path,&resource,entry.size(),&mut entry,thumbnail)? {
                    bitmaps.insert(resource,(uri.into(),dims));continue;
                }
            }
            size += entry.size();
            if size > 16 * 1024 * 1024 {
                return Err(issue(
                    "Image and font working set exceeds the bounded canvas transfer; choose a smaller object",
                ));
            }
            let mut bytes = Vec::new();
            entry
                .by_ref()
                .take(16 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(issue)?;
            entries.insert(resource, bytes);
        }
    }
    let report = interop::import_sketch_source_bitmap_window(&entries,&json!({"version":136}),document,&pages,&page_references,&bitmaps).map_err(issue)?;
    Ok((report.document, report.warnings))
}
fn json_projection(s: &Session, p: usize, n: usize) -> Result<(Document, Vec<String>)> {
    let entry = &s.parts[p].index.entries[n];
    let nodes_span = s.parts[p]
        .index
        .entry(0, &s.directory)?
        .fields
        .into_iter()
        .find(|f| f.key == "nodes")
        .ok_or_else(|| issue("This JSON object is not a shared design node; use JSON properties"))?
        .value;
    let nodes_map = s.parts[p]
        .index
        .entries
        .iter()
        .position(|e| e.span == nodes_span)
        .ok_or_else(|| issue("Source nodes index unavailable"))?;
    let lookup: HashMap<&str, usize> = s.parts[p]
        .index
        .entries
        .iter()
        .enumerate()
        .filter(|(_, e)| e.parent == Some(nodes_map))
        .map(|(n, e)| (e.id.as_str(), n))
        .collect();
    if lookup.get(entry.id.as_str()) != Some(&n) {
        return Err(issue("Select a design node from the nodes collection"));
    }
    let schema: Value = serde_json::from_slice(&field(s, p, 0, "schemaVersion")?).map_err(issue)?;
    let mut nodes = serde_json::Map::new();
    let mut pending = vec![entry.id.clone()];
    let mut bytes = 0;
    while let Some(id) = pending.pop() {
        if nodes.contains_key(&id) {
            continue;
        }
        let index = *lookup
            .get(id.as_str())
            .ok_or_else(|| issue("Working-set dependency is missing from source nodes"))?;
        let raw = read_span(s, p, s.parts[p].index.entries[index].span)?;
        bytes += raw.len();
        if bytes > 2 * 1024 * 1024 {
            return Err(issue(
                "Choose a smaller canvas subtree/dependency working set",
            ));
        }
        let node: Value = serde_json::from_slice(&raw).map_err(issue)?;
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            for child in children {
                if let Some(id) = child.as_str() {
                    pending.push(id.into())
                }
            }
        }
        if let Some(component) = node
            .pointer("/instance/componentId")
            .and_then(Value::as_str)
        {
            pending.push(component.into())
        }
        nodes.insert(id, node);
    }
    let mut value = json!({"schemaVersion":schema,"id":"working","name":"当前对象","pages":[{"id":"00000000-0000-4000-8000-000000000001","name":"当前对象","background":"#ffffff","children":[entry.id]}],"nodes":nodes,"fonts":{}});
    for key in ["colorManagement", "rasterProfile", "designSystem"] {
        if let Ok(raw) = field(s, p, 0, key) {
            value[key] = serde_json::from_slice(&raw).map_err(issue)?;
        }
    }
    let document: Document = serde_json::from_value(value).map_err(issue)?;
    document.validate().map_err(issue)?;
    Ok((document, Vec::new()))
}
pub(super) fn project(s: &mut Session, request: Request) -> Result<Value> {
    let (p, n) = location(s, request.key.as_deref())?;
    let working_id = request
        .working_document_id
        .as_deref()
        .filter(|id| identity(id))
        .ok_or_else(|| issue("Missing working-set identity"))?;
    let (mut document, warnings) = if s.format == "sketch" {
        sketch_projection(s, p, n)?
    } else {
        json_projection(s, p, n)?
    };
    document.id = working_id.into();
    // Match the existing editing-adoption profile normalization. Otherwise a
    // managed Sketch working set defaults to analytic on its first edit and
    // shared admission correctly rejects that incompatible coverage profile.
    if document.raster_profile.is_none() {
        document.raster_profile = Some(if document.color_management.is_some() {
            futureox_design_kernel::fidelity::RasterProfile::Figma
        } else {
            futureox_design_kernel::fidelity::RasterProfile::Analytic
        });
    }
    document.validate().map_err(issue)?;
    let json = serde_json::to_string(&document).map_err(issue)?;
    if json.len() > 2 * 1024 * 1024 {
        return Err(issue(
            "Choose a smaller object; the canvas working set exceeds 2 MiB",
        ));
    }
    s.projection = Some(Projection {
        key: request.key.clone().unwrap(),
        revision: s.revision,
        document,
    });
    Ok(
        json!({"owner":s.owner,"revision":s.revision,"key":request.key,"json":json,"warnings":warnings}),
    )
}
fn scene_layer(document: &Document) -> Result<Value> {
    let bytes = interop::export_sketch(document).map_err(issue)?;
    let mut archive = zip::ZipArchive::new(io::Cursor::new(bytes)).map_err(issue)?;
    let mut metadata = String::new();
    archive
        .by_name("document.json")
        .map_err(issue)?
        .read_to_string(&mut metadata)
        .map_err(issue)?;
    let metadata: Value = serde_json::from_str(&metadata).map_err(issue)?;
    let path = format!(
        "{}.json",
        metadata["pages"][0]["_ref"]
            .as_str()
            .ok_or_else(|| issue("Export page reference missing"))?
            .trim_end_matches(".json")
    );
    let page: Value =
        serde_json::from_reader(archive.by_name(&path).map_err(issue)?).map_err(issue)?;
    let layers = page["layers"]
        .as_array()
        .ok_or_else(|| issue("Export has no working root"))?;
    if layers.len() != 1 {
        return Err(issue(
            "Keep the selected working root; edit its descendants inside it",
        ));
    }
    Ok(layers[0].clone())
}
pub(super) fn equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    // JS JSON transport normalizes 0.0 to 0 (and -0 to 0). Compare the bounded
    // working view by exact numeric value, keeping original raw source bytes
    // whenever that view is unchanged. This never rewrites readonly metadata.
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(a)), Some(Value::Number(b))) => {
            a == b || a.as_f64().zip(b.as_f64()).is_some_and(|(a, b)| a == b)
        }
        (Some(Value::Array(a)), Some(Value::Array(b))) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal(Some(a), Some(b)))
        }
        (Some(Value::Object(a)), Some(Value::Object(b))) => {
            a.len() == b.len() && a.iter().all(|(key, a)| equal(Some(a), b.get(key)))
        }
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}
fn raw_paints(original: &str, before: &[Value], after: &[Value]) -> Result<String> {
    let originals: Vec<Box<RawValue>> = serde_json::from_str(original).map_err(issue)?;
    let active: Vec<usize> = originals
        .iter()
        .enumerate()
        .filter_map(|(i, raw)| {
            let value: Value = serde_json::from_str(raw.get()).ok()?;
            (value.get("isEnabled") != Some(&Value::Bool(false))).then_some(i)
        })
        .collect();
    if active.len() != before.len() {
        return Err(issue(
            "Source paint mapping is ambiguous; edit these properties through JSON",
        ));
    }
    let mut used = HashSet::new();
    let mut replacements = Vec::new();
    for (position, value) in after.iter().enumerate() {
        let matched = before
            .iter()
            .enumerate()
            .find(|(i, b)| !used.contains(i) && equal(Some(b), Some(value)))
            .map(|(i, _)| i)
            .or_else(|| (position < before.len() && !used.contains(&position)).then_some(position));
        let bytes = if let Some(i) = matched {
            used.insert(i);
            raw_object(originals[active[i]].get().as_bytes(), &before[i], value)?
        } else {
            serde_json::to_vec(value).map_err(issue)?
        };
        replacements.push(String::from_utf8(bytes).map_err(issue)?);
    }
    let mut replacement = replacements.into_iter();
    let mut items = Vec::new();
    let mut active = active.into_iter().peekable();
    for (i, raw) in originals.into_iter().enumerate() {
        if active.peek() == Some(&i) {
            active.next();
            if let Some(value) = replacement.next() {
                items.push(value);
            }
        } else {
            items.push(raw.get().to_owned());
        }
    }
    items.extend(replacement);
    Ok(format!("[{}]", items.join(",")))
}
fn curve_coordinate(value: &Value) -> Result<[f64; 2]> {
    let xy = if let Some(text) = value.as_str() {
        let values = text
            .trim_matches(['{', '}'])
            .split(',')
            .map(|s| s.trim().parse::<f64>())
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(issue)?;
        if values.len() != 2 {
            return Err(issue("Invalid canonical curve coordinate"));
        }
        [values[0], values[1]]
    } else {
        [
            value
                .get("x")
                .and_then(Value::as_f64)
                .ok_or_else(|| issue("Missing curve x"))?,
            value
                .get("y")
                .and_then(Value::as_f64)
                .ok_or_else(|| issue("Missing curve y"))?,
        ]
    };
    if !xy.iter().all(|v| v.is_finite()) {
        return Err(issue("Nonfinite curve coordinate"));
    }
    Ok(xy)
}
fn source_curve_points(layer: &Value, normalized: bool) -> Result<Vec<Value>> {
    let width = layer
        .pointer("/frame/width")
        .and_then(Value::as_f64)
        .ok_or_else(|| issue("Source curve frame missing"))?;
    let height = layer
        .pointer("/frame/height")
        .and_then(Value::as_f64)
        .ok_or_else(|| issue("Source curve frame missing"))?;
    if normalized && (width <= 0. || height <= 0.) {
        return Err(issue(
            "Set a nonzero source path extent before editing its points",
        ));
    }
    let mut points = layer["points"]
        .as_array()
        .ok_or_else(|| issue("Canonical curve points missing"))?
        .clone();
    for point in &mut points {
        for (key, active) in [
            ("point", true),
            ("curveFrom", point["hasCurveFrom"] == true),
            ("curveTo", point["hasCurveTo"] == true),
        ] {
            if !active {
                point.as_object_mut().unwrap().remove(key);
                continue;
            }
            if let Some(value) = point.get(key) {
                let xy = curve_coordinate(value)?;
                point[key] = json!(format!(
                    "{{{}, {}}}",
                    if normalized { xy[0] / width } else { xy[0] },
                    if normalized { xy[1] / height } else { xy[1] }
                ));
            }
        }
    }
    Ok(points)
}
fn source_new_layer(layer: &Value) -> Result<Value> {
    let mut value = layer.clone();
    if value.get("_class").and_then(Value::as_str) == Some("shapePath") {
        value["points"] = json!(source_curve_points(layer, true)?);
        for point in value["points"].as_array_mut().unwrap() {
            for key in ["curveFrom", "curveTo"] {
                if point.get(key).is_none() {
                    point[key] = point["point"].clone();
                }
            }
        }
        if value.get("userInfo").is_none() {
            value["userInfo"] = json!({});
        }
        if value["userInfo"]
            .get("com.futureox.design-kernel")
            .is_none()
        {
            value["userInfo"]["com.futureox.design-kernel"] = json!({});
        }
        value["userInfo"]["com.futureox.design-kernel"]["geometryUnits"] = json!("normalized");
    }
    if let Some(children) = value.get_mut("layers").and_then(Value::as_array_mut) {
        for child in children {
            *child = source_new_layer(child)?;
        }
    }
    Ok(value)
}
pub(super) fn source_normalized(s: &Session, p: usize, n: usize) -> Result<bool> {
    let entry = s.parts[p].index.entry(n, &s.directory)?;
    let Some(span) = entry
        .fields
        .iter()
        .find(|f| f.key == "userInfo")
        .map(|f| f.value)
    else {
        return Ok(true);
    };
    let value: Value = serde_json::from_slice(&read_span(s, p, span)?).map_err(issue)?;
    Ok(value
        .pointer("/com.futureox.design-kernel/originalId")
        .is_none()
        || value
            .pointer("/com.futureox.design-kernel/geometryUnits")
            .and_then(Value::as_str)
            == Some("normalized"))
}
pub(super) fn source_field_equal(
    before: &Value,
    after: &Value,
    key: &str,
    normalized: bool,
) -> Result<bool> {
    if equal(before.get(key), after.get(key))
        && (key != "points"
            || equal(
                before.pointer("/frame/width"),
                after.pointer("/frame/width"),
            ) && equal(
                before.pointer("/frame/height"),
                after.pointer("/frame/height"),
            ))
    {
        return Ok(true);
    }
    if key == "points"
        && normalized
        && before.get("_class").and_then(Value::as_str) == Some("shapePath")
        && after.get("_class").and_then(Value::as_str) == Some("shapePath")
    {
        let a = json!(source_curve_points(before, true)?);
        let b = json!(source_curve_points(after, true)?);
        return Ok(equal(Some(&a), Some(&b)));
    }
    Ok(equal(before.get(key), after.get(key)))
}
pub(super) fn raw_object(original: &[u8], before: &Value, after: &Value) -> Result<Vec<u8>> {
    raw_object_units(original, before, after, None)
}
pub(super) fn raw_object_units(
    original: &[u8],
    before: &Value,
    after: &Value,
    units: Option<bool>,
) -> Result<Vec<u8>> {
    if before.get("_class").is_some()
        && after.get("_class").is_some()
        && before.get("_class") != after.get("_class")
    {
        return Err(issue(
            "Source layer class conversion requires a separate native document; the source draft is retained",
        ));
    }
    let mut fields: BTreeMap<String, Box<RawValue>> =
        serde_json::from_slice(original).map_err(issue)?;
    // Ordinary Sketch curve points are normalized to the frame. The existing
    // compatibility encoder exposes pixel coordinates with its own identity
    // marker; source edits must return to the original coordinate convention.
    let normalized_source = units.unwrap_or_else(|| {
        fields
            .get("userInfo")
            .and_then(|raw| serde_json::from_str::<Value>(raw.get()).ok())
            .is_none_or(|value| {
                value
                    .pointer("/com.futureox.design-kernel/originalId")
                    .is_none()
                    || value
                        .pointer("/com.futureox.design-kernel/geometryUnits")
                        .and_then(Value::as_str)
                        == Some("normalized")
            })
    });
    let mut keys: HashSet<String> = before
        .as_object()
        .ok_or_else(|| issue("Invalid baseline object"))?
        .keys()
        .cloned()
        .collect();
    keys.extend(
        after
            .as_object()
            .ok_or_else(|| issue("Invalid edited object"))?
            .keys()
            .cloned(),
    );
    for key in keys {
        if source_field_equal(before, after, &key, normalized_source)? {
            continue;
        }
        if key == "points"
            && before.get("_class").and_then(Value::as_str) == Some("shapePath")
            && after.get("_class").and_then(Value::as_str) == Some("shapePath")
        {
            let raw = fields
                .get(&key)
                .ok_or_else(|| issue("Source curve points missing"))?;
            let originals: Vec<Box<RawValue>> = serde_json::from_str(raw.get()).map_err(issue)?;
            let mut old = source_curve_points(before, normalized_source)?;
            let mut new = source_curve_points(after, normalized_source)?;
            if originals.len() != old.len() || old.len() != new.len() {
                return Err(issue(
                    "Source point insertion/deletion requires a topology-aware working set; the draft is retained",
                ));
            }
            let mut merged = Vec::with_capacity(new.len());
            for ((raw, b), a) in originals.iter().zip(&mut old).zip(&mut new) {
                for key in ["curveFrom", "curveTo"] {
                    if a.get(key).is_none() {
                        if let Some(value) = b.get(key) {
                            a[key] = value.clone();
                        }
                    }
                }
                let original: Value = serde_json::from_str(raw.get()).map_err(issue)?;
                for key in ["point", "curveFrom", "curveTo"] {
                    if let Some(source) = original.get(key).filter(|v| v.is_object()) {
                        let mapped = |value: &Value| -> Result<Value> {
                            let xy = curve_coordinate(value)?;
                            let mut value = json!({"x":xy[0],"y":xy[1]});
                            if let Some(class) = source.get("_class") {
                                value["_class"] = class.clone();
                            }
                            Ok(value)
                        };
                        if let Some(value) = b.get(key) {
                            b[key] = mapped(value)?;
                        } else if a.get(key).is_some() {
                            b[key] = mapped(source)?;
                        }
                        if let Some(value) = a.get(key) {
                            a[key] = mapped(value)?;
                        }
                    }
                }
                let bytes = raw_object(raw.get().as_bytes(), b, a)?;
                merged.push(
                    RawValue::from_string(String::from_utf8(bytes).map_err(issue)?)
                        .map_err(issue)?,
                );
            }
            fields.insert(
                key,
                RawValue::from_string(serde_json::to_string(&merged).map_err(issue)?)
                    .map_err(issue)?,
            );
        } else if key == "layers" {
            let originals: Vec<Box<RawValue>> = fields
                .get(&key)
                .map(|v| serde_json::from_str(v.get()))
                .transpose()
                .map_err(issue)?
                .unwrap_or_default();
            let mut raw_by_id = HashMap::new();
            for raw in originals {
                let value: Value = serde_json::from_str(raw.get()).map_err(issue)?;
                if let Some(id) = value.get("do_objectID").and_then(Value::as_str) {
                    raw_by_id.insert(id.to_ascii_uppercase(), raw);
                }
            }
            let baseline: HashMap<String, &Value> = before
                .get("layers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| {
                    v.get("do_objectID")
                        .and_then(Value::as_str)
                        .map(|id| (id.to_ascii_uppercase(), v))
                })
                .collect();
            let mut list = String::from("[");
            for child in after
                .get("layers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if list.len() > 1 {
                    list.push(',')
                }
                let id = child
                    .get("do_objectID")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_ascii_uppercase();
                let bytes =
                    if let (Some(raw), Some(before)) = (raw_by_id.get(&id), baseline.get(&id)) {
                        raw_object(raw.get().as_bytes(), before, child)?
                    } else {
                        serde_json::to_vec(&source_new_layer(child)?).map_err(issue)?
                    };
                list.push_str(std::str::from_utf8(&bytes).map_err(issue)?);
            }
            list.push(']');
            fields.insert(key, RawValue::from_string(list).map_err(issue)?);
        } else if let Some(value) = after.get(&key) {
            let merged = if let (Some(raw), Some(b)) = (fields.get(&key), before.get(&key)) {
                if b.is_object() && value.is_object() {
                    String::from_utf8(raw_object(raw.get().as_bytes(), b, value)?).map_err(issue)?
                } else if matches!(
                    key.as_str(),
                    "fills" | "borders" | "shadows" | "innerShadows"
                ) && b.is_array()
                    && value.is_array()
                {
                    raw_paints(raw.get(), b.as_array().unwrap(), value.as_array().unwrap())?
                } else {
                    serde_json::to_string(value).map_err(issue)?
                }
            } else {
                serde_json::to_string(value).map_err(issue)?
            };
            fields.insert(key, RawValue::from_string(merged).map_err(issue)?);
        } else {
            fields.remove(&key);
        }
    }
    serde_json::to_vec(&fields).map_err(issue)
}
fn branch_index(s: &Session, p: usize, n: usize, bytes: &[u8]) -> Result<DiskIndex> {
    s.parts[p].index.replace_branch(n, bytes, &s.directory)
}
fn preserve_dependency_scope(before: &Document, after: &Document) -> Result<()> {
    let mut owned = HashSet::new();
    let mut pending = before.pages[0].children.clone();
    while let Some(id) = pending.pop() {
        if owned.insert(id.clone()) {
            if let Some(node) = before.nodes.get(&id) {
                pending.extend(node.children.clone());
            }
        }
    }
    for (id, node) in &before.nodes {
        if !owned.contains(id)
            && !equal(
                Some(&serde_json::to_value(node).map_err(issue)?),
                after
                    .nodes
                    .get(id)
                    .map(serde_json::to_value)
                    .transpose()
                    .map_err(issue)?
                    .as_ref(),
            )
        {
            return Err(issue(
                "Component dependencies are read-only in this working set; open that source component to edit it",
            ));
        }
    }
    Ok(())
}

pub(super) fn preserve_point_order(
    before: &futureox_design_kernel::scene::Node,
    after: &futureox_design_kernel::scene::Node,
) -> Result<()> {
    if let Some(old) = &before.network {
        let next = after.network.as_ref().ok_or_else(|| {
            issue("Keep source point topology while editing properties; the draft is retained")
        })?;
        if old
            .vertices
            .iter()
            .map(|v| &v.id)
            .ne(next.vertices.iter().map(|v| &v.id))
            || old
                .edges
                .iter()
                .map(|e| (&e.id, &e.from, &e.to))
                .ne(next.edges.iter().map(|e| (&e.id, &e.from, &e.to)))
        {
            return Err(issue(
                "Source point insertion, deletion or reordering requires a topology-aware working set; the draft is retained",
            ));
        }
    }
    Ok(())
}

pub(super) fn commit_canvas(
    s: &mut Session,
    request: Request,
    cancel: &AtomicBool,
) -> Result<Value> {
    let (p, n) = location(s, request.key.as_deref())?;
    let root_id = s.parts[p].index.entries[n].id.clone();
    let projection = s
        .projection
        .as_ref()
        .filter(|p| p.revision == s.revision && Some(p.key.as_str()) == request.key.as_deref())
        .ok_or_else(|| issue("Reload the canvas working set after a source edit"))?;
    let text = request
        .json
        .as_deref()
        .filter(|s| s.len() <= 2 * 1024 * 1024)
        .ok_or_else(|| issue("Canvas working set exceeds 2 MiB"))?;
    futureox_design_kernel::validate_document_json(text).map_err(issue)?;
    let document: Document = serde_json::from_str(text).map_err(issue)?;
    if s.format == "sketch" {
        // Check every new ID, including descendants, before the existing-node
        // encoder, any source serialization, index construction or mutation.
        for (id, node) in &document.nodes {
            if !projection.document.nodes.contains_key(id) {
                interop::validate_sketch_new_layer_for_source_save(node).map_err(issue)?;
            }
        }
        for (id, old) in &projection.document.nodes {
            if let Some(node) = document.nodes.get(id) {
                preserve_point_order(old, node)?;
                if old != node {
                    interop::export_sketch_layer_edit(&projection.document, &document, id)
                        .map_err(issue)?;
                }
            }
        }
    }
    let mut before = serde_json::to_value(&projection.document).map_err(issue)?;
    let mut after = serde_json::to_value(&document).map_err(issue)?;
    before["nodes"] = Value::Null;
    after["nodes"] = Value::Null;
    if !equal(Some(&before), Some(&after)) {
        return Err(issue(
            "Keep document/page settings unchanged in a local working set; edit source properties separately",
        ));
    }
    let mut next = s.state.clone();
    let index = if s.format == "sketch" {
        preserve_dependency_scope(&projection.document, &document)?;
        let new_ids: HashSet<String> = document
            .nodes
            .keys()
            .filter(|id| !projection.document.nodes.contains_key(*id))
            .map(|id| id.to_ascii_uppercase())
            .collect();
        if s.parts
            .iter()
            .flat_map(|part| &part.index.entries)
            .any(|entry| new_ids.contains(&entry.id.to_ascii_uppercase()))
        {
            return Err(issue(
                "New working node conflicts with an unloaded source node",
            ));
        }
        let before = scene_layer(&projection.document)?;
        let after = scene_layer(&document)?;
        let original = read_span(s, p, s.parts[p].index.entries[n].span)?;
        let bytes = raw_object(&original, &before, &after)?;
        next.changes[p]
            .replace(
                s.parts[p].index.entries[n].span,
                bytes.clone(),
                s.parts[p].base_bytes,
            )
            .map_err(issue)?;
        branch_index(s, p, n, &bytes)?
    } else {
        let nodes_span = s.parts[p]
            .index
            .entry(0, &s.directory)?
            .fields
            .into_iter()
            .find(|f| f.key == "nodes")
            .ok_or_else(|| issue("Source nodes metadata unavailable"))?
            .value;
        let map = s.parts[p]
            .index
            .entries
            .iter()
            .position(|e| e.span == nodes_span)
            .ok_or_else(|| issue("Source nodes index unavailable"))?;
        let fields: Vec<_> = s.parts[p]
            .index
            .entries
            .iter()
            .filter(|e| e.parent == Some(map))
            .map(|e| (e.id.as_str(), e.span, e.member))
            .collect();
        let mut edits = Vec::new();
        let mut removed = Vec::new();
        let mut inserted = Vec::new();
        for (id, node) in &projection.document.nodes {
            let field = fields
                .iter()
                .position(|f| f.0 == id)
                .ok_or_else(|| issue("Working node left source scope"))?;
            if let Some(after) = document.nodes.get(id) {
                let before = serde_json::to_value(node).map_err(issue)?;
                let after = serde_json::to_value(after).map_err(issue)?;
                if !equal(Some(&before), Some(&after)) {
                    let original = read_span(s, p, fields[field].1)?;
                    edits.push((fields[field].1, raw_object(&original, &before, &after)?));
                }
            } else {
                removed.push(field);
            }
        }
        for (id, node) in &document.nodes {
            if !projection.document.nodes.contains_key(id) {
                if fields.iter().any(|f| f.0 == id) {
                    return Err(issue(
                        "New working node conflicts with an unloaded source node",
                    ));
                }
                inserted.push((id, node));
            }
        }
        removed.sort_unstable();
        // Coalesce adjacent removals so comma ownership cannot overlap.
        let mut ranges: Vec<(usize, usize)> = Vec::new();
        for field in removed.iter().copied() {
            if ranges.last().is_some_and(|(_, end)| *end + 1 == field) {
                ranges.last_mut().unwrap().1 = field
            } else {
                ranges.push((field, field));
            }
        }
        for (start, end) in ranges {
            let span = if end + 1 < fields.len() {
                Span {
                    start: fields[start].2.start,
                    end: fields[end + 1].2.start,
                }
            } else if start > 0 {
                Span {
                    start: fields[start - 1].1.end,
                    end: fields[end].1.end,
                }
            } else {
                Span {
                    start: fields[start].2.start,
                    end: fields[end].1.end,
                }
            };
            edits.push((span, Vec::new()));
        }
        if !inserted.is_empty() {
            let mut raw = String::new();
            if fields.len() > removed.len() {
                raw.push(',')
            }
            for (i, (id, node)) in inserted.iter().enumerate() {
                if i > 0 {
                    raw.push(',')
                }
                raw.push_str(&serde_json::to_string(id).map_err(issue)?);
                raw.push(':');
                raw.push_str(&serde_json::to_string(node).map_err(issue)?);
            }
            let at = s.parts[p].index.entries[map].span.end - 1;
            edits.push((Span { start: at, end: at }, raw.into_bytes()));
        }
        edits.sort_by_key(|(span, _)| std::cmp::Reverse(span.start));
        for (span, bytes) in edits {
            next.changes[p]
                .splice(span, bytes, s.parts[p].base_bytes)
                .map_err(issue)?;
        }
        rebuild_index(s, p, &next.changes[p], cancel)?
    };
    // JSON node-map edits can shift a selected subtree's catalog ordinal too.
    // Rebind before commit, and refuse missing/ambiguous identities atomically.
    let roots = index.entries.iter().enumerate()
        .filter(|(_, entry)| !root_id.is_empty() && if s.format == "sketch" {
            entry.id.eq_ignore_ascii_case(&root_id)
        } else {
            // Shared JSON node IDs are case-sensitive, matching json_projection
            // and Document validation. Distinct node / Node IDs are not ambiguous.
            entry.id == root_id
        })
        .map(|(n, _)| n).collect::<Vec<_>>();
    if roots.len() != 1 {
        return Err(issue("Source canvas identity is ambiguous; reload the source before saving"));
    }
    let next_key = format!("{p}:{}", roots[0]);
    let mut undo = s.undo.clone();
    undo.push(s.state.clone());
    if undo.len() > HISTORY_LIMIT {
        undo.remove(0);
    }
    let mut value = commit(s, next, undo, Vec::new(), Some((p, index)), cancel)?;
    value["key"] = json!(next_key);
    s.projection = Some(Projection {
        key: next_key,
        revision: s.revision,
        document,
    });
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn single_root_scan_preserves_reference_and_layer_only_policy_scopes() {
        fn refs(value: &Value, symbols: &mut HashSet<String>, images: &mut HashSet<String>) {
            match value {
                Value::Object(map) => {
                    if map.get("_class").and_then(Value::as_str) == Some("symbolInstance") {
                        if let Some(id) = map.get("symbolID").and_then(Value::as_str) { symbols.insert(id.into()); }
                    }
                    if let Some(id) = map.get("_ref").and_then(Value::as_str).filter(|id| id.starts_with("images/")) { images.insert(id.into()); }
                    for value in map.values() { refs(value, symbols, images); }
                }
                Value::Array(values) => for value in values { refs(value, symbols, images); },
                _ => {}
            }
        }
        for source in [
            json!({"_class":"group","layers":[{"_class":"symbolInstance","symbolID":"a","image":{"_ref":"images/a"}}],"metadata":{"_class":"symbolInstance","symbolID":"b","_ref":"images/b"}}),
            json!({"_class":"group","metadata":{"_class":"symbolMaster","userInfo":{"com.futureox.design-kernel":{}}}}),
            json!({"_class":"group","layers":[{"_class":"symbolMaster"}]}),
            json!({"_class":"group","layers":[{"userInfo":{"com.futureox.design-kernel":null}}]}),
            json!({"_class":"group","layers":[[{"_class":"symbolMaster","userInfo":{"com.futureox.design-kernel":{}}}]]}),
        ] {
            let (mut symbols, mut images) = (HashSet::new(), HashSet::new()); refs(&source, &mut symbols, &mut images);
            let mut component = !symbols.is_empty(); let mut private = false; let mut pending = vec![&source];
            while let Some(layer) = pending.pop() {
                private |= layer.pointer("/userInfo/com.futureox.design-kernel").is_some();
                component |= layer.get("_class").and_then(Value::as_str) == Some("symbolMaster");
                if let Some(children) = layer.get("layers").and_then(Value::as_array) { pending.extend(children); }
            }
            let actual = RootFacts::scan(&source);
            assert_eq!(actual.symbols, symbols); assert_eq!(actual.images, images);
            assert_eq!(actual.policy(), (!private).then_some(component));
        }
    }
    #[test]
    fn source_point_edits_keep_normalized_units_unknown_fields_and_inactive_handles() {
        let original=br#"{"_class":"shapePath","do_objectID":"n","frame":{"width":20,"height":10},"points":[{"_class":"curvePoint","point":"{0, 0}","hasCurveFrom":false,"hasCurveTo":false,"curveFrom":"{99, 88}","private":-0.0},{"_class":"curvePoint","point":"{1, 0}","hasCurveFrom":false,"hasCurveTo":false,"curveFrom":"{77, 66}","private":123}]}"#;
        let before = json!({"_class":"shapePath","do_objectID":"n","frame":{"width":20,"height":10},"points":[{"_class":"curvePoint","point":"{0, 0}","hasCurveFrom":false,"hasCurveTo":false,"curveFrom":"{0, 0}"},{"_class":"curvePoint","point":"{20, 0}","hasCurveFrom":false,"hasCurveTo":false,"curveFrom":"{20, 0}"}]});
        let mut before = before;
        before["points"][0]["point"] = json!({"_class":"point","x":0,"y":0});
        before["points"][1]["point"] = json!({"_class":"point","x":20,"y":0});
        let mut after = before.clone();
        after["points"][1]["point"] = json!({"_class":"point","x":15,"y":0});
        let merged = raw_object(original, &before, &after).unwrap();
        let value: Value = serde_json::from_slice(&merged).unwrap();
        assert_eq!(value["points"][1]["point"], "{0.75, 0}");
        assert_eq!(value["points"][1]["private"], 123);
        assert_eq!(value["points"][1]["curveFrom"], "{77, 66}");
        assert!(std::str::from_utf8(&merged).unwrap().contains("-0.0"));
        let files = BTreeMap::from([
            ("meta.json".into(), br#"{"version":136}"#.to_vec()),
            (
                "document.json".into(),
                br#"{"pages":[{"_ref":"pages/p"}]}"#.to_vec(),
            ),
            (
                "pages/p.json".into(),
                serde_json::to_vec(&json!({"_class":"page","layers":[value]})).unwrap(),
            ),
        ]);
        let report = interop::import_sketch_source_window(&files).unwrap();
        assert_eq!(
            report.document.nodes["n"]
                .network
                .as_ref()
                .unwrap()
                .vertices[1]
                .x,
            15.
        );
        let mut new_path = after.clone();
        new_path["userInfo"] = json!({"com.futureox.design-kernel":{"originalId":"n"}});
        let added = source_new_layer(&new_path).unwrap();
        let mut files = files;
        files.insert(
            "pages/p.json".into(),
            serde_json::to_vec(&json!({"_class":"page","layers":[added]})).unwrap(),
        );
        assert_eq!(
            interop::import_sketch_source_window(&files)
                .unwrap()
                .document
                .nodes["n"]
                .network
                .as_ref()
                .unwrap()
                .vertices[1]
                .x,
            15.
        );
        after["points"].as_array_mut().unwrap().pop();
        assert!(raw_object(original, &before, &after).is_err());
    }
    #[test]
    fn js_numeric_normalization_keeps_original_metadata_and_raw_float_bits() {
        let before = json!({"frame":{"x":-0.0,"width":1.0},"style":{"value":[0.0,1.0]}});
        let after = json!({"frame":{"x":0,"width":1},"style":{"value":[0,1]}});
        assert!(equal(Some(&before), Some(&after)));
        assert!(!equal(
            Some(&before),
            Some(&json!({"frame":{"x":0,"width":2},"style":{"value":[0,1]}}))
        ));
        let raw = br#"{"frame":{"x":-0.0,"width":1.0},"style":{"value":[0.0,1.0]}}"#;
        let preserved = String::from_utf8(raw_object(raw, &before, &after).unwrap()).unwrap();
        assert!(preserved.contains("-0.0") && preserved.contains("1.0"));
    }
    #[test]
    fn dependency_edits_cannot_be_acknowledged_without_source_writeback() {
        let id = "10000000-0000-4000-8000-000000000001";
        let node = futureox_design_kernel::facet::sample_node(id, "rectangle");
        let mut before:Document=serde_json::from_value(json!({"schemaVersion":1,"id":"10000000-0000-4000-8000-000000000002","name":"Source","pages":[{"id":"10000000-0000-4000-8000-000000000003","name":"Page","background":"#ffffff","children":[id]}],"nodes":{(id):node}})).unwrap();
        let mut dependency = before
            .nodes
            .values()
            .find(|node| node.children.is_empty())
            .unwrap()
            .clone();
        dependency.id = "10000000-0000-4000-8000-000000000099".into();
        let id = dependency.id.clone();
        before.nodes.insert(id.clone(), dependency);
        before.pages.push(futureox_design_kernel::scene::Page {
            guides: Vec::new(),
            id: "10000000-0000-4000-8000-000000000098".into(),
            name: "Dependencies".into(),
            children: vec![id.clone()],
            background: "#ffffff".into(),
        });
        before.validate().unwrap();
        let mut after = before.clone();
        assert!(preserve_dependency_scope(&before, &after).is_ok());
        after.nodes.get_mut(&id).unwrap().width = 20.;
        assert!(preserve_dependency_scope(&before, &after).is_err());
    }
    #[test]
    fn nested_changes_preserve_unknown_and_disabled_paints() {
        let original=br#"{"style":{"opaque":-0.0,"fills":[{"isEnabled":false,"secret":1844674407370955161600}]},"frame":{"width":10,"other":1e-200}}"#;
        let before = json!({"style":{"fills":[]},"frame":{"width":10}});
        let after = json!({"style":{"fills":[{"isEnabled":true,"color":{"red":0.5}}]},"frame":{"width":20}});
        let result = raw_object(original, &before, &after).unwrap();
        let text = String::from_utf8(result).unwrap();
        assert!(
            text.contains("-0.0")
                && text.contains("1844674407370955161600")
                && text.contains("1e-200")
        );
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["style"]["fills"].as_array().unwrap().len(), 2);
        assert_eq!(value["style"]["fills"][0]["isEnabled"], false);
        assert_eq!(value["frame"]["width"], 20);
    }
}
