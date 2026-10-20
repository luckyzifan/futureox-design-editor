//! Interop with foreign design formats: Sketch `.sketch` (import + export)
//! and Figma `.fig` (import via the bundled `fig2sketch` converter).
//!
//! The `.sketch` mapping follows the documented container and JSON schema:
//! a zip holding `meta.json`, `document.json`, `user.json`, one
//! `pages/<uuid>.json` per page and `images/<sha1>` blobs; layer trees
//! keyed by `_class`; styles as fill / border / shadow part arrays.
//! Unknown fields are ignored on import and
//! omitted on export — Sketch itself defaults-absent fields, so a subset
//! document opens cleanly.
use crate::math::Transform;
use crate::color::{ColorSettings, ColorSpace};
use crate::scene::{Document, Effect, ExportSetting, Node, Page, Paint, Stroke};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};

#[derive(Debug)]
pub enum Error {
    NotAZip(String),
    MissingPart(String),
    MalformedJson(String),
    Io(String),
    UnsupportedFigPlatform,
    Unsupported(String),
    Fig2Sketch(String),
    Pdf(String),
    InvalidDocument(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::NotAZip(m) => write!(f, "not a zip container: {m}"),
            Error::MissingPart(m) => write!(f, "container missing {m}"),
            Error::MalformedJson(m) => write!(f, "malformed JSON: {m}"),
            Error::Io(m) => write!(f, "io: {m}"),
            Error::UnsupportedFigPlatform => {
                write!(
                    f,
                    ".fig import needs the fig2sketch helper (native builds only)"
                )
            }
            Error::Fig2Sketch(m) => write!(f, "fig2sketch failed: {m}"),
            Error::Pdf(m) => write!(f, "pdf import failed: {m}"),
            Error::InvalidDocument(m) => write!(f, "invalid imported document: {m}"),
            Error::Unsupported(m) => write!(f, "unsupported lossless conversion: {m}"),
        }
    }
}
impl std::error::Error for Error {}

type Result<T> = std::result::Result<T, Error>;

// ---------------------------------------------------------------------------
// zip helpers
// ---------------------------------------------------------------------------

/// Public wrapper for the fig module (container reading shares the zip codec).
pub fn read_zip_public(bytes: &[u8]) -> std::result::Result<BTreeMap<String, Vec<u8>>, String> {
    read_zip(bytes).map_err(|e| e.to_string())
}

/// Public wrapper: image bytes → data URI (used by the native fig importer).
pub fn image_data_uri_public(bytes: &[u8]) -> String {
    image_data_uri(bytes)
}

/// Resource ceilings shared with the lossless Sketch archive adapter. These
/// constrain compressed input and actual decompressed bytes, not just ZIP claims.
#[derive(Clone, Copy)]
struct ArchiveLimits {
    input: usize,
    entries: usize,
    entry: u64,
    document_entry: u64,
    total: u64,
}

const ARCHIVE_LIMITS: ArchiveLimits = ArchiveLimits {
    input: crate::sketch::archive::MAX_TOTAL_BYTES as usize,
    entries: crate::sketch::archive::MAX_ENTRIES,
    entry: crate::sketch::archive::MAX_ENTRY_BYTES,
    document_entry: crate::sketch::archive::MAX_DOCUMENT_BYTES,
    total: crate::sketch::archive::MAX_TOTAL_BYTES,
};

fn archive_limit(message: &str) -> Error {
    Error::Unsupported(format!("archive resource limit: {message}"))
}

fn read_zip(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>> {
    read_zip_bounded(bytes, ARCHIVE_LIMITS)
}

fn read_zip_bounded(bytes: &[u8], limits: ArchiveLimits) -> Result<BTreeMap<String, Vec<u8>>> {
    if bytes.len() > limits.input {
        return Err(archive_limit("input bytes"));
    }
    // Preflight the original directory before ZipArchive allocates its index.
    // ZIP32's end record has a bounded comment. Compute the physical directory
    // start from its size so ordinary prepended/self-extracting data still works.
    let end = (bytes.len().saturating_sub(22 + u16::MAX as usize)..bytes.len().saturating_sub(21))
        .rev().find(|&at| {
            bytes.get(at..at + 4) == Some(b"PK\x05\x06")
                && at + 22 + u16::from_le_bytes([bytes[at + 20], bytes[at + 21]]) as usize == bytes.len()
        }).ok_or_else(|| Error::NotAZip("missing ZIP32 end record".into()))?;
    let directory_size = u32::from_le_bytes(bytes[end + 12..end + 16].try_into().unwrap()) as usize;
    let directory_start = end.checked_sub(directory_size)
        .ok_or_else(|| Error::NotAZip("invalid central directory size".into()))?;
    let mut at = directory_start;
    // zip 2.x deduplicates central-directory names. Count original records so
    // ambiguous duplicates cannot silently overwrite each other. As in the
    // strict Sketch adapter, accept ZIP32 only; never extract to the filesystem.
    let mut records = 0;
    while bytes.get(at..at.saturating_add(4)) == Some(b"PK\x01\x02") {
        let header = bytes.get(at..at.saturating_add(46))
            .ok_or_else(|| Error::NotAZip("truncated central directory".into()))?;
        let length = |offset| u16::from_le_bytes([header[offset], header[offset + 1]]) as usize;
        at = at.checked_add(46 + length(28) + length(30) + length(32))
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| Error::NotAZip("truncated central entry".into()))?;
        records += 1;
        if records > limits.entries {
            return Err(archive_limit("entry count"));
        }
    }
    if at != end || bytes.get(at..at.saturating_add(4)) != Some(b"PK\x05\x06") {
        return Err(Error::Unsupported("non-ZIP32 or unsupported central directory trailer".into()));
    }
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| Error::NotAZip(e.to_string()))?;
    if archive.central_directory_start() != directory_start as u64 {
        return Err(Error::NotAZip("inconsistent central directory offset".into()));
    }
    if records != archive.len() {
        return Err(Error::NotAZip("duplicate central directory identity".into()));
    }
    let mut out = BTreeMap::new();
    let mut names = std::collections::BTreeSet::new();
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| Error::Io(e.to_string()))?;
        let name = file.name().to_owned();
        let path = name.strip_suffix('/').unwrap_or(&name);
        if !crate::sketch::archive::safe_path(path) || !names.insert(path.to_owned()) {
            return Err(Error::NotAZip(format!("unsafe/duplicate archive path: {name}")));
        }
        if file.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
            return Err(Error::NotAZip("archive symlink".into()));
        }
        if file.is_dir() {
            continue;
        }
        let declared = file.size();
        let remaining = limits.total.saturating_sub(total);
        let entry_limit = if name == "document.json" { limits.document_entry } else { limits.entry };
        if declared > entry_limit {
            return Err(archive_limit("entry expanded bytes"));
        }
        if declared > remaining {
            return Err(archive_limit("total expanded bytes"));
        }
        let allowed = entry_limit.min(remaining);
        // Never reserve according to untrusted metadata. Read at most the
        // remaining budget plus one sentinel byte, including when size lies.
        let mut data = Vec::new();
        file.by_ref().take(allowed.saturating_add(1)).read_to_end(&mut data)
            .map_err(|e| Error::Io(e.to_string()))?;
        let actual = data.len() as u64;
        if actual > allowed {
            return Err(archive_limit(if remaining < entry_limit {
                "total expanded bytes"
            } else {
                "entry expanded bytes"
            }));
        }
        if actual != declared {
            return Err(Error::NotAZip("entry length mismatch".into()));
        }
        total += actual; // actual <= remaining, so this cannot overflow.
        out.insert(name, data);
    }
    Ok(out)
}

fn write_zip(entries: &[(String, Vec<u8>)]) -> Result<Vec<u8>> {
    let mut sink = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut sink);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            zip.start_file(name.as_str(), options)
                .map_err(|e| Error::Io(e.to_string()))?;
            zip.write_all(data).map_err(|e| Error::Io(e.to_string()))?;
        }
        zip.finish().map_err(|e| Error::Io(e.to_string()))?;
    }
    Ok(sink.into_inner())
}

fn json_part(files: &BTreeMap<String, Vec<u8>>, name: &str) -> Result<Value> {
    let data = files
        .get(name)
        .ok_or_else(|| Error::MissingPart(name.to_string()))?;
    serde_json::from_slice(data).map_err(|e| Error::MalformedJson(format!("{name}: {e}")))
}

// ---------------------------------------------------------------------------
// format detection
// ---------------------------------------------------------------------------

/// A `.sketch` bundle is a zip whose root holds `meta.json` + `document.json`.
pub fn is_sketch_file(bytes: &[u8]) -> bool {
    matches!(read_zip(bytes), Ok(files)
        if files.contains_key("meta.json") && files.contains_key("document.json"))
}

/// A `.fig` bundle is a zip containing `canvas.fig` (Kiwi scene graph),
/// as handled by Sketch's bundled `fig2sketch` importer.
pub fn is_fig_file(bytes: &[u8]) -> bool {
    matches!(read_zip(bytes), Ok(files) if files.contains_key("canvas.fig"))
}

/// Detect and import either supported foreign format in one call.
pub fn import_any(bytes: &[u8]) -> Result<Document> {
    if is_sketch_file(bytes) {
        import_sketch(bytes)
    } else if is_fig_file(bytes) {
        import_fig(bytes)
    } else if crate::pdf_import::is_pdf_file(bytes) {
        crate::pdf_import::import_pdf(bytes).map_err(Error::Pdf)
    } else {
        Err(Error::NotAZip(
            "neither .sketch nor .fig markers found".into(),
        ))
    }
}

// ---------------------------------------------------------------------------

fn f64_at(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(0.)
}

/// Parse "{x, y}" string or {x,y} dict → (f64, f64).
fn point_xy(v: &Value) -> (f64, f64) {
    if let Some(s) = v.as_str() {
        // "{0.5, 0.25}" format
        let inner = s.trim_matches(|c| c == '{' || c == '}');
        let parts: Vec<&str> = inner.split(',').collect();
        if parts.len() == 2 {
            return (
                parts[0].trim().parse().unwrap_or(0.),
                parts[1].trim().parse().unwrap_or(0.),
            );
        }
        (0., 0.)
    } else {
        (f64_at(v, "x"), f64_at(v, "y"))
    }
}

fn point_to_point(v: &Value) -> crate::math::Point {
    let (x, y) = point_xy(v);
    crate::math::Point::new(x, y)
}

/// Sketch constraint bits per axis: 0=none/free, 1=min, 2=max, 3=min|max(fixed), 4=scale
fn constraint_anchor(bits: u64) -> crate::layout::Anchor {
    match bits {
        1 => crate::layout::Anchor::Start,
        2 => crate::layout::Anchor::End,
        3 => crate::layout::Anchor::Stretch,
        4..=7 => crate::layout::Anchor::Scale,
        _ => crate::layout::Anchor::Start,
    }
}

fn bool_at(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn color_hex(color: &Value) -> String {
    let color = adaptable_resolved(color);
    let r = (f64_at(color, "red").clamp(0., 1.) * 255.).round() as u8;
    let g = (f64_at(color, "green").clamp(0., 1.) * 255.).round() as u8;
    let b = (f64_at(color, "blue").clamp(0., 1.) * 255.).round() as u8;
    format!("#{r:02x}{g:02x}{b:02x}")
}

fn color_alpha(color: &Value) -> f64 {
    f64_at(adaptable_resolved(color), "alpha").clamp(0., 1.)
}

fn gradient_stop_color(color: &Value, space: ColorSpace) -> String {
    let resolved = adaptable_resolved(color);
    if color_alpha(color) == 1. {
        return color_hex(color);
    }
    format!("color({} {} {} {} / {})",
        if space == ColorSpace::DisplayP3 { "display-p3" } else { "srgb" },
        f64_at(resolved, "red").clamp(0., 1.),
        f64_at(resolved, "green").clamp(0., 1.),
        f64_at(resolved, "blue").clamp(0., 1.), color_alpha(color))
}

// ---------------------------------------------------------------------------
// P0-4: MSAdaptableColor (05-style.md §3, 24-c1-c11-completion.md C9)
//
// Sketch 2023+ colors can adapt between light/dark appearances. There is
// no independent resolvedColor symbol — recoloring is driven by
// `updatableColors` on the layer/style — so the
// kernel keeps both appearance values verbatim in bindings and feeds the
// light (default appearance) value into the single-color paint/text paths.
// The exact archived key set is not documented, so detection accepts the
// class marker plus the observed dual-value key pairs, and fidelity rides
// the raw JSON rather than a re-derived structure.
// ---------------------------------------------------------------------------

/// True when a color dict carries appearance-adaptive payloads.
fn adaptable_is_adaptable(color: &Value) -> bool {
    color
        .get("_class")
        .and_then(Value::as_str)
        .is_some_and(|c| c.contains("AdaptableColor"))
        || (color.get("light").is_some_and(Value::is_object)
            && color.get("dark").is_some_and(Value::is_object))
        || (color
            .get("lightColor")
            .is_some_and(Value::is_object)
            && color
                .get("darkColor")
                .is_some_and(Value::is_object))
}

/// The default-appearance (light) value of a possibly-adaptable color.
/// Plain color dicts resolve to themselves.
fn adaptable_resolved(color: &Value) -> &Value {
    if color.get("red").is_some() {
        return color;
    }
    for key in ["light", "lightColor", "color"] {
        if let Some(inner) = color.get(key).filter(|v| v.is_object()) {
            return inner;
        }
    }
    color
}

/// Record one color slot's fidelity payloads: the raw MSAdaptableColor JSON
/// (`sketchAdaptableColor.<slot>`) and/or the swatch reference
/// (`sketchSwatchID.<slot>`, 05-style.md §3 swatchID 关联).
fn adaptable_collect_color(out: &mut Vec<(String, String)>, slot: &str, color: &Value) {
    if adaptable_is_adaptable(color) {
        out.push((
            format!("sketchAdaptableColor.{slot}"),
            serde_json::to_string(color).unwrap_or_default(),
        ));
    }
    if let Some(swatch_id) = color.get("swatchID").and_then(Value::as_str) {
        out.push((format!("sketchSwatchID.{slot}"), swatch_id.into()));
    }
}

/// Walk the color slots of an archived style dict (fills/borders/shadows
/// plus gradient stops). Slot grammar: `fill.N[.stop.M]` / `border.N` /
/// `shadow.N` / `innerShadow.N`; the exporter splices originals back at the
/// same slots.
fn adaptable_collect_style(style: &Value, out: &mut Vec<(String, String)>) {
    for (array, prefix) in [
        ("fills", "fill"),
        ("borders", "border"),
        ("shadows", "shadow"),
        ("innerShadows", "innerShadow"),
    ] {
        let Some(parts) = style.get(array).and_then(Value::as_array) else {
            continue;
        };
        for (i, part) in parts.iter().enumerate() {
            if let Some(color) = part.get("color") {
                adaptable_collect_color(out, &format!("{prefix}.{i}"), color);
            }
            if let Some(stops) = part
                .get("gradient")
                .and_then(|g| g.get("stops"))
                .and_then(Value::as_array)
            {
                for (j, stop) in stops.iter().enumerate() {
                    if let Some(color) = stop.get("color") {
                        adaptable_collect_color(out, &format!("{prefix}.{i}.stop.{j}"), color);
                    }
                }
            }
        }
    }
}

/// Locate the color dict addressed by a slot inside an exported style dict.
fn adaptable_slot_in_style<'a>(style: &'a mut Value, slot: &str) -> Option<&'a mut Value> {
    let mut parts = slot.split('.');
    let array = match parts.next()? {
        "fill" => "fills",
        "border" => "borders",
        "shadow" => "shadows",
        "innerShadow" => "innerShadows",
        _ => return None,
    };
    let index: usize = parts.next()?.parse().ok()?;
    let part = style.get_mut(array)?.get_mut(index)?;
    match parts.next() {
        None => part.get_mut("color"),
        Some("stop") => {
            let stop: usize = parts.next()?.parse().ok()?;
            part.get_mut("gradient")?
                .get_mut("stops")?
                .get_mut(stop)?
                .get_mut("color")
        }
        _ => None,
    }
}

/// Locate the color dict addressed by a slot inside an exported layer dict:
/// style parts delegate to the style, `run.N` addresses the attributed
/// string's color attribute, `background` the artboard background color.
fn adaptable_slot_in_layer<'a>(layer: &'a mut Map<String, Value>, slot: &str) -> Option<&'a mut Value> {
    match slot.split('.').next()? {
        "background" => layer.get_mut("backgroundColor"),
        "run" => {
            let index: usize = slot.split('.').nth(1)?.parse().ok()?;
            layer
                .get_mut("attributedString")?
                .get_mut("attributes")?
                .get_mut(index)?
                .get_mut("attributes")?
                .get_mut("MSAttributedStringColorAttribute")
        }
        _ => adaptable_slot_in_style(layer.get_mut("style")?, slot),
    }
}

/// Export side of P0-4: splice preserved color payloads back into the layer
/// dict and restore `updatableColors` on the layer and its style. Stale
/// slots (document edited after import) are skipped rather than blocking
/// the export.
fn adaptable_apply_layer(layer: &mut Map<String, Value>, bindings: &BTreeMap<String, String>) {
    for (key, raw) in bindings {
        if let Some(slot) = key.strip_prefix("sketchAdaptableColor.") {
            match slot {
                "updatableColors" | "styleUpdatableColors" => {
                    if let Ok(value) = serde_json::from_str::<Value>(raw) {
                        if slot == "updatableColors" {
                            layer.insert("updatableColors".into(), value);
                        } else if let Some(style) = layer.get_mut("style") {
                            style["updatableColors"] = value;
                        }
                    }
                }
                _ => {
                    if let Ok(value) = serde_json::from_str::<Value>(raw)
                        && let Some(target) = adaptable_slot_in_layer(layer, slot)
                    {
                        *target = value;
                    }
                }
            }
        } else if let Some(slot) = key.strip_prefix("sketchSwatchID.") {
            if let Some(target) = adaptable_slot_in_layer(layer, slot)
                && let Some(object) = target.as_object_mut()
            {
                object.insert("swatchID".into(), json!(raw));
            }
        }
    }
}

/// Sketch stores blend modes as enum integers (0 = Normal, …).
fn blend_code(blend: &str) -> u64 {
    match blend {
        "multiply" => 2,
        "darken" => 1,
        "color-burn" => 3,
        "lighten" => 4,
        "screen" => 5,
        "color-dodge" => 6,
        "overlay" => 7,
        "soft-light" => 8,
        "hard-light" => 9,
        "difference" => 10,
        "exclusion" => 11,
        "hue" => 12,
        "saturation" => 13,
        "color" => 14,
        "luminosity" => 15,
        _ => 0,
    }
}

fn blend_from_code(code: u64) -> String {
    match code {
        1 => "darken",
        2 => "multiply",
        3 => "color-burn",
        4 => "lighten",
        5 => "screen",
        6 => "color-dodge",
        7 => "overlay",
        8 => "soft-light",
        9 => "hard-light",
        10 => "difference",
        11 => "exclusion",
        12 => "hue",
        13 => "saturation",
        14 => "color",
        15 => "luminosity",
        _ => "normal",
    }
    .into()
}

fn blend_of(style: &Value) -> (f64, String) {
    let ctx = style.get("contextSettings").cloned().unwrap_or(Value::Null);
    let opacity = ctx.get("opacity").and_then(Value::as_f64).unwrap_or(1.);
    let blend = match ctx.get("blendMode") {
        Some(Value::Number(n)) => blend_from_code(n.as_u64().unwrap_or(0)),
        Some(Value::String(s)) => s.to_lowercase(),
        _ => "normal".into(),
    };
    (opacity, blend)
}

fn blank_paint(kind: &str) -> Paint {
    Paint {
        transform: None,
        id: String::new(),
        kind: kind.into(),
        // Image and gradient paints still carry a valid fallback color under
        // the shared scene admission contract.
        color: "#000000".into(),
        opacity: 1.,
        visible: true,
        angle: 0.,
        stops: Vec::new(),
        image: None,
        fit: "cover".into(),
        blend: "normal".into(),
        adjust: None,
        tile: None,
    }
}

fn solid_paint(color: &Value, base_opacity: f64, blend: &str) -> Paint {
    let mut paint = blank_paint("solid");
    paint.color = color_hex(color);
    paint.opacity = base_opacity * color_alpha(color);
    paint.blend = blend.into();
    paint
}

fn blur_projection(effects: &[Effect]) -> Vec<Effect> {
    effects.iter().filter(|effect| matches!(effect.kind.as_str(), "blur" | "background-blur" | "glass"))
        .cloned().map(|mut effect| { effect.id.clear(); effect }).collect()
}

fn gradient_paint(gradient: &Value, fill_type: u64, size: [f64; 2], space: ColorSpace) -> Option<Paint> {
    let native_type = gradient.get("gradientType").and_then(Value::as_u64)
        .unwrap_or(fill_type.saturating_sub(1));
    let kind = match native_type {
        0 => "linear",
        1 => "radial",
        2 => "angular",
        _ => return None,
    };
    let mut paint = blank_paint(kind);
    if let (Some(from), Some(to)) = (gradient.get("from"), gradient.get("to")) {
        let (x, y) = point_xy(from);
        let (tx, ty) = point_xy(to);
        let (dx, dy) = (tx - x, ty - y);
        if dx * dx + dy * dy > 1e-12 {
            paint.transform = Some(if kind == "radial" {
                // Sketch `from` is the center, `to` is one radius endpoint.
                // Paint's radial unit disk is centered at (.5,.5), with radius
                // .5. Build the perpendicular in layer pixels before returning
                // to normalized coordinates; otherwise non-square layers turn
                // a native circle into an ellipse. elipseLength scales that
                // perpendicular radius. Verified against native Sketch exports.
                let ratio = gradient.get("elipseLength").and_then(Value::as_f64)
                    .filter(|value| *value > 0.).unwrap_or(1.);
                let cross_x = -dy * size[1] / size[0].max(1e-8) * ratio;
                let cross_y = dx * size[0] / size[1].max(1e-8) * ratio;
                Transform([2. * dx, 2. * dy, 2. * cross_x, 2. * cross_y,
                    x - dx - cross_x, y - dy - cross_y])
            } else {
                Transform([dx, dy, -dy, dx, x + dy * 0.5, y - dx * 0.5])
            });
        }
    }
    if let Some(stops) = gradient.get("stops").and_then(Value::as_array) {
        for stop in stops {
            paint.stops.push(crate::scene::Stop {
                offset: f64_at(stop, "position"),
                color: stop
                    .get("color")
                    .map(|color| gradient_stop_color(color, space))
                    .unwrap_or_else(|| "#000000".into()),
            });
        }
    }
    Some(paint)
}

fn sniff_image_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.len() >= 12 && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

fn image_data_uri(bytes: &[u8]) -> String {
    use base64::Engine;
    let mime = sniff_image_mime(bytes);
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn kind_for_class(class: &str) -> &'static str {
    match class {
        "artboard" | "frame" | "canvasFrame" => "frame",
        "symbolMaster" => "frame",
        "group" | "shapeGroup" | "symbolInstance" => "group",
        "rectangle" => "rect",
        "oval" => "ellipse",
        "star" => "star",
        "polygon" | "triangle" => "polygon",
        "shapePath" | "shape" | "customShape" => "path",
        "text" => "text",
        "bitmap" => "image",
        "slice" => "slice",
        "hotspot" => "hotspot", // Limited mapping: raw prototype payload kept in bindings.
        _ => "group",
    }
}

struct Importer<'a> {
    color_space: ColorSpace,
    files: &'a BTreeMap<String, Vec<u8>>,
    nodes: BTreeMap<String, Node>,
    /// do_objectID → kernel id (prototype flow destinations address the
    /// archived UUID, not our restored original id).
    uuids: BTreeMap<String, String>,
    /// (kernel id, raw flow payload) for layers carrying prototype flows.
    flows: Vec<(String, Value)>,
    /// Node ids whose interactions came from the userInfo payload verbatim
    /// (they must not be double-mapped from a native flow dict).
    has_user_prototype: std::collections::HashSet<String>,
    /// First layer flagged isFlowHome becomes the prototype start node.
    flow_home: Option<String>,
}

impl<'a> Importer<'a> {
    fn image_ref(&self, layer: &Value) -> Option<String> {
        let reference = layer.get("image").and_then(|i| i.get("_ref"))?.as_str()?;
        self.files
            .get(&format!("images/{reference}"))
            .or_else(|| self.files.get(reference))
            .map(|b| image_data_uri(b))
    }

    /// One archived fill/border part → kernel paint (shared by layer styles
    /// and the document-level shared style containers).
    fn paint_part(&self, part: &Value, base_opacity: f64, blend: &str, size: [f64; 2]) -> Option<Paint> {
        if !bool_at(part, "isEnabled") {
            return None;
        }
        let (part_opacity, part_blend) = blend_of(part);
        let base_opacity = base_opacity * part_opacity;
        let blend = if part.get("contextSettings").and_then(|v| v.get("blendMode")).is_some() {
            part_blend.as_str()
        } else { blend };
        let fill_type = part.get("fillType").and_then(Value::as_u64).unwrap_or(0);
        match fill_type {
            0 => {
                // image (pattern) fills carry fillType 0 + an image ref in real files
                if part.get("image").is_some() {
                    self.image_ref(part).map(|uri| {
                        let mut p = blank_paint("image");
                        p.image = Some(uri);
                        p.opacity = base_opacity;
                        p.blend = blend.into();
                        p
                    })
                } else {
                    part.get("color")
                        .map(|c| solid_paint(c, base_opacity, blend))
                }
            }
            1..=3 => part.get("gradient").and_then(|g| {
                let mut p = gradient_paint(g, fill_type, size, self.color_space)?;
                p.blend = blend.into();
                p.opacity *= base_opacity;
                Some(p)
            }),
            4 => self.image_ref(part).map(|uri| {
                let mut p = blank_paint("image");
                p.image = Some(uri);
                p.opacity = base_opacity;
                p.blend = blend.into();
                p
            }),
            _ => None,
        }
    }

    fn paints(&self, style: &Value, key: &str, size: [f64; 2]) -> Vec<Paint> {
        let mut out = Vec::new();
        let Some(parts) = style.get(key).and_then(Value::as_array) else {
            return out;
        };
        for part in parts {
            // The node owns the layer context. Each paint owns only its part
            // context and color alpha; multiplying layer opacity here repeats it.
            if let Some(paint) = self.paint_part(part, 1., "normal", size) {
                out.push(paint);
            }
        }
        out
    }

    fn strokes(&self, style: &Value) -> Vec<Stroke> {
        // Dash/cap/join live on the style's borderOptions (one set shared by
        // every border, per the archived schema).
        let options = style.get("borderOptions").cloned().unwrap_or(Value::Null);
        let dash = options
            .get("dashPattern")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(Value::as_f64)
                    .filter(|v| *v > 0.)
                    .map(|v| format!("{v}"))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        let cap = match options.get("lineCapStyle").and_then(Value::as_i64) {
            Some(1) => "round",
            Some(2) => "square",
            _ => "butt",
        };
        let join = match options.get("lineJoinStyle").and_then(Value::as_i64) {
            Some(1) => "round",
            Some(2) => "bevel",
            _ => "miter",
        };
        let mut out = Vec::new();
        let Some(parts) = style.get("borders").and_then(Value::as_array) else {
            return out;
        };
        for part in parts {
            if !bool_at(part, "isEnabled") {
                continue;
            }
            let (base_opacity, blend) = blend_of(part);
            let mut paint = part
                .get("color")
                .map(|c| solid_paint(c, base_opacity, &blend))
                .unwrap_or_else(|| blank_paint("solid"));
            paint.id = String::new();
            out.push(Stroke {
                start_marker: Default::default(),
                end_marker: Default::default(),
                id: String::new(),
                paint,
                width: f64_at(part, "thickness").max(0.01),
                align: match part.get("position").and_then(Value::as_i64).unwrap_or(0) {
                    1 => "inside",
                    2 => "outside",
                    _ => "center",
                }
                .into(),
                cap: cap.into(),
                join: join.into(),
                dash: dash.clone(),
                dash_offset: 0.,
                visible: true,
                width_profile: Vec::new(),
            });
        }
        out
    }

    fn effects(&self, style: &Value) -> Vec<Effect> {
        let mut out = Vec::new();
        let mut push_shadow = |parts: Option<&Vec<Value>>, inner: bool| {
            if let Some(parts) = parts {
                for part in parts {
                    if !bool_at(part, "isEnabled") {
                        continue;
                    }
                    out.push(Effect {
                        id: String::new(),
                        kind: if inner { "inner-shadow" } else { "shadow" }.into(),
                        visible: true,
                        radius: f64_at(part, "blurRadius"),
                        x: f64_at(part, "offsetX"),
                        y: f64_at(part, "offsetY"),
                        spread: f64_at(part, "spread"),
                        color: part
                            .get("color")
                            .map(color_hex)
                            .unwrap_or_else(|| "#000000".into()),
                        // shadow alpha lives in the archived color payload
                        opacity: part.get("color").map(color_alpha).unwrap_or(1.),
                        amount: 0.,
                        glass: None,
                        texture: None,
                        gradient_blur: None,
                    });
                }
            }
        };
        push_shadow(style.get("shadows").and_then(Value::as_array), false);
        push_shadow(style.get("innerShadows").and_then(Value::as_array), true);
        if let Some(blur) = style.get("blur")
            && bool_at(blur, "isEnabled")
            && f64_at(blur, "radius") > 0.
        {
            let kind = match blur.get("type").and_then(Value::as_i64).unwrap_or(0) {
                0 => "blur",
                3 => "background-blur",
                _ => return out,
            };
            out.push(Effect {
                id: String::new(),
                kind: kind.into(),
                visible: true,
                radius: f64_at(blur, "radius"),
                x: 0.,
                y: 0.,
                spread: 0.,
                color: "#000000".into(),
                opacity: 1.,
                amount: 0.,
                glass: None,
                texture: None,
                gradient_blur: None,
            });
        }
        out
    }

