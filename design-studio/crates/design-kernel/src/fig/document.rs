//! Figma file semantics that live beside the layer tree: document identity,
//! hidden pages, shared styles, and component sets.
//!
//! Scene nodes stay the authority for paint. Style definitions are added
//! beside them. An internal canvas is a real page so masters parented there
//! remain reachable; other `internalOnly` records stay out of the scene.
use super::{bool_of, guid_string, str_of, Error, FigImporter};
use crate::design_system::SharedStyle;
use crate::scene::{Document, Node, RulerGuide};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn include_in_scene(record: &Value, records: &BTreeMap<String, Value>) -> bool {
    let kind = str_of(record, "type").unwrap_or("");
    if kind == "DOCUMENT" {
        return false;
    }
    if kind == "CANVAS" {
        return true;
    }
    // Variable definitions live in the design system, not the layer tree.
    if matches!(kind, "VARIABLE" | "VARIABLE_SET") {
        return false;
    }
    if bool_of(record, "internalOnly").unwrap_or(false) {
        return false;
    }
    // Style definitions parented to the document, or to nothing, are library
    // entries. A style that already lives on a canvas stays a layer too.
    if is_shared_style(record) {
        let Some(parent) = record
            .get("parentIndex")
            .and_then(|parent| parent.get("guid"))
            .map(guid_string)
        else {
            return false;
        };
        let Some(parent_record) = records.get(&parent) else {
            return false;
        };
        return str_of(parent_record, "type") != Some("DOCUMENT")
            && !is_shared_style(parent_record);
    }
    true
}

pub(super) fn is_shared_style(record: &Value) -> bool {
    matches!(
        str_of(record, "styleType"),
        Some("FILL" | "STROKE" | "TEXT" | "EFFECT" | "GRID" | "EXPORT")
    )
}

pub(super) fn page_guides(record: &Value, page_id: &str) -> Result<Vec<RulerGuide>, Error> {
    let Some(guides) = record.get("guides") else {
        return Ok(Vec::new());
    };
    let Some(guides) = guides.as_array() else {
        return Err(Error::Unsupported(
            "FIG page guides must be an array; the source file was not modified".into(),
        ));
    };
    if guides.len() > 1000 {
        return Err(Error::Unsupported(
            "FIG page has more than 1000 guides; the source file was not modified".into(),
        ));
    }
    let mut out = Vec::with_capacity(guides.len());
    for (index, guide) in guides.iter().enumerate() {
        let axis = match str_of(guide, "axis") {
            Some("X" | "x") => "x",
            Some("Y" | "y") => "y",
            other => {
                return Err(Error::Unsupported(format!(
                    "FIG guide axis {other:?} is not X or Y; the source file was not modified"
                )));
            }
        };
        let position = guide
            .get("offset")
            .or_else(|| guide.get("position"))
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && v.abs() <= 1e7)
            .ok_or_else(|| {
                Error::Unsupported(
                    "FIG guide offset is missing or out of range; the source file was not modified"
                        .into(),
                )
            })?;
        let id = format!("{page_id}:g:{index}");
        if id.len() > 128 {
            return Err(Error::Unsupported(
                "FIG guide id exceeds 128 bytes; the source file was not modified".into(),
            ));
        }
        out.push(RulerGuide {
            id,
            axis: axis.into(),
            position,
        });
    }
    Ok(out)
}

fn push_untranslated(node: &mut Node, note: &str) {
    let mut notes: Vec<String> = node
        .bindings
        .get("figUntranslated")
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    if !notes.iter().any(|existing| existing == note) {
        notes.push(note.into());
    }
    node.bindings.insert(
        "figUntranslated".into(),
        serde_json::to_string(&notes).unwrap_or_else(|_| "[]".into()),
    );
}

fn style_source(record: &Value, style_type: &str) -> Value {
    let mut copy = record.clone();
    let scene_type = match style_type {
        "TEXT" => "TEXT",
        _ => "RECTANGLE",
    };
    if let Some(object) = copy.as_object_mut() {
        object.insert("type".into(), Value::String(scene_type.into()));
        object
            .entry("guid")
            .or_insert_with(|| serde_json::json!({"sessionID": 0, "localID": 0}));
    }
    copy
}

fn style_name(record: &Value, id: &str) -> Result<String, Error> {
    let name = str_of(record, "name").filter(|name| !name.trim().is_empty());
    let name = name.unwrap_or("Style").to_string();
    if name.len() > 512 || name.chars().any(char::is_control) {
        return Err(Error::Unsupported(format!(
            "FIG shared style {id} has a name that cannot be stored"
        )));
    }
    Ok(name)
}

