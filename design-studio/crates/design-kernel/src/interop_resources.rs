//! Official Sketch FontRef/MSFontData resources. Inline font bytes remain exact,
//! including copyright/license name records. Export is for caller-authorized
//! portable document resources: fsType is a technical restriction, not a license.
use crate::{font::FontResource, interop::Error, scene::Document};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::{borrow::Cow, collections::BTreeMap};

const FONT_LIMIT: usize = 20 * 1024 * 1024;
const TOTAL_LIMIT: usize = 24 * 1024 * 1024;
fn invalid(message: impl Into<String>) -> Error {
    Error::Unsupported(message.into())
}
fn decode(data: &str) -> Result<Vec<u8>, Error> {
    if data.len() > FONT_LIMIT.div_ceil(3) * 4 {
        return Err(invalid("Sketch font exceeds 20 MiB"));
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| invalid("Invalid embedded Sketch font base64"))?;
    if bytes.len() > FONT_LIMIT {
        return Err(invalid("Sketch font exceeds 20 MiB"));
    }
    Ok(bytes)
}
fn face_name(face: &ttf_parser::Face<'_>, name_id: u16) -> Option<String> {
    face.names()
        .into_iter()
        .filter(|n| n.name_id == name_id)
        .find_map(|n| n.to_string())
        .filter(|s| !s.is_empty())
}
fn check_embedding(face: &ttf_parser::Face<'_>) -> Result<(), Error> {
    if face.tables().os2.is_some()
        && (!matches!(
            face.permissions(),
            Some(ttf_parser::Permissions::Installable | ttf_parser::Permissions::Editable)
        ) || !face.is_outline_embedding_allowed())
    {
        return Err(invalid(
            "Font embedding flags prohibit editable outline embedding; preserve the native document and obtain a licensed font",
        ));
    }
    Ok(())
}

fn valid_installed_reference(reference: &Value) -> bool {
    reference["_class"] == "fontReference" && reference.get("fontData").is_none()
        && reference["fontFamilyName"].as_str().is_some_and(|name| !name.is_empty())
        && reference["postscriptNames"].as_array().is_some_and(|names| !names.is_empty()
            && names.iter().all(|name| name.as_str().is_some_and(|s| !s.is_empty())))
}

pub(crate) fn export_fonts(doc: &Document, output: &mut Value) -> Result<(), Error> {
    if doc.fonts.len() > 32 {
        return Err(invalid("Sketch export exceeds 32 font resources"));
    }
    let mut refs = Vec::new();
    let mut identities = Vec::new();
    let mut names = BTreeMap::new();
    let mut total = 0usize;
    for (id, font) in &doc.fonts {
        let bytes = decode(&font.data)?;
        total += bytes.len();
        if total > TOTAL_LIMIT {
            return Err(invalid("Sketch font resources exceed 24 MiB"));
        }
        let face = ttf_parser::Face::parse(&bytes, font.index)
            .map_err(|_| invalid(format!("Invalid font resource `{id}` or face index")))?;
        check_embedding(&face)?;
        let name = font
            .postscript
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| face_name(&face, ttf_parser::name_id::POST_SCRIPT_NAME))
            .unwrap_or_else(|| font.family.clone());
        let hash = Sha1::digest(&bytes);
        let hex = format!("{hash:x}");
        if let Some(previous) = names.insert(name.clone(), (hex.clone(), font.index)) {
            if previous != (hex.clone(), font.index) {
                return Err(invalid(format!(
                    "Conflicting embedded fonts share Sketch PostScript name `{name}`"
                )));
            }
        }
        // A collection must carry all its data; no subsetting or license-table removal.
        // Check every face because all of them are transmitted in the collection.
        if let Some(count) = ttf_parser::fonts_in_collection(&bytes) {
            for index in 0..count {
                let f = ttf_parser::Face::parse(&bytes, index)
                    .map_err(|_| invalid("Malformed font collection"))?;
                check_embedding(&f)?;
            }
        }
        let suffix = if bytes.starts_with(b"ttcf") {
            "ttc"
        } else if bytes.starts_with(b"OTTO") {
            "otf"
        } else {
            "ttf"
        };
        refs.push(json!({"_class":"fontReference", "fontFamilyName":font.family,
            "fontFileName":format!("{hex}.{suffix}"),"options":0,"postscriptNames":[name],
            "fontData":{"_class":"MSJSONOriginalDataReference","_ref_class":"MSFontData",
                "_ref":format!("fonts/{hex}"),"data":{"_data":STANDARD.encode(&bytes)},"sha1":{"_data":STANDARD.encode(hash)}}}));
        identities.push(json!({"sha1":hex,"id":id,"index":font.index,"family":font.family,"postscript":font.postscript,"name":name}));
    }
    if let Some(value) = doc.design_system.as_ref().and_then(|s| s.sketch_containers.get("nonEmbeddedFontReferences")) {
        let installed = value.as_array().ok_or_else(|| invalid("Invalid Sketch installed font declarations"))?;
        if installed.len().saturating_add(refs.len()) > crate::sketch::archive::MAX_ENTRIES ||
            !installed.iter().all(valid_installed_reference) {
            return Err(invalid("Invalid Sketch installed font declarations"));
        }
        refs.extend(installed.iter().cloned());
    }
    output["fontReferences"] = Value::Array(refs);
    if !identities.is_empty() {
        if !output["userInfo"].is_object() {
            output["userInfo"] = json!({});
        }
        if !output["userInfo"]["com.futureox.design-kernel"].is_object() {
            output["userInfo"]["com.futureox.design-kernel"] = json!({});
        }
        output["userInfo"]["com.futureox.design-kernel"]["fontIdentities"] =
            Value::Array(identities);
    }
    Ok(())
}

