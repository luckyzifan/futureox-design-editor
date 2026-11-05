//! Derived page working sets. Original JSON and assets remain in source storage;
//! conversion windows and ordinary live-scene admission are independent bounds.
use super::*;
use base64::Engine as _;
use futureox_design_kernel::{capacity, fidelity::RasterProfile, scene::Document};

pub(super) struct Scene {
    pub key: String,
    pub revision: u64,
    pub document: Document,
    pub bytes: u64,
    pub hash: String,
    pub path: PathBuf,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NodeEdit {
    patch: BTreeMap<String, Value>,
    #[serde(default)]
    geometry_scale: Option<[f64; 2]>,
}
// The shared Editor mirrors an instance resize into its $root overrides.
// Accept that paired update without authorizing component replacement or
// edits to descendants. Native Sketch still receives the real frame extent.
fn instance_resize_only(
    old: &futureox_design_kernel::scene::Node,
    next: &futureox_design_kernel::scene::Node,
    patch: &BTreeMap<String, Value>,
) -> bool {
    if old.instance == next.instance { return true; }
    let (Some(a), Some(b)) = (&old.instance, &next.instance) else { return false; };
    if a.component_id != b.component_id || a.property_values != b.property_values
        || a.slot_contents != b.slot_contents { return false; }
    let mut a_overrides = a.overrides.clone();
    let mut b_overrides = b.overrides.clone();
    let a_root = a_overrides.remove("$root").unwrap_or_default();
    let b_root = b_overrides.remove("$root").unwrap_or_default();
    if a_overrides != b_overrides { return false; }
    a_root.keys().chain(b_root.keys()).all(|field| {
        let before = a_root.get(field);
        let after = b_root.get(field);
        projection::equal(before, after)
            || (["width", "height", "transform"].contains(&field.as_str())
                && patch.get(field).is_some_and(|value| {
                    after.is_none_or(|after| projection::equal(Some(after), Some(value)))
                }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counting_output_preserves_exact_utf8_float_and_escape_sizes() {
        let value = json!({"text":"中文\n\t\"\\🙂", "floats":[-0.0,1e-200,1e20,0.125],"opaque":{"keep":null}});
        assert_eq!(serialized_size(&value).unwrap(), serde_json::to_vec(&value).unwrap().len());
    }
    #[test]
    fn dependency_roots_keep_original_order_and_only_skip_incoming_duplicates() {
        let mut full: Document = serde_json::from_value(json!({"schemaVersion":1,"id":"s","name":"source","pages":[
            {"id":"p","name":"page","background":"#ffffff","children":[]},
            {"id":"deps","name":"deps","background":"#ffffff","children":["a","b","a"]}],"nodes":{}})).unwrap();
        let mut window = full.clone(); window.pages[1].children = vec!["b".into(),"c".into(),"c".into(),"d".into()];
        merge_window(&mut full, window).unwrap();
        assert_eq!(full.pages[1].children, ["a","b","a","c","d"]);
    }
    #[test]
    fn typed_design_system_merge_matches_the_original_json_merge_and_conflict_rules() {
        use futureox_design_kernel::design_system::DesignSystem;
        let first:DesignSystem=serde_json::from_value(json!({"fontSources":{"n":{"runs":{"0":"source-a"}}},
            "sketchContainers":{"assets":{"untouched":[1,-0.0,1e20]},"nodeMetadata":{"a":{"nested":{"x":1}}}}})).unwrap();
        let second:DesignSystem=serde_json::from_value(json!({"fontSources":{"n":{"runs":{"1":"source-b"}}},
            "sketchContainers":{"assets":{"untouched":[1,-0.0,1e20]},"nodeMetadata":{"a":{"nested":{"y":2}},"b":{"retained":"all bytes"}}}})).unwrap();
        let mut oracle=serde_json::to_value(&first).unwrap();merge(&mut oracle,serde_json::to_value(&second).unwrap()).unwrap();
        let mut actual=first.clone();merge_design_system(&mut actual,second).unwrap();
        assert_eq!(serde_json::to_value(actual).unwrap(),oracle);
        let conflict:DesignSystem=serde_json::from_value(json!({"sketchContainers":{"nodeMetadata":{"a":{"nested":{"x":2}}}}})).unwrap();
        assert!(merge_design_system(&mut first.clone(),conflict.clone()).is_err());
        assert!(merge(&mut serde_json::to_value(first).unwrap(),serde_json::to_value(conflict).unwrap()).is_err());
    }
    #[test]
    fn shared_window_retention_is_conservative_without_recharging_node_values() {
        let doc:Document=serde_json::from_value(json!({"schemaVersion":16,"id":"source","name":"source","pages":[{"id":"p","name":"page","background":"#ffffff","children":["n"]}],"nodes":{"n":futureox_design_kernel::facet::sample_node("n","frame")}})).unwrap();
        let bytes=serde_json::to_vec(&doc).unwrap().len();
        let added=unique_window_bytes(&doc,&doc,bytes).unwrap();
        assert!(added<bytes);assert!(added>0);
        // The merged identical scene is still bounded from above, including
        // every root/optional metadata field serialized by Document itself.
        assert!(bytes+added>=bytes);
        let mut other=doc.clone();other.nodes.get_mut("n").unwrap().width+=1.;
        assert!(unique_window_bytes(&doc,&other,serde_json::to_vec(&other).unwrap().len()).is_err());
        other.nodes.clear();other.pages[0].children.clear();
        let standalone=serde_json::to_vec(&other).unwrap().len();
        assert_eq!(unique_window_bytes(&doc,&other,standalone).unwrap(),standalone);
    }

    #[test]
    fn instance_resize_keeps_component_identity_and_other_overrides() {
        let mut old=futureox_design_kernel::facet::sample_node("instance", "frame");
        old.instance=Some(serde_json::from_value(json!({"componentId":"master","overrides":{},"propertyValues":{}})).unwrap());
        let mut next=old.clone();next.width=120.;
        next.instance.as_mut().unwrap().overrides.insert("$root".into(),BTreeMap::from([("width".into(),json!(120))]));
        let patch=BTreeMap::from([("width".into(),json!(120))]);
        assert!(instance_resize_only(&old,&next,&patch));
        assert!(!instance_resize_only(&old,&next,&BTreeMap::new()));
        assert!(!instance_resize_only(&old,&next,&BTreeMap::from([("width".into(),json!(121))])));
        let mut bad=next.clone();bad.instance.as_mut().unwrap().component_id="another".into();
        assert!(!instance_resize_only(&old,&bad,&patch));
        let mut bad=next.clone();bad.instance.as_mut().unwrap().overrides.insert("child".into(),BTreeMap::from([("width".into(),json!(120))]));
        assert!(!instance_resize_only(&old,&bad,&patch));
        assert!(instance_resize_only(&next,&old,&BTreeMap::from([("width".into(),json!(old.width))])));
        let mut bad=next.clone();bad.instance.as_mut().unwrap().slot_contents.insert("slot".into(),vec!["child".into()]);
        assert!(!instance_resize_only(&old,&bad,&patch));
    }
}
fn merge(a: &mut Value, b: Value) -> Result<()> {
    if *a == b {
        return Ok(());
    }
    if let (Value::Object(a), Value::Object(b)) = (a, b) {
        for (key, value) in b {
            if let Some(previous) = a.get_mut(&key) {
                merge(previous, value)?;
            } else {
                a.insert(key, value);
            }
        }
        Ok(())
    } else {
        Err(issue("Conflicting shared source metadata in page windows"))
    }
}
fn merge_entries<T: PartialEq + Serialize + serde::de::DeserializeOwned>(a: &mut BTreeMap<String,T>, b: BTreeMap<String,T>) -> Result<()> {
    for (key,value) in b {
        if let Some(old)=a.get_mut(&key) {
            if *old!=value {
                let mut merged=serde_json::to_value(&*old).map_err(issue)?;
                merge(&mut merged,serde_json::to_value(value).map_err(issue)?)?;
                *old=serde_json::from_value(merged).map_err(issue)?;
            }
        } else {a.insert(key,value);}
    }
    Ok(())
}
fn merge_design_system(a: &mut futureox_design_kernel::design_system::DesignSystem, b: futureox_design_kernel::design_system::DesignSystem) -> Result<()> {
    merge_entries(&mut a.font_sources,b.font_sources)?;
    merge_entries(&mut a.collections,b.collections)?;
    merge_entries(&mut a.variables,b.variables)?;
    merge_entries(&mut a.active_modes,b.active_modes)?;
    merge_entries(&mut a.styles,b.styles)?;
    merge_entries(&mut a.libraries,b.libraries)?;
    // Large per-node Sketch provenance is already a JSON map. Merge owned
    // incoming entries in place instead of cloning and re-decoding the entire
    // accumulated document metadata for every converted source object.
    for (key,value) in b.sketch_containers {
        if let Some(old)=a.sketch_containers.get_mut(&key){merge(old,value)?;}
        else{a.sketch_containers.insert(key,value);}
    }
    Ok(())
}
// Conservative serialized retention bound. Subtract only the value bytes of
// exact shared entries; duplicate keys, delimiters and root metadata stay in
// the bound. Never subtract conflicting references or change memory policy.
fn serialized_size(value: &impl Serialize) -> Result<usize> {
    struct Count(usize);
    impl Write for Count {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0 = self.0.checked_add(bytes.len()).ok_or_else(|| io::Error::other("Scene byte overflow"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> { Ok(()) }
    }
    let mut count = Count(0);
    serde_json::to_writer(&mut count, value).map_err(issue)?;
    Ok(count.0)
}
fn unique_window_bytes(full: &Document, window: &Document, bytes: usize) -> Result<usize> {
    let mut added = bytes;
    for (id, node) in &window.nodes {
        if let Some(old) = full.nodes.get(id) {
            if old != node { return Err(issue("Conflicting source node in page dependency closure")); }
            added = added.checked_sub(serialized_size(node)?)
                .ok_or_else(|| issue("Scene byte accounting underflow"))?;
        }
    }
    for (id, font) in &window.fonts {
        if let Some(old) = full.fonts.get(id) {
            if old != font { return Err(issue("Conflicting source font in page dependency closure")); }
            added = added.checked_sub(serialized_size(font)?)
                .ok_or_else(|| issue("Scene byte accounting underflow"))?;
        }
    }
    Ok(added)
}

pub(super) fn merge_window(full: &mut Document, mut doc: Document) -> Result<()> {
    full.schema_version = full.schema_version.max(doc.schema_version);
    full.pages[0].children.append(&mut doc.pages[0].children);
    if !doc.pages[1].children.is_empty() {
        let mut dependencies: HashSet<_> = full.pages[1].children.iter().cloned().collect();
        for id in doc.pages[1].children.drain(..) {
            if dependencies.insert(id.clone()) {
                full.pages[1].children.push(id);
            }
        }
    }
    for (id, node) in doc.nodes {
        if let Some(previous) = full.nodes.get(&id) {
            if previous != &node {
                return Err(issue("Conflicting source node in page dependency closure"));
            }
        } else {
            full.nodes.insert(id, node);
        }
    }
    match (&mut full.design_system, doc.design_system) {
        (Some(a), Some(b)) => {
            merge_design_system(a,b)?;
        }
        (a @ None, Some(b)) => *a = Some(b),
        _ => {}
    }
    if full.color_management != doc.color_management {
        return Err(issue("Page window color contract changed"));
    }
    for (id, font) in doc.fonts {
        if let Some(old)=full.fonts.get(&id) {
            if old!=&font{return Err(issue("Conflicting source font in page dependency closure"));}
        } else {
            full.fonts.insert(id, font);
        }
    }
    if let Some(b) = doc.prototype {
        if let Some(a) = &mut full.prototype {
            a.interactions.extend(b.interactions);
            if a.start_node.is_none() {
                a.start_node = b.start_node;
            }
        } else {
            full.prototype = Some(b);
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PageRange {
    pub offset: usize,
    pub end: usize,
    pub total_roots: usize,
    pub next_offset: Option<usize>,
}

#[cfg(test)]
pub(super) fn build(
    s: &Session,
    p: usize,
    n: usize,
    cancel: &AtomicBool,
) -> Result<(Document, Vec<String>)> {
    let (doc, warnings, _) = build_range(s, p, n, cancel, 0, false, capacity::document_byte_limit(), None)?;
    Ok((doc, warnings))
}

pub(super) fn build_range(
    s: &Session, p: usize, n: usize, cancel: &AtomicBool,
    offset: usize, segmented: bool, byte_limit: usize, root_limit: Option<usize>,
) -> Result<(Document, Vec<String>, Option<PageRange>)> {
    if s.format != "sketch" {
        return Err(issue(
            "Choose a shared design node for JSON canvas editing; arbitrary JSON has no canvas geometry",
        ));
    }
    let part = &s.parts[p];
    let entry = &part.index.entries[n];
    let roots = if entry.kind == "page" {
        let span = part
            .index
            .entry(n, &s.directory)?
            .fields
            .into_iter()
            .find(|f| f.key == "layers")
            .ok_or_else(|| issue("Sketch page has no layers"))?
            .value;
        part.index
            .entries
            .iter()
            .enumerate()
            .filter(|(_, e)| {
                e.parent == Some(n) && e.span.start >= span.start && e.span.end <= span.end
            })
            .map(|(i, _)| i)
            .collect::<Vec<_>>()
    } else {
        vec![n]
    };
    if offset >= roots.len() || root_limit == Some(0) ||
        (entry.kind != "page" && (offset != 0 || root_limit.is_some())) {
        return Err(issue("Invalid page working-set offset"));
    }
    let total_roots = roots.len();
    // The UI may request a smaller contiguous range after the authoritative
    // WASM derivation expands component instances beyond live-scene admission.
    // This only narrows source work; it never changes either byte allowance.
    let range_end = root_limit.map_or(total_roots, |limit| offset.saturating_add(limit).min(total_roots));
    let mut end = offset;
    let byte_limit = byte_limit.min(capacity::document_byte_limit());
    let context = projection::SketchContext::new(s)?;
    let mut full: Option<Document> = None;
    let mut warnings = std::collections::BTreeSet::new();
    // Account each conversion before retaining it. The source window can be
    // large while its typed representation still obeys normal scene admission.
    let mut retained = 0usize;
    // At most two conversion windows, only with enough trusted startup memory.
    // Merge in source order and join every worker before returning on failure
    // or cancellation. No detached jobs or new Tokio blocking lanes.
    let concurrency = if capacity::memory_budget_bytes() >= 2 * 1024 * 1024 * 1024 { 2 } else { 1 };
    'windows: for batch in roots[offset..range_end].chunks(concurrency) {
        check_cancel(cancel).map_err(issue)?;
        let convert = |root| {
            check_cancel(cancel).map_err(issue)?;
            let (doc, notes) = window_cache::convert(s, p, root, cancel, &context)?;
            check_cancel(cancel).map_err(issue)?;
            Ok::<_, BackendError>((doc, notes))
        };
        let converted = std::thread::scope(|scope| {
            let next = batch.get(1).map(|root| scope.spawn(move || convert(*root)));
            let first = convert(batch[0]);
            let mut results = vec![first];
            if let Some(next) = next {
                results.push(next.join().unwrap_or_else(|_| Err(issue("Source conversion worker failed"))));
            }
            results
        });
        for converted in converted {
            check_cancel(cancel).map_err(issue)?;
            let (doc, notes) = converted?;
            let window_bytes = serialized_size(&doc)?;
            capacity::check_document_bytes(window_bytes).map_err(issue)?;
            // Each window includes its shared fonts/component dependencies. Charge
            // their retained values once, while keeping map keys/metadata overhead
            // conservatively counted. The incoming window is independently bounded.
            let added = if let Some(full) = &full {
                unique_window_bytes(full, &doc, window_bytes)?
            } else { window_bytes };
            let next_retained = retained.checked_add(added).ok_or_else(|| issue("Scene byte overflow"))?;
            if next_retained > byte_limit {
                if segmented && entry.kind == "page" && full.is_some() { break 'windows; }
                return Err(issue(format!("DOCUMENT_RESOURCE_LIMIT: page working set needs {next_retained} bytes; allowance is {byte_limit} bytes. Select a smaller source object.")));
            }
            retained = next_retained;
            capacity::check_document_bytes(retained).map_err(issue)?;
            warnings.extend(notes);
            if let Some(full) = &mut full { merge_window(full, doc)?; }
            else { full = Some(doc); }
            end += 1;
        }
    }
    let mut doc = full.ok_or_else(|| issue("This page has no drawable source layers"))?;
    doc.id = s.owner.document_id.clone();
    doc.name = format!("{} · {}", s.name, entry.name);
    doc.pages[0].name = entry.name.clone();
    let roots = doc.pages[0]
        .children
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    doc.pages[1].children.retain(|id| !roots.contains(id));
    doc.raster_profile = Some(if doc.color_management.is_some() {
        RasterProfile::Figma
    } else {
        RasterProfile::Analytic
    });
    doc.validate().map_err(issue)?;
    let range = (entry.kind == "page").then_some(PageRange {
        offset, end, total_roots, next_offset: (end < total_roots).then_some(end),
    });
    Ok((doc, warnings.into_iter().collect(), range))
}
pub(super) fn load(s: &mut Session, request: Request, cancel: &AtomicBool) -> Result<Value> {
    let (p, n) = location(s, request.key.as_deref())?;
    let (document, warnings, range) = build_range(s, p, n, cancel, request.offset, true, capacity::document_byte_limit(), request.limit)?;
    let bytes = serde_json::to_vec(&document).map_err(issue)?;
    capacity::check_document_bytes(bytes.len()).map_err(issue)?;
    check_cancel(cancel).map_err(issue)?;
    let path = s.directory.join("canvas-scene.json");
    fs::write(&path, &bytes).map_err(issue)?;
    let hash = digest(&bytes);
    let key = request.key.unwrap();
    let result = json!({"owner":s.owner,"revision":s.revision,"key":key,"bytes":bytes.len(),"hash":hash,"nodes":document.nodes.len(),"warnings":warnings,"pageRange":range});
    s.scene = Some(Scene {
        key,
        revision: s.revision,
        document,
        bytes: bytes.len() as u64,
        hash,
        path,
    });
    Ok(result)
}
pub(super) fn read(s: &Session, request: Request) -> Result<Value> {
    let scene = s
        .scene
        .as_ref()
        .filter(|scene| {
            scene.revision == s.revision && Some(scene.key.as_str()) == request.key.as_deref()
        })
        .ok_or_else(|| issue("Reload the source canvas after a source edit"))?;
    let offset = request.offset as u64;
    if offset > scene.bytes {
        return Err(issue("Invalid scene chunk offset"));
    }
    let mut file = File::open(&scene.path).map_err(issue)?;
    file.seek(SeekFrom::Start(offset)).map_err(issue)?;
    let mut bytes = Vec::new();
    file.take((512 * 1024).min(scene.bytes - offset))
        .read_to_end(&mut bytes)
        .map_err(issue)?;
    Ok(
        json!({"owner":s.owner,"revision":s.revision,"key":scene.key,"offset":offset,"bytes":scene.bytes,"hash":scene.hash,"data":base64::engine::general_purpose::STANDARD.encode(&bytes)}),
    )
}

pub(super) fn commit_nodes(
    s: &mut Session,
    request: Request,
    cancel: &AtomicBool,
) -> Result<Value> {
    if !s.scene.as_ref().is_some_and(|scene| {
        scene.revision == s.revision && Some(scene.key.as_str()) == request.key.as_deref()
    }) {
        return Err(issue("Reload the source canvas after a source edit"));
    }
    let mut scene = s.scene.take().unwrap();
    let baseline = scene.document.clone();
    let result = (|| {
        if !request.request_id.as_deref().is_some_and(identity) {
            return Err(issue("Missing source edit identity"));
        }
        let text = request
            .json
            .as_deref()
            .filter(|text| text.len() <= 2 * 1024 * 1024)
            .ok_or_else(|| issue("Select fewer changes for this source transaction (2 MiB)"))?;
        large_json::index(text.as_bytes(), MAX_FRAGMENT_BYTES).map_err(issue)?;
        let updates: BTreeMap<String, NodeEdit> = serde_json::from_str(text).map_err(issue)?;
        let (p, root) = location(s, request.key.as_deref())?;
        let root_id = s.parts[p].index.entries[root].id.clone();
        let mut source_nodes = Vec::new();
        let mut hierarchy = BTreeMap::new();
        for (id, edit) in &updates {
            let old = baseline
                .nodes
                .get(id)
                .ok_or_else(|| issue("New layers require a local subtree editing session"))?;
            let mut value = serde_json::to_value(old).map_err(issue)?;
            for (key, next) in &edit.patch {
                if projection::equal(value.get(key), Some(next)) {
                    continue;
                }
                if key != "children" && key != "instance" && !futureox_design_kernel::components::FIELDS.contains(&key.as_str()) {
                    return Err(issue(format!(
                        "Source field {key} requires a dedicated structural transaction",
                    )));
                }
                value[key] = next.clone();
            }
            let mut node: futureox_design_kernel::scene::Node =
                serde_json::from_value(value).map_err(issue)?;
            if let Some([sx, sy]) = edit.geometry_scale {
                if ![sx, sy].iter().all(|s| s.is_finite() && *s > 0.)
                    || sx != node.width / old.width
                    || sy != node.height / old.height
                    || edit.patch.contains_key("vectorGeometry")
                    || edit.patch.contains_key("network")
                {
                    return Err(issue("Invalid source geometry scale proof"));
                }
                std::sync::Arc::make_mut(node.vector_geometry
                    .as_mut()
                    .ok_or_else(|| issue("No owned render geometry to scale"))?)
                    .scale(sx, sy);
            }
            projection::preserve_point_order(old, &node)?;
            if id != &node.id
                || old.kind != node.kind
                || old.component != node.component
                || !instance_resize_only(old, &node, &edit.patch)
                || old.boolean_operation != node.boolean_operation
            {
                return Err(issue(
                    "Keep the source hierarchy and component links unchanged in this page session; property edits remain available",
                ));
            }
            let found = s.parts[p]
                .index
                .entries
                .iter()
                .enumerate()
                .filter(|(_, entry)| entry.id.eq_ignore_ascii_case(id))
                .map(|(n, _)| n)
                .collect::<Vec<_>>();
            if found.len() != 1 {
                return Err(issue("Edit this dependency in its original source page"));
            }
            if old.children != node.children {
                if old.instance.is_some() || !matches!(old.kind.as_str(), "group"|"frame"|"section") {
                    return Err(issue("Only source containers can change layer order"));
                }
                hierarchy.insert(id.clone(), (old.children.clone(), node.children.clone()));
            }
            source_nodes.push((id.clone(), found[0]));
            scene.document.nodes.insert(id.clone(), node);
        }
        scene.document.validate().map_err(issue)?;
        let has_authored_changes = scene.document != baseline;
        if !has_authored_changes {
            let mut result = status(s);
            result["key"] = json!(scene.key);
            return Ok(result);
        }
        let mut edits = Vec::new();
        let mut added_fields = false;
        for (id, n) in source_nodes {
            check_cancel(cancel).map_err(issue)?;
            if baseline.nodes[&id] == scene.document.nodes[&id] { continue; }
            let (before, after) =
                futureox_design_kernel::interop::export_sketch_layer_edit(&baseline, &scene.document, &id)
                    .map_err(issue)?;
            let (original, omitted) = properties(s, p, n)?;
            let normalized = if before.get("_class").and_then(Value::as_str) == Some("shapePath") {
                projection::source_normalized(s, p, n)?
            } else {
                false
            };
            for key in omitted {
                if !projection::source_field_equal(&before, &after, &key, normalized)? {
                    return Err(issue(format!(
                        "Source field {key} is outside this property working set"
                    )));
                }
            }
            // Source assets are immutable in this adapter. A new URI needs an
            // explicit asset transaction, never an unpublished ZIP reference.
            fn image_refs(value: &Value, out: &mut HashSet<String>) {
                match value {
                    Value::Object(map) => {
                        if let Some(reference) = map
                            .get("_ref")
                            .and_then(Value::as_str)
                            .filter(|s| s.starts_with("images/"))
                        {
                            out.insert(reference.into());
                        }
                        for value in map.values() {
                            image_refs(value, out);
                        }
                    }
                    Value::Array(items) => {
                        for value in items {
                            image_refs(value, out);
                        }
                    }
                    _ => {}
                }
            }
            let mut a = HashSet::new();
            let mut b = HashSet::new();
            image_refs(&before, &mut a);
            image_refs(&after, &mut b);
            if a != b {
                return Err(issue(
                    "Image replacement requires a source asset transaction",
                ));
            }
            let merged = projection::raw_object_units(
                original.as_bytes(),
                &before,
                &after,
                Some(normalized),
            )?;
            let old: BTreeMap<String, Box<RawValue>> =
                serde_json::from_str(&original).map_err(issue)?;
            let new: BTreeMap<String, Box<RawValue>> =
                serde_json::from_slice(&merged).map_err(issue)?;
            let entry = s.parts[p].index.entry(n, &s.directory)?;
            let removed: HashSet<_> = old.keys().filter(|key| !new.contains_key(*key)).collect();
            if removed.iter().any(|key| matches!(key.as_str(), "do_objectID" | "_class" | "layers")) {
                return Err(issue("Source hierarchy changed"));
            }
            // Remove complete property runs, including exactly one separating
            // comma. Cold children/points never enter this small DTO or splice.
            // A full streaming index rebuild validates the virtual JSON before
            // the transaction or its history receipt can be published.
            let fields = &entry.fields;
            let mut i = 0;
            while i < fields.len() {
                if !removed.contains(&fields[i].key) { i += 1; continue; }
                let first = i;
                while i < fields.len() && removed.contains(&fields[i].key) { i += 1; }
                let span = if i < fields.len() {
                    Span { start: fields[first].member.start, end: fields[i].member.start }
                } else if first > 0 {
                    Span { start: fields[first-1].value.end, end: fields[i-1].value.end }
                } else { return Err(issue("Cannot remove every source property")); };
                edits.push((span, Vec::new()));
                added_fields = true;
            }
            let mut appended = Vec::new();
            for (key, value) in new {
                if old.get(&key).is_some_and(|old| old.get() == value.get()) {
                    continue;
                }
                if matches!(key.as_str(), "do_objectID" | "_class" | "layers") {
                    return Err(issue("Source hierarchy changed"));
                }
                if !old.contains_key(&key) {
                    // Append only the newly authored property. Large omitted
                    // points/children keep their original source byte ranges.
                    appended.push(b',');
                    serde_json::to_writer(&mut appended, &key).map_err(issue)?;
                    appended.push(b':');
                    appended.extend_from_slice(value.get().as_bytes());
                    continue;
                }
                let span = entry
                    .fields
                    .iter()
                    .find(|f| f.key == key)
                    .ok_or_else(|| issue("Source field missing"))?
                    .value;
                edits.push((span, value.get().as_bytes().to_vec()));
            }
            if !appended.is_empty() {
                let at = entry.span.end.checked_sub(1).ok_or_else(|| issue("Invalid source object span"))?;
                edits.push((Span { start: at, end: at }, appended));
                added_fields = true;
            }
        }
        if edits.is_empty() && hierarchy.is_empty() {
            return Err(issue("Source edit has no lossless Sketch representation; keep the draft or save a native document"));
        }
        edits.sort_by_key(|(span, _)| std::cmp::Reverse(span.start));
        if edits.windows(2).any(|pair| pair[1].0.end > pair[0].0.start) {
            return Err(issue("Overlapping source edits"));
        }
        let mut next = s.state.clone();
        for (span, bytes) in &edits {
            if span.start == span.end || bytes.is_empty() {
                // A member insertion is not a standalone JSON value. The
                // complete virtual source is scanned below before commit.
                next.changes[p].splice(*span, bytes.clone(), s.parts[p].base_bytes).map_err(issue)?;
            } else {
                next.changes[p].replace(*span, bytes.clone(), s.parts[p].base_bytes).map_err(issue)?;
            }
        }
        let mut index = if added_fields {
            rebuild_index(s, p, &next.changes[p], cancel)?
        } else {
            adjusted_index(s, p, &next.changes[p], &edits, cancel)?
        };
        if !hierarchy.is_empty() {
            next.changes[p] = super::hierarchy::reorder(s, p, &root_id, &index, &next.changes[p], &hierarchy, cancel)?;
            index = rebuild_index(s, p, &next.changes[p], cancel)?;
        }
        // A new object-valued property can shift later catalog ordinals.
        // Resolve the selected source identity before publishing, never reuse a
        // stale ordinal or choose an ambiguous duplicate after a successful save.
        let roots = index.entries.iter().enumerate()
            .filter(|(_, entry)| !root_id.is_empty() && entry.id.eq_ignore_ascii_case(&root_id))
            .map(|(n, _)| n).collect::<Vec<_>>();
        if roots.len() != 1 {
            return Err(issue("Source canvas identity is ambiguous; reload the source before saving"));
        }
        let next_key = format!("{p}:{}", roots[0]);
        let mut undo = s.undo.clone();
        undo.push(s.state.clone());
        while undo.len() > HISTORY_LIMIT
            || undo
                .iter()
                .flat_map(|s| &s.changes)
                .map(Changes::retained_bytes)
                .sum::<usize>()
                > HISTORY_BYTES
        {
            undo.remove(0);
        }
        let mut result = commit(s, next, undo, Vec::new(), Some((p, index)), cancel)?;
        scene.key = next_key;
        result["key"] = json!(scene.key);
        Ok(result)
    })();
    if result.is_err() {
        scene.document = baseline;
    } else {
        scene.revision = s.revision;
        // Only successful edits invalidate the initial chunk DTO. Rejections
        // preserve the exact scene/read state as well as source/revision/history.
        if scene.document != baseline { scene.bytes = 0; }
    }
    s.scene = Some(scene);
    result
}

#[cfg(test)]
#[path = "scene_roundtrip_tests.rs"]
mod roundtrip_tests;