fn build_style(
    importer: &FigImporter,
    record: &Value,
    in_scene: bool,
    notes: &mut Vec<String>,
) -> Result<Option<SharedStyle>, Error> {
    let style_type = str_of(record, "styleType").unwrap_or("");
    let id = guid_string(record.get("guid").unwrap_or(&Value::Null));
    if matches!(style_type, "GRID" | "EXPORT") {
        notes.push(format!(
            "shared style {id} ({style_type}) is retained as source metadata, not an executable style"
        ));
        return Ok(None);
    }
    let source = style_source(record, style_type);
    let mut local_notes = Vec::new();
    let node = match importer.node(&source, &mut local_notes) {
        Ok(node) => node,
        Err(error) if !in_scene => {
            notes.push(format!(
                "internal shared style {id} was not imported: {error}"
            ));
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    if !local_notes.is_empty() {
        notes.push(format!("shared style {id}: {}", local_notes.join("; ")));
    }
    let name = match style_name(record, &id) {
        Ok(name) => name,
        Err(error) if !in_scene => {
            notes.push(error.to_string());
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let style = match style_type {
        "FILL" => SharedStyle {
            name,
            kind: "paint".into(),
            value: serde_json::to_value(&node.fills)
                .map_err(|e| Error::Malformed(e.to_string()))?,
            strokes: Vec::new(),
            effects: Vec::new(),
        },
        "STROKE" => SharedStyle {
            name,
            kind: "paint".into(),
            value: serde_json::json!([]),
            strokes: node.strokes,
            effects: Vec::new(),
        },
        "TEXT" => {
            let Some(text) = node.text_style else {
                notes.push(format!("shared text style {id} has no text style"));
                return Ok(None);
            };
            SharedStyle {
                name,
                kind: "text".into(),
                value: serde_json::to_value(text).map_err(|e| Error::Malformed(e.to_string()))?,
                strokes: Vec::new(),
                effects: Vec::new(),
            }
        }
        "EFFECT" => SharedStyle {
            name,
            kind: "effect".into(),
            value: serde_json::to_value(&node.effects)
                .map_err(|e| Error::Malformed(e.to_string()))?,
            strokes: Vec::new(),
            effects: Vec::new(),
        },
        _ => return Ok(None),
    };
    Ok(Some(style))
}

fn guid_ref(record: &Value, key: &str) -> Option<String> {
    let value = record.get(key)?;
    if value.is_null() || !value.is_object() {
        return None;
    }
    Some(guid_string(value))
}

fn variant_map(name: &str) -> Option<BTreeMap<String, String>> {
    if !name.contains('=') {
        return None;
    }
    let mut map = BTreeMap::new();
    for part in name.split(',') {
        let (key, value) = part.trim().split_once('=')?;
        let key = key.trim();
        let value = value.trim();
        if key.is_empty()
            || value.is_empty()
            || key.len() > 128
            || value.len() > 128
            || key.chars().any(char::is_control)
            || value.chars().any(char::is_control)
            || map.contains_key(key)
        {
            return None;
        }
        map.insert(key.to_string(), value.to_string());
    }
    if map.is_empty() || map.len() > 16 {
        None
    } else {
        Some(map)
    }
}

pub(super) fn import_styles(
    doc: &mut Document,
    records: &BTreeMap<String, Value>,
    importer: &FigImporter,
    notes: &mut Vec<String>,
) -> Result<(), Error> {
    let mut styles = BTreeMap::new();
    let mut retained = Vec::new();
    for (id, record) in records {
        if !is_shared_style(record) {
            continue;
        }
        let style_type = str_of(record, "styleType").unwrap_or("");
        if matches!(style_type, "GRID" | "EXPORT") {
            retained.push(serde_json::json!({
                "id": id,
                "name": str_of(record, "name").unwrap_or(""),
                "styleType": style_type,
            }));
        }
        if let Some(style) =
            build_style(importer, record, include_in_scene(record, records), notes)?
        {
            styles.insert(id.clone(), style);
        }
    }
    if !styles.is_empty() {
        doc.design_system
            .get_or_insert_with(Default::default)
            .styles
            .extend(styles);
    }
    if !retained.is_empty() {
        doc.design_system
            .get_or_insert_with(Default::default)
            .sketch_containers
            .insert("figRetainedStyles".into(), Value::Array(retained));
    }
    let style_ids: BTreeSet<String> = doc
        .design_system
        .as_ref()
        .map(|system| system.styles.keys().cloned().collect())
        .unwrap_or_default();
    for (id, record) in records {
        let Some(node) = doc.nodes.get_mut(id) else {
            continue;
        };
        for (field, key) in [
            ("fills", "inheritFillStyleID"),
            ("textStyle", "inheritTextStyleID"),
            ("effects", "inheritEffectStyleID"),
        ] {
            if let Some(style_id) = guid_ref(record, key) {
                if style_ids.contains(&style_id) {
                    node.style_refs.insert(field.into(), style_id);
                } else {
                    push_untranslated(node, &format!("unresolved shared style {key}={style_id}"));
                }
            }
        }
        if guid_ref(record, "inheritFillStyleIDForStroke").is_some()
            || guid_ref(record, "inheritStrokeStyleID").is_some()
        {
            push_untranslated(
                node,
                "stroke style reference is preserved on the style, not applied to fills",
            );
        }
        if guid_ref(record, "inheritGridStyleID").is_some() {
            push_untranslated(node, "grid style reference is not executable");
        }
        if record
            .get("boundVariables")
            .is_some_and(|value| !value.is_null())
        {
            node.bindings.insert(
                "figBoundVariables".into(),
                serde_json::to_string(&record["boundVariables"]).unwrap_or_else(|_| "null".into()),
            );
            push_untranslated(
                node,
                "variable bindings retained as source metadata, not executable",
            );
        }
        if let Some(key) = str_of(record, "componentKey").filter(|key| !key.is_empty()) {
            node.bindings.insert("figComponentKey".into(), key.into());
        }
    }
    Ok(())
}

pub(super) fn apply_component_sets(
    doc: &mut Document,
    records: &BTreeMap<String, Value>,
    notes: &mut Vec<String>,
) -> Result<(), Error> {
    let sets: Vec<String> = records
        .iter()
        .filter_map(|(id, record)| {
            let is_set = str_of(record, "type") == Some("COMPONENT_SET")
                || bool_of(record, "isStateGroup") == Some(true);
            (is_set && doc.nodes.contains_key(id)).then_some(id.clone())
        })
        .collect();
    for id in sets {
        let children = doc.nodes[&id].children.clone();
        let name = doc.nodes[&id].name.clone();
        if children.is_empty() {
            let node = doc.nodes.get_mut(&id).unwrap();
            node.component = None;
            node.component_set = true;
            continue;
        }
        let mut parsed = Vec::new();
        let mut promoted = true;
        for child in &children {
            let Some(node) = doc.nodes.get(child) else {
                promoted = false;
                break;
            };
            let Some(component) = node.component.as_ref() else {
                promoted = false;
                break;
            };
            if component.variants.is_empty() {
                match variant_map(&node.name) {
                    Some(map) => parsed.push((child.clone(), map)),
                    None => {
                        promoted = false;
                        break;
                    }
                }
            } else {
                parsed.push((child.clone(), component.variants.clone()));
            }
        }
        if !promoted {
            notes.push(format!(
                "component set {name} was kept as a frame; variant names must be unique Key=Value pairs on main components"
            ));
            continue;
        }
        let axes: Vec<String> = parsed[0].1.keys().cloned().collect();
        let mut combinations = BTreeSet::new();
        if parsed
            .iter()
            .any(|(_, variants)| variants.keys().cloned().collect::<Vec<_>>() != axes)
            || parsed.iter().any(|(_, variants)| {
                !combinations.insert(serde_json::to_string(variants).unwrap_or_default())
            })
        {
            notes.push(format!(
                "component set {name} was kept as a frame; variant axes or combinations do not match"
            ));
            continue;
        }
        for (child, variants) in parsed {
            if let Some(component) = doc
                .nodes
                .get_mut(&child)
                .and_then(|node| node.component.as_mut())
            {
                component.variants = variants;
            }
        }
        let node = doc.nodes.get_mut(&id).unwrap();
        node.component = None;
        node.component_set = true;
    }
    Ok(())
}

fn authored_document_name(name: &str) -> Option<String> {
    if name.trim().is_empty() || name.encode_utf16().count() > 200 {
        None
    } else {
        Some(name.to_string())
    }
}

/// Variable sets are not layers. Their modes and values become design-system
/// collections. A value shape this kernel cannot execute is kept as a string
/// so the file still opens.
pub(super) fn import_variables(doc: &mut Document, records: &BTreeMap<String, Value>) {
    use crate::design_system::{Collection, Variable};
    let mut mode_names: BTreeMap<String, String> = BTreeMap::new();
    let mut collections: BTreeMap<String, Collection> = BTreeMap::new();
    for (id, record) in records {
        if str_of(record, "type") != Some("VARIABLE_SET") {
            continue;
        }
        let collection_id = str_of(record, "key").unwrap_or(id).to_string();
        let mut modes = Vec::new();
        if let Some(list) = record.get("variableSetModes").and_then(Value::as_array) {
            for mode in list {
                let name = str_of(mode, "name").filter(|n| !n.is_empty()).unwrap_or("Mode");
                if let Some(mode_id) = mode.get("id") {
                    mode_names.insert(guid_string(mode_id), name.to_string());
                }
                if !modes.iter().any(|existing: &String| existing == name) {
                    modes.push(name.to_string());
                }
            }
        }
        if modes.is_empty() {
            modes.push("Default".into());
        }
        if modes.len() > 32 {
            continue;
        }
        collections.insert(
            collection_id,
            Collection {
                name: str_of(record, "name").unwrap_or("Variables").to_string(),
                default_mode: modes[0].clone(),
                modes,
            },
        );
    }
    let mut variables: BTreeMap<String, Variable> = BTreeMap::new();
    for (id, record) in records {
        if str_of(record, "type") != Some("VARIABLE") {
            continue;
        }
        let from_guid = record.get("variableSetID").map(guid_string);
        let collection = record
            .get("variableSetID")
            .and_then(|value| value.get("assetRef"))
            .and_then(|value| str_of(value, "key"))
            .filter(|key| !key.is_empty())
            .map(str::to_string)
            .or_else(|| from_guid.filter(|value| !value.is_empty() && value != "0:0"))
            .unwrap_or_else(|| id.clone());
        if !collections.contains_key(&collection) {
            collections.insert(
                collection.clone(),
                Collection {
                    name: collection.clone(),
                    modes: vec!["Default".into()],
                    default_mode: "Default".into(),
                },
            );
        }
        let kind = match str_of(record, "variableResolvedType").unwrap_or("") {
            "COLOR" => "color",
            "FLOAT" | "NUMBER" => "number",
            "BOOLEAN" => "boolean",
            "STRING" => "string",
            _ => "string",
        };
        let mut values = BTreeMap::new();
        if let Some(entries) = record
            .get("variableDataValues")
            .and_then(|value| value.get("entries"))
            .and_then(Value::as_array)
        {
            for entry in entries {
                let mode = entry
                    .get("modeID")
                    .map(guid_string)
                    .and_then(|id| mode_names.get(&id).cloned())
                    .unwrap_or_else(|| "Default".into());
                if let Some(value) = variable_value(entry.get("variableData").unwrap_or(&Value::Null), kind)
                {
                    values.insert(mode, value);
                }
            }
        }
        let Some(collection_modes) = collections.get(&collection).map(|c| c.modes.clone()) else {
            continue;
        };
        if collection_modes.len() > 32 {
            continue;
        }
        if values.is_empty() {
            let fallback = match kind {
                "boolean" => Value::Bool(false),
                "number" => Value::from(0.),
                "color" => Value::String("#000000".into()),
                _ => Value::String(String::new()),
            };
            values.insert(collection_modes[0].clone(), fallback);
        }
        let fallback = values.values().next().cloned().unwrap_or(Value::Null);
        for mode in &collection_modes {
            values.entry(mode.clone()).or_insert_with(|| fallback.clone());
        }
        values.retain(|mode, _| collection_modes.iter().any(|name| name == mode));
        variables.insert(
            id.clone(),
            Variable {
                name: str_of(record, "name").unwrap_or("Variable").to_string(),
                collection,
                kind: kind.into(),
                values,
            },
        );
    }
    if collections.is_empty() && variables.is_empty() {
        return;
    }
    let system = doc.design_system.get_or_insert_with(Default::default);
    system.collections.extend(collections);
    system.variables.extend(variables);
    for (id, collection) in &system.collections {
        system
            .active_modes
            .entry(id.clone())
            .or_insert_with(|| collection.default_mode.clone());
    }
}

fn variable_value(data: &Value, kind: &str) -> Option<Value> {
    let value = data.get("value")?;
    if let Some(alias) = value.get("alias").or_else(|| value.get("variableAlias")) {
        let id = guid_string(alias);
        if !id.is_empty() && id != "0:0" {
            return Some(serde_json::json!({ "alias": id }));
        }
    }
    match kind {
        "color" => value.get("colorValue").and_then(color_value),
        "number" => value
            .get("floatValue")
            .or_else(|| value.get("numberValue"))
            .filter(|v| v.is_number())
            .cloned(),
        "boolean" => value.get("boolValue").filter(|v| v.is_boolean()).cloned(),
        _ => value
            .get("textValue")
            .and_then(|v| v.get("characters"))
            .or_else(|| value.get("stringValue"))
            .filter(|v| v.is_string())
            .cloned()
            .or_else(|| Some(Value::String(value.to_string()))),
    }
}

fn color_value(color: &Value) -> Option<Value> {
    let channel = |key: &str| color.get(key).and_then(Value::as_f64);
    let (r, g, b) = (channel("r")?, channel("g")?, channel("b")?);
    let a = channel("a").unwrap_or(1.);
    if [r, g, b, a].iter().any(|v| !v.is_finite() || !(0. ..=1.).contains(v)) {
        return None;
    }
    let byte = |v: f64| (v * 255.).round() as u8;
    let text = if (a - 1.).abs() < 1e-6 {
        format!("#{:02x}{:02x}{:02x}", byte(r), byte(g), byte(b))
    } else {
        format!("color(srgb {r} {g} {b} / {a})")
    };
    Some(Value::String(text))
}

pub(super) fn write_receipt(
    doc: &mut Document,
    records: &BTreeMap<String, Value>,
    tree: &Value,
    internal_pages: &[String],
    notes: &[String],
) {
    let document = records
        .values()
        .find(|record| str_of(record, "type") == Some("DOCUMENT"));
    let mut receipt = Map::new();
    receipt.insert("source".into(), Value::String("figma".into()));
    if let Some(document) = document {
        receipt.insert(
            "documentId".into(),
            Value::String(guid_string(document.get("guid").unwrap_or(&Value::Null))),
        );
        if let Some(name) = str_of(document, "name") {
            if let Some(name) = authored_document_name(name) {
                doc.name = name;
            } else {
                receipt.insert(
                    "unusableDocumentName".into(),
                    Value::String(name.to_string()),
                );
            }
        }
        for key in ["documentColorProfile", "colorProfile"] {
            if let Some(profile) = str_of(document, key) {
                receipt.insert("colorProfile".into(), Value::String(profile.into()));
                break;
            }
        }
    }
    if !internal_pages.is_empty() {
        receipt.insert(
            "internalPages".into(),
            Value::Array(internal_pages.iter().cloned().map(Value::String).collect()),
        );
    }
    let mut stored_notes: Vec<String> = notes
        .iter()
        .filter(|note| !note.is_empty())
        .take(32)
        .cloned()
        .collect();
    if let Some(variables) = bounded_variables(tree) {
        if variables.get("omitted").and_then(Value::as_bool) == Some(true) {
            stored_notes.push(
                "variable payload exceeds the 256 KiB inert metadata budget and was not copied"
                    .into(),
            );
        }
        receipt.insert("variables".into(), variables);
    }
    if stored_notes.len() < notes.len() {
        stored_notes.push(format!(
            "{} additional document notes omitted",
            notes.len().saturating_sub(stored_notes.len())
        ));
    }
    if !stored_notes.is_empty() {
        receipt.insert(
            "notes".into(),
            Value::Array(stored_notes.into_iter().map(Value::String).collect()),
        );
    }
    doc.design_system
        .get_or_insert_with(Default::default)
        .sketch_containers
        .insert("figDocument".into(), Value::Object(receipt));
}

fn bounded_variables(tree: &Value) -> Option<Value> {
    let mut map = Map::new();
    for key in [
        "variables",
        "variableCollections",
        "variableSets",
        "variableModes",
    ] {
        if let Some(value) = tree.get(key) {
            map.insert(key.into(), value.clone());
        }
    }
    if map.is_empty() {
        return None;
    }
    match serde_json::to_vec(&map) {
        Ok(encoded) if encoded.len() <= 256 * 1024 => Some(Value::Object(map)),
        _ => Some(serde_json::json!({"omitted": true})),
    }
}

pub(super) fn raise_schema(doc: &Document, version: &mut u32) {
    if doc.design_system.is_some() {
        *version = (*version).max(4);
    }
    if doc.pages.iter().any(|page| !page.guides.is_empty()) {
        *version = (*version).max(11);
    }
    if doc.design_system.as_ref().is_some_and(|system| {
        system
            .styles
            .values()
            .any(|style| !style.strokes.is_empty() || !style.effects.is_empty())
    }) {
        *version = (*version).max(12);
    }
    if doc.requires_schema17() {
        *version = (*version).max(17);
    }
    if doc.requires_schema18() {
        *version = (*version).max(18);
    }
    if doc.requires_schema19() {
        *version = (*version).max(19);
    }
    if doc.requires_schema20() {
        *version = (*version).max(20);
    }
}
