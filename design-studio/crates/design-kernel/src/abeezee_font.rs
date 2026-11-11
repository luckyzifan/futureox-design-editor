//! Bundled ABeeZee Regular and Italic retain their exact face identities.
//! Missing cuts stay on the fallback font and are diagnosed by name.
//! The import receipt records line breaks and text-box measurements for a
//! single pinned face used by the Sketch node.
use crate::{font::Fonts, scene::Document};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const UNEMBEDDED_FONT_WARNING: &str = "Sketch: fonts without embedded resources use the default font; source font names remain in metadata.";
pub const ABEEZEE_REGULAR_SHA256: &str =
    "2901c8df256648cc2bb2e3afb381cb8d28e65ed3dbe11de20695ae4d5ffdeda9";
pub const ABEEZEE_ITALIC_SHA256: &str =
    "3892bb74578207ed6edae040a0869e54dcae13a466d005460570947062137dd8";
const BUNDLED_ITALIC: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../frontend/design-client/public/fonts/abeezee/ABeeZee-Italic.ttf"
));
const BUNDLED_REGULAR: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../frontend/design-client/public/fonts/abeezee/ABeeZee-Regular.ttf"
));
const RECEIPT: &str = "sketchPinnedFontLines";
const ABSENT: &str = "sketchAbsentFontFace";

pub(crate) struct PinnedAbeezee {
    pub warnings: Vec<String>,
    pub changed: Vec<String>,
    pub unembedded_remain: bool,
}

fn compact(name: &str) -> String {
    name.chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-' | '\u{00a0}'))
        .flat_map(|c| c.to_lowercase())
        .collect()
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Cut {
    Regular,
    Italic,
}

impl Cut {
    fn postscript(self) -> &'static str {
        match self {
            Self::Regular => "ABeeZee-Regular",
            Self::Italic => "ABeeZee-Italic",
        }
    }

    fn bundled(self) -> (&'static [u8], &'static str) {
        match self {
            Self::Regular => (BUNDLED_REGULAR, ABEEZEE_REGULAR_SHA256),
            Self::Italic => (BUNDLED_ITALIC, ABEEZEE_ITALIC_SHA256),
        }
    }
}

fn requested_cut(name: &str) -> Option<Cut> {
    match compact(name).as_str() {
        "abeezee" | "abeezeeregular" | "abeezeenormal" | "abeezeeroman" => Some(Cut::Regular),
        "abeezeeitalic" => Some(Cut::Italic),
        _ => None,
    }
}

fn postscript_cut(postscript: &str) -> Option<Cut> {
    match postscript {
        "ABeeZee-Regular" => Some(Cut::Regular),
        "ABeeZee-Italic" => Some(Cut::Italic),
        _ => None,
    }
}

pub fn absent_abeezee_diagnosis(name: &str) -> Option<String> {
    if !compact(name).starts_with("abeezee") || requested_cut(name).is_some() {
        return None;
    }
    Some(format!(
        "字体 {name} 没有同名随包文件。不能把 Regular 或 Italic 的换行当成这个请求的结果。文字已保留，显示用当前回退。"
    ))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn decode_font(data: &str) -> Option<Vec<u8>> {
    let data = data
        .split_once(',')
        .map(|(_, payload)| payload)
        .unwrap_or(data);
    let bytes = STANDARD.decode(data).ok()?;
    if bytes.len() > 20 * 1024 * 1024 {
        return None;
    }
    Some(bytes)
}

fn face_postscript(bytes: &[u8], index: u32) -> Option<String> {
    let face = ttf_parser::Face::parse(bytes, index).ok()?;
    face.names()
        .into_iter()
        .filter(|name| name.name_id == ttf_parser::name_id::POST_SCRIPT_NAME)
        .find_map(|name| name.to_string())
        .filter(|name| !name.is_empty())
}

fn face_family(bytes: &[u8], index: u32) -> Option<String> {
    let face = ttf_parser::Face::parse(bytes, index).ok()?;
    face.names()
        .into_iter()
        .filter(|name| name.name_id == ttf_parser::name_id::FAMILY)
        .find_map(|name| name.to_string())
        .filter(|name| !name.is_empty())
}

fn mentions(value: &str) -> bool {
    compact(value).contains("abeezee")
}

struct SourceFonts {
    style: Option<String>,
    runs: Vec<(usize, String)>,
}

fn source_fonts(document: &Document, id: &str) -> SourceFonts {
    let Some(raw) = document
        .design_system
        .as_ref()
        .and_then(|system| system.sketch_containers.get("nodeMetadata"))
        .and_then(|metadata| metadata.get(id))
        .and_then(|entry| entry.get("bindings"))
        .and_then(|bindings| bindings.get("sketchSourceFonts"))
        .and_then(Value::as_str)
    else {
        return SourceFonts {
            style: None,
            runs: Vec::new(),
        };
    };
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return SourceFonts {
            style: None,
            runs: Vec::new(),
        };
    };
    let style = value
        .get("style")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut runs = Vec::new();
    if let Some(map) = value.get("runs").and_then(Value::as_object) {
        for (key, name) in map {
            if let (Ok(index), Some(name)) = (key.parse::<usize>(), name.as_str()) {
                runs.push((index, name.to_owned()));
            }
        }
    }
    SourceFonts { style, runs }
}

