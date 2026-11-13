//! Interop with foreign design formats: Sketch `.sketch` (import + export)
//! and Figma `.fig` (import via the bundled `fig2sketch` converter).
//!
//! The `.sketch` mapping follows the documented container and JSON schema:
//! a zip holding `meta.json`, `document.json`, `user.json`, one
//! `pages/<uuid>.json` per page and `images/<sha1>` blobs; layer trees
//! keyed by `_class`; styles as fill / border / shadow part arrays.
//! Unsupported fields are retained selectively and reported; executable
//! semantics and source preservation remain separate contracts.
use crate::color::{ColorSettings, ColorSpace};
use crate::math::Transform;
use crate::scene::{Document, Effect, ExportSetting, Node, Page, Paint, Stroke};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
mod boolean_worksets;
#[cfg(not(target_arch="wasm32"))]
mod source_size;

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

fn archive_limits() -> ArchiveLimits {
    ArchiveLimits {
        input: crate::sketch::archive::max_input_bytes(),
        entries: crate::sketch::archive::MAX_ENTRIES,
        entry: crate::sketch::archive::max_entry_bytes(),
        document_entry: crate::sketch::archive::max_document_bytes(),
        total: crate::sketch::archive::max_total_bytes(),
    }
}

fn archive_limit(message: &str) -> Error {
    Error::Unsupported(format!("archive resource limit: {message}"))
}

fn read_zip(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>> {
    read_zip_bounded(bytes, archive_limits())
}

fn read_zip_bounded(bytes: &[u8], limits: ArchiveLimits) -> Result<BTreeMap<String, Vec<u8>>> {
    read_zip_bounded_filtered(bytes, limits, None)
}

/// `only` expands just those members. Every other member stays compressed and
/// does not spend the expanded-byte budget. A requested member still uses the
/// same per-entry and total ceilings; exceeding one is an error, not a skip.
fn read_zip_bounded_filtered(
    bytes: &[u8],
    limits: ArchiveLimits,
    only: Option<&BTreeSet<String>>,
) -> Result<BTreeMap<String, Vec<u8>>> {
    if bytes.len() > limits.input {
        return Err(archive_limit("input bytes"));
    }
    // Preflight the original directory before ZipArchive allocates its index.
    // ZIP32's end record has a bounded comment. Compute the physical directory
    // start from its size so ordinary prepended/self-extracting data still works.
    let end = (bytes.len().saturating_sub(22 + u16::MAX as usize)..bytes.len().saturating_sub(21))
        .rev()
        .find(|&at| {
            bytes.get(at..at + 4) == Some(b"PK\x05\x06")
                && at + 22 + u16::from_le_bytes([bytes[at + 20], bytes[at + 21]]) as usize
                    == bytes.len()
        })
        .ok_or_else(|| Error::NotAZip("missing ZIP32 end record".into()))?;
    let directory_size = u32::from_le_bytes(bytes[end + 12..end + 16].try_into().unwrap()) as usize;
    let directory_start = end
        .checked_sub(directory_size)
        .ok_or_else(|| Error::NotAZip("invalid central directory size".into()))?;
    let mut at = directory_start;
    // zip 2.x deduplicates central-directory names. Count original records so
    // ambiguous duplicates cannot silently overwrite each other. As in the
    // strict Sketch adapter, accept ZIP32 only; never extract to the filesystem.
    let mut records = 0;
    while bytes.get(at..at.saturating_add(4)) == Some(b"PK\x01\x02") {
        let header = bytes
            .get(at..at.saturating_add(46))
            .ok_or_else(|| Error::NotAZip("truncated central directory".into()))?;
        let length = |offset| u16::from_le_bytes([header[offset], header[offset + 1]]) as usize;
        at = at
            .checked_add(46 + length(28) + length(30) + length(32))
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| Error::NotAZip("truncated central entry".into()))?;
        records += 1;
        if records > limits.entries {
            return Err(archive_limit("entry count"));
        }
    }
    if at != end || bytes.get(at..at.saturating_add(4)) != Some(b"PK\x05\x06") {
        return Err(Error::Unsupported(
            "non-ZIP32 or unsupported central directory trailer".into(),
        ));
    }
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| Error::NotAZip(e.to_string()))?;
    if archive.central_directory_start() != directory_start as u64 {
        return Err(Error::NotAZip(
            "inconsistent central directory offset".into(),
        ));
    }
    if records != archive.len() {
        return Err(Error::NotAZip(
            "duplicate central directory identity".into(),
        ));
    }
    let mut out = BTreeMap::new();
    let mut names = std::collections::BTreeSet::new();
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| Error::Io(e.to_string()))?;
        let name = file
            .name()
            .map_err(|e| Error::Io(e.to_string()))?
            .into_owned();
        let path = name.strip_suffix('/').unwrap_or(&name);
        if !crate::sketch::archive::safe_path(path) || !names.insert(path.to_owned()) {
            return Err(Error::NotAZip(format!(
                "unsafe/duplicate archive path: {name}"
            )));
        }
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(Error::NotAZip("archive symlink".into()));
        }
        if file.is_dir() {
            continue;
        }
        if only.is_some_and(|wanted| !wanted.contains(&name) && !wanted.contains(path)) {
            continue;
        }
        let declared = file.size();
        let remaining = limits.total.saturating_sub(total);
        let entry_limit = if name == "document.json" {
            limits.document_entry
        } else {
            limits.entry
        };
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
        file.by_ref()
            .take(allowed.saturating_add(1))
            .read_to_end(&mut data)
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

struct ZipMember {
    name: String,
    size: u64,
}

/// Names and declared sizes only. The same directory checks run, and no member
/// body is expanded.
fn sketch_zip_members(bytes: &[u8], limits: ArchiveLimits) -> Result<Vec<ZipMember>> {
    if bytes.len() > limits.input {
        return Err(archive_limit("input bytes"));
    }
    let end = (bytes.len().saturating_sub(22 + u16::MAX as usize)..bytes.len().saturating_sub(21))
        .rev()
        .find(|&at| {
            bytes.get(at..at + 4) == Some(b"PK\x05\x06")
                && at + 22 + u16::from_le_bytes([bytes[at + 20], bytes[at + 21]]) as usize
                    == bytes.len()
        })
        .ok_or_else(|| Error::NotAZip("missing ZIP32 end record".into()))?;
    let directory_size = u32::from_le_bytes(bytes[end + 12..end + 16].try_into().unwrap()) as usize;
    let directory_start = end
        .checked_sub(directory_size)
        .ok_or_else(|| Error::NotAZip("invalid central directory size".into()))?;
    let mut at = directory_start;
    let mut records = 0;
    while bytes.get(at..at.saturating_add(4)) == Some(b"PK\x01\x02") {
        let header = bytes
            .get(at..at.saturating_add(46))
            .ok_or_else(|| Error::NotAZip("truncated central directory".into()))?;
        let length = |offset| u16::from_le_bytes([header[offset], header[offset + 1]]) as usize;
        at = at
            .checked_add(46 + length(28) + length(30) + length(32))
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| Error::NotAZip("truncated central entry".into()))?;
        records += 1;
        if records > limits.entries {
            return Err(archive_limit("entry count"));
        }
    }
    if at != end || bytes.get(at..at.saturating_add(4)) != Some(b"PK\x05\x06") {
        return Err(Error::Unsupported(
            "non-ZIP32 or unsupported central directory trailer".into(),
        ));
    }
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| Error::NotAZip(e.to_string()))?;
    if archive.central_directory_start() != directory_start as u64 {
        return Err(Error::NotAZip("inconsistent central directory offset".into()));
    }
    if records != archive.len() {
        return Err(Error::NotAZip("duplicate central directory identity".into()));
    }
    let mut members = Vec::new();
    let mut names = BTreeSet::new();
    for i in 0..archive.len() {
        let file = archive.by_index(i).map_err(|e| Error::Io(e.to_string()))?;
        let name = file.name().map_err(|e| Error::Io(e.to_string()))?.into_owned();
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
        members.push(ZipMember { name, size: file.size() });
    }
    Ok(members)
}

fn write_zip(entries: &[(String, Vec<u8>)]) -> Result<Vec<u8>> {
    // The writer obeys the same per-entry/total expanded budgets the reader
    // enforces, so an oversized payload fails loudly at export instead of
    // producing an archive this codec (and the strict Sketch adapter) would
    // refuse to reopen.
    let limits = archive_limits();
    if entries.len() > limits.entries {
        return Err(archive_limit("entry count"));
    }
    let mut total = 0u64;
    for (name, data) in entries {
        let limit = if name == "document.json" {
            limits.document_entry
        } else {
            limits.entry
        };
        if data.len() as u64 > limit {
            return Err(archive_limit("entry expanded bytes"));
        }
        total = total.saturating_add(data.len() as u64);
        if total > limits.total {
            return Err(archive_limit("total expanded bytes"));
        }
    }
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
    // Sniff once so a zip-shaped bundle that fails archive admission keeps its
    // resource-limit diagnostic instead of falling through to the generic
    // "markers not found" message that hides the real rejection reason.
    let sniffed = read_zip(bytes);
    let sketch = matches!(&sniffed, Ok(files)
        if files.contains_key("meta.json") && files.contains_key("document.json"));
    let fig = matches!(&sniffed, Ok(files) if files.contains_key("canvas.fig"));
    if sketch {
        return import_sketch(bytes);
    }
    if fig {
        return import_fig(bytes);
    }
    if let Err(Error::Unsupported(limit)) = &sniffed {
        return Err(Error::Unsupported(limit.clone()));
    }
    if crate::pdf_import::is_pdf_file(bytes) {
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

/// Native Sketch detach oracle (100→200): bit 4 flexes leading margin,
/// bit 2 flexes size, bit 1 flexes trailing margin. Mixed-flex cases require
/// the native resize solver and are reported rather than called exact mappings.
fn constraint_anchor(bits: u64) -> crate::layout::Anchor {
    match bits {
        1 => crate::layout::Anchor::Start,
        2 => crate::layout::Anchor::Stretch,
        4 => crate::layout::Anchor::End,
        _ => crate::layout::Anchor::Scale,
    }
}

fn bool_at(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// Archived borderOptions marker code → kernel stroke marker. The enum is
/// the Sketch 74–93 / fig2sketch archive set (fig2sketch `MarkerType`, 8
/// values): 0=None, 1=FilledArrow, 2=Line, 3=OpenCircle, 4=FilledCircle,
/// 5=OpenSquare, 6=FilledSquare, 7=OpenArrow. The 2025 public schema
/// re-numbers 0=OpenArrow and drops None — imported against the archive
/// set the real corpus uses; approximations are reported, never silent.
fn marker_of(code: i64, lossy: &mut Vec<String>) -> crate::stroke::Marker {
    use crate::stroke::Marker;
    match code {
        0 => Marker::None,
        // FilledArrow's filled head renders closest to the equilateral
        // kernel triangle marker.
        1 => Marker::Triangle,
        // Sketch "Line" is a perpendicular tick across the endpoint — the
        // kernel Bar marker.
        2 => Marker::Bar,
        3 => {
            note_lossy(lossy, "marker-open-circle->filled-circle");
            Marker::Circle
        }
        4 => Marker::Circle,
        5 => {
            note_lossy(lossy, "marker-open-square->filled-square");
            Marker::Square
        }
        6 => Marker::Square,
        7 => Marker::Arrow,
        other => {
            note_lossy(lossy, &format!("marker-type-{other}-unsupported"));
            Marker::None
        }
    }
}

/// Kernel stroke marker → archived borderOptions code (inverse of
/// `marker_of`; markers without a Sketch home are noted, never dropped
/// silently into a different shape).
fn marker_code(marker: crate::stroke::Marker, lossy: &mut Vec<String>) -> i64 {
    use crate::stroke::Marker;
    match marker {
        Marker::None => 0,
        Marker::Arrow => 7,
        Marker::Triangle => 1,
        Marker::Circle => 4,
        Marker::Square => 6,
        Marker::Bar => 2,
        Marker::Diamond => {
            note_lossy(lossy, "marker-diamond-not-expressible");
            0
        }
    }
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
    format!(
        "color({} {} {} {} / {})",
        if space == ColorSpace::DisplayP3 {
            "display-p3"
        } else {
            "srgb"
        },
        f64_at(resolved, "red").clamp(0., 1.),
        f64_at(resolved, "green").clamp(0., 1.),
        f64_at(resolved, "blue").clamp(0., 1.),
        color_alpha(color)
    )
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
        || (color.get("lightColor").is_some_and(Value::is_object)
            && color.get("darkColor").is_some_and(Value::is_object))
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
fn adaptable_slot_in_layer<'a>(
    layer: &'a mut Map<String, Value>,
    slot: &str,
) -> Option<&'a mut Value> {
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

fn adaptable_model(node: &Node, slot: &str) -> Option<Value> {
    let mut parts = slot.split('.');
    let kind = parts.next()?;
    if kind == "background" { return Some(json!(node.fills.first()?)); }
    let i: usize = parts.next()?.parse().ok()?;
    Some(match kind {
        "fill" => json!(node.fills.get(i)?),
        "border" => json!(node.strokes.get(i)?),
        "shadow" | "innerShadow" => json!(node.effects.iter().filter(|e| e.kind == if kind == "shadow" { "shadow" } else { "inner-shadow" }).nth(i)?),
        // Font resolution happens after initial import. Color restoration depends
        // on the authored range and color, not the resolved local font identity.
        "run" => { let r = node.text_runs.get(i)?; json!([r.start,r.end,r.color]) },
        _ => return None,
    })
}

fn adaptable_capture(node: &mut Node) {
    let entries: Vec<_> = node.bindings.keys().filter_map(|key| {
        let slot = key.strip_prefix("sketchAdaptableColor.")?;
        Some((format!("sketchColorModel.{slot}"), adaptable_model(node, slot)?.to_string()))
    }).collect();
    node.bindings.extend(entries);
}

fn adaptable_unchanged(node: &Node, slot: &str) -> bool {
    node.bindings.get(&format!("sketchColorModel.{slot}"))
        .and_then(|v| serde_json::from_str::<Value>(v).ok())
        .zip(adaptable_model(node, slot)).is_some_and(|(a,b)| a == b)
}

/// Export side of P0-4: splice preserved color payloads back into the layer
/// dict and restore `updatableColors` on the layer and its style. Stale
/// slots (document edited after import) are skipped rather than blocking
/// the export.
fn adaptable_apply_layer(layer: &mut Map<String, Value>, node: &Node) {
    let bindings = &node.bindings;
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
                    if adaptable_unchanged(node, slot)
                        && let Ok(value) = serde_json::from_str::<Value>(raw)
                    {
                        if let Some(target)=adaptable_slot_in_layer(layer, slot) { *target = value; }
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
        "linear-burn" => 16,
        "linear-dodge" => 17,
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
        16 => "linear-burn",
        17 => "linear-dodge",
        _ => "normal",
    }
    .into()
}

fn blend_of(style: &Value) -> (f64, String) {
    let ctx = style.get("contextSettings").unwrap_or(&Value::Null);
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

fn solid_paint(color: &Value, base_opacity: f64, blend: &str, space: ColorSpace) -> Paint {
    let mut paint = blank_paint("solid");
    paint.color = gradient_stop_color(color, space);
    paint.opacity = base_opacity;
    paint.blend = blend.into();
    paint
}

fn sketch_blurs(style: &Value) -> Vec<&Value> {
    if let Some(blurs) = style.get("blurs").and_then(Value::as_array) { blurs.iter().collect() }
    else { style.get("blur").into_iter().collect() }
}
fn sketch_blur_enabled(blur: &Value) -> bool {
    // Real Sketch archives can encode this NSNumber flag as JSON 0/1.
    // Keep this compatibility local to blur dictionaries; arbitrary numbers
    // and strings are not boolean admission for other document properties.
    matches!(blur.get("isEnabled"), Some(Value::Bool(true)))
        || blur.get("isEnabled").and_then(Value::as_u64) == Some(1)
}
fn sketch_point(value: &Value) -> Option<[f64; 2]> {
    let (x, y) = match value {
        Value::String(text) => {
            let inner = text.trim().strip_prefix('{')?.strip_suffix('}')?;
            let (x, y) = inner.split_once(',')?;
            (x.trim().parse::<f64>().ok()?, y.trim().parse::<f64>().ok()?)
        }
        Value::Object(_) => (value.get("x")?.as_f64()?, value.get("y")?.as_f64()?),
        _ => return None,
    };
    (x.is_finite() && y.is_finite()).then_some([x, y])
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum SketchProgressiveBackground {
    NotProgressive,
    Uniform(f64),
    Ramp(crate::scene::GradientBlurParameters),
}

/// Sketch 2025.2 exposes `Blur.progressive` and `Blur.gradient`. Stop alpha is
/// the published progression channel; this importer treats two linear stops as
/// fractions of `radius`. `isProgressive` is a different graphics flag.
/// Radial and non-two-stop gradients stay uniform and are named. The published
/// file schema does not list these fields, so this is the plugin shape, not a
/// framebuffer oracle.
pub(crate) fn sketch_background_progressive(blur: &Value, size: Option<[f64; 2]>) -> std::result::Result<SketchProgressiveBackground, &'static str> {
    if blur.get("progressive") != Some(&Value::Bool(true)) {
        return Ok(SketchProgressiveBackground::NotProgressive);
    }
    if blur.get("type").and_then(Value::as_i64).unwrap_or(0) != 3 {
        return Err("progressive-blur-outside-background-scope");
    }
    let gradient = blur.get("gradient").ok_or("progressive-background-blur-gradient-missing")?;
    let gradient_type = gradient.get("gradientType").and_then(Value::as_u64).ok_or("progressive-background-blur-gradient-missing")?;
    if gradient_type != 0 {
        return Err(if gradient_type == 1 {
            "progressive-background-blur-radial-not-modeled"
        } else {
            "progressive-background-blur-gradient-not-linear"
        });
    }
    let from = gradient.get("from").and_then(sketch_point).ok_or("progressive-background-blur-endpoints-missing")?;
    let to = gradient.get("to").and_then(sketch_point).ok_or("progressive-background-blur-endpoints-missing")?;
    let stops = gradient.get("stops").and_then(Value::as_array).ok_or("progressive-background-blur-stops-not-two-ended")?;
    if stops.len() != 2 {
        return Err("progressive-background-blur-stops-not-two-ended");
    }
    let mut indexed = Vec::with_capacity(2);
    for stop in stops {
        let position = stop.get("position").and_then(Value::as_f64).filter(|value| value.is_finite()).ok_or("progressive-background-blur-stops-not-two-ended")?;
        let direct = stop.get("alpha").and_then(Value::as_f64);
        let color = stop.pointer("/color/alpha").and_then(Value::as_f64);
        let alpha = match (direct, color) {
            (Some(left), Some(right)) if left != right => return Err("progressive-background-blur-stop-alpha-conflict"),
            (Some(alpha), _) | (_, Some(alpha)) => alpha,
            _ => return Err("progressive-background-blur-stop-alpha-missing"),
        };
        if !alpha.is_finite() || !(0. ..=1.).contains(&alpha) {
            return Err("progressive-background-blur-stop-alpha-outside-unit-interval");
        }
        indexed.push((position, alpha));
    }
    indexed.sort_by(|left, right| left.0.partial_cmp(&right.0).unwrap_or(std::cmp::Ordering::Equal));
    let radius = match blur.get("radius") {
        None => 0.,
        Some(value) => value.as_f64().filter(|value| value.is_finite() && *value >= 0.).ok_or("progressive-background-blur-radius-outside-model")?,
    };
    let start_radius = indexed[0].1 * radius;
    let end_radius = indexed[1].1 * radius;
    let (start, end) = if start_radius == end_radius {
        ([0., 0.], [1., 0.])
    } else {
        let Some(size) = size else { return Err("progressive-background-blur-needs-layer-bounds") };
        let at = |t: f64| [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
        let local = |point: [f64; 2]| [point[0] * size[0], point[1] * size[1]];
        (local(at(indexed[0].0)), local(at(indexed[1].0)))
    };
    match crate::gradient_blur::admit_two_end_progressive(start, end, start_radius, end_radius) {
        Ok(crate::gradient_blur::TwoEndAdmission::Uniform(radius)) => Ok(SketchProgressiveBackground::Uniform(radius)),
        Ok(crate::gradient_blur::TwoEndAdmission::Ramp(params)) => Ok(SketchProgressiveBackground::Ramp(params)),
        Err(crate::gradient_blur::TwoEndReject::Endpoints) => Err("progressive-background-blur-endpoints-missing"),
        Err(crate::gradient_blur::TwoEndReject::OutsideModel) => Err("progressive-background-blur-radius-outside-model"),
    }
}

fn sketch_progressive_note(blur: &Value, size: Option<[f64; 2]>) -> Option<&'static str> {
    match sketch_background_progressive(blur, size) {
        Ok(SketchProgressiveBackground::Uniform(_)) => Some("progressive-background-blur-equal-radii-kept-uniform"),
        Err(note) => Some(note),
        Ok(_) => None,
    }
}

fn sketch_zoom_parameters(blur:&Value)->Option<crate::zoom_blur::ZoomBlur> {
    let amount=match blur.get("radius") {None=>0.,Some(value)=>value.as_f64()?};
    let center=match blur.get("center") {
        None=>[0.5,0.5],
        Some(Value::String(value))=>{let inside=value.trim().strip_prefix('{')?.strip_suffix('}')?;
            let (x,y)=inside.split_once(',')?;[x.trim().parse().ok()?,y.trim().parse().ok()?]},
        Some(value)=>[value.get("x")?.as_f64()?,value.get("y")?.as_f64()?],
    };
    let params=crate::zoom_blur::ZoomBlur{amount,center};params.validate().then_some(params)
}
fn modern_blur(mut blur: Value) -> Value {
    if let Some(object) = blur.as_object_mut() { object.entry("layeringType").or_insert(json!(0)); }
    blur
}

// Native Custom Glass stores a unit depth, whereas our optical model uses
// document pixels. Anchor the portable preview at the two defaults (.5 and
// 8). The original native dictionary and the authored FD receipt are kept
// independently, including values outside this preview projection.
const SKETCH_GLASS_DEPTH_SCALE: f64 = 16.;
fn sketch_glass(blur: &Value, space: ColorSpace) -> Option<Effect> {
    if blur.get("isCustomGlass").and_then(Value::as_bool) == Some(false) { return None; }
    let number = |key: &str, default: f64, max: f64| {
        let v = match blur.get(key) { Some(v) => v.as_f64()?, None => default };
        (v.is_finite() && (0. ..=max).contains(&v)).then_some(v)
    };
    let light = match blur.get("skipLightingEffects") { Some(v) => !v.as_bool()?, None => true };
    let controls = crate::color_controls::ColorControls { space: Some(space),
        brightness: number("brightness",1.,2.)?-1., saturation: number("saturation",1.,2.)?, ..Default::default() };
    Some(Effect { id: String::new(), kind: "glass".into(), visible: true,
        radius: number("radius",0.,1000.)?, x:0., y:0., spread:0., color:"#000000".into(), opacity:1., amount:0.,
        glass: Some(crate::scene::GlassParameters { depth:(number("depth",0.5,1.)? * SKETCH_GLASS_DEPTH_SCALE).max(1.),
            refraction:number("distortion",0.5,1.)?, dispersion:number("chromaticAberrationMultiplier",0.,1.)?,
            bevel_size:None,light_angle:45.,light_intensity:if light {0.5} else {0.} }),
        color_controls: (!controls.is_identity()).then_some(controls),
        texture:None,gradient_blur:None,zoom_blur:None,motion_angle:0.,show_shadow_behind_node:false })
}

fn sketch_blur_value(e: &Effect) -> Value {
    let mut value=json!({"_class":"blur","isEnabled":e.visible,
        "center":e.zoom_blur.map_or_else(||"{0.5, 0.5}".to_string(),|z|format!("{{{}, {}}}",z.center[0],z.center[1])),
        "motionAngle":if e.motion_angle == 0. { 0. } else { -e.motion_angle },
        "radius":e.zoom_blur.map_or(e.radius.max(0.),|z|z.amount),
        "saturation":e.color_controls.map_or(1.,|c|c.saturation),
        "type":match e.kind.as_str() {"background-blur"=>3,"motion-blur"=>1,"zoom-blur"=>2,_=>0}});
    if let Some(g)=&e.glass {
        value["type"]=json!(4);
        value["brightness"]=json!((1.+e.color_controls.map_or(0.,|c|c.brightness)).clamp(0.,2.));
        value["saturation"]=json!(e.color_controls.map_or(1.,|c|c.saturation).clamp(0.,2.));
        value["depth"]=json!((g.depth/SKETCH_GLASS_DEPTH_SCALE).clamp(0.,1.));
        value["distortion"]=json!(g.refraction.clamp(0.,1.));
        value["chromaticAberrationMultiplier"]=json!(g.dispersion.clamp(0.,1.));
        value["skipLightingEffects"]=json!(g.light_intensity==0.);
        value["isProgressive"]=json!(false);
    }
    value
}

fn modern_blurs(effects: &[Effect], first: &Value) -> Value {
    if effects.iter().any(|e| e.glass.is_some()) {
        Value::Array(blur_projection(effects).iter().map(|e| modern_blur(sketch_blur_value(e))).collect())
    } else { json!([modern_blur(first.clone())]) }
}

// Patch only the modeled native controls that actually changed. In
// particular, editing frost must not quantize a small original unit depth or
// discard disabled effects and future optional native fields.
fn edited_glass_blurs(source: &Value, current: &[Effect]) -> Option<Vec<Value>> {
    let old: Vec<Effect> = serde_json::from_value(source.get("effects")?.clone()).ok()?;
    let current = blur_projection(current);
    if old.len()!=current.len() { return None; }
    let mut parts = source.get("blurs")?.as_array()?.clone();
    let mut enabled = parts.iter_mut().filter(|b| sketch_blur_enabled(b));
    for (before,after) in old.iter().zip(&current) {
        let raw = enabled.next()?;
        if before==after { continue; }
        if before.glass.is_none() || after.glass.is_none() || raw["type"]!=4 {return None;}
        let baseline = sketch_blur_value(before);
        let update = sketch_blur_value(after);
        for (key,value) in update.as_object()? {
            if baseline.get(key)!=Some(value) { raw[key]=value.clone(); }
        }
    }
    if enabled.next().is_some() { return None; }
    Some(parts)
}
// Old FD files may contain admitted paints in the former noise-retention
// list. Do not resurrect or duplicate those paints on compatibility export.
fn inactive_retained_noise(node:&Node,part:&Value,borders:bool)->bool {
    if part.get("image").is_some(){return false}
    match part.get("fillType").and_then(Value::as_u64).unwrap_or(0) {
        0=>part.get("color").is_some(),
        1..=3=>node.bindings.get(if borders{"sketchSourceStrokeGradients"}else{"sketchSourceGradients"})
            .and_then(|s|serde_json::from_str::<Value>(s).ok()).and_then(|v|v.as_object().cloned())
            .is_some_and(|m|part.get("gradient").is_some_and(|g|m.values().any(|v|v.get("gradient")==Some(g)))),
        _=>false,
    }
}
fn copy_inactive_noise(source:&Value,target:Option<&mut Value>){
    if let Some(target)=target.and_then(Value::as_object_mut){
        for key in ["noiseIndex","noiseIntensity","noiseFillType"]{if let Some(value)=source.get(key){target.insert(key.into(),value.clone());}}
    }
}
fn native_effect_projection(style:&Value) -> Value {
    json!({"blurs":sketch_blurs(style).into_iter().cloned().map(modern_blur).collect::<Vec<_>>(),"shadows":style.get("shadows"),"innerShadows":style.get("innerShadows"),"colorControls":style.get("colorControls")})
}

fn restored_effect_model(owner: &Value, style: &Value) -> Option<Vec<Effect>> {
    let receipt = owner.pointer("/userInfo/com.futureox.design-kernel/legacyEffectModel")?;
    if receipt.get("native") != Some(&native_effect_projection(style)) { return None; }
    let effects: Vec<Effect> = serde_json::from_value(receipt.get("effects")?.clone()).ok()?;
    (effects.len() <= 16 && effects.iter().all(|e| e.validate_material().is_ok())).then_some(effects)
}

fn blur_projection(effects: &[Effect]) -> Vec<Effect> {
    effects
        .iter()
        .filter(|effect| matches!(effect.kind.as_str(), "blur" | "gaussian-blur" | "motion-blur" | "zoom-blur" | "background-blur" | "glass"))
        .cloned()
        .map(|mut effect| {
            effect.id.clear();
            effect
        })
        .collect()
}

fn gradient_paint(
    gradient: &Value,
    fill_type: u64,
    size: [f64; 2],
    space: ColorSpace,
) -> Option<Paint> {
    let native_type = gradient
        .get("gradientType")
        .and_then(Value::as_u64)
        .unwrap_or(fill_type.saturating_sub(1));
    let kind = match native_type {
        0 => "linear",
        1 => "radial",
        2 => "angular",
        _ => return None,
    };
    let mut paint = blank_paint(kind);
    if let (Some(from), Some(to)) = (gradient.get("from"), gradient.get("to")) {
        let (mut x, mut y) = point_xy(from);
        let (tx, ty) = point_xy(to);
        let (dx, dy) = (tx - x, ty - y);
        // A linear gradient samples only its longitudinal coordinate. Exact
        // axis-aligned gradients can discard an out-of-range perpendicular
        // translation without changing any sample. Keep the raw source anchors
        // in sketchSourceGradients for unchanged compatibility export.
        if kind == "linear" {
            if dx == 0. && dy != 0. && x.abs() > 1e7 {
                x = 0.;
            }
            if dy == 0. && dx != 0. && y.abs() > 1e7 {
                y = 0.;
            }
        }
        if dx * dx + dy * dy > 1e-12 {
            paint.transform = Some(if kind == "radial" {
                // Sketch `from` is the center, `to` is one radius endpoint.
                // Paint's radial unit disk is centered at (.5,.5), with radius
                // .5. Build the perpendicular in layer pixels before returning
                // to normalized coordinates; otherwise non-square layers turn
                // a native circle into an ellipse. elipseLength scales that
                // perpendicular radius. Verified against native Sketch exports.
                let ratio = gradient
                    .get("elipseLength")
                    .and_then(Value::as_f64)
                    .filter(|value| *value > 0.)
                    .unwrap_or(1.);
                let cross_x = -dy * size[1] / size[0].max(1e-8) * ratio;
                let cross_y = dx * size[0] / size[1].max(1e-8) * ratio;
                Transform([
                    2. * dx,
                    2. * dy,
                    2. * cross_x,
                    2. * cross_y,
                    x - dx - cross_x,
                    y - dy - cross_y,
                ])
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
    } else if bytes.starts_with(b"II*\x00") || bytes.starts_with(b"MM\x00*") {
        "image/tiff"
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

#[cfg(all(test,not(target_arch="wasm32")))]
#[test]
fn repeated_archive_image_references_share_exact_encoded_bytes(){
    let mut image=std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(2,2,image::Rgba([16,128,240,255])))
        .write_to(&mut image,image::ImageFormat::Png).unwrap();
    let bytes=image.into_inner();let files=BTreeMap::from([("images/asset".into(),bytes.clone())]);
    let page=json!({"_class":"page","do_objectID":"p","name":"p","layers":[
        {"_class":"bitmap","do_objectID":"a","name":"a","frame":{"x":0,"y":0,"width":2,"height":2},"image":{"_ref":"asset"}},
        {"_class":"bitmap","do_objectID":"b","name":"b","frame":{"x":4,"y":0,"width":2,"height":2},"image":{"_ref":"images/asset"}}
    ]});
    let result=import_sketch_source_parts(&files,&json!({"version":136}),&json!({"pages":[{"_ref":"pages/p"}]}),&BTreeMap::from([("p".into(),page)])).unwrap();
    let a=result.document.nodes.values().find(|n|n.name=="a").unwrap().fills[0].image.as_ref().unwrap();
    let b=result.document.nodes.values().find(|n|n.name=="b").unwrap().fills[0].image.as_ref().unwrap();
    assert!(std::sync::Arc::ptr_eq(a,b));assert_eq!(a.as_ref(),image_data_uri(&bytes));
}

#[cfg(all(test,not(target_arch="wasm32")))]
#[test]
fn classic_tiff_bitmap_bytes_keep_a_tiff_data_uri() {
    let bytes = b"II*\x00\x08\x00\x00\x00".to_vec();
    assert!(image_data_uri(&bytes).starts_with("data:image/tiff;base64,"));
    assert_eq!(sniff_image_mime(b"MM\x00*"), "image/tiff");
    assert_eq!(sniff_image_mime(b"GIF89a"), "image/gif");
}

#[cfg(all(test,not(target_arch="wasm32")))]
#[test]
fn parsed_source_size_bound_falls_back_without_changing_escaped_entry_limit(){
    let pages=BTreeMap::from([("p".into(),json!({"_class":"page","do_objectID":"p","name":"p","layers":[]}))]);
    let mut document=json!({"pages":[{"_ref":"pages/p"}],"unknownSourceSizeProbe":"x".repeat(12*1024*1024)});
    assert!(source_size::upper_bound(&document,64*1024*1024).is_some());
    assert!(import_sketch_source_parts(&BTreeMap::new(),&json!({"version":136}),&document,&pages).is_ok());
    // Eleven MiB of controls serialize beyond the unchanged64MiBentry cap.
    document["unknownSourceSizeProbe"]=json!("\0".repeat(11*1024*1024));
    assert!(import_sketch_source_parts(&BTreeMap::new(),&json!({"version":136}),&document,&pages).is_err());
    // The numeric bound can still overestimate an otherwise valid entry.
    // Keep the original exact-count fallback at the real admission boundary.
    document["unknownSourceSizeProbe"]=json!("");document["numberProbe"]=json!(0.5);
    let overhead=serde_json::to_vec(&document).unwrap().len();
    document["unknownSourceSizeProbe"]=json!("x".repeat(64*1024*1024-overhead-1));
    assert!(source_size::upper_bound(&document,64*1024*1024).is_none());
    assert!(import_sketch_source_parts(&BTreeMap::new(),&json!({"version":136}),&document,&pages).is_ok());
}

/// Read the encoded extent without decoding/allocating the bitmap. Sampling
/// still uses the ordinary image admission and decoder in the renderer.
fn bitmap_extent(bytes: &[u8]) -> Option<[f64; 2]> {
    let (w, h) = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format().ok()?.into_dimensions().ok()?;
    (w > 0 && h > 0).then_some([f64::from(w), f64::from(h)])
}

/// Sketch has one uniform tile scale; independent axes, offsets and stagger
/// remain separate kernel features and cannot be silently flattened into it.
fn sketch_pattern_scale(paint: &Paint, extent: Option<[f64; 2]>) -> Option<f64> {
    let tile = paint.tile.as_ref().filter(|tile| tile.is_active())?;
    if tile.mode != crate::pattern_fill::GRID || tile.offset != [0., 0.]
        || tile.alignment.iter().any(|a| a != crate::pattern_fill::ALIGN_START)
        || paint.transform.is_some_and(|t| t != Transform::default()) {
        return None;
    }
    if tile.size == [0., 0.] { return Some(1.); }
    let extent = extent?;
    let size = tile.resolve(extent);
    let x = size[0] / extent[0];
    let y = size[1] / extent[1];
    (x.is_finite() && x > 0. && (x-y).abs() <= x.abs().max(y.abs()) * 8. * f64::EPSILON)
        .then_some(x)
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
        "hotspot" => "rectangle", // Paintless hit region; prototype actions use the shared player.
        _ => "group",
    }
}

/// Images already admitted and owned by the native Sketch source session.
#[cfg(not(target_arch = "wasm32"))]
pub fn source_bitmap_upright(exif: &[u8]) -> std::result::Result<bool,String>{
    Ok(crate::image_color::exif_orientation(exif)? == image::metadata::Orientation::NoTransforms)
}
pub type SourceBitmapRefs = BTreeMap<String,(std::sync::Arc<str>,[u32;2])>;
struct Importer<'a> {
    source_bitmaps: &'a SourceBitmapRefs,
    image_sources: std::cell::RefCell<std::collections::HashMap<&'a str,std::sync::Arc<str>>>,
    available_fonts: std::collections::BTreeSet<String>,
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
    fn source_bitmap(&self, reference:&str)->Option<&(std::sync::Arc<str>,[u32;2])>{
        self.source_bitmaps.get(reference).or_else(|| self.source_bitmaps.get(&format!("images/{reference}")))
    }
    fn pattern_size(&self, part: &Value) -> Option<[f64; 2]> {
        let scale = part.get("patternTileScale").and_then(Value::as_f64).unwrap_or(1.);
        if !scale.is_finite() || scale <= 0. { return None; }
        if scale == 1. { return Some([0., 0.]); }
        let reference = part.pointer("/image/_ref")?.as_str()?;
        let extent=if let Some((_,dims))=self.source_bitmap(reference){dims.map(f64::from)} else {
            let bytes = self.files.get(&format!("images/{reference}")).or_else(|| self.files.get(reference))?;
            bitmap_extent(bytes)?
        };
        let size = extent.map(|value| value * scale);
        size.iter().all(|v| v.is_finite() && *v > 0. && *v <= 1e7).then_some(size)
    }
    fn image_ref(&self, layer: &Value) -> Option<std::sync::Arc<str>> {
        let reference = layer.get("image").and_then(|i| i.get("_ref"))?.as_str()?;
        if let Some((uri,_))=self.source_bitmap(reference){return Some(uri.clone());}
        let (key,bytes)=self.files.get_key_value(&format!("images/{reference}"))
            .or_else(||self.files.get_key_value(reference))?;
        // The same immutable archive asset is often painted by many layers.
        // Encode it once; each node still owns the complete original data URI.
        Some(self.image_sources.borrow_mut().entry(key.as_str())
            .or_insert_with(||std::sync::Arc::from(image_data_uri(bytes))).clone())
    }

    /// Whether `paint_part` would admit this part, checked without building
    /// the paint (no base64 data-URI pass) so fidelity scans stay cheap on
    /// large archives. Mirrors `paint_part`'s admission branches exactly.
    fn part_admitted(&self, part: &Value) -> bool {
        if !bool_at(part, "isEnabled") {
            return false;
        }
        let fill_type = part.get("fillType").and_then(Value::as_u64).unwrap_or(0);
        match fill_type {
            0 if part.get("image").is_some() => self.image_resolves(part),
            0 => part.get("color").is_some(),
            1..=3 => part
                .get("gradient")
                .map(|g| {
                    g.get("gradientType")
                        .and_then(Value::as_u64)
                        .unwrap_or(fill_type - 1)
                        <= 2
                })
                .unwrap_or(false),
            4 => self.image_resolves(part),
            _ => false,
        }
    }

    fn image_resolves(&self, part: &Value) -> bool {
        part.get("image")
            .and_then(|i| i.get("_ref"))
            .and_then(Value::as_str)
            .map(|r| {
                self.source_bitmap(r).is_some() || self.files.contains_key(&format!("images/{r}")) || self.files.contains_key(r)
            })
            .unwrap_or(false)
    }

    /// One archived fill/border part → kernel paint (shared by layer styles
    /// and the document-level shared style containers).
    fn paint_part(
        &self,
        part: &Value,
        base_opacity: f64,
        blend: &str,
        size: [f64; 2],
    ) -> Option<Paint> {
        let (part_opacity, part_blend) = blend_of(part);
        let base_opacity = base_opacity * part_opacity;
        let blend = if part
            .get("contextSettings")
            .and_then(|v| v.get("blendMode"))
            .is_some()
        {
            part_blend.as_str()
        } else {
            blend
        };
        let fill_type = part.get("fillType").and_then(Value::as_u64).unwrap_or(0);
        // Pattern placement follows the archived `patternFillType`
        // (Tile=0/Fill=1/Stretch=2/Fit=3, official file-format enum):
        // Fill keeps aspect while covering (cover), Stretch distorts
        // (stretch), Fit letterboxes (contain), Tile repeats at the image's
        // native cell period multiplied by patternTileScale. The existing
        // authored tile size drives CPU, GPU, SVG and Inspector edits alike.
        let image_paint = |part: &Value| {
            self.image_ref(part).map(|uri| {
                let mut p = blank_paint("image");
                p.image = Some(uri.into());
                match part.get("patternFillType").and_then(Value::as_i64) {
                    Some(2) => p.fit = "stretch".into(),
                    Some(3) => p.fit = "contain".into(),
                    Some(0) => {
                        p.tile = Some(crate::pattern_fill::PatternTile {
                            mode: crate::pattern_fill::GRID.into(),
                            size: self.pattern_size(part).unwrap_or([0., 0.]),
                            offset: [0., 0.],
                            alignment: [
                                crate::pattern_fill::ALIGN_START.into(),
                                crate::pattern_fill::ALIGN_START.into(),
                            ],
                            ..crate::pattern_fill::PatternTile::native()
                        })
                    }
                    // 1 (Fill) is the kernel image-paint default (cover)
                    _ => {}
                }
                p.opacity = base_opacity;
                p.blend = blend.into();
                p
            })
        };
        let mut paint = match fill_type {
            0 => {
                // image (pattern) fills carry fillType 0 + an image ref in real files
                if part.get("image").is_some() {
                    image_paint(part)
                } else {
                    part.get("color")
                        .map(|c| solid_paint(c, base_opacity, blend, self.color_space))
                }
            }
            1..=3 => part.get("gradient").and_then(|g| {
                let mut p = gradient_paint(g, fill_type, size, self.color_space)?;
                p.blend = blend.into();
                p.opacity *= base_opacity;
                Some(p)
            }),
            4 => image_paint(part),
            _ => None,
        }?;
        paint.visible = bool_at(part, "isEnabled");
        Some(paint)
    }

    fn paints(&self, style: &Value, key: &str, size: [f64; 2]) -> Vec<Paint> {
        self.paint_sources(style,key,size).into_iter().map(|(_,paint)|paint).collect()
    }

    fn paint_sources<'b>(&self, style:&'b Value, key:&str, size:[f64;2])->Vec<(&'b Value,Paint)> {
        let mut out = Vec::new();
        let Some(parts) = style.get(key).and_then(Value::as_array) else {
            return out;
        };
        for part in parts {
            // The node owns the layer context. Each paint owns only its part
            // context and color alpha; multiplying layer opacity here repeats it.
            if let Some(paint) = self.paint_part(part, 1., "normal", size) {
                out.push((part,paint));
            }
        }
        out
    }

    fn strokes(&self, style: &Value, size: [f64; 2], lossy: &mut Vec<String>) -> Vec<Stroke> {
        self.stroke_sources(style,size,lossy).into_iter().map(|(_,stroke)|stroke).collect()
    }

    fn stroke_sources<'b>(&self, style:&'b Value, size:[f64;2], lossy:&mut Vec<String>)->Vec<(&'b Value,Stroke)> {
        // Dash/cap/join live on the style's borderOptions (one set shared by
        // every border, per the archived schema); the endpoint markers ride
        // the same shared options, so every border inherits them.
        let options = style.get("borderOptions").unwrap_or(&Value::Null);
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
        let start_marker = options
            .get("startMarkerType")
            .and_then(Value::as_i64)
            .map(|code| marker_of(code, lossy))
            .unwrap_or_default();
        let end_marker = options
            .get("endMarkerType")
            .and_then(Value::as_i64)
            .map(|code| marker_of(code, lossy))
            .unwrap_or_default();
        let mut out = Vec::new();
        let Some(parts) = style.get("borders").and_then(Value::as_array) else {
            return out;
        };
        for part in parts {
            // A border has the same paint carrier as a fill. Its `color`
            // can be an unused black fallback while fillType selects a gradient.
            let Some(mut paint) = self.paint_part(part, 1., "normal", size) else {
                continue;
            };
            paint.id = String::new();
            out.push((part,Stroke {
                start_marker,
                end_marker,
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
                visible: bool_at(part, "isEnabled"),
                width_profile: Vec::new(),
            }));
        }
        out
    }

    fn effects(&self, style: &Value, allow_color_controls: bool, size: Option<[f64; 2]>) -> Vec<Effect> {
        let mut out = Vec::new();
        let mut push_shadow = |parts: Option<&Vec<Value>>, inner: bool| {
            if let Some(parts) = parts {
                for part in parts {
                    out.push(Effect {
                        id: String::new(),
                        kind: if inner { "inner-shadow" } else { "shadow" }.into(),
                        visible: bool_at(part, "isEnabled"),
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
                        show_shadow_behind_node: false,
                        color_controls: None,
                        zoom_blur: None, motion_angle: 0.,
                    });
                }
            }
        };
        push_shadow(style.get("shadows").and_then(Value::as_array), false);
        push_shadow(style.get("innerShadows").and_then(Value::as_array), true);
        for blur in sketch_blurs(style).into_iter().filter(|blur| sketch_blur_enabled(blur)) {
            if blur.get("type").and_then(Value::as_i64)==Some(4) {
                if let Some(effect)=sketch_glass(blur,self.color_space) { out.push(effect); }
                continue;
            }
            if sketch_blur_enabled(blur)
            && (f64_at(blur, "radius") > 0. || blur.get("type").and_then(Value::as_i64)==Some(2) || (blur.get("type").and_then(Value::as_i64) == Some(3)
                && blur.get("saturation").and_then(Value::as_f64).unwrap_or(1.) != 1.))
        {
            let kind = match blur.get("type").and_then(Value::as_i64).unwrap_or(0) {
                0 => Some("gaussian-blur"),
                1 => Some("motion-blur"),
                2 => Some("zoom-blur"),
                3 => Some("background-blur"),
                _ => None,
            };
            if let Some(kind) = kind {
                let zoom_blur=if kind=="zoom-blur" {sketch_zoom_parameters(blur)} else {None};
                if kind=="zoom-blur" && zoom_blur.is_none() {continue;}
                let mut radius = if kind=="zoom-blur" {0.} else {f64_at(blur, "radius")};
                let mut gradient_blur = None;
                if kind == "background-blur" {
                    match sketch_background_progressive(blur, size) {
                        Ok(SketchProgressiveBackground::Uniform(value)) => radius = value,
                        Ok(SketchProgressiveBackground::Ramp(params)) => {
                            radius = 1.;
                            gradient_blur = Some(params);
                        }
                        Ok(SketchProgressiveBackground::NotProgressive) | Err(_) => {}
                    }
                }
                out.push(Effect {
                id: String::new(),
                kind: kind.into(),
                visible: true,
                radius,
                x: 0.,
                y: 0.,
                spread: 0.,
                color: "#000000".into(),
                opacity: 1.,
                amount: 0.,
                glass: None,
                texture: None,
                gradient_blur,
                show_shadow_behind_node: false,
                color_controls: (kind == "background-blur").then(|| crate::color_controls::ColorControls {
                    space:Some(self.color_space), saturation: blur.get("saturation").and_then(Value::as_f64).unwrap_or(1.), ..Default::default()
                }).filter(|c| c.validate() && !c.is_identity()),
                zoom_blur,
                // Sketch stores this angle in a y-up coordinate system.
                motion_angle: if kind=="motion-blur" {-f64_at(blur,"motionAngle")} else {0.},
            }); }
            }
        }
        if let Some(controls) = style.get("colorControls").filter(|c|allow_color_controls && bool_at(c,"isEnabled")) {
            let controls = crate::color_controls::ColorControls {
                space:Some(self.color_space),
                brightness:f64_at(controls,"brightness"),
                contrast:controls.get("contrast").and_then(Value::as_f64).unwrap_or(1.),
                saturation:controls.get("saturation").and_then(Value::as_f64).unwrap_or(1.),
                hue:f64_at(controls,"hue"),
            };
            if controls.validate() {
                out.push(Effect { id:String::new(),kind:"color-controls".into(),visible:true,
                    radius:0.,x:0.,y:0.,spread:0.,color:"#000000".into(),opacity:1.,amount:0.,
                    glass:None,texture:None,gradient_blur:None,show_shadow_behind_node:false,color_controls:Some(controls),zoom_blur:None,motion_angle:0. });
            }
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
        let clipping = layer.get("clippingBehavior").and_then(Value::as_i64);
        let modern_frame = class == "group"
            && (matches!(layer.get("groupBehavior").and_then(Value::as_i64), Some(1 | 2))
                || clipping == Some(1));
        let kind = if modern_frame { "frame" } else { kind_for_class(class) };
        let mut node = crate::facet::sample_node(&id, kind);
        if kind == "frame" {
            // Artboards and Frames clip by default. Symbol masters only clip
            // when explicitly enabled. This is separate from sibling masks.
            node.clip = match clipping {
                Some(1) => true,
                Some(2) => false,
                _ => class != "symbolMaster",
            };
        }
        // Import-side degradation ledger (mirror of the exporter's userInfo
        // lossy list, surfaced through bindings like figUntranslated).
        let mut import_lossy: Vec<String> = Vec::new();
        if !matches!(
            class,
            "artboard"
                | "frame"
                | "canvasFrame"
                | "symbolMaster"
                | "group"
                | "shapeGroup"
                | "symbolInstance"
                | "rectangle"
                | "oval"
                | "star"
                | "polygon"
                | "triangle"
                | "shapePath"
                | "shape"
                | "text"
                | "bitmap"
                | "slice"
                | "hotspot"
        ) {
            node.bindings.insert(
                "interopLimited".into(),
                format!("sketch-unknown-layer-class:{class}"),
            );
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
        let frame = layer.get("frame").unwrap_or(&Value::Null);
        node.constrain_proportions = bool_at(&frame, "constrainProportions");
        node.width = f64_at(&frame, "width").max(0.);
        node.height = f64_at(&frame, "height").max(0.);
        let x = f64_at(&frame, "x");
        let y = f64_at(&frame, "y");
        node.transform = Transform([1., 0., 0., 1., x, y]);
        let rotation = f64_at(layer, "rotation");
        let flip = [
            bool_at(layer, "isFlippedHorizontal"),
            bool_at(layer, "isFlippedVertical"),
        ];
        if rotation != 0. || flip.iter().any(|v| *v) {
            node.transform = crate::sketch::geometry::layer_transform(
                [x, y, node.width, node.height],
                rotation,
                flip,
            );
            node.bindings.insert(
                "sketchSourceTransform".into(),
                json!({
                    "frame": [x,y,node.width,node.height], "rotation":rotation,
                    "flip":flip, "matrix":node.transform.0,
                })
                .to_string(),
            );
        }

        let style = layer.get("style").unwrap_or(&Value::Null);
        if !style.is_null() {
            if ["fills","borders"].iter().any(|key|style.get(key).and_then(Value::as_array).into_iter().flatten().any(|part|matches!(part.pointer("/contextSettings/blendMode").and_then(Value::as_u64),Some(16|17)))) {
                import_lossy.push("plus-blend-native-roundtrip-preserved-portable-compositing-differs".into());
            }
            let size = [node.width, node.height];
            let fills=self.paint_sources(style,"fills",size);
            let source_gradients: BTreeMap<String, Value> = fills.iter()
                .enumerate()
                .filter_map(|(index, (part, paint))| {
                    part.get("gradient")
                        .filter(|_| part.get("fillType").and_then(Value::as_u64) == Some(1))
                        .map(|gradient| {
                            (
                                index.to_string(),
                                json!({"gradient":gradient,"paint":paint}),
                            )
                        })
                })
                .collect();
            if !source_gradients.is_empty() {
                node.bindings.insert(
                    "sketchSourceGradients".into(),
                    json!(source_gradients).to_string(),
                );
            }
            node.fills=fills.into_iter().map(|(_,paint)|paint).collect();
            let borders=self.stroke_sources(style,size,&mut import_lossy);
            let border_gradients: BTreeMap<String, Value> = borders.iter().map(|(part,stroke)|(*part,&stroke.paint))
                .enumerate()
                .filter_map(|(index, (part, paint))| {
                    part.get("gradient")
                        .filter(|_| matches!(paint.kind.as_str(), "linear" | "radial" | "angular"))
                        .map(|gradient| {
                            (
                                index.to_string(),
                                json!({"gradient":gradient,"paint":paint,"size":size}),
                            )
                        })
                })
                .collect();
            if !border_gradients.is_empty() {
                node.bindings.insert(
                    "sketchSourceStrokeGradients".into(),
                    json!(border_gradients).to_string(),
                );
            }
            node.strokes=borders.into_iter().map(|(_,stroke)|stroke).collect();
            node.effects = self.effects(&style, class == "bitmap", Some([node.width, node.height]));
            // Our historical blur radius remains a different authored model.
            // Restore only while the native effect fields still match exactly;
            // a subsequent native Sketch edit must supersede this receipt.
            if let Some(effects) = restored_effect_model(layer, &style) {
                node.effects = effects;
            }

            let source_blurs = sketch_blurs(&style);
            if source_blurs.iter().any(|b| sketch_blur_enabled(b) || f64_at(b,"radius") > 0. || b["type"]==4) {
                node.bindings.insert("sketchSourceBlur".into(), json!({
                    "blur":source_blurs.first(), "blurs":style.get("blurs"),
                    "effects":blur_projection(&node.effects),
                }).to_string());
                for blur in source_blurs.iter().filter(|b| sketch_blur_enabled(b)) {
                    if let Some(note) = sketch_progressive_note(blur, Some([node.width, node.height])) {
                        import_lossy.push(note.into());
                    }
                    match blur.get("type").and_then(Value::as_i64).unwrap_or(0) {
                        2 if sketch_zoom_parameters(blur).is_none()=>import_lossy.push("zoom-blur-invalid-parameters;source-retained".into()),
                        0 | 1 | 2 | 3 => {},
                        4 if sketch_glass(blur,self.color_space).is_some()=>import_lossy.push("glass-portable-optics-projection;native-parameters-retained".into()),
                        4=>import_lossy.push("glass-parameters-not-modeled;source-blur-retained".into()),
                        _ => import_lossy.push("unknown-blur-type-not-modeled;source-blur-retained".into()),
                    }
                    if blur.get("layeringType").and_then(Value::as_i64).unwrap_or(0) != 0 {
                        import_lossy.push("blur-layering-type-not-modeled;source-blur-retained".into());
                    }
                }
                if source_blurs.iter().filter(|b|bool_at(b,"isEnabled")).count()>1 {
                    import_lossy.push("multiple-native-blurs-portable-order;source-blurs-retained".into());
                }
                if node.effects.iter().any(|e|matches!(e.kind.as_str(),"gaussian-blur"|"motion-blur"|"zoom-blur")) {
                    import_lossy.push("native-blur-portable-kernel;native-pixels-not-identical".into());
                }
            }
            let (opacity, blend) = blend_of(&style);
            node.opacity = opacity;
            node.blend = blend;
            // P1-6: shared style reference survives as a style_ref
            if let Some(shared) = layer
                .get("sharedStyleID")
                .or_else(|| style.get("sharedStyleID"))
                .and_then(Value::as_str)
            {
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
        // Modern noise presets are image/pattern fills. An unused legacy
        // noiseIndex on an otherwise admitted paint must not splice a second
        // fill on export. Only genuinely unmodeled parts need raw retention.
        // Only unresolved/invalid bitmap extents retain an unmodeled scale.
        if !style.is_null() {
            let mut noise = Map::new();
            let mut inactive_noise = Map::new();
            let mut pattern_scale = Map::new();
            for parts_key in ["fills", "borders"] {
                let mut admitted = 0usize;
                let mut dropped = 0usize;
                let Some(parts) = style.get(parts_key).and_then(Value::as_array) else {
                    continue;
                };
                for part in parts {
                    let admitted_part=self.part_admitted(part);
                    let is_noise = bool_at(part, "isEnabled")
                        && !admitted_part
                        && part.get("image").is_none()
                        && (part.get("noiseIndex").and_then(Value::as_u64).unwrap_or(0) != 0
                            || !matches!(
                                part.get("fillType").and_then(Value::as_u64).unwrap_or(0),
                                0..=3
                            ));
                    if is_noise {
                        noise.insert(format!("{parts_key}-{}", admitted + dropped), part.clone());
                        dropped += 1;
                        continue;
                    }
                    if !admitted_part {
                        continue;
                    }
                    if ["noiseIndex","noiseIntensity","noiseFillType"].iter().any(|key|f64_at(part,key)!=0.) {
                        let fields:Map<String,Value>=["noiseIndex","noiseIntensity","noiseFillType"].into_iter()
                            .filter_map(|key|part.get(key).map(|v|(key.to_owned(),v.clone()))).collect();
                        inactive_noise.insert(format!("{parts_key}-{}",admitted+dropped),Value::Object(fields));
                    }
                    if part.get("patternFillType").and_then(Value::as_i64) == Some(0)
                        && self.pattern_size(part).is_none()
                        && let Some(scale) = part
                            .get("patternTileScale")
                            .and_then(Value::as_f64)
                            .filter(|s| *s != 1.)
                    {
                        pattern_scale.insert(format!("{parts_key}-{admitted}"), json!(scale));
                    }
                    admitted += 1;
                }
            }
            if !inactive_noise.is_empty() {
                node.bindings.insert("sketchInactiveNoiseMetadata".into(),Value::Object(inactive_noise).to_string());
            }
            if !noise.is_empty() {
                node.bindings.insert(
                    "sketchSourceNoiseFills".into(),
                    json!(noise).to_string(),
                );
                import_lossy.push("noise-fill-not-modeled;source-retained".into());
            }
            if !pattern_scale.is_empty() {
                node.bindings.insert(
                    "sketchSourcePatternScale".into(),
                    json!(pattern_scale).to_string(),
                );
                import_lossy.push("pattern-tile-scale-not-modeled;source-retained".into());
            }
            if let Some(controls) = layer
                .pointer("/style/colorControls")
                .filter(|c| bool_at(c, "isEnabled"))
            {
                node.bindings.insert(
                    "sketchSourceColorControls".into(),
                    serde_json::to_string(controls).unwrap_or_default(),
                );
                if node.effects.iter().any(|e|e.kind == "color-controls") {
                    node.bindings.insert("sketchColorControlsModeled".into(),"true".into());
                } else { import_lossy.push("color-controls-not-modeled;source-retained".into()); }
            }
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
            let wrap = bool_at(group_layout, "wrappingEnabled");
            let saved = layer.pointer("/userInfo/com.futureox.design-kernel/stackAlignment");
            let axis = |value: crate::layout::Align, key: &str| {
                use crate::layout::Align::*;
                let hint = saved.and_then(|v| v.get(key)).and_then(Value::as_str);
                match value {
                    Center if hint == Some("unsafe-center") || (wrap && hint != Some("center")) => UnsafeCenter,
                    End if hint == Some("unsafe-end") || (wrap && hint != Some("end")) => UnsafeEnd,
                    value => value,
                }
            };
            node.layout = Some(crate::layout::Layout {
                mode,
                gap: f64_at(group_layout, "allGuttersGap"),
                line_gap: f64_at(group_layout, "crossAxisGutterGap"),
                padding: [
                    f64_at(layer, "topPadding"),
                    f64_at(layer, "rightPadding"),
                    f64_at(layer, "bottomPadding"),
                    f64_at(layer, "leftPadding"),
                ],
                wrap,
                // Sketch 2025 stores the modern Stack's first item last in
                // its layer array. Keep that array for painting and masking.
                reverse_flow: layer.get("groupBehavior").and_then(Value::as_i64).is_some(),
                justify: axis(justify(f64_at(group_layout, "justifyContent") as i64), "justify"),
                align: axis(align(f64_at(group_layout, "alignItems") as i64), "align"),
                ..crate::layout::Layout::default()
            });
        } else if let Some(group_layout) = layer.get("groupLayout")
            && matches!(
                group_layout.get("_class").and_then(Value::as_str),
                Some("MSImmutableInferredGroupLayout") | Some("MSInferredGroupLayout")
            )
        {
            // Inferred (smart) group layout: the archived schema is
            // axis(0=H/1=V) + layoutAnchor(0=min/1=middle/2=max) + optional
            // min/maxSize. The kernel's inferred_layout.rs derives stack
            // parameters from static geometry but has no authored storage
            // slot, so the payload rides bindings verbatim and the static
            // child frames — which Sketch itself laid out — are preserved.
            let payload = json!({
                "_class": "MSImmutableInferredGroupLayout",
                "axis": group_layout.get("axis").cloned().unwrap_or(json!(1)),
                "layoutAnchor": group_layout.get("layoutAnchor").cloned().unwrap_or(json!(0)),
                "minSize": group_layout.get("minSize").cloned().unwrap_or(Value::Null),
                "maxSize": group_layout.get("maxSize").cloned().unwrap_or(Value::Null),
            });
            node.bindings.insert(
                "sketchInferredGroupLayout".into(),
                serde_json::to_string(&payload).unwrap_or_default(),
            );
            import_lossy.push("inferred-group-layout-not-modeled;static-frames-preserved".into());
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
            "rectangle" => {
                // Shared rectangle corners use radii; cornerRadius belongs to
                // polygon/star fillets and is invalid on a rectangle.
                node.radii = [f64_at(layer, "fixedRadius"); 4];
                if let Some(points) = layer
                    .get("points")
                    .and_then(Value::as_array)
                    .filter(|p| p.len() == 4)
                {
                    for (radius, point) in node.radii.iter_mut().zip(points) {
                        if point.get("cornerRadius").is_some() {
                            *radius = f64_at(point, "cornerRadius");
                        }
                    }
                }
            }
            "oval" | "star" | "polygon" | "triangle" => {
                node.points = layer
                    .get("numberOfPoints")
                    .and_then(Value::as_u64)
                    .unwrap_or(5) as usize;
                node.inner_radius = layer.get("radius").or_else(||layer.get("innerRadius")).and_then(Value::as_f64).unwrap_or(0.5);
            }
            "shapePath" | "shape" => {
                if layer.get("isClosed").and_then(Value::as_bool) == Some(false) {
                    node.bindings.insert("sketchOpenPath".into(), "true".into());
                }
                if layer
                    .get("userInfo")
                    .and_then(|u| u.get("com.futureox.design-kernel"))
                    .and_then(|u| u.get("originalId"))
                    .is_none()
                    || layer
                        .pointer("/userInfo/com.futureox.design-kernel/geometryUnits")
                        .and_then(Value::as_str)
                        == Some("normalized")
                {
                    node.bindings
                        .insert("sketchNormalizedCoordinates".into(), "true".into());
                }
                if let Some(points) = layer.get("points").and_then(Value::as_array) {
                    let mut network = crate::scene::Network {
                        filled_faces: None,
                        vertices: Vec::new(),
                        edges: Vec::new(),
                        fill_rule: if style
                            .get("windingRule")
                            .or_else(|| layer.get("windingRule"))
                            .and_then(Value::as_u64)
                            .unwrap_or(1)
                            == 0
                        {
                            "nonzero"
                        } else {
                            "evenodd"
                        }
                        .into(),
                    };
                    // Explicit handle flags own the rendered geometry, just
                    // as in sketch::CurveContour. curveMode is an editing
                    // constraint: real Sketch paths can retain an active
                    // one-sided curve on a Straight point (e.g. a split circle).
                    // Do not drop active controls or invent an inactive side.
                    let mut outgoing: Vec<Option<crate::math::Point>> =
                        Vec::with_capacity(points.len());
                    let mut incoming: Vec<Option<crate::math::Point>> =
                        Vec::with_capacity(points.len());
                    let mut corner_radii: Vec<f64> = Vec::with_capacity(points.len());
                    let mut any_corner_radius = false;
                    #[allow(clippy::needless_range_loop)]
                    for i in 0..points.len() {
                        let pt = &points[i];
                        let anchor = pt.get("point").unwrap_or(&Value::Null);
                        let (vx, vy) = point_xy(&anchor);
                        network.vertices.push(crate::scene::Vertex {
                            id: format!("v{i}"),
                            x: vx,
                            y: vy,
                        });
                        let has_from = bool_at(pt, "hasCurveFrom");
                        let has_to = bool_at(pt, "hasCurveTo");
                        let to = if has_to {
                            pt.get("curveTo").map(point_to_point)
                        } else {
                            None
                        };
                        let from = if has_from {
                            pt.get("curveFrom").map(point_to_point)
                        } else {
                            None
                        };
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
                    node.network = Some((network).into());
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
                let behaviour = layer
                    .get("textBehaviour")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                style.wrap = behaviour != 0;
                // Native sizing remains authoritative. The namespaced payload
                // preserves the independent kernel wrap switch, which Sketch
                // cannot express for fixed boxes. Ignore it after a native
                // sizing-mode or text edit; ordinary foreign files need no metadata.
                if let Some(own) = layer.pointer("/userInfo/com.futureox.design-kernel/textWrap") {
                    if own.get("textBehaviour").and_then(Value::as_i64) == Some(behaviour)
                        && own.get("text").and_then(Value::as_str) == Some(node.text.as_str())
                    {
                        if let Some(wrap) = own.get("wrap").and_then(Value::as_bool) {
                            style.wrap = wrap;
                        }
                    }
                }
                if matches!(behaviour, 0..=2) {
                    node.sizing = Some(crate::layout::Sizing {
                        width: if behaviour == 0 {
                            crate::layout::SizeMode::Hug
                        } else {
                            crate::layout::SizeMode::Fixed
                        },
                        height: if behaviour == 2 {
                            crate::layout::SizeMode::Fixed
                        } else {
                            crate::layout::SizeMode::Hug
                        },
                        ..Default::default()
                    });
                    if let Some(frame) = layer.get("frame") {
                        node.bindings
                            .insert("sketchSourceTextFrameRaw".into(), frame.to_string());
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
                        let a = run.get("attributes").unwrap_or(&Value::Null);
                        let start =
                            run.get("location").and_then(Value::as_u64).unwrap_or(0) as usize;
                        let len = run.get("length").and_then(Value::as_u64).unwrap_or(0) as usize;
                        let font_size = a
                            .get("MSAttributedStringFontAttribute")
                            .and_then(|f| f.get("attributes"))
                            .and_then(|f| f.get("size"))
                            .and_then(Value::as_f64);
                        let color = a.get("MSAttributedStringColorAttribute").map(|c| gradient_stop_color(c, self.color_space));
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
                        // Official TextTransform enum: 0=None, 1=Uppercase,
                        // 2=Lowercase — mapped per run into the kernel's
                        // authored text-case slot (rendered by text_case.rs).
                        let text_case = match a
                            .get("MSAttributedStringTextTransformAttribute")
                            .and_then(Value::as_i64)
                        {
                            Some(1) => Some(crate::font::TextCase::Upper),
                            Some(2) => Some(crate::font::TextCase::Lower),
                            _ => None,
                        };
                        let paragraph = a.get("paragraphStyle").or_else(||a.get("textStyleBasicParagraphStyle")).and_then(|p| {
                            let value = crate::font::TextParagraph {
                                align: alignment_from_code(p.get("alignment").and_then(Value::as_i64).unwrap_or(0)).into(),
                                minimum_line_height: p.get("minimumLineHeight").and_then(Value::as_f64).unwrap_or(0.),
                                maximum_line_height: p.get("maximumLineHeight").and_then(Value::as_f64).unwrap_or(0.),
                                spacing: p.get("paragraphSpacing").and_then(Value::as_f64).unwrap_or(0.),
                                indent: p.get("firstLineHeadIndent").and_then(Value::as_f64).unwrap_or(0.),
                            };
                            if value.validate().is_ok() { Some(value) } else { import_lossy.push("paragraph-values-outside-supported-range".into()); None }
                        });
                        node.text_runs.push(crate::font::TextRun {
                            paragraph,
                            text_case,
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
                            letter_spacing: None,
                            line_height: None,
                        });
                        // first run fills the defaults
                        if node.text_runs.len() == 1 {
                            if let Some(font) = node.text_runs[0].font_id.as_ref() {
                                style.font_id = font.clone();
                            }
                            if let Some(weight) = node.text_runs[0].weight {
                                style.weight = weight;
                            }
                            node.font_size = font_size.unwrap_or(14.);
                            // Attributed color supplies a fallback when no
                            // native style fill exists. Appending it to an
                            // existing fill leaves a duplicate paint that becomes
                            // active after range colors are cleared by editing.
                            if let Some(c) = &color && node.fills.is_empty() {
                                node.fills.push({
                                    let mut p = blank_paint("solid");
                                    p.color = c.to_string();
                                    p
                                });
                            }
                            // P0-2 (import side): paragraph + spacing keys
                            // from the same first run (22 号字典 §4)
                            if let Some(para) = a
                                .get("paragraphStyle")
                                .or_else(|| a.get("textStyleBasicParagraphStyle"))
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
                                    && px > 0. && node.font_size >= 1.
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
                                    // Both limits live on the paragraph run and are applied by Fonts.
                                    let _ = (lo, hi);
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
                                    node.bindings
                                        .insert("sketchTextAllowsTightening".into(), "1".into());
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
                            if let Some(vertical) = layer.pointer("/style/textStyle/verticalAlignment")
                                .or_else(||a.get("textStyleVerticalAlignmentKey")).and_then(Value::as_i64) {
                                match vertical {
                                    0 => style.vertical_align = "top".into(),
                                    1 => style.vertical_align = "center".into(),
                                    2 => style.vertical_align = "bottom".into(),
                                    _ => { node.bindings.insert("sketchTextVerticalAlignment".into(), vertical.to_string()); import_lossy.push("text-vertical-alignment-value-not-modeled".into()); }
                                }
                            }
                            if let Some(transform) =
                                a.get("MSAttributedStringTextTransformAttribute")
                            {
                                let active = transform.as_i64().is_some_and(|t| t != 0)
                                    || transform.as_bool() == Some(true);
                                node.bindings
                                    .insert("sketchTextTransform".into(), transform.to_string());
                                // 0/1/2 are mapped per run into TextRun.text_case;
                                // other payload shapes (bools, future enums) can
                                // only round-trip through the binding.
                                if active && transform.as_i64().is_none_or(|t| !matches!(t, 0..=2)) {
                                    import_lossy.push("text-transform-value-not-modeled".into());
                                }
                            }
                        }
                    }
                }
                // Equivalent unconstrained paragraphs need no new schema facet.
                if node.text_runs.iter().all(|r|r.paragraph.as_ref().is_none_or(|p|p.minimum_line_height==0. && p.maximum_line_height==0. && p.align==style.align && p.spacing==style.paragraph_spacing && p.indent==style.paragraph_indent)) {
                    for run in &mut node.text_runs {run.paragraph=None;}
                }
                if let Some(spacing) = raw_spacing_behaviour {
                    // Matches the exporter's derivation: a custom line height
                    // archives as 3 (自定义), everything else as the v2-era
                    // default 2. Deviations (e.g. 1 = v2 常基线) need the
                    // binding to round-trip.
                    let custom = style.line_height > 0. && (style.line_height - 1.35).abs() > 1e-9;
                    if spacing != if custom { 3 } else { 2 } {
                        node.bindings
                            .insert("sketchLineSpacingBehaviour".into(), spacing.to_string());
                    }
                }
                if node.text_runs.iter().any(|run| {
                    run.paragraph.as_ref().and_then(crate::font::TextParagraph::fixed_line_height).is_some()
                }) {
                    style.line_box_baseline = "nearest-point".into();
                }
                node.text_style = Some((style).into());
                let parsed_style_font = node.text_style.as_ref().map(|style| style.font_id.clone());
                let parsed_run_fonts: Vec<Option<String>> = node.text_runs.iter().map(|run| run.font_id.clone()).collect();
                if let Some(receipt) = user_ns.get("textModel")
                    && receipt.get("native") == Some(&native_text_projection(layer)) {
                    if let (Ok(saved_style),Ok(saved_runs)) = (
                        serde_json::from_value::<Option<crate::font::TextStyle>>(receipt["style"].clone()),
                        serde_json::from_value::<Vec<crate::font::TextRun>>(receipt["runs"].clone())) {
                        // A native editor can remove document-level identity metadata
                        // while retaining per-layer receipts. In that case the native
                        // PostScript descriptors own the font mapping, not dangling IDs.
                        let owned=|id:&str|id=="default"||self.available_fonts.contains(id)
                            ||node.text_style.as_ref().is_some_and(|s|s.font_id==id)
                            ||node.text_runs.iter().any(|r|r.font_id.as_deref()==Some(id));
                        if saved_style.as_ref().is_none_or(|s|owned(&s.font_id))
                            && saved_runs.iter().all(|r|r.font_id.as_deref().is_none_or(owned)) {
                            node.text_style=saved_style.map(Box::new); node.text_runs=saved_runs.into();
                            // The receipt stores the editable default face. An unshipped
                            // ABeeZee name in the native descriptor is still the request.
                            if let Some(style) = node.text_style.as_mut()
                                && style.font_id == "default"
                                && let Some(name) = parsed_style_font.filter(|name| crate::abeezee_font::absent_abeezee_diagnosis(name).is_some()) {
                                style.font_id = name;
                            }
                            for (run, parsed) in node.text_runs.iter_mut().zip(parsed_run_fonts) {
                                if run.font_id.as_deref().unwrap_or("default") == "default"
                                    && let Some(name) = parsed.filter(|name| crate::abeezee_font::absent_abeezee_diagnosis(name).is_some()) {
                                    run.font_id = Some(name);
                                }
                            }
                        }
                    }
                }
                // No authored min/max line box: Sketch uses the font's metrics.
                // Keep 1.35 stored so an explicit editor line height still wins.
                if let Some(style) = node.text_style.as_mut()
                    && (style.line_height - 1.35).abs() <= 1e-9
                    && node.text_runs.iter().all(|run| {
                        run.line_height.is_none()
                            && run.paragraph.as_ref().is_none_or(|paragraph| {
                                paragraph.minimum_line_height == 0.
                                    && paragraph.maximum_line_height == 0.
                            })
                    })
                {
                    style.line_height_auto = true;
                }
            }
            "bitmap" => {
                node.bindings.insert("sketchSourceBitmap".into(), "true".into());
                if let Some(uri) = self.image_ref(layer) {
                    node.fills.push({
                        let mut p = blank_paint("image");
                        p.image = Some(uri.into());
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
                    node.bindings.insert("sketchOverrideProperties".into(), raw);
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
                            let value =
                                match sketch_override_value_from_native(self.files, self.source_bitmaps, field, &raw) {
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
                    node.instance = Some((crate::components::Instance {
                        slot_contents: Default::default(),
                        component_id: symbol_id.into(),
                        overrides,
                        property_values: BTreeMap::new(),
                    }).into());
                }
            }
            "artboard" | "frame" | "canvasFrame" => {
                if bool_at(layer, "hasBackgroundColor")
                    && let Some(bg) = layer.get("backgroundColor")
                {
                    node.fills.insert(0, solid_paint(bg, 1., "normal", self.color_space));
                }
                import_layout_grid(&mut node, layer, &mut import_lossy);
            }
            "hotspot" => {
                node.fills.clear(); node.strokes.clear(); node.effects.clear();
                node.bindings.insert("sketchSourceHotspot".into(), "true".into());
                // Hotspots are bare MSLayers whose prototype semantics live in
                // the flow payload (03-layer-tree.md: MSImmutableHotspotLayer,
                // no style) and the kernel model has no hotspot entity. Keep
                // the limited "hotspot" kind, stash the raw layer so re-export
                // is lossless, and mark the degradation explicitly — never
                // silently masquerade as a frame.
                if let Ok(raw) = serde_json::to_string(layer) {
                    node.bindings.insert("sketchRawLayer".into(), raw);
                }

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
            node.component = Some((c).into());
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
            if let Ok(instance) =
                serde_json::from_value::<crate::components::Instance>(instance.clone())
            {
                node.instance = Some((instance).into());
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
            node.layout_grid = Some((g).into());
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
        if let Some(flow) = layer.get("flow").filter(|f| !f.is_null())
        {
            self.flows.push((id.clone(), flow.clone()));
        }
        if bool_at(layer, "isFlowHome") && self.flow_home.is_none() {
            self.flow_home = Some(id.clone());
        }

        if bool_at(layer, "shouldBreakMaskChain") {
            node.mask_chain = Some(crate::scene::MaskChain::Break);
        }
        if bool_at(layer, "hasClippingMask") {
            node.mask = true;
            // Sketch's outline clips to the layer path even when it has no
            // fill. The alpha mode instead reads the rendered mask pixels.
            let alpha = layer.get("clippingMaskMode").and_then(Value::as_f64).unwrap_or(0.) != 0.;
            node.mask_type = Some(if alpha { "alpha" } else { "shape" }.into());
            if alpha && node.mask_chain.is_none() {
                node.mask_chain = Some(crate::scene::MaskChain::Start);
            }
        }

        // resizingConstraint 6-bit: X=low 3, Y=high 3 (22 号字典,BCConstraint and/ubfx 实证).
        // 63 = 0b111111 is the measured default on ordinary layers (1,860
        // occurrences) and must NOT become a kernel constraint rule.
        if let Some(rc) = layer
            .get("resizingConstraint")
            .and_then(Value::as_u64)
            .filter(|rc| *rc != 63 || bool_at(layer,"hasExplicitConstraints"))
        {
            let x = rc & 0x7;
            let y = (rc >> 3) & 0x7;
            node.constraints = Some(crate::layout::Constraints {
                horizontal: constraint_anchor(x),
                vertical: constraint_anchor(y),
                reference_width: None,
                reference_height: None,
            });
            node.bindings.insert("sketchLegacyConstraints".into(), json!({"mask":rc,"model":node.constraints}).to_string());
            if [x,y].iter().any(|bits|matches!(bits,3|5|6)) {
                import_lossy.push("legacy-mixed-flex-constraints-require-native-resize".into());
            }
        }
        // Sketch 2025 modern layout keys (horizontalPins/verticalPins uint
        // masks, horizontalSizing/verticalSizing enums, per-child flexItem),
        // archived under plain/`_`/`__` ivar spellings (08-layout.md; the
        // double-underscore pair is the documented ivar mapping). The public
        // file-format schema does not publish these enums yet — only the
        // legacy 6-bit mask is decoded (22 号字典 §2) — so non-default values
        // are preserved verbatim under their original spelling for lossless
        // round-trip instead of guessed into kernel constraints.
        {
            let mut modern = Map::new();
            for key in [
                "horizontalPins",
                "verticalPins",
                "horizontalSizing",
                "verticalSizing",
                "flexItem",
            ] {
                let found = [format!("__{key}"), format!("_{key}"), key.to_string()]
                    .iter()
                    .find_map(|spelling| {
                        layer
                            .get(spelling)
                            .filter(|v| {
                                v.as_u64().is_none_or(|n| n != 0) && !v.is_null()
                            })
                            .map(|v| (spelling.clone(), v.clone()))
                    });
                if let Some((spelling, value)) = found {
                    modern.insert(spelling, value);
                }
            }
            if !modern.is_empty() {
                node.bindings.insert(
                    "sketchModernLayout".into(),
                    json!(&modern).to_string(),
                );
                let mut modeled = Vec::<String>::new();
                for (spelling,value) in &modern {
                    let key = spelling.trim_start_matches('_');
                    let Some(code) = value.as_u64() else { continue };
                    let axis = key.starts_with("vertical");
                    if key.ends_with("Sizing") {
                        let mode = match code { 0=>Some(crate::layout::SizeMode::Fixed), 1=>Some(crate::layout::SizeMode::Hug), 2=>Some(crate::layout::SizeMode::Fill), _=>None };
                        if let Some(mode)=mode {
                            // Hug is meaningful only for text/container contents.
                            if mode == crate::layout::SizeMode::Hug && !matches!(node.kind.as_str(),"text"|"frame"|"group"|"section") {continue}
                            let sizing=node.sizing.get_or_insert_with(Default::default);
                            if axis {sizing.height=mode} else {sizing.width=mode}
                            modeled.push(spelling.clone());
                        }
                    } else if key.ends_with("Pins") {
                        let anchor=match code {1=>Some(crate::layout::Anchor::Start),4=>Some(crate::layout::Anchor::End),5=>Some(crate::layout::Anchor::Stretch),_=>None};
                        if let Some(anchor)=anchor {
                            let c=node.constraints.get_or_insert_with(Default::default);
                            if axis {c.vertical=anchor} else {c.horizontal=anchor}
                            modeled.push(spelling.clone());
                        }
                    }
                }
                if modeled.len()!=modern.len() {import_lossy.push("modern-layout-untranslated-fields-retained".into());}
                if !modeled.is_empty() {node.bindings.insert("sketchModernLayoutModeled".into(),json!(modeled).to_string());}
            }
        }
        if let Some(formats) = layer
            .get("exportOptions")
            .and_then(|e| e.get("exportFormats"))
            .and_then(Value::as_array)
        {
            for (index, f) in formats.iter().enumerate() {
                let format = f
                    .get("fileFormat")
                    .and_then(Value::as_str)
                    .unwrap_or("png")
                    .to_lowercase();
                let scale = f.get("scale").and_then(Value::as_f64).unwrap_or(1.);
                // Positive-scale TIFF and HEIC are executable exports. EPS and the
                // Sketch absolute-size sentinel (scale 0) stay source-only.
                if format == "eps" || scale == 0. {
                    import_lossy.push("export-setting-preserved-without-local-render-support".into());
                }
                node.export_settings.push(ExportSetting {
                    id: format!("sketch-export-{index}"),
                    format,
                    scale,
                    suffix: f
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                });
                let mut fields = f.as_object().cloned().unwrap_or_default();
                for key in ["_class", "fileFormat", "scale", "name"] {
                    fields.remove(key);
                }
                if !fields.is_empty() {
                    let mut retained = node.bindings.get("sketchExportFormatFields")
                        .and_then(|raw| serde_json::from_str::<Vec<Value>>(raw).ok())
                        .unwrap_or_default();
                    retained.push(json!({"index":index,"fields":fields}));
                    node.bindings.insert("sketchExportFormatFields".into(),serde_json::to_string(&retained).unwrap());
                }
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
                "windingRule":style.get("windingRule").or_else(||layer.get("windingRule")).and_then(Value::as_i64).unwrap_or(1),
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
        if let Some(info)=layer.get("userInfo").and_then(Value::as_object) {
            let plugin:Map<String,Value>=info.iter().filter(|(key,_)|key.as_str()!="com.futureox.design-kernel").map(|(k,v)|(k.clone(),v.clone())).collect();
            if !plugin.is_empty() {node.bindings.insert("sketchPluginUserInfo".into(),json!(plugin).to_string());}
        }
        adaptable_capture(&mut node);
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
        node.layout_grid = Some((crate::scene::LayoutGrid {
            axis: if row { "row".into() } else { "column".into() },
            count,
            gutter,
            margin,
            color: "#ff0000".into(),
            visible: true,
            opacity: 0.1,
        }).into());
    } else if let Some(sg) = layer.get("grid").filter(|g| bool_at(g, "isEnabled")) {
        let cell = f64_at(sg, "gridSize").max(1.);
        let count = ((node.width.max(1.) / cell).floor() as u32).clamp(1, 64);
        let remainder = node.width - count as f64 * cell;
        if remainder.abs() > 1e-6 {
            notes(lossy, "simple-grid-alignment-centered");
        }
        notes(lossy, "simple-grid-thickGridTimes-omitted");
        notes(lossy, "layout-grid-color-not-in-sketch-document");
        node.layout_grid = Some((crate::scene::LayoutGrid {
            axis: "uniform".into(),
            count,
            gutter: 0.,
            margin: (remainder / 2.).max(0.),
            color: "#ff0000".into(),
            visible: true,
            opacity: 0.1,
        }).into());
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
            let mut source=entry.clone();
            if let Some(map)=source.get_mut("remoteToLocalIDMap").and_then(Value::as_object_mut) {
                for local in map.values_mut() {
                    if let Some(id)=local.as_str().and_then(|id|importer.uuids.get(&id.to_ascii_uppercase())) { *local=json!(id); }
                }
            }
            if let Ok(raw) = serde_json::to_string(&source) {
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
        let Some(objects) = document
            .get(container)
            .and_then(|c| c.get("objects"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for object in objects {
            let Some(wire) = object.get("do_objectID").and_then(Value::as_str) else {
                continue;
            };
            if !wire_ids.insert(wire) {
                return Err(Error::MalformedJson(
                    "duplicate shared style wire ID across definitions".into(),
                ));
            }
            let resolved = match aliases.and_then(|ids| ids.get(wire)) {
                Some(value) => value.as_str().filter(|id| !id.is_empty()).ok_or_else(|| {
                    Error::MalformedJson("invalid shared style original-ID mapping".into())
                })?,
                None => wire,
            };
            if !resolved_ids.insert(resolved) {
                return Err(Error::MalformedJson(
                    "duplicate resolved shared style ID across definitions".into(),
                ));
            }
        }
    }
    Ok(())
}

pub fn import_sketch(bytes: &[u8]) -> Result<Document> {
    let files =
        crate::sketch::archive::read(bytes).map_err(|e| Error::Unsupported(e.to_string()))?;
    import_sketch_files(&files)
}

fn import_sketch_files(files: &BTreeMap<String, Vec<u8>>) -> Result<Document> {
    let meta = json_part(files, "meta.json")?;
    let document = json_part(files, "document.json")?;
    let mut page_index: BTreeMap<String, Value> = BTreeMap::new();
    for (name, data) in files {
        if let Some(page_id) = name
            .strip_prefix("pages/")
            .and_then(|n| n.strip_suffix(".json"))
        {
            let value = serde_json::from_slice::<Value>(data)
                .map_err(|e| Error::MalformedJson(format!("{name}: {e}")))?;
            page_index.insert(page_id.into(), value);
        }
    }

    import_sketch_parts(files, &meta, &document, &page_index,None,&Default::default())
}

// Both archive and native-source imports execute the same semantic codec.
// Parsed native windows borrow their values instead of serializing and then
// parsing the complete layer tree again.
fn import_sketch_parts(files: &BTreeMap<String, Vec<u8>>, meta: &Value,
    document: &Value, page_index: &BTreeMap<String, Value>,page_references:Option<&Value>,source_bitmaps:&SourceBitmapRefs) -> Result<Document> {
    validate_sketch_shared_style_ids(&document)?;

    let mut doc = Document {
        reviews: Vec::new(),
        design_system: None,
        prototype: None,
        fd_compatibility: None,
        schema_version: 1,
        color_management: None,
        raster_profile: None,
        id: document.get("do_objectID").and_then(Value::as_str).filter(|v|!v.is_empty()).map(|v|sketch_id(v).to_lowercase()).unwrap_or_else(||"imported-sketch".into()),
        name: meta
            .get("appVersion")
            .and_then(Value::as_str)
            .map(|v| format!("Imported from Sketch {v}"))
            .unwrap_or_else(|| "Imported from Sketch".into()),
        pages: Vec::new(),
        nodes: Default::default(),
        fonts: BTreeMap::new(),
        animations: Vec::new(),
    };

    // Restore private text identities only when this archive still owns their resources.
    let font_aliases=crate::interop_resources::import_fonts(document, files, &mut doc)?;
    let mut importer = Importer {
        source_bitmaps,
        image_sources: Default::default(),
        available_fonts: doc.fonts.keys().cloned().collect(),
        color_space: if document.get("colorSpace").and_then(Value::as_i64) == Some(2) {
            ColorSpace::DisplayP3
        } else {
            ColorSpace::Srgb
        },
        files: &files,
        nodes: BTreeMap::new(),
        uuids: BTreeMap::new(),
        flows: Vec::new(),
        has_user_prototype: std::collections::HashSet::new(),
        flow_home: None,
    };
    // Native page order is authored data. Resolve archive identities directly;
    // originalId only renames the resulting kernel identity, never its file.
    let mut ordered = Vec::new();
    if let Some(refs) = page_references.or_else(||document.get("pages")).and_then(Value::as_array) {
        for reference in refs {
            let reference = reference
                .get("_ref")
                .and_then(Value::as_str)
                .ok_or_else(|| Error::MalformedJson("page reference requires _ref".into()))?;
            let file_id = reference
                .trim_start_matches("pages/")
                .trim_end_matches(".json");
            let page = page_index
                .get(file_id)
                .ok_or_else(|| Error::MissingPart(format!("pages/{file_id}.json")))?;
            let kernel_id = page
                .get("userInfo")
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

    let mut ruler_pages: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    for (file_id, kernel_id, page_name) in ordered {
        let page_json = page_index
            .get(&file_id)
            .ok_or_else(|| Error::MissingPart(format!("pages/{file_id}.json")))?;
        let mut page_node = crate::facet::sample_node(&kernel_id, "page");
        page_node.name = page_name.clone();
        let mut children = Vec::new();
        if let Some(layers) = page_json.get("layers").and_then(Value::as_array) {
            for layer in layers {
                children.push(importer.layer(layer));
            }
        }
        page_node.children = children.clone();
        // Ruler guides (03-layer-tree.md `_horizontalRulerData`): the
        // horizontal ruler archives vertical guide lines (x positions) and
        // the vertical ruler horizontal ones (y positions). The kernel
        // models {id, axis, position}; guide colors and other ruler payload
        // survive in the raw rulerData container keyed by page id.
        let mut guides = Vec::new();
        let mut ruler_raw = Map::new();
        for (data_key, axis) in [("horizontalRulerData", "x"), ("verticalRulerData", "y")] {
            let Some(data) = page_json.get(data_key) else {
                continue;
            };
            ruler_raw.insert(data_key.to_string(), data.clone());
            let Some(list) = data.get("guides").and_then(Value::as_array) else {
                continue;
            };
            for (i, guide) in list.iter().enumerate() {
                if let Some(position) = guide
                    .get("pos")
                    .and_then(Value::as_f64)
                    .filter(|p| p.is_finite() && p.abs() <= 1e7)
                {
                    guides.push(crate::scene::RulerGuide {
                        id: format!("sketch-guide-{file_id}-{axis}-{i}"),
                        axis: axis.into(),
                        position,
                    });
                }
            }
        }
        if guides.len() > 1000 {
            page_node.bindings.insert(
                "sketchGuidesTruncated".into(),
                (guides.len() - 1000).to_string(),
            );
            guides.truncate(1000);
        }
        if !ruler_raw.is_empty() {
            ruler_pages
                .entry(kernel_id.clone())
                .or_default()
                .extend(ruler_raw);
        }
        importer.nodes.insert(kernel_id.clone(), page_node);
        doc.pages.push(Page {
            guides,
            id: kernel_id,
            name: page_name,
            children,
            background: "#ffffff".into(),
        });
    }
    // P0-4: color space (document.json colorSpace: 0 unmanaged, 1 sRGB, 2 P3).
    // Sketch composites in the encoded document space. Treating colorSpace 1 as
    // linear management blends a 50% dark fill on white to about
    // RGB(190,190,189) instead of Sketch's encoded RGB(150,150,148). Only an
    // archive this editor marked `linearSrgbComposite` restores linear sRGB.
    let mut sketch_encoded_srgb = false;
    match document.get("colorSpace").and_then(Value::as_i64) {
        Some(1) => {
            let linear = document
                .pointer("/userInfo/com.futureox.design-kernel/linearSrgbComposite")
                .and_then(Value::as_bool)
                == Some(true);
            if linear {
                doc.color_management = Some(crate::color::ColorSettings::default());
            } else {
                sketch_encoded_srgb = true;
            }
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
    // Foreign library styles carry an embedded localSharedStyle. Admit that
    // definition so a layerStyle/textStyle override can resolve by either the
    // local id or the remote id. The raw foreign container stays untouched.
    let mut style_inputs: Vec<(&str, &Value, bool, Option<&str>)> = Vec::new();
    for (container, kind) in [("layerStyles", "paint"), ("layerTextStyles", "text")] {
        if let Some(objects) = document
            .get(container)
            .and_then(|c| c.get("objects"))
            .and_then(Value::as_array)
        {
            for object in objects {
                style_inputs.push((kind, object, false, None));
            }
        }
    }
    for (container, kind) in [("foreignLayerStyles", "paint"), ("foreignTextStyles", "text")] {
        if let Some(entries) = document.get(container).and_then(Value::as_array) {
            for entry in entries {
                if let Some(object) = entry.get("localSharedStyle").filter(|value| value.is_object())
                {
                    style_inputs.push((
                        kind,
                        object,
                        true,
                        entry.get("remoteStyleID").and_then(Value::as_str),
                    ));
                }
            }
        }
    }
    let mut style_aliases: Map<String, Value> = Map::new();
    for (kind, object, foreign, remote_id) in style_inputs {
            let Some(style_id) = object.get("do_objectID").and_then(Value::as_str) else {
                continue;
            };
            let name = object
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let style_id = document
                .pointer("/userInfo/com.futureox.design-kernel/sharedStyleIds")
                .and_then(|ids| ids.get(style_id))
                .and_then(Value::as_str)
                .unwrap_or(style_id);
            let style_object = object
                .get("value")
                .or_else(|| object.get("style"))
                .cloned()
                .unwrap_or(Value::Null);
            // Full Sketch layer styles carry borders/shadows next to their
            // fills (22 号字典 §6); they survive as paint-style parts.
            let mut strokes = Vec::new();
            let mut effects = Vec::new();
            let mut style_lossy: Vec<String> = Vec::new();
            if kind == "paint" && !style_object.is_null() {
                strokes = importer.strokes(&style_object, [1., 1.], &mut style_lossy);
                effects = restored_effect_model(object, &style_object)
                    .unwrap_or_else(|| importer.effects(&style_object, true, None));
                for blur in sketch_blurs(&style_object).into_iter().filter(|blur| sketch_blur_enabled(blur)) {
                    if let Some(note) = sketch_progressive_note(blur, None) {
                        style_lossy.push(note.into());
                    }
                }
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
            if !style_lossy.is_empty() {
                // Shared styles have no node bindings; marker degradations
                // ride the fidelity map so export round-trips stay honest.
                fidelity.push(("importLossy".into(), serde_json::to_string(&style_lossy).unwrap_or_default()));
            }
            let mut colors = Map::new();
            let mut swatches = Map::new();
            let mut entry = Map::new();
            for (key, raw) in fidelity {
                if key == "updatableColors" || key == "importLossy" {
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
            // Every shared style keeps the admitted paint/text model, including
            // styles with no adaptable-color payload. Export uses it to notice
            // an edit without rewriting an unchanged foreign definition.
            entry.insert("model".into(), json!({"value":value,"strokes":strokes,"effects":effects}));
            style_fidelity.insert(style_id.to_string(), Value::Object(entry));
            let admitted = crate::design_system::SharedStyle {
                name,
                kind: kind.into(),
                value,
                strokes,
                effects,
            };
            if let Some(existing) = styles.get(style_id) {
                if existing != &admitted {
                    return Err(Error::MalformedJson(format!(
                        "duplicate shared style ID {style_id}"
                    )));
                }
            } else {
                styles.insert(style_id.to_string(), admitted);
            }
            if foreign && let Some(remote) = remote_id.filter(|id| !id.is_empty()) {
                let alias = remote.to_ascii_uppercase();
                if let Some(previous) = style_aliases.get(&alias) && previous != &json!(style_id) {
                    return Err(Error::MalformedJson(format!("duplicate shared style alias {remote}")));
                }
                style_aliases.insert(alias, json!(style_id));
            }
        }
    // P1-13: document-level containers without a kernel-native home
    // (design_system has no swatch concept) ride the raw container store;
    // the shared-style fidelity map joins them under a fixed key.
    let mut sketch_containers: BTreeMap<String, Value> = BTreeMap::new();
    if sketch_encoded_srgb {
        sketch_containers.insert("sketchDocumentColorSpace".into(), json!(1));
    }
    if let Some(ids) = document.pointer("/userInfo/com.futureox.design-kernel/sharedStyleIds") {
        sketch_containers.insert("sharedStyleIds".into(), ids.clone());
    }
    if !style_aliases.is_empty() {
        sketch_containers.insert("sketchStyleAliases".into(), Value::Object(style_aliases));
    }
    for key in [
        "assets",
        "sharedSwatches",
        "foreignLayerStyles",
        "foreignTextStyles",
        "foreignSwatches",
        "foreignStyles",
        "libraries",
        "perDocumentLibraries",
        "sketchCheckedLibraries",
    ] {
        if let Some(value) = document.get(key).filter(|v| !v.is_null()) {
            // Every document.json carries a default (empty) assets
            // collection; keep it only when it actually holds content so
            // ordinary round-trips do not grow a redundant container.
            let meaningful = key != "assets"
                || value
                    .as_object()
                    .is_some_and(|map| {
                        map.values().any(|v| {
                            v.as_array().is_some_and(|a| !a.is_empty())
                                || v.as_object().is_some_and(|o| !o.is_empty())
                        })
                    });
            if meaningful {
                sketch_containers.insert(key.to_string(), value.clone());
            }
        }
    }
    if !ruler_pages.is_empty() {
        sketch_containers.insert(
            "rulerData".into(),
            Value::Object(
                ruler_pages
                    .into_iter()
                    .map(|(page, raw)| (page, Value::Object(raw)))
                    .collect(),
            ),
        );
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
    // Embedded library definitions need an owned graph root before editable
    // admission. They remain native foreign resources when exported.
    let owned: std::collections::BTreeSet<&str> = doc.pages.iter().flat_map(|p|p.children.iter().map(String::as_str))
        .chain(importer.nodes.values().flat_map(|n|n.children.iter().map(String::as_str))).collect();
    let foreign_roots: Vec<String> = importer.nodes.values().filter(|n|n.bindings.contains_key("sketchForeignLibraryID") && !owned.contains(n.id.as_str())).map(|n|n.id.clone()).collect();
    if !foreign_roots.is_empty() {
        doc.pages.push(Page{id:sketch_id(&format!("{}-foreign-symbols",doc.id)),name:"Library Symbols".into(),children:foreign_roots,background:"#ffffff".into(),guides:vec![]});
    }

    if let Some(font_metadata)=doc.design_system.take() {
        sketch_containers.extend(font_metadata.sketch_containers);
    }
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
    doc.nodes = importer.nodes.into();
    crate::interop_resources::remap_fonts(&font_aliases, &mut doc)?;
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
        doc.design_system
            .get_or_insert_with(Default::default)
            .sketch_containers
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
        let back = payload.get("destinationArtboardID").and_then(Value::as_str)==Some("back");
        let destination = payload
            .get("destinationArtboardID")
            .and_then(Value::as_str)
            .map(str::to_ascii_uppercase)
            .and_then(|uuid| importer.uuids.get(&uuid).cloned());
        if !back && destination.is_none()
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
        let transition_style = if back { None } else if !overlay {
            match payload.get("animationType").and_then(Value::as_i64).unwrap_or(-1) {
                -1=>Some("none".into()), 0=>Some("slide-right".into()), 1=>Some("slide-left".into()),
                2=>Some("slide-bottom".into()), 3=>Some("slide-top".into()),
                other=>{notes.push(format!("flow-animationType={other}")); None}
            }
        } else { if payload.get("animationType").and_then(Value::as_i64).is_some_and(|v|v!=-1) {notes.push("flow-overlay-animation-unmapped".into());} None };
        let duration_ms=if transition_style.as_deref()==Some("none") {0} else if duration_ms==0 && transition_style.is_some() {300} else {duration_ms};
        if destination.is_some() || back {
            node.bindings.insert("sketchFlowModeled".into(), "true".into());
            interactions
                .entry(node_id.clone())
                .or_default()
                .push(crate::prototype::Interaction {
                    trigger: "click".into(),
                    actions: vec![crate::prototype::Action {
                        kind: if back { "back" } else if overlay { "overlay" } else { "navigate" }.into(),
                        target: destination,
                        transition_style,
                        transition_preserve_scroll: payload.get("maintainScrollPosition").and_then(Value::as_bool),
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
    if doc.nodes.values().any(|n| n.effects.iter().any(|e| e.glass.is_some())) { version=version.max(5); }
    if doc.color_management.is_some() {
        version = version.max(3);
    }
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
    if crate::stroke::has_markers(&doc) || doc.nodes.values().any(|n| !n.export_settings.is_empty())
    {
        version = version.max(8);
    }
    if doc
        .nodes
        .values()
        .any(|n| n.arc.is_some() || n.corner_radius != 0. || n.constrain_proportions)
    {
        version = version.max(7);
    }
    if doc.nodes.values().any(|n| {
        n.kind == "slice"
            || n.export_settings
                .iter()
                .any(|s| !matches!(s.format.as_str(), "png" | "svg"))
    }) {
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
    // ruler guides (scene.rs validate_guides) and pattern tiling
    // (Paint.tile) gate on schema 11 / 14 respectively
    if doc.pages.iter().any(|p| !p.guides.is_empty()) {
        version = version.max(11);
    }
    if doc.nodes.values().any(|n| {
        n.fills.iter().any(|p| p.tile.is_some())
            || n.strokes.iter().any(|s| s.paint.tile.is_some())
    }) {
        version = version.max(14);
    }
    if doc.nodes.values().any(|node| node.effects.iter().any(|effect| effect.gradient_blur.is_some())) {
        version = version.max(9);
    }
    if doc.requires_schema17() { version=version.max(17); }
    if doc.requires_schema18() { version=version.max(18); }
    if doc.requires_schema20() { version=version.max(20); }
    if doc.requires_schema19() { version=version.max(19); }
    if doc.requires_schema22() { version=version.max(22); }
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

fn clip_id(value: &str) -> String {
    value.chars().take(128).collect()
}

fn checked_library_note(document: &Document) -> String {
    let Some(entries) = document
        .design_system
        .as_ref()
        .and_then(|system| system.sketch_containers.get("sketchCheckedLibraries"))
        .and_then(Value::as_array)
    else {
        return String::new();
    };
    if entries.is_empty() {
        return String::new();
    }
    let listed = entries
        .iter()
        .filter_map(|entry| {
            let id = entry.get("documentId").and_then(Value::as_str).unwrap_or("unknown");
            let name = entry.get("name").and_then(Value::as_str).unwrap_or(id);
            Some(format!("{name}（documentID {id}）"))
        })
        .collect::<Vec<_>>()
        .join("、");
    let unchecked = entries
        .iter()
        .filter_map(|entry| entry.get("unchecked").and_then(Value::as_array))
        .flat_map(|items| items.iter().filter_map(Value::as_str))
        .take(8)
        .collect::<Vec<_>>()
        .join("、");
    if unchecked.is_empty() {
        format!("已核对本地库 {listed}。")
    } else {
        format!("已核对本地库 {listed}。以下库成员超过现有条目上限，未展开，不能据此判定定义缺失：{unchecked}。不会提高预算。")
    }
}

fn recorded_libraries(document: &Document) -> String {
    let Some(entries) = document
        .design_system
        .as_ref()
        .and_then(|system| system.sketch_containers.get("perDocumentLibraries"))
        .and_then(Value::as_array)
    else {
        return String::new();
    };
    let listed = entries
        .iter()
        .filter_map(|entry| {
            let name = entry.get("name").and_then(Value::as_str)?;
            let id = entry.get("documentID").and_then(Value::as_str).unwrap_or("");
            Some(if id.is_empty() { name.to_owned() } else { format!("{name}（documentID {id}）") })
        })
        .collect::<Vec<_>>();
    if listed.is_empty() {
        String::new()
    } else {
        format!("文档记录的外部库：{}。", listed.join("、"))
    }
}

fn resolve_shared_style<'a>(document: &'a Document, id: &str) -> Option<(String, &'a crate::design_system::SharedStyle)> {
    let system = document.design_system.as_ref()?;
    if let Some((key, style)) = system.styles.get_key_value(id) {
        return Some((key.clone(), style));
    }
    if let Some((key, style)) = system.styles.iter().find(|(key, _)| key.eq_ignore_ascii_case(id)) {
        return Some((key.clone(), style));
    }
    let alias = system
        .sketch_containers
        .get("sketchStyleAliases")
        .and_then(|aliases| aliases.get(&id.to_ascii_uppercase()))
        .and_then(Value::as_str)?;
    system.styles.get(alias).map(|style| (alias.to_owned(), style))
}

fn shared_style_override(
    document: &Document,
    native_field: &str,
    style_id: &str,
    instance_name: &str,
    instance_id: &str,
    full_path: &str,
) -> Result<(String, Value)> {
    let expected = if native_field == "textStyle" { "text" } else { "paint" };
    let Some((id, style)) = resolve_shared_style(document, style_id) else {
        let checked = checked_library_note(document);
        let place = node_location(document, instance_id);
        let repair = if checked.contains("未展开") {
            "修复：先提供一份条目上限内、且包含该共享样式 ID 的库文件。未展开的成员不算已核对，也不会被当成缺失。不会发明样式，也不会丢弃该覆盖。"
        } else if checked.is_empty() {
            "修复：打开前定位并附上包含该共享样式 ID 的本地 .sketch 库。不会发明样式，也不会丢弃该覆盖。真实定义缺失时打开保持阻断，源文件保持不变。"
        } else {
            "其中没有这个共享样式 ID。上游样式定义缺失，打开保持阻断。不会发明样式，也不会丢弃该覆盖。"
        };
        return Err(Error::Unsupported(format!(
            "Sketch shared {native_field} `{id}` is not embedded。这是缺失的外部库样式定义，不是无法映射的字段，也不是损坏的图层路径。实例「{name}」（{instance}）的覆盖 `{path}_{native_field}` 指向该样式，但 layerStyles、layerTextStyles 和 foreignLayerStyles、foreignTextStyles 都没有它。{place}{recorded}{checked}{repair}",
            id = clip_id(style_id),
            name = clip_id(instance_name),
            instance = clip_id(instance_id),
            path = clip_id(full_path),
            place = place,
            recorded = recorded_libraries(document),
            checked = checked,
            repair = repair
        )));
    };
    if style.kind != expected {
        return Err(Error::Unsupported(format!(
            "Sketch shared {native_field} `{id}` 的种类是 {}，不能当作{}使用。这是样式种类不匹配的损坏引用，不会改挂到其他样式上。",
            style.kind,
            if expected == "paint" { "图层样式" } else { "文本样式" },
            id = clip_id(style_id)
        )));
    }
    let field = if expected == "text" { "textStyle" } else { "fills" };
    Ok(("styleRefs".into(), json!({ field: id })))
}

fn layer_style_parts(document: &Document, style: &Value) -> Result<(Value, Value, Value)> {
    let files = BTreeMap::new();
    let bitmaps = SourceBitmapRefs::new();
    let color_space = document
        .color_management
        .as_ref()
        .map(|settings| settings.document_space)
        .unwrap_or(ColorSpace::Srgb);
    let importer = Importer {
        source_bitmaps: &bitmaps,
        image_sources: Default::default(),
        available_fonts: Default::default(),
        color_space,
        files: &files,
        nodes: BTreeMap::new(),
        uuids: BTreeMap::new(),
        flows: Vec::new(),
        has_user_prototype: Default::default(),
        flow_home: None,
    };
    let mut lossy = Vec::new();
    for key in ["fills", "borders"] {
        let Some(parts) = style.get(key).and_then(Value::as_array) else { continue };
        for part in parts {
            if bool_at(part, "isEnabled") && importer.paint_part(part, 1., "normal", [1., 1.]).is_none() {
                return Err(Error::Unsupported(format!(
                    "Sketch override `layerStyle` 的启用{key}无法转换成可编辑绘制属性。不会跳过该部分，也不会关闭无损保护；请保留原始 .sketch 文件。"
                )));
            }
        }
    }
    let fills = importer.paints(style, "fills", [1., 1.]);
    let strokes = importer.strokes(style, [1., 1.], &mut lossy);
    let effects = importer.effects(style, false, None);
    Ok((
        serde_json::to_value(&fills).map_err(|e| Error::MalformedJson(e.to_string()))?,
        serde_json::to_value(&strokes).map_err(|e| Error::MalformedJson(e.to_string()))?,
        serde_json::to_value(&effects).map_err(|e| Error::MalformedJson(e.to_string()))?,
    ))
}

fn is_layer_style_dict(value: &Value) -> bool {
    value.get("_class").and_then(Value::as_str) == Some("style")
        || value.get("fills").and_then(Value::as_array).is_some()
        || value.get("borders").and_then(Value::as_array).is_some()
        || value.get("shadows").and_then(Value::as_array).is_some()
}

fn push_override(overrides: &mut crate::components::Overrides, key: String, field: String, value: Value) -> Result<()> {
    let slot = overrides.entry(key).or_default();
    if field == "styleRefs" {
        let incoming = value.as_object().cloned().ok_or_else(|| {
            Error::Unsupported("Sketch style override is not an object".into())
        })?;
        let existing = slot.entry("styleRefs".into()).or_insert_with(|| json!({}));
        let object = existing.as_object_mut().ok_or_else(|| {
            Error::Unsupported("Sketch style override is not an object".into())
        })?;
        for (name, next) in incoming {
            if let Some(previous) = object.get(&name) && previous != &next {
                return Err(Error::Unsupported(
                    "ambiguous Sketch overrides map to the same property".into(),
                ));
            }
            object.insert(name, next);
        }
        return Ok(());
    }
    if slot.insert(field, value).is_some() {
        return Err(Error::Unsupported(
            "ambiguous Sketch overrides map to the same property".into(),
        ));
    }
    Ok(())
}

fn native_override_path(document: &Document, root: &str, path: &str) -> std::result::Result<String, String> {
    let mut scope = root.to_owned();
    let mut keys = Vec::new();
    let parts: Vec<_> = path.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        return Err(path.to_owned());
    }
    for (index, part) in parts.iter().enumerate() {
        let mut pending = vec![scope.clone()];
        let mut found = None;
        let mut visited = std::collections::BTreeSet::new();
        while let Some(id) = pending.pop() {
            if !visited.insert(id.clone()) || visited.len() > 20000 {
                return Err((*part).to_owned());
            }
            let Some(node) = document.nodes.get(&id) else {
                return Err((*part).to_owned());
            };
            if id.eq_ignore_ascii_case(part) {
                found = Some(node);
                break;
            }
            if id == scope || node.instance.is_none() {
                pending.extend(node.children.iter().cloned());
            }
        }
        let Some(node) = found else {
            return Err((*part).to_owned());
        };
        if index + 1 == parts.len() {
            keys.push(if node.id == root {
                "$root".to_owned()
            } else {
                node.component_key.as_ref().unwrap_or(&node.id).clone()
            });
        } else if let Some(instance) = &node.instance {
            keys.push(node.component_key.as_ref().unwrap_or(&node.id).clone());
            scope = instance.component_id.clone();
        } else {
            scope = node.id.clone();
        }
    }
    Ok(keys.join("/"))
}

fn unresolved_override_message(document: &Document, full_path: &str, missing: &str, instance_name: &str, instance_id: &str, master_id: &str) -> String {
    let master = document.nodes.get(master_id);
    let master_name = master.map(|node| node.name.as_str()).unwrap_or("");
    let master_symbol = master.and_then(|node| node.bindings.get("symbolID")).map(String::as_str).unwrap_or("");
    let elsewhere = document.nodes.keys().any(|id| id.eq_ignore_ascii_case(missing));
    let location = if elsewhere {
        "该 ID 存在于文档的其他图层，但不属于这个符号的可覆盖子树，因此不能改挂到别的组件上。"
    } else {
        "文档其他位置也没有这个图层。"
    };
    format!(
        "Sketch override target `{path}` could not be resolved。这是损坏的覆盖引用，不是缺失的外部库符号，也不是无法映射的字段。实例「{name}」（{instance}）的主组件「{master}」（symbolID {symbol}）里没有图层 {missing}。{located}{location}不会跳过该覆盖，也不会发明图层。修复：需要源文件里的该主组件真正包含这个图层；更换无关库不能生成它。",
        path = clip_id(full_path),
        name = clip_id(instance_name),
        instance = clip_id(instance_id),
        master = clip_id(master_name),
        symbol = clip_id(master_symbol),
        missing = clip_id(missing),
        located = node_location(document, instance_id),
        location = location
    )
}

fn node_parents(document: &Document) -> BTreeMap<String, String> {
    let mut parent = BTreeMap::new();
    for node in document.nodes.values() {
        for child in &node.children {
            parent.insert(child.clone(), node.id.clone());
        }
    }
    for page in &document.pages {
        for child in &page.children {
            parent.insert(child.clone(), format!("page:{}", page.id));
        }
    }
    parent
}

fn node_location(document: &Document, id: &str) -> String {
    node_location_in(document, &node_parents(document), id)
}

fn node_location_in(document: &Document, parent: &BTreeMap<String, String>, id: &str) -> String {
    let mut names = Vec::new();
    let mut cursor = Some(id.to_owned());
    let mut guard = 0usize;
    while let Some(current) = cursor {
        guard += 1;
        if guard > 32 {
            break;
        }
        if let Some(page_id) = current.strip_prefix("page:") {
            let page_name = document
                .pages
                .iter()
                .find(|page| page.id == page_id)
                .map(|page| page.name.as_str())
                .unwrap_or(page_id);
            names.push(format!("页面「{}」", clip_id(page_name)));
            break;
        }
        if let Some(node) = document.nodes.get(&current) && !node.name.is_empty() {
            names.push(clip_id(&node.name));
        }
        cursor = parent.get(&current).cloned();
    }
    names.reverse();
    if names.is_empty() {
        String::new()
    } else {
        format!("位置：{}。", names.join(" / "))
    }
}

/// Resolve the separate Sketch symbol identity before shared-model admission.
/// The low-level archival importer intentionally retains native spellings.
fn admit_sketch_symbols(document: &mut Document) -> Result<()> {
    let mut symbols = BTreeMap::<String, String>::new();
    for node in document.nodes.values_mut() {
        if let Some(symbol) = node.bindings.get("symbolID") {
            if symbols
                .insert(symbol.to_ascii_uppercase(), node.id.clone())
                .is_some()
            {
                return Err(Error::Unsupported(
                    "ambiguous duplicate Sketch symbolID".into(),
                ));
            }
            node.component.get_or_insert_with(Default::default);
        }
    }
    // An authored compatibility archive may refer to a canonical node ID.
    for node in document.nodes.values().filter(|n| n.component.is_some()) {
        let key = node.id.to_ascii_uppercase();
        if symbols.get(&key).is_some_and(|id| id != &node.id) {
            return Err(Error::Unsupported(
                "ambiguous Sketch symbol/node identity".into(),
            ));
        }
        symbols.insert(key, node.id.clone());
    }
    let library_context = format!("{}{}", recorded_libraries(document), checked_library_note(document));
    let parents = node_parents(document);
    let locations = document
        .nodes
        .values()
        .filter(|node| node.instance.is_some())
        .map(|node| (node.id.clone(), node_location_in(document, &parents, &node.id)))
        .collect::<BTreeMap<_, _>>();
    for node in document.nodes.values_mut() {
        if let Some(instance) = &mut node.instance {
            let symbol = instance.component_id.clone();
            let name = node.name.clone();
            let id = node.id.clone();
            let located = locations.get(&id).cloned().unwrap_or_default();
            instance.component_id = symbols.get(&symbol.to_ascii_uppercase()).cloned().ok_or_else(|| {
                let repair = if library_context.contains("未展开") {
                    "修复：先定位一份条目上限内、且包含该 symbolID 的本地 .sketch 库。未展开的成员不算已核对，也不会被当成缺失。不会按名称猜测，也不会发明主组件。"
                } else if library_context.contains("已核对本地库") {
                    "其中没有这个 symbolID。上游定义缺失，打开保持阻断。不会发明主组件，源文件保持不变。"
                } else {
                    "修复：打开前定位并附上包含该 symbolID 的本地 .sketch 库。只按 symbolID 对接，不会按名称猜测，也不会发明主组件。真实定义缺失时打开保持阻断，源文件保持不变。"
                };
                Error::Unsupported(format!(
                    "Sketch instance requires an embedded symbol master: {}。这是缺失的外部库符号定义，不是无法映射的字段，也不是损坏的图层引用。实例「{}」（{}）引用了该 symbolID，但页面主组件和已嵌入的 foreignSymbols 都没有它。{}{}{}",
                    clip_id(&symbol), clip_id(&name), clip_id(&id), located, library_context, repair
                ))
            })?;
        }
        // Stable keys must survive the host's fresh node-ID assignment.
        if !symbols.is_empty() {
            node.component_key.get_or_insert_with(|| node.id.clone());
        }
    }
    if !symbols.is_empty() {
        document.schema_version = document.schema_version.max(4);
    }
    let mut replacements = Vec::new();
    for node in document.nodes.values() {
        let Some(instance) = &node.instance else {
            continue;
        };
        let mut overrides = crate::components::Overrides::new();
        for (path, fields) in &instance.overrides {
            for (field, value) in fields {
                if crate::components::FIELDS.contains(&field.as_str())
                    || matches!(field.as_str(), "swapComponent" | "propertyValues")
                {
                    push_override(&mut overrides, path.clone(), field.clone(), value.clone())?;
                    continue;
                }
                let (layer, native_field) = field.rsplit_once('_').ok_or_else(|| {
                    Error::Unsupported(format!(
                        "Sketch override `{field}` has no editable mapping。这是无法映射的字段名，不是缺失的外部库符号。"
                    ))
                })?;
                let full_path = if path == "self" { layer.to_owned() } else { format!("{path}/{layer}") };
                let key = native_override_path(document, &instance.component_id, &full_path).map_err(|missing| {
                    Error::Unsupported(unresolved_override_message(
                        document, &full_path, &missing, &node.name, &node.id, &instance.component_id,
                    ))
                })?;
                match native_field {
                    "stringValue" if value.is_string() => {
                        push_override(&mut overrides, key, "text".into(), value.clone())?;
                    }
                    "symbolID" if value.is_string() => {
                        let symbol = value.as_str().ok_or_else(|| {
                            Error::Unsupported("invalid Sketch symbol override".into())
                        })?;
                        let master = symbols.get(&symbol.to_ascii_uppercase()).ok_or_else(|| {
                            let repair = if library_context.contains("未展开") {
                                "未展开的成员不算已核对，也不会被当成缺失。不会按名称猜测，也不会发明主组件。"
                            } else if library_context.contains("已核对本地库") {
                                "其中没有这个 symbolID。上游定义缺失，打开保持阻断。不会发明主组件。"
                            } else {
                                "修复：打开前定位并附上包含该 symbolID 的本地 .sketch 库。不会按名称猜测，也不会发明主组件。"
                            };
                            Error::Unsupported(format!(
                                "Sketch symbol override requires an embedded master: {id}。这是缺失的外部库符号定义，不是无法映射的字段，也不是损坏的图层引用。嵌套符号替换目标没有嵌入的主组件。{repair}",
                                id = clip_id(symbol),
                                repair = repair
                            ))
                        })?;
                        push_override(&mut overrides, key, "swapComponent".into(), json!(master))?;
                    }
                    "isVisible" if value.is_boolean() => {
                        push_override(&mut overrides, key, "visible".into(), value.clone())?;
                    }
                    "layerStyle" | "textStyle" if value.is_string() => {
                        let (field, mapped) = shared_style_override(
                            document, native_field, value.as_str().unwrap_or_default(), &node.name, &node.id, &full_path,
                        )?;
                        push_override(&mut overrides, key, field, mapped)?;
                    }
                    "layerStyle" if is_layer_style_dict(value) => {
                        let (fills, strokes, effects) = layer_style_parts(document, value)?;
                        push_override(&mut overrides, key.clone(), "fills".into(), fills)?;
                        push_override(&mut overrides, key.clone(), "strokes".into(), strokes)?;
                        push_override(&mut overrides, key, "effects".into(), effects)?;
                    }
                    _ => {
                        return Err(Error::Unsupported(format!(
                            "Sketch override `{native_field}` has no supported editable mapping; keep the original .sketch file。这是无法映射的字段，不是缺失的外部库符号，也不是损坏的图层引用。实例「{}」（{}）的覆盖 `{}_{native_field}` 不能变成可编辑属性。不会跳过该覆盖，也不会关闭无损保护。",
                            clip_id(&node.name), clip_id(&node.id), clip_id(&full_path)
                        )));
                    }
                }
            }
        }
        replacements.push((node.id.clone(), overrides));
    }
    for (id, overrides) in replacements {
        document.nodes.get_mut(&id).unwrap().instance.as_mut().unwrap().overrides = overrides;
    }
    if let Some(system) = document.design_system.as_mut() {
        system.sketch_containers.remove("sketchCheckedLibraries");
    }
    Ok(())
}

pub fn import_sketch_report(bytes: &[u8]) -> Result<SketchImportReport> {
    finish_sketch_report(import_sketch(bytes)?)
}

/// Admit `bytes` together with local `.sketch` libraries. Symbols and shared
/// styles are copied only when their IDs match; nothing is invented by name.
/// Libraries that still lack a referenced ID leave admission blocked.
/// A page past the existing entry ceiling stays unread and is not treated as
/// proof that the definition is absent.
pub fn import_sketch_report_with_libraries(bytes: &[u8], libraries: &[&[u8]]) -> Result<SketchImportReport> {
    let mut files = read_zip(bytes)?;
    attach_sketch_libraries(&mut files, libraries)?;
    finish_sketch_report(import_sketch_files(&files)?)
}

fn attach_sketch_libraries(files: &mut BTreeMap<String, Vec<u8>>, libraries: &[&[u8]]) -> Result<()> {
    attach_sketch_libraries_with(files, libraries, archive_limits())
}

/// JSON definitions only. Bitmap members are not expanded. A page JSON that
/// exceeds the existing entry or remaining total ceiling is listed as unchecked
/// instead of failing the libraries whose other pages do fit. document.json
/// itself still has to fit; that failure stays an archive limit.
fn read_library_definitions_limited(bytes: &[u8], limits: ArchiveLimits) -> Result<(BTreeMap<String, Vec<u8>>, Vec<String>)> {
    let members = sketch_zip_members(bytes, limits)?;
    let (selected, unchecked) = select_library_members(&members, limits)?;
    Ok((read_zip_bounded_filtered(bytes, limits, Some(&selected))?, unchecked))
}

fn select_library_members(members: &[ZipMember], limits: ArchiveLimits) -> Result<(BTreeSet<String>, Vec<String>)> {
    let mut selected = BTreeSet::new();
    let mut unchecked = Vec::new();
    let mut total = 0u64;
    for required in ["meta.json", "document.json"] {
        let Some(member) = members.iter().find(|member| member.name == required) else {
            return Err(Error::MissingPart(required.into()));
        };
        let limit = if required == "document.json" { limits.document_entry } else { limits.entry };
        if member.size > limit {
            return Err(archive_limit("entry expanded bytes"));
        }
        if total.saturating_add(member.size) > limits.total {
            return Err(archive_limit("total expanded bytes"));
        }
        total += member.size;
        selected.insert(required.to_owned());
    }
    for member in members {
        if !member.name.starts_with("pages/") || !member.name.ends_with(".json") {
            continue;
        }
        if member.size > limits.entry || total.saturating_add(member.size) > limits.total {
            unchecked.push(member.name.clone());
            continue;
        }
        total += member.size;
        selected.insert(member.name.clone());
    }
    Ok((selected, unchecked))
}

fn attach_sketch_libraries_with(files: &mut BTreeMap<String, Vec<u8>>, libraries: &[&[u8]], limits: ArchiveLimits) -> Result<()> {
    if libraries.is_empty() {
        return Ok(());
    }
    let mut document = json_part(files, "document.json")?;
    let mut pages = Vec::new();
    for (name, bytes) in files.iter() {
        if let Some(id) = name.strip_prefix("pages/").and_then(|name| name.strip_suffix(".json")) {
            let _ = id;
            pages.push(serde_json::from_slice::<Value>(bytes).map_err(|e| Error::MalformedJson(format!("{name}: {e}")))?);
        }
    }
    let mut defined = BTreeSet::new();
    let mut needed = BTreeSet::new();
    let mut style_ids = BTreeSet::new();
    let mut referenced_styles = BTreeSet::new();
    collect_archive_symbols(&document, &pages, &mut defined, &mut needed, &mut style_ids, &mut referenced_styles);
    let mut masters: BTreeMap<String, LibraryMaster> = BTreeMap::new();
    // None records two different definitions for one ID. It blocks only a
    // reference that still needs a library copy; unused collisions do not.
    let mut styles: BTreeMap<String, Option<LibraryStyle>> = BTreeMap::new();
    let mut checked = Vec::new();
    for library in libraries {
        let (lib_files, unchecked) = read_library_definitions_limited(library, limits)?;
        let lib_doc = json_part(&lib_files, "document.json")?;
        let document_id = lib_doc.get("do_objectID").and_then(Value::as_str).filter(|id| !id.is_empty()).unwrap_or("library").to_owned();
        let name = document
            .get("perDocumentLibraries")
            .and_then(Value::as_array)
            .and_then(|entries| entries.iter().find(|entry| entry.get("documentID").and_then(Value::as_str) == Some(document_id.as_str())))
            .and_then(|entry| entry.get("name").and_then(Value::as_str))
            .unwrap_or(document_id.as_str())
            .to_owned();
        checked.push(json!({"documentId": document_id, "name": name, "unchecked": unchecked}));
        let mut lib_pages = Vec::new();
        for (entry_name, bytes) in &lib_files {
            if entry_name.strip_prefix("pages/").and_then(|name| name.strip_suffix(".json")).is_some() {
                lib_pages.push(serde_json::from_slice::<Value>(bytes).map_err(|e| Error::MalformedJson(format!("{entry_name}: {e}")))?);
            }
        }
        let mut lib_defined = BTreeSet::new();
        let mut lib_needed = BTreeSet::new();
        let mut lib_styles = BTreeSet::new();
        let mut lib_refs = BTreeSet::new();
        collect_archive_symbols(&lib_doc, &lib_pages, &mut lib_defined, &mut lib_needed, &mut lib_styles, &mut lib_refs);
        for page in &lib_pages {
            index_library_masters(page.get("layers"), &document_id, &name, &mut masters)?;
        }
        if let Some(entries) = lib_doc.get("foreignSymbols").and_then(Value::as_array) {
            for entry in entries {
                if let Some(master) = entry.get("symbolMaster").filter(|master| master.is_object()) {
                    remember_library_master(master, &document_id, &name, &mut masters)?;
                }
            }
        }
        index_library_styles(&lib_doc, &document_id, &name, &mut styles)?;
    }
    document["sketchCheckedLibraries"] = Value::Array(checked);
    let mut pending: Vec<String> = needed.difference(&defined).cloned().collect();
    let mut linked = 0usize;
    while let Some(symbol) = pending.pop() {
        if defined.contains(&symbol) {
            continue;
        }
        let Some(master) = masters.get(&symbol).cloned() else { continue };
        linked += 1;
        if linked > 512 {
            return Err(Error::Unsupported(
                "Sketch library dependency set exceeds 512 symbols; select a smaller library working set".into(),
            ));
        }
        let entry = json!({
            "_class": "MSImmutableForeignSymbol",
            "do_objectID": sketch_id(&format!("{}:{}", master.document_id, symbol)),
            "libraryID": master.document_id,
            "sourceLibraryName": master.name,
            "symbolPrivate": false,
            "originalMaster": master.master,
            "symbolMaster": master.master,
        });
        defined.insert(symbol);
        let mut nested = BTreeSet::new();
        collect_one_layer(&master.master, &mut defined, &mut nested, &mut referenced_styles);
        pending.extend(nested);
        let symbols = document.as_object_mut().ok_or_else(|| Error::MalformedJson("document.json".into()))?
            .entry("foreignSymbols").or_insert_with(|| json!([]));
        symbols.as_array_mut().ok_or_else(|| Error::MalformedJson("foreignSymbols".into()))?.push(entry);
    }
    for style_id in referenced_styles {
        if style_ids.contains(&style_id) {
            continue;
        }
        let style = match styles.get(&style_id) {
            Some(Some(style)) => style.clone(),
            Some(None) => return Err(Error::Unsupported(format!(
                "ambiguous Sketch library style {style_id}。多个本地库以不同内容定义了同一个共享样式 ID，不会按名称挑选。"
            ))),
            None => continue,
        };
        let entry = json!({
            "_class": style.class_name,
            "do_objectID": sketch_id(&format!("{}:{}", style.document_id, style_id)),
            "libraryID": style.document_id,
            "sourceLibraryName": style.name,
            "symbolPrivate": false,
            "remoteStyleID": style.remote_id,
            "localSharedStyle": style.local,
        });
        style_ids.insert(style_id.clone());
        if let Some(local) = style.local.get("do_objectID").and_then(Value::as_str) {
            style_ids.insert(local.to_ascii_uppercase());
        }
        let container = style.container;
        let values = document.as_object_mut().ok_or_else(|| Error::MalformedJson("document.json".into()))?
            .entry(container).or_insert_with(|| json!([]));
        values.as_array_mut().ok_or_else(|| Error::MalformedJson(container.into()))?.push(entry);
    }
    files.insert("document.json".into(), serde_json::to_vec(&document).map_err(|e| Error::Io(e.to_string()))?);
    Ok(())
}

fn collect_archive_symbols(document: &Value, pages: &[Value], defined: &mut BTreeSet<String>, needed: &mut BTreeSet<String>, styles: &mut BTreeSet<String>, referenced: &mut BTreeSet<String>) {
    for page in pages {
        if let Some(layers) = page.get("layers").and_then(Value::as_array) {
            for layer in layers {
                collect_one_layer(layer, defined, needed, referenced);
            }
        }
    }
    if let Some(entries) = document.get("foreignSymbols").and_then(Value::as_array) {
        for entry in entries {
            if let Some(master) = entry.get("symbolMaster") {
                collect_one_layer(master, defined, needed, referenced);
            }
        }
    }
    for (container, _) in [("layerStyles", "paint"), ("layerTextStyles", "text")] {
        if let Some(objects) = document.get(container).and_then(|c| c.get("objects")).and_then(Value::as_array) {
            for object in objects {
                if let Some(id) = object.get("do_objectID").and_then(Value::as_str) {
                    styles.insert(id.to_ascii_uppercase());
                }
            }
        }
    }
    for container in ["foreignLayerStyles", "foreignTextStyles"] {
        if let Some(entries) = document.get(container).and_then(Value::as_array) {
            for entry in entries {
                for id in [
                    entry.pointer("/localSharedStyle/do_objectID").and_then(Value::as_str),
                    entry.get("remoteStyleID").and_then(Value::as_str),
                ].into_iter().flatten() {
                    styles.insert(id.to_ascii_uppercase());
                }
            }
        }
    }
}

fn collect_one_layer(layer: &Value, defined: &mut BTreeSet<String>, needed: &mut BTreeSet<String>, referenced: &mut BTreeSet<String>) {
    match layer.get("_class").and_then(Value::as_str) {
        Some("symbolMaster") => {
            if let Some(id) = layer.get("symbolID").and_then(Value::as_str).filter(|id| !id.is_empty()) {
                defined.insert(id.to_ascii_uppercase());
            }
        }
        Some("symbolInstance") => {
            if let Some(id) = layer.get("symbolID").and_then(Value::as_str).filter(|id| !id.is_empty()) {
                needed.insert(id.to_ascii_uppercase());
            }
            for override_value in layer.get("overrideValues").and_then(Value::as_array).into_iter().flatten() {
                let name = override_value.get("overrideName").and_then(Value::as_str).unwrap_or("");
                if (name.ends_with("_layerStyle") || name.ends_with("_textStyle"))
                    && let Some(id) = override_value.get("value").and_then(Value::as_str).filter(|id| !id.is_empty())
                {
                    referenced.insert(id.to_ascii_uppercase());
                }
                if name.ends_with("_symbolID")
                    && let Some(id) = override_value.get("value").and_then(Value::as_str).filter(|id| !id.is_empty())
                {
                    needed.insert(id.to_ascii_uppercase());
                }
            }
        }
        _ => {}
    }
    if let Some(children) = layer.get("layers").and_then(Value::as_array) {
        for child in children {
            collect_one_layer(child, defined, needed, referenced);
        }
    }
}

fn remember_library_master(master: &Value, document_id: &str, name: &str, masters: &mut BTreeMap<String, LibraryMaster>) -> Result<()> {
    let Some(symbol) = master.get("symbolID").and_then(Value::as_str).filter(|id| !id.is_empty()) else { return Ok(()) };
    let key = symbol.to_ascii_uppercase();
    if let Some(previous) = masters.get(&key) && previous.master != *master {
        return Err(Error::Unsupported(format!(
            "ambiguous Sketch library symbol {symbol}。多个本地库以不同内容定义了同一个 symbolID，不会按名称挑选。"
        )));
    }
    masters.insert(key, LibraryMaster { document_id: document_id.to_owned(), name: name.to_owned(), master: master.clone() });
    Ok(())
}

fn index_library_masters(layers: Option<&Value>, document_id: &str, name: &str, masters: &mut BTreeMap<String, LibraryMaster>) -> Result<()> {
    let Some(layers) = layers.and_then(Value::as_array) else { return Ok(()) };
    for layer in layers {
        if layer.get("_class").and_then(Value::as_str) == Some("symbolMaster") {
            remember_library_master(layer, document_id, name, masters)?;
        }
        index_library_masters(layer.get("layers"), document_id, name, masters)?;
    }
    Ok(())
}

fn index_library_styles(document: &Value, document_id: &str, name: &str, styles: &mut BTreeMap<String, Option<LibraryStyle>>) -> Result<()> {
    for (container, class_name) in [
        ("layerStyles", "MSImmutableForeignLayerStyle"),
        ("layerTextStyles", "MSImmutableForeignTextStyle"),
    ] {
        if let Some(objects) = document.get(container).and_then(|c| c.get("objects")).and_then(Value::as_array) {
            for object in objects {
                remember_library_style(object, object.get("do_objectID").and_then(Value::as_str), container, class_name, document_id, name, styles)?;
            }
        }
    }
    for (container, class_name) in [
        ("foreignLayerStyles", "MSImmutableForeignLayerStyle"),
        ("foreignTextStyles", "MSImmutableForeignTextStyle"),
    ] {
        if let Some(entries) = document.get(container).and_then(Value::as_array) {
            for entry in entries {
                let Some(local) = entry.get("localSharedStyle") else { continue };
                let remote = entry.get("remoteStyleID").and_then(Value::as_str);
                remember_library_style(local, remote, container, class_name, document_id, name, styles)?;
                if let Some(local_id) = local.get("do_objectID").and_then(Value::as_str) && remote != Some(local_id) {
                    remember_library_style(local, Some(local_id), container, class_name, document_id, name, styles)?;
                }
            }
        }
    }
    Ok(())
}

fn remember_library_style(local: &Value, remote: Option<&str>, container: &'static str, class_name: &'static str, document_id: &str, name: &str, styles: &mut BTreeMap<String, Option<LibraryStyle>>) -> Result<()> {
    let Some(remote) = remote.filter(|id| !id.is_empty()) else { return Ok(()) };
    let key = remote.to_ascii_uppercase();
    let conflict = styles.get(&key).is_some_and(|previous| previous.as_ref().is_none_or(|style| style.local != *local));
    if conflict {
        styles.insert(key, None);
        return Ok(());
    }
    styles.entry(key).or_insert_with(|| Some(LibraryStyle {
        document_id: document_id.to_owned(),
        name: name.to_owned(),
        class_name,
        container: if class_name.contains("Text") { "foreignTextStyles" } else { "foreignLayerStyles" },
        remote_id: remote.to_owned(),
        local: local.clone(),
    }));
    let _ = container;
    Ok(())
}

#[derive(Clone)]
struct LibraryMaster {
    document_id: String,
    name: String,
    master: Value,
}
#[derive(Clone)]
struct LibraryStyle {
    document_id: String,
    name: String,
    class_name: &'static str,
    container: &'static str,
    remote_id: String,
    local: Value,
}

/// Native source storage has already checked the original archive and extracts
/// one bounded subtree at a time. Reuse the very same codec without re-zipping
/// that subtree or applying the ordinary whole-archive expansion policy to it.
/// This does not admit a larger live document or alter GPU resource policy.
#[cfg(not(target_arch = "wasm32"))]
pub fn import_sketch_source_window(
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<SketchImportReport> {
    const ENTRY: usize = 64 * 1024 * 1024;
    const TOTAL: usize = 96 * 1024 * 1024;
    if files.len() > 4096
        || files.values().any(|v| v.len() > ENTRY)
        || files
            .values()
            .try_fold(0usize, |n, v| n.checked_add(v.len()))
            .is_none_or(|n| n > TOTAL)
    {
        return Err(Error::Unsupported(
            "Source conversion window exceeds its memory allowance".into(),
        ));
    }
    finish_sketch_report(import_sketch_files(files)?)
}

/// Already parsed native windows, under the same serialized entry/total
/// allowance as import_sketch_source_window. Counting serialization checks the
/// real wire size without allocating another copy of these trees.
#[cfg(not(target_arch = "wasm32"))]
pub fn import_sketch_source_parts(files: &BTreeMap<String, Vec<u8>>, meta: &Value,
    document: &Value, pages: &BTreeMap<String, Value>) -> Result<SketchImportReport> {
    import_sketch_source_parts_inner(files,meta,document,pages,None,&Default::default())
}
/// Native windows share immutable document metadata and project their two
/// page references without cloning the entire styles/fonts/foreign-symbol tree.
#[cfg(not(target_arch = "wasm32"))]
pub fn import_sketch_source_parts_with_pages(files:&BTreeMap<String,Vec<u8>>,meta:&Value,
    document:&Value,pages:&BTreeMap<String,Value>,page_references:&Value)->Result<SketchImportReport> {
    if !document.is_object() || !page_references.is_array() {return Err(Error::MalformedJson("Invalid source page projection".into()));}
    import_sketch_source_parts_inner(files,meta,document,pages,Some(page_references),&Default::default())
}
#[cfg(not(target_arch = "wasm32"))]
pub fn import_sketch_source_bitmap_window(files:&BTreeMap<String,Vec<u8>>,meta:&Value,
    document:&Value,pages:&BTreeMap<String,Value>,page_references:&Value,images:&SourceBitmapRefs)->Result<SketchImportReport>{
    if !document.is_object() || !page_references.is_array() {return Err(Error::MalformedJson("Invalid source page projection".into()));}
    import_sketch_source_parts_inner(files,meta,document,pages,Some(page_references),images)
}
#[cfg(not(target_arch = "wasm32"))]
fn import_sketch_source_parts_inner(files:&BTreeMap<String,Vec<u8>>,meta:&Value,
    document:&Value,pages:&BTreeMap<String,Value>,page_references:Option<&Value>,images:&SourceBitmapRefs)->Result<SketchImportReport> {
    use std::io::Write;
    const ENTRY: usize = 64 * 1024 * 1024;
    const TOTAL: usize = 96 * 1024 * 1024;
    struct Count(usize);
    impl Write for Count {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.checked_add(bytes.len()).filter(|n| *n <= ENTRY)
                .ok_or_else(|| std::io::Error::other("Source conversion entry exceeds its memory allowance"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    let failure = || Error::Unsupported("Source conversion window exceeds its memory allowance".into());
    if files.len().saturating_add(images.len()).saturating_add(pages.len()).saturating_add(2) > 4096 || files.values().any(|v|v.len()>ENTRY) {
        return Err(failure());
    }
    let base = files.values().try_fold(0usize, |n,v|n.checked_add(v.len())).ok_or_else(failure)?;
    let projected=source_size::DocumentFields{source:document,pages:page_references};
    let upper=projected.upper_bound(ENTRY).and_then(|bytes|base.checked_add(bytes)).filter(|n|*n<=TOTAL)
        .and_then(|base|std::iter::once(meta).chain(pages.values()).try_fold(base,|total,value|
        total.checked_add(source_size::upper_bound(value,ENTRY)?).filter(|n|*n<=TOTAL)));
    if upper.is_none(){
        // An upper bound may decline a perfectly valid near-limit document.
        // Recount ALL entries exactly, retaining the original admission set.
        let mut total=base;
        let mut document_count=Count(0);
        serde_json::to_writer(&mut document_count,&projected).map_err(|_|failure())?;
        total=total.checked_add(document_count.0).filter(|n|*n<=TOTAL).ok_or_else(failure)?;
        for value in std::iter::once(meta).chain(pages.values()) {
            let mut count = Count(0);
            serde_json::to_writer(&mut count,value).map_err(|_|failure())?;
            total = total.checked_add(count.0).filter(|n|*n<=TOTAL).ok_or_else(failure)?;
        }
    }
    finish_sketch_report(import_sketch_parts(files,meta,document,pages,page_references,images)?)
}

fn finish_sketch_report(mut document: Document) -> Result<SketchImportReport> {
    admit_sketch_symbols(&mut document)?;
    let mut warnings = std::collections::BTreeSet::new();
    warnings.insert("Sketch compatibility import: unsupported source fields may not be editable or survive export; keep the original .sketch file.".to_owned());
    // A shared document stores pages outside nodes. The low-level codec also
    // exposes native page wrappers for legacy inspection; they are not an
    // additional reachable canvas node in the application model.
    for page in &document.pages {
        if document
            .nodes
            .get(&page.id)
            .is_some_and(|node| node.kind == "page")
        {
            document.nodes.remove(&page.id);
        }
    }
    // Sketch archives normally name installed fonts without embedding their
    // bytes. Rendering requires portable resources; retain source identities
    // as format metadata and make the substitution visible before admission.
    let mut large_booleans = Vec::new();
    let mut mixed_booleans = Vec::new();
    for node in document.nodes.values_mut() {
        if node
                .bindings
                .get("interopLimited")
                .is_some_and(|value| value.starts_with("sketch-unknown-layer-class:"))
        {
            return Err(Error::Unsupported(format!(
                "Sketch layer `{}` ({}) has no supported editable mapping; keep the original .sketch file",
                node.id, node.kind
            )));
        }
        match node.kind.as_str() {
            "path" => node.kind = "vector".into(),
            "rect" | "image" => node.kind = "rectangle".into(),
            "slice" | "frame" | "section" | "group" | "rectangle" | "ellipse" | "polygon"
            | "star" | "line" | "vector" | "text" => {}
            _ => {
                return Err(Error::Unsupported(format!(
                    "Sketch layer `{}` kind `{}` has no supported editable mapping; keep the original .sketch file",
                    node.id, node.kind
                )));
            }
        }
        if node
            .bindings
            .get("sketchOpenPath")
            .is_some_and(|v| v == "true")
            && let Some(network) = &mut node.network
        {
            let network = std::sync::Arc::make_mut(network);
            network.edges.pop();
        }
        if node
            .bindings
            .get("sketchNormalizedCoordinates")
            .is_some_and(|v| v == "true")
            && let Some(network) = &mut node.network
        {
            let network = std::sync::Arc::make_mut(network);
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
        if node
            .network
            .as_ref()
            .is_some_and(|g| g.vertices.len() > 10000)
        {
            let closed = !node
                .bindings
                .get("sketchOpenPath")
                .is_some_and(|v| v == "true");
            node.vector_geometry = Some(
                crate::vector_geometry::VectorGeometry::ordered_network(
                    node.network.as_ref().unwrap(),
                    closed,
                )
                .map_err(Error::InvalidDocument)?.into(),
            );
            node.network = None;
            document.schema_version = document.schema_version.max(16);
        }
        if let Some(group) = node.bindings.get("sketchSourceShapeGroup") {
            let source: Value =
                serde_json::from_str(group).map_err(|e| Error::MalformedJson(e.to_string()))?;
            let codes: Vec<i64> = serde_json::from_value(source["operations"].clone())
                .map_err(|e| Error::MalformedJson(e.to_string()))?;
            if node.children.len() > 4096 || codes.len() != node.children.len() {
                return Err(Error::Unsupported(format!(
                    "Sketch shapeGroup `{}` exceeds source conversion allowance ({} operands)",
                    node.id,
                    node.children.len()
                )));
            }

            if node.children.is_empty() {
                node.kind = "vector".into();
                node.boolean_operation = None;
            } else {
                let operations = codes
                    .iter()
                    .skip(1)
                    .map(|code| match code {
                        -1 | 0 => Some(crate::boolean::Operation::Union),
                        value => boolean_from_code(*value),
                    })
                    .collect::<Option<Vec<_>>>()
                    .ok_or_else(|| {
                        Error::Unsupported(format!(
                            "Sketch shapeGroup `{}` has an unknown operand operation",
                            node.id
                        ))
                    })?;
                let ordinary = operations
                    .first()
                    .copied()
                    .unwrap_or(crate::boolean::Operation::Union);
                let compound = codes.iter().all(|code| *code == -1);
                let operation = if compound {
                    document.schema_version = document.schema_version.max(16);
                    if source["windingRule"].as_i64() == Some(0) {
                        crate::boolean::Operation::CompoundNonzero
                    } else {
                        crate::boolean::Operation::CompoundEvenodd
                    }
                } else {
                    ordinary
                };
                let operation = if !compound && operations.iter().any(|other| *other != ordinary) {
                    let outer = *operations.last().unwrap();
                    mixed_booleans.push((node.id.clone(),operations));
                    outer
                } else {
                    if node.children.len() > 64 { large_booleans.push(node.id.clone()); }
                    operation
                };
                node.kind = "vector".into();
                node.boolean_operation = Some(operation);
                node.bindings.insert(
                    "sketchShapeGroupMappedOperation".into(),
                    serde_json::to_string(&operation)
                        .map_err(|e| Error::MalformedJson(e.to_string()))?,
                );
            }
        } else if let Some(operation) = node.boolean_operation {
            node.bindings.insert(
                "sketchOperandBooleanOperation".into(),
                serde_json::to_string(&operation)
                    .map_err(|e| Error::MalformedJson(e.to_string()))?,
            );
            node.boolean_operation = None;
            warnings.insert("Sketch: operand boolean flags remain source metadata; executable boolean groups use the shared vector model.".into());
        }
        if node.width == 0. || node.height == 0. {
            node.bindings.insert(
                "sketchSourceZeroExtent".into(),
                json!({"width":node.width,"height":node.height}).to_string(),
            );
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
            let unavailable: Vec<String> = style
                .fallbacks
                .iter()
                .filter(|font| *font != "default" && !document.fonts.contains_key(*font))
                .cloned()
                .collect();
            if !unavailable.is_empty() {
                source_fonts.insert("fallbacks".into(), json!(unavailable));
                style
                    .fallbacks
                    .retain(|font| font == "default" || document.fonts.contains_key(font));
            }
        }
        let mut runs = Map::new();
        for (index, run) in node.text_runs.iter_mut().enumerate() {
            if let Some(font) = run.font_id.as_mut()
                && font != "default"
                && !document.fonts.contains_key(font)
            {
                runs.insert(index.to_string(), Value::String(font.clone()));
                *font = "default".into();
            }
        }
        if !runs.is_empty() {
            source_fonts.insert("runs".into(), Value::Object(runs));
        }
        if !source_fonts.is_empty() {
            node.bindings.insert(
                "sketchSourceFonts".into(),
                serde_json::to_string(&source_fonts)
                    .map_err(|e| Error::MalformedJson(e.to_string()))?,
            );
            warnings.insert(crate::abeezee_font::UNEMBEDDED_FONT_WARNING.to_owned());
        }
        if let Some(source) = document
            .design_system
            .as_mut()
            .and_then(|system| system.sketch_containers.get_mut("textSourceLayouts"))
            .and_then(|layouts| layouts.get_mut(&node.id))
            .and_then(Value::as_object_mut)
        {
            // Admission's font fallback is derived state. Keep the raw source
            // frame while certifying against the actually editable text model.
            source.insert("signature".into(), text_layout_signature(node));
        }
    }
    boolean_worksets::bound(&mut document, &large_booleans)?;
    for (id,operations) in mixed_booleans { boolean_worksets::mixed(&mut document,&id,&operations)?; }
    let mut omitted = false;
    for node in document.nodes.values() {
        for key in [
            "sketchImportLossy",
            "sketchExportLossy",
            "sketchFlowUntranslated",
            "interopLimited",
        ] {
            let Some(value) = node.bindings.get(key) else {
                continue;
            };
            // Aggregate by feature; never emit layer names, IDs or one line per
            // node. The cap also bounds unrecognized source extension strings.
            let notes =
                serde_json::from_str::<Vec<String>>(value).unwrap_or_else(|_| vec![value.clone()]);
            for note in notes {
                let note =
                    if note.starts_with("override-") && note.ends_with("-image-ref-unresolved") {
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
        system
            .sketch_containers
            .contains_key("foreignSymbolsUnresolved")
    }) {
        warnings.insert(
            "Sketch: external symbols without an embedded master remain source data.".into(),
        );
    }
    if omitted {
        warnings.insert(
            "Sketch: additional compatibility notices omitted; inspect retained source fields."
                .into(),
        );
    }
    // Turn native Sketch shared-style links into executable kernel references.
    // Keep unresolved IDs as source metadata rather than inventing definitions.
    if let Some(system) = &mut document.design_system {
        for shared in system
            .styles
            .values_mut()
            .filter(|style| style.kind == "text")
        {
            if let Ok(mut style) =
                serde_json::from_value::<crate::font::TextStyle>(shared.value.clone())
            {
                if style.font_id != "default" && !document.fonts.contains_key(&style.font_id) {
                    style.font_id = "default".into();
                }
                shared.value =
                    serde_json::to_value(style).map_err(|e| Error::MalformedJson(e.to_string()))?;
            }
        }
        for node in document.nodes.values_mut() {
            if let Some(id) = node.style_refs.get("sketchSharedStyleID").cloned() {
                let id = system
                    .sketch_containers
                    .get("sharedStyleIds")
                    .and_then(|ids| ids.get(&id))
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_owned();
                if let Some(shared) = system.styles.get(&id) {
                    let field = if shared.kind == "text" {
                        "textStyle"
                    } else {
                        "fills"
                    };
                    node.style_refs.insert(field.into(), id);
                } else {
                    warnings.insert(
                        "Sketch: unresolved shared style reference retained as source metadata."
                            .into(),
                    );
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
            if key.starts_with("sketch")
                || matches!(key.as_str(), "symbolID" | "instanceOf" | "interopLimited")
            {
                bindings.insert(key.clone(), value.clone());
                false
            } else {
                true
            }
        });
        let mut style_refs = BTreeMap::new();
        node.style_refs.retain(|key, value| {
            if key.starts_with("sketch") {
                style_refs.insert(key.clone(), value.clone());
                false
            } else {
                true
            }
        });
        if !bindings.is_empty() || !style_refs.is_empty() {
            metadata.insert(
                node.id.clone(),
                json!({"bindings":bindings,"styleRefs":style_refs}),
            );
        }
    }
    if !metadata.is_empty() {
        document
            .design_system
            .get_or_insert_with(Default::default)
            .sketch_containers
            .insert("nodeMetadata".into(), Value::Object(metadata));
        document.schema_version = document.schema_version.max(4);
    }
    let pin = crate::abeezee_font::pin_imported_faces(&mut document);
    for warning in pin.warnings {
        warnings.insert(warning);
    }
    if !pin.unembedded_remain {
        warnings.remove(crate::abeezee_font::UNEMBEDDED_FONT_WARNING);
    }
    let signatures: Vec<(String, Value)> = pin
        .changed
        .iter()
        .filter_map(|id| {
            document
                .nodes
                .get(id)
                .map(|node| (id.clone(), text_layout_signature(node)))
        })
        .collect();
    if let Some(layouts) = document
        .design_system
        .as_mut()
        .and_then(|system| system.sketch_containers.get_mut("textSourceLayouts"))
        .and_then(Value::as_object_mut)
    {
        for (id, signature) in signatures {
            if let Some(source) = layouts.get_mut(&id).and_then(Value::as_object_mut) {
                source.insert("signature".into(), signature);
            }
        }
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
            return Err(Error::Unsupported(format!(
                "Invalid Sketch color `{value}`"
            )));
        }
        let channel = |start| {
            u8::from_str_radix(&value[start..start + 2], 16)
                .map(|v| f64::from(v) / 255.)
                .map_err(|_| Error::Unsupported(format!("Invalid Sketch color `{value}`")))
        };
        return Ok(
            json!({"_class":"color", "red":channel(1)?, "green":channel(3)?,
            "blue":channel(5)?, "alpha":alpha.clamp(0., 1.)}),
        );
    }
    let (source, rgb, intrinsic_alpha) = crate::color::parse(value, settings.document_space)
        .map_err(|reason| Error::Unsupported(format!("Sketch color `{value}`: {reason}")))?;
    if matches!(source, ColorSpace::Pq | ColorSpace::Hlg) {
        return Err(Error::Unsupported(format!(
            "Sketch cannot preserve HDR color `{value}`; use the native format or explicitly tone-map an SDR copy"
        )));
    }
    let rgb = if source == settings.document_space {
        rgb
    } else {
        settings.from_working(settings.to_working(rgb, source), settings.document_space)
    };
    const ROUND_OFF: f64 = 1e-10;
    if rgb
        .iter()
        .any(|v| !v.is_finite() || *v < -ROUND_OFF || *v > 1. + ROUND_OFF)
    {
        return Err(Error::Unsupported(format!(
            "Sketch color `{value}` is outside the target {:?} gamut; no implicit clipping or tone mapping is applied",
            settings.document_space
        )));
    }
    let [red, green, blue] = rgb.map(|v| v.clamp(0., 1.));
    Ok(
        json!({"_class":"color", "red":red, "green":green, "blue":blue,
        "alpha":(intrinsic_alpha * alpha).clamp(0., 1.)}),
    )
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
    use sha1::Digest;
    hex(&sha1::Sha1::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Sketch readers expect UUID-shaped object IDs; derive one deterministically
/// from our node id so re-exports stay stable, and stash the original id in
/// userInfo for loss-free round-trips.
fn sketch_shared_style_id(id: &str) -> String {
    if id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        id.to_owned()
    } else {
        sketch_id(id)
    }
}

fn sketch_id(id: &str) -> String {
    if id.len() == 36 && id.bytes().enumerate().all(|(i,b)| {
        if matches!(i,8|13|18|23) { b == b'-' } else { b.is_ascii_hexdigit() }
    }) { return id.to_owned(); }
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

fn export_paint(
    paint: &Paint,
    images: &mut ExportedImages,
    size: [f64; 2],
) -> Result<Option<Value>> {
    Ok(match paint.kind.as_str() {
        "solid" if !paint.color.is_empty() => Some(json!({
            "_class": "fill", "isEnabled": paint.visible, "fillType": 0,
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
                    let inverse = matrix
                        .inverse()
                        .map_err(|e| Error::Unsupported(e.to_string()))?;
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
                let primary = crate::math::Point::new(
                    radial_matrix.0[0] * size[0],
                    radial_matrix.0[1] * size[1],
                );
                let perpendicular = crate::math::Point::new(
                    radial_matrix.0[2] * size[0],
                    radial_matrix.0[3] * size[1],
                );
                if primary.length() > 0. {
                    perpendicular.length() / primary.length()
                } else {
                    1.
                }
            } else {
                0.
            };
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
                "_class": "fill", "isEnabled": paint.visible, "fillType": 1,
                "gradient": {"_class": "gradient", "from": from, "to": to, "elipseLength": ellipse_length,
                              "stops": stops, "gradientType": gradient_type},
                "contextSettings": {"_class": "graphicsContextSettings",
                                     "blendMode": blend_code(&paint.blend), "opacity": paint.opacity.clamp(0., 1.),
                                     "isProgressive": false}
            }))
        }
        "image" => {
            if paint.transform.is_some_and(|t|t!=Transform::default()) || paint.adjust.is_some() {
                return Err(Error::Unsupported("Sketch cannot preserve image transform/adjust; save FD or explicitly bake the image".into()));
            }
            let Some(uri) = paint.image.as_deref() else {
                return Ok(None);
            };
            let Some((mime, bytes)) = data_uri_bytes(uri) else {
                return Ok(None);
            };
            let pattern_scale = if paint.tile.as_ref().is_some_and(|t|t.is_active()) {
                sketch_pattern_scale(paint, bitmap_extent(&bytes)).ok_or_else(||Error::Unsupported("Sketch cannot preserve pattern spacing/offset/stagger".into()))?
            } else {1.};
            let name = sha1_hex(&bytes);
            if images.seen.insert(name.clone()) {
                images.entries.push((format!("images/{name}"), bytes));
            }
            let ext = mime.rsplit('/').next().unwrap_or("png");
            let _ = ext;
            // Inverse of the import mapping: tiling (Paint.tile) archives as
            // Tile(0) with a uniform authored cell scale; otherwise fit picks
            // Fill(1)/Stretch(2)/Fit(3). Never replay a stale imported scale
            // over an edited, modeled tile size.
            let pattern_fill_type = if paint.tile.as_ref().is_some_and(|t| t.is_active()) {
                0
            } else {
                match paint.fit.as_str() {
                    "stretch" => 2,
                    "contain" => 3,
                    _ => 1,
                }
            };
            Some(json!({
                "_class": "fill", "isEnabled": paint.visible, "fillType": 4,
                "color": hex_to_rgba("#000000", 1., images.color_settings)?,
                "image": {"_class": "MSJSONFileReference", "_ref_class": "MSImageData", "_ref": format!("images/{name}")},
                "noiseIndex": 0, "noiseIntensity": 0., "noiseFillType": 0,
                "patternFillType": pattern_fill_type, "patternTileScale": pattern_scale,
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

/// `Some(true)` is an exact inverse of the two-stop importer (base radius 1,
/// smooth tier). `Some(false)` still writes that portable form; the FD receipt
/// keeps a different base radius or tier. `None` leaves the uniform blur.
fn attach_sketch_progressive_background(blur: &mut Value, effect: &Effect, size: [f64; 2]) -> Option<bool> {
    let gradient = effect.gradient_blur.as_ref()?;
    if !(size[0] > 0. && size[1] > 0. && size.iter().all(|value| value.is_finite())) {
        return None;
    }
    let max_count = gradient.start_count.max(gradient.end_count);
    if !(max_count.is_finite() && max_count > 0. && gradient.start_count >= 0. && gradient.end_count >= 0.) {
        return None;
    }
    let normalize = |point: [f64; 2]| [point[0] / size[0], point[1] / size[1]];
    let from = normalize(gradient.start);
    let to = normalize(gradient.end);
    if !from.iter().chain(to.iter()).all(|value| value.is_finite()) {
        return None;
    }
    let point = |value: [f64; 2]| format!("{{{}, {}}}", value[0], value[1]);
    let stop = |position: f64, alpha: f64| json!({
        "_class": "gradientStop", "position": position,
        "color": {"_class": "color", "red": 0., "green": 0., "blue": 0., "alpha": alpha}
    });
    blur["progressive"] = json!(true);
    blur["radius"] = json!(max_count);
    blur["gradient"] = json!({
        "_class": "gradient", "gradientType": 0, "elipseLength": 0.,
        "from": point(from), "to": point(to),
        "stops": [stop(0., gradient.start_count / max_count), stop(1., gradient.end_count / max_count)]
    });
    let exact = effect.radius == 1. && matches!(
        crate::gradient_blur::admit_two_end_progressive(gradient.start, gradient.end, gradient.start_count, gradient.end_count),
        Ok(crate::gradient_blur::TwoEndAdmission::Ramp(params)) if params == *gradient
    );
    Some(exact)
}

/// Kernel strokes/effects → Sketch border/shadow/blur parts. Shared by the
/// layer exporter and the document-level layerStyles container, so a shared
/// style archives exactly what a layer with the same parts would. The
/// returned borderOptions carry the dash/cap/join of the first stroke —
/// Sketch keeps them per style, not per border.
fn export_style_parts(
    strokes: &[crate::scene::Stroke],
    effects: &[Effect],
    lossy: &mut Vec<String>,
    images: &mut ExportedImages,
    size: [f64; 2],
) -> Result<(Vec<Value>, Vec<Value>, Vec<Value>, Value, Value)> {
    let settings = images.color_settings;
    // Native gradients share the fill encoding, including strict HDR/gamut
    // admission. Unsupported border carriers still reject instead of falling
    // back to an unrelated solid color, including when the stroke is hidden.
    if let Some(stroke) = strokes.iter().find(|stroke| {
        !matches!(
            stroke.paint.kind.as_str(),
            "solid" | "linear" | "radial" | "angular"
        )
    }) {
        return Err(Error::Unsupported(format!(
            "Sketch export cannot preserve {} stroke paints; use the native format instead",
            stroke.paint.kind
        )));
    }
    let borders: Vec<Value> = strokes
        .iter()
        .map(|s| -> Result<Value> {
            if s.paint.kind != "solid" {
                let mut paint = s.paint.clone(); paint.visible = true;
                let mut border = export_paint(&paint, images, size)?.ok_or_else(||Error::Unsupported("Sketch border paint".into()))?;
                border["_class"]=json!("border");border["isEnabled"]=json!(s.visible&&s.paint.visible);
                border["thickness"]=json!(s.width);
                border["position"]=json!(match s.align.as_str(){"inside"=>1,"outside"=>2,_=>0});
                return Ok(border);
            }
            Ok(json!({
                "_class": "border", "isEnabled": s.visible && s.paint.visible, "thickness": s.width,
                "position": match s.align.as_str() { "inside" => 1, "outside" => 2, _ => 0 },
                "fillType": 0,
                "color": hex_to_rgba(&s.paint.color, 1., settings)?,
                "contextSettings": {"_class": "graphicsContextSettings",
                                      "blendMode": blend_code(&s.paint.blend), "opacity": s.paint.opacity.clamp(0.,1.), "isProgressive": false}
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
            if strokes.iter().any(|s| {
                s.start_marker != first.start_marker || s.end_marker != first.end_marker
            }) {
                note_lossy(lossy, "border-markers-mixed-per-stroke");
            }
            if strokes.iter().any(|s| s.dash_offset != 0.) {
                note_lossy(lossy, "border-dash-offset-omitted");
            }
            json!({"_class": "borderOptions",
                   "lineCapStyle": cap_code(&first.cap), "lineJoinStyle": join_code(&first.join),
                   "dashPattern": dash_pattern(&first.dash),
                   "startMarkerType": marker_code(first.start_marker, lossy),
                   "endMarkerType": marker_code(first.end_marker, lossy),
                   "miterLimit": 10, "windingRule": 0})
        }
        None => json!({"_class": "borderOptions", "lineCapStyle": 0, "lineJoinStyle": 0,
                       "dashPattern": [], "startMarkerType": 0, "endMarkerType": 0,
                       "miterLimit": 10, "windingRule": 0}),
    };
    // Shadow alpha lives in the color payload; kernel keeps it separately
    // in Effect.opacity, so export multiplies it back into the color.
    let shadow_json = |e: &Effect| -> Result<Value> {
        // Native Sketch uses `_class: innerShadow` for inner shadows. `_class: shadow`
        // is an outer shadow, including when a fixture author meant the other kind.
        let class = if e.kind == "inner-shadow" { "innerShadow" } else { "shadow" };
        Ok(
            json!({"_class": class, "isEnabled": e.visible, "blurRadius": e.radius,
                "offsetX": e.x, "offsetY": e.y, "spread": e.spread,
                "color": hex_to_rgba(&e.color, e.opacity.clamp(0., 1.), settings)?,
                "contextSettings": {"_class": "graphicsContextSettings", "blendMode": 0, "opacity": 1., "isProgressive": false}}),
        )
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
    // The legacy dictionary mirrors the first blur; modern arrays are written below.
    let blur_like: Vec<&Effect> = effects
        .iter()
        .filter(|e| matches!(e.kind.as_str(), "blur" | "gaussian-blur" | "motion-blur" | "zoom-blur" | "background-blur" | "glass"))
        .collect();
    let blur = match blur_like.first() {
        Some(e) => {
            match e.kind.as_str() {
                "glass" if e.glass.is_some() => note_lossy(lossy, "glass-native-depth-and-lighting-projection;authored-optics-retained"),
                "glass" => note_lossy(lossy, "effect-glass->gaussian(refraction-lost)"),
                _ => {}
            }
            if blur_like.len() > 1 && !blur_like.iter().any(|e| e.glass.is_some()) {
                note_lossy(lossy, "effect-multiple-blurs-collapsed");
            }
            sketch_blur_value(e)
        }
        None => {
            json!({"_class": "blur", "isEnabled": false, "center": "{0.5, 0.5}", "motionAngle": 0.,
                       "radius": 0., "saturation": 1., "type": 0})
        }
    };
    let mut blur = blur;
    let exported_background_progressive = blur_like.first().and_then(|effect| {
        if effect.kind == "background-blur" { attach_sketch_progressive_background(&mut blur, effect, size) } else { None }
    });
    if exported_background_progressive == Some(false) {
        note_lossy(lossy, "progressive-background-blur-portable-sketch-keeps-strength-counts");
    }
    let mut skipped_background_progressive = false;
    for e in effects {
        let exported = exported_background_progressive.is_some()
            && e.kind == "background-blur"
            && e.gradient_blur.is_some()
            && !skipped_background_progressive;
        if exported {
            skipped_background_progressive = true;
            continue;
        }
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

/// Canonical native masks for the shared anchor subset. Center has no exact
/// legacy mapping (mask 5 preserves proportional center, not a fixed offset).
fn constraint_axis_bits(anchor: crate::layout::Anchor, lossy: &mut Vec<String>) -> u64 {
    use crate::layout::Anchor;
    match anchor {
        Anchor::Start => 1, Anchor::End => 4, Anchor::Stretch => 2, Anchor::Scale => 7,
        Anchor::Center => { note_lossy(lossy, "constraint-center->scale"); 7 }
    }
}

fn flex_justify(align: crate::layout::Align, lossy: &mut Vec<String>) -> i64 {
    use crate::layout::Align;
    match align {
        Align::Start => 0,
        Align::Center | Align::UnsafeCenter => 1,
        Align::End | Align::UnsafeEnd => 2,
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
        Align::Center | Align::UnsafeCenter => 1,
        Align::End | Align::UnsafeEnd => 2,
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
        crate::boolean::Operation::CompoundNonzero | crate::boolean::Operation::CompoundEvenodd => {
            -1
        }
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

/// A contour whose edges already walk the vertices in order. Closed rings and
/// open chains are the only topologies a Sketch shapePath can store without
/// dropping handles. An open chain is not a broken closed ring.
fn sequential_contour(net: &crate::scene::Network, closed: bool) -> bool {
    let count = net.vertices.len();
    if count == 0 || (!closed && count < 2) {
        return false;
    }
    let expected = if closed { count } else { count - 1 };
    net.edges.len() == expected
        && net.edges.iter().enumerate().all(|(i, edge)| {
            let next = (i + 1) % count;
            edge.from == net.vertices[i].id && edge.to == net.vertices[next].id
        })
}

/// Official point-string grammar (`sketch-document` `point-string.schema.yaml`):
/// `^-?\d+(\.\d+)?(e-\d+)?$`. The published pattern leaves `.` unescaped; this
/// check uses a real decimal point, which that pattern also accepts.
fn sketch_unit_schema(text: &str) -> bool {
    let rest = text.strip_prefix('-').unwrap_or(text);
    let (mantissa, exponent) = match rest.split_once('e') {
        Some((mantissa, exponent)) => {
            if !exponent.starts_with('-')
                || exponent.len() == 1
                || !exponent[1..].bytes().all(|b| b.is_ascii_digit())
            {
                return false;
            }
            (mantissa, true)
        }
        None => (rest, false),
    };
    let _ = exponent;
    let (whole, fraction) = match mantissa.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (mantissa, None),
    };
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.is_none_or(|fraction| {
            !fraction.is_empty() && fraction.bytes().all(|b| b.is_ascii_digit())
        })
}

fn same_f64_bits(text: &str, value: f64) -> bool {
    text.parse::<f64>()
        .ok()
        .is_some_and(|parsed| parsed.to_bits() == value.to_bits())
}

/// Expand `1.25e20` into a plain decimal. The schema allows only a negative
/// exponent, and the digit shift keeps the shortest round-trip.
fn expand_nonnegative_exponent(debug: &str) -> Option<String> {
    let negative = debug.starts_with('-');
    let rest = debug.strip_prefix('-').unwrap_or(debug);
    let (mantissa, exponent) = rest.split_once(['e', 'E'])?;
    if exponent.starts_with('-') {
        return None;
    }
    let exponent: i32 = exponent.trim_start_matches('+').parse().ok()?;
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let digits = format!("{whole}{fraction}");
    let point = whole.len() as i32 + exponent;
    let body = if point <= 0 {
        let zeros = "0".repeat((-point) as usize);
        let tail = digits.trim_end_matches('0');
        format!("0.{zeros}{tail}")
    } else if point as usize >= digits.len() {
        let zeros = "0".repeat(point as usize - digits.len());
        format!("{digits}{zeros}")
    } else {
        let index = point as usize;
        let tail = digits[index..].trim_end_matches('0');
        if tail.is_empty() {
            digits[..index].to_string()
        } else {
            format!("{}.{}", &digits[..index], tail)
        }
    };
    let body = body.trim_start_matches('0');
    let body = if body.is_empty() || body.starts_with('.') {
        format!("0{body}")
    } else {
        body.to_string()
    };
    Some(if negative {
        format!("-{body}")
    } else {
        body
    })
}

fn sketch_unit(value: f64) -> Result<String> {
    if !value.is_finite() {
        return Err(Error::Unsupported(
            "Sketch curve points require finite frame-normalized coordinates".into(),
        ));
    }
    let display = format!("{value}");
    if sketch_unit_schema(&display) && same_f64_bits(&display, value) {
        return Ok(display);
    }
    let debug = format!("{value:?}");
    let text = expand_nonnegative_exponent(&debug).unwrap_or(debug);
    if sketch_unit_schema(&text) && same_f64_bits(&text, value) {
        return Ok(text);
    }
    Err(Error::Unsupported(format!(
        "Sketch curve coordinate {value:?} cannot be written as a point string without coarsening it"
    )))
}

fn frame_unit(value: f64, extent: f64) -> Result<f64> {
    if !value.is_finite() || !extent.is_finite() || extent < 0. {
        return Err(Error::Unsupported(
            "Sketch curve points require a finite nonnegative frame".into(),
        ));
    }
    if extent == 0. {
        if value == 0. {
            // A collapsed axis has one representable coordinate. Keep the sign
            // of zero; every other value would leave the frame.
            return Ok(value);
        }
        return Err(Error::Unsupported(
            "Sketch curve points are frame-normalized, so a nonzero coordinate on a zero-size axis cannot be stored without moving the geometry".into(),
        ));
    }
    let unit = value / extent;
    if !unit.is_finite() {
        return Err(Error::Unsupported(
            "Sketch curve points require finite frame-normalized coordinates".into(),
        ));
    }
    Ok(unit)
}

fn sketch_curve_coordinate(x: f64, y: f64, width: f64, height: f64) -> Result<String> {
    Ok(format!(
        "{{{}, {}}}",
        sketch_unit(frame_unit(x, width)?)?,
        sketch_unit(frame_unit(y, height)?)?
    ))
}

fn shape_path_curve_points(
    net: &crate::scene::Network,
    width: f64,
    height: f64,
    closed: bool,
    corner_radii: &[f64],
    lossy: &mut Vec<String>,
) -> Result<Vec<Value>> {
    let count = net.vertices.len();
    let ring = sequential_contour(net, closed);
    if !ring && count > 0 {
        note_lossy(lossy, "network-topology-flattened-to-ring");
    }
    let mut points = Vec::with_capacity(count);
    for (i, vertex) in net.vertices.iter().enumerate() {
        let (outgoing, incoming) = if ring {
            (
                net.edges.get(i).and_then(|edge| edge.c1),
                if i > 0 {
                    net.edges[i - 1].c2
                } else if closed {
                    net.edges[count - 1].c2
                } else {
                    None
                },
            )
        } else {
            (None, None)
        };
        let mode = curve_mode_of(vertex, outgoing, incoming);
        let anchor = sketch_curve_coordinate(vertex.x, vertex.y, width, height)?;
        let curve_from = match outgoing {
            Some(point) => sketch_curve_coordinate(point.x, point.y, width, height)?,
            None => anchor.clone(),
        };
        let curve_to = match incoming {
            Some(point) => sketch_curve_coordinate(point.x, point.y, width, height)?,
            None => anchor.clone(),
        };
        points.push(json!({
            "_class": "curvePoint",
            "curveMode": mode,
            "hasCurveFrom": outgoing.is_some(),
            "hasCurveTo": incoming.is_some(),
            "point": anchor,
            "curveFrom": curve_from,
            "curveTo": curve_to,
            "cornerRadius": corner_radii.get(i).copied().unwrap_or(0.),
        }));
    }
    Ok(points)
}

/// 22 号字典 §1 export side: derive curveMode from the handle geometry at
/// one vertex. c1 is the outgoing handle (curveFrom), c2 the incoming one
/// (curveTo). No handles → 1 (Straight); two handles collinear with the
/// vertex → 2 (Mirrored) when equally long, 4 (Asymmetric) otherwise; a
/// single handle or non-collinear pair → 3 (Disconnected).
fn curve_mode_of(
    v: &crate::scene::Vertex,
    c1: Option<crate::math::Point>,
    c2: Option<crate::math::Point>,
) -> i64 {
    let (Some(a), Some(b)) = (c1, c2) else {
        return if c1.is_some() || c2.is_some() { 3 } else { 1 };
    };
    let (ox, oy) = (a.x - v.x, a.y - v.y);
    let (ix, iy) = (b.x - v.x, b.y - v.y);
    let out_len = ox.hypot(oy);
    let in_len = ix.hypot(iy);
    let cross = (ox * iy - oy * ix).abs();
    if ox * ix + oy * iy >= 0. || cross > 1e-9 * (1. + out_len * in_len) {
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
    files: &BTreeMap<String, Vec<u8>>, sources:&SourceBitmapRefs,
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
    if let Some((uri,_))=sources.get(reference).or_else(||sources.get(&format!("images/{reference}"))){return Some(Value::String(uri.to_string()));}
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
fn sketch_override_value_to_native(
    value: &Value,
    images: &mut ExportedImages,
) -> Result<Option<Value>> {
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
            json!({"_class": "MSJSONFileReference", "_ref_class": "MSImageData", "_ref": format!("images/{name}")}),
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
        None => node
            .bindings
            .get("sketchTextBehaviour")
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(2),
        _ => 2,
    }
}

fn native_text_projection(layer: &Value) -> Value {
    json!({"attributedString":layer.get("attributedString"),"verticalAlignment":layer.pointer("/style/textStyle/verticalAlignment"),"textBehaviour":layer.get("textBehaviour"),"lineSpacingBehaviour":layer.get("lineSpacingBehaviour")})
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
    let Some(signature) = source
        .get("signature")
        .and_then(|value| serde_json::from_value::<TextLayoutSignature>(value.clone()).ok())
    else {
        return false;
    };
    let current = TextLayoutSignature {
        text: node.text.clone(),
        font_size: node.font_size,
        text_style: node.text_style.as_deref().cloned(),
        text_runs: node.text_runs.to_vec(),
        sizing: node.sizing.clone(),
    };
    if signature != current {
        return false;
    }
    let (Some(width), Some(height), Some(transform), Some(sizing)) = (
        source.get("width").and_then(Value::as_f64),
        source.get("height").and_then(Value::as_f64),
        source
            .get("transform")
            .and_then(|value| serde_json::from_value::<Transform>(value.clone()).ok()),
        node.sizing.as_ref(),
    ) else {
        return false;
    };
    if (sizing.width != crate::layout::SizeMode::Hug && node.width != width)
        || (sizing.height != crate::layout::SizeMode::Hug && node.height != height)
    {
        return false;
    }
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
    if node.transform != expected {
        return false;
    }
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
fn sketch_font_name(doc: &Document, font_id: &str, source_name: Option<&str>) -> String {
    if font_id.is_empty() || font_id == "default" {
        if let Some(name) = source_name.filter(|name| crate::abeezee_font::absent_abeezee_diagnosis(name).is_some()) {
            return name.to_owned();
        }
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
                    let data = resource
                        .data
                        .split_once(',')
                        .map(|(_, data)| data)
                        .unwrap_or(&resource.data);
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .ok()?;
                    let face = ttf_parser::Face::parse(&bytes, resource.index).ok()?;
                    face.names()
                        .into_iter()
                        .filter(|name| name.name_id == ttf_parser::name_id::POST_SCRIPT_NAME)
                        .find_map(|name| name.to_string())
                })
                .unwrap_or_else(|| resource.family.clone())
        })
        .unwrap_or_else(|| font_id.to_owned())
}

fn sketch_font_descriptor(
    doc: &Document,
    axes: &mut BTreeMap<String, bool>,
    font_id: &str,
    size: f64,
    weight: f32,
    source_name: Option<&str>,
) -> Value {
    let mut descriptor = json!({"_class":"fontDescriptor", "attributes":{
        "name":sketch_font_name(doc, font_id, source_name), "size":size}});
    let has_weight = *axes.entry(font_id.into()).or_insert_with(|| {
        let Some(resource) = doc.fonts.get(font_id) else {
            return false;
        };
        use base64::Engine as _;
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(resource.data.as_bytes())
        else {
            return false;
        };
        let Ok(face) = ttf_parser::Face::parse(&bytes, resource.index) else {
            return false;
        };
        face.variation_axes()
            .into_iter()
            .any(|axis| axis.tag == ttf_parser::Tag::from_bytes(b"wght"))
    });
    if has_weight {
        descriptor["attributes"]["variation"] = json!({"2003265652":weight});
    }
    descriptor
}

fn exported_symbol_id(doc: &Document, id: &str) -> String {
    let Some(master) = doc.nodes.get(id) else {
        return id.to_owned();
    };
    master
        .bindings
        .get("symbolID")
        .cloned()
        .or_else(|| {
            doc.design_system
                .as_ref()
                .and_then(|system| system.sketch_containers.get("nodeMetadata"))
                .and_then(|metadata| metadata.get(id))
                .and_then(|metadata| metadata.get("bindings"))
                .and_then(|bindings| bindings.get("symbolID"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| if master.component.is_some() { sketch_id(id) } else { id.to_owned() })
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
            if !visited.insert(id.clone()) || visited.len() > 20000 {
                return None;
            }
            let node = doc.nodes.get(&id)?;
            if (index == 0 && *part == "$root" && id == scope)
                || node.component_key.as_deref().unwrap_or(&node.id) == *part
            {
                found = Some(node);
                break;
            }
            if id == scope || node.instance.is_none() {
                pending.extend(node.children.iter().cloned());
            }
        }
        let node = found?;
        native.push(sketch_id(&node.id));
        if index + 1 < parts.len() {
            scope = node.instance.as_ref()?.component_id.clone();
        }
    }
    Some(native.join("/"))
}

/// Sketch's frame/rotation/flips represent rigid local placement. Test only
/// floating-point orthogonality here; never flatten scale/shear to identity.
fn sketch_placement(node: &Node) -> Option<([f64; 4], f64, [bool; 2])> {
    crate::sketch::geometry::frame_placement(node.transform, node.width, node.height)
}

fn export_layer(doc: &Document, id: &str, images: &mut ExportedImages) -> Result<Value> {
    export_layer_impl(doc, id, images, true)
}

fn export_layer_impl(
    doc: &Document,
    id: &str,
    images: &mut ExportedImages,
    descendants: bool,
) -> Result<Value> {
    let mut source_text_frame_restored = false;
    let restored_node = doc
        .nodes
        .get(id)
        .map(|node| -> Result<crate::scene::Node> {
            let mut node = node.clone();
            if node.kind == "line" && node.network.is_none() && node.vector_geometry.is_none() {
                node.kind="vector".into();
                node.bindings.insert("sketchOpenPath".into(),"true".into());
                node.network=Some(serde_json::from_value(json!({"vertices":[{"id":"a","x":0.,"y":0.},{"id":"b","x":node.width,"y":node.height}],"edges":[{"id":"ab","from":"a","to":"b"}],"fillRule":"nonzero"})).unwrap());
            }
            if let Some(geometry) = node.vector_geometry.take() {
                node.network = Some((
                    geometry
                        .network(crate::vector_geometry::MAX_COMMANDS)
                        .map_err(Error::InvalidDocument)?
                ).into());
            }
            let metadata = doc
                .design_system
                .as_ref()
                .and_then(|system| system.sketch_containers.get("nodeMetadata"))
                .and_then(|metadata| metadata.get(id));
            if let Some(metadata) = metadata {
                if let Some(bindings) = metadata.get("bindings").and_then(|v| {
                    serde_json::from_value::<BTreeMap<String, String>>(v.clone()).ok()
                }) {
                    node.bindings.extend(bindings);
                }
                if let Some(style_refs) = metadata.get("styleRefs").and_then(|v| {
                    serde_json::from_value::<BTreeMap<String, String>>(v.clone()).ok()
                }) {
                    node.style_refs.extend(style_refs);
                }
            }
            let source_text_layout = doc
                .design_system
                .as_ref()
                .and_then(|system| system.sketch_containers.get("textSourceLayouts"))
                .and_then(|layouts| layouts.get(id));
            source_text_frame_restored = restore_unedited_text_frame(&mut node, source_text_layout);
            if let Some(extent) = node
                .bindings
                .get("sketchSourceZeroExtent")
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            {
                if node.width == 1e-6 && extent.get("width").and_then(Value::as_f64) == Some(0.) {
                    node.width = 0.;
                }
                if node.height == 1e-6 && extent.get("height").and_then(Value::as_f64) == Some(0.) {
                    node.height = 0.;
                }
            }
            Ok(node)
        })
        .transpose()?;
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
        // Admission represents native bitmaps as ordinary image-filled
        // rectangles. Restore that native class while the geometry/paint can
        // still express it, otherwise Sketch ignores bitmap color controls.
        if n.bindings.contains_key("sketchSourceBitmap") && matches!(n.kind.as_str(), "rectangle" | "image")
            && n.children.is_empty() && n.radii.iter().all(|r| *r==0.) && n.fills.len()==1 {
            let p=&n.fills[0];
            let extent=p.image.as_deref().and_then(data_uri_bytes).and_then(|(_,b)|bitmap_extent(&b));
            let same_aspect=extent.is_some_and(|size|(n.width*size[1]-n.height*size[0]).abs()<=1e-10*n.width.max(n.height)*size[0].max(size[1]));
            if p.kind=="image" && p.visible && p.opacity==1. && p.blend=="normal" && p.transform.is_none()
                && p.tile.is_none() && p.adjust.is_none() && (p.fit=="stretch" || same_aspect) {class="bitmap";}
        }
        if n.bindings.contains_key("sketchSourceHotspot") && n.kind == "rectangle" && n.fills.is_empty() && n.strokes.is_empty() && n.effects.is_empty() && n.children.is_empty() { class = "hotspot"; }
        if n.instance.is_some() {
            class = "symbolInstance";
        } else if n.kind == "frame"
            && (n.component.is_some() || n.bindings.contains_key("symbolID"))
        {
            class = "symbolMaster";
        } else if matches!(n.kind.as_str(), "group" | "vector") && n.boolean_operation.is_some() {
            class = "shapeGroup";
        } else if n.kind == "vector"
            && n.children.is_empty()
            && n.network.is_none()
            && n.vector_geometry.is_none()
            && n.bindings.contains_key("sketchSourceShapeGroup")
        {
            class = "shapeGroup";
        }
    }
    layer.insert("_class".into(), json!(class));
    layer.insert("do_objectID".into(), json!(sketch_id(id)));
    // Canonical base field set every real Sketch layer carries (the
    // unarchiver constructs these via initWithUnarchiver: even when default).
    layer.insert("booleanOperation".into(), json!(-1));
    layer.insert("clippingMaskMode".into(), json!(0));
    // Authored export formats return with their source-only fields by index;
    // layers without settings keep the canonical empty container.
    let export_formats: Vec<Value> = node
        .into_iter()
        .flat_map(|n| n.export_settings.iter().enumerate().map(move |(index,setting)| (n,index,setting)))
        .map(|(node,index,setting)| {
            let mut value=json!({"_class":"exportFormat","absoluteSize":0,
                "relativeAvailabilityMethod":0,"visible":true});
            if let Some(entries)=sketch_binding(doc,node,"sketchExportFormatFields")
                .and_then(|raw|serde_json::from_str::<Vec<Value>>(raw).ok()) {
                for fields in entries.iter().filter(|entry|entry["index"]==index).filter_map(|entry|entry["fields"].as_object()) {
                    for (key,source) in fields { value[key]=source.clone(); }
                }
            }
            value["fileFormat"]=json!(setting.format);
            value["scale"]=json!(setting.scale);
            value["name"]=json!(setting.suffix);
            value
        })
        .collect();
    layer.insert(
        "exportOptions".into(),
        json!({
            "_class": "exportOptions", "includedLayerIds": [], "layerOptions": 0,
            "shouldTrim": false, "exportFormats": export_formats
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
    layer.insert("shouldBreakMaskChain".into(), json!(node.is_some_and(|n| n.mask_chain == Some(crate::scene::MaskChain::Break))));
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
        if let Some(source) = n
            .bindings
            .get("sketchSourceTransform")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            && source
                .get("matrix")
                .and_then(|v| serde_json::from_value::<[f64; 6]>(v.clone()).ok())
                == Some(t)
            && let Some(frame) = source
                .get("frame")
                .and_then(|v| serde_json::from_value::<[f64; 4]>(v.clone()).ok())
            && frame[2] == n.width
            && frame[3] == n.height
        {
            layer.insert("frame".into(), json!({"_class":"rect", "x":frame[0], "y":frame[1], "width":frame[2], "height":frame[3]}));
            layer.insert("rotation".into(), source["rotation"].clone());
            layer.insert("isFlippedHorizontal".into(), source["flip"][0].clone());
            layer.insert("isFlippedVertical".into(), source["flip"][1].clone());
        }
        if source_text_frame_restored
            && let Some(frame) = doc
                .design_system
                .as_ref()
                .and_then(|system| system.sketch_containers.get("textSourceLayouts"))
                .and_then(|layouts| layouts.get(id))
                .and_then(|source| source.get("frame"))
        {
            layer.insert("frame".into(), frame.clone());
        }
        if let Some(frame) = layer.get_mut("frame").and_then(Value::as_object_mut)
            && (n.constrain_proportions || frame.contains_key("constrainProportions"))
        {
            frame.insert(
                "constrainProportions".into(),
                json!(n.constrain_proportions),
            );
        }
        // P1-7: constraints → resizingConstraint bits (63 = Sketch's
        // measured default "free" value and must not re-import as a rule).
        if let Some(c) = &n.constraints {
            let x = constraint_axis_bits(c.horizontal, &mut lossy);
            let y = constraint_axis_bits(c.vertical, &mut lossy);
            layer.insert("resizingConstraint".into(), json!(x | (y << 3)));
            layer.insert("hasExplicitConstraints".into(), json!(true));
        }
        if let Some(source)=n.bindings.get("sketchLegacyConstraints").and_then(|raw|serde_json::from_str::<Value>(raw).ok())
            && source.get("model")==Some(&json!(n.constraints)) {
            layer.insert("resizingConstraint".into(),source["mask"].clone());
        }
        // Sketch 2025 modern layout fields return verbatim under their
        // original archived spelling (plain/`_`/`__`), overriding the
        // default zeros written above.
        if let Some(modern) = n
            .bindings
            .get("sketchModernLayout")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            && let Some(fields) = modern.as_object()
        {
            let modeled: Vec<String> = n.bindings.get("sketchModernLayoutModeled").and_then(|v|serde_json::from_str(v).ok()).unwrap_or_default();
            for (spelling, value) in fields {
                let mut value=value.clone();
                if modeled.contains(spelling) {
                    let key=spelling.trim_start_matches('_'); let vertical=key.starts_with("vertical");
                    if key.ends_with("Sizing") {
                        let z=n.sizing_value(); let mode=if vertical {z.height}else{z.width};
                        value=json!(match mode {crate::layout::SizeMode::Fixed=>0,crate::layout::SizeMode::Hug=>1,crate::layout::SizeMode::Fill=>2});
                    } else if key.ends_with("Pins") {
                        let c=n.constraints.clone().unwrap_or_default(); let a=if vertical {c.vertical}else{c.horizontal};
                        value=json!(match a {crate::layout::Anchor::Start=>1,crate::layout::Anchor::End=>4,crate::layout::Anchor::Stretch=>5,_=>0});
                    }
                }
                layer.insert(spelling.clone(), value);
            }
        }
        // P1-9: boolean groups carry their operation on shapeGroup.
        if let Some(op) = &n.boolean_operation {
            layer.insert("booleanOperation".into(), json!(boolean_code(*op)));
        } else if let Some(op) = n
            .bindings
            .get("sketchOperandBooleanOperation")
            .and_then(|raw| serde_json::from_str::<crate::boolean::Operation>(raw).ok())
        {
            layer.insert("booleanOperation".into(), json!(boolean_code(op)));
        }
        let source_gradients = n
            .bindings
            .get("sketchSourceGradients")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        let bitmap_paint = (class == "bitmap").then(|| n.fills.iter().rposition(|p|p.kind=="image")).flatten();
        let fills: Vec<Value> = n
            .fills
            .iter()
            .enumerate()
            .map(|(index, p)| -> Result<Option<Value>> {
                if Some(index) == bitmap_paint { return Ok(None); }
                if p.kind == "diamond" {
                    // Sketch gradients: 1 linear, 2 radial, 3 angular — no
                    // diamond; radial is the nearest visual approximation.
                    note_lossy(&mut lossy, "fill-diamond->radial");
                }
                if p.kind == "radial" {
                    let transform = p.transform.unwrap_or_default();
                    let primary = crate::math::Point::new(
                        transform.0[0] * n.width,
                        transform.0[1] * n.height,
                    );
                    let cross = crate::math::Point::new(
                        transform.0[2] * n.width,
                        transform.0[3] * n.height,
                    );
                    if (primary.x * cross.x + primary.y * cross.y).abs()
                        > 1e-10 * primary.length() * cross.length()
                    {
                        note_lossy(&mut lossy, "fill-radial-skew-approximated");
                    }
                }
                let Some(mut part) = export_paint(p, images, [n.width, n.height])? else {
                    return Ok(None);
                };
                if let Some(source) = source_gradients
                    .as_ref()
                    .and_then(|source| source.get(index.to_string()))
                    && source
                        .get("paint")
                        .and_then(|value| serde_json::from_value::<Paint>(value.clone()).ok())
                        .as_ref()
                        == Some(p)
                {
                    part["gradient"] = source["gradient"].clone();
                }
                Ok(Some(part))
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect();
        // Pattern tile scales and dropped noise parts ride bindings; splice
        // them back so the exported parts byte-match the imported source
        // (indices address the admitted-paint sequence recorded on import).
        let pattern_scale = n
            .bindings
            .get("sketchSourcePatternScale")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        let noise_parts = n
            .bindings
            .get("sketchSourceNoiseFills")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        let mut fills = fills;
        if let Some(scales) = &pattern_scale {
            for (index, part) in fills.iter_mut().enumerate() {
                if let Some(scale) = scales.get(format!("fills-{index}")) {
                    part["patternTileScale"] = scale.clone();
                }
            }
        }
        if let Some(noise) = noise_parts
            .as_ref()
            .and_then(|n| n.as_object())
        {
            let mut inserts: Vec<(usize, &Value)> = noise
                .iter()
                .filter_map(|(key, part)| {
                    key.strip_prefix("fills-")?
                        .parse::<usize>()
                        .ok()
                        .map(|position| (position, part))
                })
                .collect();
            inserts.sort_by_key(|(position, _)| *position);
            for (position, part) in inserts {
                if inactive_retained_noise(n,part,false){copy_inactive_noise(part,fills.get_mut(position));continue}
                let at = position.min(fills.len());
                fills.insert(at, part.clone());
            }
        }
        for paint in &n.fills {
            if let Some(tile) = &paint.tile
                && tile.is_active()
                && sketch_pattern_scale(paint, paint.image.as_deref().and_then(data_uri_bytes)
                    .and_then(|(_, bytes)| bitmap_extent(&bytes))).is_none()
            {
                note_lossy(
                    &mut lossy,
                    "pattern-tile-stagger/offset/size-not-expressible",
                );
                break;
            }
        }
        let (mut borders, shadows, inner_shadows, mut blur, border_options) = export_style_parts(
            &n.strokes,
            &n.effects,
            &mut lossy,
            images,
            [n.width, n.height],
        )?;
        if let Some(sources) = n
            .bindings
            .get("sketchSourceStrokeGradients")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        {
            for (index, stroke) in n.strokes.iter().enumerate() {
                if let Some(source) = sources.get(index.to_string())
                    && source
                        .get("paint")
                        .and_then(|value| serde_json::from_value::<Paint>(value.clone()).ok())
                        .as_ref()
                        == Some(&stroke.paint)
                    && (stroke.paint.kind == "linear"
                        || source
                            .get("size")
                            .and_then(|v| serde_json::from_value::<[f64; 2]>(v.clone()).ok())
                            == Some([n.width, n.height]))
                {
                    borders[index]["gradient"] = source["gradient"].clone();
                }
            }
        }
        let mut source_blurs = None;
        if let Some(source) = n
            .bindings
            .get("sketchSourceBlur")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        {
            if source
                .get("effects")
                .and_then(|value| serde_json::from_value::<Vec<Effect>>(value.clone()).ok())
                .as_ref()
                == Some(&blur_projection(&n.effects)) {
                blur = source["blur"].clone();
                source_blurs = source.get("blurs").filter(|v|v.is_array()).cloned();
            } else if n.effects.iter().any(|e|e.glass.is_some()) && let Some(parts)=edited_glass_blurs(&source,&n.effects) {
                if let Some(first)=parts.first() { blur=first.clone(); }
                source_blurs=Some(Value::Array(parts));
            }
        }
        // Border-side twin of the fill splice: pattern tile scales and noise
        // parts return at their recorded admitted-borders positions.
        if let Some(scales) = &pattern_scale {
            for (index, part) in borders.iter_mut().enumerate() {
                if let Some(scale) = scales.get(format!("borders-{index}")) {
                    part["patternTileScale"] = scale.clone();
                }
            }
        }
        if let Some(noise) = noise_parts.as_ref().and_then(|n| n.as_object()) {
            let mut inserts: Vec<(usize, &Value)> = noise
                .iter()
                .filter_map(|(key, part)| {
                    key.strip_prefix("borders-")?
                        .parse::<usize>()
                        .ok()
                        .map(|position| (position, part))
                })
                .collect();
            inserts.sort_by_key(|(position, _)| *position);
            for (position, part) in inserts {
                if inactive_retained_noise(n,part,true){copy_inactive_noise(part,borders.get_mut(position));continue}
                let at = position.min(borders.len());
                borders.insert(at, part.clone());
            }
        }
        // P1-6: shared style reference (style_refs holds the Sketch uuid).
        let mut style = Map::new();
        if let Some(shared) = n
            .style_refs
            .get("textStyle")
            .or_else(|| n.style_refs.get("fills"))
            .or_else(|| n.style_refs.get("sketchSharedStyleID"))
        {
            layer.insert(
                "sharedStyleID".into(),
                json!(sketch_shared_style_id(shared)),
            );
        }
        style.insert("_class".into(), json!("style"));
        style.insert(
            "windingRule".into(),
            json!(if n.fill_even_odd() { 1 } else { 0 }),
        );
        style.insert(
            "do_objectID".into(),
            json!(sketch_id(&format!("{id}-style"))),
        );
        style.insert("fills".into(), Value::Array(fills));
        style.insert("borders".into(), Value::Array(borders));
        style.insert("shadows".into(), Value::Array(shadows));
        style.insert("innerShadows".into(), Value::Array(inner_shadows));
        style.insert("blurs".into(), source_blurs.unwrap_or_else(|| modern_blurs(&n.effects,&blur)));
        // Keep the old dictionary for old readers; current Sketch reads blurs.
        style.insert("blur".into(), blur);
        style.insert("borderOptions".into(), border_options);
        // Per-layer color controls ride bindings verbatim when the source
        // archived an enabled part; the default-disabled object covers the
        // kernel-authored case.
        let mut color_controls = n
            .bindings
            .get("sketchSourceColorControls")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .unwrap_or_else(|| {
                json!({"_class": "colorControls", "isEnabled": false, "brightness": 0.,
                                       "contrast": 1., "hue": 0., "saturation": 1.})
            });
        if let Some(effect) = n.effects.iter().find(|e|e.kind=="color-controls") {
            if class != "bitmap" { note_lossy(&mut lossy,"color-controls-native-bitmap-required"); }
            if n.effects.iter().filter(|e|e.kind=="color-controls").count()>1 { note_lossy(&mut lossy,"multiple-color-controls-collapsed"); }
            if let Some(controls)=effect.color_controls {
                color_controls["isEnabled"]=json!(effect.visible);
                color_controls["brightness"]=json!(controls.brightness);
                color_controls["contrast"]=json!(controls.contrast);
                color_controls["saturation"]=json!(controls.saturation);
                color_controls["hue"]=json!(controls.hue);
            }
        } else if n.bindings.contains_key("sketchColorControlsModeled") {
            color_controls["isEnabled"]=json!(false);
        }
        if let Some(fields)=n.bindings.get("sketchInactiveNoiseMetadata").and_then(|v|serde_json::from_str::<Value>(v).ok()).and_then(|v|v.as_object().cloned()) {
            for (key,values) in fields {if let Some((parts,index))=key.split_once('-')
                && matches!(parts,"fills"|"borders") && let Ok(index)=index.parse::<usize>()
                && let Some(part)=style.get_mut(parts).and_then(Value::as_array_mut).and_then(|v|v.get_mut(index)).and_then(Value::as_object_mut) {
                for field in ["noiseIndex","noiseIntensity","noiseFillType"] {if let Some(value)=values.get(field) {part.insert(field.into(),value.clone());}}
            }}
        }
        style.insert("colorControls".into(), color_controls);
        style.insert(
            "contextSettings".into(),
            json!({"_class": "graphicsContextSettings",
                                          "blendMode": blend_code(&n.blend), "opacity": n.opacity.clamp(0., 1.),
                                          "isProgressive": false}),
        );
        layer.insert("style".into(), Value::Object(style));
        match class {
            "rectangle" => {
                layer.insert(
                    "fixedRadius".into(),
                    json!(if n.radii.iter().all(|r| *r == n.radii[0]) {
                        n.radii[0]
                    } else {
                        0.
                    }),
                );
                let points = ["{0, 0}", "{1, 0}", "{1, 1}", "{0, 1}"].into_iter().zip(n.radii).map(|(point, radius)| json!({"_class":"curvePoint","point":point,"cornerRadius":radius,"curveMode":1,"hasCurveFrom":false,"hasCurveTo":false})).collect::<Vec<_>>();
                layer.insert("points".into(), json!(points));
                layer.insert("needsConversion".into(), json!(false));
            }
            "artboard" | "symbolMaster" => {
                layer.insert("clippingBehavior".into(), json!(if n.clip { 1 } else { 2 }));
                layer.insert("hasBackgroundColor".into(), json!(false));
                layer.insert("includeBackgroundColorInExport".into(), json!(true));
                layer.insert(
                    "backgroundColor".into(),
                    hex_to_rgba("#ffffff", 0., images.color_settings)?,
                );
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
                    layer.insert(
                        "symbolID".into(),
                        json!(exported_symbol_id(doc, &inst.component_id)),
                    );
                    layer.insert("scale".into(), json!(1.));
                    layer.insert("preservesSpaceWhenHidden".into(), json!(false));
                    let mut values = Vec::new();
                    let mut paint_overrides: BTreeMap<String, BTreeMap<String, Value>> = BTreeMap::new();
                    for (path, fields) in &inst.overrides {
                        for (field, value) in fields {
                            if field == "styleRefs" {
                                let Some(native_path) = exported_override_path(doc, &inst.component_id, path) else {
                                    note_lossy(&mut lossy, "component-override-path-in-userInfo");
                                    continue;
                                };
                                let Some(map) = value.as_object() else {
                                    note_lossy(&mut lossy, "component-overrides-in-userInfo");
                                    continue;
                                };
                                if let Some(id) = map.get("fills").and_then(Value::as_str) {
                                    values.push(json!({"_class":"overrideValue","overrideName":format!("{native_path}_layerStyle"),"value":id}));
                                }
                                if let Some(id) = map.get("textStyle").and_then(Value::as_str) {
                                    values.push(json!({"_class":"overrideValue","overrideName":format!("{native_path}_textStyle"),"value":id}));
                                }
                                if map.contains_key("strokes") && !map.contains_key("fills") || map.contains_key("effects") && !map.contains_key("fills") {
                                    note_lossy(&mut lossy, "component-overrides-in-userInfo");
                                }
                                continue;
                            }
                            if matches!(field.as_str(), "fills" | "strokes" | "effects") {
                                paint_overrides.entry(path.clone()).or_default().insert(field.clone(), value.clone());
                                continue;
                            }
                            let canonical = crate::components::FIELDS.contains(&field.as_str())
                                || matches!(field.as_str(), "swapComponent" | "propertyValues");
                            let mut native_value = value.clone();
                            let name = if canonical {
                                let native_field = match field.as_str() {
                                    "text" => "stringValue",
                                    "visible" => "isVisible",
                                    "swapComponent" => "symbolID",
                                    _ => {
                                        note_lossy(&mut lossy, "component-overrides-in-userInfo");
                                        continue;
                                    }
                                };
                                let Some(native_path) =
                                    exported_override_path(doc, &inst.component_id, path)
                                else {
                                    note_lossy(&mut lossy, "component-override-path-in-userInfo");
                                    continue;
                                };
                                if field == "swapComponent" {
                                    if let Some(id) = value.as_str() {
                                        native_value = json!(exported_symbol_id(doc, id));
                                    }
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
                                            images.entries.push((format!("images/{name}"), bytes));
                                        }
                                        Some(json!({"_class": "MSJSONFileReference",
                                                    "_ref_class": "MSImageData",
                                                    "_ref": format!("images/{name}")}))
                                    } else {
                                        Some(json!(s))
                                    }
                                }
                                Value::Number(nb) => Some(json!(nb)),
                                Value::Bool(b) => Some(json!(b)),
                                Value::Object(_) => {
                                    let converted = sketch_override_value_to_native(value, images)?;
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
                    for (path, parts) in paint_overrides {
                        let Some(native_path) = exported_override_path(doc, &inst.component_id, &path) else {
                            note_lossy(&mut lossy, "component-override-path-in-userInfo");
                            continue;
                        };
                        let fills = parts.get("fills").cloned().and_then(|value| serde_json::from_value::<Vec<Paint>>(value).ok()).unwrap_or_default();
                        let strokes = parts.get("strokes").cloned().and_then(|value| serde_json::from_value::<Vec<Stroke>>(value).ok()).unwrap_or_default();
                        let effects = parts.get("effects").cloned().and_then(|value| serde_json::from_value::<Vec<Effect>>(value).ok()).unwrap_or_default();
                        if parts.contains_key("fills") && parts.get("fills").is_some_and(|value| serde_json::from_value::<Vec<Paint>>(value.clone()).is_err())
                            || parts.contains_key("strokes") && parts.get("strokes").is_some_and(|value| serde_json::from_value::<Vec<Stroke>>(value.clone()).is_err())
                            || parts.contains_key("effects") && parts.get("effects").is_some_and(|value| serde_json::from_value::<Vec<Effect>>(value.clone()).is_err())
                        {
                            note_lossy(&mut lossy, "component-overrides-in-userInfo");
                            continue;
                        }
                        let (borders, shadows, inner_shadows, blur, border_options) = export_style_parts(&strokes, &effects, &mut lossy, images, [1., 1.])?;
                        let mut paints = Vec::new();
                        for paint in &fills {
                            if let Some(part) = export_paint(paint, images, [1., 1.])? { paints.push(part); }
                        }
                        values.push(json!({
                            "_class":"overrideValue",
                            "overrideName":format!("{native_path}_layerStyle"),
                            "value":{"_class":"style","fills":paints,"borders":borders,"shadows":shadows,"innerShadows":inner_shadows,"blur":blur,"borderOptions":border_options}
                        }));
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
                if class == "star" { layer.insert("radius".into(),json!(n.inner_radius)); }
                if n.arc.is_some() || n.corner_radius != 0. {
                    return Err(Error::Unsupported("Sketch parametric arc/rounded polygon export requires an explicit vector conversion".into()));
                }
                let points:Vec<Value> = if class=="oval" {
                    let k=0.5522847498307936/2.;
                    [([1.,0.5],[1.,0.5-k],[1.,0.5+k]),([0.5,1.],[0.5+k,1.],[0.5-k,1.]),
                        ([0.,0.5],[0.,0.5+k],[0.,0.5-k]),([0.5,0.],[0.5-k,0.],[0.5+k,0.])]
                        .into_iter().map(|(at,incoming,outgoing)|json!({"_class":"curvePoint","point":format!("{{{}, {}}}",at[0],at[1]),
                            "curveTo":format!("{{{}, {}}}",incoming[0],incoming[1]),"curveFrom":format!("{{{}, {}}}",outgoing[0],outgoing[1]),
                            "curveMode":2,"hasCurveFrom":true,"hasCurveTo":true,"cornerRadius":0.})).collect()
                } else {
                    let count=n.points.clamp(3,128)*if class=="star" {2} else {1};
                    (0..count).map(|i| {let angle=i as f64*std::f64::consts::TAU/count as f64-std::f64::consts::FRAC_PI_2;
                        let radius=if class=="star" && i%2!=0 {n.inner_radius} else {1.};
                        json!({"_class":"curvePoint","point":format!("{{{}, {}}}",0.5+0.5*radius*angle.cos(),0.5+0.5*radius*angle.sin()),
                            "curveMode":1,"hasCurveFrom":false,"hasCurveTo":false,"cornerRadius":0.})}).collect()
                };
                layer.insert("points".into(),json!(points));
                layer.insert("isClosed".into(),json!(true));
                layer.insert("edited".into(),json!(false));
            }
            "shapePath" => {
                // An authored open chain is a shapePath with isClosed false.
                // Treating it as a closed ring drops its handles and invents a
                // closing segment the kernel does not draw.
                let binding_open = n
                    .bindings
                    .get("sketchOpenPath")
                    .is_some_and(|v| v == "true");
                let closed = match n.network.as_ref() {
                    Some(net) if !binding_open && sequential_contour(net, false) => false,
                    _ => !binding_open,
                };
                layer.insert("isClosed".into(), json!(closed));
                // Per-point corner radii imported from a native document
                // ride bindings (the kernel has no per-vertex radius slot)
                // and are restored verbatim here.
                let corner_radii: Vec<f64> = n
                    .bindings
                    .get("sketchPointCornerRadii")
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_default();
                // Curve points are frame-normalized "{x, y}" strings. Local
                // pixel objects are not a Sketch curvePoint and native Sketch
                // refuses the archive. Handles stay f64; only a non-chain is
                // reported, and it is not redrawn as a coarser polyline here.
                let points = match n.network.as_ref() {
                    Some(net) => shape_path_curve_points(
                        net,
                        n.width,
                        n.height,
                        closed,
                        &corner_radii,
                        &mut lossy,
                    )?,
                    None => Vec::new(),
                };
                layer.insert("points".into(), Value::Array(points));
            }
            "text" => {
                // P0-2: full multi-run attributed string (22 号字典 §4 key
                // set). Kernel run offsets are UTF-16 already, so
                // {location, length} pass through untouched.
                let style = n.text_style.as_ref();
                let absent_default = crate::abeezee_font::exported_absent_face(doc, n);
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
                let vertical_alignment = Some(match style.map(|s|s.vertical_align.as_str()).unwrap_or("top") { "center"=>1, "bottom"=>2, _=>n.bindings.get("sketchTextVerticalAlignment").and_then(|v|v.parse::<i64>().ok()).unwrap_or(0) });
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
                                     strikethrough: bool,
                                     case: Option<&crate::font::TextCase>,
                                     paragraph: Option<&crate::font::TextParagraph>|
                 -> Result<Value> {
                    let mut attrs = Map::new();
                    attrs.insert(
                        "MSAttributedStringFontAttribute".into(),
                        sketch_font_descriptor(
                            doc,
                            &mut images.font_weight_axes,
                            font,
                            size,
                            weight,
                            if font == "default" { absent_default.as_deref() } else { None },
                        ),
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
                    // Official TextTransform enum (0=None/1=Uppercase/
                    // 2=Lowercase): the kernel's authored run case writes
                    // directly; variants Sketch cannot express fall back to
                    // the imported binding payload (their degradation was
                    // already noted at the call site).
                    let case_code = match case {
                        Some(crate::font::TextCase::Upper) => Some(1),
                        Some(crate::font::TextCase::Lower) => Some(2),
                        _ => None,
                    };
                    if let Some(code) = case_code {
                        attrs.insert(
                            "MSAttributedStringTextTransformAttribute".into(),
                            json!(code),
                        );
                    } else if let Some(t) = &text_transform {
                        attrs.insert(
                            "MSAttributedStringTextTransformAttribute".into(),
                            t.clone(),
                        );
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
                    if let Some(p) = paragraph {
                        para.insert("alignment".into(), json!(paragraph_alignment(&p.align)));
                        para.insert("minimumLineHeight".into(), json!(p.minimum_line_height));
                        para.insert("maximumLineHeight".into(), json!(p.maximum_line_height));
                        para.insert("paragraphSpacing".into(), json!(p.spacing));
                        para.insert("firstLineHeadIndent".into(), json!(p.indent));
                    }
                    attrs.insert("paragraphStyle".into(), Value::Object(para));
                    Ok(
                        json!({"_class": "stringAttribute", "attributes": Value::Object(attrs),
                           "location": location, "length": length}),
                    )
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
                    if let Some(case) = run.text_case.as_ref()
                        && !matches!(
                            case,
                            crate::font::TextCase::Original
                                | crate::font::TextCase::Upper
                                | crate::font::TextCase::Lower
                        )
                    {
                        note_lossy(
                            &mut lossy,
                            match case {
                                crate::font::TextCase::Title => "text-case-title",
                                crate::font::TextCase::SmallCaps => "text-case-smallcaps",
                                _ => "text-case-smallcaps-forced",
                            },
                        );
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
                            None,
                            None,
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
                        run.text_case.as_ref(),
                        run.paragraph.as_ref(),
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
                        None,
                        None,
                    )?);
                }
                if let Some(native_style) = layer.get_mut("style").and_then(Value::as_object_mut) {
                    native_style.insert("textStyle".into(), json!({"_class":"textStyle","verticalAlignment":vertical_alignment.unwrap_or(0)}));
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
                    s.width == SizeMode::Fill
                        || s.height == SizeMode::Fill
                        || (s.width == SizeMode::Hug && s.height != SizeMode::Hug)
                }) {
                    note_lossy(&mut lossy, "text-sizing-not-representable-in-native-sketch");
                }
                if style.is_some_and(|s| s.wrap) != (behaviour != 0) {
                    note_lossy(
                        &mut lossy,
                        "text-wrap-in-userInfo-native-sketch-may-wrap-differently",
                    );
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
                    .unwrap_or(
                        if style.is_some_and(|s| {
                            s.line_height > 0. && (s.line_height - 1.35).abs() > 1e-9
                        }) {
                            3
                        } else {
                            2
                        },
                    );
                layer.insert("lineSpacingBehaviour".into(), json!(spacing_behaviour));
                layer.insert(
                    "glyphBounds".into(),
                    json!(format!("{{0, 0, {}, {}}}", n.width, n.height)),
                );
            }
            "bitmap" => {
                if let Some(paint) = bitmap_paint.and_then(|index|n.fills.get(index))
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
                                        "_ref_class": "MSImageData", "_ref": format!("images/{name}")}),
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
                    "allGuttersGap": l.gap, "crossAxisGutterGap": l.line_gap, "wrappingEnabled": l.wrap
                }),
            );
            layer.insert("topPadding".into(), json!(l.padding[0]));
            layer.insert("rightPadding".into(), json!(l.padding[1]));
            layer.insert("bottomPadding".into(), json!(l.padding[2]));
            layer.insert("leftPadding".into(), json!(l.padding[3]));
            if l.reverse_flow {
                layer.insert("groupBehavior".into(), json!(u8::from(class == "artboard" || class == "canvasFrame")));
            }
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
        } else if n.layout.is_none()
            && let Some(payload) = n
                .bindings
                .get("sketchInferredGroupLayout")
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        {
            // Imported inferred (smart) group layouts return verbatim; the
            // kernel keeps the static child frames they produced.
            layer.insert("groupLayout".into(), payload);
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
                    a.kind == "back" || (matches!(a.kind.as_str(), "navigate" | "overlay")
                        && a.target
                            .as_ref()
                            .is_some_and(|t| doc.nodes.get(t).is_some_and(|n| n.kind == "frame")))
                })
            {
                let mut flow = Map::new();
                flow.insert("_class".into(), json!("MSImmutableFlowConnection"));
                flow.insert(
                    "destinationArtboardID".into(),
                    json!(if action.kind=="back" {Some("back".into())} else {action.target.as_deref().map(sketch_id)}),
                );
                flow.insert(
                    "transition".into(),
                    json!({"_class": "MSTransition",
                           "duration": action.duration_ms as f64 / 1000.}),
                );
                flow.insert("animationType".into(), json!(match action.transition_style.as_deref() {Some("slide-right")=>0,Some("slide-left")=>1,Some("slide-bottom")=>2,Some("slide-top")=>3,_=>-1}));
                flow.insert("maintainScrollPosition".into(), json!(action.transition_preserve_scroll.unwrap_or(false)));
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
                                || (a.transition_style.is_none() && a.duration_ms > 0)
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
            .filter(|_| descendants)
            .map(|c| export_layer(doc, c, images))
            .collect::<Result<Vec<_>>>()?;
        if class == "shapeGroup"
            && let Some(operation) = n.boolean_operation
        {
            if let Some(rule) = operation.compound_rule() {
                if let Some(style) = layer.get_mut("style") {
                    style["windingRule"] = json!(if rule == "nonzero" { 0 } else { 1 });
                }
            }
            let source = n
                .bindings
                .get("sketchSourceShapeGroup")
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
            let unchanged = source.as_ref().is_some_and(|source| {
                serde_json::from_value::<Vec<String>>(source["children"].clone())
                    .ok()
                    .as_ref()
                    == Some(&n.children)
                    && n.bindings
                        .get("sketchShapeGroupMappedOperation")
                        .and_then(|raw| serde_json::from_str::<crate::boolean::Operation>(raw).ok())
                        == Some(operation)
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
        } else if class == "shapeGroup" {
            layer.insert("layers".into(), json!([]));
        }
        if n.mask && n.mask_type.as_deref()==Some("outline") {
            return Err(Error::Unsupported("Sketch cannot yet preserve authored vector-mask paint/stroke semantics; save FD".into()));
        }
        if n.mask {
            layer.insert("hasClippingMask".into(), json!(true));
            match n.mask_type.as_deref() {
                Some("shape") => { layer.insert("clippingMaskMode".into(),json!(0)); }
                Some("alpha") => { layer.insert("clippingMaskMode".into(),json!(1)); }
                _ => {}
            }
        }
        // Kernel-native payloads that Sketch cannot express travel through
        // our userInfo namespace: the component definition (variants and
        // properties) survives symbol round-trips this way.
        let mut user_info = Map::new();
        user_info.insert("originalId".into(), json!(id));
        // Admission scales shapePath points only when this marker is set.
        // Native Sketch ignores the namespace; the coordinates themselves are
        // already frame-normalized strings.
        if class == "shapePath" {
            user_info.insert("geometryUnits".into(), json!("normalized"));
        }
        if let Some(l) = &n.layout {
            use crate::layout::Align::{UnsafeCenter, UnsafeEnd};
            if l.wrap || matches!(l.justify, UnsafeCenter | UnsafeEnd) || matches!(l.align, UnsafeCenter | UnsafeEnd) {
                user_info.insert("stackAlignment".into(), json!({"align":l.align,"justify":l.justify}));
            }
        }
        if n.effects.iter().any(|e|e.kind=="blur" || e.glass.is_some() || (e.kind=="background-blur" && e.gradient_blur.is_some())) {
            user_info.insert("legacyEffectModel".into(),json!({"native":native_effect_projection(&layer["style"]),"effects":n.effects}));
        }

        if n.kind == "text" {
            user_info.insert("textModel".into(),json!({"native":native_text_projection(&Value::Object(layer.clone())),"style":n.text_style,"runs":n.text_runs}));
            let behaviour = sketch_text_behaviour(n);
            let wrap = n.text_style.as_ref().is_some_and(|s| s.wrap);
            if wrap != (behaviour != 0) {
                user_info.insert(
                    "textWrap".into(),
                    json!({"textBehaviour": behaviour, "text": n.text, "wrap": wrap}),
                );
            }
        }
        if let Some(key) = &n.component_key {
            user_info.insert("componentKey".into(), json!(key));
        }
        if n.component_set {
            user_info.insert("componentSet".into(), json!(true));
        }
        if let Some(c) = &n.component {
            user_info.insert(
                "component".into(),
                serde_json::to_value(c).unwrap_or(Value::Null),
            );
        }
        if let Some(instance) = &n.instance {
            user_info.insert(
                "instance".into(),
                serde_json::to_value(instance).unwrap_or(Value::Null),
            );
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
        let mut all_user_info=n.bindings.get("sketchPluginUserInfo").and_then(|raw|serde_json::from_str::<Map<String,Value>>(raw).ok()).unwrap_or_default();
        all_user_info.insert("com.futureox.design-kernel".into(),Value::Object(user_info));
        layer.insert("userInfo".into(),Value::Object(all_user_info));
        if class == "hotspot" {
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
                    if key != "layers" && (key != "flow" || !n.bindings.contains_key("sketchFlowModeled")) && !layer.contains_key(&key) {
                        layer.insert(key, value);
                    }
                }
            }
        }
        // P0-4: splice preserved adaptable colors / swatch references back
        // into their style/text/background slots and restore the
        // updatableColors recolor markers.
        adaptable_apply_layer(&mut layer, n);
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
pub(crate) fn sketch_binding<'a>(doc: &'a Document, node: &'a Node, key: &str) -> Option<&'a str> {
    node.bindings.get(key).map(String::as_str).or_else(||doc.design_system.as_ref()?.sketch_containers.get("nodeMetadata")?.get(&node.id)?.get("bindings")?.get(key)?.as_str())
}
fn foreign_symbol_export(doc: &Document, images: &mut ExportedImages) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for (id, node) in &doc.nodes {
        let Some(library_id) = sketch_binding(doc,node,"sketchForeignLibraryID") else {
            continue;
        };
        let mut entry = sketch_binding(doc,node,"sketchForeignSymbolRaw")
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
            let symbol_id = exported_symbol_id(doc,id);
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
        if let Some(map)=entry.get_mut("remoteToLocalIDMap").and_then(Value::as_object_mut) {
            for local in map.values_mut() {
                if let Some(n)=local.as_str().and_then(|id|doc.nodes.get(id)) { *local=json!(sketch_id(&n.id)); }
            }
        }
        if !entry.contains_key("symbolPrivate") {
            entry.insert("symbolPrivate".into(), json!(false));
        }
        out.push(Value::Object(entry));
    }
    Ok(out)
}

/// Export the kernel document as a `.sketch` bundle Sketch can open.
/// Source-backed property commits use the same codec, excluding cold children.
#[cfg(not(target_arch = "wasm32"))]
pub fn export_sketch_layer_fields(doc: &Document, id: &str) -> Result<Value> {
    let node = doc
        .nodes
        .get(id)
        .ok_or_else(|| Error::MissingPart("Source node".into()))?;
    if node.vector_brush.is_some() || node.repeat.is_some() || sketch_placement(node).is_none() {
        return Err(Error::Unsupported(
            "Sketch cannot preserve this edited geometry; keep the source draft".into(),
        ));
    }
    let settings = doc.color_management.unwrap_or_default();
    settings.validate().map_err(Error::InvalidDocument)?;
    if !matches!(
        settings.document_space,
        ColorSpace::Srgb | ColorSpace::DisplayP3
    ) {
        return Err(Error::Unsupported(
            "Sketch requires an explicit SDR profile conversion".into(),
        ));
    }
    let mut images = ExportedImages {
        font_weight_axes: BTreeMap::new(),
        color_settings: settings,
        entries: Vec::new(),
        seen: Default::default(),
    };
    export_layer_impl(doc, id, &mut images, false)
}

/// Existing-source edits for which the current native Sketch codec has no
/// representation must fail before storage can acknowledge them. This is a
/// source-audited missing-codec guard, not a general roundtrip/format capability
/// oracle. Preserve ordinary paint/stroke/effect and new-subtree behavior until
/// their kind-specific semantic and identity contracts are separately proven.
#[cfg(not(target_arch = "wasm32"))]
pub fn export_sketch_layer_edit(
    before: &Document,
    after: &Document,
    id: &str,
) -> Result<(Value, Value)> {
    let old = before
        .nodes
        .get(id)
        .ok_or_else(|| Error::MissingPart("Existing source node".into()))?;
    let next = after
        .nodes
        .get(id)
        .ok_or_else(|| Error::MissingPart("Edited source node".into()))?;
    let image_state = |node:&Node| node.fills.iter().chain(node.strokes.iter().map(|s|&s.paint)).filter(|p|p.kind=="image")
        .map(|p|json!({"transform":p.transform,"adjust":p.adjust,"tile":p.tile})).collect::<Vec<_>>();
    let unsupported_image= image_state(old)!=image_state(next) && next.fills.iter().chain(next.strokes.iter().map(|s|&s.paint)).any(|p|p.kind=="image" &&
        (p.transform.is_some_and(|t|t!=Transform::default()) || p.adjust.is_some() || p.tile.as_ref().is_some_and(|t|t.is_active()) && sketch_pattern_scale(p,p.image.as_deref().and_then(data_uri_bytes).and_then(|(_,b)|bitmap_extent(&b))).is_none()));
    let unsupported = if unsupported_image { Some("imagePaint") }
    else if old.text_path != next.text_path { Some("textPath") }
    else if old.path_offset != next.path_offset { Some("pathOffset") }
    else if old.smoothing != next.smoothing
        && matches!(
            next.kind.as_str(),
            "rectangle" | "rect" | "frame" | "section" | "slice"
        ) {
        // Neither Importer::layer nor export_layer_impl has a smoothing codec.
        Some("smoothing")
    } else if old.clip != next.clip {
        // hasClippingMask maps Node.mask, not the distinct Node.clip property.
        Some("clip")
    } else if old.arc != next.arc && next.kind == "ellipse" {
        Some("arc")
    } else if old.corner_radius != next.corner_radius
        && matches!(next.kind.as_str(), "polygon" | "star")
    {
        // Rectangle cornerRadius point fields encode Node.radii, not the
        // polygon/star fillet property Node.corner_radius.
        Some("cornerRadius")
    } else if old.radii != next.radii && matches!(next.kind.as_str(), "frame" | "section" | "slice")
    {
        // Only the rectangle class emits fixedRadius and four curve-point radii.
        Some("radii")
    } else if old.export_settings != next.export_settings {
        // Full archive round trips retain settings; source-edit admission is stricter.
        Some("exportSettings")
    } else {
        None
    };
    if let Some(field) = unsupported {
        // Fixed schema field names only: no arbitrary nested keys or source text.
        return Err(Error::Unsupported(format!(
            "Source field {field} is not supported by the Sketch save codec; keep the draft or save a native document"
        )));
    }
    Ok((
        export_sketch_layer_fields(before, id)?,
        export_sketch_layer_fields(after, id)?,
    ))
}

/// Admit the six source-proven omissions for a newly authored source layer.
/// The caller must first validate the document and check that this ID is new.
/// This is not a whole-model roundtrip oracle: transient paint identities and
/// unrelated dormant UI defaults remain on the existing compatibility path.
#[cfg(not(target_arch = "wasm32"))]
pub fn validate_sketch_new_layer_for_source_save(node: &Node) -> Result<()> {
    let unsupported = if node.smoothing != 0.
        && matches!(
            node.kind.as_str(),
            "rectangle" | "rect" | "frame" | "section" | "slice"
        ) {
        // Preserve authored smoothing even with zero radii or no visible pixels.
        Some("smoothing")
    } else if node.clip {
        // New source-layer admission is intentionally stricter than full
        // archive export; the source mutation codec does not project clipping.
        Some("clip")
    } else if node.arc.is_some() && node.kind == "ellipse" {
        // Even an explicit full-circle arc is authored state, unlike None.
        Some("arc")
    } else if node.corner_radius != 0. && matches!(node.kind.as_str(), "polygon" | "star") {
        Some("cornerRadius")
    } else if node.radii.iter().any(|radius| *radius != 0.)
        && matches!(node.kind.as_str(), "frame" | "section" | "slice")
    {
        // Rectangle radii have a native mapping and remain admissible.
        Some("radii")
    } else if node.text_path.is_some() {Some("textPath")}
    else if node.path_offset != 0. {Some("pathOffset")}
    else if !node.export_settings.is_empty() {
        Some("exportSettings")
    } else {
        None
    };
    if let Some(field) = unsupported {
        // Match the existing-node guard's fixed, actionable error contract.
        return Err(Error::Unsupported(format!(
            "Source field {field} is not supported by the Sketch save codec; keep the draft or save a native document"
        )));
    }
    Ok(())
}

/// Opt-in affine baking for the compatibility exporter, mirroring sketch-hq
/// fig2sketch's `apply_transform`: a leaf vector node whose placement Sketch
/// cannot represent (any scale or shear) keeps its visual geometry by baking
/// the linear transform into the curve points and recomputing the frame from
/// the mapped unit box. This trades the editable transform for
/// convertibility; `export_sketch` keeps refusing such nodes. Non-vector
/// kinds, nodes with children, and singular matrices still take the default
/// refusal path so nothing is silently distorted. Returns the archive and the
/// number of baked nodes.

/// Approximate a parametric arc with cubic segments (standard k = 4/3·tan(Δ/4)),
/// used only by the opt-in `export_sketch_baked` pre-pass so arc-authored
/// leaves can become explicit vector geometry. The default exporter keeps
/// refusing parametric arcs instead of approximating silently.
fn baked_arc_commands(center: [f64; 2], radius: [f64; 2], start: f64, sweep: f64) -> Vec<crate::path::Command> {
    let segments = ((sweep.abs() / std::f64::consts::FRAC_PI_2).ceil() as usize).clamp(1, 32);
    let delta = sweep / segments as f64;
    let k = (4. / 3.) * (delta / 4.).tan();
    let direction = delta.signum();
    let point = |angle: f64| crate::math::Point::new(center[0] + angle.cos() * radius[0], center[1] + angle.sin() * radius[1]);
    let tangent = |angle: f64| crate::math::Point::new(-angle.sin() * radius[0] * direction, angle.cos() * radius[1] * direction);
    let mut commands = Vec::with_capacity(segments);
    for index in 0..segments {
        let a0 = start + delta * index as f64;
        let a1 = a0 + delta;
        let p0 = point(a0);
        let p3 = point(a1);
        let t0 = tangent(a0);
        let t1 = tangent(a1);
        commands.push(crate::path::Command::Cubic(
            crate::math::Point::new(p0.x + t0.x * k, p0.y + t0.y * k),
            crate::math::Point::new(p3.x - t1.x * k, p3.y - t1.y * k),
            p3,
        ));
    }
    commands
}

fn baked_explicit_path(path: &crate::path::Path) -> crate::path::Path {
    let mut commands = Vec::with_capacity(path.commands.len() * 2);
    for command in &path.commands {
        match command {
            crate::path::Command::Arc { center, radius, start, sweep } => {
                commands.extend(baked_arc_commands([center.x, center.y], [radius.x, radius.y], *start, *sweep))
            }
            other => commands.push(other.clone()),
        }
    }
    crate::path::Path { commands }
}

pub fn export_sketch_baked(doc: &Document) -> Result<(Vec<u8>, usize)> {
    let source = boolean_worksets::source_view(doc)?;
    let mut doc: Document = source.as_ref().clone();
    let mut baked = 0usize;
    for node in doc.nodes.values_mut() {
        // Figma OUTLINE masks and Sketch outline masks (clippingMaskMode 0)
        // clip to the path the same way. The remap is exact only when the
        // mask shape itself paints nothing: Sketch renders a mask layer's own
        // style while Figma ignores it. Painted outline masks and luminance
        // masks keep the default refusal.
        if node.mask_type.as_deref() == Some("outline") {
            // Figma never renders an outline mask's own style; Sketch does.
            // Disabling the paints keeps both sides rendering identically
            // while the authored paint data survives as disabled entries.
            for paint in node.fills.iter_mut() {
                paint.visible = false;
            }
            for stroke in node.strokes.iter_mut() {
                stroke.visible = false;
            }
            node.mask_type = Some("shape".into());
            baked += 1;
        }
    }
    let roots: Vec<String> = doc
        .pages
        .iter()
        .flat_map(|page| page.children.iter().cloned())
        .collect();
    let mut visited = std::collections::BTreeSet::new();
    for root in roots {
        baked += baked_subtree(&mut doc.nodes, root.as_str(), None, &mut visited);
    }
    // The exporter's refusal walk covers every node, including ones detached
    // from the page tree; bake those forests as extra roots.
    loop {
        let orphan = doc
            .nodes
            .keys()
            .find(|id| !visited.contains(*id))
            .cloned();
        let Some(orphan) = orphan else { break };
        baked += baked_subtree(&mut doc.nodes, orphan.as_str(), None, &mut visited);
    }
    let bytes = export_sketch(&doc)?;
    Ok((bytes, baked))
}

/// One node of the opt-in baked pre-pass. `pending` premultiplies the node's
/// transform with the un-applied linear part of an ancestor so world geometry
/// stays exact while containers become Sketch-representable:
/// - a shear-free placement (rotation ∘ scale) keeps its rotation, rescales
///   the box and propagates the pure scale to children;
/// - a sheared placement without its own box paints flattens to the mapped
///   axis-aligned bounds and propagates the full linear part;
/// - a sheared placement with visible fills/strokes keeps the default
///   refusal because Sketch cannot represent a sheared box losslessly;
/// - leaves bake the linear part into curve points exactly as before.
fn baked_subtree(doc: &mut crate::scene::DocumentNodes, id: &str, pending: Option<crate::math::Transform>, visited: &mut std::collections::BTreeSet<String>) -> usize {
    if !visited.insert(id.to_owned()) {
        return 0;
    }
    let Some(node) = doc.get_mut(id) else { return 0 };
    if let Some(pending) = pending {
        node.transform = pending.concat(node.transform);
    }
    // Independent stroke topology collapses onto the fill outline (the
    // vector-network encoder walks stroke-preferred curves but compares the
    // fill); an empty stroke geometry with active stroke paints keeps
    // refusing instead of inventing a stroke.
    if let Some(geometry) = node.vector_geometry.as_ref()
        && geometry
            .stroke
            .as_ref()
            .is_some_and(|stroke| *stroke != geometry.fill)
    {
        let stroke_was_empty = geometry.stroke.as_ref().unwrap().is_empty();
        if !stroke_was_empty || node.strokes.is_empty() {
            let shared = std::sync::Arc::make_mut(node.vector_geometry.as_mut().unwrap());
            shared.stroke = None;
            let children: Vec<String> = node.children.clone();
            return 1 + children
                .into_iter()
                .map(|child| baked_subtree(doc, child.as_str(), None, visited))
                .sum::<usize>();
        } else {
            let children: Vec<String> = node.children.clone();
            return children
                .into_iter()
                .map(|child| baked_subtree(doc, child.as_str(), None, visited))
                .sum::<usize>();
        }
    }
    let children: Vec<String> = node.children.clone();
    let rigid = sketch_placement(node).is_some();
    let parametric = matches!(node.kind.as_str(), "ellipse" | "star" | "polygon")
        && (node.arc.is_some() || node.corner_radius != 0.);
    if !node.vector_geometry.is_none() || (!rigid && children.is_empty()) || parametric {
        // Parametric leaves and non-rigid leaves become explicit vector
        // geometry first (kappa arc approximation, exporter point math).
        if node.vector_geometry.is_none() && (children.is_empty() || parametric) {
            let corners = [
                crate::math::Point::new(0., 0.),
                crate::math::Point::new(node.width, 0.),
                crate::math::Point::new(node.width, node.height),
                crate::math::Point::new(0., node.height),
            ];
            let path = match node.kind.as_str() {
                "rect" | "rectangle" if node.radii.iter().all(|r| (r - node.radii[0]).abs() < 1e-9) && node.radii[0] > 0. => {
                    crate::authoring_shapes::rounded_polygon(&corners, node.radii[0])
                }
                "rect" | "rectangle" => crate::path::Path {
                    commands: vec![
                        crate::path::Command::Move(corners[0]),
                        crate::path::Command::Line(corners[1]),
                        crate::path::Command::Line(corners[2]),
                        crate::path::Command::Line(corners[3]),
                        crate::path::Command::Close,
                    ],
                },
                "ellipse" => crate::authoring_shapes::ellipse_arc(
                    node.width,
                    node.height,
                    node.arc.unwrap_or(crate::scene::EllipseArc { start_angle: 0., sweep_angle: std::f64::consts::TAU, inner_radius: 0. }),
                ),
                "star" | "polygon" => {
                    let count = node.points.clamp(3, 128) * if node.kind == "star" { 2 } else { 1 };
                    let star = node.kind == "star";
                    let ring: Vec<crate::math::Point> = (0..count)
                        .map(|i| {
                            let angle = i as f64 * std::f64::consts::TAU / count as f64 - std::f64::consts::FRAC_PI_2;
                            let radius = if star && i % 2 != 0 { node.inner_radius } else { 1. };
                            crate::math::Point::new(
                                node.width / 2. + node.width / 2. * radius * angle.cos(),
                                node.height / 2. + node.height / 2. * radius * angle.sin(),
                            )
                        })
                        .collect();
                    if node.corner_radius > 0. {
                        crate::authoring_shapes::rounded_polygon(&ring, node.corner_radius)
                    } else {
                        crate::path::Path {
                            commands: std::iter::once(crate::path::Command::Move(ring[0]))
                                .chain(ring[1..].iter().map(|p| crate::path::Command::Line(*p)))
                                .chain(std::iter::once(crate::path::Command::Close))
                                .collect(),
                        }
                    }
                }
                _ => crate::path::Path::default(),
            };
            if let Ok(fill) = crate::vector_geometry::encode(&baked_explicit_path(&path)) {
                node.kind = "vector".into();
                node.vector_geometry = Some(std::sync::Arc::new(crate::vector_geometry::VectorGeometry {
                    fill_rule: "nonzero".into(),
                    fill,
                    stroke: None,
                }));
            }
        }
    }
    if parametric {
        node.kind = "vector".into();
    }
    if rigid && !parametric {
        return children
            .into_iter()
            .map(|child| baked_subtree(doc, child.as_str(), None, visited))
            .sum::<usize>()
            + usize::from(pending.is_some());
    }
    let [a, b, c, d, x, y] = node.transform.0;
    let determinant = a * d - b * c;
    let recurse_plain = |doc: &mut crate::scene::DocumentNodes, children: &[String], visited: &mut std::collections::BTreeSet<String>| {
        children
            .iter()
            .map(|child| baked_subtree(doc, child, None, visited))
            .sum::<usize>()
    };
    if !determinant.is_finite() || determinant.abs() < 1e-12 {
        return recurse_plain(doc, &children, visited); // singular: keep the explicit refusal
    }
    let scale_x = (a * a + b * b).sqrt();
    let scale_y = (c * c + d * d).sqrt();
    let shear_free = (a * c + b * d).abs() < 1e-9 * (scale_x * scale_y).max(1.);
    let paints_box = node
        .fills
        .iter()
        .any(|paint| paint.visible)
        || node.strokes.iter().any(|stroke| stroke.visible);
    if !children.is_empty() {
        if shear_free && scale_x.is_finite() && scale_y.is_finite() && scale_x > 1e-12 && scale_y > 1e-12 {
            // Keep the rotation on the container, rescale the box, and hand
            // the pure scale to the children: R∘S∘K = R∘(S∘K).
            let scale = crate::math::Transform([scale_x, 0., 0., scale_y, 0., 0.]);
            let rotation = crate::math::Transform([a / scale_x, b / scale_x, c / scale_y, d / scale_y, x, y]);
            if let Some(geometry) = node.vector_geometry.as_mut() {
                let shared = std::sync::Arc::make_mut(geometry);
                let sx = scale_x;
                let sy = scale_y;
                shared.scale(sx.max(1e-12), sy.max(1e-12));
            }
            node.transform = rotation;
            node.width *= scale_x;
            node.height *= scale_y;
            node.corner_radius = 0.;
            return 1 + children
                .into_iter()
                .map(|child| baked_subtree(doc, child.as_str(), Some(scale), visited))
                .sum::<usize>();
        }
        if paints_box {
            // A sheared box with its own paint cannot be represented
            // losslessly; keep the default refusal for this node.
            return recurse_plain(doc, &children, visited);
        }
    }
    // Flatten to the mapped axis-aligned bounds (leaf curves or a paint-free
    // container): every curve point is mapped exactly, the frame becomes the
    // mapped unit-box bounds, and children carry [L | -min].
    let corners = [
        (c * node.height, d * node.height),
        (a * node.width, c * node.width),
        (a * node.width + c * node.height, b * node.width + d * node.height),
        (0., 0.),
    ];
    let min_x = corners.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let min_y = corners.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let max_x = corners.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
    let max_y = corners.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
    let mut baked = usize::from(pending.is_some());
    if let Some(geometry) = node.vector_geometry.take() {
        let mut geometry = (*geometry).clone();
        let bake = |values: &mut [f64], offset: usize| {
            let (px, py) = (values[offset], values[offset + 1]);
            values[offset] = a * px + c * py - min_x;
            values[offset + 1] = b * px + d * py - min_y;
        };
        let mut fills = std::mem::take(&mut geometry.fill);
        baked_curves(&mut fills, &bake);
        geometry.fill = fills;
        if let Some(strokes) = geometry.stroke.as_mut() {
            let mut moved = std::mem::take(strokes);
            baked_curves(&mut moved, &bake);
            geometry.stroke = Some(moved);
        }
        node.vector_geometry = Some(std::sync::Arc::new(geometry));
        baked = 1;
    }
    node.transform = crate::math::Transform([1., 0., 0., 1., x + min_x, y + min_y]);
    node.width = max_x - min_x;
    node.height = max_y - min_y;
    node.corner_radius = 0.;
    if children.is_empty() {
        return baked.max(1);
    }
    let child_pending = crate::math::Transform([a, b, c, d, -min_x, -min_y]);
    baked + children
        .into_iter()
        .map(|child| baked_subtree(doc, child.as_str(), Some(child_pending), visited))
        .sum::<usize>()
}

fn baked_curves(
    curves: &mut [crate::vector_geometry::Curve],
    bake: &impl Fn(&mut [f64], usize),
) {
    for curve in curves.iter_mut() {
        match curve {
            crate::vector_geometry::Curve::Move(p) | crate::vector_geometry::Curve::Line(p) => bake(p, 0),
            crate::vector_geometry::Curve::Quad(p) => {
                bake(p, 0);
                bake(p, 2);
            }
            crate::vector_geometry::Curve::Cubic(p) => {
                bake(p, 0);
                bake(p, 2);
                bake(p, 4);
            }
            crate::vector_geometry::Curve::Close => {}
        }
    }
}

fn shared_style_model(shared: &crate::design_system::SharedStyle) -> Value {
    json!({"value": shared.value, "strokes": shared.strokes, "effects": shared.effects})
}

/// Write an edited foreign layer style back into `foreignLayerStyles`.
/// Unchanged styles keep the imported container bytes. The instance override
/// remains a shared-style id, so the fill, stroke and effect stay one style.
fn sync_foreign_paint_styles(document: &mut Value, doc: &Document, images: &mut ExportedImages) -> Result<()> {
    let Some(system) = doc.design_system.as_ref() else { return Ok(()) };
    let Some(entries) = document.get_mut("foreignLayerStyles").and_then(Value::as_array_mut) else { return Ok(()) };
    for entry in entries {
        let Some(local_id) = entry.pointer("/localSharedStyle/do_objectID").and_then(Value::as_str).map(str::to_owned) else { continue };
        let Some(shared) = system.styles.get(&local_id) else { continue };
        if shared.kind != "paint" { continue };
        let stored = system.sketch_containers.get("sharedStyleFidelity").and_then(|styles| styles.get(&local_id)).and_then(|style| style.get("model"));
        if stored == Some(&shared_style_model(shared)) { continue };
        let mut paints = Vec::new();
        if let Some(values) = shared.value.as_array() {
            for value in values {
                let Ok(paint) = serde_json::from_value::<Paint>(value.clone()) else { continue };
                if let Some(part) = export_paint(&paint, images, [1., 1.])? {
                    paints.push(part);
                }
            }
        }
        let mut lossy = Vec::new();
        let (borders, shadows, inner_shadows, blur, border_options) = export_style_parts(&shared.strokes, &shared.effects, &mut lossy, images, [1., 1.])?;
        if !lossy.is_empty() {
            return Err(Error::Unsupported(format!(
                "Sketch foreign layer style `{local_id}` edit cannot preserve {}; keep the original .sketch file",
                lossy.join(",")
            )));
        }
        let Some(value) = entry.pointer_mut("/localSharedStyle/value") else { continue };
        if !value.is_object() {
            *value = json!({"_class": "style"});
        }
        value["fills"] = Value::Array(paints);
        value["borders"] = Value::Array(borders);
        value["shadows"] = Value::Array(shadows);
        value["innerShadows"] = Value::Array(inner_shadows);
        value["blur"] = blur;
        value["borderOptions"] = border_options;
    }
    Ok(())
}

/// Export the kernel document as a `.sketch` bundle Sketch can open.
fn foreign_shared_style_ids(system: &crate::design_system::DesignSystem) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for key in ["foreignLayerStyles", "foreignTextStyles"] {
        let Some(entries) = system.sketch_containers.get(key).and_then(Value::as_array) else { continue };
        for entry in entries {
            let Some(wire) = entry.pointer("/localSharedStyle/do_objectID").and_then(Value::as_str) else { continue };
            ids.insert(wire.to_owned());
            if let Some(mapped) = system.sketch_containers.get("sharedStyleIds").and_then(|ids| ids.get(wire)).and_then(Value::as_str) {
                ids.insert(mapped.to_owned());
            }
        }
    }
    ids
}

pub fn export_sketch(doc: &Document) -> Result<Vec<u8>> {
    let source = boolean_worksets::source_view(doc)?;
    let doc = source.as_ref();
    if let Some(node) = doc.nodes.values().find(|n| n.vector_brush.is_some()) {
        return Err(Error::Unsupported(format!(
            "Sketch cannot preserve editable vector brush on layer `{}`; preserve the native FD document or explicitly bake the brush before exporting",
            node.id
        )));
    }
    if let Some(node) = doc.nodes.values().find(|n| n.repeat.is_some()) {
        return Err(Error::Unsupported(format!(
            "Sketch cannot preserve non-destructive repeated transforms on layer `{}`; save native FD/JSON to retain editability, or export PNG/SVG/PDF for visual output",
            node.id
        )));
    }
    let settings = doc.color_management.unwrap_or_default();
    if !matches!(
        settings.document_space,
        ColorSpace::Srgb | ColorSpace::DisplayP3
    ) {
        return Err(Error::Unsupported(format!(
            "Sketch only supports sRGB or Display P3 document profiles, not {:?}; preserve the native file or explicitly convert an SDR copy",
            settings.document_space
        )));
    }
    settings.validate().map_err(Error::InvalidDocument)?;
    for node in doc.nodes.values() {
        if sketch_placement(node).is_none() {
            return Err(Error::Unsupported(format!(
                "Sketch export cannot represent scaled or sheared affine placement on layer `{}` without changing editable geometry; use the native document format",
                node.id
            )));
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
                map.insert(
                    "layers".into(),
                    Value::Array(
                        page.children
                            .iter()
                            .filter(|id|doc.nodes.get(*id).is_none_or(|n|sketch_binding(doc,n,"sketchForeignLibraryID").is_none()))
                            .map(|id| export_layer(doc, id, &mut images))
                            .collect::<Result<Vec<_>>>()?,
                    ),
                );
                map.insert(
                    "userInfo".into(),
                    json!({"com.futureox.design-kernel":{"originalId":page.id}}),
                );
                // Ruler guides (schema-11 Page.guides): the raw imported
                // rulerData is authoritative while its guide count still
                // matches the modeled guides (preserving colors and other
                // payload); otherwise the modeled {axis, position} pairs
                // rebuild the containers. The horizontal ruler archives
                // vertical lines (x), the vertical one horizontal (y).
                let raw_rulers = doc
                    .design_system
                    .as_ref()
                    .and_then(|s| s.sketch_containers.get("rulerData"))
                    .and_then(|r| r.get(&page.id));
                let counts_match = |raw: &Value| {
                    let raw_count = |key: &str| {
                        raw.get(key)
                            .and_then(|d| d.get("guides"))
                            .and_then(Value::as_array)
                            .map(|a| a.len())
                            .unwrap_or(0)
                    };
                    raw_count("horizontalRulerData")
                        == page.guides.iter().filter(|g| g.axis == "x").count()
                        && raw_count("verticalRulerData")
                            == page.guides.iter().filter(|g| g.axis == "y").count()
                };
                if let Some(raw) = raw_rulers.filter(|raw| counts_match(raw)) {
                    for key in ["horizontalRulerData", "verticalRulerData"] {
                        if let Some(value) = raw.get(key) {
                            map.insert(key.into(), value.clone());
                        }
                    }
                } else if !page.guides.is_empty() {
                    let build = |axis: &str| {
                        json!({"_class": "rulerData", "noLabelsOnExport": false,
                               "guides": page.guides.iter().filter(|g| g.axis == axis)
                                   .map(|g| json!({"_class": "rulerGuide", "pos": g.position}))
                                   .collect::<Vec<_>>()})
                    };
                    map.insert("horizontalRulerData".into(), build("x"));
                    map.insert("verticalRulerData".into(), build("y"));
                }
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
            serde_json::to_vec(&page_json).map_err(|e| Error::Io(e.to_string()))?,
        ));
    }

    // P0-4: color space. Sketch document.json colorSpace: 0 unmanaged,
    // 1 sRGB, 2 P3 — the kernel color_management maps onto the same three
    // states. Unsupported target profiles have already failed at admission;
    // no linear/HDR document is silently relabelled as unmanaged.
    let sketch_srgb_tag = doc
        .design_system
        .as_ref()
        .and_then(|system| system.sketch_containers.get("sketchDocumentColorSpace"))
        .and_then(Value::as_i64)
        == Some(1);
    let color_space = match doc.color_management.as_ref().map(|c| c.document_space) {
        Some(crate::color::ColorSpace::DisplayP3) => 2,
        Some(crate::color::ColorSpace::Srgb) => 1,
        _ if sketch_srgb_tag => 1,
        _ => 0,
    };

    // P1-6: shared style containers (22 号字典 §6: document.json
    // layerStyles/layerTextStyles hold the definitions layers reference by
    // sharedStyleID). Kernel paint styles carry fills; text styles carry
    // the paragraph/font basics.
    let mut layer_styles = Vec::new();
    let mut layer_text_styles = Vec::new();
    if let Some(system) = &doc.design_system {
        let foreign_styles = foreign_shared_style_ids(system);
        for (style_id, shared) in &system.styles {
            if foreign_styles.contains(style_id) {
                continue;
            }
            let object = match shared.kind.as_str() {
                "paint" => {
                    let mut paints = Vec::new();
                    if let Some(values) = shared.value.as_array() {
                        for value in values {
                            if let Ok(paint) = serde_json::from_value::<Paint>(value.clone())
                                && let Some(part) = export_paint(&paint, &mut images, [1., 1.])?
                            {
                                paints.push(part);
                            }
                        }
                    }
                    // Full layer styles archive borders/shadows/blur next to
                    // their fills; the shared helper writes the same parts a
                    // layer with these strokes/effects would.
                    let mut style_lossy = Vec::new();
                    let (borders, shadows, inner_shadows, blur, border_options) =
                        export_style_parts(
                            &shared.strokes,
                            &shared.effects,
                            &mut style_lossy,
                            &mut images,
                            [1., 1.],
                        )?;
                    let controls = shared.effects.iter().find(|e|e.kind=="color-controls").and_then(|e|e.color_controls.map(|c|
                        json!({"_class":"colorControls","isEnabled":e.visible,"brightness":c.brightness,
                            "contrast":c.contrast,"saturation":c.saturation,"hue":c.hue})));
                    json!({"_class":"sharedStyle", "do_objectID": sketch_shared_style_id(style_id), "name": shared.name,
                           "value": {"_class": "style", "do_objectID": sketch_id(style_id),
                                     "fills": paints, "borders": borders,
                                     "shadows": shadows, "innerShadows": inner_shadows,
                                     "blurs": modern_blurs(&shared.effects,&blur), "blur": blur, "borderOptions": border_options,
                                     "colorControls": controls.unwrap_or_else(||json!({"_class":"colorControls","isEnabled":false,"brightness":0.,"contrast":1.,"saturation":1.,"hue":0.}))}})
                }
                "text" => {
                    let style: Option<crate::font::TextStyle> =
                        serde_json::from_value(shared.value.clone()).ok();
                    let encoded = style.as_ref().map(|s| {
                        json!({
                            "_class": "textStyle",
                            "verticalAlignment":match s.vertical_align.as_str() { "center"=>1,"bottom"=>2,_=>0 },
                            "encodedAttributes": {
                                "MSAttributedStringFontAttribute": sketch_font_descriptor(doc, &mut images.font_weight_axes, &s.font_id, 16., s.weight, None),
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
                        if let Some(settings) = part["contextSettings"].as_object_mut() {
                            settings.remove("isProgressive");
                        }
                        if part.get("gradient").is_none() {
                            part["gradient"] = json!({"_class":"gradient", "gradientType":0, "elipseLength":0,
                                "from":"{0.5, 0}", "to":"{0.5, 1}", "stops":[
                                    {"_class":"gradientStop", "position":0, "color":part["color"]},
                                    {"_class":"gradientStop", "position":1, "color":part["color"]}]});
                        }
                    }
                }
            }
            if value
                .pointer("/textStyle/encodedAttributes/paragraphStyle/firstLineHeadIndent")
                .and_then(Value::as_f64)
                == Some(0.)
            {
                value["textStyle"]["encodedAttributes"]["paragraphStyle"]
                    .as_object_mut()
                    .unwrap()
                    .remove("firstLineHeadIndent");
            }
            value["startMarkerType"] = json!(0);
            value["endMarkerType"] = json!(0);
            value["miterLimit"] = json!(10);
            value["windingRule"] = json!(1);
            if value.get("innerShadows").is_none() {
                value["innerShadows"] = json!([]);
            }
            if value.get("borderOptions").is_none() {
                value["borderOptions"] = json!({"_class":"borderOptions", "isEnabled":true,
                    "dashPattern":[], "lineCapStyle":0, "lineJoinStyle":0});
            }
            if let Some(options) = value["borderOptions"].as_object_mut() {
                for field in [
                    "startMarkerType",
                    "endMarkerType",
                    "miterLimit",
                    "windingRule",
                ] {
                    options.remove(field);
                }
                options.insert("isEnabled".into(), json!(true));
            }
            if value.get("colorControls").is_none() {
                value["colorControls"] = json!({"_class":"colorControls", "isEnabled":false,
                    "brightness":0, "contrast":1, "hue":0, "saturation":1});
            }
            if let Some(fidelity) = system
                .sketch_containers
                .get("sharedStyleFidelity")
                .and_then(|f| f.get(style_id))
            {
                if fidelity.get("model") == Some(&json!({"value":shared.value,"strokes":shared.strokes,"effects":shared.effects})) {
                    adaptable_apply_shared_style(&mut object, fidelity);
                }
            }
            if shared.kind == "paint" && shared.effects.iter().any(|e| e.kind == "blur" || e.glass.is_some() || (e.kind=="background-blur" && e.gradient_blur.is_some())) {
                object["userInfo"] = json!({"com.futureox.design-kernel": {"legacyEffectModel": {
                    "native": native_effect_projection(&object["value"]), "effects": shared.effects
                }}});
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
        let ids: Map<String, Value> = system
            .styles
            .keys()
            .map(|id| (sketch_shared_style_id(id), json!(id)))
            .collect();
        document["userInfo"] = json!({"com.futureox.design-kernel":{"sharedStyleIds":ids}});
    }
    if doc.color_management.as_ref().is_some_and(|c| c.document_space == crate::color::ColorSpace::Srgb) {
        let user = document
            .as_object_mut()
            .expect("document object")
            .entry("userInfo")
            .or_insert_with(|| json!({}));
        if !user.is_object() {
            *user = json!({});
        }
        let ns = user
            .as_object_mut()
            .expect("userInfo object")
            .entry("com.futureox.design-kernel")
            .or_insert_with(|| json!({}));
        if !ns.is_object() {
            *ns = json!({});
        }
        ns.as_object_mut()
            .expect("kernel userInfo object")
            .insert("linearSrgbComposite".into(), json!(true));
    }
    // P1-13: document-level containers return as imported. An edited foreign
    // layer style is written back below; an unchanged one stays byte-identical.
    // Foreign symbols are rebuilt from their local masters, with entries that
    // had no embedded copy appended raw.
    if let Some(system) = &doc.design_system {
        for (key, value) in &system.sketch_containers {
            if matches!(
                key.as_str(),
                "sharedStyleFidelity"
                    | "sharedStyleIds"
                    | "foreignSymbolsUnresolved"
                    | "nonEmbeddedFontReferences"
                    | "nodeMetadata"
                    | "textSourceLayouts"
                    | "rulerData"
                    | "figDocument"
                    | "figRetainedStyles"
                    | "sketchDocumentColorSpace"
                    | "sketchStyleAliases"
                    | "sketchCheckedLibraries"
            ) {
                continue;
            }
            document[key] = value.clone();
        }
    }
    sync_foreign_paint_styles(&mut document, doc, &mut images)?;
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
    let has_glass = doc.nodes.values().any(|n| n.effects.iter().any(|e|e.glass.is_some())) ||
        doc.design_system.as_ref().is_some_and(|s|s.styles.values().any(|style|style.effects.iter().any(|e|e.glass.is_some())));
    let archive_version=if has_glass {196} else {160};
    let producer = json!({
        "app": "com.futureox.design-kernel",
        "appVersion": env!("CARGO_PKG_VERSION"),
        "build": 1,
        "commit": "interop",
        "version": archive_version,
        "compatibilityVersion": 99,
        "coeditCompatibilityVersion": archive_version,
        "variant": "NONAPPSTORE",
    });
    let mut meta=producer.clone();
    meta["created"]=producer;
    meta["pagesAndArtboards"]=json!(pages_and_artboards);
    meta["saveHistory"]=json!(["interop"]);

    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    // Compact JSON halves the archive weight versus pretty printing (native
    // Sketch serializes compactly too) and keeps large real documents inside
    // the reader's per-entry budget.
    let push_json = |entries: &mut Vec<(String, Vec<u8>)>, name: &str, value: &Value| {
        entries.push((
            name.to_string(),
            serde_json::to_vec(value).unwrap_or_default(),
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

/// A caller-visible import route and the full native failure if conversion was needed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FigImportReport {
    pub document: Document,
    pub backend: &'static str,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_error: Option<String>,
}

/// Native Kiwi first, then the optional local converter. Use the report entry
/// point when presenting fidelity or fallback details to a user.
pub fn import_fig(bytes: &[u8]) -> Result<Document> {
    Ok(import_fig_report(bytes)?.document)
}

pub fn import_fig_report(bytes: &[u8]) -> Result<FigImportReport> {
    #[cfg(target_arch = "wasm32")]
    { let _=bytes; Err(Error::UnsupportedFigPlatform) }
    #[cfg(not(target_arch = "wasm32"))]
    {
        if !is_fig_file(bytes) && !bytes.starts_with(b"fig-kiwi") {
            return Err(Error::NotAZip("canvas.fig marker missing".into()));
        }
        match crate::fig::import_fig_native(bytes) {
            Ok(document) => {
                let mut warnings=Vec::new();
                if let Some(metadata)=document.design_system.as_ref().and_then(|s|s.sketch_containers.get("nodeMetadata")).and_then(Value::as_object) {
                    for (id,source) in metadata {
                        if let Some(notes)=source.pointer("/bindings/figUntranslated").and_then(Value::as_str) {
                            warnings.push(format!("FIG {id}: {notes}"));
                        }
                        if source.pointer("/bindings/prototypeFlow").is_some() {
                            warnings.push(format!("FIG {id}: prototype interactions retained as source metadata, not executable"));
                        }
                    }
                }
                if let Some(notes)=document.design_system.as_ref().and_then(|s|s.sketch_containers.get("figDocument")).and_then(|v|v.get("notes")).and_then(Value::as_array) {
                    for note in notes.iter().filter_map(Value::as_str) {
                        warnings.push(format!("FIG document: {note}"));
                    }
                }
                Ok(FigImportReport {document, backend:"rust-native-fig", warnings, native_error:None})
            },
            Err(native) => {
                let converted=import_fig_via_converter(bytes).map_err(|converter|Error::Unsupported(format!("FIG native import failed: {native}; fig2sketch fallback failed: {converter}")))?;
                let mut warnings=converted.warnings;
                warnings.insert(0,format!("FIG used fig2sketch compatibility conversion; native import failed: {native}"));
                Ok(FigImportReport {document:converted.document, backend:"fig2sketch", warnings, native_error:Some(native.to_string())})
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
fn import_fig_via_converter(bytes: &[u8]) -> Result<SketchImportReport> {
    import_fig_via_converter_at(bytes, &fig2sketch_path())
}

#[cfg(not(target_arch = "wasm32"))]
fn import_fig_via_converter_at(bytes: &[u8], helper: &std::path::Path) -> Result<SketchImportReport> {
    if !helper.exists() {
        return Err(Error::Fig2Sketch(format!("converter not found at {} (set FIG2SKETCH_BIN)",helper.display())));
    }
    static SEQUENCE: std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
    let sequence=SEQUENCE.fetch_add(1,std::sync::atomic::Ordering::Relaxed);
    let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|Error::Io(e.to_string()))?.as_nanos();
    let dir=std::env::temp_dir().join(format!("fxdk-fig-{}-{now}-{sequence}",std::process::id()));
    std::fs::create_dir(&dir).map_err(|e|Error::Io(e.to_string()))?;
    struct OwnedDirectory(std::path::PathBuf);
    impl Drop for OwnedDirectory {fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}}
    let _cleanup=OwnedDirectory(dir.clone());
    let input=dir.join("input.fig");let output=dir.join("output.sketch");
    std::fs::write(&input,bytes).map_err(|e|Error::Io(e.to_string()))?;
    let status=std::process::Command::new(helper).arg(&input).arg(&output).output().map_err(|e|Error::Fig2Sketch(e.to_string()))?;
    if !status.status.success() {
        return Err(Error::Fig2Sketch(format!("exit {:?}: {}",status.status.code(),String::from_utf8_lossy(&status.stderr).chars().take(400).collect::<String>())));
    }
    let size=std::fs::metadata(&output).map_err(|e|Error::Fig2Sketch(format!("no output file: {e}")))?.len();
    if size>archive_limits().input as u64 {return Err(archive_limit("converted FIG input bytes"));}
    let sketch_bytes=std::fs::read(&output).map_err(|e|Error::Fig2Sketch(format!("cannot read converter output: {e}")))?;
    import_sketch_report(&sketch_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn large_source_boolean_is_bounded_for_render_and_exports_original_hierarchy() {
        for code in 0..4 {
            let layers=(0..204).map(|i|json!({"_class":"rectangle","do_objectID":format!("rect{i}"),"booleanOperation":code,"frame":{"x":i*3,"y":0,"width":1,"height":10}})).collect::<Vec<_>>();
            let files=BTreeMap::from([("meta.json".into(),br#"{"version":136}"#.to_vec()),("document.json".into(),br#"{"colorSpace":1,"pages":[{"_ref":"pages/p"}]}"#.to_vec()),("pages/p.json".into(),serde_json::to_vec(&json!({"_class":"page","layers":[{"_class":"shapeGroup","do_objectID":"n","frame":{"width":612,"height":10},"layers":layers,"style":{"fills":[{"isEnabled":true,"fillType":0,"color":{"red":0.2,"green":0.4,"blue":0.8,"alpha":1}}]}}]})).unwrap())]);
            let report = finish_sketch_report(import_sketch_files(&files).unwrap()).unwrap();
            let mut document = report.document;
            document.raster_profile = Some(crate::fidelity::RasterProfile::FigmaSoftware);
            document.validate().unwrap();
            assert!(
                document
                    .nodes
                    .values()
                    .filter(|n| n.boolean_operation.is_some())
                    .all(|n| n.children.len() <= 64)
            );
            let bytes = export_sketch(&document).unwrap();
            let parts = crate::sketch::archive::read(&bytes).unwrap();
            let page: Value = serde_json::from_slice(
                parts
                    .iter()
                    .find(|(name, _)| name.starts_with("pages/"))
                    .unwrap()
                    .1,
            )
            .unwrap();
            assert_eq!(page["layers"][0]["layers"].as_array().unwrap().len(), 204);
            let mut reference = boolean_worksets::source_view(&document)
                .unwrap()
                .into_owned();
            let fills = reference.nodes["n"].fills.clone();
            for (i, id) in reference.nodes["n"]
                .children
                .clone()
                .into_iter()
                .enumerate()
            {
                let child = reference.nodes.get_mut(&id).unwrap();
                child.fills = fills.clone();
                child.visible = match code {
                    1 => i == 0,
                    3 => false,
                    _ => true,
                };
            }
            let root = reference.nodes.get_mut("n").unwrap();
            root.kind = "group".into();
            root.boolean_operation = None;
            root.fills.clear();
            let mut a = crate::Engine::new();
            let mut b = crate::Engine::new();
            a.load_document(&serde_json::to_string(&document).unwrap())
                .unwrap();
            b.load_document(&serde_json::to_string(&reference).unwrap())
                .unwrap();
            let options = crate::RenderOptions {
                page_id: "p".into(),
                width: 620,
                height: 16,
                view: crate::View {
                    x: 0.,
                    y: 0.,
                    zoom: 1.,
                },
                transparent: true,
                grid: false,
                pixel_preview: None,
                animation: None,
                raster_profile: crate::fidelity::RasterProfile::FigmaSoftware,
                interactive_effects: false,
                checkerboard: false,
            };
            let actual = a.render(&options).unwrap();
            let expected = b.render(&options).unwrap();
            let changed = actual.iter().zip(&expected).filter(|(a, b)| a != b).count();
            assert_eq!(changed, 0, "Sketch boolean code {code}");
        }
    }
    #[test]
    fn sketch_style_winding_controls_render_fill_and_survives_export() {
        for (rule, inside) in [(0, true), (1, false)] {
            let points=[[0.,0.],[1.,0.],[1.,1.],[0.,1.],[0.,0.],[1.,0.],[1.,1.],[0.,1.]].into_iter().map(|p|json!({"point":format!("{{{}, {}}}",p[0],p[1]),"hasCurveFrom":false,"hasCurveTo":false})).collect::<Vec<_>>();
            let files=BTreeMap::from([("meta.json".into(),br#"{"version":136}"#.to_vec()),("document.json".into(),br#"{"pages":[{"_ref":"pages/p"}]}"#.to_vec()),("pages/p.json".into(),serde_json::to_vec(&json!({"_class":"page","layers":[{"_class":"shapePath","do_objectID":"n","isClosed":true,"frame":{"width":20,"height":20},"points":points,"style":{"windingRule":rule,"fills":[{"fillType":0,"isEnabled":true,"color":{"red":1,"green":0,"blue":0,"alpha":1}}]}}]})).unwrap())]);
            let report = finish_sketch_report(import_sketch_files(&files).unwrap()).unwrap();
            assert_eq!(
                crate::hit_test_fill_device(
                    &report.document.nodes["n"],
                    crate::math::Point::new(10., 10.),
                    Transform::default()
                )
                .unwrap(),
                inside
            );
            let back = import_sketch_report(&export_sketch(&report.document).unwrap()).unwrap();
            assert_eq!(
                back.document.nodes["n"].network.as_ref().unwrap().fill_rule,
                if rule == 0 { "nonzero" } else { "evenodd" }
            );
        }
    }
    #[test]
    fn extreme_perpendicular_linear_anchor_has_identical_mapping_and_keeps_raw_source() {
        let source = json!({"gradientType":0,"from":"{510351200223232, 0}","to":"{510351200223232, 1}","stops":[{"position":0,"color":{"red":0.,"green":0.,"blue":0.,"alpha":1.}},{"position":1,"color":{"red":1.,"green":1.,"blue":1.,"alpha":1.}}]});
        let mut reference = source.clone();
        reference["from"] = json!("{0, 0}");
        reference["to"] = json!("{0, 1}");
        let a = gradient_paint(&source, 1, [0.1, 146.], ColorSpace::Srgb).unwrap();
        let b = gradient_paint(&reference, 1, [0.1, 146.], ColorSpace::Srgb).unwrap();
        assert_eq!(a, b);
        let files=BTreeMap::from([("meta.json".into(),br#"{"version":136}"#.to_vec()),("document.json".into(),br#"{"pages":[{"_ref":"pages/p"}]}"#.to_vec()),("pages/p.json".into(),serde_json::to_vec(&json!({"_class":"page","layers":[{"_class":"rectangle","do_objectID":"n","frame":{"width":10,"height":146},"style":{"fills":[{"isEnabled":true,"fillType":1,"gradient":source}]}}]})).unwrap())]);
        let report = finish_sketch_report(import_sketch_files(&files).unwrap()).unwrap();
        let bytes = export_sketch(&report.document).unwrap();
        let parts = crate::sketch::archive::read(&bytes).unwrap();
        let page: Value = serde_json::from_slice(
            parts
                .iter()
                .find(|(name, _)| name.starts_with("pages/"))
                .unwrap()
                .1,
        )
        .unwrap();
        assert_eq!(
            page["layers"][0]["style"]["fills"][0]["gradient"]["from"],
            source["from"]
        );
    }
    #[test]
    fn empty_sketch_shape_group_stays_empty_and_round_trips_as_a_group() {
        let files=BTreeMap::from([("meta.json".into(),br#"{"version":136}"#.to_vec()),("document.json".into(),br#"{"pages":[{"_ref":"pages/p"}]}"#.to_vec()),("pages/p.json".into(),serde_json::to_vec(&json!({"_class":"page","layers":[{"_class":"shapeGroup","do_objectID":"n","frame":{"width":10,"height":10},"layers":[]}]})).unwrap())]);
        let report = finish_sketch_report(import_sketch_files(&files).unwrap()).unwrap();
        assert!(
            report.document.nodes["n"]
                .paths()
                .unwrap()
                .0
                .commands
                .is_empty()
        );
        assert!(report.document.nodes["n"].boolean_operation.is_none());
        let bytes = export_sketch(&report.document).unwrap();
        let parts = crate::sketch::archive::read(&bytes).unwrap();
        let page: Value = serde_json::from_slice(
            parts
                .iter()
                .find(|(name, _)| name.starts_with("pages/"))
                .unwrap()
                .1,
        )
        .unwrap();
        assert_eq!(page["layers"][0]["_class"], "shapeGroup");
        assert_eq!(page["layers"][0]["layers"], json!([]));
    }
    #[test]
    fn rectangle_corners_and_proportion_lock_admit_and_round_trip() {
        let files=BTreeMap::from([
            ("meta.json".into(),br#"{"version":136}"#.to_vec()),
            ("document.json".into(),br#"{"pages":[{"_ref":"pages/00000000-0000-4000-8000-000000000001"}]}"#.to_vec()),
            ("pages/00000000-0000-4000-8000-000000000001.json".into(),serde_json::to_vec(&json!({"_class":"page","layers":[{"_class":"rectangle","do_objectID":"00000000-0000-4000-8000-000000000002","frame":{"x":0,"y":0,"width":100,"height":100,"constrainProportions":true},"fixedRadius":12,"points":[{"cornerRadius":1},{"cornerRadius":2},{"cornerRadius":3},{"cornerRadius":4}]}]})).unwrap())
        ]);
        let report = finish_sketch_report(import_sketch_files(&files).unwrap()).unwrap();
        let node = report.document.nodes.values().next().unwrap();
        assert_eq!(node.radii, [1., 2., 3., 4.]);
        assert_eq!(node.corner_radius, 0.);
        assert!(report.document.schema_version >= 7);
        let roundtrip = import_sketch_report(&export_sketch(&report.document).unwrap()).unwrap();
        assert_eq!(roundtrip.document.nodes[&node.id].radii, node.radii);
        assert!(roundtrip.document.nodes[&node.id].constrain_proportions);
    }
    #[test]
    fn import_input_policy_does_not_raise_expansion_budget() {
        assert_eq!(archive_limits().input, crate::sketch::archive::addressable_bytes(crate::capacity::memory_budget_bytes().clamp(1_073_741_824, crate::capacity::WASM_ADDRESS_BYTES)));
        assert_eq!(archive_limits().entries, 4096);
    }

    fn archive_test_limits() -> ArchiveLimits {
        ArchiveLimits {
            input: 16 * 1024,
            entries: 4,
            entry: 1024,
            document_entry: 1024,
            total: 1536,
        }
    }

    fn patch_zip_sizes(bytes: &mut [u8], size: u32) {
        // Fixtures contain no accidental signatures in their compressed data.
        for at in 0..bytes.len().saturating_sub(46) {
            let offset = if &bytes[at..at + 4] == b"PK\x01\x02" {
                Some(24)
            } else if &bytes[at..at + 4] == b"PK\x03\x04" {
                Some(22)
            } else {
                None
            };
            if let Some(offset) = offset {
                bytes[at + offset..at + offset + 4].copy_from_slice(&size.to_le_bytes());
            }
        }
    }

    #[test]
    fn bounded_archive_valid_exact_limits_and_high_compression() {
        let entries = vec![
            ("canvas.fig".into(), vec![0; 1024]),
            ("images/a".into(), vec![1; 512]),
        ];
        let bytes = write_zip(&entries).unwrap();
        let mut limits = archive_test_limits();
        limits.input = bytes.len();
        limits.entries = entries.len();
        assert_eq!(
            read_zip_bounded(&bytes, limits).unwrap(),
            entries.into_iter().collect()
        );
        // High compression is supported; the expanded-byte budget is the guard.
        let bytes = write_zip(&[("canvas.fig".into(), vec![0; 256 * 1024])]).unwrap();
        assert!(bytes.len() < 2048);
        assert_eq!(
            read_zip_public(&bytes).unwrap()["canvas.fig"].len(),
            256 * 1024
        );
    }

    #[test]
    fn selected_members_skip_siblings_that_exceed_the_entry_budget() {
        let bytes = write_zip(&[
            ("meta.json".into(), br#"{"version":1}"#.to_vec()),
            ("keep.json".into(), vec![1; 100]),
            ("huge.json".into(), vec![2; 2000]),
        ]).unwrap();
        let mut limits = archive_test_limits();
        limits.input = bytes.len();
        limits.entries = 8;
        limits.entry = 500;
        limits.document_entry = 500;
        limits.total = 4000;
        let only = BTreeSet::from(["meta.json".to_owned(), "keep.json".to_owned()]);
        let files = read_zip_bounded_filtered(&bytes, limits, Some(&only)).unwrap();
        assert!(files.contains_key("keep.json"));
        assert!(!files.contains_key("huge.json"));
        assert!(read_zip_bounded_filtered(&bytes, limits, None).unwrap_err().to_string().contains("entry expanded"));
        let wanted = BTreeSet::from(["huge.json".to_owned()]);
        assert!(read_zip_bounded_filtered(&bytes, limits, Some(&wanted)).unwrap_err().to_string().contains("entry expanded"));
    }

    #[test]
    fn over_budget_library_page_stays_unread_and_does_not_prove_a_symbol_missing() {
        let limits = ArchiveLimits { input: 64 * 1024, entries: 8, entry: 800, document_entry: 4000, total: 8000 };
        let master = json!({
            "_class": "symbolMaster", "do_objectID": "LIB-MASTER", "name": "Button", "symbolID": "LIB-SYMBOL",
            "frame": {"_class": "rect", "x": 0, "y": 0, "width": 16, "height": 16},
            "layers": [{"_class": "text", "do_objectID": "LABEL", "name": "LABEL", "attributedString": {"string": "Library", "attributes": []}, "frame": {"_class": "rect", "x": 0, "y": 0, "width": 16, "height": 16}}]
        });
        let library_document = json!({
            "_class": "document", "do_objectID": "LIB-DOC",
            "pages": [{"_class": "MSJSONFileReference", "_ref": "pages/small"}, {"_class": "MSJSONFileReference", "_ref": "pages/huge"}]
        });
        let library = write_zip(&[
            ("meta.json".into(), br#"{"version":144}"#.to_vec()),
            ("document.json".into(), serde_json::to_vec(&library_document).unwrap()),
            ("pages/small.json".into(), serde_json::to_vec(&json!({"_class":"page","do_objectID":"small","name":"Symbols","layers":[master]})).unwrap()),
            ("pages/huge.json".into(), vec![b'x'; 2000]),
        ]).unwrap();
        let (definitions, unchecked) = read_library_definitions_limited(&library, limits).unwrap();
        assert_eq!(unchecked, vec!["pages/huge.json".to_string()]);
        assert!(definitions.contains_key("pages/small.json"));
        assert!(!definitions.contains_key("pages/huge.json"));
        assert!(read_zip_bounded(&library, limits).unwrap_err().to_string().contains("entry expanded"));

        let project_document = json!({
            "_class": "document", "do_objectID": "DOC",
            "perDocumentLibraries": [{"_class": "MSImmutableDocumentLibraryInfo", "documentID": "LIB-DOC", "name": "uswds", "libraryType": 0}],
            "pages": [{"_class": "MSJSONFileReference", "_ref": "pages/page"}]
        });
        let instance = |symbol: &str| json!({
            "_class": "symbolInstance", "do_objectID": "INSTANCE", "name": "INSTANCE", "symbolID": symbol,
            "overrideValues": [{"_class": "overrideValue", "overrideName": "LABEL_stringValue", "value": "From project"}],
            "frame": {"_class": "rect", "x": 0, "y": 0, "width": 16, "height": 16}
        });
        let project_for = |symbol: &str| {
            let mut files = BTreeMap::from([
                ("meta.json".into(), br#"{"version":144}"#.to_vec()),
                ("document.json".into(), serde_json::to_vec(&project_document).unwrap()),
                ("pages/page.json".into(), serde_json::to_vec(&json!({"_class":"page","do_objectID":"page","name":"Page","layers":[instance(symbol)]})).unwrap()),
            ]);
            attach_sketch_libraries_with(&mut files, &[&library], limits).unwrap();
            files
        };
        let blocked = match finish_sketch_report(import_sketch_files(&project_for("ONLY-IN-UNREAD")).unwrap()) {
            Err(error) => error.to_string(),
            Ok(_) => panic!("a symbol that was only inside an unread page must stay blocked"),
        };
        assert!(blocked.contains("ONLY-IN-UNREAD"), "{blocked}");
        assert!(blocked.contains("未展开"), "{blocked}");
        assert!(blocked.contains("pages/huge.json"), "{blocked}");
        assert!(blocked.contains("不会提高预算"), "{blocked}");
        assert!(!blocked.contains("上游定义缺失"), "{blocked}");
        assert!(blocked.contains("不会发明主组件"), "{blocked}");

        let admitted = finish_sketch_report(import_sketch_files(&project_for("LIB-SYMBOL")).unwrap()).unwrap().document;
        assert_eq!(admitted.nodes["INSTANCE"].instance.as_ref().unwrap().overrides["LABEL"]["text"], "From project");
        admitted.validate().unwrap();
        let exported = export_sketch(&admitted).unwrap();
        let reopened = import_sketch_report(&exported).unwrap().document;
        assert_eq!(reopened.nodes["INSTANCE"].instance.as_ref().unwrap().overrides["LABEL"]["text"], "From project");
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
        assert!(
            read_zip_bounded(&bytes, limits)
                .unwrap_err()
                .to_string()
                .contains("total expanded")
        );
        assert!(
            read_zip_bounded(
                &bytes,
                ArchiveLimits {
                    entries: 1,
                    ..limits
                }
            )
            .unwrap_err()
            .to_string()
            .contains("entry count")
        );
        assert!(
            read_zip_bounded(
                &bytes,
                ArchiveLimits {
                    input: bytes.len() - 1,
                    ..limits
                }
            )
            .unwrap_err()
            .to_string()
            .contains("input bytes")
        );
        assert!(
            read_zip_bounded(
                &bytes,
                ArchiveLimits {
                    entry: 1023,
                    ..limits
                }
            )
            .unwrap_err()
            .to_string()
            .contains("entry expanded")
        );
    }

    #[test]
    fn bounded_archive_rejects_forged_sizes_and_compression_bombs() {
        let bytes = write_zip(&[("canvas.fig".into(), vec![0; 8192])]).unwrap();
        for declared in [0, 1, 1024, u32::MAX] {
            let mut forged = bytes.clone();
            patch_zip_sizes(&mut forged, declared);
            let error = read_zip_bounded(&forged, archive_test_limits())
                .unwrap_err()
                .to_string();
            // zip 9 validates declared sizes itself ("File is larger than
            // its declared uncompressed size"), so a forged header is refused
            // by the reader before our budget gate: both rejections keep the
            // expansion bounded.
            assert!(
                error.contains("entry expanded bytes")
                    || error.contains("declared uncompressed size"),
                "declared={declared}: {error}"
            );
        }
        // A lying second entry must also stop at the remaining total allowance.
        let mut bytes =
            write_zip(&[("a".into(), vec![0; 800]), ("b".into(), vec![1; 800])]).unwrap();
        for at in 0..bytes.len().saturating_sub(47) {
            let offset = if &bytes[at..at + 4] == b"PK\x01\x02" && bytes[at + 46] == b'b' {
                Some(24)
            } else if &bytes[at..at + 4] == b"PK\x03\x04" && bytes[at + 30] == b'b' {
                Some(22)
            } else {
                None
            };
            if let Some(offset) = offset {
                bytes[at + offset..at + offset + 4].copy_from_slice(&0u32.to_le_bytes());
            }
        }
        let error = read_zip_bounded(&bytes, archive_test_limits())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("total expanded") || error.contains("declared uncompressed size"),
            "{error}"
        );
    }

    #[test]
    fn bounded_archive_rejects_paths_duplicates_and_symlinks() {
        for name in ["../a", "/a", "C:a", "a\\b", "a//b", "./a"] {
            let bytes = write_zip(&[(name.into(), vec![1])]).unwrap();
            assert!(
                read_zip(&bytes)
                    .unwrap_err()
                    .to_string()
                    .contains("archive path"),
                "{name}"
            );
        }
        let mut duplicate = write_zip(&[("a".into(), vec![1]), ("b".into(), vec![2])]).unwrap();
        // ZipWriter itself refuses duplicate names: forge an actual ZIP instead.
        for at in 0..duplicate.len().saturating_sub(46) {
            if &duplicate[at..at + 4] == b"PK\x01\x02" {
                duplicate[at + 46] = b'a';
            }
            if &duplicate[at..at + 4] == b"PK\x03\x04" {
                duplicate[at + 30] = b'a';
            }
        }
        assert!(
            read_zip(&duplicate)
                .unwrap_err()
                .to_string()
                .contains("duplicate")
        );
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .add_symlink(
                "link",
                "document.json",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert!(
            read_zip(&bytes)
                .unwrap_err()
                .to_string()
                .contains("symlink")
        );
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .add_directory("a/", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer
            .start_file("a", zip::write::SimpleFileOptions::default())
            .unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert!(
            read_zip(&bytes)
                .unwrap_err()
                .to_string()
                .contains("duplicate")
        );
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
    fn hotspot_layers_are_paintless_regions_and_unresolved_flows_remain_raw() {
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
        assert_eq!(node.kind, "rectangle");
        assert!(node.fills.is_empty() && node.strokes.is_empty());
        assert!(node.bindings.contains_key("sketchSourceHotspot"));
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
    fn sketch_artboard_and_modern_frame_clipping_are_separate_from_masks() {
        let layers = json!([
            {"_class":"artboard","do_objectID":"legacy","frame":{"width":128,"height":128}},
            {"_class":"artboard","do_objectID":"legacy-open","frame":{"width":128,"height":128},"clippingBehavior":2},
            {"_class":"group","do_objectID":"frame","groupBehavior":1,"clippingBehavior":0,"frame":{"width":128,"height":128},"layers":[
                {"_class":"group","do_objectID":"nested","groupBehavior":1,"clippingBehavior":2,"frame":{"width":32,"height":32}},
                {"_class":"rectangle","do_objectID":"mask","hasClippingMask":true,"clippingMaskMode":0,"frame":{"width":32,"height":32}}
            ]},
            {"_class":"group","do_objectID":"plain","groupBehavior":0,"frame":{"width":128,"height":128}},
            {"_class":"symbolMaster","do_objectID":"master","clippingBehavior":0,"frame":{"width":128,"height":128}}
        ]);
        let files = BTreeMap::from([
            ("meta.json".into(), br#"{"version":168}"#.to_vec()),
            ("document.json".into(), br#"{"pages":[{"_ref":"pages/p"}]}"#.to_vec()),
            ("pages/p.json".into(), serde_json::to_vec(&json!({"_class":"page","layers":layers})).unwrap()),
        ]);
        let doc = finish_sketch_report(import_sketch_files(&files).unwrap()).unwrap().document;
        assert!(doc.nodes["legacy"].clip);
        assert!(!doc.nodes["legacy-open"].clip);
        assert_eq!(doc.nodes["frame"].kind, "frame");
        assert!(doc.nodes["frame"].clip);
        assert_eq!(doc.nodes["nested"].kind, "frame");
        assert!(!doc.nodes["nested"].clip);
        assert!(!doc.nodes["plain"].clip);
        assert!(!doc.nodes["master"].clip);
        assert!(doc.nodes["mask"].mask);
        let reopened = import_sketch(&export_sketch(&doc).unwrap()).unwrap();
        assert!(reopened.nodes["legacy"].clip);
        assert!(!reopened.nodes["legacy-open"].clip);
    }

    #[test]
    fn modern_sketch_stack_flows_in_reverse_without_reordering_paint() {
        for vertical in [false, true] {
            let frame = json!({"_class":"group","groupBehavior":1,"do_objectID":"stack",
                "frame":{"width":240,"height":240},"topPadding":16,"rightPadding":16,"bottomPadding":16,"leftPadding":16,
                "groupLayout":{"_class":"MSImmutableFlexGroupLayout","flexDirection":u8::from(vertical),"allGuttersGap":10},
                "layers":[
                    {"_class":"rectangle","do_objectID":"fixed","frame":{"width":40,"height":40}},
                    {"_class":"rectangle","do_objectID":"fill","frame":{"width":40,"height":40},
                     "horizontalSizing":if vertical {0} else {2},"verticalSizing":if vertical {2} else {0}}
                ]});
            let files = BTreeMap::from([
                ("meta.json".into(), br#"{"version":168}"#.to_vec()),
                ("document.json".into(), br#"{"pages":[{"_ref":"pages/p"}]}"#.to_vec()),
                ("pages/p.json".into(), serde_json::to_vec(&json!({"_class":"page","layers":[frame]})).unwrap()),
            ]);
            let mut doc = finish_sketch_report(import_sketch_files(&files).unwrap()).unwrap().document;
            assert_eq!(doc.schema_version, 22);
            assert!(doc.nodes["stack"].layout.as_ref().unwrap().reverse_flow);
            let axis = 4 + usize::from(vertical);
            for gap in [10., 24.] {
                doc.nodes.get_mut("stack").unwrap().layout.as_mut().unwrap().gap = gap;
                crate::layout::resolve(&mut doc, &crate::font::Fonts::new()).unwrap();
                assert_eq!(doc.nodes["stack"].children, ["fixed", "fill"]);
                assert_eq!(doc.nodes["fill"].transform.0[axis], 16.);
                assert_eq!(doc.nodes["fixed"].transform.0[axis], 184.);
                let size = if vertical { doc.nodes["fill"].height } else { doc.nodes["fill"].width };
                assert_eq!(size, 168. - gap);
            }
        }
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
            show_shadow_behind_node: false,
            color_controls: None,
            zoom_blur: None, motion_angle: 0.,
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
        paint.image = Some(image_data_uri(&png).into());
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
            Err(Error::Unsupported(_) | Error::UnsupportedFigPlatform)
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
    fn sketch_curve_units_keep_f64_bits_and_match_the_triangle_example() {
        for value in [
            0.0,
            -0.0,
            1.0,
            0.5,
            1e-7,
            1e20,
            f64::from_bits(0x3ff0_0000_0000_0001),
        ] {
            let text = sketch_unit(value).unwrap();
            assert!(sketch_unit_schema(&text), "{text}");
            assert!(text.parse::<f64>().unwrap().to_bits() == value.to_bits(), "{text}");
        }
        assert_eq!(sketch_curve_coordinate(0., 24., 24., 24.).unwrap(), "{0, 1}");
        assert_eq!(sketch_curve_coordinate(12., 0., 24., 24.).unwrap(), "{0.5, 0}");
        assert_eq!(sketch_curve_coordinate(24., 24., 24., 24.).unwrap(), "{1, 1}");
        assert!(frame_unit(5., 0.).is_err());
        assert_eq!(frame_unit(-0.0, 0.).unwrap().to_bits(), (-0.0f64).to_bits());
    }

    #[test]
    fn curve_handles_round_trip_through_curve_points() {
        // 21 号 P0-1: network c1/c2 handles survive as curveFrom/curveTo.
        let mut doc = sample_document();
        let mut path = crate::facet::sample_node("n3", "path");
        path.name = "Blob".into();
        path.network = Some((crate::scene::Network {
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
        }).into());
        doc.pages[0].children.push("n3".into());
        doc.nodes.insert("n3".into(), path);

        // Admission scales the frame-normalized archive back to local pixels.
        let back = import_sketch_report(&export_sketch(&doc).unwrap())
            .unwrap()
            .document;
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
        // A single sequential edge is an open contour, not a broken ring.
        // A branch cannot be one shapePath, so the exporter reports that.
        let mut doc = sample_document();
        let mut path = crate::facet::sample_node("n3", "path");
        path.network = Some((crate::scene::Network {
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
                crate::scene::Vertex {
                    id: "v2".into(),
                    x: 0.,
                    y: 1.,
                },
            ],
            edges: vec![
                crate::scene::Edge {
                    id: "e0".into(),
                    from: "v0".into(),
                    to: "v1".into(),
                    c1: Some(crate::math::Point::new(0.5, 0.5)),
                    c2: None,
                },
                crate::scene::Edge {
                    id: "e1".into(),
                    from: "v0".into(),
                    to: "v2".into(),
                    c1: None,
                    c2: None,
                },
            ],
            fill_rule: "nonzero".into(),
        }).into());
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
        // Explicit handle flags own imported geometry independently of the
        // editing mode; re-export must preserve those controls and radii.
        let mut doc = sample_document();
        let mut path = crate::facet::sample_node("n3", "path");
        path.name = "Modes".into();
        path.network = Some((crate::scene::Network {
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
        }).into());
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
            // Straight editing type with explicitly active stored handles.
            {"_class":"curvePoint","point":"{0, 0}","curveFrom":"{0.3, 0.3}",
             "curveTo":"{-0.3, -0.3}","hasCurveFrom":true,"hasCurveTo":true,
             "curveMode":1,"cornerRadius":2.0},
            // Mirrored editing type cannot activate an explicitly false side.
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
        // The active controls are retained even on a Straight editing point.
        let c1 = net.edges[0].c1.expect("active outgoing handle of v0");
        assert!((c1.x - 0.3).abs() < 1e-9 && (c1.y - 0.3).abs() < 1e-9);
        let c2 = net.edges[3].c2.expect("active incoming handle of v0");
        assert!((c2.x + 0.3).abs() < 1e-9 && (c2.y + 0.3).abs() < 1e-9);
        // Only the explicitly active incoming handle is used at v1.
        let c2 = net.edges[0].c2.expect("incoming handle of v1");
        assert!((c2.x - 0.8).abs() < 1e-9 && (c2.y - 0.2).abs() < 1e-9);
        assert!(net.edges[1].c1.is_none());
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
            node.bindings
                .get("sketchPointCornerRadii")
                .map(String::as_str),
            Some("[2.0,0.0,0.0,0.0]")
        );
        assert!(
            node.bindings
                .get("sketchImportLossy")
                .is_some_and(|s| s.contains("corner-radius")),
            "per-point corner radius degradation must be reported"
        );

        // Editing modes may re-derive from the retained geometry; they cannot
        // erase active controls or invent inactive ones during the round trip.
        // Re-export the admitted pixel network. The low-level import above
        // still holds the file's unit numbers and is not a second scaling.
        let admitted = import_sketch_report(&encoded).unwrap().document;
        let re = export_sketch(&admitted).unwrap();
        let re_files = read_zip(&re).unwrap();
        let re_page: Value = serde_json::from_slice(&re_files[&name]).unwrap();
        let points = re_page["layers"][2]["points"].as_array().unwrap();
        let modes: Vec<i64> = points
            .iter()
            .map(|p| p["curveMode"].as_i64().unwrap())
            .collect();
        assert_eq!(modes, vec![2, 3, 3, 4]);
        assert_eq!(points[0]["cornerRadius"], 2.0);
        assert_eq!(points[0]["hasCurveFrom"], true);
        assert_eq!(points[0]["hasCurveTo"], true);
        assert_eq!(points[1]["hasCurveFrom"], false);
        assert_eq!(points[1]["hasCurveTo"], true);
        let reopened = import_sketch_report(&re).unwrap().document;
        assert_eq!(reopened.nodes["n3"].network, admitted.nodes["n3"].network);
        assert_eq!(
            reopened.nodes["n3"].bindings.get("sketchPointCornerRadii"),
            admitted.nodes["n3"].bindings.get("sketchPointCornerRadii")
        );
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
        text.text_style = Some((crate::font::TextStyle {
            align: "center".into(),
            line_height: 1.5,
            letter_spacing: 0.8,
            paragraph_spacing: 3.,
            wrap: true,
            ..Default::default()
        }).into());
        text.text_runs = vec![
            crate::font::TextRun {
                paragraph: None,
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
                letter_spacing: None,
                line_height: None,
            },
            crate::font::TextRun {
                paragraph: None,
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
                letter_spacing: None,
                line_height: None,
            },
        ].into();
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
            attrs[0]["attributes"]["paragraphStyle"]["alignment"],
            2
        );
        let px = attrs[0]["attributes"]["paragraphStyle"]["minimumLineHeight"]
            .as_f64()
            .unwrap();
        assert!((px - 1.5 * 14.).abs() < 1e-9);
        assert_eq!(
            attrs[0]["attributes"]["paragraphStyle"]["paragraphSpacing"],
            3.
        );
        assert_eq!(attrs[0]["attributes"]["kerning"], 0.8);

        let back = import_sketch(&bytes).unwrap();
        let text = back.nodes.get("n2").unwrap();
        assert_eq!(text.text, "plainBIGsmall");
        let runs = &text.text_runs;
        // The exact text-model receipt preserves the authored sparse ranges.
        assert_eq!(runs.len(), 2);
        assert_eq!((runs[0].start, runs[0].end), (5, 8));
        assert_eq!(runs[0].color.as_deref(), Some("#ff0000"));
        assert_eq!(runs[0].font_size, Some(24.));
        assert_eq!(runs[0].font_id.as_deref(), Some("Inter-SemiBold"));
        assert!(runs[0].underline);
        assert_eq!(runs[1].color.as_deref(), Some("#00ff00"));
        assert!(runs[1].strikethrough);
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
        page["layers"][1]["style"]["textStyle"]["verticalAlignment"] = json!(1);
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
        assert_eq!(style.vertical_align, "center");
        assert_eq!(
            node.bindings.get("sketchTextTransform").map(String::as_str),
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
            assert_eq!(
                run["attributes"]["MSAttributedStringTextTransformAttribute"],
                1
            );
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
                refraction: 0.75,
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
        assert!(node.effects.iter().any(|e| e.kind=="glass" && e.glass.as_ref().is_some_and(|g|g.refraction==0.75 && g.depth==2.)));
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
            show_shadow_behind_node: false,
            color_controls: None,
            zoom_blur: None, motion_angle: 0.,
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
        master.component = Some((crate::components::Component {
            slots: Default::default(),
            variants: [("Size".into(), "M".into())].into_iter().collect(),
            properties: BTreeMap::new(),
        }).into());
        let mut instance = crate::facet::sample_node("n4", "frame");
        instance.name = "Button instance".into();
        instance.instance = Some((crate::components::Instance {
            slot_contents: Default::default(),
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
        }).into());
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
            reverse_flow: false,
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
        frame.layout_grid = Some((crate::scene::LayoutGrid {
            axis: "column".into(),
            count: 8,
            gutter: 16.,
            margin: 24.,
            color: "#00a0ff".into(),
            visible: true,
            opacity: 0.3,
        }).into());
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
        frame.layout_grid = Some((crate::scene::LayoutGrid {
            axis: "uniform".into(),
            count: 8,
            gutter: 0.,
            margin: 0.,
            color: "#ff0000".into(),
            visible: false,
            opacity: 0.1,
        }).into());
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
        assert_eq!(events[0].actions[0].transition_preserve_scroll, Some(true));
    }

    /// Shared fixture builder for the 2026-10-26 gap-closure tests: a
    /// one-page .sketch zip with a document.json the test can extend.
    fn gap_test_files(page_layers: Value, document_extra: Value) -> Vec<u8> {
        let mut document = json!({"pages": [{"_ref": "pages/p"}]});
        if let (Some(target), Some(extra)) = (document.as_object_mut(), document_extra.as_object())
        {
            for (key, value) in extra {
                target.insert(key.clone(), value.clone());
            }
        }
        let files = BTreeMap::from([
            (
                "meta.json".to_owned(),
                br#"{"version":136}"#.to_vec(),
            ),
            ("document.json".to_owned(), serde_json::to_vec(&document).unwrap()),
            (
                "pages/p.json".to_owned(),
                serde_json::to_vec(&json!({
                    "_class": "page", "do_objectID": "page-p", "name": "P",
                    "layers": page_layers
                }))
                .unwrap(),
            ),
        ]);
        write_zip(&files.into_iter().collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn positive_scale_tiff_is_executable_while_eps_and_zero_scale_stay_preserved() {
        let encoded = gap_test_files(
            json!([{
                "_class": "rectangle",
                "do_objectID": "n1",
                "name": "R",
                "frame": {"_class": "rect", "x": 0, "y": 0, "width": 120, "height": 90},
                "exportOptions": {"_class": "exportOptions", "exportFormats": [
                    {"_class": "exportFormat", "fileFormat": "tiff", "scale": 2, "name": "@2x", "namingScheme": 1},
                    {"_class": "exportFormat", "fileFormat": "heic", "scale": 1, "name": ""},
                    {"_class": "exportFormat", "fileFormat": "eps", "scale": 1, "name": ""},
                    {"_class": "exportFormat", "fileFormat": "tiff", "scale": 0, "name": "", "absoluteSize": 100, "visibleScaleType": 1},
                    {"_class": "exportFormat", "fileFormat": "png", "scale": 1, "name": ""}
                ]}
            }]),
            json!({}),
        );
        let back = import_sketch(&encoded).unwrap();
        let node = &back.nodes["n1"];
        let formats: Vec<_> = node
            .export_settings
            .iter()
            .map(|setting| (setting.format.as_str(), setting.scale, setting.suffix.as_str()))
            .collect();
        assert_eq!(
            formats,
            vec![("tiff", 2., "@2x"), ("heic", 1., ""), ("eps", 1., ""), ("tiff", 0., ""), ("png", 1., "")]
        );
        let lossy = import_lossy_of(node);
        let preserved = lossy
            .iter()
            .filter(|note| note.as_str() == "export-setting-preserved-without-local-render-support")
            .count();
        assert_eq!(preserved, 2, "eps and zero-scale tiff only, got {lossy:?}");
        let again = import_sketch(&export_sketch(&back).unwrap()).unwrap();
        let round_trip: Vec<_> = again.nodes["n1"]
            .export_settings
            .iter()
            .map(|setting| (setting.format.as_str(), setting.scale))
            .collect();
        assert_eq!(round_trip, vec![("tiff", 2.), ("heic", 1.), ("eps", 1.), ("tiff", 0.), ("png", 1.)]);
        let fields = again.nodes["n1"]
            .bindings
            .get("sketchExportFormatFields")
            .cloned()
            .unwrap_or_default();
        assert!(fields.contains("namingScheme"), "{fields}");
        assert!(fields.contains("absoluteSize"), "{fields}");
    }

    /// Import-side degradation ledger for the gap-closure tests (the
    /// pre-existing `lossy_of` reads the export ledger).
    fn import_lossy_of(node: &crate::scene::Node) -> Vec<String> {
        node.bindings
            .get("sketchImportLossy")
            .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
            .unwrap_or_default()
    }

    fn first_exported_page(re_files: &BTreeMap<String, Vec<u8>>) -> Value {
        let name = re_files
            .keys()
            .find(|n| n.starts_with("pages/"))
            .map(|n| &re_files[n])
            .expect("exported page entry");
        serde_json::from_slice(name).unwrap()
    }

    #[test]
    fn pattern_fills_map_fit_and_tile_and_round_trip() {
        let png = [
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
        ];
        let files = BTreeMap::from([
            (
                "meta.json".to_owned(),
                br#"{"version":136}"#.to_vec(),
            ),
            (
                "document.json".to_owned(),
                br#"{"pages":[{"_ref":"pages/p"}]}"#.to_vec(),
            ),
            ("images/abc".to_owned(), png.to_vec()),
            (
                "pages/p.json".to_owned(),
                serde_json::to_vec(&json!({
                    "_class": "page", "name": "P",
                    "layers": [
                        {"_class": "shapePath", "do_objectID": "n1", "frame": {"x":0,"y":0,"width":40,"height":20},
                         "points": [{"point":"{0,0}"},{"point":"{1,0}"},{"point":"{1,1}"},{"point":"{0,1}"}],
                         "isClosed": true,
                         "style": {"fills": [
                            {"isEnabled": true, "fillType": 0, "image": {"_ref": "abc"},
                             "patternFillType": 1, "patternTileScale": 1.},
                            {"isEnabled": true, "fillType": 0, "image": {"_ref": "abc"},
                             "patternFillType": 2, "patternTileScale": 1.},
                            {"isEnabled": true, "fillType": 0, "image": {"_ref": "abc"},
                             "patternFillType": 3, "patternTileScale": 1.},
                            {"isEnabled": true, "fillType": 0, "image": {"_ref": "abc"},
                             "patternFillType": 0, "patternTileScale": 2.5}
                         ]}}
                    ]
                }))
                .unwrap(),
            ),
        ]);
        let encoded = write_zip(&files.into_iter().collect::<Vec<_>>()).unwrap();
        let back = import_sketch(&encoded).unwrap();
        let node = &back.nodes["n1"];
        assert_eq!(node.fills.len(), 4);
        assert_eq!(node.fills[0].fit, "cover");
        assert_eq!(node.fills[1].fit, "stretch");
        assert_eq!(node.fills[2].fit, "contain");
        let tile = node.fills[3].tile.as_ref().expect("tile mode mapped");
        assert_eq!(tile.mode, crate::pattern_fill::GRID);
        // This intentionally malformed PNG has no usable extent. Its scale
        // still survives with a diagnostic instead of guessing dimensions.
        let scale = node
            .bindings
            .get("sketchSourcePatternScale")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .expect("tile scale retained");
        assert_eq!(scale["fills-3"], json!(2.5));
        assert!(import_lossy_of(node)
            .iter()
            .any(|n| n.contains("pattern-tile-scale")));
        // Pattern tiling gated the document onto schema 14.
        assert!(back.schema_version >= 14);

        let re = export_sketch(&back).unwrap();
        let re_files = read_zip(&re).unwrap();
        let page = first_exported_page(&re_files);
        let fills = &page["layers"][0]["style"]["fills"];
        assert_eq!(fills[0]["patternFillType"], json!(1));
        assert_eq!(fills[1]["patternFillType"], json!(2));
        assert_eq!(fills[2]["patternFillType"], json!(3));
        assert_eq!(fills[3]["patternFillType"], json!(0));
        assert_eq!(fills[3]["patternTileScale"], json!(2.5));
    }

    #[test]
    fn sketch_pattern_scale_changes_pixels_and_edited_period_round_trips() {
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, 4, 2);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let row = [255,0,0,255, 255,0,0,255, 0,0,255,255, 0,0,255,255];
            encoder.write_header().unwrap().write_image_data(&row.repeat(2)).unwrap();
        }
        let encoded = gap_test_files(json!([{
            "_class":"rectangle", "do_objectID":"pattern", "frame":{"x":0,"y":0,"width":48,"height":24},
            "style":{"fills":[{"isEnabled":true,"fillType":4,"image":{"_ref":"checker"},
                "patternFillType":0,"patternTileScale":2.5}]}
        }]), json!({"colorSpace":1}));
        let mut files = read_zip(&encoded).unwrap();
        files.insert("images/checker".into(), png);
        let mut doc = import_sketch_report(&write_zip(&files.into_iter().collect::<Vec<_>>()).unwrap()).unwrap().document;
        assert_eq!(doc.nodes["pattern"].fills[0].tile.as_ref().unwrap().size, [10.,5.]);
        assert!(!doc.nodes["pattern"].bindings.contains_key("sketchSourcePatternScale"));
        assert!(!import_lossy_of(&doc.nodes["pattern"]).iter().any(|n|n.contains("pattern-tile-scale")));
        let render = |doc: &Document| {
            let mut engine = crate::Engine::new();
            engine.load_document(&serde_json::to_string(doc).unwrap()).unwrap();
            let options = engine.parse_options(json!({"pageId":doc.pages[0].id,"width":48,"height":24,
                "view":{"x":0,"y":0,"zoom":1}})).unwrap();
            engine.render(&options).unwrap()
        };
        let before = render(&doc);
        let mut native = doc.clone();
        native.nodes.get_mut("pattern").unwrap().fills[0].tile.as_mut().unwrap().size = [0.,0.];
        assert_ne!(before, render(&native), "source scale must affect rendered pixels");
        let exported = export_sketch(&doc).unwrap();
        let page = first_exported_page(&read_zip(&exported).unwrap());
        assert_eq!(page["layers"][0]["style"]["fills"][0]["patternTileScale"],2.5);
        assert_eq!(before, render(&import_sketch_report(&exported).unwrap().document));

        // The Inspector edits this existing size slot. Export must use the
        // edited value instead of replaying the original source scale.
        doc.nodes.get_mut("pattern").unwrap().fills[0].tile.as_mut().unwrap().size = [16.,8.];
        let edited = render(&doc);
        assert_ne!(before, edited);
        let exported = export_sketch(&doc).unwrap();
        let page = first_exported_page(&read_zip(&exported).unwrap());
        assert_eq!(page["layers"][0]["style"]["fills"][0]["patternTileScale"],4.);
        assert_eq!(edited, render(&import_sketch_report(&exported).unwrap().document));
    }

    #[test]
    fn old_fd_noise_receipts_do_not_duplicate_or_resurrect_supported_paints() {
        let raw=json!({"_class":"fill","isEnabled":true,"fillType":0,"noiseIndex":3,"noiseIntensity":0.5,
            "color":{"red":0.2,"green":0.4,"blue":0.7,"alpha":0.5}});
        for deleted in [false,true] {
            let mut doc=sample_document();let node=doc.nodes.get_mut("n1").unwrap();
            node.bindings.insert("sketchSourceNoiseFills".into(),json!({"fills-0":raw}).to_string());
            if deleted {node.fills.clear();}else{node.fills[0].color="#ef3344".into();}
            let files=read_zip(&export_sketch(&doc).unwrap()).unwrap();let page=first_exported_page(&files);
            let fills=page["layers"][0]["style"]["fills"].as_array().unwrap();assert_eq!(fills.len(),usize::from(!deleted));
            if !deleted {assert_eq!(fills[0]["noiseIndex"],3);assert_eq!(fills[0]["noiseIntensity"],0.5);}
        }
    }

    #[test]
    fn inactive_noise_metadata_does_not_duplicate_an_admitted_fill() {
        let source=gap_test_files(json!([{"_class":"shapePath","do_objectID":"n1","frame":{"x":0,"y":0,"width":10,"height":10},"isClosed":true,
            "points":[{"point":"{0,0}"},{"point":"{1,0}"},{"point":"{1,1}"},{"point":"{0,1}"}],
            "style":{"fills":[{"_class":"fill","isEnabled":true,"fillType":0,"noiseIndex":3,"noiseIntensity":0.5,
                "color":{"red":0.2,"green":0.4,"blue":0.7,"alpha":0.5}}]}}]),json!({}));
        let doc=import_sketch(&source).unwrap();let node=&doc.nodes["n1"];
        assert_eq!(node.fills.len(),1);assert!(!node.bindings.contains_key("sketchSourceNoiseFills"));
        let files=read_zip(&export_sketch(&doc).unwrap()).unwrap();let page=first_exported_page(&files);let fills=page["layers"][0]["style"]["fills"].as_array().unwrap();
        assert_eq!(fills.len(),1);assert_eq!(fills[0]["fillType"],0);assert_eq!(fills[0]["noiseIndex"],3);assert_eq!(fills[0]["noiseIntensity"],0.5);
    }

    #[test]
    fn noise_fills_and_color_controls_round_trip_instead_of_dropping() {
        let encoded = gap_test_files(
            json!([{"_class": "shapePath", "do_objectID": "n1",
                    "frame": {"x":0,"y":0,"width":10,"height":10},
                    "points": [{"point":"{0,0}"},{"point":"{1,0}"},{"point":"{1,1}"},{"point":"{0,1}"}],
                    "isClosed": true,
                    "style": {
                        "fills": [
                            {"isEnabled": true, "fillType": 0, "color": {"red":1,"green":0,"blue":0,"alpha":1}},
                            {"isEnabled": true, "fillType": 4, "noiseIndex": 3, "noiseIntensity": 0.5}
                        ],
                        "colorControls": {"_class": "colorControls", "isEnabled": true,
                                          "brightness": 0.2, "contrast": 1.4, "hue": 0.1, "saturation": 0.8}
                    }}]),
            json!({}),
        );
        let back = import_sketch(&encoded).unwrap();
        let node = &back.nodes["n1"];
        // The noise remains preserved; color controls now have executable
        // effect parameters as well as the original archive payload.
        assert_eq!(node.fills.len(), 1);
        let noise = node
            .bindings
            .get("sketchSourceNoiseFills")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .expect("noise fill retained");
        assert_eq!(noise["fills-1"]["noiseIndex"], json!(3));
        let controls = node
            .bindings
            .get("sketchSourceColorControls")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .expect("color controls retained");
        assert_eq!(controls["brightness"], json!(0.2));
        let lossy = import_lossy_of(node);
        assert!(lossy.iter().any(|n| n.contains("noise-fill-not-modeled")));
        assert!(lossy.iter().any(|n| n.contains("color-controls-not-modeled")));

        let re = export_sketch(&back).unwrap();
        let re_files = read_zip(&re).unwrap();
        let page = first_exported_page(&re_files);
        let style = &page["layers"][0]["style"];
        let fills = style["fills"].as_array().unwrap();
        assert_eq!(fills.len(), 2, "noise part returns in place");
        assert_eq!(fills[1]["noiseIndex"], json!(3));
        assert_eq!(style["colorControls"]["brightness"], json!(0.2));
        assert_eq!(style["colorControls"]["isEnabled"], json!(true));
    }

    #[test]
    fn border_markers_map_both_directions_with_honest_approximations() {
        let encoded = gap_test_files(
            json!([{"_class": "shapePath", "do_objectID": "n1",
                    "frame": {"x":0,"y":0,"width":30,"height":10},
                    "points": [{"point":"{0,0}"},{"point":"{1,1}"}],
                    "isClosed": false,
                    "style": {
                        "borders": [{"isEnabled": true, "fillType": 0, "thickness": 2,
                                     "color": {"red":0,"green":0,"blue":0,"alpha":1}}],
                        "borderOptions": {"lineCapStyle": 0, "lineJoinStyle": 0,
                                          "startMarkerType": 7, "endMarkerType": 1}
                    }}]),
            json!({}),
        );
        let back = import_sketch(&encoded).unwrap();
        let node = &back.nodes["n1"];
        let stroke = &node.strokes[0];
        assert_eq!(stroke.start_marker, crate::stroke::Marker::Arrow);
        assert_eq!(stroke.end_marker, crate::stroke::Marker::Triangle);
        // Open markers approximate to their filled kernel shapes and say so.
        assert!(import_lossy_of(node).is_empty(), "exact codes need no note");

        let re = export_sketch(&back).unwrap();
        let re_files = read_zip(&re).unwrap();
        let page = first_exported_page(&re_files);
        let options = &page["layers"][0]["style"]["borderOptions"];
        assert_eq!(options["startMarkerType"], json!(7));
        assert_eq!(options["endMarkerType"], json!(1));

        // Open variants map to the nearest filled shape with a note.
        let encoded = gap_test_files(
            json!([{"_class": "shapePath", "do_objectID": "n1",
                    "frame": {"x":0,"y":0,"width":30,"height":10},
                    "points": [{"point":"{0,0}"},{"point":"{1,1}"}],
                    "isClosed": false,
                    "style": {
                        "borders": [{"isEnabled": true, "fillType": 0, "thickness": 2,
                                     "color": {"red":0,"green":0,"blue":0,"alpha":1}}],
                        "borderOptions": {"startMarkerType": 3, "endMarkerType": 0}
                    }}]),
            json!({}),
        );
        let back = import_sketch(&encoded).unwrap();
        let node = &back.nodes["n1"];
        assert_eq!(node.strokes[0].start_marker, crate::stroke::Marker::Circle);
        assert!(import_lossy_of(node)
            .iter()
            .any(|n| n.contains("marker-open-circle")));
    }

    #[test]
    fn per_run_text_transform_maps_to_authored_text_case() {
        let encoded = gap_test_files(
            json!([{"_class": "text", "do_objectID": "n1",
                    "frame": {"x":0,"y":0,"width":120,"height":20},
                    "textBehaviour": 0,
                    "attributedString": {"string": "Big small",
                        "attributes": [
                            {"location": 0, "length": 3,
                             "attributes": {"MSAttributedStringFontAttribute": {"_class": "fontDescriptor", "attributes": {"name": "A", "size": 12}},
                                            "MSAttributedStringTextTransformAttribute": 1}},
                            {"location": 3, "length": 6,
                             "attributes": {"MSAttributedStringFontAttribute": {"_class": "fontDescriptor", "attributes": {"name": "A", "size": 12}},
                                            "MSAttributedStringTextTransformAttribute": 2}}
                        ]}}]),
            json!({}),
        );
        let back = import_sketch(&encoded).unwrap();
        let node = &back.nodes["n1"];
        assert_eq!(
            node.text_runs[0].text_case,
            Some(crate::font::TextCase::Upper)
        );
        assert_eq!(
            node.text_runs[1].text_case,
            Some(crate::font::TextCase::Lower)
        );
        assert!(!import_lossy_of(node).iter().any(|n| n.contains("transform")));

        let re = export_sketch(&back).unwrap();
        let re_files = read_zip(&re).unwrap();
        let page = first_exported_page(&re_files);
        let attrs = &page["layers"][0]["attributedString"]["attributes"];
        assert_eq!(attrs[0]["attributes"]["MSAttributedStringTextTransformAttribute"], json!(1));
        assert_eq!(attrs[1]["attributes"]["MSAttributedStringTextTransformAttribute"], json!(2));
    }

    #[test]
    fn modern_layout_fields_and_inferred_groups_round_trip() {
        let encoded = gap_test_files(
            json!([
                {"_class": "group", "do_objectID": "g1",
                 "frame": {"x":0,"y":0,"width":100,"height":100},
                 "groupLayout": {"_class": "MSImmutableInferredGroupLayout", "axis": 1, "layoutAnchor": 0},
                 "layers": [
                    {"_class": "shapePath", "do_objectID": "n1",
                     "frame": {"x":0,"y":0,"width":30,"height":10},
                     "__horizontalPins": 5, "__horizontalSizing": 1,
                     "_flexItem": {"_class": "MSImmutableFlexItem", "flexGrow": 1.5},
                     "points": [{"point":"{0,0}"},{"point":"{1,0}"},{"point":"{1,1}"},{"point":"{0,1}"}],
                     "isClosed": true}
                 ]}
            ]),
            json!({}),
        );
        let back = import_sketch(&encoded).unwrap();
        let group = &back.nodes["g1"];
        let inferred = group
            .bindings
            .get("sketchInferredGroupLayout")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .expect("inferred payload retained");
        assert_eq!(inferred["_class"], json!("MSImmutableInferredGroupLayout"));
        assert_eq!(inferred["axis"], json!(1));
        assert!(group.layout.is_none(), "static frames, no stack");
        assert!(import_lossy_of(group)
            .iter()
            .any(|n| n.contains("inferred-group-layout")));
        let child = &back.nodes["n1"];
        let modern = child
            .bindings
            .get("sketchModernLayout")
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .expect("modern fields retained");
        // Original ivar spellings survive for exact round-trip.
        assert_eq!(modern["__horizontalPins"], json!(5));
        assert_eq!(modern["__horizontalSizing"], json!(1));
        assert_eq!(modern["_flexItem"]["flexGrow"], json!(1.5));
        assert!(import_lossy_of(child)
            .iter()
            .any(|n| n.contains("modern-layout-untranslated")));

        let re = export_sketch(&back).unwrap();
        let re_files = read_zip(&re).unwrap();
        let page = first_exported_page(&re_files);
        let group = &page["layers"][0];
        assert_eq!(group["groupLayout"]["_class"], json!("MSImmutableInferredGroupLayout"));
        assert_eq!(group["groupLayout"]["axis"], json!(1));
        let child = &group["layers"][0];
        assert_eq!(child["__horizontalPins"], json!(5));
        assert_eq!(child["__horizontalSizing"], json!(1));
        assert_eq!(child["_flexItem"]["flexGrow"], json!(1.5));
    }

    /// Local real-corpus gate (skipped by default): point
    /// CORPUS_SKETCH at a native .sketch file (e.g. the 111/117 reference
    /// archives) to verify the 2026-10-26 gap-closure slots import, export
    /// and re-import with stable counts.
    #[test]
    #[ignore = "set CORPUS_SKETCH=/path/to/file.sketch to run"]
    fn real_corpus_gap_slots_round_trip_stably() {
        let path = std::env::var("CORPUS_SKETCH").expect("CORPUS_SKETCH");
        let bytes = std::fs::read(&path).expect("corpus file readable");
        let profile = |doc: &Document| serde_json::json!({
            "pages": doc.pages.len(),
            "guidePages": doc.pages.iter().filter(|p| !p.guides.is_empty()).count(),
            "guides": doc.pages.iter().map(|p| p.guides.len()).sum::<usize>(),
            "tileFills": doc.nodes.values().filter(|n| n.fills.iter().any(|f| f.tile.is_some())).count(),
            "markers": doc.nodes.values().filter(|n| n.strokes.iter().any(|s| !s.start_marker.is_none() || !s.end_marker.is_none())).count(),
            "caseRuns": doc.nodes.values().map(|n| n.text_runs.iter().filter(|r| r.text_case.is_some()).count()).sum::<usize>(),
            "modernLayout": doc.nodes.values().filter(|n| n.bindings.contains_key("sketchModernLayout")).count(),
            "inferred": doc.nodes.values().filter(|n| n.bindings.contains_key("sketchInferredGroupLayout")).count(),
            "noiseFills": doc.nodes.values().filter(|n| n.bindings.contains_key("sketchSourceNoiseFills")).count(),
            "colorControls": doc.nodes.values().filter(|n| n.bindings.contains_key("sketchSourceColorControls")).count(),
            "patternScale": doc.nodes.values().filter(|n| n.bindings.contains_key("sketchSourcePatternScale")).count(),
            "assets": doc.design_system.as_ref().is_some_and(|d| d.sketch_containers.contains_key("assets")),
            "rulerData": doc.design_system.as_ref().is_some_and(|d| d.sketch_containers.contains_key("rulerData")),
            "schema": doc.schema_version,
        });
        let first = import_sketch(&bytes).expect("corpus import");
        let profile_first = profile(&first);
        let exported = export_sketch(&first).expect("corpus export");
        if let Ok(path) = std::env::var("CORPUS_DUMP") {
            std::fs::write(&path, &exported).expect("dump export");
        }
        {
            // Diagnostic: largest entries of the produced archive, so a
            // self-inflicted entry-limit miss is visible next to the counts.
            let mut sizes: Vec<(usize, String)> = read_zip(&exported)
                .expect("own export readable as zip")
                .iter()
                .map(|(name, data)| (data.len(), name.clone()))
                .collect();
            sizes.sort_by_key(|(size, _)| std::cmp::Reverse(*size));
            println!("largest entries: {:?}", &sizes[..sizes.len().min(4)]);
        }
        let second = import_sketch(&exported).expect("re-import of own export");
        let profile_second = profile(&second);
        assert_eq!(profile_first, profile_second, "round-trip changed fidelity slots");
        println!("corpus {path}");
        println!("{}", serde_json::to_string_pretty(&profile_first).unwrap());
    }

    #[test]
    fn ruler_guides_and_assets_round_trip() {
        let encoded = gap_test_files(
            json!([{"_class": "shapePath", "do_objectID": "n1",
                    "frame": {"x":0,"y":0,"width":10,"height":10},
                    "points": [{"point":"{0,0}"},{"point":"{1,0}"},{"point":"{1,1}"},{"point":"{0,1}"}],
                    "isClosed": true}]),
            json!({"assets": {"_class": "assetCollection", "colors": [],
                              "gradients": [], "images": [],
                              "colorAssets": [{"_class": "colorAsset", "name": "brand",
                                               "color": {"red":1,"green":0,"blue":0,"alpha":1}}]}}),
        );
        // Patch the page to carry ruler guides.
        let mut files: BTreeMap<String, Vec<u8>> = read_zip(&encoded).unwrap();
        let mut page: Value = serde_json::from_slice(&files["pages/p.json"]).unwrap();
        page["horizontalRulerData"] = json!({"_class": "rulerData", "noLabelsOnExport": false,
            "guides": [{"_class": "rulerGuide", "pos": 24.5, "color": {"red":1,"green":0,"blue":0,"alpha":1}}]});
        page["verticalRulerData"] = json!({"_class": "rulerData", "noLabelsOnExport": false,
            "guides": [{"_class": "rulerGuide", "pos": -3.0}]});
        files.insert("pages/p.json".into(), serde_json::to_vec(&page).unwrap());
        let encoded = write_zip(&files.into_iter().collect::<Vec<_>>()).unwrap();

        let back = import_sketch(&encoded).unwrap();
        let guides = &back.pages[0].guides;
        assert_eq!(guides.len(), 2);
        assert_eq!(guides[0].axis, "x");
        assert_eq!(guides[0].position, 24.5);
        assert_eq!(guides[1].axis, "y");
        assert_eq!(guides[1].position, -3.0);
        assert!(back.schema_version >= 11, "guides gate schema 11");
        let containers = &back
            .design_system
            .as_ref()
            .unwrap()
            .sketch_containers;
        assert!(containers.contains_key("rulerData"));
        let assets = containers.get("assets").expect("assets retained");
        assert_eq!(assets["colorAssets"].as_array().unwrap().len(), 1);

        let re = export_sketch(&back).unwrap();
        let re_files = read_zip(&re).unwrap();
        let re_page = first_exported_page(&re_files);
        // Raw ruler payload is authoritative while guide counts match, so
        // even the guide color survives.
        assert_eq!(
            re_page["horizontalRulerData"]["guides"][0]["pos"], json!(24.5)
        );
        assert_eq!(
            re_page["horizontalRulerData"]["guides"][0]["color"]["red"].as_f64(),
            Some(1.0),
            "raw ruler payload preferred over modeled rebuild"
        );
        assert_eq!(re_page["verticalRulerData"]["guides"][0]["pos"], json!(-3.0));
        let document: Value = serde_json::from_slice(&re_files["document.json"]).unwrap();
        assert_eq!(
            document["assets"]["colorAssets"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "interop/source_edit_tests.rs"]
mod source_edit_tests;

#[cfg(all(test,unix))]
mod converter_isolation_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    struct Directory(std::path::PathBuf);
    impl Drop for Directory {fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}}
    fn directory()->Directory {
        let nonce=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p=std::env::temp_dir().join(format!("fxdk-converter-test-{}-{nonce}",std::process::id()));std::fs::create_dir(&p).unwrap();Directory(p)
    }
    fn script(dir:&Directory,name:&str,source:&str)->std::path::PathBuf {
        let p=dir.0.join(name);std::fs::write(&p,source).unwrap();std::fs::set_permissions(&p,std::fs::Permissions::from_mode(0o700)).unwrap();p
    }
    #[test]
    fn concurrent_conversions_have_private_files_and_publish_admitted_documents(){
        let dir=directory();let helper=script(&dir,"copy-converter","#!/bin/sh\ncp \"$1\" \"$2\"\n");
        std::thread::scope(|scope|{
            let jobs=(0..8).map(|i|{
                let helper=&helper;
                scope.spawn(move||{
                    let name=format!("source-{i}");
                    let doc:Document=serde_json::from_value(json!({"schemaVersion":4,"id":"d","name":"source","pages":[{"id":"p","name":name,"children":["n"],"background":"#ffffff"}],"nodes":{"n":{"id":"n","kind":"rectangle","name":name,"width":10,"height":10,"fills":[{"kind":"solid","color":"#ff0000"}]}}})).unwrap();
                    let report=import_fig_via_converter_at(&export_sketch(&doc).unwrap(),helper).unwrap();
                    report.document.validate().unwrap();assert_eq!(report.document.pages[0].name,name);assert_eq!(report.document.nodes["n"].name,name);
                })
            }).collect::<Vec<_>>();
            for job in jobs {job.join().unwrap();}
        });
    }
    #[test]
    fn failed_converter_retains_exit_and_stderr_without_requiring_an_output_file(){
        let dir=directory();let helper=script(&dir,"failed-converter","#!/bin/sh\nprintf 'intentional converter failure' >&2\nexit 7\n");
        let error=import_fig_via_converter_at(b"fig-kiwi",&helper).err().unwrap().to_string();
        assert!(error.contains("7")&&error.contains("intentional converter failure"),"{error}");
    }
}