pub(crate) fn import_fonts(
    source: &Value, files: &BTreeMap<String, Vec<u8>>, doc: &mut Document,
) -> Result<BTreeMap<String,String>, Error> {
    let Some(refs) = source.get("fontReferences") else {
        return Ok(BTreeMap::new());
    };
    let refs = refs
        .as_array()
        .ok_or_else(|| invalid("Sketch fontReferences must be an array"))?;
    if refs.len() > crate::sketch::archive::MAX_ENTRIES {
        return Err(invalid("Sketch font declaration limit exceeded"));
    }
    if refs.iter().filter(|r| r.get("fontData").is_some()).take(33).count() > 32 {
        return Err(invalid("Sketch import exceeds 32 embedded font resources"));
    }
    let identities = source
        .pointer("/userInfo/com.futureox.design-kernel/fontIdentities")
        .and_then(Value::as_array);
    let mut aliases = BTreeMap::<String, String>::new();
    let mut total = 0usize;
    let mut installed_bytes = 0usize;
    let mut nonembedded = Vec::new();
    for (position, reference) in refs.iter().enumerate() {
        // Installed-font declarations need no bytes. A present malformed
        // fontData must still fail rather than silently becoming a fallback.
        if reference.get("fontData").is_none() && reference["_class"] == "fontReference" {
            if !valid_installed_reference(reference) {
                return Err(invalid("Malformed Sketch non-embedded font declaration"));
            }
            nonembedded.push(reference.clone());
            continue;
        }
        let data = &reference["fontData"];
        if reference["_class"] != "fontReference" || data["_ref_class"] != "MSFontData" {
            return Err(invalid("Unsupported Sketch embedded font reference; keep original archive"));
        }
        let bytes: Cow<'_, [u8]> = match data["_class"].as_str() {
            Some("MSJSONOriginalDataReference") => Cow::Owned(decode(
                data.pointer("/data/_data").and_then(Value::as_str)
                    .ok_or_else(|| invalid("Sketch embedded font bytes are missing"))?,
            )?),
            Some("MSJSONFileReference") => {
                let path = data["_ref"].as_str().filter(|path| path.strip_prefix("fonts/")
                    .is_some_and(|name| !name.is_empty() && !matches!(name, "." | "..") &&
                        !name.contains(['/', '\\', '\0'])))
                    .ok_or_else(|| invalid("Invalid Sketch font archive reference"))?;
                let file = files.get(path).ok_or_else(|| invalid("Sketch font archive entry is missing"))?;
                if file.len() > FONT_LIMIT {
                    return Err(invalid("Sketch font exceeds 20 MiB"));
                }
                if data.get("data").is_some() {
                    return Err(invalid("Ambiguous Sketch file-backed font data"));
                }
                Cow::Borrowed(file)
            }
            _ => return Err(invalid("Unsupported Sketch embedded font reference; keep original archive")),
        };
        total += bytes.len();
        if total > TOTAL_LIMIT {
            return Err(invalid("Sketch font resources exceed 24 MiB"));
        }
        let hash = Sha1::digest(&bytes);
        let hex = format!("{hash:x}");
        let digest = data
            .pointer("/sha1/_data")
            .and_then(Value::as_str)
            .and_then(|s| STANDARD.decode(s).ok());
        if (data["_class"] == "MSJSONOriginalDataReference" || data.get("sha1").is_some())
            && digest.as_deref() != Some(hash.as_slice()) {
            return Err(invalid(
                "Sketch embedded font SHA-1 does not match its bytes",
            ));
        }
        let native = identities
            .and_then(|v| v.get(position))
            .filter(|v| v["sha1"] == hex);
        let postscript_names = reference["postscriptNames"]
            .as_array()
            .ok_or_else(|| invalid("Sketch font postscriptNames must be an array"))?;
        let count = ttf_parser::fonts_in_collection(&bytes).unwrap_or(1);
        // A native identity selects the exact collection face. External Sketch
        // references can expose several faces from a single embedded collection.
        let indices: Vec<u32> = if let Some(index) = native.and_then(|v| v["index"].as_u64()) {
            vec![u32::try_from(index).map_err(|_| invalid("Invalid embedded font index"))?]
        } else {
            (0..count).collect()
        };
        let mut resolved = false;
        for index in indices {
            let face = ttf_parser::Face::parse(&bytes, index)
                .map_err(|_| invalid("Invalid embedded Sketch font or face index"))?;
            let ps = face_name(&face, ttf_parser::name_id::POST_SCRIPT_NAME);
            let family = face_name(&face, ttf_parser::name_id::FAMILY).unwrap_or_else(|| {
                reference["fontFamilyName"]
                    .as_str()
                    .unwrap_or("Embedded font")
                    .into()
            });
            let names: Vec<String> = postscript_names
                .iter()
                .filter_map(Value::as_str)
                .filter(|name| count == 1 || ps.as_deref() == Some(*name))
                .map(str::to_owned)
                .collect();
            if names.is_empty() {
                continue;
            }
            resolved = true;
            let id = native
                .and_then(|v| v["id"].as_str())
                .unwrap_or(&names[0])
                .to_owned();
            if id.is_empty() || id == "default" || id.len() > 128 {
                return Err(invalid("Invalid embedded font resource identity"));
            }
            if !doc.fonts.contains_key(&id) {
                installed_bytes += bytes.len();
                if installed_bytes > TOTAL_LIMIT {
                    return Err(invalid(
                        "Sketch font faces exceed 24 MiB document resource budget",
                    ));
                }
            }
            let resource = FontResource {
                family: native
                    .and_then(|v| v["family"].as_str())
                    .unwrap_or(&family)
                    .into(),
                data: STANDARD.encode(&bytes).into(),
                index,
                postscript: native
                    .map(|v| v["postscript"].as_str().map(str::to_owned))
                    .unwrap_or(ps),
            };
            if let Some(existing) = doc.fonts.get(&id) {
                if existing != &resource {
                    return Err(invalid("Conflicting embedded Sketch font resources"));
                }
            } else {
                if doc.fonts.len() >= 32 {
                    return Err(invalid("Sketch import exceeds 32 font faces"));
                }
                doc.fonts.insert(id.clone(), resource);
            }
            for name in names {
                if let Some(previous) = aliases.get(&name) {
                    let a = &doc.fonts[previous];
                    let b = &doc.fonts[&id];
                    if a.data != b.data || a.index != b.index {
                        return Err(invalid("Conflicting Sketch PostScript font names"));
                    }
                }
                aliases.entry(name).or_insert_with(|| id.clone());
            }
        }
        if !resolved {
            return Err(invalid(
                "Sketch embedded font has no matching PostScript face; keep original archive",
            ));
        }
    }
    if !nonembedded.is_empty() {
        doc.design_system.get_or_insert_with(Default::default).sketch_containers
            .insert("nonEmbeddedFontReferences".into(), Value::Array(nonembedded));
    }
    Ok(aliases)
}

pub(crate) fn remap_fonts(aliases:&BTreeMap<String,String>,doc:&mut Document)->Result<(),Error>{
    let remap = |id: &mut String| {
        if let Some(mapped) = aliases.get(id) {
            *id = mapped.clone();
        }
    };
    for node in doc.nodes.values_mut() {
        if let Some(style) = &mut node.text_style {
            remap(&mut style.font_id);
            for fallback in &mut style.fallbacks {
                remap(fallback);
            }
        }
        for run in &mut node.text_runs {
            if let Some(id) = &mut run.font_id {
                remap(id);
            }
        }
    }
    if let Some(system) = &mut doc.design_system {
        for shared in system.styles.values_mut().filter(|s| s.kind == "text") {
            if let Ok(mut style) =
                serde_json::from_value::<crate::font::TextStyle>(shared.value.clone())
            {
                remap(&mut style.font_id);
                for fallback in &mut style.fallbacks {
                    remap(fallback);
                }
                shared.value =
                    serde_json::to_value(style).map_err(|e| Error::MalformedJson(e.to_string()))?;
            }
        }
    }
    Ok(())
}