fn font_label_matches(document: &Document, id: &str) -> bool {
    if mentions(id) {
        return true;
    }
    let Some(font) = document.fonts.get(id) else {
        return false;
    };
    mentions(&font.family) || font.postscript.as_deref().is_some_and(mentions)
}

fn resource_cut(document: &Document, id: &str) -> Option<Cut> {
    let font = document.fonts.get(id)?;
    if let Some(cut) = font.postscript.as_deref().and_then(postscript_cut) {
        return Some(cut);
    }
    if !font_label_matches(document, id) {
        return None;
    }
    decode_font(&font.data)
        .and_then(|bytes| face_postscript(&bytes, font.index))
        .as_deref()
        .and_then(postscript_cut)
}

fn document_mentions_abeezee(document: &Document) -> bool {
    document.nodes.values().any(|node| {
        if node.kind != "text" {
            return false;
        }
        let source = source_fonts(document, &node.id);
        if source.style.as_deref().is_some_and(mentions)
            || source.runs.iter().any(|(_, name)| mentions(name))
        {
            return true;
        }
        node.text_style
            .as_ref()
            .is_some_and(|style| font_label_matches(document, &style.font_id))
            || node
                .text_runs
                .iter()
                .filter_map(|run| run.font_id.as_deref())
                .any(|id| font_label_matches(document, id))
    })
}

struct PinnedFace {
    id: String,
    sha256: String,
}

fn install_cut(document: &mut Document, cut: Cut) -> Option<PinnedFace> {
    let requested = cut.postscript();
    if let Some(found) = document.fonts.iter().find_map(|(id, font)| {
        let bytes = decode_font(&font.data)?;
        let postscript = face_postscript(&bytes, font.index)?;
        if postscript != requested {
            return None;
        }
        Some(PinnedFace {
            id: id.clone(),
            sha256: sha256_hex(&bytes),
        })
    }) {
        return Some(found);
    }
    let (bytes, expected_sha) = cut.bundled();
    let sha = sha256_hex(bytes);
    if sha != expected_sha || face_postscript(bytes, 0).as_deref() != Some(requested) {
        return None;
    }
    let id = format!("{sha}-0");
    if document.fonts.contains_key(&id) || document.fonts.len() >= 32 {
        return None;
    }
    let family = face_family(bytes, 0).unwrap_or_else(|| "ABeeZee".into());
    document.fonts.insert(
        id.clone(),
        crate::font::FontResource {
            family,
            data: STANDARD.encode(bytes).into(),
            index: 0,
            postscript: Some(requested.into()),
        },
    );
    Some(PinnedFace { id, sha256: sha })
}

fn unembedded_source_remains(document: &Document) -> bool {
    document.nodes.values().any(|node| {
        if node.kind != "text" {
            return false;
        }
        let source = source_fonts(document, &node.id);
        let style_missing = source.style.is_some()
            && node
                .text_style
                .as_ref()
                .is_some_and(|style| style.font_id == "default");
        let run_missing = source.runs.iter().any(|(index, _)| {
            node.text_runs
                .get(*index)
                .and_then(|run| run.font_id.as_deref())
                .unwrap_or("default")
                == "default"
        });
        style_missing || run_missing
    })
}