    fn layer(&mut self, layer: &Value) -> String {
        let class = layer
            .get("_class")
            .and_then(Value::as_str)
            .unwrap_or("group");
        let id = layer
            .get("userInfo")
            .and_then(|u| u.get("com.futureox.design-kernel"))
            .and_then(|u| u.get("originalId"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                layer
                    .get("do_objectID")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| format!("sketch-{}/{}", class, self.nodes.len()));
        let kind = kind_for_class(class);
        let mut node = crate::facet::sample_node(&id, kind);
        // Import-side degradation ledger (mirror of the exporter's userInfo
        // lossy list, surfaced through bindings like figUntranslated).
        let mut import_lossy: Vec<String> = Vec::new();
        if !matches!(class, "artboard" | "frame" | "canvasFrame" | "symbolMaster"
            | "group" | "shapeGroup" | "symbolInstance" | "rectangle" | "oval"
            | "star" | "polygon" | "triangle" | "shapePath" | "shape" | "text"
            | "bitmap" | "slice" | "hotspot")
        {
            node.bindings.insert("interopLimited".into(), format!("sketch-unknown-layer-class:{class}"));
        }
        node.name = layer
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into();
        node.visible = layer
            .get("isVisible")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        node.locked = bool_at(layer, "isLocked");
        let frame = layer.get("frame").cloned().unwrap_or(Value::Null);
        node.width = f64_at(&frame, "width").max(0.);
        node.height = f64_at(&frame, "height").max(0.);
        let x = f64_at(&frame, "x");
        let y = f64_at(&frame, "y");
        node.transform = Transform([1., 0., 0., 1., x, y]);
        let rotation = f64_at(layer, "rotation");
        let flip = [bool_at(layer, "isFlippedHorizontal"), bool_at(layer, "isFlippedVertical")];
        if rotation != 0. || flip.iter().any(|v| *v) {
            node.transform = crate::sketch::geometry::layer_transform(
                [x, y, node.width, node.height], rotation, flip);
            node.bindings.insert("sketchSourceTransform".into(), json!({
                "frame": [x,y,node.width,node.height], "rotation":rotation,
                "flip":flip, "matrix":node.transform.0,
            }).to_string());
        }

        let style = layer.get("style").cloned().unwrap_or(Value::Null);
        if !style.is_null() {
            let size = [node.width, node.height];
            node.fills = self.paints(&style, "fills", size);
            let source_gradients: BTreeMap<String, Value> = style.get("fills").and_then(Value::as_array)
                .into_iter().flatten().filter_map(|part| self.paint_part(part, 1., "normal", size)
                    .map(|paint| (part, paint))).enumerate()
                .filter_map(|(index, (part, paint))| part.get("gradient")
                    .filter(|_| part.get("fillType").and_then(Value::as_u64) == Some(1))
                    .map(|gradient| (index.to_string(), json!({"gradient":gradient,"paint":paint}))))
                .collect();
            if !source_gradients.is_empty() {
                node.bindings.insert("sketchSourceGradients".into(), json!(source_gradients).to_string());
            }
            node.strokes = self.strokes(&style);
            node.effects = self.effects(&style);
            if let Some(blur) = style.get("blur")
                .filter(|value| bool_at(value, "isEnabled") || f64_at(value, "radius") > 0.)
            {
                node.bindings.insert("sketchSourceBlur".into(), json!({
                    "blur":blur,"effects":blur_projection(&node.effects),
                }).to_string());
                if bool_at(blur, "isEnabled") && f64_at(blur, "radius") > 0. {
                    match blur.get("type").and_then(Value::as_i64).unwrap_or(0) {
                        0 => {}
                        3 => {
                            if blur.get("saturation").and_then(Value::as_f64).is_some_and(|value| value != 1.) {
                                import_lossy.push("background-blur-saturation-not-modeled;source-blur-retained".into());
                            }
                        }
                        1 => import_lossy.push("motion-blur-not-modeled;source-blur-retained".into()),
                        2 => import_lossy.push("zoom-blur-not-modeled;source-blur-retained".into()),
                        _ => import_lossy.push("unknown-blur-type-not-modeled;source-blur-retained".into()),
                    }
                }
            }
            let (opacity, blend) = blend_of(&style);
            node.opacity = opacity;
            node.blend = blend;
            // P1-6: shared style reference survives as a style_ref
            if let Some(shared) = layer.get("sharedStyleID").or_else(|| style.get("sharedStyleID")).and_then(Value::as_str) {
                node.style_refs
                    .insert("sketchSharedStyleID".into(), shared.into());
            }
        }
        // P0-4: adaptable colors / swatch references on this layer's style
        // (slot grammar documented at adaptable_collect_style), plus the
        // updatableColors recolor markers on the style and the layer.
        if !style.is_null() {
            let mut fidelity = Vec::new();
            adaptable_collect_style(&style, &mut fidelity);
            if let Some(updatable) = style.get("updatableColors") {
                fidelity.push((
                    "sketchAdaptableColor.styleUpdatableColors".into(),
                    serde_json::to_string(updatable).unwrap_or_default(),
                ));
            }
            for (key, value) in fidelity {
                node.bindings.insert(key, value);
            }
        }
        if let Some(updatable) = layer.get("updatableColors") {
            node.bindings.insert(
                "sketchAdaptableColor.updatableColors".into(),
                serde_json::to_string(updatable).unwrap_or_default(),
            );
        }
        // P1-9: boolean groups (shapeGroup) carry the operation code;
        // -1 means "no boolean" and stays None. Winding rides in bindings.
        if let Some(op) = layer
            .get("booleanOperation")
            .and_then(Value::as_i64)
            .and_then(boolean_from_code)
        {
            node.boolean_operation = Some(op);
        }
        if layer.get("windingRule").and_then(Value::as_i64) == Some(1) {
            node.bindings
                .insert("sketchWindingRule".into(), "evenodd".into());
        }

        // P1-8: FlexGroupLayout stacks (the Sketch 2025 auto-layout).
        if let Some(group_layout) = layer.get("groupLayout")
            && group_layout.get("_class").and_then(Value::as_str)
                == Some("MSImmutableFlexGroupLayout")
        {
            let mode = match f64_at(group_layout, "flexDirection") as i64 {
                1 => crate::layout::Flow::Vertical,
                _ => crate::layout::Flow::Horizontal,
            };
            let justify = |code: i64| match code {
                1 => crate::layout::Align::Center,
                2 => crate::layout::Align::End,
                3 => crate::layout::Align::SpaceBetween,
                4 => crate::layout::Align::SpaceAround,
                5 => crate::layout::Align::SpaceEvenly,
                _ => crate::layout::Align::Start,
            };
            let align = |code: i64| match code {
                1 => crate::layout::Align::Center,
                2 => crate::layout::Align::End,
                _ => crate::layout::Align::Start,
            };
            node.layout = Some(crate::layout::Layout {
                mode,
                gap: f64_at(group_layout, "allGuttersGap"),
                line_gap: 0.,
                padding: [
                    f64_at(layer, "topPadding"),
                    f64_at(layer, "rightPadding"),
                    f64_at(layer, "bottomPadding"),
                    f64_at(layer, "leftPadding"),
                ],
                wrap: false,
                justify: justify(f64_at(group_layout, "justifyContent") as i64),
                align: align(f64_at(group_layout, "alignItems") as i64),
                ..crate::layout::Layout::default()
            });
        }

        // Export-lossy notes travel in userInfo so round-trip callers see an
        // honest warning list instead of silent degradation.
        let user_ns = layer
            .get("userInfo")
            .and_then(|u| u.get("com.futureox.design-kernel"))
            .cloned()
            .unwrap_or(Value::Null);
        if let Some(lossy) = user_ns
            .get("lossy")
            .and_then(Value::as_array)
            .filter(|a| !a.is_empty())
        {
            node.bindings.insert(
                "sketchExportLossy".into(),
                serde_json::to_string(lossy).unwrap_or_default(),
            );
        }
        match class {
            "rectangle" => node.corner_radius = f64_at(layer, "fixedRadius"),
            "oval" | "star" | "polygon" | "triangle" => {
                node.points = layer
                    .get("numberOfPoints")
                    .and_then(Value::as_u64)
                    .unwrap_or(5) as usize;
                node.inner_radius = f64_at(layer, "innerRadius");
            }
            "shapePath" | "shape" => {
                if layer.get("isClosed").and_then(Value::as_bool) == Some(false) {
                    node.bindings.insert("sketchOpenPath".into(), "true".into());
                }
                if layer.get("userInfo")
                    .and_then(|u| u.get("com.futureox.design-kernel"))
                    .and_then(|u| u.get("originalId")).is_none()
                {
                    node.bindings.insert("sketchNormalizedCoordinates".into(), "true".into());
                }
                if let Some(points) = layer.get("points").and_then(Value::as_array) {
                    let mut network = crate::scene::Network {
                        filled_faces: None,
                        vertices: Vec::new(),
                        edges: Vec::new(),
                        fill_rule: "nonzero".into(),
                    };
                    // Per-point handles honoring curveMode (22 号字典 §1):
                    // 0/1 (None/Straight) ignore the archived handle values;
                    // 2 (Mirrored) derives a missing side as 2*v − h;
                    // 3 (Disconnected) and 4 (Asymmetric) keep both sides as
                    // read — the kernel stores no collinearity constraint, so
                    // Asymmetric materializes into two independent handles.
                    let mut outgoing: Vec<Option<crate::math::Point>> =
                        Vec::with_capacity(points.len());
                    let mut incoming: Vec<Option<crate::math::Point>> =
                        Vec::with_capacity(points.len());
                    let mut corner_radii: Vec<f64> = Vec::with_capacity(points.len());
                    let mut any_corner_radius = false;
                    #[allow(clippy::needless_range_loop)]
                    for i in 0..points.len() {
                        let pt = &points[i];
                        let anchor = pt.get("point").cloned().unwrap_or(Value::Null);
                        let (vx, vy) = point_xy(&anchor);
                        network.vertices.push(crate::scene::Vertex {
                            id: format!("v{i}"),
                            x: vx,
                            y: vy,
                        });
                        let mode = pt.get("curveMode").and_then(Value::as_i64).unwrap_or(1);
                        let has_from = bool_at(pt, "hasCurveFrom");
                        let has_to = bool_at(pt, "hasCurveTo");
                        let (mut to, mut from) = match mode {
                            0 | 1 => (None, None),
                            _ => (
                                if has_to {
                                    pt.get("curveTo").map(point_to_point)
                                } else {
                                    None
                                },
                                if has_from {
                                    pt.get("curveFrom").map(point_to_point)
                                } else {
                                    None
                                },
                            ),
                        };
                        if mode == 2 {
                            match (to, from) {
                                (Some(t), None) => {
                                    from = Some(crate::math::Point::new(
                                        2. * vx - t.x,
                                        2. * vy - t.y,
                                    ));
                                }
                                (None, Some(f)) => {
                                    to = Some(crate::math::Point::new(
                                        2. * vx - f.x,
                                        2. * vy - f.y,
                                    ));
                                }
                                _ => {}
                            }
                        }
                        incoming.push(to);
                        outgoing.push(from);
                        let radius = f64_at(pt, "cornerRadius");
                        any_corner_radius |= radius != 0.;
                        corner_radii.push(radius);
                    }
                    for i in 0..network.vertices.len() {
                        let n = network.vertices.len();
                        let next = (i + 1) % n;
                        let (from, to) = (
                            network.vertices[i].id.clone(),
                            network.vertices[next].id.clone(),
                        );
                        // edge i→next takes c1 from point[i].curveFrom and c2
                        // from point[next].curveTo (kernel semantics: c1 sits
                        // at `from`, c2 at `to`).
                        network.edges.push(crate::scene::Edge {
                            id: format!("e{i}"),
                            from,
                            to,
                            c1: outgoing[i],
                            c2: incoming[next],
                        });
                    }
                    node.network = Some(network);
                    if any_corner_radius {
                        // Per-point corner radii have no kernel home; they
                        // ride bindings verbatim and the degradation is
                        // reported, not silently dropped.
                        node.bindings.insert(
                            "sketchPointCornerRadii".into(),
                            serde_json::to_string(&corner_radii).unwrap_or_default(),
                        );
                        import_lossy.push("shapepath-point-corner-radius-not-modeled".into());
                    }
                }
            }
            "text" => {
                let attr = layer
                    .get("attributedString")
                    .cloned()
                    .unwrap_or(Value::Null);
                node.text = attr
                    .get("string")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .into();
                let mut style = crate::font::TextStyle::default();
                // Official Sketch text sizing maps to the shared layout
                // model: Flexible measures both axes, Fixed keeps its width,
                // FixedWidthAndHeight preserves both source extents.
                let behaviour = layer.get("textBehaviour").and_then(Value::as_i64).unwrap_or(0);
                style.wrap = behaviour != 0;
                // Native sizing remains authoritative. The namespaced payload
                // preserves the independent kernel wrap switch, which Sketch
                // cannot express for fixed boxes. Ignore it after a native
                // sizing-mode or text edit; ordinary foreign files need no metadata.
                if let Some(own) = layer.pointer("/userInfo/com.futureox.design-kernel/textWrap") {
                    if own.get("textBehaviour").and_then(Value::as_i64) == Some(behaviour)
                        && own.get("text").and_then(Value::as_str) == Some(node.text.as_str()) {
                        if let Some(wrap) = own.get("wrap").and_then(Value::as_bool) {
                            style.wrap = wrap;
                        }
                    }
                }
                if matches!(behaviour, 0..=2) {
                    node.sizing = Some(crate::layout::Sizing {
                        width: if behaviour == 0 { crate::layout::SizeMode::Hug } else { crate::layout::SizeMode::Fixed },
                        height: if behaviour == 2 { crate::layout::SizeMode::Fixed } else { crate::layout::SizeMode::Hug },
                        ..Default::default()
                    });
                    if let Some(frame) = layer.get("frame") {
                        node.bindings.insert("sketchSourceTextFrameRaw".into(), frame.to_string());
                    }
                }
                if layer.get("textBehaviour").is_some() && !matches!(behaviour, 0 | 1) {
                        node.bindings
                            .insert("sketchTextBehaviour".into(), behaviour.to_string());
                        if behaviour != 2 {
                            import_lossy.push("textbehaviour-fixed-size-not-modeled".into());
                        }
                }
                // lineSpacingBehaviour (1 = v2 常基线, 3 = 自定义) rides
                // bindings only when it differs from what the line-height
                // geometry would re-derive (resolved after the runs loop).
                let raw_spacing_behaviour =
                    layer.get("lineSpacingBehaviour").and_then(Value::as_i64);
                if let Some(runs) = attr.get("attributes").and_then(Value::as_array) {
                    for run in runs {
                        let a = run.get("attributes").cloned().unwrap_or(Value::Null);
                        let start =
                            run.get("location").and_then(Value::as_u64).unwrap_or(0) as usize;
                        let len = run.get("length").and_then(Value::as_u64).unwrap_or(0) as usize;
                        let font_size = a
                            .get("MSAttributedStringFontAttribute")
                            .and_then(|f| f.get("attributes"))
                            .and_then(|f| f.get("size"))
                            .and_then(Value::as_f64);
                        let color = a.get("MSAttributedStringColorAttribute").map(color_hex);
                        let font_name = a
                            .get("MSAttributedStringFontAttribute")
                            .and_then(|f| f.get("attributes"))
                            .and_then(|f| f.get("name"))
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        let underline =
                            a.get("underlineStyle").and_then(Value::as_i64).unwrap_or(0) > 0;
                        let strikethrough = a
                            .get("strikethroughStyle")
                            .and_then(Value::as_i64)
                            .unwrap_or(0)
                            > 0;
                        node.text_runs.push(crate::font::TextRun {
            text_case: None,
                            start,
                            end: start + len,
                            color: color.clone(),
                            underline,
                            strikethrough,
                            link: None,
                            font_id: font_name,
                            font_size,
                            weight: a.pointer("/MSAttributedStringFontAttribute/attributes/variation/2003265652")
                                .and_then(Value::as_f64).map(|weight| weight as f32),
                        });
                        // first run fills the defaults
                        if node.text_runs.len() == 1 {
                            if let Some(font) = node.text_runs[0].font_id.as_ref() { style.font_id = font.clone(); }
                            if let Some(weight) = node.text_runs[0].weight { style.weight = weight; }
                            node.font_size = font_size.unwrap_or(14.);
                            if let Some(c) = &color {
                                node.fills.push({
                                    let mut p = blank_paint("solid");
                                    p.color = c.to_string();
                                    p
                                });
                            }
                            // P0-2 (import side): paragraph + spacing keys
                            // from the same first run (22 号字典 §4)
                            if let Some(para) = a
                                .get("textStyleBasicParagraphStyle")
                                .or_else(|| a.get("paragraphStyle"))
                            {
                                style.align = alignment_from_code(
                                    para.get("alignment").and_then(Value::as_i64).unwrap_or(0),
                                )
                                .into();
                                let line_px = para
                                    .get("minimumLineHeight")
                                    .or_else(|| para.get("maximumLineHeight"))
                                    .and_then(Value::as_f64);
                                if let Some(px) = line_px
                                    && node.font_size >= 1.
                                {
                                    style.line_height = px / node.font_size;
                                }
                                // minimum/maximumLineHeight collapse into the
                                // kernel's single line-height ratio; a real
                                // range is reported, not silently flattened
                                // (22 号字典 §4).
                                if let (Some(lo), Some(hi)) = (
                                    para.get("minimumLineHeight").and_then(Value::as_f64),
                                    para.get("maximumLineHeight").and_then(Value::as_f64),
                                ) && (hi - lo).abs() > 1e-9
                                {
                                    import_lossy
                                        .push("paragraph-line-height-range-collapsed".into());
                                }
                                style.paragraph_spacing = para
                                    .get("paragraphSpacing")
                                    .and_then(Value::as_f64)
                                    .unwrap_or(0.);
                                // allowsDefaultTighteningForTruncation has no
                                // kernel TextStyle slot; ride bindings and
                                // report instead of silently dropping.
                                if para
                                    .get("allowsDefaultTighteningForTruncation")
                                    .and_then(Value::as_bool)
                                    == Some(true)
                                {
                                    node.bindings.insert(
                                        "sketchTextAllowsTightening".into(),
                                        "1".into(),
                                    );
                                    import_lossy.push("paragraph-tightening-not-modeled".into());
                                }
                            }
                            if let Some(kerning) = a.get("kerning").and_then(Value::as_f64) {
                                style.letter_spacing = kerning;
                            }
                            // 22 号字典 §4 remaining run keys. The kernel
                            // TextStyle has no vertical-alignment or
                            // case-transform slot, so both ride bindings
                            // (first run is authoritative, mirroring how the
                            // other defaults resolve) and export writes them
                            // back onto every run; the unmodeled semantics
                            // are reported, not silently absorbed.
                            if let Some(vertical) = a
                                .get("textStyleVerticalAlignmentKey")
                                .and_then(Value::as_i64)
                            {
                                node.bindings.insert(
                                    "sketchTextVerticalAlignment".into(),
                                    vertical.to_string(),
                                );
                                if vertical != 0 {
                                    import_lossy
                                        .push("text-vertical-alignment-not-modeled".into());
                                }
                            }
                            if let Some(transform) =
                                a.get("MSAttributedStringTextTransformAttribute")
                            {
                                let active = transform.as_i64().is_some_and(|t| t != 0)
                                    || transform.as_bool() == Some(true);
                                node.bindings.insert(
                                    "sketchTextTransform".into(),
                                    transform.to_string(),
                                );
                                if active {
                                    import_lossy.push("text-transform-not-modeled".into());
                                }
                            }
                        }
                    }
                }
                if let Some(spacing) = raw_spacing_behaviour {
                    // Matches the exporter's derivation: a custom line height
                    // archives as 3 (自定义), everything else as the v2-era
                    // default 2. Deviations (e.g. 1 = v2 常基线) need the
                    // binding to round-trip.
                    let custom =
                        style.line_height > 0. && (style.line_height - 1.35).abs() > 1e-9;
                    if spacing != if custom { 3 } else { 2 } {
                        node.bindings
                            .insert("sketchLineSpacingBehaviour".into(), spacing.to_string());
                    }
                }
                node.text_style = Some(style);
            }
            "bitmap" => {
                if let Some(uri) = self.image_ref(layer) {
                    node.fills.push({
                        let mut p = blank_paint("image");
                        p.image = Some(uri);
                        p
                    });
                }
            }
            "symbolMaster" => {
                if let Some(symbol_id) = layer.get("symbolID").and_then(Value::as_str) {
                    node.bindings.insert("symbolID".into(), symbol_id.into());
                }
                // P1-12 (22 号字典 §5): master overrideProperties carry the
                // canOverride inventory, which the kernel component model has
                // no slot for; the raw array rides bindings so the export
                // side can restore it verbatim.
                if let Some(properties) = layer
                    .get("overrideProperties")
                    .and_then(Value::as_array)
                    .filter(|p| !p.is_empty())
                    && let Ok(raw) = serde_json::to_string(properties)
                {
                    node.bindings
                        .insert("sketchOverrideProperties".into(), raw);
                }
                import_layout_grid(&mut node, layer, &mut import_lossy);
            }
            "symbolInstance" => {
                if let Some(symbol_id) = layer.get("symbolID").and_then(Value::as_str) {
                    node.bindings.insert("instanceOf".into(), symbol_id.into());
                    // override values: "ancestorID/layerID_field" → Overrides BTreeMap
                    let mut overrides = crate::components::Overrides::new();
                    if let Some(values) = layer.get("overrideValues").and_then(Value::as_array) {
                        for ov in values {
                            let Some(ov_name) = ov.get("overrideName").and_then(Value::as_str)
                            else {
                                continue;
                            };
                            // split "path/layerID_field" → path key and field name
                            let (path, field) = match ov_name.rfind('/') {
                                Some(i) => (&ov_name[..i], &ov_name[i + 1..]),
                                None => ("self", ov_name),
                            };
                            // strip "_xxx" suffix from layerID to get clean path
                            let clean_path = path.to_string();
                            let raw = ov.get("value").cloned().unwrap_or(Value::Null);
                            // P1-12 (22 号字典 §5): image overrides archive as
                            // MSJSONFileReference dicts; resolve the blob into
                            // a self-contained data URI so re-export cannot
                            // dangle. An unresolvable reference keeps the raw
                            // dict and is reported, never silently dropped.
                            let value = match sketch_override_value_from_native(
                                self.files, field, &raw,
                            ) {
                                Some(resolved) => resolved,
                                None => {
                                    import_lossy.push(format!(
                                        "override-{ov_name}-image-ref-unresolved"
                                    ));
                                    raw
                                }
                            };
                            overrides
                                .entry(clean_path)
                                .or_default()
                                .insert(field.to_string(), value);
                        }
                    }
                    node.instance = Some(crate::components::Instance {
                        component_id: symbol_id.into(),
                        overrides,
                        property_values: BTreeMap::new(),
                    });
                }
            }
            "artboard" | "frame" | "canvasFrame" => {
                if bool_at(layer, "hasBackgroundColor")
                    && let Some(bg) = layer.get("backgroundColor")
                {
                    node.fills.insert(0, solid_paint(bg, 1., "normal"));
                }
                import_layout_grid(&mut node, layer, &mut import_lossy);
            }
            "hotspot" => {
                // Hotspots are bare MSLayers whose prototype semantics live in
                // the flow payload (03-layer-tree.md: MSImmutableHotspotLayer,
                // no style) and the kernel model has no hotspot entity. Keep
                // the limited "hotspot" kind, stash the raw layer so re-export
                // is lossless, and mark the degradation explicitly — never
                // silently masquerade as a frame.
                if let Ok(raw) = serde_json::to_string(layer) {
                    node.bindings.insert("sketchRawLayer".into(), raw);
                }
                node.bindings.insert(
                    "interopLimited".into(),
                    "sketch-hotspot:prototype-flow-preserved-as-raw;no-kernel-entity".into(),
                );
            }
            _ => {}
        }

        // P0-4 remaining color slots, collected read-only so the class arms
        // above stay pure semantic mappings: text run colors (`run.N`, the
        // index inside attributedString.attributes) and the artboard
        // background (`background`).
        if class == "text"
            && let Some(runs) = layer
                .get("attributedString")
                .and_then(|a| a.get("attributes"))
                .and_then(Value::as_array)
        {
            let mut fidelity = Vec::new();
            for (i, run) in runs.iter().enumerate() {
                if let Some(color) = run
                    .get("attributes")
                    .and_then(|a| a.get("MSAttributedStringColorAttribute"))
                {
                    adaptable_collect_color(&mut fidelity, &format!("run.{i}"), color);
                }
            }
            for (key, value) in fidelity {
                node.bindings.insert(key, value);
            }
        }
        if let Some(background) = layer.get("backgroundColor") {
            let mut fidelity = Vec::new();
            adaptable_collect_color(&mut fidelity, "background", background);
            for (key, value) in fidelity {
                node.bindings.insert(key, value);
            }
        }
        // The dark value renders nowhere in the kernel; both values survive
        // in bindings, and the degradation is reported rather than silent.
        if node.bindings.keys().any(|k| {
            k.starts_with("sketchAdaptableColor.")
                && k != "sketchAdaptableColor.updatableColors"
                && k != "sketchAdaptableColor.styleUpdatableColors"
        }) {
            import_lossy.push("adaptable-color-appearance-values-in-bindings".into());
        }

        // Kernel-native payloads that Sketch cannot express (restored after
        // the class arms so freshly built instances keep their property
        // values and masters keep their component definitions).
        if let Some(component) = user_ns.get("component")
            && let Ok(c) = serde_json::from_value::<crate::components::Component>(component.clone())
        {
            node.component = Some(c);
        }
        if let Some(props) = user_ns.get("instanceProperties")
            && let Ok(map) = serde_json::from_value::<BTreeMap<String, Value>>(props.clone())
            && let Some(instance) = &mut node.instance
        {
            instance.property_values = map;
        }
        // Canonical component data uses editor layer keys, not Sketch's native
        // overrideName spelling. Keep both representations explicit; native
        // overrides remain the fallback for ordinary external Sketch files.
        if let Some(instance) = user_ns.get("instance") {
            if let Ok(instance) = serde_json::from_value::<crate::components::Instance>(instance.clone()) {
                node.instance = Some(instance);
            }
        }
        if let Some(key) = user_ns.get("componentKey").and_then(Value::as_str) {
            node.component_key = Some(key.to_owned());
        }
        if user_ns.get("componentSet").and_then(Value::as_bool) == Some(true) {
            node.component_set = true;
        }
        // Kernel-authored layout grid payload (color/opacity have no
        // archived Sketch home and ride our userInfo namespace).
        if let Some(grid) = user_ns.get("layoutGrid")
            && let Ok(g) = serde_json::from_value::<crate::scene::LayoutGrid>(grid.clone())
        {
            node.layout_grid = Some(g);
        }
        // Kernel-authored interactions beyond Sketch's one-flow-per-layer
        // classic model travel verbatim (resolved later, once all ids exist).
        if user_ns.get("prototypeInteractions").is_some() {
            self.flows.push((
                id.clone(),
                user_ns.get("prototypeInteractions").cloned().unwrap(),
            ));
            self.has_user_prototype.insert(id.clone());
        }

        // Prototype flow: any non-hotspot layer with a flow payload becomes
        // a click interaction (03-layer-tree.md: MSImmutableFlowConnection;
        // hotspots keep their raw-layer limited mapping).
        if class != "hotspot"
            && let Some(flow) = layer.get("flow").filter(|f| !f.is_null())
        {
            self.flows.push((id.clone(), flow.clone()));
        }
        if bool_at(layer, "isFlowHome") && self.flow_home.is_none() {
            self.flow_home = Some(id.clone());
        }

        if bool_at(layer, "hasClippingMask") {
            node.mask = true;
        }

        // resizingConstraint 6-bit: X=low 3, Y=high 3 (22 号字典,BCConstraint and/ubfx 实证).
        // 63 = 0b111111 is the measured default on ordinary layers (1,860
        // occurrences) and must NOT become a kernel constraint rule.
        if let Some(rc) = layer
            .get("resizingConstraint")
            .and_then(Value::as_u64)
            .filter(|rc| *rc != 63)
        {
            let x = rc & 0x7;
            let y = (rc >> 3) & 0x7;
            node.constraints = Some(crate::layout::Constraints {
                horizontal: constraint_anchor(x),
                vertical: constraint_anchor(y),
                reference_width: None,
                reference_height: None,
            });
        }
        if let Some(formats) = layer
            .get("exportOptions")
            .and_then(|e| e.get("exportFormats"))
            .and_then(Value::as_array)
        {
            for (index, f) in formats.iter().enumerate() {
                node.export_settings.push(ExportSetting {
                    id: format!("sketch-export-{index}"),
                    format: f
                        .get("fileFormat")
                        .and_then(Value::as_str)
                        .unwrap_or("png")
                        .to_lowercase(),
                    scale: f.get("scale").and_then(Value::as_f64).unwrap_or(1.),
                    suffix: f.get("name").and_then(Value::as_str).unwrap_or_default().into(),
                });
            }
        }

        let mut children = Vec::new();
        if let Some(layers) = layer.get("layers").and_then(Value::as_array) {
            for child in layers {
                children.push(self.layer(child));
            }
        }
        node.children = children;
        if class == "shapeGroup" {
            node.bindings.insert("sketchSourceShapeGroup".into(), json!({
                "parentOperation":layer.get("booleanOperation").and_then(Value::as_i64).unwrap_or(-1),
                "operations":layer.get("layers").and_then(Value::as_array).map(|children|
                    children.iter().map(|child| child.get("booleanOperation").and_then(Value::as_i64).unwrap_or(-1)).collect::<Vec<_>>()).unwrap_or_default(),
                "children":node.children,
            }).to_string());
        }
        if !import_lossy.is_empty() {
            node.bindings.insert(
                "sketchImportLossy".into(),
                serde_json::to_string(&import_lossy).unwrap_or_default(),
            );
        }
        if let Some(uuid) = layer.get("do_objectID").and_then(Value::as_str) {
            self.uuids.insert(uuid.to_ascii_uppercase(), id.clone());
        }
        self.nodes.insert(id.clone(), node);
        id
    }
}

/// Sketch artboard grids → kernel layout grid (21 号 P1-10). The archived
/// field set follows the fig2sketch `LayoutGrid`/`SimpleGrid` dataclasses
/// plus the Marina `Layout` schema names (22 号字典 §7): `layout` is the
/// column grid, `grid` the square one. Sketch stores neither the grid color
/// nor opacity in the document (app-level preferences), so imports pick the
/// reference default and both numbers round-trip through our userInfo
/// namespace instead. Fields without a kernel home are reported, not
/// silently dropped.
fn import_layout_grid(node: &mut Node, layer: &Value, lossy: &mut Vec<String>) {
    if node.layout_grid.is_some() {
        return;
    }
    let notes = |lossy: &mut Vec<String>, note: &str| {
        if !lossy.iter().any(|n| n == note) {
            lossy.push(note.into());
        }
    };
    if let Some(lg) = layer.get("layout").filter(|g| bool_at(g, "isEnabled")) {
        let count = lg
            .get("numberOfColumns")
            .and_then(Value::as_u64)
            .or_else(|| lg.get("columnsCount").and_then(Value::as_u64))
            .unwrap_or(12)
            .clamp(1, 64) as u32;
        let row = lg
            .get("drawHorizontal")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && !lg
                .get("drawVertical")
                .and_then(Value::as_bool)
                .unwrap_or(true);
        let extent = if row { node.height } else { node.width };
        let gutter = if row {
            f64_at(lg, "gutterHeight").max(0.)
        } else {
            f64_at(lg, "gutterWidth").max(0.)
        };
        // The archived dict has a single offset field (horizontalOffset);
        // row grids ride it too — the corpus has no separate vertical name.
        let mut margin = f64_at(lg, "horizontalOffset").max(0.);
        if bool_at(lg, "guttersOutside") {
            notes(lossy, "layout-grid-gutters-outside->inside");
        }
        // Column width is derived from the extent in the kernel model; when
        // the archived fixed width disagrees, recenter the margin so the
        // derived track matches the authored one.
        if let Some(column_width) = lg
            .get("columnWidth")
            .and_then(Value::as_f64)
            .filter(|w| *w > 0.)
        {
            let span = count as f64 * column_width + (count as f64 - 1.) * gutter;
            if span <= extent && extent > 0. {
                let centered = (extent - span) / 2.;
                if (centered - margin).abs() > 1e-6 {
                    notes(lossy, "layout-grid-offset-recentered-for-columnWidth");
                }
                margin = centered;
            }
        }
        if let Some(total) = lg
            .get("totalWidth")
            .and_then(Value::as_f64)
            .filter(|t| *t > 0.)
        {
            notes(lossy, "layout-grid-totalWidth-approximated");
            let _ = total;
        }
        if lg
            .get("drawHorizontal")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && lg
                .get("drawVertical")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        {
            notes(lossy, "layout-grid-second-axis-omitted");
        }
        if lg.get("drawHorizontalLines").and_then(Value::as_bool) == Some(true) {
            notes(lossy, "layout-grid-baselines-omitted");
        }
        notes(lossy, "layout-grid-color-not-in-sketch-document");
        node.layout_grid = Some(crate::scene::LayoutGrid {
            axis: if row { "row".into() } else { "column".into() },
            count,
            gutter,
            margin,
            color: "#ff0000".into(),
            visible: true,
            opacity: 0.1,
        });
    } else if let Some(sg) = layer.get("grid").filter(|g| bool_at(g, "isEnabled")) {
        let cell = f64_at(sg, "gridSize").max(1.);
        let count = ((node.width.max(1.) / cell).floor() as u32).clamp(1, 64);
        let remainder = node.width - count as f64 * cell;
        if remainder.abs() > 1e-6 {
            notes(lossy, "simple-grid-alignment-centered");
        }
        notes(lossy, "simple-grid-thickGridTimes-omitted");
        notes(lossy, "layout-grid-color-not-in-sketch-document");
        node.layout_grid = Some(crate::scene::LayoutGrid {
            axis: "uniform".into(),
            count,
            gutter: 0.,
            margin: (remainder / 2.).max(0.),
            color: "#ff0000".into(),
            visible: true,
            opacity: 0.1,
        });
    }
}

/// P1-13 import: foreign symbols (MSImmutableForeignSymbol family). The
/// embedded symbolMaster copy becomes a local master node so instances
/// reference its symbolID as usual; the library origin rides node bindings
/// and the whole entry — originalMaster included — is kept verbatim for
/// re-export. Entries without an embedded copy cannot become masters; they
/// are preserved raw at the document level, never silently dropped.
fn foreign_symbol_import(
    importer: &mut Importer,
    document: &Value,
    sketch_containers: &mut BTreeMap<String, Value>,
) {
    let Some(entries) = document.get("foreignSymbols").and_then(Value::as_array) else {
        return;
    };
    let mut unresolved = Vec::new();
    for entry in entries {
        let Some(master) = entry.get("symbolMaster").filter(|m| m.is_object()) else {
            unresolved.push(entry.clone());
            continue;
        };
        let id = importer.layer(master);
        let library_id = entry
            .get("libraryID")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if let Some(node) = importer.nodes.get_mut(&id) {
            node.bindings
                .insert("sketchForeignLibraryID".into(), library_id.into());
            if let Ok(raw) = serde_json::to_string(entry) {
                node.bindings.insert("sketchForeignSymbolRaw".into(), raw);
            }
            // The library link itself is static: updates published to the
            // source library never flow into the local copy.
            node.bindings.insert(
                "interopLimited".into(),
                "sketch-foreign-symbol:library-link-static;originalMaster-preserved-raw".into(),
            );
        }
    }
    if !unresolved.is_empty() {
        sketch_containers.insert("foreignSymbolsUnresolved".into(), Value::Array(unresolved));
    }
}

/// Import a `.sketch` bundle into the kernel document model.
///
/// Hotspot layers are admitted through a limited mapping (see the
/// `"hotspot"` arm in [`Importer::layer`]): their prototype flow payload is
/// preserved verbatim in `bindings.sketchRawLayer` and flagged via
/// `bindings.interopLimited` instead of being dropped or disguised.
// Validate both namespaces before adopting any layers or resources. Two native
// definitions must never silently overwrite one another, including aliases in
// our optional original-ID metadata and collisions across paint/text containers.
fn validate_sketch_shared_style_ids(document: &Value) -> Result<()> {
    let aliases = document.pointer("/userInfo/com.futureox.design-kernel/sharedStyleIds");
    let mut wire_ids = std::collections::BTreeSet::new();
    let mut resolved_ids = std::collections::BTreeSet::new();
    for container in ["layerStyles", "layerTextStyles"] {
        let Some(objects) = document.get(container).and_then(|c| c.get("objects")).and_then(Value::as_array) else { continue };
        for object in objects {
            let Some(wire) = object.get("do_objectID").and_then(Value::as_str) else { continue };
            if !wire_ids.insert(wire) {
                return Err(Error::MalformedJson("duplicate shared style wire ID across definitions".into()));
            }
            let resolved = match aliases.and_then(|ids| ids.get(wire)) {
                Some(value) => value.as_str().filter(|id| !id.is_empty())
                    .ok_or_else(|| Error::MalformedJson("invalid shared style original-ID mapping".into()))?,
                None => wire,
            };
            if !resolved_ids.insert(resolved) {
                return Err(Error::MalformedJson("duplicate resolved shared style ID across definitions".into()));
            }
        }
    }
    Ok(())
}

pub fn import_sketch(bytes: &[u8]) -> Result<Document> {
    let files = crate::sketch::archive::read(bytes)
        .map_err(|e| Error::Unsupported(e.to_string()))?;
    let meta = json_part(&files, "meta.json")?;
    let document = json_part(&files, "document.json")?;
    validate_sketch_shared_style_ids(&document)?;

    let mut doc = Document {
        reviews: Vec::new(),
        design_system: None,
        prototype: None,
        fd_compatibility: None,
        schema_version: 1,
        color_management: None,
        raster_profile: None,
        id: "imported-sketch".into(),
        name: meta
            .get("appVersion")
            .and_then(Value::as_str)
            .map(|v| format!("Imported from Sketch {v}"))
            .unwrap_or_else(|| "Imported from Sketch".into()),
        pages: Vec::new(),
        nodes: BTreeMap::new(),
        fonts: BTreeMap::new(),
        animations: Vec::new(),
    };

    let mut importer = Importer {
        color_space: if document.get("colorSpace").and_then(Value::as_i64) == Some(2) { ColorSpace::DisplayP3 } else { ColorSpace::Srgb },
        files: &files,
        nodes: BTreeMap::new(),
        uuids: BTreeMap::new(),
        flows: Vec::new(),
        has_user_prototype: std::collections::HashSet::new(),
        flow_home: None,
    };
    let mut page_index: BTreeMap<String, Value> = BTreeMap::new();
    for (name, data) in &files {
        if let Some(page_id) = name
            .strip_prefix("pages/")
            .and_then(|n| n.strip_suffix(".json"))
        {
            let value = serde_json::from_slice::<Value>(data)
                .map_err(|e| Error::MalformedJson(format!("{name}: {e}")))?;
            page_index.insert(page_id.into(), value);
        }
    }

    // Native page order is authored data. Resolve archive identities directly;
    // originalId only renames the resulting kernel identity, never its file.
    let mut ordered = Vec::new();
    if let Some(refs) = document.get("pages").and_then(Value::as_array) {
        for reference in refs {
            let reference = reference.get("_ref").and_then(Value::as_str)
                .ok_or_else(|| Error::MalformedJson("page reference requires _ref".into()))?;
            let file_id = reference.trim_start_matches("pages/").trim_end_matches(".json");
            let page = page_index.get(file_id)
                .ok_or_else(|| Error::MissingPart(format!("pages/{file_id}.json")))?;
            let kernel_id = page.get("userInfo")
                .and_then(|u| u.get("com.futureox.design-kernel"))
                .and_then(|u| u.get("originalId"))
                .and_then(Value::as_str)
                .unwrap_or(file_id);
            let name = page.get("name").and_then(Value::as_str).unwrap_or("Page");
            ordered.push((file_id.to_owned(), kernel_id.to_owned(), name.to_owned()));
        }
    }
    if ordered.is_empty() {
        ordered = page_index
            .iter()
            .map(|(file_id, p)| {
                let kernel_id = p
                    .get("userInfo")
                    .and_then(|u| u.get("com.futureox.design-kernel"))
                    .and_then(|u| u.get("originalId"))
                    .and_then(Value::as_str)
                    .unwrap_or(file_id.as_str())
                    .to_string();
                let name = p
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Page")
                    .to_string();
                (file_id.clone(), kernel_id, name)
            })
            .collect();
    }

    for (file_id, kernel_id, page_name) in ordered {
        let page_json = page_index
            .get(&file_id)
            .cloned()
            .unwrap_or_else(|| json!({"_class": "page", "name": page_name, "layers": []}));
        let mut page_node = crate::facet::sample_node(&kernel_id, "page");
        page_node.name = page_name.clone();
        let mut children = Vec::new();
        if let Some(layers) = page_json.get("layers").and_then(Value::as_array) {
            for layer in layers {
                children.push(importer.layer(layer));
            }
        }
        page_node.children = children.clone();
        importer.nodes.insert(kernel_id.clone(), page_node);
        doc.pages.push(Page {
            guides: vec![],
            id: kernel_id,
            name: page_name,
            children,
            background: "#ffffff".into(),
        });
    }
    // P0-4: color space (document.json colorSpace: 0 unmanaged, 1 sRGB, 2 P3)
    match document.get("colorSpace").and_then(Value::as_i64) {
        Some(1) => {
            doc.color_management = Some(crate::color::ColorSettings::default());
        }
        Some(2) => {
            doc.color_management = Some(crate::color::ColorSettings {
                document_space: crate::color::ColorSpace::DisplayP3,
                ..Default::default()
            });
        }
        _ => {}
    }
    // P1-6: shared style containers → design system styles
    let mut styles = BTreeMap::new();
    let mut style_fidelity: BTreeMap<String, Value> = BTreeMap::new();
    for (container, kind) in [("layerStyles", "paint"), ("layerTextStyles", "text")] {
        let Some(objects) = document
            .get(container)
            .and_then(|c| c.get("objects"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for object in objects {
            let Some(style_id) = object.get("do_objectID").and_then(Value::as_str) else {
                continue;
            };
            let name = object
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let style_id = document.pointer("/userInfo/com.futureox.design-kernel/sharedStyleIds")
                .and_then(|ids| ids.get(style_id)).and_then(Value::as_str).unwrap_or(style_id);
            let style_object = object.get("value").or_else(|| object.get("style")).cloned().unwrap_or(Value::Null);
            // Full Sketch layer styles carry borders/shadows next to their
            // fills (22 号字典 §6); they survive as paint-style parts.
            let mut strokes = Vec::new();
            let mut effects = Vec::new();
            if kind == "paint" && !style_object.is_null() {
                strokes = importer.strokes(&style_object);
                effects = importer.effects(&style_object);
            }
            let value = match kind {
                // paint styles archive their fills; convert them to kernel paints
                "paint" => style_object
                    .get("fills")
                    .and_then(Value::as_array)
                    .map(|fills| {
                        Value::Array(
                            fills
                                .iter()
                                .filter_map(|f| importer.paint_part(f, 1., "normal", [1., 1.]))
                                .filter_map(|p| serde_json::to_value(p).ok())
                                .collect(),
                        )
                    })
                    .unwrap_or(Value::Null),
                // text styles keep their paragraph basics
                _ => style_object.get("textStyle").unwrap_or(&style_object)
                    .get("encodedAttributes")
                    .map(|attrs| {
                        let para = attrs
                            .get("textStyleBasicParagraphStyle")
                            .or_else(|| attrs.get("paragraphStyle"))
                            .cloned()
                            .unwrap_or(Value::Null);
                        json!({
                            "fontId": attrs.pointer("/MSAttributedStringFontAttribute/attributes/name").and_then(Value::as_str).unwrap_or("default"),
                            "weight": attrs.pointer("/MSAttributedStringFontAttribute/attributes/variation/2003265652").and_then(Value::as_f64).unwrap_or(400.),
                            "letterSpacing": attrs.get("kerning").and_then(Value::as_f64).unwrap_or(0.),
                            "paragraphSpacing": para.get("paragraphSpacing").and_then(Value::as_f64).unwrap_or(0.),
                            "paragraphIndent": para.get("firstLineHeadIndent").and_then(Value::as_f64).unwrap_or(0.),
                            "align": alignment_from_code(
                                para.get("alignment").and_then(Value::as_i64).unwrap_or(0)),
                            "lineHeight": para
                                .get("minimumLineHeight")
                                .or_else(|| para.get("maximumLineHeight"))
                                .and_then(Value::as_f64)
                                .map(|px| px / attrs.pointer("/MSAttributedStringFontAttribute/attributes/size").and_then(Value::as_f64).filter(|v| *v > 0.).unwrap_or(16.))
                                .unwrap_or(1.35),
                            "wrap": false
                        })
                    })
                    .unwrap_or(Value::Null),
            };
            if value.is_null() {
                continue;
            }
            // P0-4 container side: adaptable color / swatchID slots inside
            // the shared style definition, plus its updatableColors marker,
            // keyed by style id so export can splice them back.
            let mut fidelity: Vec<(String, String)> = Vec::new();
            adaptable_collect_style(&style_object, &mut fidelity);
            if let Some(updatable) = style_object.get("updatableColors") {
                fidelity.push((
                    "updatableColors".into(),
                    serde_json::to_string(updatable).unwrap_or_default(),
                ));
            }
            if !fidelity.is_empty() {
                let mut colors = Map::new();
                let mut swatches = Map::new();
                let mut entry = Map::new();
                for (key, raw) in fidelity {
                    if key == "updatableColors" {
                        entry.insert(key, serde_json::from_str(&raw).unwrap_or(Value::Null));
                    } else if let Some(slot) = key.strip_prefix("sketchAdaptableColor.") {
                        colors.insert(
                            slot.into(),
                            serde_json::from_str(&raw).unwrap_or(Value::Null),
                        );
                    } else if let Some(slot) = key.strip_prefix("sketchSwatchID.") {
                        swatches.insert(slot.into(), Value::String(raw));
                    }
                }
                if !colors.is_empty() {
                    entry.insert("colors".into(), Value::Object(colors));
                }
                if !swatches.is_empty() {
                    entry.insert("swatchID".into(), Value::Object(swatches));
                }
                style_fidelity.insert(style_id.to_string(), Value::Object(entry));
            }
            styles.insert(
                style_id.to_string(),
                crate::design_system::SharedStyle {
                    name,
                    kind: kind.into(),
                    value,
                    strokes,
                    effects,
                },
            );
        }
    }
    // P1-13: document-level containers without a kernel-native home
    // (design_system has no swatch concept) ride the raw container store;
    // the shared-style fidelity map joins them under a fixed key.
    let mut sketch_containers: BTreeMap<String, Value> = BTreeMap::new();
    if let Some(ids) = document.pointer("/userInfo/com.futureox.design-kernel/sharedStyleIds") {
        sketch_containers.insert("sharedStyleIds".into(), ids.clone());
    }
    for key in [
        "sharedSwatches",
        "foreignLayerStyles",
        "foreignTextStyles",
        "foreignSwatches",
        "foreignStyles",
        "libraries",
    ] {
        if let Some(value) = document.get(key).filter(|v| !v.is_null()) {
            sketch_containers.insert(key.to_string(), value.clone());
        }
    }
    if !style_fidelity.is_empty() {
        sketch_containers.insert(
            "sharedStyleFidelity".into(),
            serde_json::to_value(&style_fidelity).unwrap_or(Value::Null),
        );
    }
    // P1-13: foreign symbols — the embedded symbolMaster copy becomes a
    // local master node (instances reference its symbolID as usual).
    foreign_symbol_import(&mut importer, &document, &mut sketch_containers);
    if !styles.is_empty() || !sketch_containers.is_empty() {
        doc.design_system = Some(crate::design_system::DesignSystem {
            styles,
            sketch_containers,
            ..Default::default()
        });
    }
    // Prototype flows → interactions (21 号 P2-11). Destinations address the
    // archived do_objectID; the uuid map built during layer import restores
    // the kernel id. Unmappable fields are reported on the node, not dropped.
    doc.nodes = importer.nodes;
    crate::interop_resources::import_fonts(&document, &mut doc)?;
    let mut text_layouts = Map::new();
    for node in doc.nodes.values_mut() {
        if let Some(frame) = node.bindings.remove("sketchSourceTextFrameRaw") {
            text_layouts.insert(node.id.clone(), json!({
                "frame":serde_json::from_str::<Value>(&frame).map_err(|e| Error::MalformedJson(e.to_string()))?,
                "signature":text_layout_signature(node), "width":node.width,
                "height":node.height,"transform":node.transform
            }));
        }
    }
    if !text_layouts.is_empty() {
        doc.design_system.get_or_insert_with(Default::default).sketch_containers
            .insert("textSourceLayouts".into(), Value::Object(text_layouts));
    }
    let mut interactions: BTreeMap<String, Vec<crate::prototype::Interaction>> = BTreeMap::new();
    for (node_id, payload) in &importer.flows {
        let Some(node) = doc.nodes.get_mut(node_id) else {
            continue;
        };
        if importer.has_user_prototype.contains(node_id) {
            // userInfo payload is authoritative; the native flow dict that
            // rode alongside it is the subset we exported, so skip it.
            match serde_json::from_value::<Vec<crate::prototype::Interaction>>(payload.clone()) {
                Ok(events) => {
                    interactions.insert(node_id.clone(), events);
                }
                Err(_) => {
                    node.bindings.insert(
                        "sketchFlowUntranslated".into(),
                        "prototypeInteractions-payload-unreadable".into(),
                    );
                }
            }
            continue;
        }
        let mut notes: Vec<String> = Vec::new();
        let destination = payload
            .get("destinationArtboardID")
            .and_then(Value::as_str)
            .map(str::to_ascii_uppercase)
            .and_then(|uuid| importer.uuids.get(&uuid).cloned());
        if destination.is_none()
            && payload
                .get("destinationArtboardID")
                .and_then(Value::as_str)
                .is_some()
        {
            notes.push("flow-destination-unresolved".into());
        }
        if let Some(action_type) = payload.get("actionType").and_then(Value::as_i64)
            && action_type != 2
        {
            notes.push(format!("flow-actionType={action_type}"));
        }
        for field in [
            "maintainScrollPosition",
            "shouldCloseExistingOverlays",
            "overlayRelativePosition",
        ] {
            if payload.get(field).is_some_and(|v| !v.is_null()) {
                notes.push(format!("flow-{field}-unmapped"));
            }
        }
        let overlay = payload.get("overlaySettings").is_some_and(|s| !s.is_null());
        if overlay {
            // MSImmutableFlowOverlaySettings position fields have no
            // documented archived names.
            notes.push("flow-overlaySettings-position-unmapped".into());
        }
        let duration_ms = payload
            .get("transition")
            .and_then(|t| t.get("duration"))
            .and_then(Value::as_f64)
            .map(|seconds| (seconds * 1000.).round().clamp(0., 10000.) as u32)
            .unwrap_or(0);
        if let Some(animation) = payload.get("animationType").and_then(Value::as_i64)
            && animation != -1
        {
            notes.push(format!("flow-animationType={animation}"));
        }
        if let Some(target) = destination {
            interactions
                .entry(node_id.clone())
                .or_default()
                .push(crate::prototype::Interaction {
                    trigger: "click".into(),
                    actions: vec![crate::prototype::Action {
                        kind: if overlay { "overlay" } else { "navigate" }.into(),
                        target: Some(target),
                        value: None,
                        duration_ms,
                        easing_curve: None,
                        overlay_position: None,
                        ..Default::default()
                    }],
                    delay_ms: 0,
                    condition: None,
                });
        }
        if !notes.is_empty()
            && let Some(node) = doc.nodes.get_mut(node_id)
        {
            node.bindings.insert(
                "sketchFlowUntranslated".into(),
                serde_json::to_string(&notes).unwrap_or_default(),
            );
        }
    }
    let start = importer
        .flow_home
        .clone()
        .filter(|id| doc.nodes.contains_key(id));
    if !interactions.is_empty() || start.is_some() {
        doc.prototype = Some(crate::prototype::Prototype {
            start_node: start,
            interactions,
        });
    }
    // honest serialization version, mirroring the fig importer gates: the
    // newly imported constraints/layouts/components/text styles need 4+,
    // stroke markers 8, slices 10
    let mut version = doc.schema_version.max(1);
    if doc.design_system.is_some() {
        // design systems (shared styles, swatch/foreign containers) need 4+
        version = version.max(4);
    }
    if doc.nodes.values().any(|n| {
        n.requires_schema4()
            || n.layout.is_some()
            || n.sizing.is_some()
            || n.constraints.is_some()
            || n.component.is_some()
            || n.instance.is_some()
    }) {
        version = version.max(4);
    }
    if doc.prototype.is_some() {
        version = version.max(4);
    }
    if crate::stroke::has_markers(&doc)
        || doc.nodes.values().any(|n| !n.export_settings.is_empty())
    {
        version = version.max(8);
    }
    if doc.nodes.values().any(|n| n.kind == "slice"
        || n.export_settings.iter().any(|s| !matches!(s.format.as_str(), "png" | "svg"))) {
        version = version.max(10);
    }
    // layout grids and shared-style strokes/effects are schema-12 facets
    if doc.nodes.values().any(|n| n.layout_grid.is_some())
        || doc.design_system.as_ref().is_some_and(|s| {
            s.styles
                .values()
                .any(|st| !st.strokes.is_empty() || !st.effects.is_empty())
        })
    {
        version = version.max(12);
    }
    doc.schema_version = version;
    Ok(doc)
}

/// One admission contract for browsers, Electron and native callers. The
/// source archive remains a separate file; this document is the editable
/// compatibility mapping consumed by the shared engine.
#[derive(Serialize)]
pub struct SketchImportReport {
    pub document: Document,
    pub warnings: Vec<String>,
}

pub const MAX_IMPORT_WARNINGS: usize = 32;

/// Resolve the separate Sketch symbol identity before shared-model admission.
/// The low-level archival importer intentionally retains native spellings.
fn admit_sketch_symbols(document: &mut Document) -> Result<()> {
    let mut symbols = BTreeMap::<String, String>::new();
    for node in document.nodes.values_mut() {
        if let Some(symbol) = node.bindings.get("symbolID") {
            if symbols.insert(symbol.to_ascii_uppercase(), node.id.clone()).is_some() {
                return Err(Error::Unsupported("ambiguous duplicate Sketch symbolID".into()));
            }
            node.component.get_or_insert_with(Default::default);
        }
    }
    // An authored compatibility archive may refer to a canonical node ID.
    for node in document.nodes.values().filter(|n| n.component.is_some()) {
        let key = node.id.to_ascii_uppercase();
        if symbols.get(&key).is_some_and(|id| id != &node.id) {
            return Err(Error::Unsupported("ambiguous Sketch symbol/node identity".into()));
        }
        symbols.insert(key, node.id.clone());
    }
    for node in document.nodes.values_mut() {
        if let Some(instance) = &mut node.instance {
            instance.component_id = symbols.get(&instance.component_id.to_ascii_uppercase()).cloned()
                .ok_or_else(|| Error::Unsupported("Sketch instance requires an embedded symbol master".into()))?;
        }
        // Stable keys must survive the host's fresh node-ID assignment.
        if !symbols.is_empty() { node.component_key.get_or_insert_with(|| node.id.clone()); }
    }
    if !symbols.is_empty() { document.schema_version = document.schema_version.max(4); }
    fn native_path(document: &Document, root: &str, path: &str) -> Option<String> {
        let mut scope = root.to_owned();
        let mut keys = Vec::new();
        let parts: Vec<_> = path.split('/').collect();
        for (index, part) in parts.iter().enumerate() {
            let mut pending = vec![scope.clone()];
            let mut found = None;
            let mut visited = std::collections::BTreeSet::new();
            while let Some(id) = pending.pop() {
                if !visited.insert(id.clone()) || visited.len() > 20000 { return None }
                let node = document.nodes.get(&id)?;
                if id.eq_ignore_ascii_case(part) { found = Some(node); break }
                if id == scope || node.instance.is_none() { pending.extend(node.children.iter().cloned()); }
            }
            let node = found?;
            if index + 1 == parts.len() {
                keys.push(if node.id == root { "$root".to_owned() }
                    else { node.component_key.as_ref().unwrap_or(&node.id).clone() });
            } else if let Some(instance) = &node.instance {
                keys.push(node.component_key.as_ref().unwrap_or(&node.id).clone());
                scope = instance.component_id.clone();
            } else { scope = node.id.clone(); }
        }
        Some(keys.join("/"))
    }
    let mut replacements = Vec::new();
    for node in document.nodes.values() {
        let Some(instance) = &node.instance else { continue };
        let mut overrides = crate::components::Overrides::new();
        for (path, fields) in &instance.overrides {
            for (field, value) in fields {
                let (key, field, mut value) = if crate::components::FIELDS.contains(&field.as_str())
                    || matches!(field.as_str(), "swapComponent" | "propertyValues") {
                    (path.clone(), field.clone(), value.clone())
                } else {
                    let (layer, native_field) = field.rsplit_once('_')
                        .ok_or_else(|| Error::Unsupported(format!("Sketch override `{field}` has no editable mapping")))?;
                    let full_path = if path == "self" { layer.to_owned() } else { format!("{path}/{layer}") };
                    let key = native_path(document, &instance.component_id, &full_path)
                        .ok_or_else(|| Error::Unsupported(format!("Sketch override target `{full_path}` could not be resolved")))?;
                    let field = match native_field {
                        "stringValue" if value.is_string() => "text",
                        "symbolID" if value.is_string() => "swapComponent",
                        "isVisible" if value.is_boolean() => "visible",
                        _ => return Err(Error::Unsupported(format!("Sketch override `{native_field}` has no supported editable mapping; keep the original .sketch file"))),
                    };
                    (key, field.to_owned(), value.clone())
                };
                if field == "swapComponent" {
                    let symbol = value.as_str().ok_or_else(|| Error::Unsupported("invalid Sketch symbol override".into()))?;
                    value = json!(symbols.get(&symbol.to_ascii_uppercase())
                        .ok_or_else(|| Error::Unsupported("Sketch symbol override requires an embedded master".into()))?);
                }
                if overrides.entry(key).or_default().insert(field, value).is_some() {
                    return Err(Error::Unsupported("ambiguous Sketch overrides map to the same property".into()));
                }
            }
        }
        replacements.push((node.id.clone(), overrides));
    }
    for (id, overrides) in replacements {
        document.nodes.get_mut(&id).unwrap().instance.as_mut().unwrap().overrides = overrides;
    }
    Ok(())
}

pub fn import_sketch_report(bytes: &[u8]) -> Result<SketchImportReport> {
    let mut document = import_sketch(bytes)?;
    admit_sketch_symbols(&mut document)?;
    let mut warnings = std::collections::BTreeSet::new();
    warnings.insert("Sketch compatibility import: unsupported source fields may not be editable or survive export; keep the original .sketch file.".to_owned());
    // A shared document stores pages outside nodes. The low-level codec also
    // exposes native page wrappers for legacy inspection; they are not an
    // additional reachable canvas node in the application model.
    for page in &document.pages {
        if document.nodes.get(&page.id).is_some_and(|node| node.kind == "page") {
            document.nodes.remove(&page.id);
        }
    }
    // Sketch archives normally name installed fonts without embedding their
    // bytes. Rendering requires portable resources; retain source identities
    // as format metadata and make the substitution visible before admission.
    for node in document.nodes.values_mut() {
        if node.kind == "hotspot" || node.bindings.get("interopLimited")
            .is_some_and(|value| value.starts_with("sketch-unknown-layer-class:"))
        {
            return Err(Error::Unsupported(format!(
                "Sketch layer `{}` ({}) has no supported editable mapping; keep the original .sketch file",
                node.id, node.kind)));
        }
        match node.kind.as_str() {
            "path" => node.kind = "vector".into(),
            "rect" | "image" => node.kind = "rectangle".into(),
            "slice" | "frame" | "section" | "group" | "rectangle" | "ellipse"
            | "polygon" | "star" | "line" | "vector" | "text" => {}
            _ => return Err(Error::Unsupported(format!(
                "Sketch layer `{}` kind `{}` has no supported editable mapping; keep the original .sketch file",
                node.id, node.kind))),
        }
        if node.bindings.get("sketchOpenPath").is_some_and(|v| v == "true")
            && let Some(network) = &mut node.network
        {
            network.edges.pop();
        }
        if node.bindings.get("sketchNormalizedCoordinates").is_some_and(|v| v == "true")
            && let Some(network) = &mut node.network
        {
            for vertex in &mut network.vertices {
                vertex.x *= node.width;
                vertex.y *= node.height;
            }
            for edge in &mut network.edges {
                for point in [&mut edge.c1, &mut edge.c2].into_iter().flatten() {
                    point.x *= node.width;
                    point.y *= node.height;
                }
            }
            // Exported compatibility paths use the kernel's pixel-coordinate
            // encoding; never scale an already admitted document a second time.
            node.bindings.remove("sketchNormalizedCoordinates");
        }
        if let Some(group) = node.bindings.get("sketchSourceShapeGroup") {
            let source: Value = serde_json::from_str(group).map_err(|e| Error::MalformedJson(e.to_string()))?;
            let codes: Vec<i64> = serde_json::from_value(source["operations"].clone())
                .map_err(|e| Error::MalformedJson(e.to_string()))?;
            if node.children.is_empty() || node.children.len() > 64 || codes.len() != node.children.len() {
                return Err(Error::Unsupported(format!("Sketch shapeGroup `{}` requires 1–64 operands", node.id)));
            }
            let operations = codes.iter().skip(1).map(|code| match code {
                -1 | 0 => Some(crate::boolean::Operation::Union),
                value => boolean_from_code(*value),
            }).collect::<Option<Vec<_>>>()
                .ok_or_else(|| Error::Unsupported(format!("Sketch shapeGroup `{}` has an unknown operand operation", node.id)))?;
            let operation = operations.first().copied().unwrap_or(crate::boolean::Operation::Union);
            if operations.iter().any(|other| *other != operation) {
                return Err(Error::Unsupported(format!("Sketch shapeGroup `{}` uses mixed operand operations; keep the original .sketch file", node.id)));
            }
            node.kind = "vector".into();
            node.boolean_operation = Some(operation);
            node.bindings.insert("sketchShapeGroupMappedOperation".into(), serde_json::to_string(&operation)
                .map_err(|e| Error::MalformedJson(e.to_string()))?);
        } else if let Some(operation) = node.boolean_operation {
            node.bindings.insert("sketchOperandBooleanOperation".into(),
                serde_json::to_string(&operation).map_err(|e| Error::MalformedJson(e.to_string()))?);
            node.boolean_operation = None;
            warnings.insert("Sketch: operand boolean flags remain source metadata; executable boolean groups use the shared vector model.".into());
        }
        if node.width == 0. || node.height == 0. {
            node.bindings.insert("sketchSourceZeroExtent".into(),
                json!({"width":node.width,"height":node.height}).to_string());
            // Degenerate native paths retain their existing absolute network
            // coordinates. Only the editable selection box gains an extent.
            node.width = node.width.max(1e-6);
            node.height = node.height.max(1e-6);
            warnings.insert("Sketch: zero-sized layers use a minimum selection box; source dimensions remain in metadata.".into());
        }
        let mut source_fonts = Map::new();
        if let Some(style) = &mut node.text_style {
            if style.font_id != "default" && !document.fonts.contains_key(&style.font_id) {
                source_fonts.insert("style".into(), Value::String(style.font_id.clone()));
                style.font_id = "default".into();
            }
            let unavailable: Vec<String> = style.fallbacks.iter()
                .filter(|font| *font != "default" && !document.fonts.contains_key(*font))
                .cloned().collect();
            if !unavailable.is_empty() {
                source_fonts.insert("fallbacks".into(), json!(unavailable));
                style.fallbacks.retain(|font| font == "default" || document.fonts.contains_key(font));
            }
        }
        let mut runs = Map::new();
        for (index, run) in node.text_runs.iter_mut().enumerate() {
            if let Some(font) = run.font_id.as_mut()
                && font != "default" && !document.fonts.contains_key(font)
            {
                runs.insert(index.to_string(), Value::String(font.clone()));
                *font = "default".into();
            }
        }
        if !runs.is_empty() {
            source_fonts.insert("runs".into(), Value::Object(runs));
        }
        if !source_fonts.is_empty() {
            node.bindings.insert("sketchSourceFonts".into(),
                serde_json::to_string(&source_fonts).map_err(|e| Error::MalformedJson(e.to_string()))?);
            warnings.insert("Sketch: fonts without embedded resources use the default font; source font names remain in metadata.".into());
        }
        if let Some(source) = document.design_system.as_mut()
            .and_then(|system| system.sketch_containers.get_mut("textSourceLayouts"))
            .and_then(|layouts| layouts.get_mut(&node.id)).and_then(Value::as_object_mut)
        {
            // Admission's font fallback is derived state. Keep the raw source
            // frame while certifying against the actually editable text model.
            source.insert("signature".into(), text_layout_signature(node));
        }
    }
    let mut omitted = false;
    for node in document.nodes.values() {
        for key in ["sketchImportLossy", "sketchExportLossy", "sketchFlowUntranslated", "interopLimited"] {
            let Some(value) = node.bindings.get(key) else { continue };
            // Aggregate by feature; never emit layer names, IDs or one line per
            // node. The cap also bounds unrecognized source extension strings.
            let notes = serde_json::from_str::<Vec<String>>(value)
                .unwrap_or_else(|_| vec![value.clone()]);
            for note in notes {
                let note = if note.starts_with("override-") && note.ends_with("-image-ref-unresolved") {
                    "image override reference unresolved; source value retained".into()
                } else {
                    note.chars().take(160).collect::<String>()
                };
                let warning = format!("Sketch: {note}");
                if warnings.len() < MAX_IMPORT_WARNINGS - 1 || warnings.contains(&warning) {
                    warnings.insert(warning);
                } else {
                    omitted = true;
                }
            }
        }
    }
    if document.design_system.as_ref().is_some_and(|system| {
        system.sketch_containers.contains_key("foreignSymbolsUnresolved")
    }) {
        warnings.insert("Sketch: external symbols without an embedded master remain source data.".into());
    }
    if omitted {
        warnings.insert("Sketch: additional compatibility notices omitted; inspect retained source fields.".into());
    }
    // Turn native Sketch shared-style links into executable kernel references.
    // Keep unresolved IDs as source metadata rather than inventing definitions.
    if let Some(system) = &mut document.design_system {
        for shared in system.styles.values_mut().filter(|style| style.kind == "text") {
            if let Ok(mut style) = serde_json::from_value::<crate::font::TextStyle>(shared.value.clone()) {
                if style.font_id != "default" && !document.fonts.contains_key(&style.font_id) {
                    style.font_id = "default".into();
                }
                shared.value = serde_json::to_value(style).map_err(|e| Error::MalformedJson(e.to_string()))?;
            }
        }
        for node in document.nodes.values_mut() {
            if let Some(id) = node.style_refs.get("sketchSharedStyleID").cloned() {
                let id = system.sketch_containers.get("sharedStyleIds")
                    .and_then(|ids| ids.get(&id)).and_then(Value::as_str).unwrap_or(&id).to_owned();
                if let Some(shared) = system.styles.get(&id) {
                    let field = if shared.kind == "text" { "textStyle" } else { "fills" };
                    node.style_refs.insert(field.into(), id);
                } else {
                    warnings.insert("Sketch: unresolved shared style reference retained as source metadata.".into());
                }
            }
        }
    }
    // Format metadata is opaque source data, never a variable binding or a
    // shared-style property. Keep it outside the executable node contract.
    let mut metadata = Map::new();
    for node in document.nodes.values_mut() {
        let mut bindings = BTreeMap::new();
        node.bindings.retain(|key, value| {
            if key.starts_with("sketch") || matches!(key.as_str(), "symbolID" | "instanceOf" | "interopLimited") {
                bindings.insert(key.clone(), value.clone());
                false
            } else { true }
        });
        let mut style_refs = BTreeMap::new();
        node.style_refs.retain(|key, value| {
            if key.starts_with("sketch") {
                style_refs.insert(key.clone(), value.clone());
                false
            } else { true }
        });
        if !bindings.is_empty() || !style_refs.is_empty() {
            metadata.insert(node.id.clone(), json!({"bindings":bindings,"styleRefs":style_refs}));
        }
    }
    if !metadata.is_empty() {
        document.design_system.get_or_insert_with(Default::default)
            .sketch_containers.insert("nodeMetadata".into(), Value::Object(metadata));
        document.schema_version = document.schema_version.max(4);
    }
    document.validate().map_err(Error::InvalidDocument)?;
    let warnings = warnings.into_iter().take(MAX_IMPORT_WARNINGS).collect();
    Ok(SketchImportReport { document, warnings })
}

struct ExportedImages {
    font_weight_axes: BTreeMap<String, bool>,
    color_settings: ColorSettings,
    entries: Vec<(String, Vec<u8>)>,
    seen: std::collections::HashSet<String>,
}

/// Export straight coordinates in the Sketch document's SDR profile. Alpha is
/// coverage; neither the transfer function nor the profile matrix touches it.
/// Only matrix/transfer roundoff (1e-10 encoded channel units) may be snapped at
/// the gamut boundary. Genuine gamut loss and HDR need an explicit conversion
/// workflow, so they fail before any archive is produced.
fn hex_to_rgba(value: &str, alpha: f64, settings: ColorSettings) -> Result<Value> {
    if value.starts_with('#') {
        // Keep the existing exact byte/255 path; color::parse uses f32 Pixel
        // for Hex and would perturb already-correct archived SDR coordinates.
        if value.len() != 7 || !value.is_ascii() {
            return Err(Error::Unsupported(format!("Invalid Sketch color `{value}`")));
        }
        let channel = |start| u8::from_str_radix(&value[start..start + 2], 16)
            .map(|v| f64::from(v) / 255.)
            .map_err(|_| Error::Unsupported(format!("Invalid Sketch color `{value}`")));
        return Ok(json!({"_class":"color", "red":channel(1)?, "green":channel(3)?,
            "blue":channel(5)?, "alpha":alpha.clamp(0., 1.)}));
    }
    let (source, rgb, intrinsic_alpha) = crate::color::parse(value, settings.document_space)
        .map_err(|reason| Error::Unsupported(format!("Sketch color `{value}`: {reason}")))?;
    if matches!(source, ColorSpace::Pq | ColorSpace::Hlg) {
        return Err(Error::Unsupported(format!("Sketch cannot preserve HDR color `{value}`; use the native format or explicitly tone-map an SDR copy")));
    }
    let rgb = if source == settings.document_space { rgb } else {
        settings.from_working(settings.to_working(rgb, source), settings.document_space)
    };
    const ROUND_OFF: f64 = 1e-10;
    if rgb.iter().any(|v| !v.is_finite() || *v < -ROUND_OFF || *v > 1. + ROUND_OFF) {
        return Err(Error::Unsupported(format!("Sketch color `{value}` is outside the target {:?} gamut; no implicit clipping or tone mapping is applied", settings.document_space)));
    }
    let [red, green, blue] = rgb.map(|v| v.clamp(0., 1.));
    Ok(json!({"_class":"color", "red":red, "green":green, "blue":blue,
        "alpha":(intrinsic_alpha * alpha).clamp(0., 1.)}))
}

fn data_uri_bytes(uri: &str) -> Option<(String, Vec<u8>)> {
    let payload = uri.strip_prefix("data:")?;
    let (meta, data64) = payload.split_once(',')?;
    let mime = meta.split(';').next().unwrap_or("image/png").to_string();
    let bytes =
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data64.trim()).ok()?;
    Some((mime, bytes))
}

fn sha1_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    // Sketch names image blobs by SHA-1; sha2 offers SHA-256 here. We keep the
    // same content-addressing idea with a distinct prefix so imports and
    // exports cannot collide with native documents.
    let digest = sha2::Sha256::digest(bytes);
    format!("fxdk-{}", &hex(&digest[..12]))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Sketch readers expect UUID-shaped object IDs; derive one deterministically
/// from our node id so re-exports stay stable, and stash the original id in
/// userInfo for loss-free round-trips.
fn sketch_shared_style_id(id: &str) -> String {
    if id.len() == 36 && id.bytes().enumerate().all(|(i, b)| {
        if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() }
    }) { id.to_owned() } else { sketch_id(id) }
}

fn sketch_id(id: &str) -> String {
    use sha2::Digest;
    let d = sha2::Sha256::digest(id.as_bytes());
    let h = hex(&d[..16]);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
    .to_uppercase()
}

fn export_paint(paint: &Paint, images: &mut ExportedImages, size: [f64; 2]) -> Result<Option<Value>> {
    if !paint.visible {
        return Ok(None);
    }
    Ok(match paint.kind.as_str() {
        "solid" if !paint.color.is_empty() => Some(json!({
            "_class": "fill", "isEnabled": true, "fillType": 0,
            "color": hex_to_rgba(&paint.color, 1.0, images.color_settings)?,
            "noiseIndex": 0, "noiseIntensity": 0., "noiseFillType": 0,
            "patternFillType": 1, "patternTileScale": 1.,
            "contextSettings": {"_class": "graphicsContextSettings",
                                 "blendMode": blend_code(&paint.blend), "opacity": paint.opacity.clamp(0., 1.),
                                 "isProgressive": false}
        })),
        "linear" | "radial" | "angular" | "diamond" => {
            // Sketch stores gradient anchors as "{x, y}" point strings.
            let radial_matrix = paint.transform.unwrap_or_default();
            let (from, to) = if paint.kind == "radial" {
                let center = radial_matrix.point(crate::math::Point::new(0.5, 0.5));
                let edge = radial_matrix.point(crate::math::Point::new(1., 0.5));
                ([center.x, center.y], [edge.x, edge.y])
            } else if let Some(matrix) = paint.transform {
                if paint.kind == "linear" {
                    let inverse = matrix.inverse().map_err(|e| Error::Unsupported(e.to_string()))?;
                    let (a, b, c) = (inverse.0[0], inverse.0[2], inverse.0[4]);
                    let norm = a * a + b * b;
                    let d = [a / norm, b / norm];
                    let t = (a + b) * 0.5 + c;
                    let p = [0.5 - t * d[0], 0.5 - t * d[1]];
                    (p, [p[0] + d[0], p[1] + d[1]])
                } else {
                    let a = matrix.point(crate::math::Point::new(0., 0.5));
                    let b = matrix.point(crate::math::Point::new(1., 0.5));
                    ([a.x, a.y], [b.x, b.y])
                }
            } else {
                let (sin, cos) = paint.angle.to_radians().sin_cos();
                let length = cos.abs() + sin.abs();
                (
                    [0.5 - cos * length * 0.5, 0.5 - sin * length * 0.5],
                    [0.5 + cos * length * 0.5, 0.5 + sin * length * 0.5],
                )
            };
            let from = format!("{{{}, {}}}", from[0], from[1]);
            let to = format!("{{{}, {}}}", to[0], to[1]);
            let ellipse_length = if paint.kind == "radial" {
                let primary = crate::math::Point::new(radial_matrix.0[0] * size[0], radial_matrix.0[1] * size[1]);
                let perpendicular = crate::math::Point::new(radial_matrix.0[2] * size[0], radial_matrix.0[3] * size[1]);
                if primary.length() > 0. { perpendicular.length() / primary.length() } else { 1. }
            } else { 0. };
            let stops: Vec<Value> = paint
                .stops
                .iter()
                .map(|s| -> Result<Value> {
                    Ok(json!({
                        "_class": "gradientStop", "position": s.offset,
                        "color": hex_to_rgba(&s.color, 1.0, images.color_settings)?
                    }))
                })
                .collect::<Result<Vec<_>>>()?;
            let gradient_type = match paint.kind.as_str() {
                "radial" => 1,
                "angular" => 2,
                "diamond" => 1,
                _ => 0,
            };
            Some(json!({
                "_class": "fill", "isEnabled": true, "fillType": 1,
                "gradient": {"_class": "gradient", "from": from, "to": to, "elipseLength": ellipse_length,
                              "stops": stops, "gradientType": gradient_type},
                "contextSettings": {"_class": "graphicsContextSettings",
                                     "blendMode": blend_code(&paint.blend), "opacity": paint.opacity.clamp(0., 1.),
                                     "isProgressive": false}
            }))
        }
        "image" => {
            let Some(uri) = paint.image.as_deref() else { return Ok(None) };
            let Some((mime, bytes)) = data_uri_bytes(uri) else { return Ok(None) };
            let name = sha1_hex(&bytes);
            if images.seen.insert(name.clone()) {
                images.entries.push((format!("images/{name}"), bytes));
            }
            let ext = mime.rsplit('/').next().unwrap_or("png");
            let _ = ext;
            Some(json!({
                "_class": "fill", "isEnabled": true, "fillType": 4,
                "color": hex_to_rgba("#000000", 1., images.color_settings)?,
                "image": {"_class": "MSJSONFileReference", "_ref_class": "MSImageData", "_ref": name},
                "noiseIndex": 0, "noiseIntensity": 0., "noiseFillType": 0,
                "patternFillType": 1, "patternTileScale": 1.,
                "contextSettings": {"_class": "graphicsContextSettings", "blendMode": blend_code(&paint.blend), "opacity": paint.opacity.clamp(0., 1.), "isProgressive": false}
            }))
        }
        _ => None,
    })
}

// ---------------------------------------------------------------------------
// export-side gap closures (mapping tables from the Sketch JSON dictionary
// and the fig2sketch sketchformat sources)
// ---------------------------------------------------------------------------

/// Kernel strokes/effects → Sketch border/shadow/blur parts. Shared by the
/// layer exporter and the document-level layerStyles container, so a shared
/// style archives exactly what a layer with the same parts would. The
/// returned borderOptions carry the dash/cap/join of the first stroke —
/// Sketch keeps them per style, not per border.
fn export_style_parts(
    strokes: &[crate::scene::Stroke],
    effects: &[Effect],
    lossy: &mut Vec<String>,
    settings: ColorSettings,
) -> Result<(Vec<Value>, Vec<Value>, Vec<Value>, Value, Value)> {
    // This compatibility path only represents solid borders. Do not flatten
    // gradient/image strokes to their unused fallback color, even when hidden:
    // that loses authored content and bypasses gradient-stop color admission.
    if let Some(stroke) = strokes.iter().find(|stroke| stroke.paint.kind != "solid") {
        return Err(Error::Unsupported(format!(
            "Sketch export cannot preserve {} stroke paints; use the native format instead",
            stroke.paint.kind
        )));
    }
    let borders: Vec<Value> = strokes
        .iter()
        .map(|s| -> Result<Value> {
            Ok(json!({
                "_class": "border", "isEnabled": s.paint.visible, "thickness": s.width,
                "position": match s.align.as_str() { "inside" => 1, "outside" => 2, _ => 0 },
                "fillType": 0,
                "color": hex_to_rgba(&s.paint.color, s.paint.opacity.clamp(0., 1.), settings)?,
                "contextSettings": {"_class": "graphicsContextSettings",
                                      "blendMode": blend_code(&s.paint.blend), "opacity": 1., "isProgressive": false}
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    // Dash/cap/join live on the style's borderOptions in Sketch (one set
    // shared by every border); kernel strokes each own them, so mixed sets
    // are reported instead of silently collapsed.
    let cap_code = |cap: &str| match cap {
        "round" => 1,
        "square" => 2,
        _ => 0,
    };
    let join_code = |join: &str| match join {
        "round" => 1,
        "bevel" => 2,
        _ => 0,
    };
    let dash_pattern = |dash: &str| -> Value {
        Value::Array(
            dash.split(|c: char| c == ',' || c.is_whitespace())
                .filter(|s| !s.is_empty())
                .filter_map(|v| v.parse::<f64>().ok())
                .map(|v| json!(v))
                .collect(),
        )
    };
    let border_options = match strokes.first() {
        Some(first) => {
            if strokes
                .iter()
                .any(|s| s.cap != first.cap || s.join != first.join || s.dash != first.dash)
            {
                note_lossy(lossy, "border-options-mixed-per-stroke");
            }
            if strokes.iter().any(|s| s.dash_offset != 0.) {
                note_lossy(lossy, "border-dash-offset-omitted");
            }
            json!({"_class": "borderOptions",
                   "lineCapStyle": cap_code(&first.cap), "lineJoinStyle": join_code(&first.join),
                   "dashPattern": dash_pattern(&first.dash), "startMarkerType": 0, "endMarkerType": 0,
                   "miterLimit": 10, "windingRule": 0})
        }
        None => json!({"_class": "borderOptions", "lineCapStyle": 0, "lineJoinStyle": 0,
                       "dashPattern": [], "startMarkerType": 0, "endMarkerType": 0,
                       "miterLimit": 10, "windingRule": 0}),
    };
    // Shadow alpha lives in the color payload; kernel keeps it separately
    // in Effect.opacity, so export multiplies it back into the color.
    let shadow_json = |e: &Effect| -> Result<Value> {
        Ok(json!({"_class": "shadow", "isEnabled": e.visible, "blurRadius": e.radius,
                "offsetX": e.x, "offsetY": e.y, "spread": e.spread,
                "color": hex_to_rgba(&e.color, e.opacity.clamp(0., 1.), settings)?,
                "contextSettings": {"_class": "graphicsContextSettings", "blendMode": 0, "opacity": 1., "isProgressive": false}}))
    };
    let shadows: Vec<Value> = effects
        .iter()
        .filter(|e| e.kind == "shadow")
        .map(shadow_json)
        .collect::<Result<Vec<_>>>()?;
    let inner_shadows: Vec<Value> = effects
        .iter()
        .filter(|e| e.kind == "inner-shadow")
        .map(shadow_json)
        .collect::<Result<Vec<_>>>()?;
    // Sketch style carries one blur object: Gaussian=0, Background=3.
    // Glass refraction parameters have no native Sketch representation.
    let blur_like: Vec<&Effect> = effects
        .iter()
        .filter(|e| matches!(e.kind.as_str(), "blur" | "background-blur" | "glass"))
        .collect();
    let blur = match blur_like.first() {
        Some(e) => {
            match e.kind.as_str() {
                "glass" => note_lossy(lossy, "effect-glass->gaussian(refraction-lost)"),
                _ => {}
            }
            if blur_like.len() > 1 {
                note_lossy(lossy, "effect-multiple-blurs-collapsed");
            }
            json!({"_class": "blur", "isEnabled": e.visible, "center": "{0.5, 0.5}",
                    "motionAngle": 0., "radius": e.radius.max(0.), "saturation": 1.,
                    "type": if e.kind == "background-blur" {3} else {0}})
        }
        None => {
            json!({"_class": "blur", "isEnabled": false, "center": "{0.5, 0.5}", "motionAngle": 0.,
                       "radius": 0., "saturation": 1., "type": 0})
        }
    };
    for e in effects {
        if matches!(e.kind.as_str(), "texture" | "gradient-blur")
            || e.texture.is_some()
            || e.gradient_blur.is_some()
        {
            note_lossy(lossy, &format!("effect-{}-omitted", e.kind));
        }
    }
    Ok((borders, shadows, inner_shadows, blur, border_options))
}

/// Record a downgrade note once; the exporter writes the collected list into
/// userInfo so the importer can surface honest round-trip warnings.
fn note_lossy(lossy: &mut Vec<String>, note: &str) {
    if !lossy.iter().any(|n| n == note) {
        lossy.push(note.to_string());
    }
}

/// kernel `Anchor` → Sketch resizingConstraint 3-bit axis code
/// (22 号字典 §2: low 3 bits = X, high 3 bits = Y; per axis
/// 1 = min, 2 = max, 3 = min|max fixed, 4..=7 = scale).
/// Sketch pins have no center anchor; that downgrade is lossy.
fn constraint_axis_bits(anchor: crate::layout::Anchor, lossy: &mut Vec<String>) -> u64 {
    use crate::layout::Anchor;
    match anchor {
        Anchor::Start => 1,
        Anchor::End => 2,
        Anchor::Stretch => 3,
        Anchor::Scale => 4,
        Anchor::Center => {
            note_lossy(lossy, "constraint-center->scale");
            4
        }
    }
}

/// FlexJustify (sketchformat/layer_common.py, disassembled):
/// START=0 CENTER=1 END=2 SPACE_BETWEEN=3 SPACE_AROUND=4 SPACE_EVENLY=5.
fn flex_justify(align: crate::layout::Align, lossy: &mut Vec<String>) -> i64 {
    use crate::layout::Align;
    match align {
        Align::Start => 0,
        Align::Center => 1,
        Align::End => 2,
        Align::SpaceBetween => 3,
        Align::SpaceAround => 4,
        Align::SpaceEvenly => 5,
        Align::Stretch => {
            note_lossy(lossy, "stack-justify-stretch->start");
            0
        }
    }
}

/// FlexAlign: START=0 CENTER=1 END=2 NONE=5. Flex has no stretch align —
/// the counter axis stretches through per-child alignSelf instead.
fn flex_align(align: crate::layout::Align, lossy: &mut Vec<String>) -> i64 {
    use crate::layout::Align;
    match align {
        Align::Start => 0,
        Align::Center => 1,
        Align::End => 2,
        other => {
            note_lossy(lossy, "stack-align-not-supported");
            let _ = other;
            5
        }
    }
}

/// booleanOperation codes (22 号字典 §3, measured distribution):
/// -1 none, 0 Union, 1 Subtract, 3 Intersection, 2 Difference/XOR.
fn boolean_code(op: crate::boolean::Operation) -> i64 {
    match op {
        crate::boolean::Operation::Union => 0,
        crate::boolean::Operation::Subtract => 1,
        crate::boolean::Operation::Exclude => 2,
        crate::boolean::Operation::Intersect => 3,
    }
}

fn boolean_from_code(code: i64) -> Option<crate::boolean::Operation> {
    match code {
        0 => Some(crate::boolean::Operation::Union),
        1 => Some(crate::boolean::Operation::Subtract),
        2 => Some(crate::boolean::Operation::Exclude),
        3 => Some(crate::boolean::Operation::Intersect),
        _ => None,
    }
}

/// 22 号字典 §1 export side: derive curveMode from the handle geometry at
/// one vertex. c1 is the outgoing handle (curveFrom), c2 the incoming one
/// (curveTo). No handles → 1 (Straight); two handles collinear with the
/// vertex → 2 (Mirrored) when equally long, 4 (Asymmetric) otherwise; a
/// single handle or non-collinear pair → 3 (Disconnected).
fn curve_mode_of(v: &crate::scene::Vertex, c1: Option<crate::math::Point>, c2: Option<crate::math::Point>) -> i64 {
    let (Some(a), Some(b)) = (c1, c2) else {
        return if c1.is_some() || c2.is_some() { 3 } else { 1 };
    };
    let (ox, oy) = (a.x - v.x, a.y - v.y);
    let (ix, iy) = (b.x - v.x, b.y - v.y);
    let out_len = ox.hypot(oy);
    let in_len = ix.hypot(iy);
    let cross = (ox * iy - oy * ix).abs();
    if cross > 1e-9 * (1. + out_len * in_len) {
        return 3;
    }
    if (out_len - in_len).abs() <= 1e-9 * (1. + out_len.max(in_len)) {
        2
    } else {
        4
    }
}

/// Kernel paint objects stored inside instance overrides (fig imports keep
/// converted `fillPaints` there) become Sketch color override values.
fn override_object_to_sketch(value: &Value, settings: ColorSettings) -> Result<Option<Value>> {
    if value.get("kind").and_then(Value::as_str) == Some("solid")
        && let Some(color) = value.get("color").and_then(Value::as_str)
    {
        let opacity = value.get("opacity").and_then(Value::as_f64).unwrap_or(1.);
        return Ok(Some(hex_to_rgba(color, opacity, settings)?));
    }
    Ok(None)
}

/// 22 号字典 §5 import side: an image override archives its value as an
/// MSJSONFileReference dict pointing into the bundle's `images/` blobs.
/// Resolve the blob into a self-contained data URI so the value survives in
/// the kernel model without the original container. `None` means the value
/// was an image reference whose blob could not be found — the caller keeps
/// the raw dict and reports the gap. Color (`color:fill-N`/`color:shadow-N`)
/// and layerStyle override dicts pass through untouched; the export side
/// writes native `_class` payloads back verbatim.
fn sketch_override_value_from_native(
    files: &BTreeMap<String, Vec<u8>>,
    field: &str,
    value: &Value,
) -> Option<Value> {
    let is_image_ref = value.get("_ref").and_then(Value::as_str).is_some()
        && (field.ends_with("_image")
            || value.get("_ref_class").and_then(Value::as_str) == Some("MSImageData"));
    if !is_image_ref {
        return Some(value.clone());
    }
    let reference = value.get("_ref").and_then(Value::as_str)?;
    files
        .get(&format!("images/{reference}"))
        .or_else(|| files.get(reference))
        .map(|bytes| Value::String(image_data_uri(bytes)))
}

/// 22 号字典 §5 export side: one object-typed override value → its native
/// Sketch payload. Native archived dicts (color overrides, image file
/// references, layerStyle style objects) carry `_class` and pass through
/// verbatim; kernel paint objects convert — solid fills through
/// [`override_object_to_sketch`], image fills archive their blob and
/// reference it. Anything else returns `None` and is reported by the caller.
fn sketch_override_value_to_native(value: &Value, images: &mut ExportedImages) -> Result<Option<Value>> {
    if value.get("_class").is_some() {
        return Ok(Some(value.clone()));
    }
    if let converted @ Some(_) = override_object_to_sketch(value, images.color_settings)? {
        return Ok(converted);
    }
    if value.get("kind").and_then(Value::as_str) == Some("image")
        && let Some(uri) = value.get("image").and_then(Value::as_str)
        && let Some((_, bytes)) = data_uri_bytes(uri)
    {
        let name = sha1_hex(&bytes);
        if images.seen.insert(name.clone()) {
            images.entries.push((format!("images/{name}"), bytes));
        }
        return Ok(Some(
            json!({"_class": "MSJSONFileReference", "_ref_class": "MSImageData", "_ref": name}),
        ));
    }
    Ok(None)
}

/// Sketch paragraph alignment (sketchformat/text.py): LEFT=0 RIGHT=1
/// CENTER=2 JUSTIFIED=3.
fn paragraph_alignment(align: &str) -> i64 {
    match align {
        "end" => 1,
        "center" => 2,
        "justify" => 3,
        _ => 0,
    }
}

fn alignment_from_code(code: i64) -> &'static str {
    match code {
        1 => "end",
        2 => "center",
        3 => "justify",
        _ => "start",
    }
}

/// Font weight → closest PostScript-ish font name suffix is not derivable;
/// runs keep the authored font name verbatim instead.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Sketch stores blend modes as enum integers (0 = Normal, …).
fn class_for_kind(kind: &str) -> &'static str {
    match kind {
        "frame" => "artboard",
        "group" => "group",
        "rect" | "rectangle" => "rectangle",
        "ellipse" => "oval",
        "star" => "star",
        "polygon" => "polygon",
        "path" | "vector" => "shapePath",
        "text" => "text",
        "image" => "bitmap",
        "slice" => "slice",
        "hotspot" => "hotspot",
        _ => "group",
    }
}

fn sketch_text_behaviour(node: &Node) -> i64 {
    use crate::layout::SizeMode;
    match node.sizing.as_ref() {
        Some(s) if s.width == SizeMode::Hug && s.height == SizeMode::Hug => 0,
        Some(s) if s.height == SizeMode::Hug => 1,
        None => node.bindings.get("sketchTextBehaviour")
            .and_then(|value| value.parse::<i64>().ok()).unwrap_or(2),
        _ => 2,
    }
}

fn text_layout_signature(node: &Node) -> Value {
    json!({"text":node.text,"fontSize":node.font_size,"textStyle":node.text_style,
        "textRuns":node.text_runs,"sizing":node.sizing})
}

#[derive(serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TextLayoutSignature {
    text: String,
    font_size: f64,
    text_style: Option<crate::font::TextStyle>,
    text_runs: Vec<crate::font::TextRun>,
    sizing: Option<crate::layout::Sizing>,
}

fn restore_unedited_text_frame(node: &mut Node, source: Option<&Value>) -> bool {
    let Some(source) = source else { return false };
    // JS/IndexedDB/FD producers serialize integral doubles as integers. Compare
    // canonical typed fields rather than serde_json::Number's storage variant.
    let Some(signature) = source.get("signature")
        .and_then(|value| serde_json::from_value::<TextLayoutSignature>(value.clone()).ok()) else { return false };
    let current = TextLayoutSignature {
        text:node.text.clone(), font_size:node.font_size, text_style:node.text_style.clone(),
        text_runs:node.text_runs.clone(), sizing:node.sizing.clone(),
    };
    if signature != current { return false }
    let (Some(width), Some(height), Some(transform), Some(sizing)) = (
        source.get("width").and_then(Value::as_f64), source.get("height").and_then(Value::as_f64),
        source.get("transform").and_then(|value| serde_json::from_value::<Transform>(value.clone()).ok()),
        node.sizing.as_ref()
    ) else { return false };
    if (sizing.width != crate::layout::SizeMode::Hug && node.width != width)
        || (sizing.height != crate::layout::SizeMode::Hug && node.height != height) { return false }
    let mut expected = transform;
    if sizing.width == crate::layout::SizeMode::Hug {
        let shift = (width - node.width) * crate::layout::text_anchor_factor(node);
        if shift != 0. {
            expected.0[4] += expected.0[0] * shift;
            expected.0[5] += expected.0[1] * shift;
        }
    }
    // Exact equality is deliberate: moving/scaling text is an authored edit.
    // Do not discard it using a broad geometric tolerance.
    if node.transform != expected { return false }
    node.width = width;
    node.height = height;
    node.transform = transform;
    true
}

/// Sketch resolves `MSAttributedStringFontAttribute.attributes.name`
/// against installed font *names*. Kernel font ids are resource-table keys —
/// a scanner digest is unresolvable there. Resolve through the document's
/// font table (PostScript name first, family second); the embedded default
/// keeps the historical HelveticaNeue mapping because Sketch cannot resolve
/// the editor's bundled CJK font either way.
fn sketch_font_name(doc: &Document, font_id: &str) -> String {
    if font_id.is_empty() || font_id == "default" {
        return "HelveticaNeue".into();
    }
    doc.fonts
        .get(font_id)
        .map(|resource| {
            resource
                .postscript
                .as_deref()
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .or_else(|| {
                    use base64::Engine as _;
                    let data = resource.data.split_once(',').map(|(_, data)| data).unwrap_or(&resource.data);
                    let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
                    let face = ttf_parser::Face::parse(&bytes, resource.index).ok()?;
                    face.names().into_iter().filter(|name| name.name_id == ttf_parser::name_id::POST_SCRIPT_NAME)
                        .find_map(|name| name.to_string())
                })
                .unwrap_or_else(|| resource.family.clone())
        })
        .unwrap_or_else(|| font_id.to_owned())
}

fn sketch_font_descriptor(doc: &Document, axes: &mut BTreeMap<String, bool>, font_id: &str, size: f64, weight: f32) -> Value {
    let mut descriptor = json!({"_class":"fontDescriptor", "attributes":{
        "name":sketch_font_name(doc, font_id), "size":size}});
    let has_weight = *axes.entry(font_id.into()).or_insert_with(|| {
        let Some(resource) = doc.fonts.get(font_id) else { return false };
        use base64::Engine as _;
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(resource.data.as_bytes()) else { return false };
        let Ok(face) = ttf_parser::Face::parse(&bytes, resource.index) else { return false };
        face.variation_axes().into_iter().any(|axis| axis.tag == ttf_parser::Tag::from_bytes(b"wght"))
    });
    if has_weight { descriptor["attributes"]["variation"] = json!({"2003265652":weight}); }
    descriptor
}

fn exported_symbol_id(doc: &Document, id: &str) -> String {
    let Some(master) = doc.nodes.get(id).filter(|node| node.component.is_some()) else {
        // Legacy archive inspection keeps the native symbol reference here.
        return id.to_owned();
    };
    master.bindings.get("symbolID").cloned().or_else(|| doc.design_system.as_ref()
        .and_then(|system| system.sketch_containers.get("nodeMetadata"))
        .and_then(|metadata| metadata.get(id))
        .and_then(|metadata| metadata.get("bindings"))
        .and_then(|bindings| bindings.get("symbolID"))
        .and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| sketch_id(id))
}

fn exported_override_path(doc: &Document, component: &str, path: &str) -> Option<String> {
    let mut scope = component.to_owned();
    let mut native = Vec::new();
    let parts: Vec<_> = path.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        let mut pending = vec![scope.clone()];
        let mut visited = std::collections::BTreeSet::new();
        let mut found = None;
        while let Some(id) = pending.pop() {
            if !visited.insert(id.clone()) || visited.len() > 20000 { return None }
            let node = doc.nodes.get(&id)?;
            if (index == 0 && *part == "$root" && id == scope)
                || node.component_key.as_deref().unwrap_or(&node.id) == *part {
                found = Some(node); break;
            }
            if id == scope || node.instance.is_none() { pending.extend(node.children.iter().cloned()); }
        }
        let node = found?;
        native.push(sketch_id(&node.id));
        if index + 1 < parts.len() { scope = node.instance.as_ref()?.component_id.clone(); }
    }
    Some(native.join("/"))
}

/// Sketch's frame/rotation/flips represent rigid local placement. Test only
/// floating-point orthogonality here; never flatten scale/shear to identity.
fn sketch_placement(node: &Node) -> Option<([f64; 4], f64, [bool; 2])> {
    let [a, b, c, d, x, y] = node.transform.0;
    let determinant = a * d - b * c;
    if [a, b, c, d, x, y].iter().any(|value| !value.is_finite())
        || (a * a + b * b - 1.).abs() > 1e-12
        || (c * c + d * d - 1.).abs() > 1e-12
        || (a * c + b * d).abs() > 1e-12
        || (determinant.abs() - 1.).abs() > 1e-12 { return None }
    let flip = determinant < 0.;
    let sign = if flip { -1. } else { 1. };
    let rotation = -(b * sign).atan2(a * sign).to_degrees();
    Some(([
        x - node.width / 2. + a * node.width / 2. + c * node.height / 2.,
        y - node.height / 2. + b * node.width / 2. + d * node.height / 2.,
        node.width, node.height,
    ], rotation, [flip, false]))
}

fn export_layer(doc: &Document, id: &str, images: &mut ExportedImages) -> Result<Value> {
    let mut source_text_frame_restored = false;
    let restored_node = doc.nodes.get(id).map(|node| {
        let mut node = node.clone();
        let metadata = doc.design_system.as_ref()
            .and_then(|system| system.sketch_containers.get("nodeMetadata"))
            .and_then(|metadata| metadata.get(id));
        if let Some(metadata) = metadata {
            if let Some(bindings) = metadata.get("bindings")
                .and_then(|v| serde_json::from_value::<BTreeMap<String, String>>(v.clone()).ok()) {
                node.bindings.extend(bindings);
            }
            if let Some(style_refs) = metadata.get("styleRefs")
                .and_then(|v| serde_json::from_value::<BTreeMap<String, String>>(v.clone()).ok()) {
                node.style_refs.extend(style_refs);
            }
        }
        let source_text_layout = doc.design_system.as_ref()
            .and_then(|system| system.sketch_containers.get("textSourceLayouts"))
            .and_then(|layouts| layouts.get(id));
        source_text_frame_restored = restore_unedited_text_frame(&mut node, source_text_layout);
        if let Some(extent) = node.bindings.get("sketchSourceZeroExtent")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        {
            if node.width == 1e-6 && extent.get("width").and_then(Value::as_f64) == Some(0.) {
                node.width = 0.;
            }
            if node.height == 1e-6 && extent.get("height").and_then(Value::as_f64) == Some(0.) {
                node.height = 0.;
            }
        }
        node
    });
    let node = restored_node.as_ref();
    let mut layer = Map::new();
    // Class refinement beyond pure kind (21 号 P1-5/P1-9): component frames
    // are symbol masters (as are native-imported masters, which carry their
    // symbolID in bindings but no kernel component payload), instances are
    // symbol instances, boolean groups are shape groups — all native Sketch
    // classes with their own JSON payloads.
    let mut class = node
        .map(|n| class_for_kind(n.kind.as_str()))
        .unwrap_or("group");
    let mut lossy: Vec<String> = Vec::new();
    // Kernel interactions that exceed Sketch's one-flow-per-layer model and
    // must ride userInfo (written near the end of the node branch).
    let mut pending_user_prototype: Option<Value> = None;
    if let Some(n) = node {
        if n.instance.is_some() {
            class = "symbolInstance";
        } else if n.kind == "frame"
            && (n.component.is_some() || n.bindings.contains_key("symbolID"))
        {
            class = "symbolMaster";
        } else if matches!(n.kind.as_str(), "group" | "vector") && n.boolean_operation.is_some() {
            class = "shapeGroup";
        }
    }
    layer.insert("_class".into(), json!(class));
    layer.insert("do_objectID".into(), json!(sketch_id(id)));
    // Canonical base field set every real Sketch layer carries (the
    // unarchiver constructs these via initWithUnarchiver: even when default).
    layer.insert("booleanOperation".into(), json!(-1));
    layer.insert("clippingMaskMode".into(), json!(0));
    layer.insert(
        "exportOptions".into(),
        json!({
            "_class": "exportOptions", "includedLayerIds": [], "layerOptions": 0,
            "shouldTrim": false, "exportFormats": []
        }),
    );
    layer.insert("hasClippingMask".into(), json!(false));
    layer.insert("hasCustomPrototypeVisibility".into(), json!(false));
    layer.insert("hasExplicitConstraints".into(), json!(false));
    layer.insert("isFixedToViewport".into(), json!(false));
    layer.insert("isFlippedHorizontal".into(), json!(false));
    layer.insert("isFlippedVertical".into(), json!(false));
    layer.insert("isTemplate".into(), json!(false));
    layer.insert("layerListExpandedType".into(), json!(0));
    layer.insert("nameIsFixed".into(), json!(false));
    layer.insert("resizingConstraint".into(), json!(63));
    layer.insert("resizingType".into(), json!(0));
    layer.insert("shouldBreakMaskChain".into(), json!(false));
    layer.insert("prototypeScrolling".into(), json!(0));
    layer.insert("prototypeVisibility".into(), json!(0));
    layer.insert("prototypeVisibilityTrigger".into(), json!(0));
    layer.insert("horizontalSizing".into(), json!(0));
    layer.insert("verticalSizing".into(), json!(0));
    layer.insert("horizontalPins".into(), json!(0));
    layer.insert("verticalPins".into(), json!(0));
    if let Some(n) = node {
        layer.insert("name".into(), json!(n.name));
        layer.insert("isVisible".into(), json!(n.visible));
        layer.insert("isLocked".into(), json!(n.locked));
        layer.insert("rotation".into(), json!(0));
        let t = n.transform.0;
        layer.insert(
            "frame".into(),
            json!({"_class": "rect", "x": t[4], "y": t[5],
                    "width": n.width, "height": n.height}),
        );
        if let Some((frame, rotation, flip)) = sketch_placement(n) {
            layer.insert("frame".into(), json!({"_class":"rect", "x":frame[0], "y":frame[1], "width":frame[2], "height":frame[3]}));
            layer.insert("rotation".into(), json!(rotation));
            layer.insert("isFlippedHorizontal".into(), json!(flip[0]));
            layer.insert("isFlippedVertical".into(), json!(flip[1]));
        }
        if let Some(source) = n.bindings.get("sketchSourceTransform")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            && source.get("matrix").and_then(|v| serde_json::from_value::<[f64; 6]>(v.clone()).ok()) == Some(t)
            && let Some(frame) = source.get("frame").and_then(|v| serde_json::from_value::<[f64; 4]>(v.clone()).ok())
            && frame[2] == n.width && frame[3] == n.height
        {
            layer.insert("frame".into(), json!({"_class":"rect", "x":frame[0], "y":frame[1], "width":frame[2], "height":frame[3]}));
            layer.insert("rotation".into(), source["rotation"].clone());
            layer.insert("isFlippedHorizontal".into(), source["flip"][0].clone());
            layer.insert("isFlippedVertical".into(), source["flip"][1].clone());
        }
        if source_text_frame_restored && let Some(frame) = doc.design_system.as_ref()
            .and_then(|system| system.sketch_containers.get("textSourceLayouts"))
            .and_then(|layouts| layouts.get(id)).and_then(|source| source.get("frame"))
        {
            layer.insert("frame".into(), frame.clone());
        }
        // P1-7: constraints → resizingConstraint bits (63 = Sketch's
        // measured default "free" value and must not re-import as a rule).
        if let Some(c) = &n.constraints {
            let x = constraint_axis_bits(c.horizontal, &mut lossy);
            let y = constraint_axis_bits(c.vertical, &mut lossy);
            layer.insert("resizingConstraint".into(), json!(x | (y << 3)));
            layer.insert("hasExplicitConstraints".into(), json!(true));
        }
        // P1-9: boolean groups carry their operation on shapeGroup.
        if let Some(op) = &n.boolean_operation {
            layer.insert("booleanOperation".into(), json!(boolean_code(*op)));
        } else if let Some(op) = n.bindings.get("sketchOperandBooleanOperation")
            .and_then(|raw| serde_json::from_str::<crate::boolean::Operation>(raw).ok())
        {
            layer.insert("booleanOperation".into(), json!(boolean_code(op)));
        }
        let source_gradients = n.bindings.get("sketchSourceGradients")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        let fills: Vec<Value> = n
            .fills
            .iter()
            .enumerate()
            .map(|(index, p)| -> Result<Option<Value>> {
                if p.kind == "diamond" {
                    // Sketch gradients: 1 linear, 2 radial, 3 angular — no
                    // diamond; radial is the nearest visual approximation.
                    note_lossy(&mut lossy, "fill-diamond->radial");
                }
                if p.kind == "radial" {
                    let transform = p.transform.unwrap_or_default();
                    let primary = crate::math::Point::new(transform.0[0] * n.width, transform.0[1] * n.height);
                    let cross = crate::math::Point::new(transform.0[2] * n.width, transform.0[3] * n.height);
                    if (primary.x * cross.x + primary.y * cross.y).abs() > 1e-10 * primary.length() * cross.length() {
                        note_lossy(&mut lossy, "fill-radial-skew-approximated");
                    }
                }
                let Some(mut part) = export_paint(p, images, [n.width, n.height])? else { return Ok(None) };
                if let Some(source) = source_gradients.as_ref().and_then(|source| source.get(index.to_string()))
                    && source.get("paint").and_then(|value| serde_json::from_value::<Paint>(value.clone()).ok()).as_ref() == Some(p)
                {
                    part["gradient"] = source["gradient"].clone();
                }
                Ok(Some(part))
            })
            .collect::<Result<Vec<_>>>()?.into_iter().flatten().collect();
        let (borders, shadows, inner_shadows, mut blur, border_options) =
            export_style_parts(&n.strokes, &n.effects, &mut lossy, images.color_settings)?;
        if let Some(source) = n.bindings.get("sketchSourceBlur")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            && source.get("effects").and_then(|value| serde_json::from_value::<Vec<Effect>>(value.clone()).ok())
                .as_ref() == Some(&blur_projection(&n.effects))
        {
            blur = source["blur"].clone();
        }
        // P1-6: shared style reference (style_refs holds the Sketch uuid).
        let mut style = Map::new();
        if let Some(shared) = n.style_refs.get("textStyle").or_else(|| n.style_refs.get("fills"))
            .or_else(|| n.style_refs.get("sketchSharedStyleID")) {
            layer.insert("sharedStyleID".into(), json!(sketch_shared_style_id(shared)));
        }
        style.insert("_class".into(), json!("style"));
        style.insert(
            "do_objectID".into(),
            json!(sketch_id(&format!("{id}-style"))),
        );
        style.insert("fills".into(), Value::Array(fills));
        style.insert("borders".into(), Value::Array(borders));
        style.insert("shadows".into(), Value::Array(shadows));
        style.insert("innerShadows".into(), Value::Array(inner_shadows));
        style.insert("blur".into(), blur);
        style.insert("borderOptions".into(), border_options);
        style.insert(
            "colorControls".into(),
            json!({"_class": "colorControls", "isEnabled": false, "brightness": 0.,
                                       "contrast": 1., "hue": 0., "saturation": 1.}),
        );
        style.insert(
            "contextSettings".into(),
            json!({"_class": "graphicsContextSettings",
                                          "blendMode": blend_code(&n.blend), "opacity": n.opacity.clamp(0., 1.),
                                          "isProgressive": false}),
        );
        layer.insert("style".into(), Value::Object(style));
        match class {
            "rectangle" => {
                layer.insert("fixedRadius".into(), json!(n.corner_radius));
                layer.insert("needsConversion".into(), json!(false));
            }
            "artboard" | "symbolMaster" => {
                layer.insert("hasBackgroundColor".into(), json!(false));
                layer.insert("includeBackgroundColorInExport".into(), json!(true));
                layer.insert("backgroundColor".into(), hex_to_rgba("#ffffff", 0., images.color_settings)?);
                layer.insert(
                    "isFlowHome".into(),
                    json!(
                        doc.prototype.as_ref().and_then(|p| p.start_node.as_ref()) == Some(&n.id)
                    ),
                );
                layer.insert("includeInCloudUpload".into(), json!(true));
                layer.insert("presetItemType".into(), json!(0));
                layer.insert("resizesContent".into(), json!(false));
                // 21 号 P1-10: layout grid. Native dicts cover axis/count/
                // gutter/margin; the kernel-only color/opacity ride userInfo
                // (Sketch keeps grid appearance in app preferences).
                if let Some(grid) = &n.layout_grid {
                    match grid.axis.as_str() {
                        "uniform" => {
                            let cell = grid.tracks(n.width).first().copied().unwrap_or(8.);
                            layer.insert(
                                "grid".into(),
                                json!({"_class": "simpleGrid", "isEnabled": grid.visible,
                                       "gridSize": cell, "thickGridTimes": 1}),
                            );
                        }
                        axis => {
                            let extent = if axis == "row" { n.height } else { n.width };
                            let track = grid.tracks(extent).first().copied().unwrap_or(1.);
                            layer.insert(
                                "layout".into(),
                                json!({"_class": "layoutGrid", "isEnabled": grid.visible,
                                       "drawVertical": axis != "row",
                                       "drawHorizontal": axis == "row",
                                       "drawHorizontalLines": false,
                                       "numberOfColumns": grid.count,
                                       "columnWidth": track,
                                       "gutterWidth": if axis == "row" { 0. } else { grid.gutter },
                                       "gutterHeight": if axis == "row" { grid.gutter } else { 20. },
                                       "guttersOutside": false,
                                       "horizontalOffset": grid.margin}),
                            );
                        }
                    }
                    note_lossy(&mut lossy, "layout-grid-color-not-in-sketch-document");
                }
                if class == "symbolMaster" {
                    // 21 号 P1-5: master export. overrideProperties needs the
                    // authoring-side property inventory which the kernel
                    // models differently (Component.properties/variants);
                    // that payload travels in userInfo for lossless trips.
                    layer.insert(
                        "symbolID".into(),
                        json!(
                            n.bindings
                                .get("symbolID")
                                .map(String::as_str)
                                .unwrap_or(&sketch_id(id))
                        ),
                    );
                    layer.insert("allowsOverrides".into(), json!(true));
                    layer.insert("includeBackgroundColorInInstance".into(), json!(true));
                    // P1-12: restore the archived canOverride inventory
                    // imported into bindings; a master authored kernel-side
                    // has none and exports the empty list.
                    let stored_properties = n
                        .bindings
                        .get("sketchOverrideProperties")
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                        .filter(|v| v.is_array());
                    match stored_properties {
                        Some(properties) => {
                            layer.insert("overrideProperties".into(), properties);
                        }
                        None => {
                            if n.bindings.contains_key("sketchOverrideProperties") {
                                note_lossy(&mut lossy, "override-properties-binding-unreadable");
                            }
                            layer.insert("overrideProperties".into(), json!([]));
                        }
                    }
                    if let Some(c) = &n.component
                        && (!c.properties.is_empty() || !c.variants.is_empty())
                    {
                        note_lossy(&mut lossy, "component-definition-in-userInfo");
                    }
                }
            }
            "symbolInstance" => {
                // 21 号 P1-5: instance export with the override tree
                // (22 号字典 §5 syntax: "ancestor/layerID_field", bare names
                // import back with the "self" path key).
                if let Some(inst) = &n.instance {
                    layer.insert("symbolID".into(), json!(exported_symbol_id(doc, &inst.component_id)));
                    layer.insert("scale".into(), json!(1.));
                    layer.insert("preservesSpaceWhenHidden".into(), json!(false));
                    let mut values = Vec::new();
                    for (path, fields) in &inst.overrides {
                        for (field, value) in fields {
                            let canonical = crate::components::FIELDS.contains(&field.as_str())
                                || matches!(field.as_str(), "swapComponent" | "propertyValues");
                            let mut native_value = value.clone();
                            let name = if canonical {
                                let native_field = match field.as_str() {
                                    "text" => "stringValue",
                                    "visible" => "isVisible",
                                    "swapComponent" => "symbolID",
                                    _ => { note_lossy(&mut lossy, "component-overrides-in-userInfo"); continue; }
                                };
                                let Some(native_path) = exported_override_path(doc, &inst.component_id, path) else {
                                    note_lossy(&mut lossy, "component-override-path-in-userInfo"); continue;
                                };
                                if field == "swapComponent" {
                                    if let Some(id) = value.as_str() { native_value = json!(exported_symbol_id(doc, id)); }
                                }
                                format!("{native_path}_{native_field}")
                            } else if path == "self" {
                                field.clone()
                            } else {
                                format!("{path}/{field}")
                            };
                            let exported = match &native_value {
                                Value::String(s) => {
                                    // 22 号字典 §5 image 覆盖: a data-URI string
                                    // under an `*_image` field archives as an
                                    // images/ blob plus a file reference.
                                    if field.ends_with("_image")
                                        && let Some((_, bytes)) = data_uri_bytes(s)
                                    {
                                        let name = sha1_hex(&bytes);
                                        if images.seen.insert(name.clone()) {
                                            images
                                                .entries
                                                .push((format!("images/{name}"), bytes));
                                        }
                                        Some(json!({"_class": "MSJSONFileReference",
                                                    "_ref_class": "MSImageData",
                                                    "_ref": name}))
                                    } else {
                                        Some(json!(s))
                                    }
                                }
                                Value::Number(nb) => Some(json!(nb)),
                                Value::Bool(b) => Some(json!(b)),
                                Value::Object(_) => {
                                    let converted =
                                        sketch_override_value_to_native(value, images)?;
                                    if converted.is_none() {
                                        note_lossy(
                                            &mut lossy,
                                            &format!("override-{path}-{field}-object-dropped"),
                                        );
                                    }
                                    converted
                                }
                                Value::Null | Value::Array(_) => {
                                    // Null/array override values have no
                                    // archived Sketch form; report instead of
                                    // dropping silently.
                                    note_lossy(
                                        &mut lossy,
                                        &format!("override-{path}-{field}-value-dropped"),
                                    );
                                    None
                                }
                            };
                            if let Some(v) = exported {
                                values.push(json!({
                                    "_class": "overrideValue", "overrideName": name,
                                    "value": v
                                }));
                            }
                        }
                    }
                    layer.insert("overrideValues".into(), Value::Array(values));
                }
            }
            "shapeGroup" => {
                // Boolean groups: winding rides in bindings when even-odd
                // (the kernel boolean group itself carries no winding slot).
                layer.insert(
                    "windingRule".into(),
                    json!(if n.bindings.get("sketchWindingRule").map(String::as_str)
                        == Some("evenodd")
                    {
                        1
                    } else {
                        0
                    }),
                );
            }
            "oval" | "star" | "polygon" => {
                layer.insert("numberOfPoints".into(), json!(n.points));
            }
            "shapePath" => {
                let closed = !n.bindings.get("sketchOpenPath").is_some_and(|v| v == "true");
                layer.insert("isClosed".into(), json!(closed));
                // Per-point corner radii imported from a native document
                // ride bindings (the kernel has no per-vertex radius slot)
                // and are restored verbatim here.
                let corner_radii: Vec<f64> = n
                    .bindings
                    .get("sketchPointCornerRadii")
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_default();
                let points: Vec<Value> = n
                    .network
                    .as_ref()
                    .map(|net| {
                        // P0-1: curve handles. The kernel network stores
                        // handles on edges (c1 = handle at `from`, c2 = handle
                        // at `to`); a shapePath is a closed ring through the
                        // vertices in order, so vertex i's outgoing handle is
                        // edge[i].c1 and its incoming handle edge[i-1].c2
                        // (22 号字典 §1 table; Disconnected keeps both ends
                        // independent, which matches the kernel edge model).
                        let count = net.vertices.len();
                        let ring = count > 0
                            && net.edges.len() == if closed { count } else { count - 1 }
                            && net.edges.iter().enumerate().all(|(i, e)| {
                                let next = (i + 1) % count;
                                e.from == net.vertices[i].id && e.to == net.vertices[next].id
                            });
                        if !ring {
                            note_lossy(&mut lossy, "network-topology-flattened-to-ring");
                        }
                        net.vertices
                            .iter()
                            .enumerate()
                            .map(|(i, v)| {
                                let (c1, c2) = if ring {
                                    (net.edges.get(i).and_then(|e| e.c1),
                                     if i > 0 { net.edges[i - 1].c2 }
                                     else if closed { net.edges[count - 1].c2 } else { None })
                                } else {
                                    (None, None)
                                };
                                let mode = curve_mode_of(v, c1, c2);
                                let mirror = |p: Option<crate::math::Point>| match p {
                                    Some(p) => json!({"_class": "point", "x": p.x, "y": p.y}),
                                    None => json!({"_class": "point", "x": v.x, "y": v.y}),
                                };
                                json!({
                                    "_class": "curvePoint", "curveMode": mode,
                                    "hasCurveFrom": c1.is_some(), "hasCurveTo": c2.is_some(),
                                    "point": {"_class": "point", "x": v.x, "y": v.y},
                                    "curveFrom": mirror(c1), "curveTo": mirror(c2),
                                    "cornerRadius": corner_radii.get(i).copied().unwrap_or(0.)
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                layer.insert("points".into(), Value::Array(points));
            }
            "text" => {
                // P0-2: full multi-run attributed string (22 号字典 §4 key
                // set). Kernel run offsets are UTF-16 already, so
                // {location, length} pass through untouched.
                let style = n.text_style.as_ref();
                let default_font = style.map(|s| s.font_id.as_str()).unwrap_or("default");
                let default_weight = style.map(|s| s.weight).unwrap_or(400.);
                let default_color = n
                    .fills
                    .iter()
                    .find(|p| p.kind == "solid" && !p.color.is_empty())
                    .map(|p| p.color.clone());
                let kerning = style
                    .map(|s| s.letter_spacing)
                    .filter(|k| *k != 0.)
                    .unwrap_or_default();
                let alignment = style.map(|s| s.align.as_str()).unwrap_or("start");
                // 22 号字典 §4: run-level keys without a kernel slot ride
                // bindings and are written back onto every segment.
                let vertical_alignment = n
                    .bindings
                    .get("sketchTextVerticalAlignment")
                    .and_then(|s| s.parse::<i64>().ok());
                let text_transform = n
                    .bindings
                    .get("sketchTextTransform")
                    .and_then(|s| serde_json::from_str::<Value>(s).ok());
                let allows_tightening = n
                    .bindings
                    .get("sketchTextAllowsTightening")
                    .is_some_and(|v| v == "1" || v == "true");
                let mut attribute = |location: usize,
                                 length: usize,
                                 font: &str,
                                 size: f64,
                                 weight: f32,
                                 color: Option<&str>,
                                 underline: bool,
                                 strikethrough: bool|
                 -> Result<Value> {
                    let mut attrs = Map::new();
                    attrs.insert(
                        "MSAttributedStringFontAttribute".into(),
                        sketch_font_descriptor(doc, &mut images.font_weight_axes, font, size, weight),
                    );
                    if let Some(c) = color {
                        attrs.insert(
                            "MSAttributedStringColorAttribute".into(),
                            hex_to_rgba(c, 1., images.color_settings)?,
                        );
                    }
                    if kerning != 0. {
                        attrs.insert("kerning".into(), json!(kerning));
                    }
                    if underline {
                        attrs.insert("underlineStyle".into(), json!(1));
                    }
                    if strikethrough {
                        attrs.insert("strikethroughStyle".into(), json!(1));
                    }
                    if let Some(v) = vertical_alignment {
                        attrs.insert("textStyleVerticalAlignmentKey".into(), json!(v));
                    }
                    if let Some(t) = &text_transform {
                        attrs.insert("MSAttributedStringTextTransformAttribute".into(), t.clone());
                    }
                    let mut para = Map::new();
                    para.insert("_class".into(), json!("paragraphStyle"));
                    para.insert("alignment".into(), json!(paragraph_alignment(alignment)));
                    if let Some(s) = style {
                        // Only authored line heights become fixed Sketch
                        // line heights; the kernel default stays implicit so
                        // Sketch's own font metrics keep rendering.
                        if s.line_height > 0. && (s.line_height - 1.35).abs() > 1e-9 {
                            let px = s.line_height * size;
                            para.insert("minimumLineHeight".into(), json!(px));
                            para.insert("maximumLineHeight".into(), json!(px));
                        }
                        if s.paragraph_spacing != 0. {
                            para.insert("paragraphSpacing".into(), json!(s.paragraph_spacing));
                        }
                    }
                    para.insert(
                        "allowsDefaultTighteningForTruncation".into(),
                        json!(allows_tightening),
                    );
                    attrs.insert("textStyleBasicParagraphStyle".into(), Value::Object(para));
                    Ok(json!({"_class": "stringAttribute", "attributes": Value::Object(attrs),
                           "location": location, "length": length}))
                };
                let total = utf16_len(&n.text);
                let mut runs: Vec<&crate::font::TextRun> = n
                    .text_runs
                    .iter()
                    .filter(|r| r.end > r.start && r.start < total)
                    .collect();
                runs.sort_by_key(|r| r.start);
                let mut attributes: Vec<Value> = Vec::new();
                let mut cursor = 0usize;
                for run in runs {
                    let start = run.start.min(total);
                    let end = run.end.min(total).max(start);
                    if end <= start {
                        continue;
                    }
                    if start > cursor {
                        // gap between runs keeps the node-level defaults
                        attributes.push(attribute(
                            cursor,
                            start - cursor,
                            default_font,
                            n.font_size,
                            default_weight,
                            default_color.as_deref(),
                            false,
                            false,
                        )?);
                    }
                    attributes.push(attribute(
                        start,
                        end - start,
                        run.font_id.as_deref().unwrap_or(default_font),
                        run.font_size.unwrap_or(n.font_size),
                        run.weight.unwrap_or(default_weight),
                        run.color.as_deref().or(default_color.as_deref()),
                        run.underline,
                        run.strikethrough,
                    )?);
                    cursor = end;
                }
                if cursor < total || attributes.is_empty() {
                    attributes.push(attribute(
                        cursor,
                        total - cursor,
                        default_font,
                        n.font_size,
                        default_weight,
                        default_color.as_deref(),
                        false,
                        false,
                    )?);
                }
                layer.insert(
                    "attributedString".into(),
                    json!({
                        "_class": "attributedString",
                        "string": n.text,
                        "attributes": attributes
                    }),
                );
                layer.insert("automaticallyDrawOnUnderlyingPath".into(), json!(false));
                layer.insert("dontSynchroniseWithSymbol".into(), json!(false));
                // TextBehaviour is a sizing contract, not a wrap switch. A
                // node without Sizing has fixed authored extents in the kernel.
                let behaviour = sketch_text_behaviour(n);
                if n.sizing.as_ref().is_some_and(|s| {
                    use crate::layout::SizeMode;
                    s.width == SizeMode::Fill || s.height == SizeMode::Fill
                        || (s.width == SizeMode::Hug && s.height != SizeMode::Hug)
                }) {
                    note_lossy(&mut lossy, "text-sizing-not-representable-in-native-sketch");
                }
                if style.is_some_and(|s| s.wrap) != (behaviour != 0) {
                    note_lossy(&mut lossy, "text-wrap-in-userInfo-native-sketch-may-wrap-differently");
                }
                layer.insert("textBehaviour".into(), json!(behaviour));
                // lineSpacingBehaviour: stored binding wins; a custom line
                // height (written as fixed min/maxLineHeight above) derives
                // 3 (自定义), everything else keeps the fig2sketch default 2
                // ("more or less a version number", sketchformat/text.py).
                let spacing_behaviour = n
                    .bindings
                    .get("sketchLineSpacingBehaviour")
                    .and_then(|s| s.parse::<i64>().ok())
                    .unwrap_or(if style.is_some_and(|s| {
                        s.line_height > 0. && (s.line_height - 1.35).abs() > 1e-9
                    }) {
                        3
                    } else {
                        2
                    });
                layer.insert("lineSpacingBehaviour".into(), json!(spacing_behaviour));
                layer.insert(
                    "glyphBounds".into(),
                    json!(format!("{{0, 0, {}, {}}}", n.width, n.height)),
                );
            }
            "bitmap" => {
                if let Some(paint) = n.fills.iter().find(|p| p.kind == "image")
                    && let Some(uri) = paint.image.as_deref()
                    && let Some((_, bytes)) = data_uri_bytes(uri)
                {
                    let name = sha1_hex(&bytes);
                    if images.seen.insert(name.clone()) {
                        images.entries.push((format!("images/{name}"), bytes));
                    }
                    layer.insert(
                        "image".into(),
                        json!({"_class": "MSJSONFileReference",
                                        "_ref_class": "MSImageData", "_ref": name}),
                    );
                }
            }
            _ => {}
        }
        // P1-8: auto-layout stacks. Sketch 2025 expresses them as a
        // FlexGroupLayout groupLayout + four padding fields on the group
        // (fig2sketch converter/layout.py, mapping table verified above).
        if let Some(l) = &n.layout
            && matches!(
                l.mode,
                crate::layout::Flow::Horizontal | crate::layout::Flow::Vertical
            )
            && matches!(
                class,
                "group" | "artboard" | "symbolMaster" | "shapeGroup" | "canvasFrame"
            )
        {
            let justify = flex_justify(l.justify, &mut lossy);
            let align = flex_align(l.align, &mut lossy);
            layer.insert(
                "groupLayout".into(),
                json!({
                    "_class": "MSImmutableFlexGroupLayout",
                    "flexDirection": if l.mode == crate::layout::Flow::Vertical { 1 } else { 0 },
                    "justifyContent": justify, "alignItems": align,
                    "allGuttersGap": l.gap
                }),
            );
            layer.insert("topPadding".into(), json!(l.padding[0]));
            layer.insert("rightPadding".into(), json!(l.padding[1]));
            layer.insert("bottomPadding".into(), json!(l.padding[2]));
            layer.insert("leftPadding".into(), json!(l.padding[3]));
            // converter logic: asymmetric padding selects INDIVIDUAL (2),
            // anything else PAIRED (1)
            layer.insert(
                "paddingSelection".into(),
                json!(if (l.padding[0] - l.padding[2]).abs() > 1e-9
                    || (l.padding[3] - l.padding[1]).abs() > 1e-9
                {
                    2
                } else {
                    1
                }),
            );
            if l.wrap {
                note_lossy(&mut lossy, "stack-wrap-omitted");
            }
            if l.line_gap != 0. {
                note_lossy(&mut lossy, "stack-line-gap-omitted");
            }
        } else if let Some(l) = &n.layout
            && !matches!(l.mode, crate::layout::Flow::None)
        {
            note_lossy(&mut lossy, "stack-grid-layout-omitted");
        }
        // 21 号 P2-11: prototype flows. Sketch's classic model is one click
        // flow per layer (MSImmutableFlowConnection + MSTransition duration
        // in seconds + overlaySettings presence marking overlay actions,
        // fig2sketch sketchformat.prototype). Everything beyond that
        // (multiple interactions, non-click triggers, easing curves, overlay
        // positions, conditions) rides userInfo verbatim.
        if let Some(events) = doc.prototype.as_ref().and_then(|p| p.interactions.get(id)) {
            let mut exported_flow = false;
            if let Some(first) = events.first()
                && first.trigger == "click"
                && let Some(action) = first.actions.iter().find(|a| {
                    matches!(a.kind.as_str(), "navigate" | "overlay")
                        && a.target
                            .as_ref()
                            .is_some_and(|t| doc.nodes.get(t).is_some_and(|n| n.kind == "frame"))
                })
            {
                let mut flow = Map::new();
                flow.insert("_class".into(), json!("MSImmutableFlowConnection"));
                flow.insert(
                    "destinationArtboardID".into(),
                    json!(action.target.as_deref().map(sketch_id)),
                );
                flow.insert(
                    "transition".into(),
                    json!({"_class": "MSTransition",
                           "duration": action.duration_ms as f64 / 1000.}),
                );
                flow.insert("animationType".into(), json!(-1));
                flow.insert("maintainScrollPosition".into(), json!(false));
                if action.kind == "overlay" {
                    // The archived overlay position fields are not documented;
                    // the class marker plus the userInfo payload keep the
                    // intent identifiable.
                    flow.insert(
                        "overlaySettings".into(),
                        json!({"_class": "MSImmutableFlowOverlaySettings"}),
                    );
                }
                layer.insert("flow".into(), Value::Object(flow));
                exported_flow = true;
                if action.easing_curve.is_some() {
                    note_lossy(&mut lossy, "flow-easing-curve-not-in-sketch-flow");
                }
                if action.overlay_position.is_some() {
                    note_lossy(&mut lossy, "flow-overlay-position-not-serialized");
                }
            }
            let beyond_native = events.len() > 1
                || events
                    .iter()
                    .any(|e| e.trigger != "click" || e.condition.is_some() || e.delay_ms != 0)
                || events.iter().any(|e| {
                    e.actions.len() > 1
                        || e.actions.iter().any(|a| {
                            !matches!(a.kind.as_str(), "navigate" | "overlay")
                                || a.easing_curve.is_some()
                                || a.overlay_position.is_some()
                        })
                })
                || !exported_flow;
            if beyond_native {
                note_lossy(&mut lossy, "prototype-interactions-in-userInfo");
                pending_user_prototype = Some(serde_json::to_value(events).unwrap_or(Value::Null));
            }
        }
        let mut children: Vec<Value> = n
            .children
            .iter()
            .map(|c| export_layer(doc, c, images))
            .collect::<Result<Vec<_>>>()?;
        if class == "shapeGroup" && let Some(operation) = n.boolean_operation {
            let source = n.bindings.get("sketchSourceShapeGroup")
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
            let unchanged = source.as_ref().is_some_and(|source| {
                serde_json::from_value::<Vec<String>>(source["children"].clone()).ok().as_ref() == Some(&n.children)
                    && n.bindings.get("sketchShapeGroupMappedOperation")
                        .and_then(|raw| serde_json::from_str::<crate::boolean::Operation>(raw).ok()) == Some(operation)
            });
            if unchanged {
                let source = source.as_ref().unwrap();
                layer.insert("booleanOperation".into(), source["parentOperation"].clone());
                for (index, child) in children.iter_mut().enumerate() {
                    child["booleanOperation"] = source["operations"][index].clone();
                }
            } else {
                for child in children.iter_mut().skip(1) {
                    child["booleanOperation"] = json!(boolean_code(operation));
                }
            }
        }
        if !children.is_empty() {
            layer.insert("layers".into(), Value::Array(children));
        }
        if n.mask {
            layer.insert("hasClippingMask".into(), json!(true));
            layer.insert("shouldBreakMaskChain".into(), json!(false));
        }
        // Kernel-native payloads that Sketch cannot express travel through
        // our userInfo namespace: the component definition (variants and
        // properties) survives symbol round-trips this way.
        let mut user_info = Map::new();
        user_info.insert("originalId".into(), json!(id));
        if n.kind == "text" {
            let behaviour = sketch_text_behaviour(n);
            let wrap = n.text_style.as_ref().is_some_and(|s| s.wrap);
            if wrap != (behaviour != 0) {
                user_info.insert("textWrap".into(), json!({"textBehaviour": behaviour, "text": n.text, "wrap": wrap}));
            }
        }
        if let Some(key) = &n.component_key { user_info.insert("componentKey".into(), json!(key)); }
        if n.component_set { user_info.insert("componentSet".into(), json!(true)); }
        if let Some(c) = &n.component
        {
            user_info.insert(
                "component".into(),
                serde_json::to_value(c).unwrap_or(Value::Null),
            );
        }
        if let Some(instance) = &n.instance {
            user_info.insert("instance".into(), serde_json::to_value(instance).unwrap_or(Value::Null));
        }
        if let Some(inst) = &n.instance
            && !inst.property_values.is_empty()
        {
            user_info.insert(
                "instanceProperties".into(),
                serde_json::to_value(&inst.property_values).unwrap_or(Value::Null),
            );
        }
        // Layout grid appearance (color/opacity) has no archived Sketch home;
        // the full authored payload keeps kernel round-trips lossless.
        if let Some(grid) = &n.layout_grid {
            user_info.insert(
                "layoutGrid".into(),
                serde_json::to_value(grid).unwrap_or(Value::Null),
            );
        }
        if let Some(events) = pending_user_prototype {
            user_info.insert("prototypeInteractions".into(), events);
        }
        if !lossy.is_empty() {
            user_info.insert("lossy".into(), json!(lossy));
        }
        layer.insert(
            "userInfo".into(),
            json!({"com.futureox.design-kernel": Value::Object(user_info)}),
        );
        if n.kind == "hotspot" {
            // Additive restore of the stashed native layer (round 2 of the
            // limited hotspot mapping): only keys the generic exporter never
            // writes — the prototype flow payload and any other native fields
            // — so geometry and identity stay model-driven.
            if let Some(raw) = n
                .bindings
                .get("sketchRawLayer")
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .and_then(|v| v.as_object().cloned())
            {
                for (key, value) in raw {
                    if key != "layers" && !layer.contains_key(&key) {
                        layer.insert(key, value);
                    }
                }
            }
        }
        // P0-4: splice preserved adaptable colors / swatch references back
        // into their style/text/background slots and restore the
        // updatableColors recolor markers.
        adaptable_apply_layer(&mut layer, &n.bindings);
    }
    Ok(Value::Object(layer))
}

/// P0-4 container export: a shared style's preserved color payloads return
/// to their slots inside the archived style dict — raw adaptable color JSON
/// under `colors`, swatch references under `swatchID`, plus the
/// updatableColors recolor marker.
fn adaptable_apply_shared_style(object: &mut Value, fidelity: &Value) {
    let Some(style) = object.get_mut("value") else {
        return;
    };
    if let Some(colors) = fidelity.get("colors").and_then(Value::as_object) {
        for (slot, raw) in colors {
            if let Some(target) = adaptable_slot_in_style(style, slot) {
                *target = raw.clone();
            }
        }
    }
    if let Some(swatches) = fidelity.get("swatchID").and_then(Value::as_object) {
        for (slot, id) in swatches {
            if let Some(target) = adaptable_slot_in_style(style, slot)
                && let Some(color) = target.as_object_mut()
            {
                color.insert("swatchID".into(), id.clone());
            }
        }
    }
    if let Some(updatable) = fidelity.get("updatableColors") {
        style["updatableColors"] = updatable.clone();
    }
}

/// P1-13 export: rebuild document.json foreignSymbols entries from the
/// local masters carrying `sketchForeignLibraryID`. The embedded copy is
/// re-exported from the live node (it may have been edited); everything
/// else — originalMaster, remoteToLocalIDMap, library flags — comes from
/// the raw entry kept at import.
fn foreign_symbol_export(doc: &Document, images: &mut ExportedImages) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for (id, node) in &doc.nodes {
        let Some(library_id) = node.bindings.get("sketchForeignLibraryID") else {
            continue;
        };
        let mut entry = node
            .bindings
            .get("sketchForeignSymbolRaw")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        entry.insert("_class".into(), json!("MSImmutableForeignSymbol"));
        if !entry.contains_key("do_objectID") {
            entry.insert(
                "do_objectID".into(),
                json!(sketch_id(&format!("{id}-foreign"))),
            );
        }
        entry.insert("libraryID".into(), json!(library_id));
        let mut master = export_layer(doc, id, images)?;
        if let Value::Object(map) = &mut master {
            map.insert("_class".into(), json!("symbolMaster"));
            let symbol_id = node
                .bindings
                .get("symbolID")
                .cloned()
                .unwrap_or_else(|| sketch_id(id));
            map.insert("symbolID".into(), json!(symbol_id));
            map.entry("allowsOverrides").or_insert_with(|| json!(true));
            map.entry("overrideProperties").or_insert_with(|| json!([]));
        }
        if !entry.contains_key("originalMaster") {
            entry.insert("originalMaster".into(), master.clone());
        }
        entry.insert("symbolMaster".into(), master);
        if !entry.contains_key("remoteToLocalIDMap") {
            entry.insert("remoteToLocalIDMap".into(), json!({}));
        }
        if !entry.contains_key("symbolPrivate") {
            entry.insert("symbolPrivate".into(), json!(false));
        }
        out.push(Value::Object(entry));
    }
    Ok(out)
}

/// Export the kernel document as a `.sketch` bundle Sketch can open.
pub fn export_sketch(doc: &Document) -> Result<Vec<u8>> {
    let settings = doc.color_management.unwrap_or_default();
    if !matches!(settings.document_space, ColorSpace::Srgb | ColorSpace::DisplayP3) {
        return Err(Error::Unsupported(format!("Sketch only supports sRGB or Display P3 document profiles, not {:?}; preserve the native file or explicitly convert an SDR copy", settings.document_space)));
    }
    settings.validate().map_err(Error::InvalidDocument)?;
    for node in doc.nodes.values() {
        if sketch_placement(node).is_none() {
            return Err(Error::Unsupported(format!(
                "Sketch export cannot represent scaled or sheared affine placement on layer `{}` without changing editable geometry; use the native document format", node.id)));
        }
    }
    let mut images = ExportedImages {
        font_weight_axes: BTreeMap::new(),
        color_settings: settings,
        entries: Vec::new(),
        seen: Default::default(),
    };
    let mut page_refs = Vec::new();
    let mut pages_and_artboards = Map::new();
    let mut page_entries: Vec<(String, Vec<u8>)> = Vec::new();

    for page in &doc.pages {
        let page_json = {
            let mut page_layer = export_layer(doc, &page.id, &mut images)?;
            if let Value::Object(map) = &mut page_layer {
                map.insert("_class".into(), json!("page"));
                map.insert("name".into(), json!(page.name));
                map.insert("layers".into(), Value::Array(page.children.iter()
                    .map(|id| export_layer(doc, id, &mut images)).collect::<Result<Vec<_>>>()?));
                map.insert("userInfo".into(), json!({"com.futureox.design-kernel":{"originalId":page.id}}));
                map.remove("frame");
                map.remove("style");
            }
            page_layer
        };
        let mut artboard_map = Map::new();
        for child in &page.children {
            if let Some(node) = doc.nodes.get(child)
                && node.kind == "frame"
            {
                artboard_map.insert(sketch_id(&child), json!({"name": node.name}));
            }
        }
        pages_and_artboards.insert(
            sketch_id(&page.id),
            json!({"name": page.name, "artboards": artboard_map}),
        );
        page_refs.push(json!({
            "_class": "MSJSONFileReference",
            "_ref_class": "MSImmutablePage",
            "_ref": format!("pages/{}", sketch_id(&page.id))
        }));
        page_entries.push((
            format!("pages/{}.json", sketch_id(&page.id)),
            serde_json::to_vec_pretty(&page_json).map_err(|e| Error::Io(e.to_string()))?,
        ));
    }

    // P0-4: color space. Sketch document.json colorSpace: 0 unmanaged,
    // 1 sRGB, 2 P3 — the kernel color_management maps onto the same three
    // states. Unsupported target profiles have already failed at admission;
    // no linear/HDR document is silently relabelled as unmanaged.
    let color_space = match doc.color_management.as_ref().map(|c| c.document_space) {
        Some(crate::color::ColorSpace::DisplayP3) => 2,
        Some(crate::color::ColorSpace::Srgb) => 1,
        _ => 0,
    };

    // P1-6: shared style containers (22 号字典 §6: document.json
    // layerStyles/layerTextStyles hold the definitions layers reference by
    // sharedStyleID). Kernel paint styles carry fills; text styles carry
    // the paragraph/font basics.
    let mut layer_styles = Vec::new();
    let mut layer_text_styles = Vec::new();
    if let Some(system) = &doc.design_system {
        for (style_id, shared) in &system.styles {
            let object = match shared.kind.as_str() {
                "paint" => {
                    let mut paints = Vec::new();
                    if let Some(values) = shared.value.as_array() {
                        for value in values {
                            if let Ok(paint) = serde_json::from_value::<Paint>(value.clone())
                                && let Some(part) = export_paint(&paint, &mut images, [1., 1.])? {
                                paints.push(part);
                            }
                        }
                    }
                    // Full layer styles archive borders/shadows/blur next to
                    // their fills; the shared helper writes the same parts a
                    // layer with these strokes/effects would.
                    let mut style_lossy = Vec::new();
                    let (borders, shadows, inner_shadows, blur, border_options) =
                        export_style_parts(&shared.strokes, &shared.effects, &mut style_lossy, images.color_settings)?;
                    json!({"_class":"sharedStyle", "do_objectID": sketch_shared_style_id(style_id), "name": shared.name,
                           "value": {"_class": "style", "do_objectID": sketch_id(style_id),
                                     "fills": paints, "borders": borders,
                                     "shadows": shadows, "innerShadows": inner_shadows,
                                     "blur": blur, "borderOptions": border_options}})
                }
                "text" => {
                    let style: Option<crate::font::TextStyle> =
                        serde_json::from_value(shared.value.clone()).ok();
                    let encoded = style.as_ref().map(|s| {
                        json!({
                            "_class": "textStyle",
                            "verticalAlignment":0,
                            "encodedAttributes": {
                                "MSAttributedStringFontAttribute": sketch_font_descriptor(doc, &mut images.font_weight_axes, &s.font_id, 16., s.weight),
                                "kerning": s.letter_spacing,
                                "paragraphStyle": {"_class": "paragraphStyle",
                                    "alignment": paragraph_alignment(&s.align),
                                    "minimumLineHeight": s.line_height * 16.,
                                    "maximumLineHeight": s.line_height * 16.,
                                    "paragraphSpacing": s.paragraph_spacing,
                                    "firstLineHeadIndent": s.paragraph_indent,
                                    "allowsDefaultTighteningForTruncation": 0}
                            }
                        })
                    });
                    json!({"_class":"sharedStyle", "do_objectID": sketch_shared_style_id(style_id), "name": shared.name,
                           "value": {"_class":"style", "do_objectID": sketch_id(&format!("{style_id}-value")),
                               "textStyle": encoded.unwrap_or(Value::Null)}})
                }
                _ => continue,
            };
            // P0-4 container side: splice the style's preserved color
            // payloads (raw adaptable JSON / swatchID) and updatableColors
            // back at their recorded slots.
            let mut object = object;
            // Required Style members use the same defaults as ordinary layers.
            let value = &mut object["value"];
            for field in ["fills", "borders"] {
                if let Some(parts) = value.get_mut(field).and_then(Value::as_array_mut) {
                    for part in parts {
                        part.as_object_mut().unwrap().remove("noiseFillType");
                        if let Some(settings) = part["contextSettings"].as_object_mut() { settings.remove("isProgressive"); }
                        if part.get("gradient").is_none() {
                            part["gradient"] = json!({"_class":"gradient", "gradientType":0, "elipseLength":0,
                                "from":"{0.5, 0}", "to":"{0.5, 1}", "stops":[
                                    {"_class":"gradientStop", "position":0, "color":part["color"]},
                                    {"_class":"gradientStop", "position":1, "color":part["color"]}]});
                        }
                    }
                }
            }
            if value.pointer("/textStyle/encodedAttributes/paragraphStyle/firstLineHeadIndent").and_then(Value::as_f64) == Some(0.) {
                value["textStyle"]["encodedAttributes"]["paragraphStyle"].as_object_mut().unwrap().remove("firstLineHeadIndent");
            }
            value["startMarkerType"] = json!(0);
            value["endMarkerType"] = json!(0);
            value["miterLimit"] = json!(10);
            value["windingRule"] = json!(1);
            if value.get("innerShadows").is_none() { value["innerShadows"] = json!([]); }
            if value.get("borderOptions").is_none() {
                value["borderOptions"] = json!({"_class":"borderOptions", "isEnabled":true,
                    "dashPattern":[], "lineCapStyle":0, "lineJoinStyle":0});
            }
            if let Some(options) = value["borderOptions"].as_object_mut() {
                for field in ["startMarkerType", "endMarkerType", "miterLimit", "windingRule"] { options.remove(field); }
                options.insert("isEnabled".into(), json!(true));
            }
            value["colorControls"] = json!({"_class":"colorControls", "isEnabled":false,
                "brightness":0, "contrast":1, "hue":0, "saturation":1});
            if let Some(fidelity) = system
                .sketch_containers
                .get("sharedStyleFidelity")
                .and_then(|f| f.get(style_id))
            {
                adaptable_apply_shared_style(&mut object, fidelity);
            }
            if shared.kind == "text" {
                layer_text_styles.push(object);
            } else {
                layer_styles.push(object);
            }
        }
    }

    let mut document = json!({
        "_class": "document",
        "do_objectID": format!("doc-{}", doc.id),
        "assets": {"_class": "assetCollection", "colors": [], "gradients": [], "images": [], "colorAssets": []},
        "colorSpace": color_space,
        "currentPageIndex": 0,
        "pages": page_refs,
        "layerStyles": {"_class": "sharedStyleContainer", "objects": layer_styles},
        "layerTextStyles": {"_class": "sharedTextStyleContainer", "objects": layer_text_styles}
    });
    if let Some(system) = &doc.design_system {
        let ids: Map<String, Value> = system.styles.keys()
            .map(|id| (sketch_shared_style_id(id), json!(id))).collect();
        document["userInfo"] = json!({"com.futureox.design-kernel":{"sharedStyleIds":ids}});
    }
    // P1-13: verbatim document-level containers (sharedSwatches, foreign
    // style/swatch lists, library metadata) return untouched; foreign
    // symbols are rebuilt from their local masters, with entries that had
    // no embedded copy appended raw.
    if let Some(system) = &doc.design_system {
        for (key, value) in &system.sketch_containers {
            if matches!(key.as_str(), "sharedStyleFidelity" | "sharedStyleIds" | "foreignSymbolsUnresolved" | "nodeMetadata" | "textSourceLayouts") {
                continue;
            }
            document[key] = value.clone();
        }
    }
    crate::interop_resources::export_fonts(doc, &mut document)?;
    let mut foreign_symbols = foreign_symbol_export(doc, &mut images)?;
    if let Some(system) = &doc.design_system
        && let Some(unresolved) = system
            .sketch_containers
            .get("foreignSymbolsUnresolved")
            .and_then(Value::as_array)
    {
        foreign_symbols.extend(unresolved.iter().cloned());
    }
    if !foreign_symbols.is_empty() {
        document["foreignSymbols"] = Value::Array(foreign_symbols);
    }
    validate_sketch_shared_style_ids(&document)?;
    let meta = json!({
        "app": "com.futureox.design-kernel",
        "appVersion": "3.0",
        "build": 1,
        "commit": "interop",
        "pagesAndArtboards": pages_and_artboards,
        "version": 160,
        "compatibilityVersion": 99,
        "cocompatibilityVersion": 99,
        "created": {"_class": "date", "iso8601": "2026-01-01T00:00:00Z"},
        "saveHistory": ["interop"]
    });

    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    let push_json = |entries: &mut Vec<(String, Vec<u8>)>, name: &str, value: &Value| {
        entries.push((
            name.to_string(),
            serde_json::to_vec_pretty(value).unwrap_or_default(),
        ));
    };
    push_json(&mut entries, "meta.json", &meta);
    push_json(&mut entries, "document.json", &document);
    push_json(&mut entries, "user.json", &json!({}));
    push_json(&mut entries, "archive.json", &json!({"version": 1}));
    entries.extend(page_entries);
    entries.extend(images.entries);
    write_zip(&entries)
}

// ---------------------------------------------------------------------------
// .fig import — delegated to Sketch's own fig2sketch converter
// ---------------------------------------------------------------------------

/// Default helper location inside a Sketch install (see 17-fig2sketch.md).
pub const DEFAULT_FIG2SKETCH: &str = "/Applications/Sketch.app/Contents/MacOS/fig2sketch";

/// Import a `.fig` bundle. Reuses Sketch's bundled Python converter (the same
/// delegation Sketch itself performs — its native code only shells out to
/// `fig2sketch`, which turns the Kiwi scene graph into a `.sketch` bundle we
/// then import with [`import_sketch`]).
pub fn import_fig(bytes: &[u8]) -> Result<Document> {
    #[cfg(target_arch = "wasm32")]
    {
        let _ = bytes;
        Err(Error::UnsupportedFigPlatform)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        if !is_fig_file(bytes) {
            return Err(Error::NotAZip("canvas.fig marker missing".into()));
        }
        // native Rust kiwi reader first (no external helper)
        match crate::fig::import_fig_native(bytes) {
            Ok(doc) => Ok(doc),
            Err(native) => {
                eprintln!("[fig] native import failed ({native}); falling back to fig2sketch");
                import_fig_via_converter(bytes)
            }
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn fig2sketch_path() -> std::path::PathBuf {
    if let Ok(path) = std::env::var("FIG2SKETCH_BIN") {
        return std::path::PathBuf::from(path);
    }
    std::path::PathBuf::from(DEFAULT_FIG2SKETCH)
}

#[cfg(not(target_arch = "wasm32"))]
fn import_fig_via_converter(bytes: &[u8]) -> Result<Document> {
    let helper = fig2sketch_path();
    if !helper.exists() {
        return Err(Error::Fig2Sketch(format!(
            "converter not found at {} (set FIG2SKETCH_BIN)",
            helper.display()
        )));
    }
    let dir = std::env::temp_dir().join(format!("fxdk-fig-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| Error::Io(e.to_string()))?;
    let input = dir.join("input.fig");
    let output = dir.join("output.sketch");
    std::fs::write(&input, bytes).map_err(|e| Error::Io(e.to_string()))?;
    let status = std::process::Command::new(&helper)
        .arg(&input)
        .arg(&output)
        .output()
        .map_err(|e| Error::Fig2Sketch(e.to_string()))?;
    let sketch_bytes =
        std::fs::read(&output).map_err(|e| Error::Fig2Sketch(format!("no output file: {e}")))?;
    let _ = std::fs::remove_dir_all(&dir);
    if !status.status.success() {
        return Err(Error::Fig2Sketch(format!(
            "exit {:?}: {}",
            status.status.code(),
            String::from_utf8_lossy(&status.stderr)
                .chars()
                .take(400)
                .collect::<String>()
        )));
    }
    import_sketch(&sketch_bytes)
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    fn archive_test_limits() -> ArchiveLimits {
        ArchiveLimits { input: 16 * 1024, entries: 4, entry: 1024, document_entry:1024, total: 1536 }
    }

    fn patch_zip_sizes(bytes: &mut [u8], size: u32) {
        // Fixtures contain no accidental signatures in their compressed data.
        for at in 0..bytes.len().saturating_sub(46) {
            let offset = if &bytes[at..at + 4] == b"PK\x01\x02" {
                Some(24)
            } else if &bytes[at..at + 4] == b"PK\x03\x04" {
                Some(22)
            } else { None };
            if let Some(offset) = offset {
                bytes[at + offset..at + offset + 4].copy_from_slice(&size.to_le_bytes());
            }
        }
    }

    #[test]
    fn bounded_archive_valid_exact_limits_and_high_compression() {
        let entries = vec![("canvas.fig".into(), vec![0; 1024]),
            ("images/a".into(), vec![1; 512])];
        let bytes = write_zip(&entries).unwrap();
        let mut limits = archive_test_limits();
        limits.input = bytes.len();
        limits.entries = entries.len();
        assert_eq!(read_zip_bounded(&bytes, limits).unwrap(), entries.into_iter().collect());
        // High compression is supported; the expanded-byte budget is the guard.
        let bytes = write_zip(&[("canvas.fig".into(), vec![0; 256 * 1024])]).unwrap();
        assert!(bytes.len() < 2048);
        assert_eq!(read_zip_public(&bytes).unwrap()["canvas.fig"].len(), 256 * 1024);
    }

    #[test]
    fn bounded_archive_empty_and_truncated_containers() {
        let bytes = write_zip(&[]).unwrap();
        assert!(read_zip(&bytes).unwrap().is_empty());
        for end in 0..bytes.len() {
            assert!(read_zip(&bytes[..end]).is_err());
        }
    }

    #[test]
    fn bounded_archive_rejects_each_budget() {
        let bytes = write_zip(&[("a".into(), vec![0; 1024]), ("b".into(), vec![1; 513])]).unwrap();
        let limits = archive_test_limits();
        assert!(read_zip_bounded(&bytes, limits).unwrap_err().to_string().contains("total expanded"));
        assert!(read_zip_bounded(&bytes, ArchiveLimits { entries: 1, ..limits }).unwrap_err().to_string().contains("entry count"));
        assert!(read_zip_bounded(&bytes, ArchiveLimits { input: bytes.len() - 1, ..limits }).unwrap_err().to_string().contains("input bytes"));
        assert!(read_zip_bounded(&bytes, ArchiveLimits { entry: 1023, ..limits }).unwrap_err().to_string().contains("entry expanded"));
    }

    #[test]
    fn bounded_archive_rejects_forged_sizes_and_compression_bombs() {
        let bytes = write_zip(&[("canvas.fig".into(), vec![0; 8192])]).unwrap();
        for declared in [0, 1, 1024, u32::MAX] {
            let mut forged = bytes.clone();
            patch_zip_sizes(&mut forged, declared);
            let error = read_zip_bounded(&forged, archive_test_limits()).unwrap_err().to_string();
            assert!(error.contains("entry expanded bytes"), "declared={declared}: {error}");
        }
        // A lying second entry must also stop at the remaining total allowance.
        let mut bytes = write_zip(&[("a".into(), vec![0; 800]), ("b".into(), vec![1; 800])]).unwrap();
        for at in 0..bytes.len().saturating_sub(47) {
            let offset = if &bytes[at..at + 4] == b"PK\x01\x02" && bytes[at + 46] == b'b' {
                Some(24)
            } else if &bytes[at..at + 4] == b"PK\x03\x04" && bytes[at + 30] == b'b' {
                Some(22)
            } else { None };
            if let Some(offset) = offset {
                bytes[at + offset..at + offset + 4].copy_from_slice(&0u32.to_le_bytes());
            }
        }
        let error = read_zip_bounded(&bytes, archive_test_limits()).unwrap_err().to_string();
        assert!(error.contains("total expanded"), "{error}");
    }

    #[test]
    fn bounded_archive_rejects_paths_duplicates_and_symlinks() {
        for name in ["../a", "/a", "C:a", "a\\b", "a//b", "./a"] {
            let bytes = write_zip(&[(name.into(), vec![1])]).unwrap();
            assert!(read_zip(&bytes).unwrap_err().to_string().contains("archive path"), "{name}");
        }
        let mut duplicate = write_zip(&[("a".into(), vec![1]), ("b".into(), vec![2])]).unwrap();
        // ZipWriter itself refuses duplicate names: forge an actual ZIP instead.
        for at in 0..duplicate.len().saturating_sub(46) {
            if &duplicate[at..at + 4] == b"PK\x01\x02" { duplicate[at + 46] = b'a'; }
            if &duplicate[at..at + 4] == b"PK\x03\x04" { duplicate[at + 30] = b'a'; }
        }
        assert!(read_zip(&duplicate).unwrap_err().to_string().contains("duplicate"));
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer.add_symlink("link", "document.json", zip::write::SimpleFileOptions::default()).unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert!(read_zip(&bytes).unwrap_err().to_string().contains("symlink"));
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer.add_directory("a/", zip::write::SimpleFileOptions::default()).unwrap();
        writer.start_file("a", zip::write::SimpleFileOptions::default()).unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert!(read_zip(&bytes).unwrap_err().to_string().contains("duplicate"));
    }

    #[test]
    fn text_ranges_use_utf16_and_linear_gradient_geometry_roundtrips() {
        let mut doc = sample_document();
        doc.nodes.get_mut("n2").unwrap().text = "A😀中".into();
        let mut grad = blank_paint("linear");
        grad.transform = Some(Transform([0.7, 0.3, -0.3, 0.7, 0.2, -0.1]));
        grad.stops = vec![
            crate::scene::Stop {
                offset: 0.,
                color: "#000000".into(),
            },
            crate::scene::Stop {
                offset: 1.,
                color: "#ffffff".into(),
            },
        ];
        doc.nodes.get_mut("n1").unwrap().fills = vec![grad.clone()];
        let bytes = export_sketch(&doc).unwrap();
        let files = read_zip(&bytes).unwrap();
        let name = files
            .keys()
            .find(|n| n.starts_with("pages/"))
            .unwrap()
            .clone();
        let page: Value = serde_json::from_slice(&files[&name]).unwrap();
        assert_eq!(
            page["layers"][1]["attributedString"]["attributes"][0]["length"],
            4
        );
        let back = import_sketch(&bytes).unwrap();
        let before = grad.transform.unwrap().inverse().unwrap();
        let after = back.nodes["n1"].fills[0]
            .transform
            .unwrap()
            .inverse()
            .unwrap();
        for p in [
            crate::math::Point::new(0., 0.),
            crate::math::Point::new(1., 1.),
            crate::math::Point::new(0.23, 0.84),
        ] {
            assert!((before.point(p).x - after.point(p).x).abs() < 1e-12);
        }
    }

    #[test]
    fn exported_text_run_spans_are_utf16_code_units() {
        // 22-sketch-json-dictionary.md §4: attributedString {location, length}
        // are UTF-16 code-unit offsets, not code-point counts. The string
        // below mixes BMP CJK with emoji and a supplementary-plane math
        // letter: 5 code points but 1+2+2+1+2 = 8 UTF-16 code units.
        let mut doc = sample_document();
        doc.nodes.get_mut("n2").unwrap().text = "中😀𝕏文🎉".into();
        let bytes = export_sketch(&doc).unwrap();
        let files = read_zip(&bytes).unwrap();
        let name = files
            .keys()
            .find(|n| n.starts_with("pages/"))
            .unwrap()
            .clone();
        let page: Value = serde_json::from_slice(&files[&name]).unwrap();
        let runs = &page["layers"][1]["attributedString"]["attributes"];
        assert_eq!(runs.as_array().map(Vec::len), Some(1));
        assert_eq!(runs[0]["location"], 0);
        assert_eq!(runs[0]["length"], 8);
        // The string itself survives the round trip unharmed.
        let back = import_sketch(&bytes).unwrap();
        assert_eq!(back.nodes["n2"].text, "中😀𝕏文🎉");
    }

    #[test]
    fn hotspot_layers_keep_raw_payload_with_explicit_limited_mapping() {
        // Minimal .sketch input: export the sample doc, then patch one layer
        // into a native hotspot carrying a prototype flow destination.
        let bytes = export_sketch(&sample_document()).unwrap();
        let mut files = read_zip(&bytes).unwrap();
        let name = files
            .keys()
            .find(|n| n.starts_with("pages/"))
            .unwrap()
            .clone();
        let mut page: Value = serde_json::from_slice(&files[&name]).unwrap();
        page["layers"][1]["_class"] = json!("hotspot");
        page["layers"][1]["flow"] = json!({
            "_class": "MSImmutableFlowDestination",
            "actionType": 2,
            "destinationArtboardID": "AAAABBBB-0000-4000-8000-000000000001",
            "overlaySettings": {"_class": "MSOverlaySettings"},
            "transition": {"_class": "MSTransition", "duration": 0.3}
        });
        files.insert(name.clone(), serde_json::to_vec(&page).unwrap());
        let encoded = write_zip(&files.into_iter().collect::<Vec<_>>()).unwrap();

        let back = import_sketch(&encoded).unwrap();
        let node = back.nodes.get("n2").unwrap();
        // Not masqueraded as a frame: limited kind plus explicit degradation.
        assert_eq!(node.kind, "hotspot");
        assert!(node.bindings.contains_key("interopLimited"));
        let raw = node
            .bindings
            .get("sketchRawLayer")
            .expect("raw layer stashed");
        assert!(raw.contains("MSImmutableFlowDestination"));
        assert!(raw.contains("AAAABBBB-0000-4000-8000-000000000001"));

        // Re-export restores the native hotspot class and its flow payload,
        // with geometry still driven by the model.
        let re = export_sketch(&back).unwrap();
        let re_files = read_zip(&re).unwrap();
        let re_page: Value = serde_json::from_slice(&re_files[&name]).unwrap();
        let hotspot = &re_page["layers"][1];
        assert_eq!(hotspot["_class"], "hotspot");
        assert_eq!(hotspot["flow"]["_class"], "MSImmutableFlowDestination");
        assert_eq!(
            hotspot["flow"]["destinationArtboardID"],
            "AAAABBBB-0000-4000-8000-000000000001"
        );
        assert_eq!(hotspot["name"], "Caption");
    }

    #[test]
    fn gradient_anchors_come_from_transform_or_angle_not_constants() {
        let read_page = |bytes: &[u8]| -> Value {
            let files = read_zip(bytes).unwrap();
            let name = files
                .keys()
                .find(|n| n.starts_with("pages/"))
                .unwrap()
                .clone();
            serde_json::from_slice(&files[&name]).unwrap()
        };
        // Build orthogonal ellipse axes in layer pixels (320×200), with
        // a perpendicular/primary radius ratio of 1.5. Native radial anchors
        // describe the center (.35,.65) and radius endpoint (.65,.75).
        let mut doc = sample_document();
        let mut radial = blank_paint("radial");
        radial.transform = Some(Transform([0.6, 0.2, -0.1875, 1.44, 0.14375, -0.17]));
        radial.stops = vec![crate::scene::Stop {
            offset: 0.,
            color: "#000000".into(),
        }];
        doc.nodes.get_mut("n1").unwrap().fills = vec![radial];
        let bytes = export_sketch(&doc).unwrap();
        let grad = &read_page(&bytes)["layers"][0]["style"]["fills"][0]["gradient"];
        assert_eq!(grad["gradientType"], 1);
        let (fx, fy) = point_xy(&grad["from"]);
        let (tx, ty) = point_xy(&grad["to"]);
        assert!((fx - 0.35).abs() < 1e-12 && (fy - 0.65).abs() < 1e-12);
        assert!((tx - 0.65).abs() < 1e-12 && (ty - 0.75).abs() < 1e-12);
        assert!((grad["elipseLength"].as_f64().unwrap() - 1.5).abs() < 1e-12);
        let back = import_sketch(&bytes).unwrap();
        let t = back.nodes["n1"].fills[0].transform.unwrap().0;
        for (got, want) in t.iter().zip([0.6, 0.2, -0.1875, 1.44, 0.14375, -0.17]) {
            assert!((got - want).abs() < 1e-12);
        }

        // Angle-only paint (no transform): anchors follow the angle — a 90°
        // axis is vertical, not the old hardcoded "{0, 0.5}"→"{1, 0.5}".
        let mut doc = sample_document();
        let mut lin = blank_paint("linear");
        lin.angle = 90.;
        lin.stops = vec![crate::scene::Stop {
            offset: 0.,
            color: "#111111".into(),
        }];
        doc.nodes.get_mut("n1").unwrap().fills = vec![lin];
        let grad =
            &read_page(&export_sketch(&doc).unwrap())["layers"][0]["style"]["fills"][0]["gradient"];
        let (fx, fy) = point_xy(&grad["from"]);
        let (tx, ty) = point_xy(&grad["to"]);
        assert!((fx - 0.5).abs() < 1e-12 && (fy - 0.).abs() < 1e-12);
        assert!((tx - 0.5).abs() < 1e-12 && (ty - 1.).abs() < 1e-12);
    }

    fn sample_document() -> Document {
        let mut doc = Document {
            reviews: Vec::new(),
            design_system: None,
            prototype: None,
            fd_compatibility: None,
            schema_version: 1,
            color_management: None,
            raster_profile: None,
            id: "d1".into(),
            name: "Interop".into(),
            pages: vec![Page {
                guides: vec![],
                id: "p1".into(),
                name: "Page 1".into(),
                children: vec!["n1".into(), "n2".into()],
                background: "#ffffff".into(),
            }],
            nodes: Default::default(),
            fonts: Default::default(),
            animations: Vec::new(),
        };
        let mut page = crate::facet::sample_node("p1", "page");
        page.children = vec!["n1".into(), "n2".into()];
        let mut frame = crate::facet::sample_node("n1", "frame");
        frame.name = "Board".into();
        frame.width = 320.;
        frame.height = 200.;
        frame.transform = Transform([1., 0., 0., 1., 40., 60.]);
        frame.fills.push({
            let mut p = blank_paint("solid");
            p.color = "#3366cc".into();
            p
        });
        let mut text = crate::facet::sample_node("n2", "text");
        text.name = "Caption".into();
        text.text = "hello sketch".into();
        text.font_size = 18.;
        doc.nodes.insert("p1".into(), page);
        doc.nodes.insert("n1".into(), frame);
        doc.nodes.insert("n2".into(), text);
        doc
    }

    #[test]
    fn sketch_roundtrip_keeps_structure_and_paint() {
        let doc = sample_document();
        let bytes = export_sketch(&doc).unwrap();
        assert!(is_sketch_file(&bytes));
        let back = import_sketch(&bytes).unwrap();
        assert_eq!(back.pages.len(), 1);
        assert_eq!(back.pages[0].name, "Page 1");
        assert_eq!(
            back.pages[0].children,
            vec!["n1".to_string(), "n2".to_string()]
        );
        let frame = back.nodes.get("n1").unwrap();
        assert_eq!(frame.kind, "frame");
        assert_eq!(frame.name, "Board");
        assert_eq!(frame.width, 320.);
        assert_eq!((frame.transform.0[4], frame.transform.0[5]), (40., 60.));
        assert_eq!(frame.fills[0].color, "#3366cc");
        let text = back.nodes.get("n2").unwrap();
        assert_eq!(text.kind, "text");
        assert_eq!(text.text, "hello sketch");
        assert_eq!(text.font_size, 18.);
    }

    #[test]
    fn sketch_exported_container_has_expected_parts() {
        let bytes = export_sketch(&sample_document()).unwrap();
        let files = read_zip(&bytes).unwrap();
        for part in ["meta.json", "document.json", "user.json"] {
            assert!(files.contains_key(part), "missing {part}");
        }
        let page_name = files
            .keys()
            .find(|k| k.starts_with("pages/") && k.ends_with(".json"))
            .expect("one page file")
            .clone();
        let page: Value = serde_json::from_slice(&files[&page_name]).unwrap();
        assert_eq!(page["_class"], "page");
        let layers = page["layers"].as_array().unwrap();
        assert_eq!(layers.len(), 2);
        assert_eq!(layers[0]["_class"], "artboard");
        assert_eq!(layers[0]["frame"]["x"], 40.);
    }

    #[test]
    fn gradient_and_shadow_survive_roundtrip() {
        let mut doc = sample_document();
        let node = doc.nodes.get_mut("n1").unwrap();
        let mut grad = blank_paint("linear");
        grad.stops.push(crate::scene::Stop {
            offset: 0.,
            color: "#ff0000".into(),
        });
        grad.stops.push(crate::scene::Stop {
            offset: 1.,
            color: "#0000ff".into(),
        });
        node.fills.push(grad);
        node.effects.push(Effect {
            id: String::new(),
            kind: "shadow".into(),
            visible: true,
            radius: 12.,
            x: 4.,
            y: 8.,
            spread: 0.,
            color: "#102030".into(),
            opacity: 1.,
            amount: 0.,
            glass: None,
            texture: None,
            gradient_blur: None,
        });
        let back = import_sketch(&export_sketch(&doc).unwrap()).unwrap();
        let node = back.nodes.get("n1").unwrap();
        assert!(
            node.fills
                .iter()
                .any(|p| p.kind == "linear" && p.stops.len() == 2 && p.stops[0].color == "#ff0000")
        );
        assert!(
            node.effects
                .iter()
                .any(|e| e.kind == "shadow" && e.radius == 12. && e.y == 8.)
        );
    }

    #[test]
    fn image_fill_roundtrips_through_content_addressed_blob() {
        // 1x1 transparent PNG
        let png: [u8; 67] = [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let mut doc = sample_document();
        let node = doc.nodes.get_mut("n1").unwrap();
        let mut paint = blank_paint("image");
        paint.image = Some(image_data_uri(&png));
        node.fills.push(paint);
        let bytes = export_sketch(&doc).unwrap();
        let files = read_zip(&bytes).unwrap();
        assert!(
            files.keys().any(|k| k.starts_with("images/")),
            "image blob stored"
        );
        let back = import_sketch(&bytes).unwrap();
        let node = back.nodes.get("n1").unwrap();
        let image_paint = node.fills.iter().find(|p| p.kind == "image").unwrap();
        let (_, decoded) = data_uri_bytes(image_paint.image.as_deref().unwrap()).unwrap();
        assert_eq!(decoded, png.to_vec());
    }

    #[test]
    fn detects_fig_marker() {
        let entries = vec![("canvas.fig".to_string(), b"kiwi-bytes".to_vec())];
        let bytes = write_zip(&entries).unwrap();
        assert!(is_fig_file(&bytes));
        assert!(!is_sketch_file(&bytes));
        assert!(matches!(
            import_fig(&bytes),
            Err(Error::Fig2Sketch(_) | Error::UnsupportedFigPlatform)
        ));
    }

    #[test]
    fn rejects_non_zip() {
        assert!(matches!(import_any(b"plain text"), Err(Error::NotAZip(_))));
    }

    // ------------------------------------------------------------------
    // 21 号 gap-closure round trips
    // ------------------------------------------------------------------

    fn lossy_of(node: &crate::scene::Node) -> Vec<String> {
        node.bindings
            .get("sketchExportLossy")
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default()
    }

    #[test]
    fn curve_handles_round_trip_through_curve_points() {
        // 21 号 P0-1: network c1/c2 handles survive as curveFrom/curveTo.
        let mut doc = sample_document();
        let mut path = crate::facet::sample_node("n3", "path");
        path.name = "Blob".into();
        path.network = Some(crate::scene::Network {
            filled_faces: None,
            vertices: vec![
                crate::scene::Vertex {
                    id: "v0".into(),
                    x: 0.,
                    y: 0.,
                },
                crate::scene::Vertex {
                    id: "v1".into(),
                    x: 1.,
                    y: 0.,
                },
                crate::scene::Vertex {
                    id: "v2".into(),
                    x: 1.,
                    y: 1.,
                },
            ],
            edges: vec![
                crate::scene::Edge {
                    id: "e0".into(),
                    from: "v0".into(),
                    to: "v1".into(),
                    c1: Some(crate::math::Point::new(0.4, -0.1)),
                    c2: Some(crate::math::Point::new(0.8, 0.2)),
                },
                crate::scene::Edge {
                    id: "e1".into(),
                    from: "v1".into(),
                    to: "v2".into(),
                    c1: Some(crate::math::Point::new(1.2, 0.3)),
                    c2: None,
                },
                crate::scene::Edge {
                    id: "e2".into(),
                    from: "v2".into(),
                    to: "v0".into(),
                    c1: None,
                    c2: None,
                },
            ],
            fill_rule: "nonzero".into(),
        });
        doc.pages[0].children.push("n3".into());
        doc.nodes.insert("n3".into(), path);

        let back = import_sketch(&export_sketch(&doc).unwrap()).unwrap();
        let node = back.nodes.get("n3").unwrap();
        let net = node.network.as_ref().expect("network");
        assert_eq!(net.vertices.len(), 3);
        // c1 handles (outgoing) and c2 handles (incoming) preserved per edge
        let c1 = net.edges[0].c1.expect("e0 c1");
        assert!((c1.x - 0.4).abs() < 1e-9 && (c1.y + 0.1).abs() < 1e-9);
        let c2 = net.edges[0].c2.expect("e0 c2");
        assert!((c2.x - 0.8).abs() < 1e-9 && (c2.y - 0.2).abs() < 1e-9);
        assert!(net.edges[1].c1.is_some() && net.edges[1].c2.is_none());
        assert!(net.edges[2].c1.is_none() && net.edges[2].c2.is_none());
        // ring topology round-trips without a lossy note
        assert!(lossy_of(node).is_empty(), "{:?}", lossy_of(node));
    }

    #[test]
    fn non_ring_networks_report_topology_loss() {
        let mut doc = sample_document();
        let mut path = crate::facet::sample_node("n3", "path");
        path.network = Some(crate::scene::Network {
            filled_faces: None,
            vertices: vec![
                crate::scene::Vertex {
                    id: "v0".into(),
                    x: 0.,
                    y: 0.,
                },
                crate::scene::Vertex {
                    id: "v1".into(),
                    x: 1.,
                    y: 1.,
                },
            ],
            edges: vec![crate::scene::Edge {
                id: "e0".into(),
                from: "v0".into(),
                to: "v1".into(),
                c1: Some(crate::math::Point::new(0.5, 0.5)),
                c2: None,
            }],
            fill_rule: "nonzero".into(),
        });
        doc.pages[0].children.push("n3".into());
        doc.nodes.insert("n3".into(), path);
        let back = import_sketch(&export_sketch(&doc).unwrap()).unwrap();
        assert!(
            lossy_of(back.nodes.get("n3").unwrap())
                .iter()
                .any(|n| n.contains("network-topology")),
            "topology degradation must be reported"
        );
    }

    #[test]
    fn curve_modes_map_all_values_and_corner_radii_round_trip() {
        // 22 号字典 §1: every curveMode value maps onto kernel handles, and
        // the exported mode is derived back from the handle geometry.
        let mut doc = sample_document();
        let mut path = crate::facet::sample_node("n3", "path");
        path.name = "Modes".into();
        path.network = Some(crate::scene::Network {
            filled_faces: None,
            vertices: (0..4)
                .map(|i| crate::scene::Vertex {
                    id: format!("v{i}"),
                    x: 0.,
                    y: 0.,
                })
                .collect(),
            edges: (0..4)
                .map(|i| crate::scene::Edge {
                    id: format!("e{i}"),
                    from: format!("v{i}"),
                    to: format!("v{}", (i + 1) % 4),
                    c1: None,
                    c2: None,
                })
                .collect(),
            fill_rule: "nonzero".into(),
        });
        doc.pages[0].children.push("n3".into());
        doc.nodes.insert("n3".into(), path);

        // Patch the exported page into a native-flavored shapePath whose
        // points exercise every curveMode plus a per-point cornerRadius.
        let bytes = export_sketch(&doc).unwrap();
        let mut files = read_zip(&bytes).unwrap();
        let name = files
            .keys()
            .find(|n| n.starts_with("pages/"))
            .unwrap()
            .clone();
        let mut page: Value = serde_json::from_slice(&files[&name]).unwrap();
        page["layers"][2]["points"] = json!([
            // 1 Straight: archived handles must be ignored
            {"_class":"curvePoint","point":"{0, 0}","curveFrom":"{0.3, 0.3}",
             "curveTo":"{-0.3, -0.3}","hasCurveFrom":true,"hasCurveTo":true,
             "curveMode":1,"cornerRadius":2.0},
            // 2 Mirrored with only the incoming side stored: the outgoing
            // handle derives as 2*v − curveTo = {1.2, -0.2}
            {"_class":"curvePoint","point":"{1, 0}","curveFrom":"{1, 0}",
             "curveTo":"{0.8, 0.2}","hasCurveFrom":false,"hasCurveTo":true,
             "curveMode":2,"cornerRadius":0.0},
            // 3 Disconnected: both sides independent
            {"_class":"curvePoint","point":"{1, 1}","curveFrom":"{1.2, 1.1}",
             "curveTo":"{0.9, 0.8}","hasCurveFrom":true,"hasCurveTo":true,
             "curveMode":3,"cornerRadius":0.0},
            // 4 Asymmetric: collinear with the vertex, unequal lengths
            {"_class":"curvePoint","point":"{0, 1}","curveFrom":"{0.2, 1}",
             "curveTo":"{-0.1, 1}","hasCurveFrom":true,"hasCurveTo":true,
             "curveMode":4,"cornerRadius":0.0}
        ]);
        files.insert(name.clone(), serde_json::to_vec(&page).unwrap());
        let encoded = write_zip(&files.into_iter().collect::<Vec<_>>()).unwrap();

        let back = import_sketch(&encoded).unwrap();
        let node = back.nodes.get("n3").unwrap();
        let net = node.network.as_ref().expect("network");
        // Straight point: no handles despite archived values
        assert!(net.edges[0].c1.is_none() && net.edges[3].c2.is_none());
        // Mirrored point: stored incoming handle used, outgoing derived
        let c2 = net.edges[0].c2.expect("incoming handle of v1");
        assert!((c2.x - 0.8).abs() < 1e-9 && (c2.y - 0.2).abs() < 1e-9);
        let c1 = net.edges[1].c1.expect("derived mirror handle of v1");
        assert!((c1.x - 1.2).abs() < 1e-9 && (c1.y + 0.2).abs() < 1e-9);
        // Disconnected point: both sides as read
        let c1 = net.edges[2].c1.expect("outgoing handle of v2");
        assert!((c1.x - 1.2).abs() < 1e-9 && (c1.y - 1.1).abs() < 1e-9);
        let c2 = net.edges[1].c2.expect("incoming handle of v2");
        assert!((c2.x - 0.9).abs() < 1e-9 && (c2.y - 0.8).abs() < 1e-9);
        // Asymmetric point: both sides as read (no collinearity constraint)
        let c1 = net.edges[3].c1.expect("outgoing handle of v3");
        assert!((c1.x - 0.2).abs() < 1e-9 && (c1.y - 1.).abs() < 1e-9);
        let c2 = net.edges[2].c2.expect("incoming handle of v3");
        assert!((c2.x + 0.1).abs() < 1e-9 && (c2.y - 1.).abs() < 1e-9);
        // Per-point corner radii ride bindings with an explicit lossy note
        assert_eq!(
            node.bindings.get("sketchPointCornerRadii").map(String::as_str),
            Some("[2.0,0.0,0.0,0.0]")
        );
        assert!(
            node.bindings
                .get("sketchImportLossy")
                .is_some_and(|s| s.contains("corner-radius")),
            "per-point corner radius degradation must be reported"
        );

        // Re-export: modes derive back from the handle geometry (1/2/3/4) and
        // the archived corner radii return verbatim.
        let re = export_sketch(&back).unwrap();
        let re_files = read_zip(&re).unwrap();
        let re_page: Value = serde_json::from_slice(&re_files[&name]).unwrap();
        let points = re_page["layers"][2]["points"].as_array().unwrap();
        let modes: Vec<i64> = points
            .iter()
            .map(|p| p["curveMode"].as_i64().unwrap())
            .collect();
        assert_eq!(modes, vec![1, 2, 3, 4]);
        assert_eq!(points[0]["cornerRadius"], 2.0);
        assert_eq!(points[1]["hasCurveFrom"], true);
        assert_eq!(points[1]["hasCurveTo"], true);
    }

    #[test]
    fn multi_run_rich_text_round_trips() {
        // 21 号 P0-2: multi-run attributedString with per-run font, color,
        // size and decoration plus paragraph alignment and line height.
        let mut doc = sample_document();
        let text = doc.nodes.get_mut("n2").unwrap();
        text.text = "plainBIGsmall".into();
        text.font_size = 14.;
        text.fills.push({
            let mut p = blank_paint("solid");
            p.color = "#102030".into();
            p
        });
        text.text_style = Some(crate::font::TextStyle {
            align: "center".into(),
            line_height: 1.5,
            letter_spacing: 0.8,
            paragraph_spacing: 3.,
            wrap: true,
            ..Default::default()
        });
        text.text_runs = vec![
            crate::font::TextRun {
            text_case: None,
                start: 5,
                end: 8,
                color: Some("#ff0000".into()),
                underline: true,
                strikethrough: false,
                link: None,
                font_id: Some("Inter-SemiBold".into()),
                font_size: Some(24.),
                weight: Some(600.),
            },
            crate::font::TextRun {
            text_case: None,
                start: 8,
                end: 13,
                color: Some("#00ff00".into()),
                underline: false,
                strikethrough: true,
                link: None,
                font_id: None,
                font_size: Some(10.),
                weight: None,
            },
        ];
        let bytes = export_sketch(&doc).unwrap();
        let files = read_zip(&bytes).unwrap();
        let name = files
            .keys()
            .find(|n| n.starts_with("pages/"))
            .unwrap()
            .clone();
        let page: Value = serde_json::from_slice(&files[&name]).unwrap();
        let attrs = &page["layers"][1]["attributedString"]["attributes"];
        // default segment + two styled segments
        assert_eq!(attrs.as_array().map(Vec::len), Some(3));
        assert_eq!(attrs[0]["location"], 0);
        assert_eq!(attrs[0]["length"], 5);
        assert_eq!(
            attrs[0]["attributes"]["MSAttributedStringFontAttribute"]["attributes"]["name"],
            "HelveticaNeue"
        );
        assert_eq!(attrs[1]["location"], 5);
        assert_eq!(attrs[1]["length"], 3);
        assert_eq!(
            attrs[1]["attributes"]["MSAttributedStringFontAttribute"]["attributes"]["name"],
            "Inter-SemiBold"
        );
        assert_eq!(
            attrs[1]["attributes"]["MSAttributedStringFontAttribute"]["attributes"]["size"],
            24.
        );
        assert_eq!(attrs[1]["attributes"]["underlineStyle"], 1);
        assert_eq!(
            attrs[1]["attributes"]["MSAttributedStringColorAttribute"]["red"],
            1.0
        );
        assert_eq!(attrs[2]["location"], 8);
        assert_eq!(attrs[2]["attributes"]["strikethroughStyle"], 1);
        // paragraph properties ride on every segment
        assert_eq!(
            attrs[0]["attributes"]["textStyleBasicParagraphStyle"]["alignment"],
            2
        );
        let px = attrs[0]["attributes"]["textStyleBasicParagraphStyle"]["minimumLineHeight"]
            .as_f64()
            .unwrap();
        assert!((px - 1.5 * 14.).abs() < 1e-9);
        assert_eq!(
            attrs[0]["attributes"]["textStyleBasicParagraphStyle"]["paragraphSpacing"],
            3.
        );
        assert_eq!(attrs[0]["attributes"]["kerning"], 0.8);

        let back = import_sketch(&bytes).unwrap();
        let text = back.nodes.get("n2").unwrap();
        assert_eq!(text.text, "plainBIGsmall");
        let runs = &text.text_runs;
        assert_eq!(runs.len(), 3);
        assert_eq!((runs[0].start, runs[0].end), (0, 5));
        assert_eq!((runs[1].start, runs[1].end), (5, 8));
        assert_eq!(runs[1].color.as_deref(), Some("#ff0000"));
        assert_eq!(runs[1].font_size, Some(24.));
        assert_eq!(runs[1].font_id.as_deref(), Some("Inter-SemiBold"));
        assert!(runs[1].underline);
        assert_eq!(runs[2].color.as_deref(), Some("#00ff00"));
        assert!(runs[2].strikethrough);
        let style = text.text_style.as_ref().expect("text style");
        assert_eq!(style.align, "center");
        assert!((style.line_height - 1.5).abs() < 1e-9);
        assert!((style.letter_spacing - 0.8).abs() < 1e-9);
        assert!((style.paragraph_spacing - 3.).abs() < 1e-9);
        assert_eq!(text.fills[0].color, "#102030");
    }

    #[test]
    fn rich_text_full_key_set_round_trips() {
        // 22 号字典 §4: the full 8-key run attribute set plus the layer-level
        // textBehaviour / lineSpacingBehaviour. Keys without a kernel slot
        // (vertical alignment, text transform, both behaviours) ride
        // bindings and return verbatim on re-export.
        let bytes = export_sketch(&sample_document()).unwrap();
        let mut files = read_zip(&bytes).unwrap();
        let name = files
            .keys()
            .find(|n| n.starts_with("pages/"))
            .unwrap()
            .clone();
        let mut page: Value = serde_json::from_slice(&files[&name]).unwrap();
        page["layers"][1]["textBehaviour"] = json!(2);
        page["layers"][1]["lineSpacingBehaviour"] = json!(3);
        page["layers"][1]["attributedString"] = json!({
            "_class": "attributedString",
            "string": "Ab",
            "attributes": [
                {"_class": "stringAttribute", "location": 0, "length": 1,
                 "attributes": {
                    "MSAttributedStringFontAttribute": {"_class": "fontDescriptor",
                        "attributes": {"name": "Inter-SemiBold", "size": 20.}},
                    "MSAttributedStringColorAttribute": {"_class": "color",
                        "red": 1., "green": 0., "blue": 0., "alpha": 1.},
                    "kerning": 0.909,
                    "textStyleVerticalAlignmentKey": 1,
                    "MSAttributedStringTextTransformAttribute": 1,
                    "underlineStyle": 1,
                    "strikethroughStyle": 0,
                    "paragraphStyle": {"_class": "paragraphStyle", "alignment": 2,
                        "minimumLineHeight": 30., "maximumLineHeight": 30.,
                        "paragraphSpacing": 6.,
                        "allowsDefaultTighteningForTruncation": false}
                 }},
                {"_class": "stringAttribute", "location": 1, "length": 1,
                 "attributes": {
                    "MSAttributedStringFontAttribute": {"_class": "fontDescriptor",
                        "attributes": {"name": "HelveticaNeue", "size": 12.}},
                    "MSAttributedStringColorAttribute": {"_class": "color",
                        "red": 0., "green": 0., "blue": 1., "alpha": 1.},
                    "strikethroughStyle": 1
                 }}
            ]
        });
        files.insert(name.clone(), serde_json::to_vec(&page).unwrap());
        let encoded = write_zip(&files.into_iter().collect::<Vec<_>>()).unwrap();

        let back = import_sketch(&encoded).unwrap();
        let node = back.nodes.get("n2").unwrap();
        let style = node.text_style.as_ref().expect("text style");
        assert!(style.wrap, "textBehaviour 2 (固定宽高) wraps");
        assert!((style.letter_spacing - 0.909).abs() < 1e-9);
        assert_eq!(style.align, "center");
        assert!((style.line_height - 1.5).abs() < 1e-9);
        assert!((style.paragraph_spacing - 6.).abs() < 1e-9);
        assert_eq!(
            node.bindings.get("sketchTextBehaviour").map(String::as_str),
            Some("2")
        );
        // 3 (自定义) matches what the custom 30px line height re-derives, so
        // no binding is needed for a stable round trip.
        assert!(!node.bindings.contains_key("sketchLineSpacingBehaviour"));
        assert_eq!(
            node.bindings
                .get("sketchTextVerticalAlignment")
                .map(String::as_str),
            Some("1")
        );
        assert_eq!(
            node.bindings
                .get("sketchTextTransform")
                .map(String::as_str),
            Some("1")
        );
        assert_eq!(node.text_runs.len(), 2);
        assert!(node.text_runs[0].underline);
        assert!(node.text_runs[1].strikethrough);
        assert_eq!(node.text_runs[0].color.as_deref(), Some("#ff0000"));

        // Re-export: layer-level keys come from bindings, run-level keys land
        // on every segment, and the custom line height derives behaviour 3.
        let re = export_sketch(&back).unwrap();
        let re_files = read_zip(&re).unwrap();
        let re_page: Value = serde_json::from_slice(&re_files[&name]).unwrap();
        let layer = &re_page["layers"][1];
        assert_eq!(layer["textBehaviour"], 2);
        assert_eq!(layer["lineSpacingBehaviour"], 3);
        let attrs = layer["attributedString"]["attributes"].as_array().unwrap();
        assert_eq!(attrs.len(), 2);
        for run in attrs {
            assert_eq!(run["attributes"]["textStyleVerticalAlignmentKey"], 1);
            assert_eq!(run["attributes"]["MSAttributedStringTextTransformAttribute"], 1);
        }
        assert_eq!(attrs[0]["attributes"]["kerning"], 0.909);
        assert_eq!(attrs[0]["attributes"]["underlineStyle"], 1);
        assert_eq!(attrs[1]["attributes"]["strikethroughStyle"], 1);

        // Official TextBehaviour 0 (Flexible) is the no-wrap case, and a
        // lineSpacingBehaviour that contradicts the derived value
        // (1 = v2 常基线 next to a custom line height) needs its binding.
        let mut files = read_zip(&bytes).unwrap();
        let mut page: Value = serde_json::from_slice(&files[&name]).unwrap();
        page["layers"][1]["textBehaviour"] = json!(0);
        page["layers"][1]["lineSpacingBehaviour"] = json!(1);
        files.insert(name.clone(), serde_json::to_vec(&page).unwrap());
        let encoded = write_zip(&files.into_iter().collect::<Vec<_>>()).unwrap();
        let back = import_sketch(&encoded).unwrap();
        let node = back.nodes.get("n2").unwrap();
        assert!(
            !node.text_style.as_ref().unwrap().wrap,
            "textBehaviour 0 (Flexible) disables wrapping"
        );
        // The unpatched attributedString carries no fixed line height, so 1
        // deviates from the derived 2 and must be kept.
        assert_eq!(
            node.bindings
                .get("sketchLineSpacingBehaviour")
                .map(String::as_str),
            Some("1")
        );
        let re = export_sketch(&back).unwrap();
        let re_files = read_zip(&re).unwrap();
        let re_page: Value = serde_json::from_slice(&re_files[&name]).unwrap();
        assert_eq!(re_page["layers"][1]["textBehaviour"], 0);
        assert_eq!(re_page["layers"][1]["lineSpacingBehaviour"], 1);
    }

    #[test]
    fn layer_blur_round_trips_and_glass_reports_loss() {
        // 21 号 P0-3: blur maps onto the Sketch style blur object; glass has
        // no Sketch equivalent and degrades to a Gaussian blur with a note.
        let mut doc = sample_document();
        let node = doc.nodes.get_mut("n1").unwrap();
        node.effects.push(Effect {
            id: String::new(),
            kind: "blur".into(),
            visible: true,
            radius: 6.,
            ..shadow_like()
        });
        let bytes = export_sketch(&doc).unwrap();
        let back = import_sketch(&bytes).unwrap();
        let node = back.nodes.get("n1").unwrap();
        assert!(
            node.effects
                .iter()
                .any(|e| e.kind == "blur" && (e.radius - 6.).abs() < 1e-9)
        );
        assert!(lossy_of(node).is_empty());

        let mut doc = sample_document();
        let node = doc.nodes.get_mut("n1").unwrap();
        node.effects.push(Effect {
            id: String::new(),
            kind: "glass".into(),
            visible: true,
            radius: 4.,
            glass: Some(crate::scene::GlassParameters {
                bevel_size: None,
                depth: 2.,
                refraction: 1.5,
                dispersion: 0.2,
                light_angle: 45.,
                light_intensity: 0.8,
            }),
            ..shadow_like()
        });
        node.effects.push(Effect {
            id: String::new(),
            kind: "texture".into(),
            visible: true,
            ..shadow_like()
        });
        let back = import_sketch(&export_sketch(&doc).unwrap()).unwrap();
        let node = back.nodes.get("n1").unwrap();
        let notes = lossy_of(node);
        assert!(
            notes.iter().any(|n| n.contains("glass")),
            "glass degradation must be reported: {notes:?}"
        );
        assert!(
            notes.iter().any(|n| n.contains("texture")),
            "texture degradation must be reported: {notes:?}"
        );
        // glass degrades to the nearest Sketch equivalent: a Gaussian blur
        assert!(node.effects.iter().any(|e| e.kind == "blur"));
    }

    fn shadow_like() -> Effect {
        Effect {
            id: String::new(),
            kind: "shadow".into(),
            visible: true,
            radius: 0.,
            x: 0.,
            y: 0.,
            spread: 0.,
            color: "#000000".into(),
            opacity: 1.,
            amount: 0.,
            glass: None,
            texture: None,
            gradient_blur: None,
        }
    }

    #[test]
    fn shadow_alpha_round_trips() {
        let mut doc = sample_document();
        doc.nodes.get_mut("n1").unwrap().effects.push(Effect {
            opacity: 0.45,
            ..shadow_like()
        });
        let back = import_sketch(&export_sketch(&doc).unwrap()).unwrap();
        let shadow = back.nodes["n1"]
            .effects
            .iter()
            .find(|e| e.kind == "shadow")
            .unwrap();
        assert!((shadow.opacity - 0.45).abs() < 1e-9);
    }

    #[test]
    fn symbol_master_and_instance_round_trip() {
        // 21 号 P1-5: component frame → symbolMaster, instance node →
        // symbolInstance with its override tree.
        let mut doc = sample_document();
        let mut master = crate::facet::sample_node("n3", "frame");
        master.name = "Button".into();
        master
            .bindings
            .insert("symbolID".into(), "SYMBOL-UUID-1".into());
        master.component = Some(crate::components::Component {
            variants: [("Size".into(), "M".into())].into_iter().collect(),
            properties: BTreeMap::new(),
        });
        let mut instance = crate::facet::sample_node("n4", "frame");
        instance.name = "Button instance".into();
        instance.instance = Some(crate::components::Instance {
            component_id: "SYMBOL-UUID-1".into(),
            overrides: {
                let mut overrides = crate::components::Overrides::new();
                let mut fields = BTreeMap::new();
                fields.insert("stringValue".into(), json!("Pressed"));
                overrides.insert("ABC-LAYER-1".into(), fields);
                let mut self_fields = BTreeMap::new();
                self_fields.insert("containerID_horizontalSizing".into(), json!(1));
                overrides.insert("self".into(), self_fields);
                overrides
            },
            property_values: [("visible".into(), json!(true))].into_iter().collect(),
        });
        let page = &mut doc.pages[0];
        page.children.push("n3".into());
        page.children.push("n4".into());
        doc.nodes.insert("n3".into(), master);
        doc.nodes.insert("n4".into(), instance);

        let bytes = export_sketch(&doc).unwrap();
        let files = read_zip(&bytes).unwrap();
        let name = files
            .keys()
            .find(|n| n.starts_with("pages/"))
            .unwrap()
            .clone();
        let page: Value = serde_json::from_slice(&files[&name]).unwrap();
        assert_eq!(page["layers"][2]["_class"], "symbolMaster");
        assert_eq!(page["layers"][2]["symbolID"], "SYMBOL-UUID-1");
        assert_eq!(page["layers"][3]["_class"], "symbolInstance");
        assert_eq!(page["layers"][3]["symbolID"], "SYMBOL-UUID-1");
        let values = &page["layers"][3]["overrideValues"];
        assert_eq!(values.as_array().map(Vec::len), Some(2));
        assert_eq!(values[0]["overrideName"], "ABC-LAYER-1/stringValue");
        assert_eq!(values[0]["value"], "Pressed");
        assert_eq!(values[1]["overrideName"], "containerID_horizontalSizing");

        let back = import_sketch(&bytes).unwrap();
        let master = back.nodes.get("n3").unwrap();
        assert_eq!(master.kind, "frame");
        assert_eq!(
            master.bindings.get("symbolID").map(String::as_str),
            Some("SYMBOL-UUID-1")
        );
        assert_eq!(
            master
                .component
                .as_ref()
                .and_then(|c| c.variants.get("Size").map(String::as_str)),
            Some("M"),
            "kernel component payload travels through userInfo"
        );
        let instance = back.nodes.get("n4").unwrap();
        let inst = instance.instance.as_ref().expect("instance");
        assert_eq!(inst.component_id, "SYMBOL-UUID-1");
        let fields = inst.overrides.get("ABC-LAYER-1").expect("override path");
        assert_eq!(fields.get("stringValue"), Some(&json!("Pressed")));
        assert!(inst.overrides.contains_key("self"));
        assert_eq!(
            inst.property_values.get("visible"),
            Some(&json!(true)),
            "instance property values travel through userInfo"
        );
    }

    #[test]
    fn shared_styles_round_trip_with_document_container() {
        // 21 号 P1-6: sharedStyleID ↔ style_refs, document.json containers
        // ↔ design system styles.
        let mut doc = sample_document();
        doc.nodes.get_mut("n1").unwrap().style_refs.insert(
            "sketchSharedStyleID".into(),
            "11112222-3333-4444-5555-666677778888".into(),
        );
        let mut system = crate::design_system::DesignSystem::default();
        system.styles.insert(
            "11112222-3333-4444-5555-666677778888".into(),
            crate::design_system::SharedStyle {
                name: "Brand Fill".into(),
                kind: "paint".into(),
                strokes: Vec::new(),
                effects: Vec::new(),
                value: json!([{
                    "kind": "solid", "color": "#3366cc", "opacity": 1., "visible": true,
                    "id": "", "transform": null, "angle": 0., "stops": [], "image": null,
                    "fit": "cover", "blend": "normal"
                }]),
            },
        );
        system.styles.insert(
            "99998888-7777-6666-5555-444433332222".into(),
            crate::design_system::SharedStyle {
                name: "Body".into(),
                kind: "text".into(),
                strokes: Vec::new(),
                effects: Vec::new(),
                value: json!({"align": "end", "lineHeight": 1.35, "wrap": false}),
            },
        );
        doc.design_system = Some(system);

        let bytes = export_sketch(&doc).unwrap();
        let files = read_zip(&bytes).unwrap();
        let document: Value = serde_json::from_slice(&files["document.json"]).unwrap();
        let paint_objects = &document["layerStyles"]["objects"];
        assert_eq!(paint_objects.as_array().map(Vec::len), Some(1));
        assert_eq!(paint_objects[0]["name"], "Brand Fill");
        assert_eq!(paint_objects[0]["value"]["fills"][0]["color"]["blue"], 0.8);
        let text_objects = &document["layerTextStyles"]["objects"];
        assert_eq!(text_objects.as_array().map(Vec::len), Some(1));
        assert_eq!(text_objects[0]["name"], "Body");

        let back = import_sketch(&bytes).unwrap();
        let node = back.nodes.get("n1").unwrap();
        assert_eq!(
            node.style_refs
                .get("sketchSharedStyleID")
                .map(String::as_str),
            Some("11112222-3333-4444-5555-666677778888")
        );
        let system = back.design_system.as_ref().expect("design system");
        let paint = system
            .styles
            .get("11112222-3333-4444-5555-666677778888")
            .expect("paint style");
        assert_eq!(paint.name, "Brand Fill");
        let paints = paint.value.as_array().unwrap();
        assert_eq!(paints[0]["color"], "#3366cc");
        let text = system
            .styles
            .get("99998888-7777-6666-5555-444433332222")
            .expect("text style");
        assert_eq!(text.name, "Body");
        assert_eq!(text.value["align"], "end");
    }

    #[test]
    fn constraints_round_trip_with_center_reported() {
        // 21 号 P1-7: anchor bits are lossless except Center, which Sketch
        // cannot pin and downgrades to scale with a note.
        let mut doc = sample_document();
        let mut child = crate::facet::sample_node("n3", "rect");
        child.constraints = Some(crate::layout::Constraints {
            horizontal: crate::layout::Anchor::End,
            vertical: crate::layout::Anchor::Stretch,
            reference_width: None,
            reference_height: None,
        });
        doc.pages[0].children.push("n3".into());
        doc.nodes.insert("n3".into(), child);
        let back = import_sketch(&export_sketch(&doc).unwrap()).unwrap();
        let constraints = back.nodes["n3"].constraints.as_ref().unwrap();
        assert_eq!(constraints.horizontal, crate::layout::Anchor::End);
        assert_eq!(constraints.vertical, crate::layout::Anchor::Stretch);
        assert!(lossy_of(back.nodes.get("n3").unwrap()).is_empty());

        let mut doc = sample_document();
        let mut child = crate::facet::sample_node("n3", "rect");
        child.constraints = Some(crate::layout::Constraints {
            horizontal: crate::layout::Anchor::Center,
            vertical: crate::layout::Anchor::Scale,
            reference_width: None,
            reference_height: None,
        });
        doc.pages[0].children.push("n3".into());
        doc.nodes.insert("n3".into(), child);
        let back = import_sketch(&export_sketch(&doc).unwrap()).unwrap();
        let node = back.nodes.get("n3").unwrap();
        let constraints = node.constraints.as_ref().unwrap();
        assert_eq!(constraints.horizontal, crate::layout::Anchor::Scale);
        assert!(
            lossy_of(node)
                .iter()
                .any(|n| n.contains("constraint-center")),
            "{:?}",
            lossy_of(node)
        );
    }

    #[test]
    fn default_resizing_constraint_does_not_become_a_rule() {
        // 63 is Sketch's default "free" mask; it must not import as a
        // constraint (1,860 occurrences in the measured corpus).
        let doc = sample_document();
        let bytes = export_sketch(&doc).unwrap();
        let back = import_sketch(&bytes).unwrap();
        for node in back.nodes.values() {
            assert!(
                node.constraints.is_none(),
                "node {} must stay constraint-free",
                node.id
            );
        }
    }

    #[test]
    fn flex_stack_layout_round_trips() {
        // 21 号 P1-8: FlexGroupLayout + four-way padding.
        let mut doc = sample_document();
        let frame = doc.nodes.get_mut("n1").unwrap();
        frame.layout = Some(crate::layout::Layout {
            mode: crate::layout::Flow::Vertical,
            gap: 12.,
            line_gap: 0.,
            padding: [8., 4., 6., 2.],
            wrap: false,
            justify: crate::layout::Align::SpaceBetween,
            align: crate::layout::Align::Center,
            columns: 0,
            fill_rows: false,
        });
        let bytes = export_sketch(&doc).unwrap();
        let files = read_zip(&bytes).unwrap();
        let name = files
            .keys()
            .find(|n| n.starts_with("pages/"))
            .unwrap()
            .clone();
        let page: Value = serde_json::from_slice(&files[&name]).unwrap();
        let gl = &page["layers"][0]["groupLayout"];
        assert_eq!(gl["_class"], "MSImmutableFlexGroupLayout");
        assert_eq!(gl["flexDirection"], 1);
        assert_eq!(gl["justifyContent"], 3);
        assert_eq!(gl["alignItems"], 1);
        assert_eq!(gl["allGuttersGap"], 12.);
        assert_eq!(page["layers"][0]["topPadding"], 8.);
        assert_eq!(page["layers"][0]["rightPadding"], 4.);
        assert_eq!(page["layers"][0]["bottomPadding"], 6.);
        assert_eq!(page["layers"][0]["leftPadding"], 2.);
        assert_eq!(page["layers"][0]["paddingSelection"], 2);

        let back = import_sketch(&bytes).unwrap();
        let layout = back.nodes["n1"].layout.as_ref().expect("layout");
        assert_eq!(layout.mode, crate::layout::Flow::Vertical);
        assert!((layout.gap - 12.).abs() < 1e-9);
        assert_eq!(layout.padding, [8., 4., 6., 2.]);
        assert_eq!(layout.justify, crate::layout::Align::SpaceBetween);
        assert_eq!(layout.align, crate::layout::Align::Center);
        assert!(back.nodes["n1"].sizing.is_none());
        assert!(lossy_of(back.nodes.get("n1").unwrap()).is_empty());
    }

    #[test]
    fn boolean_operation_group_round_trips() {
        // 21 号 P1-9: shapeGroup booleanOperation ↔ boolean_operation.
        let mut doc = sample_document();
        let mut op = crate::facet::sample_node("n3", "group");
        op.name = "Subtracted".into();
        op.boolean_operation = Some(crate::boolean::Operation::Subtract);
        doc.pages[0].children.push("n3".into());
        doc.nodes.insert("n3".into(), op);
        let bytes = export_sketch(&doc).unwrap();
        let files = read_zip(&bytes).unwrap();
        let name = files
            .keys()
            .find(|n| n.starts_with("pages/"))
            .unwrap()
            .clone();
        let page: Value = serde_json::from_slice(&files[&name]).unwrap();
        assert_eq!(page["layers"][2]["_class"], "shapeGroup");
        assert_eq!(page["layers"][2]["booleanOperation"], 1);

        let back = import_sketch(&bytes).unwrap();
        assert_eq!(
            back.nodes["n3"].boolean_operation,
            Some(crate::boolean::Operation::Subtract)
        );
    }

    #[test]
    fn document_color_space_round_trips() {
        // 21 号 P0-4: P3 documents map onto colorSpace 2.
        let mut doc = sample_document();
        doc.color_management = Some(crate::color::ColorSettings {
            document_space: crate::color::ColorSpace::DisplayP3,
            ..Default::default()
        });
        let bytes = export_sketch(&doc).unwrap();
        let files = read_zip(&bytes).unwrap();
        let document: Value = serde_json::from_slice(&files["document.json"]).unwrap();
        assert_eq!(document["colorSpace"], 2);
        let back = import_sketch(&bytes).unwrap();
        assert_eq!(
            back.color_management.as_ref().map(|c| c.document_space),
            Some(crate::color::ColorSpace::DisplayP3)
        );

        // and the default document stays unmanaged
        let back = import_sketch(&export_sketch(&sample_document()).unwrap()).unwrap();
        assert!(back.color_management.is_none());
    }

    #[test]
    fn diamond_gradient_downgrade_is_reported() {
        let mut doc = sample_document();
        let mut diamond = blank_paint("diamond");
        diamond.stops = vec![
            crate::scene::Stop {
                offset: 0.,
                color: "#000000".into(),
            },
            crate::scene::Stop {
                offset: 1.,
                color: "#ffffff".into(),
            },
        ];
        doc.nodes.get_mut("n1").unwrap().fills = vec![diamond];
        let back = import_sketch(&export_sketch(&doc).unwrap()).unwrap();
        let node = back.nodes.get("n1").unwrap();
        assert!(
            node.fills.iter().any(|p| p.kind == "radial"),
            "diamond degrades to the nearest Sketch gradient"
        );
        assert!(
            lossy_of(node).iter().any(|n| n.contains("diamond")),
            "{:?}",
            lossy_of(node)
        );
    }

    // ------------------------------------------------------------------
    // layout grids (21 号 P1-10) / full layer styles / prototype flows
    // ------------------------------------------------------------------

    #[test]
    fn layout_grid_round_trips_through_native_dicts() {
        // Column grid: axis/count/gutter/margin travel natively, the kernel
        // color/opacity ride userInfo (Sketch keeps grid appearance in app
        // preferences, 22 号字典 §7).
        let mut doc = sample_document();
        doc.schema_version = 12;
        let frame = doc.nodes.get_mut("n1").unwrap();
        frame.width = 320.;
        frame.layout_grid = Some(crate::scene::LayoutGrid {
            axis: "column".into(),
            count: 8,
            gutter: 16.,
            margin: 24.,
            color: "#00a0ff".into(),
            visible: true,
            opacity: 0.3,
        });
        let bytes = export_sketch(&doc).unwrap();
        let files = read_zip(&bytes).unwrap();
        let name = files
            .keys()
            .find(|n| n.starts_with("pages/"))
            .unwrap()
            .clone();
        let page: Value = serde_json::from_slice(&files[&name]).unwrap();
        let layout = &page["layers"][0]["layout"];
        assert_eq!(layout["_class"], "layoutGrid");
        assert_eq!(layout["numberOfColumns"], 8);
        assert_eq!(layout["gutterWidth"], 16.);
        assert_eq!(layout["horizontalOffset"], 24.);
        assert_eq!(layout["drawVertical"], true);
        // derived column width: (320 - 2*24 - 7*16) / 8 = 20
        assert_eq!(layout["columnWidth"], 20.);

        let back = import_sketch(&bytes).unwrap();
        assert_eq!(back.schema_version, 12);
        let grid = back.nodes["n1"].layout_grid.as_ref().expect("grid");
        assert_eq!(grid.axis, "column");
        assert_eq!(grid.count, 8);
        assert!((grid.gutter - 16.).abs() < 1e-9);
        assert!((grid.margin - 24.).abs() < 1e-9);
        // kernel-only appearance survived through userInfo
        assert_eq!(grid.color, "#00a0ff");
        assert!((grid.opacity - 0.3).abs() < 1e-9);
        assert!(
            lossy_of(back.nodes.get("n1").unwrap())
                .iter()
                .any(|n| n.contains("layout-grid-color")),
            "color downgrade must be reported"
        );

        // Uniform grid maps onto the simpleGrid square dict; the centered
        // remainder is reported when the frame is not a whole multiple.
        let mut doc = sample_document();
        doc.schema_version = 12;
        let frame = doc.nodes.get_mut("n1").unwrap();
        frame.width = 320.;
        frame.layout_grid = Some(crate::scene::LayoutGrid {
            axis: "uniform".into(),
            count: 8,
            gutter: 0.,
            margin: 0.,
            color: "#ff0000".into(),
            visible: false,
            opacity: 0.1,
        });
        let bytes = export_sketch(&doc).unwrap();
        let files = read_zip(&bytes).unwrap();
        let name = files
            .keys()
            .find(|n| n.starts_with("pages/"))
            .unwrap()
            .clone();
        let page: Value = serde_json::from_slice(&files[&name]).unwrap();
        let grid = &page["layers"][0]["grid"];
        assert_eq!(grid["_class"], "simpleGrid");
        assert_eq!(grid["gridSize"], 40.);
        assert_eq!(grid["isEnabled"], false);
        let back = import_sketch(&bytes).unwrap();
        let grid = back.nodes["n1"].layout_grid.as_ref().expect("grid");
        assert_eq!(grid.axis, "uniform");
        assert_eq!(grid.count, 8);
        assert!((grid.margin - 0.).abs() < 1e-9);
        assert!(!grid.visible);
    }

    #[test]
    fn shared_style_borders_and_shadows_round_trip() {
        // Full layer style: fills + borders (width/position/dash/cap/join)
        // + shadows survive the document.json container.
        let mut doc = sample_document();
        doc.schema_version = 12;
        let mut system = crate::design_system::DesignSystem::default();
        let border: crate::scene::Stroke = serde_json::from_value(json!({
            "id": "", "paint": {"id": "", "kind": "solid", "color": "#112233"},
            "width": 2.5, "align": "inside", "cap": "round", "join": "bevel", "dash": "4,2"
        }))
        .unwrap();
        let shadow = Effect {
            radius: 10.,
            x: 3.,
            y: -4.,
            spread: 2.,
            color: "#001020".into(),
            opacity: 0.6,
            ..shadow_like()
        };
        let inner = Effect {
            kind: "inner-shadow".into(),
            radius: 5.,
            ..shadow_like()
        };
        system.styles.insert(
            "aaaa1111-2222-3333-4444-555566667777".into(),
            crate::design_system::SharedStyle {
                name: "Card Style".into(),
                kind: "paint".into(),
                strokes: vec![border],
                effects: vec![shadow.clone(), inner.clone()],
                value: json!([{
                    "kind": "solid", "color": "#fafafa", "opacity": 1., "visible": true,
                    "id": "", "transform": null, "angle": 0., "stops": [], "image": null,
                    "fit": "cover", "blend": "normal"
                }]),
            },
        );
        doc.design_system = Some(system);
        // sample_document keeps a page node in `nodes` (like all sketch
        // imports), which full scene validation rejects as unreachable;
        // exercise the design-system rules directly.
        crate::design_system::validate(&doc).unwrap();

        let bytes = export_sketch(&doc).unwrap();
        let files = read_zip(&bytes).unwrap();
        let document: Value = serde_json::from_slice(&files["document.json"]).unwrap();
        let style = &document["layerStyles"]["objects"][0]["value"];
        let border_json = &style["borders"][0];
        assert_eq!(border_json["thickness"], 2.5);
        assert_eq!(border_json["position"], 1);
        assert_eq!(style["borderOptions"]["dashPattern"], json!([4., 2.]));
        assert_eq!(style["borderOptions"]["lineCapStyle"], 1);
        assert_eq!(style["borderOptions"]["lineJoinStyle"], 2);
        assert_eq!(style["shadows"][0]["blurRadius"], 10.);
        assert_eq!(style["shadows"][0]["offsetY"], -4.);
        assert_eq!(style["shadows"][0]["color"]["alpha"], 0.6);
        assert_eq!(style["innerShadows"][0]["blurRadius"], 5.);

        // Canonical admission separates provenance/loss diagnostics from
        // executable variable bindings before design-system validation.
        let back = import_sketch_report(&bytes).unwrap().document;
        assert_eq!(back.schema_version, 12);
        let shared = back
            .design_system
            .as_ref()
            .unwrap()
            .styles
            .get("aaaa1111-2222-3333-4444-555566667777")
            .unwrap();
        assert_eq!(shared.strokes.len(), 1);
        let stroke = &shared.strokes[0];
        assert!((stroke.width - 2.5).abs() < 1e-9);
        assert_eq!(stroke.align, "inside");
        assert_eq!(stroke.dash, "4,2");
        assert_eq!(stroke.cap, "round");
        assert_eq!(stroke.join, "bevel");
        assert_eq!(stroke.paint.color, "#112233");
        assert_eq!(shared.effects.len(), 2);
        let shadow = shared.effects.iter().find(|e| e.kind == "shadow").unwrap();
        assert!((shadow.radius - 10.).abs() < 1e-9);
        assert!((shadow.y + 4.).abs() < 1e-9);
        assert!((shadow.spread - 2.).abs() < 1e-9);
        assert!((shadow.opacity - 0.6).abs() < 1e-6);
        assert!(shared.effects.iter().any(|e| e.kind == "inner-shadow"));
        crate::design_system::validate(&back).unwrap();
    }

    #[test]
    fn prototype_flows_round_trip_natively_and_via_userinfo() {
        // A single click navigate maps onto the native flow connection;
        // easing curves and overlay positions have no documented archived
        // fields and ride userInfo instead.
        let mut doc = sample_document();
        doc.schema_version = 12;
        doc.prototype = Some(crate::prototype::Prototype {
            start_node: Some("n1".into()),
            interactions: [(
                "n2".to_string(),
                vec![crate::prototype::Interaction {
                    trigger: "click".into(),
                    actions: vec![crate::prototype::Action {
                        kind: "navigate".into(),
                        target: Some("n1".into()),
                        value: None,
                        duration_ms: 300,
                        easing_curve: Some("ease-in-out".into()),
                        overlay_position: None,
                        ..Default::default()
                    }],
                    delay_ms: 0,
                    condition: None,
                }],
            )]
            .into_iter()
            .collect(),
        });
        let bytes = export_sketch(&doc).unwrap();
        let files = read_zip(&bytes).unwrap();
        let name = files
            .keys()
            .find(|n| n.starts_with("pages/"))
            .unwrap()
            .clone();
        let page: Value = serde_json::from_slice(&files[&name]).unwrap();
        let text_layer = &page["layers"][1];
        assert_eq!(text_layer["flow"]["_class"], "MSImmutableFlowConnection");
        assert_eq!(text_layer["flow"]["destinationArtboardID"], sketch_id("n1"));
        assert_eq!(text_layer["flow"]["transition"]["duration"], 0.3);
        assert_eq!(page["layers"][0]["isFlowHome"], true);

        let back = import_sketch(&bytes).unwrap();
        let prototype = back.prototype.as_ref().expect("prototype");
        assert_eq!(prototype.start_node.as_deref(), Some("n1"));
        let events = prototype.interactions.get("n2").expect("interaction");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].trigger, "click");
        assert_eq!(events[0].actions[0].target.as_deref(), Some("n1"));
        assert_eq!(events[0].actions[0].duration_ms, 300);
        assert_eq!(
            events[0].actions[0].easing_curve.as_deref(),
            Some("ease-in-out"),
            "kernel-native curve travels through userInfo"
        );
        assert!(
            lossy_of(back.nodes.get("n2").unwrap())
                .iter()
                .any(|n| n.contains("easing-curve")),
            "easing downgrade must be reported"
        );

        // Foreign native flow (overlay flavor) imports as an overlay action
        // and reports the unmapped overlaySettings position fields.
        let mut files = read_zip(&export_sketch(&sample_document()).unwrap()).unwrap();
        let name = files
            .keys()
            .find(|n| n.starts_with("pages/"))
            .unwrap()
            .clone();
        let mut page: Value = serde_json::from_slice(&files[&name]).unwrap();
        page["layers"][1]["flow"] = json!({
            "_class": "MSImmutableFlowConnection",
            "destinationArtboardID": sketch_id("n1"),
            "overlaySettings": {"_class": "MSImmutableFlowOverlaySettings"},
            "transition": {"_class": "MSTransition", "duration": 0.45},
            "maintainScrollPosition": true
        });
        files.insert(name.clone(), serde_json::to_vec(&page).unwrap());
        let encoded = write_zip(&files.into_iter().collect::<Vec<_>>()).unwrap();
        let back = import_sketch(&encoded).unwrap();
        let events = back
            .prototype
            .as_ref()
            .unwrap()
            .interactions
            .get("n2")
            .unwrap();
        assert_eq!(events[0].actions[0].kind, "overlay");
        assert_eq!(events[0].actions[0].duration_ms, 450);
        let note = back.nodes["n2"]
            .bindings
            .get("sketchFlowUntranslated")
            .expect("unmapped flow fields reported");
        assert!(note.contains("overlaySettings"), "{note}");
        assert!(note.contains("maintainScrollPosition"), "{note}");
    }
}
