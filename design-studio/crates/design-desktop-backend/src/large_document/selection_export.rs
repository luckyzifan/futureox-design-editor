//! An independent Sketch file made from the current source revision. Layer
//! bodies keep the original native fields, and only reachable assets are copied.
use super::*;
use futureox_design_kernel::{
    math::{Point, Transform},
    sketch::geometry::{frame_placement, layer_transform},
};
use std::collections::BTreeSet;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Selection {
    page_id: String,
    node_ids: Vec<String>,
}
pub(super) struct Archive {
    pub source_parts: BTreeSet<usize>,
    json: BTreeMap<String, Value>,
    files: BTreeSet<String>,
}
const WINDOW: u64 = 64 * 1024 * 1024;

struct References {
    // String-valued native IDs include shared styles, swatches and PostScript names.
    ids: HashSet<String>,
    symbols: BTreeSet<String>,
    masters: HashSet<String>,
    files: BTreeSet<String>,
}
impl References {
    fn new() -> Self {
        Self {
            ids: Default::default(),
            symbols: Default::default(),
            masters: Default::default(),
            files: Default::default(),
        }
    }
    fn scan(&mut self, value: &Value) -> Result<()> {
        match value {
            Value::String(id) if id.len() <= 256 => {
                self.ids.insert(id.clone());
            }
            Value::Array(items) => {
                for item in items {
                    self.scan(item)?;
                }
            }
            Value::Object(map) => {
                if let Some(path) = value["_ref"].as_str() {
                    // Native asset references may also use a bare image name.
                    // An arbitrary plugin dictionary containing "_ref" cannot
                    // pull unrelated archive members or the original preview into an export.
                    let asset = if path.starts_with("images/") || path.starts_with("fonts/") {
                        Some(path.to_owned())
                    } else if !path.contains('/') && value["_ref_class"] == "MSImageData" {
                        Some(format!("images/{path}"))
                    } else {
                        None
                    };
                    if let Some(asset) = asset {
                        if !safe_member(&asset) {
                            return Err(issue("Invalid Sketch resource reference"));
                        }
                        self.files.insert(asset);
                    }
                }
                if let Some(id) = value["symbolID"].as_str() {
                    if value["_class"] == "symbolInstance" {
                        self.symbols.insert(id.into());
                    }
                    if value["_class"] == "symbolMaster" {
                        self.masters.insert(id.into());
                    }
                }
                if value["overrideName"]
                    .as_str()
                    .is_some_and(|n| n.ends_with("_symbolID"))
                    && let Some(id) = value["value"].as_str().filter(|id| !id.is_empty())
                {
                    self.symbols.insert(id.into());
                }
                for child in map.values() {
                    self.scan(child)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn uses_definition(&self, item: &Value) -> bool {
        [
            "do_objectID",
            "sharedObjectID",
            "remoteStyleID",
            "localSharedStyleID",
            "swatchID",
            "symbolID",
            "fontFamilyName",
        ]
        .iter()
        .any(|key| item[*key].as_str().is_some_and(|id| self.ids.contains(id)))
            || item["postscriptNames"].as_array().is_some_and(|names| {
                names
                    .iter()
                    .any(|v| v.as_str().is_some_and(|n| self.ids.contains(n)))
            })
            || [
                "symbolMaster",
                "originalMaster",
                "localSharedStyle",
                "sharedStyle",
                "localSwatch",
                "originalSwatch",
            ]
            .iter()
            .filter_map(|key| item.get(*key))
            .any(|v| self.uses_definition(v))
    }
}

// Only traverse actual children of the page or a layer. Native styles and
// source metadata have their own object IDs but cannot become selected artwork.
fn artwork(s: &Session, p: usize, n: usize) -> Result<bool> {
    let part = &s.parts[p];
    let mut at = n;
    while let Some(parent) = part.index.entries[at].parent {
        let span = part.index.entries[at].span;
        let row = part.index.entry(parent, &s.directory)?;
        if !row
            .fields
            .iter()
            .any(|f| f.key == "layers" && span.start >= f.value.start && span.end <= f.value.end)
        {
            return Ok(false);
        }
        at = parent;
    }
    Ok(at == 0 && n != 0)
}
fn scalar(s: &Session, p: usize, entry: &large_json::Entry, key: &str) -> Result<Option<Value>> {
    let Some(f) = entry.fields.iter().find(|f| f.key == key) else {
        return Ok(None);
    };
    serde_json::from_slice(&projection::read_window(s, p, f.value, WINDOW)?)
        .map(Some)
        .map_err(issue)
}
fn native_transform(frame: &Value, rotation: f64, flips: [bool; 2]) -> Transform {
    layer_transform(
        ["x", "y", "width", "height"].map(|key| frame[key].as_f64().unwrap_or_default()),
        rotation,
        flips,
    )
}
fn parent_pose(s: &Session, p: usize, n: usize) -> Result<Transform> {
    let mut pose = Transform::default();
    let mut parent = s.parts[p].index.entries[n].parent;
    while let Some(i) = parent.filter(|i| *i != 0) {
        let entry = s.parts[p].index.entry(i, &s.directory)?;
        let frame = scalar(s, p, &entry, "frame")?
            .ok_or_else(|| issue("Missing native container frame"))?;
        let rotation = scalar(s, p, &entry, "rotation")?
            .and_then(|v| v.as_f64())
            .unwrap_or_default();
        let flip = |key| -> Result<bool> {
            Ok(scalar(s, p, &entry, key)?
                .and_then(|v| v.as_bool())
                .unwrap_or(false))
        };
        pose = native_transform(
            &frame,
            rotation,
            [flip("isFlippedHorizontal")?, flip("isFlippedVertical")?],
        )
        .concat(pose);
        parent = entry.parent;
    }
    Ok(pose)
}
fn read_layer(s: &Session, p: usize, n: usize, remaining: &mut u64) -> Result<Value> {
    let span = s.parts[p].index.entries[n].span;
    let raw = projection::read_window(s, p, span, *remaining)?;
    *remaining -= span.len();
    serde_json::from_slice(&raw).map_err(issue)
}
fn selected_layers(
    s: &Session,
    p: usize,
    ids: &[String],
    remaining: &mut u64,
    cancel: &AtomicBool,
) -> Result<Vec<Value>> {
    let wanted: HashSet<String> = ids.iter().map(|id| id.to_ascii_lowercase()).collect();
    if wanted.len() != ids.len() {
        return Err(issue("Duplicate selected layer"));
    }
    let part = &s.parts[p];
    let mut found = HashSet::new();
    let mut rows = Vec::new();
    for (n, row) in part.index.entries.iter().enumerate() {
        let id = row.id.to_ascii_lowercase();
        if wanted.contains(&id) && artwork(s, p, n)? {
            if !found.insert(id) {
                return Err(issue("Ambiguous source layer ID"));
            }
            rows.push(n);
        }
    }
    if found != wanted {
        return Err(issue(
            "所选图层已改变，或没有独立的 Sketch 源图层。请选择所属的画板或组件。",
        ));
    }
    rows.sort_by_key(|&n| part.index.entries[n].span.start);
    let mut end = 0;
    let mut roots = Vec::new();
    let mut left = f64::INFINITY;
    let mut top = f64::INFINITY;
    for n in rows {
        check_cancel(cancel).map_err(issue)?;
        let span = part.index.entries[n].span;
        if span.start < end {
            continue;
        }
        end = span.end;
        let layer = read_layer(s, p, n, remaining)?;
        let f = &layer["frame"];
        let w = f["width"].as_f64().unwrap_or_default();
        let h = f["height"].as_f64().unwrap_or_default();
        let pose = parent_pose(s, p, n)?.concat(native_transform(
            f,
            layer["rotation"].as_f64().unwrap_or_default(),
            [
                layer["isFlippedHorizontal"].as_bool().unwrap_or(false),
                layer["isFlippedVertical"].as_bool().unwrap_or(false),
            ],
        ));
        for (x, y) in [(0., 0.), (w, 0.), (w, h), (0., h)] {
            let v = pose.point(Point::new(x, y));
            left = left.min(v.x);
            top = top.min(v.y);
        }
        let (frame, rotation, flips) = frame_placement(pose, w, h)
            .ok_or_else(|| issue("Cannot preserve this selection's placement in Sketch"))?;
        roots.push((layer, frame, rotation, flips));
    }
    Ok(roots
        .into_iter()
        .map(|(mut layer, frame, rotation, flips)| {
            layer["frame"]["x"] = json!(frame[0] - left);
            layer["frame"]["y"] = json!(frame[1] - top);
            layer["rotation"] = json!(rotation);
            layer["isFlippedHorizontal"] = json!(flips[0]);
            layer["isFlippedVertical"] = json!(flips[1]);
            layer
        })
        .collect())
}
fn page_header(s: &Session, p: usize) -> Result<Value> {
    let entry = s.parts[p].index.entry(0, &s.directory)?;
    let mut v = json!({});
    for f in entry.fields {
        if f.key == "layers" || f.key == "userInfo" {
            continue;
        }
        let raw = projection::read_window(s, p, f.value, 4 * 1024 * 1024)?;
        v[&f.key] = serde_json::from_slice(&raw).map_err(issue)?;
    }
    Ok(v)
}
impl Archive {
    pub fn capture(
        s: &Session,
        target: &Selection,
        new_id: Option<&str>,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        let new_id = new_id
            .filter(|s| identity(s))
            .ok_or_else(|| issue("Missing selection export identity"))?;
        if s.format != "sketch"
            || target.node_ids.is_empty()
            || target.node_ids.len() > 1000
            || target
                .node_ids
                .iter()
                .any(|v| v.is_empty() || v.len() > 128)
        {
            return Err(issue("请选择当前页面的 1–1000 个 Sketch 图层"));
        }
        let mut pages = s.parts.iter().enumerate().filter(|(_, part)| {
            part.name.starts_with("pages/")
                && part.index.entries.first().is_some_and(|page| {
                    page.kind == "page" && page.id.eq_ignore_ascii_case(&target.page_id)
                })
        });
        let (p, part) = pages
            .next()
            .ok_or_else(|| issue("Selected Sketch page not found"))?;
        if pages.next().is_some() {
            return Err(issue("Ambiguous selected Sketch page"));
        }
        let mut remaining = WINDOW;
        let layers = selected_layers(s, p, &target.node_ids, &mut remaining, cancel)?;
        let name = if layers.len() == 1 {
            layers[0]["name"].as_str().unwrap_or("选区").to_owned()
        } else {
            format!("选区（{} 个图层）", layers.len())
        };
        let template = page_header(s, p)?;
        let mut selected_page = template.clone();
        selected_page["name"] = json!(name);
        selected_page["layers"] = Value::Array(layers);
        let mut references = References::new();
        references.scan(&selected_page)?;
        let mut doc = projection::json_part(s, "document.json")?;
        let context = projection::SketchContext::new(s)?;
        let mut source_parts = BTreeSet::from([p]);
        source_parts.extend(
            s.parts
                .iter()
                .enumerate()
                .filter(|(_, part)| matches!(part.name.as_str(), "document.json" | "meta.json"))
                .map(|(index, _)| index),
        );
        let mut masters = Vec::new();
        let mut visited = HashSet::new();
        let mut foreign = Vec::new();
        while let Some(id) = references.symbols.pop_first() {
            if references.masters.contains(&id) || !visited.insert(id.clone()) {
                continue;
            }
            check_cancel(cancel).map_err(issue)?;
            if visited.len() > 512 {
                return Err(issue("Selection symbol dependency limit exceeded"));
            }
            if let Some((part, n)) = context.symbol(s, &id, cancel)? {
                let value = read_layer(s, part, n, &mut remaining)?;
                references.scan(&value)?;
                source_parts.insert(part);
                masters.push(value);
            } else if let Some(item) =
                doc["foreignSymbols"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|v| {
                        ["symbolMaster", "originalMaster"]
                            .iter()
                            .any(|field| v[*field]["symbolID"].as_str() == Some(id.as_str()))
                    })
            {
                references.scan(item)?;
                foreign.push(item.clone());
            } else {
                return Err(issue(format!("Missing Sketch symbol definition: {id}")));
            }
        }
        doc["foreignSymbols"] = Value::Array(foreign);
        doc["do_objectID"] = json!(new_id.to_uppercase());
        doc["currentPageIndex"] = json!(0);
        // Document-only state (including off-selection comments and plugin data)
        // does not belong to an independent selection file.
        if let Some(map) = doc.as_object_mut() {
            map.retain(|k, _| {
                matches!(
                    k.as_str(),
                    "_class"
                        | "do_objectID"
                        | "colorSpace"
                        | "colorProfile"
                        | "currentPageIndex"
                        | "assets"
                        | "fontReferences"
                        | "foreignLayerStyles"
                        | "foreignSwatches"
                        | "foreignSymbols"
                        | "foreignTextStyles"
                        | "layerStyles"
                        | "layerTextStyles"
                        | "pages"
                        | "sharedSwatches"
                )
            });
        }
        let containers = [
            "fontReferences",
            "foreignLayerStyles",
            "foreignSwatches",
            "foreignTextStyles",
            "layerStyles",
            "layerTextStyles",
            "sharedSwatches",
        ];
        // Style definitions may themselves refer to a swatch, image or font.
        let mut pools = Vec::new();
        for key in containers {
            let Some(value) = doc.get_mut(key) else {
                continue;
            };
            let entries = if value.is_array() {
                value.as_array_mut()
            } else {
                value.get_mut("objects").and_then(Value::as_array_mut)
            };
            if let Some(entries) = entries {
                pools.push((key, std::mem::take(entries), Vec::new()));
            }
        }
        loop {
            let mut changed = false;
            for (_, pool, chosen) in &mut pools {
                for i in 0..pool.len() {
                    if !pool[i].is_null() && references.uses_definition(&pool[i]) {
                        let item = pool[i].take();
                        references.scan(&item)?;
                        chosen.push((i, item));
                        changed = true;
                    }
                }
            }
            if !changed {
                break;
            }
        }
        for (key, _, mut chosen) in pools {
            chosen.sort_by_key(|x| x.0);
            let value = Value::Array(chosen.into_iter().map(|(_, v)| v).collect());
            if doc[key].is_array() {
                doc[key] = value
            } else {
                doc[key]["objects"] = value
            }
        }
        if let Some(assets) = doc["assets"].as_object_mut() {
            for (key, v) in assets.iter_mut() {
                if let Some(list) = v.as_array_mut() {
                    list.retain(|entry| references.uses_definition(entry));
                    references.scan(v)?
                } else if key == "images" && v.is_object() {
                    if let Some(entries) = v.get_mut("entries").and_then(Value::as_object_mut) {
                        entries.retain(|id, _| references.ids.contains(id));
                        references.scan(v)?
                    }
                }
            }
        }
        let page_ref = |name: &str| json!({"_class":"MSJSONFileReference","_ref_class":"MSImmutablePage","_ref":name.trim_end_matches(".json")});
        let mut docs = vec![page_ref(&part.name)];
        let mut json = BTreeMap::new();
        let mut artboards = json!({});
        let mut add_page = |filename: String, page: Value| {
            let id = page["do_objectID"].as_str().unwrap_or("");
            let mut boards = json!({});
            for layer in page["layers"].as_array().into_iter().flatten() {
                if matches!(
                    layer["_class"].as_str(),
                    Some("artboard" | "canvasFrame" | "symbolMaster")
                ) || layer["groupBehavior"] == 1
                {
                    if let Some(id) = layer["do_objectID"].as_str() {
                        boards[id] = json!({"name":layer["name"]});
                    }
                }
            }
            artboards[id] = json!({"name":page["name"],"artboards":boards});
            json.insert(filename, page);
        };
        if !masters.is_empty() {
            let mut page = template;
            let hex = digest(format!("{new_id}:masters").as_bytes());
            let id = format!(
                "{}-{}-4{}-8{}-{}",
                &hex[..8],
                &hex[8..12],
                &hex[13..16],
                &hex[17..20],
                &hex[20..32]
            )
            .to_uppercase();
            page["do_objectID"] = json!(id);
            page["name"] = json!("Symbols");
            page["layers"] = Value::Array(masters);
            let filename = format!("pages/{id}.json");
            docs.push(page_ref(&filename));
            add_page(filename, page);
        }
        add_page(part.name.clone(), selected_page);
        doc["pages"] = Value::Array(docs);
        let mut meta = projection::json_part(s, "meta.json")?;
        meta["pagesAndArtboards"] = artboards;
        json.insert("meta.json".into(), meta);
        json.insert("document.json".into(), doc);
        json.insert("user.json".into(), json!({}));
        Ok(Self {
            source_parts,
            json,
            files: references.files,
        })
    }
    pub fn write(&self, file: File, source: &Path, cancel: &AtomicBool) -> Result<()> {
        let mut archive =
            zip::ZipArchive::new(File::open(source).map_err(issue)?).map_err(issue)?;
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, value) in &self.json {
            check_cancel(cancel).map_err(issue)?;
            writer.start_file(name, options).map_err(issue)?;
            serde_json::to_writer(&mut writer, value).map_err(issue)?;
        }
        for name in &self.files {
            check_cancel(cancel).map_err(issue)?;
            if self.json.contains_key(name) || name.starts_with("pages/") {
                return Err(issue("Invalid resource in selected Sketch archive"));
            }
            let entry = archive.by_name(name).map_err(issue)?;
            writer.raw_copy_file(entry).map_err(issue)?;
        }
        writer.finish().map_err(issue)?.sync_all().map_err(issue)
    }
}