fn binding_mut<'a>(
    document: &'a mut Document,
    id: &str,
) -> Option<&'a mut serde_json::Map<String, Value>> {
    document.schema_version = document.schema_version.max(4);
    let system = document.design_system.get_or_insert_with(Default::default);
    let metadata = system
        .sketch_containers
        .entry("nodeMetadata".into())
        .or_insert_with(|| json!({}));
    let metadata = metadata.as_object_mut()?;
    let entry = metadata
        .entry(id.to_owned())
        .or_insert_with(|| json!({"bindings": {}, "styleRefs": {}}));
    let entry = entry.as_object_mut()?;
    if !entry.get("bindings").is_some_and(Value::is_object) {
        entry.insert("bindings".into(), json!({}));
    }
    entry.get_mut("bindings")?.as_object_mut()
}

fn native_box(document: &Document, id: &str, node: &crate::scene::Node) -> (f64, f64) {
    let stored = document
        .design_system
        .as_ref()
        .and_then(|system| system.sketch_containers.get("textSourceLayouts"))
        .and_then(|layouts| layouts.get(id));
    let width = stored
        .and_then(|entry| entry.get("width"))
        .and_then(Value::as_f64);
    let height = stored
        .and_then(|entry| entry.get("height"))
        .and_then(Value::as_f64);
    (width.unwrap_or(node.width), height.unwrap_or(node.height))
}

pub(crate) fn exported_absent_face(
    document: &Document,
    node: &crate::scene::Node,
) -> Option<String> {
    let raw = node.bindings.get(ABSENT).map(String::as_str).or_else(|| {
        document
            .design_system
            .as_ref()
            .and_then(|system| system.sketch_containers.get("nodeMetadata"))
            .and_then(|metadata| metadata.get(&node.id))
            .and_then(|entry| entry.get("bindings"))
            .and_then(|bindings| bindings.get(ABSENT))
            .and_then(Value::as_str)
    })?;
    let entries = serde_json::from_str::<Vec<Value>>(raw).ok()?;
    let mut names: Vec<String> = entries
        .iter()
        .filter_map(|entry| entry.get("name").and_then(Value::as_str).map(str::to_owned))
        .filter(|name| {
            compact(name).starts_with("abeezee") && requested_cut(name) != Some(Cut::Regular)
        })
        .collect();
    names.sort();
    names.dedup();
    if names.len() == 1 { names.pop() } else { None }
}

pub(crate) fn pin_imported_faces(document: &mut Document) -> PinnedAbeezee {
    if !document_mentions_abeezee(document) {
        return PinnedAbeezee {
            warnings: Vec::new(),
            changed: Vec::new(),
            unembedded_remain: unembedded_source_remains(document),
        };
    }
    let mut warnings = BTreeSet::new();
    let mut changed = BTreeSet::new();
    let mut measure_ids = Vec::new();
    let mut absent_ids = Vec::new();
    let node_ids: Vec<String> = document
        .nodes
        .iter()
        .filter(|(_, node)| node.kind == "text")
        .map(|(id, _)| id.clone())
        .collect();
    let mut needed = BTreeSet::new();
    let mut plans = Vec::new();
    for id in &node_ids {
        let source = source_fonts(document, id);
        let node = &document.nodes[id];
        let mut diagnoses = Vec::new();
        let mut pin_style = None;
        let mut pin_runs = Vec::new();
        if let Some(name) = source.style {
            if let Some(message) = absent_abeezee_diagnosis(&name) {
                diagnoses.push((name, message));
            } else if node
                .text_style
                .as_ref()
                .is_some_and(|style| style.font_id == "default")
            {
                pin_style = requested_cut(&name);
            }
        }
        for (index, name) in source.runs {
            if let Some(message) = absent_abeezee_diagnosis(&name) {
                diagnoses.push((name, message));
            } else if let Some(cut) = requested_cut(&name)
                && node
                    .text_runs
                    .get(index)
                    .is_some_and(|run| run.font_id.as_deref().unwrap_or("default") == "default")
            {
                pin_runs.push((index, cut));
            }
        }
        needed.extend(pin_style);
        needed.extend(pin_runs.iter().map(|(_, cut)| *cut));
        needed.extend(
            node.text_style
                .iter()
                .map(|style| style.font_id.as_str())
                .chain(
                    node.text_runs
                        .iter()
                        .filter_map(|run| run.font_id.as_deref()),
                )
                .filter_map(|id| resource_cut(document, id)),
        );
        plans.push((id.clone(), pin_style, pin_runs, diagnoses));
    }
    let faces: BTreeMap<_, _> = needed
        .into_iter()
        .filter_map(|cut| install_cut(document, cut).map(|face| (cut, face)))
        .collect();
    for (id, pin_style, pin_runs, diagnoses) in plans {
        if !diagnoses.is_empty() {
            warnings.extend(diagnoses.iter().map(|(_, message)| message.clone()));
            absent_ids.push((id.clone(), diagnoses));
        }
        let node = document.nodes.get_mut(&id).unwrap();
        if let Some(face) = pin_style.and_then(|cut| faces.get(&cut))
            && let Some(style) = &mut node.text_style
        {
            style.font_id = face.id.clone();
            changed.insert(id.clone());
        }
        for (index, cut) in pin_runs {
            if let Some(face) = faces.get(&cut) {
                node.text_runs[index].font_id = Some(face.id.clone());
                changed.insert(id.clone());
            }
        }
        let mut used = faces.iter().filter(|(_, face)| {
            node.text_style
                .as_ref()
                .is_some_and(|style| style.font_id == face.id)
                || node
                    .text_runs
                    .iter()
                    .any(|run| run.font_id.as_deref() == Some(face.id.as_str()))
        });
        if let Some((&cut, _)) = used.next()
            && used.next().is_none()
        {
            measure_ids.push((id, cut));
        }
    }
    let mut receipts = Vec::new();
    if !measure_ids.is_empty()
        && let Ok(fonts) = Fonts::new().with_resources(&document.fonts)
    {
        for (id, cut) in measure_ids {
            let face = &faces[&cut];
            let Some(node) = document.nodes.get(&id) else {
                continue;
            };
            let Some(style) = node.text_style.as_ref() else {
                continue;
            };
            let width = style.wrap.then_some(node.width);
            let Ok(layout) = fonts.node_measure(node, width) else {
                continue;
            };
            let (native_width, native_height) = native_box(document, &id, node);
            let request = !absent_ids.iter().any(|(absent, _)| absent == &id);
            let receipt = json!({
                "kind": "pinned-font-file",
                "basis": "pinned-font-file",
                "postscript": cut.postscript(),
                "sha256": face.sha256,
                "lineCount": layout.lines.len(),
                "breaks": layout.lines.iter().map(|line| json!({"start": line.start, "end": line.end})).collect::<Vec<_>>(),
                "measuredBox": {"width": layout.width, "height": layout.height},
                "nativeBox": {"width": native_width, "height": native_height},
                "authoredTextBoxPreserved": node.width == native_width && node.height == native_height,
                "measuredHeightMatchesNativeBox": layout.height == native_height,
                "pinnedFaceIsTheRequest": request,
                "glyphPixels": false
            });
            receipts.push((id, receipt.to_string()));
        }
    }
    for (id, diagnoses) in absent_ids {
        if let Some(bindings) = binding_mut(document, &id) {
            let payload = diagnoses
                .iter()
                .map(|(name, diagnosis)| json!({"name": name, "diagnosis": diagnosis}))
                .collect::<Vec<_>>();
            bindings.insert(
                ABSENT.into(),
                Value::String(serde_json::to_string(&payload).unwrap_or_else(|_| "[]".into())),
            );
        }
    }
    for (id, receipt) in receipts {
        if let Some(bindings) = binding_mut(document, &id) {
            bindings.insert(RECEIPT.into(), Value::String(receipt));
        }
    }
    PinnedAbeezee {
        warnings: warnings.into_iter().collect(),
        changed: changed.into_iter().collect(),
        unembedded_remain: unembedded_source_remains(document),
    }
}
