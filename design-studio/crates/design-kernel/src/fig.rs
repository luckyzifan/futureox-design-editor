//! Native Figma `.fig` import — a Rust reader for the `.fig` container,
//! following the semantics of the public `fig2sketch`/`figformat` reader
//! stack.
//!
//! Pipeline: `.fig` zip → `canvas.fig` (self-describing Kiwi binary:
//! "fig-kiwi" magic + versioned schema + zlib/zstd payload) → `NODE_CHANGES`
//! message → parent/child tree assembly → kernel [`Document`].
//!
//! Kiwi wire format:
//! - varint: 7-bit little-endian groups; int = zigzag
//! - string: NUL-terminated UTF-8; float: 0x00 → 0.0 else 4-byte LE f32
//! - schema: uvarint type count; per type { nstr name, byte kind,
//!   uvarint field count, per field { nstr name, zigzag type id, byte array,
//!   uvarint ordinal } }
//! - builtin type ids -1..-8 map to
//!   (bool, byte, int, uint, float, string, int64, uint64)
//! - message: loop `fid = uvarint()` until 0, then decode field `fid`
//! - struct: every field in ordinal order; enum(kind 0): uvarint → name
//! - arrays: uvarint count then items
use crate::math::Transform;
use crate::scene::{Document, Effect, Node, Page, Paint, Stroke};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug)]
pub enum Error {
    NotAFig(String),
    Io(String),
    Malformed(String),
    Unsupported(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::NotAFig(m) => write!(f, "not a .fig bundle: {m}"),
            Error::Io(m) => write!(f, "io: {m}"),
            Error::Malformed(m) => write!(f, "malformed kiwi stream: {m}"),
            Error::Unsupported(m) => write!(f, "unsupported: {m}"),
        }
    }
}
impl std::error::Error for Error {}

// ---------------------------------------------------------------------------
// kiwi reader
// ---------------------------------------------------------------------------

struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Reader<'a> {
    fn byte(&mut self) -> Result<u8, Error> {
        let v = *self.b.get(self.p).ok_or(Error::Malformed("eof".into()))?;
        self.p += 1;
        Ok(v)
    }
    fn uint(&mut self) -> Result<u64, Error> {
        let mut v = 0u64;
        let mut sh = 0;
        loop {
            let b = self.byte()?;
            v |= u64::from(b & 0x7f) << sh;
            if b & 0x80 == 0 {
                return Ok(v);
            }
            sh += 7;
            if sh > 63 {
                return Err(Error::Malformed("varint too long".into()));
            }
        }
    }
    fn int(&mut self) -> Result<i64, Error> {
        let v = self.uint()?;
        Ok(if v & 1 == 1 {
            !((v >> 1) as i64)
        } else {
            (v >> 1) as i64
        })
    }
    fn float(&mut self) -> Result<f64, Error> {
        let first = self.byte()?;
        if first == 0 {
            return Ok(0.0);
        }
        let mut bits = u32::from(first);
        for sh in [8, 16, 24] {
            bits |= u32::from(self.byte()?) << sh;
        }
        // kiwi varfloat: the wire carries the f32 bits rotated left by 9
        // (figformat/kiwi.py `float` and kiwi-schema ByteBuffer.readVarFloat
        // both rotate the 4 LE bytes back before reinterpreting them)
        Ok(f32::from_bits(bits.rotate_left(23)) as f64)
    }
    fn string(&mut self) -> Result<String, Error> {
        let end = self.b[self.p..]
            .iter()
            .position(|&c| c == 0)
            .map(|i| self.p + i)
            .ok_or(Error::Malformed("unterminated string".into()))?;
        let s = String::from_utf8(self.b[self.p..end].to_vec())
            .map_err(|_| Error::Malformed("bad utf8".into()))?;
        self.p = end + 1;
        Ok(s)
    }
}

#[derive(Clone, Debug)]
struct FieldDef {
    name: String,
    type_id: i64,
    array: bool,
    ordinal: u64,
}

#[derive(Clone, Debug)]
struct TypeDef {
    name: String,
    kind: u8, // 0 enum, 1 struct, 2 message
    fields: Vec<FieldDef>,
}

fn parse_schema(data: &[u8]) -> Result<Vec<TypeDef>, Error> {
    let mut r = Reader { b: data, p: 0 };
    let count = r.uint()? as usize;
    let mut types = Vec::with_capacity(count);
    for _ in 0..count {
        let name = r.string()?;
        let kind = r.byte()?;
        let mut fields = Vec::new();
        for _ in 0..r.uint()? {
            fields.push(FieldDef {
                name: r.string()?,
                type_id: r.int()?,
                array: r.byte()? != 0,
                ordinal: r.uint()?,
            });
        }
        types.push(TypeDef { name, kind, fields });
    }
    Ok(types)
}

fn decode_value(
    r: &mut Reader<'_>,
    types: &[TypeDef],
    type_id: i64,
    array: bool,
) -> Result<Value, Error> {
    if array {
        let n = r.uint()? as usize;
        let mut items = Vec::with_capacity(n.min(1 << 20));
        for _ in 0..n {
            items.push(decode_value(r, types, type_id, false)?);
        }
        return Ok(Value::Array(items));
    }
    if type_id < 0 {
        // builtins: -1 bool, -2 byte, -3 int, -4 uint, -5 float, -6 string,
        //           -7 int64, -8 uint64
        return Ok(match -type_id {
            1 => Value::Bool(r.byte()? != 0),
            2 => Value::from(r.byte()? as i64),
            3 => Value::from(r.int()?),
            4 => Value::from(r.uint()?),
            5 => Value::from(r.float()?),
            6 => Value::from(r.string()?),
            7 => Value::from(r.int()?),
            8 => Value::from(r.uint()?),
            _ => return Err(Error::Malformed(format!("bad builtin {type_id}"))),
        });
    }
    let ty = types
        .get(type_id as usize)
        .ok_or(Error::Malformed(format!("type {type_id} out of range")))?;
    match ty.kind {
        0 => {
            // enum: uvarint → member name
            let v = r.uint()?;
            let name = ty
                .fields
                .iter()
                .find(|f| f.ordinal == v)
                .map(|f| f.name.clone())
                .unwrap_or_else(|| format!("{v}"));
            Ok(Value::from(name))
        }
        1 => {
            // struct: every field in ordinal order
            let mut map = serde_json::Map::new();
            for f in &ty.fields {
                map.insert(f.name.clone(), decode_value(r, types, f.type_id, f.array)?);
            }
            Ok(Value::Object(map))
        }
        _ => {
            // message: field-id loop until 0
            let mut map = serde_json::Map::new();
            loop {
                let fid = r.uint()?;
                if fid == 0 {
                    break;
                }
                let Some(field) = ty.fields.iter().find(|f| f.ordinal == fid) else {
                    return Err(Error::Malformed(format!("field {fid} not in {}", ty.name)));
                };
                map.insert(
                    field.name.clone(),
                    decode_value(r, types, field.type_id, field.array)?,
                );
            }
            Ok(Value::Object(map))
        }
    }
}

/// Decode `canvas.fig` bytes (Kiwi stream) into a JSON value tree.
pub fn decode_canvas(data: &[u8]) -> Result<Value, Error> {
    if data.len() < 16 || &data[..8] != b"fig-kiwi" {
        return Err(Error::NotAFig("canvas.fig magic missing".into()));
    }
    let version = u32::from_le_bytes([data[8], data[9], data[10], data[11]]);
    if version < 15 {
        return Err(Error::Unsupported(format!(
            ".fig version {version} older than minimum supported (15)"
        )));
    }
    if version > 70 {
        // figformat/kiwi.py only warns above MAX_SUPPORTED_VERSION: newer
        // files usually decode with degraded coverage
        eprintln!("[fig] version {version} newer than tested (70); decoding anyway");
    }
    let mut p = 12usize;
    let seg = |p: &mut usize| -> Result<Vec<u8>, Error> {
        let size = u32::from_le_bytes(
            data.get(*p..*p + 4)
                .and_then(|s| s.try_into().ok())
                .ok_or(Error::Malformed("segment header".into()))?,
        ) as usize;
        *p += 4;
        let raw = data
            .get(*p..*p + size)
            .ok_or(Error::Malformed("segment body".into()))?
            .to_vec();
        *p += size;
        if raw.starts_with(&[0x28, 0xB5, 0x2F, 0xFD]) {
            zstd_decompress(&raw)
        } else {
            zlib_inflate(&raw)
        }
    };
    let schema_data = seg(&mut p)?;
    let data_blob = seg(&mut p)?;
    let types = parse_schema(&schema_data)?;
    if types.is_empty() {
        return Err(Error::Malformed("empty schema".into()));
    }
    // the root message is located by name (figformat/kiwi.py filters
    // schema.types for the "Message" entry before decoding)
    let root_id = types.iter().position(|t| t.name == "Message").unwrap_or(0) as i64;
    decode_value(
        &mut Reader {
            b: &data_blob,
            p: 0,
        },
        &types,
        root_id,
        false,
    )
}

fn zlib_inflate(raw: &[u8]) -> Result<Vec<u8>, Error> {
    miniz_oxide::inflate::decompress_to_vec_with_limit(raw, 256 << 20)
        .map_err(|e| Error::Io(format!("inflate: {e:?}")))
}

fn zstd_decompress(raw: &[u8]) -> Result<Vec<u8>, Error> {
    use std::io::Read;
    let mut out = Vec::new();
    ruzstd::StreamingDecoder::new(std::io::Cursor::new(raw))
        .map_err(|e| Error::Io(e.to_string()))?
        .read_to_end(&mut out)
        .map_err(|e| Error::Io(e.to_string()))?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// .fig container
// ---------------------------------------------------------------------------

/// Read a `.fig` bundle: returns the decoded canvas tree and the raw image
/// blobs (zip `images/` entries + kiwi `blobs` payload), keyed by sha1 name.
#[allow(clippy::type_complexity)]
pub fn read_fig(bytes: &[u8]) -> Result<(Value, BTreeMap<String, Vec<u8>>, Vec<Vec<u8>>), Error> {
    let files = crate::interop::read_zip_public(bytes).map_err(|e| Error::Io(e.to_string()))?;
    let canvas = files
        .get("canvas.fig")
        .ok_or(Error::NotAFig("canvas.fig missing".into()))?;
    let tree = decode_canvas(canvas)?;
    let mut images = BTreeMap::new();
    for (name, data) in &files {
        if let Some(id) = name.strip_prefix("images/") {
            images.insert(id.to_string(), data.clone());
        }
    }
    // kiwi blobs: {bytes: [u8]} entries carrying vector networks etc.
    let mut kiwi_blobs = Vec::new();
    if let Some(blobs) = tree.get("blobs").and_then(Value::as_array) {
        for blob in blobs {
            if let Some(arr) = blob.get("bytes").and_then(Value::as_array) {
                kiwi_blobs.push(
                    arr.iter()
                        .filter_map(|v| v.as_u64().map(|b| b as u8))
                        .collect(),
                );
            }
        }
    }
    Ok((tree, images, kiwi_blobs))
}

// ---------------------------------------------------------------------------
// nodeChanges → Document
// ---------------------------------------------------------------------------
//
// Field names and enum members below come from the schema embedded in each
// canvas.fig (fig-kiwi v48/v106). Semantic reference:
// frontend/design-client/src/import-fig.ts.

use crate::layout::{Align, Anchor, Constraints, Flow, Layout, SizeMode, Sizing};

fn f64_of(v: Option<&Value>, key: &str) -> f64 {
    v.and_then(|v| v.get(key))
        .and_then(Value::as_f64)
        .unwrap_or(0.)
}
fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}
fn bool_of(v: &Value, key: &str) -> Option<bool> {
    v.get(key).and_then(Value::as_bool)
}

/// Node types with a lossless (or explicitly partial) kernel mapping.
///
/// Everything else is *rejected* by name — never silently coerced to a group.
const KNOWN_KINDS: &[(&str, &str)] = &[
    ("FRAME", "frame"),
    ("GROUP", "group"),
    ("BOOLEAN_OPERATION", "group"),
    ("VECTOR", "path"),
    ("LINE", "path"),
    ("ELLIPSE", "ellipse"),
    ("RECTANGLE", "rect"),
    ("ROUNDED_RECTANGLE", "rect"),
    ("REGULAR_POLYGON", "polygon"),
    ("STAR", "star"),
    ("TEXT", "text"),
    ("SLICE", "slice"),
    ("SECTION", "section"),
    // fig's component master is `SYMBOL`; it keeps its own paint/children/
    // autolayout, so it maps to a frame carrying a component binding rather
    // than a bare group.
    ("SYMBOL", "frame"),
    ("INSTANCE", "frame"),
    // 21 号 gap list, whiteboard family: stickies and code blocks ride on
    // the kernel BoardContent; connectors map onto the vector connector
    // facet; table cells are plain text nodes under a table board frame.
    ("STICKY", "frame"),
    ("CODE_BLOCK", "group"),
    ("CONNECTOR", "vector"),
    ("TABLE_CELL", "text"),
    ("SHAPE_WITH_TEXT", "group"),
    ("TABLE", "frame"),
    // Figma 其余节点类型(从其产品文档与 wasm 字符串恢复):
    ("EMBED", "frame"),
    ("MEDIA", "frame"),
    ("GIF", "frame"),
    ("VIDEO", "frame"),
    ("HOTSPOT", "frame"),
    ("ANNOTATION", "text"),
    ("HIGHLIGHT", "rectangle"),
    ("WASHI_TAPE", "rectangle"),
    ("LIKE", "ellipse"),
    ("MARK", "ellipse"),
    ("STAMP", "group"),
    ("SHAPE_WITH_NODES", "group"),
    ("CODE_SANDBOX", "frame"),
    ("COMPONENT_SET", "frame"),
    ("MINI_MAP", "frame"),
];

fn kind_of(fig_type: &str) -> Option<&'static str> {
    KNOWN_KINDS
        .iter()
        .find(|(t, _)| *t == fig_type)
        .map(|(_, k)| *k)
}

fn blend_name(v: &Value) -> String {
    match v.as_str().unwrap_or("PASS_THROUGH") {
        "MULTIPLY" => "multiply",
        "DARKEN" => "darken",
        "COLOR_BURN" => "color-burn",
        "LIGHTEN" => "lighten",
        "SCREEN" => "screen",
        "COLOR_DODGE" => "color-dodge",
        "OVERLAY" => "overlay",
        "SOFT_LIGHT" => "soft-light",
        "HARD_LIGHT" => "hard-light",
        "DIFFERENCE" => "difference",
        "EXCLUSION" => "exclusion",
        "HUE" => "hue",
        "SATURATION" => "saturation",
        "COLOR" => "color",
        "LUMINOSITY" => "luminosity",
        _ => "normal",
    }
    .into()
}

fn hex_color(color: &Value) -> String {
    let r = (f64_of(Some(color), "r").clamp(0., 1.) * 255.).round() as u8;
    let g = (f64_of(Some(color), "g").clamp(0., 1.) * 255.).round() as u8;
    let b = (f64_of(Some(color), "b").clamp(0., 1.) * 255.).round() as u8;
    format!("#{r:02x}{g:02x}{b:02x}")
}

fn alpha_of(color: Option<&Value>) -> f64 {
    color
        .and_then(|c| c.get("a"))
        .and_then(Value::as_f64)
        .unwrap_or(1.)
        .clamp(0., 1.)
}

fn blank_paint(kind: &str) -> Paint {
    crate::scene::Paint {
        transform: None,
        id: String::new(),
        kind: kind.into(),
        color: String::new(),
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

/// Numeric CSS-like font weight for a fig `FontName.style` string
/// ("Bold", "Semi Bold", "Light Italic", …). `None` keeps the base weight.
fn style_weight(fig_style: &str) -> Option<f32> {
    let lower = fig_style.to_ascii_lowercase().replace([' ', '-'], "");
    let lower = lower.trim_end_matches("italic").to_string();
    Some(match lower.as_str() {
        "thin" => 100.,
        "extralight" | "ultralight" => 200.,
        "light" => 300.,
        "regular" | "normal" | "book" => 400.,
        "medium" => 500.,
        "semibold" | "demibold" => 600.,
        "bold" => 700.,
        "extrabold" | "ultrabold" | "heavy" => 800.,
        "black" => 900.,
        _ => return None,
    })
}

/// `Number { value, units }` → a line-height multiplier.
/// Units follow fig2sketch converter/text.py `line_height`: PIXELS is
/// absolute, PERCENT/RAW are relative (100% / 1.0 mean "auto").
fn line_height_multiplier(number: &Value, font_size: f64) -> Option<f64> {
    let value = number.get("value").and_then(Value::as_f64)?;
    match str_of(number, "units") {
        Some("PIXELS") => (font_size >= 1.).then_some(value / font_size),
        Some("PERCENT") => Some(value / 100.),
        Some("RAW") => Some(value),
        _ => None,
    }
}

/// `Number { value, units }` → letter spacing in px, per fig2sketch
/// `kerning`: PIXELS passes through, PERCENT scales with the font size.
fn letter_spacing_px(number: &Value, font_size: f64) -> Option<f64> {
    let value = number.get("value").and_then(Value::as_f64)?;
    match str_of(number, "units") {
        Some("PIXELS") => Some(value),
        Some("PERCENT") => Some(font_size * value / 100.),
        _ => None,
    }
}

fn align_of_stack_justify(v: &str) -> Result<Align, Error> {
    Ok(match v {
        "MIN" => Align::Start,
        "CENTER" => Align::Center,
        "MAX" => Align::End,
        "SPACE_BETWEEN" => Align::SpaceBetween,
        "SPACE_EVENLY" => Align::SpaceEvenly,
        other => return Err(layout_unsupported("stackPrimaryAlignItems", other)),
    })
}

fn align_of_stack_align(v: &str) -> Result<Align, Error> {
    Ok(match v {
        "MIN" => Align::Start,
        "CENTER" => Align::Center,
        "MAX" => Align::End,
        // BASELINE has no kernel counterpart; silently mapping it to any of
        // the plain aligns would change the rendered stack.
        other => return Err(layout_unsupported("stackCounterAlignItems", other)),
    })
}

fn anchor_of_constraint(v: &str) -> Result<Anchor, Error> {
    Ok(match v {
        "MIN" => Anchor::Start,
        "CENTER" => Anchor::Center,
        "MAX" => Anchor::End,
        "STRETCH" => Anchor::Stretch,
        "SCALE" => Anchor::Scale,
        other => return Err(layout_unsupported("constraint", other)),
    })
}

fn size_mode_of(v: &str) -> Result<SizeMode, Error> {
    Ok(match v {
        "FIXED" => SizeMode::Fixed,
        "RESIZE_TO_FIT" | "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" => SizeMode::Hug,
        other => return Err(layout_unsupported("stackSizing", other)),
    })
}

fn layout_unsupported(field: &str, value: &str) -> Error {
    Error::Unsupported(format!(
        "FIG layout field {field}={value} cannot be imported losslessly; \
         the source file was not modified"
    ))
}

/// Bounded non-negative distance as validated by the TS importer
/// (finite, 0..=1e5).
fn distance(record: &Value, field: &str) -> Result<f64, Error> {
    let v = record.get(field).and_then(Value::as_f64).unwrap_or(0.);
    if !v.is_finite() || !(0. ..=1e5).contains(&v) {
        return Err(layout_unsupported(field, &v.to_string()));
    }
    Ok(v)
}

fn enum_str<'a>(record: &'a Value, field: &str) -> Option<&'a str> {
    str_of(record, field)
}

struct FigImporter {
    images: BTreeMap<String, Vec<u8>>,
    kiwi_blobs: Vec<Vec<u8>>,
}

impl FigImporter {
    fn paint(&self, p: &Value, untranslated: &mut Vec<String>) -> Option<Paint> {
        let visible = p.get("visible").and_then(Value::as_bool).unwrap_or(true);
        if !visible {
            return None;
        }
        let opacity = p.get("opacity").and_then(Value::as_f64).unwrap_or(1.);
        let blend = p
            .get("blendMode")
            .map(blend_name)
            .unwrap_or_else(|| "normal".into());
        let kind = p.get("type").and_then(Value::as_str).unwrap_or("SOLID");
        let mut paint = match kind {
            "SOLID" => {
                let mut paint = blank_paint("solid");
                paint.color = p
                    .get("color")
                    .map(hex_color)
                    .unwrap_or_else(|| "#000000".into());
                paint.opacity = alpha_of(p.get("color"));
                paint
            }
            "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND" => {
                let mut paint = blank_paint(match kind {
                    "GRADIENT_RADIAL" => "radial",
                    "GRADIENT_ANGULAR" => "angular",
                    "GRADIENT_DIAMOND" => "diamond",
                    _ => "linear",
                });
                if let Some(stops) = p.get("stops").and_then(Value::as_array) {
                    for s in stops {
                        paint.stops.push(crate::scene::Stop {
                            offset: f64_of(Some(s), "position"),
                            color: s
                                .get("color")
                                .map(hex_color)
                                .unwrap_or_else(|| "#000000".into()),
                        });
                    }
                }
                // gradient space → unit paint coordinates, same matrix
                // semantics as the node transform (Paint.transform doc)
                if let Some(matrix) = p.get("transform") {
                    paint.transform = Some(Transform([
                        f64_of(Some(matrix), "m00"),
                        f64_of(Some(matrix), "m10"),
                        f64_of(Some(matrix), "m01"),
                        f64_of(Some(matrix), "m11"),
                        f64_of(Some(matrix), "m02"),
                        f64_of(Some(matrix), "m12"),
                    ]));
                }
                paint
            }
            "IMAGE" => {
                let mut paint = blank_paint("image");
                let data_ref = p
                    .get("image")
                    .and_then(|i| i.get("dataRef"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        p.get("image")
                            .and_then(|i| i.get("bytesRef"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
                if let Some(name) = data_ref
                    && let Some(bytes) = self.images.get(&name)
                {
                    paint.image = Some(crate::interop::image_data_uri_public(bytes));
                }
                // ScaleMode → kernel fit (FILL stretches over the box)
                paint.fit = match str_of(p, "imageScaleMode") {
                    Some("FILL") => "stretch".into(),
                    Some("FIT") => "contain".into(),
                    Some("TILE") => {
                        // TILE renders through the pattern-fill pipeline.
                        // The kiwi `Paint` (field table below) carries NO
                        // tiling parameters — no patternTileType / tile
                        // size / offset fields exist in it — so those are
                        // recorded as unsupported and only the base behavior
                        // is mapped: a regular grid at the image's native
                        // size with zero offset. Figma-side stagger settings
                        // cannot be recovered from this input; deliberately
                        // not guessed.
                        untranslated.push(
                            "imageScaleMode=TILE(平铺参数不支持:按规则平铺+原始尺寸导入)".into(),
                        );
                        paint.tile = Some(crate::pattern_fill::PatternTile::native());
                        "cover".into()
                    }
                    Some("CROP") => {
                        if let Some(mode) = str_of(p, "imageScaleMode") {
                            untranslated.push(format!("imageScaleMode={mode}"));
                        }
                        "cover".into()
                    }
                    _ => "cover".into(),
                };
                // Verified by plugin -> native FIG -> exported pixel centers.
                // Native negative contrast is already scaled; do not apply
                // the public plugin slider's 0.3 conversion a second time.
                if let Some(filter)=p.get("paintFilter").or_else(||p.get("filterColorAdjust")) {
                    let value=|key:&str|filter.get(key).and_then(Value::as_f64).unwrap_or(0.);
                    let adjust=crate::image_adjust::ImageAdjust { exposure:value("exposure"),contrast:value("contrast"),
                        color:value("vibrance"),temperature:value("temperature"),tint:value("tint"),
                        highlights:value("highlights"),shadows:value("shadows"),highlight_shadow_threshold:0.5 };
                    if adjust.validate() && !adjust.is_identity() { paint.adjust=Some(adjust); }
                    if !adjust.validate() { untranslated.push(format!("invalid paintFilter={filter}")); }
                    if let Some(fields)=filter.as_object() {
                        for (key,v) in fields {
                            if !["exposure","contrast","vibrance","temperature","tint","highlights","shadows"].contains(&key.as_str()) && v.as_f64()!=Some(0.) {
                                untranslated.push(format!("paintFilter.{key}={v}"));
                            }
                        }
                    }
                }
                paint
            }
            // EMOJI paints carry code points rendered glyph-wise, VIDEO
            // paints are animated fills — the kernel has neither entity, so
            // the paint is dropped WITH a report instead of masquerading as
            // a solid color.
            other => {
                untranslated.push(format!("paintType={other}"));
                return None;
            }
        };
        paint.opacity *= opacity;
        paint.blend = blend;
        Some(paint)
    }

    /// Stroke cap → kernel cap + optional end marker. Decorative caps with no
    /// kernel equivalent are returned as the untranslated marker name instead
    /// of being dropped or misnamed.
    fn stroke_cap(cap: Option<&str>) -> (&'static str, crate::stroke::Marker, Option<String>) {
        use crate::stroke::Marker;
        match cap.unwrap_or("NONE") {
            "NONE" => ("butt", Marker::None, None),
            "ROUND" => ("round", Marker::None, None),
            "SQUARE" => ("square", Marker::None, None),
            "ARROW_LINES" | "ARROW_EQUILATERAL" => ("butt", Marker::Arrow, None),
            "TRIANGLE_FILLED" => ("butt", Marker::Triangle, None),
            "DIAMOND_FILLED" => ("butt", Marker::Diamond, None),
            "CIRCLE_FILLED" => ("butt", Marker::Circle, None),
            // HIGHLIGHT / WASHI_TAPE_* / ERD_* have no kernel stroke shape.
            other => ("butt", Marker::None, Some(other.to_string())),
        }
    }

    fn node(&self, change: &Value, untranslated: &mut Vec<String>) -> Result<Node,Error> {
        let fig_type = str_of(change, "type").unwrap_or("GROUP");
        let kind = kind_of(fig_type).unwrap_or("group");
        let id = guid_string(change.get("guid").unwrap_or(&Value::Null));
        let mut node = crate::facet::sample_node(&id, kind);
        node.name = str_of(change, "name").unwrap_or_default().into();
        node.visible = bool_of(change, "visible").unwrap_or(true);
        node.locked = bool_of(change, "locked").unwrap_or(false);
        node.opacity = change.get("opacity").and_then(Value::as_f64).unwrap_or(1.);
        node.blend = change
            .get("blendMode")
            .map(blend_name)
            .unwrap_or_else(|| "normal".into());
        let size = change.get("size").cloned().unwrap_or(Value::Null);
        if change.get("size").is_some() {
            node.width = f64_of(Some(&size), "x").max(0.);
            node.height = f64_of(Some(&size), "y").max(0.);
        }
        // figma's relative transform maps the node's local (untransformed)
        // box into the parent; the kernel transform has identical semantics,
        // so the matrix — including flips and rotation — passes through
        // verbatim. The old AABB + re-rotation decomposition discarded flips
        // (a horizontal flip became a 180° rotation) and double-rotated
        // already-rotated boxes.
        if let Some(m) = change.get("transform") {
            node.transform = Transform([
                f64_of(Some(m), "m00"),
                f64_of(Some(m), "m10"),
                f64_of(Some(m), "m01"),
                f64_of(Some(m), "m11"),
                f64_of(Some(m), "m02"),
                f64_of(Some(m), "m12"),
            ]);
        }
        node.mask = bool_of(change, "mask").unwrap_or(false);
        if str_of(change, "maskType") == Some("LUMINANCE") {
            node.mask_type = Some("luminance".into());
        } else if let Some(mt) = str_of(change, "maskType").filter(|mt| *mt != "ALPHA") {
            untranslated.push(format!("maskType={mt}"));
        }
        if kind == "frame" {
            node.clip = !bool_of(change, "frameMaskDisabled").unwrap_or(false);
        }

        // corners: per-corner radii with the scalar as fallback (TS :557-563).
        // kernel `corner_radius` is polygon/star corner rounding only
        // (authoring_shapes::validate); rectangles keep rounding in `radii`.
        let scalar_radius = f64_of(Some(change), "cornerRadius");
        if matches!(fig_type, "STAR" | "REGULAR_POLYGON") {
            node.corner_radius = scalar_radius;
        }
        node.radii = [
            change
                .get("rectangleTopLeftCornerRadius")
                .and_then(Value::as_f64)
                .unwrap_or(scalar_radius),
            change
                .get("rectangleTopRightCornerRadius")
                .and_then(Value::as_f64)
                .unwrap_or(scalar_radius),
            change
                .get("rectangleBottomRightCornerRadius")
                .and_then(Value::as_f64)
                .unwrap_or(scalar_radius),
            change
                .get("rectangleBottomLeftCornerRadius")
                .and_then(Value::as_f64)
                .unwrap_or(scalar_radius),
        ];
        node.smoothing = change
            .get("cornerSmoothing")
            .and_then(Value::as_f64)
            .unwrap_or(0.);

        if let Some(paints) = change.get("fillPaints").and_then(Value::as_array) {
            for p in paints {
                if let Some(paint) = self.paint(p, untranslated) {
                    node.fills.push(paint);
                }
            }
        }
        if let Some(paints) = change.get("strokePaints").and_then(Value::as_array) {
            let mut weight = change
                .get("strokeWeight")
                .and_then(Value::as_f64)
                .unwrap_or(1.);
            if bool_of(change, "borderStrokeWeightsIndependent").unwrap_or(false) {
                let borders = [
                    change
                        .get("borderTopWeight")
                        .and_then(Value::as_f64)
                        .unwrap_or(weight),
                    change
                        .get("borderRightWeight")
                        .and_then(Value::as_f64)
                        .unwrap_or(weight),
                    change
                        .get("borderBottomWeight")
                        .and_then(Value::as_f64)
                        .unwrap_or(weight),
                    change
                        .get("borderLeftWeight")
                        .and_then(Value::as_f64)
                        .unwrap_or(weight),
                ];
                if !borders.iter().all(|v| (v - borders[0]).abs() < 1e-9) {
                    untranslated.push("borderStrokeWeightsIndependent(non-uniform)".into());
                } else {
                    weight = borders[0];
                }
            }
            let cap = Self::stroke_cap(str_of(change, "strokeCap"));
            if let Some(marker) = &cap.2 {
                untranslated.push(format!("strokeCap={marker}"));
            }
            let join = match str_of(change, "strokeJoin").unwrap_or("MITER") {
                "ROUND" => "round",
                "BEVEL" => "bevel",
                _ => "miter",
            };
            let dash = change
                .get("dashPattern")
                .and_then(Value::as_array)
                .map(|xs| {
                    xs.iter()
                        .filter_map(|v| v.as_f64())
                        .map(|v| format!("{v}"))
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            for p in paints {
                if let Some(paint) = self.paint(p, untranslated) {
                    node.strokes.push(Stroke {
                        start_marker: Default::default(),
                        end_marker: cap.1,
                        id: String::new(),
                        paint,
                        width: weight.max(0.01),
                        align: match str_of(change, "strokeAlign") {
                            Some("INSIDE") => "inside",
                            Some("OUTSIDE") => "outside",
                            _ => "center",
                        }
                        .into(),
                        cap: cap.0.into(),
                        join: join.into(),
                        dash: dash.clone(),
                        dash_offset: 0.,
                        visible: true,
                        width_profile: Vec::new(),
                    });
                }
            }
        }
        if let Some(effects) = change.get("effects").and_then(Value::as_array) {
            for e in effects {
                let etype = str_of(e, "type").unwrap_or("");
                // EffectType has exactly four members; LAYER_BLUR does not
                // exist in .fig (the REST API name) — FOREGROUND_BLUR is the
                // layer blur of the native format.
                let kind = match etype {
                    "DROP_SHADOW" => "shadow",
                    "INNER_SHADOW" => "inner-shadow",
                    "FOREGROUND_BLUR" => "blur",
                    "BACKGROUND_BLUR" => "background-blur",
                    _ => continue,
                };
                let (ox, oy) = e
                    .get("offset")
                    .map(|o| (f64_of(Some(o), "x"), f64_of(Some(o), "y")))
                    .unwrap_or((0., 0.));
                // per-effect blend has no kernel Effect slot — report instead
                // of silently dropping it (normal stays quiet).
                if let Some(mode) = str_of(e, "blendMode").filter(|m| *m != "NORMAL") {
                    untranslated.push(format!("effectBlendMode={mode}"));
                }
                if bool_of(e, "showShadowBehindNode").unwrap_or(false) {
                    untranslated.push("showShadowBehindNode=true".into());
                }
                node.effects.push(Effect {
                    id: String::new(),
                    kind: kind.into(),
                    visible: bool_of(e, "visible").unwrap_or(true),
                    radius: f64_of(Some(e), "radius"),
                    x: ox,
                    y: oy,
                    spread: f64_of(Some(e), "spread"),
                    color: e
                        .get("color")
                        .map(hex_color)
                        .unwrap_or_else(|| "#000000".into()),
                    opacity: alpha_of(e.get("color")),
                    amount: 0.,
                    glass: None,
                    texture: None,
                    gradient_blur: None,
                });
            }
        }

        // prototype interactions (schema field name is prototypeInteractions;
        // `reactions` does not exist in any fig-kiwi schema generation)
        if let Some(interactions) = change
            .get("prototypeInteractions")
            .and_then(Value::as_array)
        {
            let mut flows = Vec::new();
            for interaction in interactions {
                if bool_of(interaction, "isDeleted").unwrap_or(false) {
                    continue;
                }
                let trigger = interaction
                    .get("event")
                    .and_then(|ev| str_of(ev, "interactionType"))
                    .unwrap_or("ON_CLICK");
                for action in interaction
                    .get("actions")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    flows.push(serde_json::json!({
                        "trigger": trigger,
                        "destinationId": action.get("transitionNodeID").map(guid_string),
                        "navigation": str_of(action, "navigationType"),
                        "transition": str_of(action, "transitionType"),
                        "duration": action.get("transitionDuration").and_then(Value::as_f64),
                    }));
                }
            }
            if !flows.is_empty() {
                node.bindings.insert(
                    "prototypeFlow".into(),
                    serde_json::to_string(&flows).unwrap_or_default(),
                );
            }
        }

        match fig_type {
            "TEXT" | "TABLE_CELL" => self.import_text(&mut node, change, untranslated),
            "STAR" | "REGULAR_POLYGON" => {
                node.points = change.get("count").and_then(Value::as_u64).unwrap_or(5) as usize;
                // the native schema calls it starInnerScale
                node.inner_radius = change
                    .get("starInnerScale")
                    .and_then(Value::as_f64)
                    .unwrap_or_default();
            }
            "BOOLEAN_OPERATION" => {
                node.boolean_operation = match str_of(change, "booleanOperation") {
                    Some("INTERSECT") => Some(crate::boolean::Operation::Intersect),
                    Some("SUBTRACT") => Some(crate::boolean::Operation::Subtract),
                    Some("XOR") => Some(crate::boolean::Operation::Exclude),
                    _ => Some(crate::boolean::Operation::Union),
                };
            }
            "SYMBOL" => {
                if let Some(g) = change.get("guid") {
                    node.bindings.insert("symbolID".into(), guid_string(g));
                }
                // 21 号 P2-14 componentProperties: the published component key
                // and the property definitions (variants/variables) map onto
                // the kernel component payload; COLOR props have no kernel
                // PropertyKind and stay verbatim in bindings.
                if let Some(key) = str_of(change, "componentKey").filter(|k| !k.is_empty()) {
                    node.component_key = Some(key.to_string());
                }
                let mut component = crate::components::Component::default();
                if let Some(defs) = change.get("componentPropDefs").and_then(Value::as_array) {
                    for def in defs {
                        if bool_of(def, "isDeleted").unwrap_or(false) {
                            continue;
                        }
                        let Some(name) = str_of(def, "name") else {
                            continue;
                        };
                        let kind = match str_of(def, "type") {
                            Some("BOOL") => Some(crate::components::PropertyKind::Boolean),
                            Some("TEXT") => Some(crate::components::PropertyKind::Text),
                            Some("INSTANCE_SWAP") => {
                                Some(crate::components::PropertyKind::InstanceSwap)
                            }
                            other => {
                                if let Some(t) = other {
                                    untranslated.push(format!("componentPropType={t}"));
                                }
                                None
                            }
                        };
                        if let Some(kind) = kind {
                            component.properties.insert(
                                name.to_string(),
                                crate::components::Property {
                                    name: name.to_string(),
                                    kind,
                                    target_key: def.get("id").map(guid_string).unwrap_or_default(),
                                    default_value: def
                                        .get("initialValue")
                                        .cloned()
                                        .unwrap_or(Value::Null),
                                },
                            );
                        }
                    }
                }
                node.component = Some(component);
            }
            "INSTANCE" => {
                if let Some(sd) = change.get("symbolData") {
                    let component_id = sd
                        .get("symbolID")
                        .map(guid_string)
                        .unwrap_or_else(|| "unknown".into());
                    let mut overrides = crate::components::Overrides::new();
                    if let Some(list) = sd.get("symbolOverrides").and_then(Value::as_array) {
                        for ov in list {
                            // entry key: overrideKey (GUID) in current schemas,
                            // guidPath (GUIDPath) in older generations
                            let path = ov
                                .get("overrideKey")
                                .map(guid_string)
                                .or_else(|| {
                                    ov.get("guidPath")
                                        .and_then(|p| p.get("guids"))
                                        .and_then(Value::as_array)
                                        .map(|gs| {
                                            gs.iter().map(guid_string).collect::<Vec<_>>().join("/")
                                        })
                                })
                                .unwrap_or_else(|| "self".into());
                            let mut fields = BTreeMap::new();
                            if let Some(obj) = ov.as_object() {
                                for (k, v) in obj {
                                    if k == "guidPath" || k == "overrideKey" || k == "styleID" {
                                        continue;
                                    }
                                    // translate fill/stroke paint arrays into kernel paints
                                    if k == "fillPaints" || k == "strokePaints" {
                                        if let Some(paints) = v.as_array() {
                                            let converted: Vec<Value> = paints
                                                .iter()
                                                .filter_map(|p| {
                                                    self.paint(p, untranslated).and_then(|kp| {
                                                        serde_json::to_value(kp).ok()
                                                    })
                                                })
                                                .collect();
                                            fields.insert(k.clone(), Value::Array(converted));
                                        }
                                    } else {
                                        fields.insert(k.clone(), v.clone());
                                    }
                                }
                            }
                            overrides.insert(path, fields);
                        }
                    }
                    let mut instance = crate::components::Instance {
                        slot_contents: Default::default(),
                        component_id,
                        overrides,
                        property_values: BTreeMap::new(),
                    };
                    // 21 号 P2-14: assigned component property values
                    // (variant/variable selections) keyed by their def GUID.
                    if let Some(assignments) = change
                        .get("componentPropAssignments")
                        .and_then(Value::as_array)
                    {
                        for assignment in assignments {
                            let Some(def_id) = assignment.get("defID") else {
                                continue;
                            };
                            let key = guid_string(def_id);
                            let value = assignment
                                .get("value")
                                .cloned()
                                .filter(|v| !v.is_null())
                                .unwrap_or_else(|| {
                                    assignment.get("varValue").cloned().unwrap_or(Value::Null)
                                });
                            if !value.is_null() {
                                instance.property_values.insert(key, value);
                            }
                        }
                    }
                    node.instance = Some(instance);
                }
            }
            "STICKY" => {
                // Whiteboard sticky: frame + BoardContent{sticky}; the
                // characters survive as node text.
                node.board = Some(crate::scene::BoardContent {
                    language: None,
                    kind: "sticky".into(),
                    rows: None,
                    columns: None,
                });
                let td = change.get("textData").cloned().unwrap_or(Value::Null);
                if let Some(text) = str_of(&td, "characters") {
                    node.text = text.into();
                }
                if let Some(size) = change.get("fontSize").and_then(Value::as_f64) {
                    node.font_size = size.max(1.);
                }
                // Per-segment styles (21 号 gap list): the sticky textData
                // carries the same characterStyleIDs/styleOverrideTable the
                // TEXT pipeline decodes, so runs import verbatim; without a
                // style table the whole string keeps the node-level style
                // (整段回退). Rendering v1 still draws the whole string —
                // storage stays faithful for the per-run renderer.
                if !node.text.is_empty() {
                    node.text_runs = styled_text_runs(&td, &node.text, untranslated);
                }
            }
            "CODE_BLOCK" => {
                // Code block: language maps onto the kernel board language
                // set; unsupported languages degrade to plain with a note.
                let language = match str_of(change, "codeBlockLanguage") {
                    Some("JAVASCRIPT") => Some("javascript".to_string()),
                    Some("TYPESCRIPT") => Some("typescript".to_string()),
                    Some("JSON") => Some("json".to_string()),
                    Some("PYTHON") => Some("python".to_string()),
                    Some(other) => {
                        untranslated.push(format!("codeBlockLanguage={other}"));
                        None
                    }
                    None => None,
                };
                node.board = Some(crate::scene::BoardContent {
                    language,
                    kind: "code-block".into(),
                    rows: None,
                    columns: None,
                });
                let td = change.get("textData").cloned().unwrap_or(Value::Null);
                if let Some(text) = str_of(&td, "characters") {
                    node.text = text.into();
                }
            }
            "SHAPE_WITH_TEXT" => {
                // Six whiteboard shapes have kernel board kinds; the rest of
                // the fig shape family is rejected by name upstream.
                let kind = match str_of(change, "shapeWithTextType") {
                    Some("SQUARE") => "shape-whiteboard-square",
                    Some("ELLIPSE") => "shape-whiteboard-ellipse",
                    Some("DIAMOND") => "shape-whiteboard-diamond",
                    Some("TRIANGLE_UP") => "shape-whiteboard-triangle-up",
                    Some("TRIANGLE_DOWN") => "shape-whiteboard-triangle-down",
                    Some("ROUNDED_RECTANGLE") => "shape-whiteboard-rounded-rectangle",
                    _ => unreachable!("classification pass filters unsupported shapes"),
                };
                node.board = Some(crate::scene::BoardContent {
                    language: None,
                    kind: kind.into(),
                    rows: None,
                    columns: None,
                });
                let td = change.get("textData").cloned().unwrap_or(Value::Null);
                if let Some(text) = str_of(&td, "characters") {
                    node.text = text.into();
                }
            }
            "TABLE" => {
                // Table dimensions come from the row/column size maps; the
                // kernel board enforces 1..=50 rows × 1..=30 columns with a
                // 600-cell budget, checked by the classification pass.
                let count = |field: &str| -> usize {
                    change
                        .get(field)
                        .and_then(|m| m.get("entries"))
                        .and_then(Value::as_array)
                        .map(Vec::len)
                        .unwrap_or(0)
                };
                node.board = Some(crate::scene::BoardContent {
                    language: None,
                    kind: "table".into(),
                    rows: Some(count("tableRowHeights") as u32),
                    columns: Some(count("tableColumnWidths") as u32),
                });
            }
            "CONNECTOR" => {
                // Connector endpoints: fig ConnectorEndpoint{endpointNodeID,
                // position, magnet} → kernel Endpoint{node_id, point}. The
                // kernel requires an anchor for attached endpoints, so the
                // magnet edge maps onto the unit-side anchor point.
                let magnet_anchor = |magnet: &str| -> (Option<crate::math::Point>, bool) {
                    match magnet {
                        "TOP" => (Some(crate::math::Point::new(0.5, 0.)), false),
                        "BOTTOM" => (Some(crate::math::Point::new(0.5, 1.)), false),
                        "LEFT" => (Some(crate::math::Point::new(0., 0.5)), false),
                        "RIGHT" => (Some(crate::math::Point::new(1., 0.5)), false),
                        "CENTER" => (Some(crate::math::Point::new(0.5, 0.5)), false),
                        // AUTO picks the nearest edge automatically; the
                        // nearest kernel approximation is the center anchor
                        "AUTO" => (Some(crate::math::Point::new(0.5, 0.5)), true),
                        // NONE magnets only float freely; attached endpoints
                        // still need an anchor, so degrade to center
                        _ => (Some(crate::math::Point::new(0.5, 0.5)), true),
                    }
                };
                let endpoint = |v: &Value, untranslated: &mut Vec<String>| {
                    let pos = v.get("position").cloned().unwrap_or(Value::Null);
                    let magnet = str_of(v, "magnet").unwrap_or("AUTO");
                    let (anchor, approximate) = magnet_anchor(magnet);
                    if approximate {
                        untranslated.push(format!("connectorMagnet={magnet}->center"));
                    }
                    crate::connectors::Endpoint {
                        point: crate::math::Point::new(
                            f64_of(Some(&pos), "x"),
                            f64_of(Some(&pos), "y"),
                        ),
                        node_id: v.get("endpointNodeID").map(guid_string),
                        anchor,
                    }
                };
                let style = match str_of(change, "connectorLineStyle") {
                    Some("ELBOWED") => "elbow",
                    Some("CURVED") => {
                        untranslated.push("connectorLineStyle=CURVED".into());
                        "straight"
                    }
                    _ => "straight",
                };
                let (from, to) = (
                    change
                        .get("connectorStart")
                        .map(|v| endpoint(v, untranslated))
                        .unwrap_or_else(|| crate::connectors::Endpoint {
                            point: crate::math::Point::new(0., 0.),
                            node_id: None,
                            anchor: None,
                        }),
                    change
                        .get("connectorEnd")
                        .map(|v| endpoint(v, untranslated))
                        .unwrap_or_else(|| crate::connectors::Endpoint {
                            point: crate::math::Point::new(0., 0.),
                            node_id: None,
                            anchor: None,
                        }),
                );
                node.connector = Some(crate::connectors::Connector {
                    from,
                    to,
                    style: style.into(),
                });
            }
            _ => {}
        }
        // vector networks: blob index → binary network → kernel geometry
        if fig_type == "VECTOR"
            && let Some(vd) = change.get("vectorData")
            && let Some(blob_id) = vd.get("vectorNetworkBlob").and_then(Value::as_u64)
        {
            let scale = vd.get("normalizedSize").map(|size|(node.width/f64_of(Some(size),"x"),node.height/f64_of(Some(size),"y"))).unwrap_or((1.,1.));
            let blob=self.kiwi_blobs.get(blob_id as usize).ok_or_else(||Error::Malformed("FIG vector blob is missing".into()))?;
            let decoded=crate::fig_geometry::decode_network(blob,scale.0,scale.1).map_err(Error::Malformed)?;
            if decoded.vertex_styles.iter().chain(&decoded.region_styles).any(|id|*id!=0) {untranslated.push("vector vertex/region style overrides require source style mapping".into());}
            node.network=decoded.network;
            node.vector_geometry=decoded.vector_geometry;
        }
        if fig_type=="VECTOR" && let Some(entries)=change.get("fillGeometry").and_then(Value::as_array).filter(|v|!v.is_empty()) {
            let mut fill=crate::path::Path::default();let mut rule=None;
            for entry in entries {
                let index=entry.get("commandsBlob").and_then(Value::as_u64).ok_or_else(||Error::Malformed("FIG fill geometry blob missing".into()))?;
                let blob=self.kiwi_blobs.get(index as usize).ok_or_else(||Error::Malformed("FIG fill geometry blob unavailable".into()))?;
                let current=if matches!(str_of(entry,"windingRule"),Some("ODD"|"EVENODD")){"evenodd"}else{"nonzero"};
                if rule.is_some_and(|r|r!=current){return Err(Error::Unsupported("Mixed FIG fill winding requires separate paint geometry".into()));}rule=Some(current);
                fill.commands.extend(crate::fig_geometry::decode_commands(blob).map_err(Error::Malformed)?.commands);
            }
            let stroke=if let Some(geometry)=&node.vector_geometry {geometry.paths().map_err(Error::Malformed)?.1}
                else if let Some(network)=&node.network {network.paths().map_err(Error::Malformed)?.1}
                else if node.strokes.iter().any(|s|s.visible&&s.width>0.) {return Err(Error::Unsupported("FIG fill outline has no corresponding stroke path".into()));}
                else {fill.clone()};
            node.vector_geometry=Some(crate::vector_geometry::VectorGeometry::from_paths(&fill,&stroke,rule.unwrap()).map_err(Error::Malformed)?);
            node.network=None;
        }
        Ok(node)
    }

    /// Text: node-level style plus per-segment runs recovered from
    /// `characterStyleIDs` + `styleOverrideTable` (entries are NodeChange
    /// partials keyed by their own `styleID` field).
    fn import_text(&self, node: &mut Node, change: &Value, untranslated: &mut Vec<String>) {
        let td = change.get("textData").cloned().unwrap_or(Value::Null);
        node.text = str_of(&td, "characters").unwrap_or_default().into();
        let font_size = change
            .get("fontSize")
            .and_then(Value::as_f64)
            .unwrap_or(16.);
        node.font_size = font_size.max(1.);
        let mut style = crate::font::TextStyle {
            wrap: true,
            ..Default::default()
        };
        style.paragraph_spacing = change
            .get("paragraphSpacing")
            .and_then(Value::as_f64)
            .unwrap_or(0.);
        style.paragraph_indent = change
            .get("paragraphIndent")
            .and_then(Value::as_f64)
            .unwrap_or(0.);
        style.align = match str_of(change, "textAlignHorizontal") {
            Some("CENTER") => "center",
            Some("RIGHT") => "end",
            Some("JUSTIFIED") => "justify",
            _ => "start",
        }
        .into();
        if let Some(font_name) = change.get("fontName") {
            if let Some(weight) = str_of(font_name, "style").and_then(style_weight) {
                style.weight = weight;
            }
            // the kernel only resolves fonts registered as resources; keep
            // the original family visible for later matching
            let family = str_of(font_name, "family").unwrap_or_default();
            if !family.is_empty() {
                untranslated.push(format!("fontName.family={family}"));
            }
        }
        if let Some(lh) = change.get("lineHeight") {
            match line_height_multiplier(lh, node.font_size) {
                Some(m) => style.line_height = m,
                None => untranslated.push(format!("lineHeight={lh}")),
            }
        }
        if let Some(ls) = change.get("letterSpacing") {
            match letter_spacing_px(ls, node.font_size) {
                Some(px) => style.letter_spacing = px,
                None => untranslated.push(format!("letterSpacing={ls}")),
            }
        }
        match str_of(change, "textCase") {
            Some("UPPER") => style.text_case = crate::font::TextCase::Upper,
            Some("LOWER") => style.text_case = crate::font::TextCase::Lower,
            Some(case) if case != "ORIGINAL" => untranslated.push(format!("textCase={case}")),
            _ => {},
        }
        if let Some(v) = str_of(change, "textAlignVertical").filter(|v| *v != "TOP") {
            untranslated.push(format!("textAlignVertical={v}"));
        }
        // 21 号/23 号 C1 font_features: toggled OpenType features map
        // directly onto the kernel's harfbuzz-syntax toggle list ("liga" on,
        // "-liga" off); the fig enum carries plain uppercase tags.
        for (field, on) in [
            ("toggledOnOTFeatures", true),
            ("toggledOffOTFeatures", false),
        ] {
            if let Some(tags) = change.get(field).and_then(Value::as_array) {
                for tag in tags {
                    if let Some(tag) = tag.as_str() {
                        let tag = tag.to_ascii_lowercase();
                        style
                            .features
                            .push(if on { tag } else { format!("-{tag}") });
                    }
                }
            }
        }
        // variable-font axes: FontVariation{axisTag(u32), value} → the
        // kernel's four-char tag + value (the reserved wght axis follows the
        // authored weight instead).
        if let Some(variations) = change.get("fontVariations").and_then(Value::as_array) {
            for variation in variations {
                let Some(value) = variation.get("value").and_then(Value::as_f64) else {
                    continue;
                };
                let tag = variation
                    .get("axisTag")
                    .and_then(Value::as_u64)
                    .map(|bits| {
                        // the axis tag is a big-endian u32 of four ASCII
                        // chars ("wght" = 0x77676874)
                        let bytes = (bits as u32).to_be_bytes();
                        String::from_utf8_lossy(&bytes).to_string()
                    })
                    .or_else(|| {
                        variation
                            .get("axisName")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
                if let Some(tag) = tag
                    && tag.len() == 4
                    && tag != "wght"
                {
                    style
                        .variations
                        .push(crate::font::TextVariation { tag, value });
                }
            }
        }
        node.text_style = Some(style);

        // per-segment styles
        let characters = node.text.clone();
        if characters.is_empty() {
            return;
        }
        node.text_runs = styled_text_runs(&td, &characters, untranslated);
        // node-level decoration applies to the whole string when no
        // per-character styles carve it up
        match str_of(change, "textDecoration") {
            Some("UNDERLINE") | Some("STRIKETHROUGH") => {
                let underline = str_of(change, "textDecoration") == Some("UNDERLINE");
                if node.text_runs.is_empty() {
                    node.text_runs.push(crate::font::TextRun {
            text_case: None,
                        color: None,
                        underline,
                        strikethrough: !underline,
                        link: None,
                        start: 0,
                        end: characters.encode_utf16().count(),
                        font_id: None,
                        font_size: None,
                        weight: None,
                    });
                } else {
                    untranslated.push(format!(
                        "textDecoration={}",
                        str_of(change, "textDecoration").unwrap_or_default()
                    ));
                }
            }
            _ => {}
        }
    }
}

/// Per-segment runs recovered from a kiwi `textData` payload
/// (`characterStyleIDs` + `styleOverrideTable`), shared by TEXT/TABLE_CELL
/// nodes and STICKY boards: whiteboard stickies carry the same per-segment
/// style fields on their textData. Runs merge adjacent characters that share
/// one style id; entries are NodeChange partials keyed by `styleID`. Keys
/// with no kernel home are reported instead of vanishing.
fn styled_text_runs(
    td: &Value,
    characters: &str,
    untranslated: &mut Vec<String>,
) -> Vec<crate::font::TextRun> {
    let empty = Vec::new();
    let style_ids = td
        .get("characterStyleIDs")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let empty_table = Vec::new();
    let table = td
        .get("styleOverrideTable")
        .and_then(Value::as_array)
        .unwrap_or(&empty_table);
    let entry_of = |id: &Value| -> Option<&Value> {
        let id = id.as_u64()?;
        if id == 0 {
            return None;
        }
        table
            .iter()
            .find(|e| e.get("styleID").and_then(Value::as_u64) == Some(id))
    };
    let mut runs = Vec::new();
    let mut dropped: Vec<String> = Vec::new();
    let mut utf16 = 0usize;
    let mut chars = characters.chars().peekable();
    while let Some(c) = chars.next() {
        let len = c.len_utf16();
        let entry = style_ids.get(utf16).and_then(entry_of);
        if entry.is_none() {
            utf16 += len;
            continue;
        }
        let start = utf16;
        let mut end = utf16 + len;
        // extend the run while subsequent characters share the same style id
        while let Some(next) = chars.peek() {
            let next_len = next.len_utf16();
            let next_id = style_ids.get(end);
            let cur_id = style_ids.get(start);
            if next_id.is_some() && next_id == cur_id {
                end += next_len;
                chars.next();
            } else {
                break;
            }
        }
        utf16 = end;
        let entry = entry.expect("checked");
        let mut run = crate::font::TextRun {
            text_case: match str_of(entry,"textCase") {
                Some("UPPER")=>Some(crate::font::TextCase::Upper),Some("LOWER")=>Some(crate::font::TextCase::Lower),
                Some("ORIGINAL")=>Some(crate::font::TextCase::Original),_=>None,
            },
            color: None,
            underline: false,
            strikethrough: false,
            link: None,
            start,
            end,
            font_id: None,
            font_size: None,
            weight: None,
        };
        if let Some(size) = entry.get("fontSize").and_then(Value::as_f64) {
            run.font_size = Some(size.max(1.));
        }
        if let Some(weight) = entry
            .get("fontName")
            .and_then(|f| str_of(f, "style"))
            .and_then(style_weight)
        {
            run.weight = Some(weight);
        }
        if let Some(paint) = entry
            .get("fillPaints")
            .and_then(Value::as_array)
            .and_then(|ps| ps.first())
            && let Some(color) = paint.get("color")
        {
            run.color = Some(hex_color(color));
        }
        match str_of(entry, "textDecoration") {
            Some("UNDERLINE") => run.underline = true,
            Some("STRIKETHROUGH") => run.strikethrough = true,
            _ => {}
        }
        // keys with no kernel home must not vanish
        for key in [
            "lineHeight",
            "letterSpacing",
            "textAlignHorizontal",
        ] {
            if let Some(v) = entry.get(key).filter(|v| !v.is_null()) {
                dropped.push(format!("{key}={v}"));
            }
        }
        if let Some(case)=str_of(entry,"textCase").filter(|c| !["ORIGINAL","UPPER","LOWER"].contains(c)) {
            dropped.push(format!("textCase={case}"));
        }
        runs.push(run);
    }
    if !dropped.is_empty() {
        let mut seen: Vec<&String> = Vec::new();
        for d in &dropped {
            if !seen.contains(&d) {
                seen.push(d);
            }
        }
        untranslated.push(format!(
            "textSegments[{}]",
            seen.into_iter().cloned().collect::<Vec<_>>().join(",")
        ));
    }
    runs
}

impl FigImporter {
    /// Autolayout stacks, sizing and constraints (TS import-fig.ts
    /// importLayout, fig2sketch converter/layout.py).
    fn import_layout(
        &self,
        node: &mut Node,
        record: &Value,
        parent: Option<&Value>,
        untranslated: &mut Vec<String>,
    ) -> Result<(), Error> {
        let mode = match enum_str(record, "stackMode") {
            None | Some("NONE") => Flow::None,
            Some("HORIZONTAL") => Flow::Horizontal,
            Some("VERTICAL") => Flow::Vertical,
            Some(other) => return Err(layout_unsupported("stackMode", other)),
        };
        let has_layout = mode != Flow::None;
        if has_layout {
            if !matches!(node.kind.as_str(), "frame" | "group" | "section") {
                return Err(layout_unsupported("stackMode", node.kind.as_str()));
            }
            // Older layout generations have different contracts; only the
            // neutral legacy values (or absence) may be ignored (TS :279-290).
            let legacy_neutral: [(&str, bool); 7] = [
                (
                    "stackCounterAlign",
                    matches!(str_of(record, "stackCounterAlign"), None | Some("MIN")),
                ),
                (
                    "stackJustify",
                    matches!(str_of(record, "stackJustify"), None | Some("MIN")),
                ),
                (
                    "stackAlign",
                    matches!(str_of(record, "stackAlign"), None | Some("MIN")),
                ),
                (
                    "stackWidth",
                    matches!(str_of(record, "stackWidth"), None | Some("FIXED")),
                ),
                (
                    "stackHeight",
                    matches!(str_of(record, "stackHeight"), None | Some("FIXED")),
                ),
                (
                    "stackCounterAlignContent",
                    matches!(
                        str_of(record, "stackCounterAlignContent"),
                        None | Some("AUTO")
                    ),
                ),
                (
                    "stackPadding",
                    record
                        .get("stackPadding")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.)
                        == 0.,
                ),
            ];
            for (field, neutral) in legacy_neutral {
                if !neutral {
                    return Err(layout_unsupported(
                        field,
                        &record
                            .get(field)
                            .cloned()
                            .unwrap_or(Value::Null)
                            .to_string(),
                    ));
                }
            }
            let horizontal = distance(record, "stackHorizontalPadding")?;
            let vertical = distance(record, "stackVerticalPadding")?;
            let padding = [
                vertical,
                record
                    .get("stackPaddingRight")
                    .and_then(Value::as_f64)
                    .unwrap_or(horizontal),
                record
                    .get("stackPaddingBottom")
                    .and_then(Value::as_f64)
                    .unwrap_or(vertical),
                horizontal,
            ];
            if padding
                .iter()
                .any(|v| !v.is_finite() || !(0. ..=1e5).contains(v))
            {
                return Err(layout_unsupported("stackPadding*", "out of range"));
            }
            let wrap = match enum_str(record, "stackWrap") {
                None | Some("NO_WRAP") => false,
                Some("WRAP") => true,
                Some(other) => return Err(layout_unsupported("stackWrap", other)),
            };
            let justify = match enum_str(record, "stackPrimaryAlignItems") {
                Some(v) => align_of_stack_justify(v)?,
                None => Align::Start,
            };
            let align = match enum_str(record, "stackCounterAlignItems") {
                Some(v) => align_of_stack_align(v)?,
                None => Align::Start,
            };
            node.layout = Some(Layout {
                mode,
                gap: distance(record, "stackSpacing")?,
                line_gap: distance(record, "stackCounterSpacing")?,
                padding,
                wrap,
                justify,
                align,
                ..Layout::default()
            });
            if bool_of(record, "stackReverseZIndex").unwrap_or(false) {
                // applied after tree assembly: children render (and stack)
                // in reverse order — converter/layout.py layers.reverse()
                node.bindings
                    .insert("figStackReverseZIndex".into(), "true".into());
            }
        }

        let mut sizing = Sizing::default();
        let mut has_sizing = has_layout;
        if has_layout {
            // Native frames commonly omit primary sizing; hug/fixed are the
            // fig2sketch defaults (TS :320-328)
            let primary = match enum_str(record, "stackPrimarySizing") {
                Some(v) => size_mode_of(v)?,
                None => SizeMode::Hug,
            };
            let counter = match enum_str(record, "stackCounterSizing") {
                Some(v) => size_mode_of(v)?,
                None => SizeMode::Fixed,
            };
            sizing.width = if mode == Flow::Horizontal {
                primary
            } else {
                counter
            };
            sizing.height = if mode == Flow::Horizontal {
                counter
            } else {
                primary
            };
        }
        let parent_mode = parent.and_then(|p| enum_str(p, "stackMode"));
        let parent_has_layout = matches!(parent_mode, Some("HORIZONTAL") | Some("VERTICAL"));
        if parent_has_layout && record.get("stackPositioning").is_some() {
            sizing.absolute = match enum_str(record, "stackPositioning") {
                Some("AUTO") => false,
                Some("ABSOLUTE") => true,
                Some(other) => return Err(layout_unsupported("stackPositioning", other)),
                None => false,
            };
            has_sizing = true;
        }
        // FIG retains stack fields when auto-layout is off or a child is
        // absolute; dormant values must not impose active rules (TS :338-359)
        if parent_has_layout && !sizing.absolute {
            let grow = record
                .get("stackChildPrimaryGrow")
                .and_then(Value::as_f64)
                .unwrap_or(0.);
            let self_align = match enum_str(record, "stackChildAlignSelf") {
                Some("MIN") => Some(Align::Start),
                Some("CENTER") => Some(Align::Center),
                Some("MAX") => Some(Align::End),
                Some("STRETCH") => Some(Align::Stretch),
                Some("AUTO") | None => None,
                Some(other) => return Err(layout_unsupported("stackChildAlignSelf", other)),
            };
            if grow != 0. && grow != 1. {
                return Err(layout_unsupported(
                    "stackChildPrimaryGrow",
                    &grow.to_string(),
                ));
            }
            if grow != 0. || self_align.is_some() {
                if parent_mode == Some("HORIZONTAL") {
                    if grow != 0. {
                        sizing.width = SizeMode::Fill;
                    }
                    if self_align == Some(Align::Stretch) {
                        sizing.height = SizeMode::Fill;
                    }
                } else {
                    if grow != 0. {
                        sizing.height = SizeMode::Fill;
                    }
                    if self_align == Some(Align::Stretch) {
                        sizing.width = SizeMode::Fill;
                    }
                }
                sizing.align_self = self_align;
                has_sizing = true;
            }
        }
        for (field, prefix) in [("minSize", "min"), ("maxSize", "max")] {
            let Some(value) = record.get(field).and_then(|m| m.get("value")) else {
                continue; // OptionalVector without a value = no bound
            };
            let x = f64_of(Some(value), "x");
            let y = f64_of(Some(value), "y");
            if ![x, y]
                .iter()
                .all(|v| v.is_finite() && (0.01..=1e7).contains(v))
            {
                return Err(layout_unsupported(field, &format!("{x},{y}")));
            }
            if prefix == "min" {
                sizing.min_width = x;
                sizing.min_height = y;
            } else {
                sizing.max_width = x;
                sizing.max_height = y;
            }
            has_sizing = true;
        }
        if sizing.min_width > sizing.max_width || sizing.min_height > sizing.max_height {
            return Err(layout_unsupported("minSize/maxSize", "inverted bounds"));
        }
        if has_sizing {
            node.sizing = Some(sizing);
        }

        if record.get("horizontalConstraint").is_some()
            || record.get("verticalConstraint").is_some()
        {
            let horizontal = match enum_str(record, "horizontalConstraint") {
                Some(v) => anchor_of_constraint(v)?,
                None => Anchor::Start,
            };
            let vertical = match enum_str(record, "verticalConstraint") {
                Some(v) => anchor_of_constraint(v)?,
                None => Anchor::Start,
            };
            let reference = parent
                .and_then(|p| p.get("size"))
                .map(|s| (f64_of(Some(s), "x"), f64_of(Some(s), "y")));
            let mut constraints = Constraints {
                horizontal,
                vertical,
                reference_width: None,
                reference_height: None,
            };
            if let Some((w, h)) = reference {
                if w.is_finite() && w > 0. {
                    constraints.reference_width = Some(w);
                }
                if h.is_finite() && h > 0. {
                    constraints.reference_height = Some(h);
                }
            }
            node.constraints = Some(constraints);
        }
        let _ = untranslated;
        Ok(())
    }
}

fn guid_string(guid: &Value) -> String {
    let session = f64_of(Some(guid), "sessionID");
    let local = f64_of(Some(guid), "localID");
    format!("fig-{session:.0}-{local:.0}")
}

/// Assemble a kernel [`Document`] from a decoded kiwi canvas tree.
pub fn document_from_canvas(
    tree: &Value,
    images: BTreeMap<String, Vec<u8>>,
    kiwi_blobs: Vec<Vec<u8>>,
) -> Result<Document, Error> {
    let mut doc = Document {
        reviews: Vec::new(),
        design_system: None,
        prototype: None,
        fd_compatibility: None,
        schema_version: 1,
        color_management: None,
        raster_profile: None,
        id: "imported-fig".into(),
        name: "Imported from Figma".into(),
        pages: Vec::new(),
        nodes: BTreeMap::new(),
        fonts: BTreeMap::new(),
        animations: Vec::new(),
    };
    let changes = tree
        .get("nodeChanges")
        .and_then(Value::as_array)
        .ok_or(Error::Malformed("nodeChanges missing".into()))?;
    let importer = FigImporter { images, kiwi_blobs };

    // Merge every phase by guid (TS :397-401): CREATED then UPDATED patches
    // the same record; REMOVED deletes it.
    let mut records: BTreeMap<String, Value> = BTreeMap::new();
    for change in changes {
        let Some(obj) = change.as_object() else {
            continue;
        };
        let id = guid_string(obj.get("guid").unwrap_or(&Value::Null));
        if str_of(change, "phase") == Some("REMOVED") {
            records.remove(&id);
            continue;
        }
        let entry = records
            .entry(id)
            .or_insert_with(|| Value::Object(Default::default()));
        if let Some(target) = entry.as_object_mut() {
            for (k, v) in obj {
                target.insert(k.clone(), v.clone());
            }
        }
    }

    // Classification pass: unknown node types are collected and rejected by
    // name — never silently coerced (ledger red line). Conditionally mapped
    // types (whiteboard shapes, tables) are validated against their payload
    // here so unsupported variants fail loudly with the offending value.
    let mut unknown: Vec<String> = Vec::new();
    for record in records.values() {
        if bool_of(record, "internalOnly").unwrap_or(false) {
            continue;
        }
        let Some(fig_type) = str_of(record, "type") else {
            continue;
        };
        if matches!(fig_type, "DOCUMENT" | "CANVAS") {
            continue;
        }
        let mut rejected: Option<String> = None;
        if kind_of(fig_type).is_none() {
            rejected = Some(fig_type.to_string());
        } else if fig_type == "SHAPE_WITH_TEXT"
            && !matches!(
                str_of(record, "shapeWithTextType"),
                Some("SQUARE")
                    | Some("ELLIPSE")
                    | Some("DIAMOND")
                    | Some("TRIANGLE_UP")
                    | Some("TRIANGLE_DOWN")
                    | Some("ROUNDED_RECTANGLE")
            )
        {
            rejected = Some(format!(
                "SHAPE_WITH_TEXT(shapeWithTextType={})",
                str_of(record, "shapeWithTextType").unwrap_or("?")
            ));
        } else if fig_type == "TABLE" {
            let count = |field: &str| -> usize {
                record
                    .get(field)
                    .and_then(|m| m.get("entries"))
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0)
            };
            let (rows, columns) = (count("tableRowHeights"), count("tableColumnWidths"));
            // kernel board table budget: 1..=50 rows × 1..=30 columns,
            // 600 cells max (scene.rs validate) — exceeding it cannot be
            // silently truncated, so it rejects by name.
            if rows == 0 || columns == 0 || rows > 50 || columns > 30 || rows * columns > 600 {
                rejected = Some(format!("TABLE({rows}x{columns} exceeds kernel budget)"));
            }
        }
        if let Some(name) = rejected
            && !unknown.contains(&name)
        {
            unknown.push(name);
        }
    }
    if !unknown.is_empty() {
        unknown.sort();
        return Err(Error::Unsupported(format!(
            "unsupported FIG node types (no silent fallback): {}",
            unknown.join(", ")
        )));
    }

    let mut nodes: BTreeMap<String, Node> = BTreeMap::new();
    let mut children_of: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    let mut canvases: Vec<(String, String)> = Vec::new();
    let mut untranslated_by_id: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for (id, record) in &records {
        if bool_of(record, "internalOnly").unwrap_or(false) {
            continue;
        }
        let fig_type = str_of(record, "type").unwrap_or("");
        if fig_type == "DOCUMENT" {
            continue;
        }
        let parent = record
            .get("parentIndex")
            .and_then(|pi| pi.get("guid"))
            .and_then(|g| records.get(&guid_string(g)));
        let mut untranslated = Vec::new();
        if fig_type == "CANVAS" {
            // canvases become Page entries; unlike the legacy path they are
            // NOT inserted into doc.nodes (kernel validate() requires every
            // node to be reachable from page.children, and the renderer walks
            // pages, so page nodes were dead weight)
            let position = record
                .get("parentIndex")
                .and_then(|pi| str_of(pi, "position"))
                .unwrap_or_default()
                .to_string();
            canvases.push((position, id.clone()));
        } else {
            let mut node = importer.node(record, &mut untranslated)?;
            importer.import_layout(&mut node, record, parent, &mut untranslated)?;
            nodes.insert(id.clone(), node);
            let parent_id = record
                .get("parentIndex")
                .and_then(|pi| pi.get("guid"))
                .map(guid_string)
                .unwrap_or_default();
            let position = record
                .get("parentIndex")
                .and_then(|pi| str_of(pi, "position"))
                .unwrap_or_default()
                .to_string();
            if parent_id.is_empty() {
                canvases.push((position, id.clone()));
            } else {
                children_of
                    .entry(parent_id)
                    .or_default()
                    .push((position, id.clone()));
            }
        }
        if !untranslated.is_empty() {
            untranslated_by_id.insert(id.clone(), untranslated);
        }
    }

    // sort siblings lexicographically by their fractional position string
    // (fig positions are strings; numeric comparison reorders punctuation
    // differently, TS :676-682)
    for kids in children_of.values_mut() {
        kids.sort_by(|a, b| a.0.cmp(&b.0));
    }
    canvases.sort_by(|a, b| a.0.cmp(&b.0));

    for (position, canvas_id) in &canvases {
        let record = records.get(canvas_id);
        let canvas_name = record
            .and_then(|r| str_of(r, "name"))
            .filter(|n| !n.is_empty())
            .map(String::from)
            .unwrap_or_else(|| format!("Page {}", position));
        let mut kids = attach_children(&mut nodes, &children_of, canvas_id);
        if !nodes.contains_key(canvas_id) {
            // a CANVAS record: children hang directly off the page
        } else {
            // a stray non-canvas root: keep the node itself as the page's
            // single child so it stays reachable
            kids = vec![canvas_id.clone()];
        }
        doc.pages.push(Page {
            guides: vec![],
            id: canvas_id.clone(),
            name: canvas_name,
            children: kids,
            background: record
                .and_then(|r| r.get("backgroundColor"))
                .map(hex_color)
                .unwrap_or_else(|| "#ffffff".into()),
        });
    }
    // stackReverseZIndex: reverse the authored child order after assembly
    for node in nodes.values_mut() {
        if node.bindings.contains_key("figStackReverseZIndex") {
            node.children.reverse();
        }
    }
    // keep dropped-but-reported semantics visible on the node itself
    for (id, notes) in untranslated_by_id {
        if let Some(node) = nodes.get_mut(&id) {
            node.bindings.insert(
                "figUntranslated".into(),
                serde_json::to_string(&notes).unwrap_or_default(),
            );
        }
    }
    doc.nodes = nodes;
    // honest serialization version: bindings/booleans/text styles need 4,
    // stroke markers 8, slices 10 (scene.rs validate gates)
    let mut version = 1u32;
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
    if crate::stroke::has_markers(&doc) {
        version = version.max(8);
    }
    if doc.nodes.values().any(|n| n.kind == "slice") {
        version = version.max(10);
    }
    // board content (stickies/code blocks/tables/whiteboard shapes) and
    // connectors are schema-10 facets (scene.rs validate gates)
    if doc
        .nodes
        .values()
        .any(|n| n.board.is_some() || n.connector.is_some())
    {
        version = version.max(10);
    }
    if doc.nodes.values().any(|n| n.text_style.as_ref().is_some_and(|s| s.text_case != crate::font::TextCase::Original)
        || n.text_runs.iter().any(|r| r.text_case.is_some())) { version=version.max(15); }
    if doc.nodes.values().any(|n| n.fills.iter().chain(n.strokes.iter().map(|s|&s.paint)).any(|p|p.adjust.is_some())) { version=version.max(13); }
    if doc.nodes.values().any(|n| n.fills.iter().chain(n.strokes.iter().map(|s|&s.paint)).any(|p|p.tile.is_some())) { version=version.max(14); }
    if doc.nodes.values().any(|n|n.vector_geometry.is_some()){version=version.max(16);}
    if doc.nodes.values().any(|n|n.network.as_ref().is_some_and(|g|g.filled_faces.is_some())){version=version.max(10);}
    doc.schema_version = version;
    Ok(doc)
}

fn attach_children(
    nodes: &mut BTreeMap<String, Node>,
    children_of: &BTreeMap<String, Vec<(String, String)>>,
    root: &str,
) -> Vec<String> {
    let mut ordered: Vec<String> = Vec::new();
    if let Some(kids) = children_of.get(root) {
        ordered = kids.iter().map(|(_, id)| id.clone()).collect();
    }
    for id in &ordered {
        attach_children(nodes, children_of, id);
    }
    if let Some(n) = nodes.get_mut(root) {
        n.children = ordered.clone();
    }
    ordered
}

/// Native `.fig` import into the kernel document model.
pub fn import_fig_native(bytes: &[u8]) -> Result<Document, Error> {
    let (tree, images, kiwi_blobs) = read_fig(bytes)?;
    document_from_canvas(&tree, images, kiwi_blobs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_kiwi_primitives() {
        let mut r = Reader {
            b: &[0xAC, 0x02],
            p: 0,
        };
        assert_eq!(r.uint().unwrap(), 300);
    }

    #[test]
    fn rejects_bad_magic() {
        assert!(matches!(
            decode_canvas(b"not-kiwi-at-all!!"),
            Err(Error::NotAFig(_))
        ));
    }

    // -----------------------------------------------------------------
    // test kiwi writer — mirrors the reader so fixtures round-trip through
    // the exact wire format (including the rotated varfloat)
    // -----------------------------------------------------------------
    mod kiwi_write {
        use super::*;

        pub struct W(pub Vec<u8>);
        impl W {
            pub fn byte(&mut self, b: u8) {
                self.0.push(b);
            }
            pub fn uint(&mut self, mut v: u64) {
                loop {
                    let b = (v & 0x7f) as u8;
                    v >>= 7;
                    if v == 0 {
                        self.byte(b);
                        return;
                    }
                    self.byte(b | 0x80);
                }
            }
            pub fn int(&mut self, v: i64) {
                self.uint(((v << 1) ^ (v >> 63)) as u64);
            }
            pub fn float(&mut self, v: f64) {
                let bits = (v as f32).to_bits();
                if bits == 0 {
                    self.byte(0);
                    return;
                }
                let rotated = bits.rotate_left(9);
                if rotated & 0xff == 0 {
                    // kiwi's lossy escape: a zero low byte decodes back as 0.0
                    self.byte(0);
                    return;
                }
                self.byte((rotated & 0xff) as u8);
                self.byte(((rotated >> 8) & 0xff) as u8);
                self.byte(((rotated >> 16) & 0xff) as u8);
                self.byte(((rotated >> 24) & 0xff) as u8);
            }
            pub fn string(&mut self, s: &str) {
                self.0.extend_from_slice(s.as_bytes());
                self.byte(0);
            }
        }

        /// minimal fig schema description: (name, kind, fields[(name, type,
        /// array, ordinal)]); builtin ids -1..-8 as in the reader
        pub type Schema = Vec<(&'static str, u8, Vec<(&'static str, i64, bool, u64)>)>;

        fn write_schema(schema: &Schema) -> Vec<u8> {
            let mut w = W(Vec::new());
            w.uint(schema.len() as u64);
            for (name, kind, fields) in schema {
                w.string(name);
                w.byte(*kind);
                w.uint(fields.len() as u64);
                for (fname, ty, arr, ord) in fields {
                    w.string(fname);
                    w.int(*ty);
                    w.byte(u8::from(*arr));
                    w.uint(*ord);
                }
            }
            w.0
        }

        fn field(schema: &Schema, type_id: i64, name: &str) -> (i64, bool, u64) {
            let (.., fields) = &schema[type_id as usize];
            let f = fields
                .iter()
                .find(|f| f.0 == name)
                .expect("field in test schema");
            (f.1, f.2, f.3)
        }

        fn write_value(w: &mut W, schema: &Schema, type_id: i64, array: bool, v: &Value) {
            if array {
                let items = v.as_array().expect("array value");
                w.uint(items.len() as u64);
                for item in items {
                    write_value(w, schema, type_id, false, item);
                }
                return;
            }
            if type_id < 0 {
                match -type_id {
                    1 => w.byte(v.as_bool().unwrap_or(false) as u8),
                    2 => w.byte(v.as_u64().unwrap_or(0) as u8),
                    3 => w.int(v.as_i64().unwrap_or(0)),
                    4 => w.uint(v.as_u64().unwrap_or(0)),
                    5 => w.float(v.as_f64().unwrap_or(0.)),
                    6 => w.string(v.as_str().unwrap_or("")),
                    7 => w.int(v.as_i64().unwrap_or(0)),
                    8 => w.uint(v.as_u64().unwrap_or(0)),
                    _ => panic!("bad builtin"),
                }
                return;
            }
            let (tname, kind, fields) = &schema[type_id as usize];
            let _ = tname;
            match kind {
                0 => {
                    // enum: value name → ordinal
                    let name = v.as_str().unwrap_or("");
                    let ord = fields
                        .iter()
                        .find(|f| f.0 == name)
                        .map(|f| f.3)
                        .unwrap_or_else(|| panic!("enum member {name}"));
                    w.uint(ord);
                }
                1 => {
                    // struct: every field in ordinal order (test data must
                    // carry them all; helper `full` fills the gaps)
                    let mut ordered: Vec<&(&str, i64, bool, u64)> = fields.iter().collect();
                    ordered.sort_by_key(|f| f.3);
                    for f in ordered {
                        let value = v.get(f.0).cloned().unwrap_or(match -f.1 {
                            1 => Value::Bool(false),
                            2 | 3 | 4 | 7 | 8 => Value::from(0),
                            5 => Value::from(0.),
                            _ => Value::from(""),
                        });
                        write_value(w, schema, f.1, f.2, &value);
                    }
                }
                _ => {
                    // message: present fields by ordinal, then 0
                    let mut present: Vec<&(&str, i64, bool, u64)> =
                        fields.iter().filter(|f| v.get(f.0).is_some()).collect();
                    present.sort_by_key(|f| f.3);
                    for f in present {
                        w.uint(f.3);
                        write_value(w, schema, f.1, f.2, v.get(f.0).unwrap());
                    }
                    w.uint(0);
                }
            }
        }

        pub fn canvas_with(schema: &Schema, root: &Value) -> Vec<u8> {
            let mut out = Vec::new();
            out.extend_from_slice(b"fig-kiwi");
            out.extend_from_slice(&48u32.to_le_bytes());
            let schema_bytes = write_schema(schema);
            let deflated = miniz_oxide::deflate::compress_to_vec(&schema_bytes, 5);
            out.extend_from_slice(&(deflated.len() as u32).to_le_bytes());
            out.extend_from_slice(&deflated);
            // the data segment is the root Message: nodeChanges by ordinal, 0
            let mut w = W(Vec::new());
            let message_id = schema.len() as i64 - 1;
            let (id, arr, ord) = field(schema, message_id, "nodeChanges");
            assert!(arr, "nodeChanges is an array field");
            w.uint(ord);
            write_value(&mut w, schema, id, true, root.get("nodeChanges").unwrap());
            w.uint(0);
            let deflated = miniz_oxide::deflate::compress_to_vec(&w.0, 5);
            out.extend_from_slice(&(deflated.len() as u32).to_le_bytes());
            out.extend_from_slice(&deflated);
            out
        }

        /// NodeChange field tuples used by the test schema, (name, type,
        /// array, ordinal); ids refer into `test_schema`.
        pub fn nc(
            name: &'static str,
            ty: i64,
            arr: bool,
            ord: u64,
        ) -> (&'static str, i64, bool, u64) {
            (name, ty, arr, ord)
        }

        /// The root Message must be the LAST type in the schema (the reader
        /// locates it by name; index-independence asserted by decode).
        pub fn test_schema(nc_fields: Vec<(&'static str, i64, bool, u64)>) -> Schema {
            vec![
                (
                    "Phase",
                    0,
                    vec![
                        ("CREATED", 0, false, 0),
                        ("REMOVED", 0, false, 1),
                        ("UPDATED", 0, false, 2),
                    ],
                ), // 0
                (
                    "NodeType",
                    0,
                    vec![
                        ("DOCUMENT", 0, false, 0),
                        ("CANVAS", 0, false, 1),
                        ("FRAME", 0, false, 2),
                        ("GROUP", 0, false, 3),
                        ("VECTOR", 0, false, 4),
                        ("ELLIPSE", 0, false, 5),
                        ("RECTANGLE", 0, false, 6),
                        ("ROUNDED_RECTANGLE", 0, false, 7),
                        ("REGULAR_POLYGON", 0, false, 8),
                        ("STAR", 0, false, 9),
                        ("TEXT", 0, false, 10),
                        ("SLICE", 0, false, 11),
                        ("SYMBOL", 0, false, 12),
                        ("INSTANCE", 0, false, 13),
                        ("BOOLEAN_OPERATION", 0, false, 14),
                        ("STICKY", 0, false, 15),
                        ("SECTION", 0, false, 16),
                        ("WIDGET", 0, false, 17),
                        ("CODE_BLOCK", 0, false, 18),
                        ("CONNECTOR", 0, false, 19),
                        ("TABLE", 0, false, 20),
                        ("TABLE_CELL", 0, false, 21),
                        ("SHAPE_WITH_TEXT", 0, false, 22),
                        ("STAMP", 0, false, 23),
                    ],
                ), // 1
                (
                    "GUID",
                    1,
                    vec![("sessionID", -4, false, 0), ("localID", -4, false, 1)],
                ), // 2
                ("Vector", 1, vec![("x", -5, false, 0), ("y", -5, false, 1)]), // 3
                (
                    "Color",
                    1,
                    vec![
                        ("r", -5, false, 0),
                        ("g", -5, false, 1),
                        ("b", -5, false, 2),
                        ("a", -5, false, 3),
                    ],
                ), // 4
                (
                    "Matrix",
                    1,
                    vec![
                        ("m00", -5, false, 0),
                        ("m01", -5, false, 1),
                        ("m02", -5, false, 2),
                        ("m10", -5, false, 3),
                        ("m11", -5, false, 4),
                        ("m12", -5, false, 5),
                    ],
                ), // 5
                (
                    "Paint",
                    2,
                    vec![
                        ("type", 7, false, 1),
                        ("color", 4, false, 2),
                        ("opacity", -5, false, 3),
                        ("visible", -1, false, 4),
                        ("blendMode", 8, false, 5),
                        ("transform", 5, false, 6),
                        ("image", 51, false, 7),
                        ("imageScaleMode", 52, false, 8),
                    ],
                ), // 6
                (
                    "PaintType",
                    0,
                    vec![
                        ("SOLID", 0, false, 0),
                        ("GRADIENT_LINEAR", 0, false, 1),
                        ("IMAGE", 0, false, 2),
                        ("EMOJI", 0, false, 3),
                    ],
                ), // 7
                (
                    "BlendMode",
                    0,
                    vec![("NORMAL", 0, false, 0), ("MULTIPLY", 0, false, 1)],
                ), // 8
                (
                    "Effect",
                    2,
                    vec![
                        ("type", 10, false, 1),
                        ("color", 4, false, 2),
                        ("offset", 3, false, 3),
                        ("radius", -5, false, 4),
                        ("visible", -1, false, 5),
                        ("spread", -5, false, 6),
                        ("blendMode", 8, false, 7),
                        ("showShadowBehindNode", -1, false, 8),
                    ],
                ), // 9
                (
                    "EffectType",
                    0,
                    vec![
                        ("DROP_SHADOW", 0, false, 0),
                        ("INNER_SHADOW", 0, false, 1),
                        ("FOREGROUND_BLUR", 0, false, 2),
                        ("BACKGROUND_BLUR", 0, false, 3),
                    ],
                ), // 10
                (
                    "StrokeCap",
                    0,
                    vec![
                        ("NONE", 0, false, 0),
                        ("ROUND", 0, false, 1),
                        ("SQUARE", 0, false, 2),
                        ("ARROW_LINES", 0, false, 3),
                        ("WASHI_TAPE_1", 0, false, 8),
                    ],
                ), // 11
                (
                    "StrokeJoin",
                    0,
                    vec![
                        ("MITER", 0, false, 0),
                        ("BEVEL", 0, false, 1),
                        ("ROUND", 0, false, 2),
                    ],
                ), // 12
                (
                    "TextDecoration",
                    0,
                    vec![
                        ("NONE", 0, false, 0),
                        ("UNDERLINE", 0, false, 1),
                        ("STRIKETHROUGH", 0, false, 2),
                    ],
                ), // 13
                (
                    "TextCase",
                    0,
                    vec![
                        ("ORIGINAL", 0, false, 0),
                        ("UPPER", 0, false, 1),
                        ("LOWER", 0, false, 2),
                    ],
                ), // 14
                (
                    "TextAlignHorizontal",
                    0,
                    vec![
                        ("LEFT", 0, false, 0),
                        ("CENTER", 0, false, 1),
                        ("RIGHT", 0, false, 2),
                        ("JUSTIFIED", 0, false, 3),
                    ],
                ), // 15
                (
                    "NumberUnits",
                    0,
                    vec![
                        ("RAW", 0, false, 0),
                        ("PIXELS", 0, false, 1),
                        ("PERCENT", 0, false, 2),
                    ],
                ), // 16
                (
                    "Number",
                    1,
                    vec![("value", -5, false, 0), ("units", 16, false, 1)],
                ), // 17
                (
                    "FontName",
                    1,
                    vec![
                        ("family", -6, false, 0),
                        ("style", -6, false, 1),
                        ("postscript", -6, false, 2),
                    ],
                ), // 18
                (
                    "TextData",
                    2,
                    vec![
                        ("characters", -6, false, 1),
                        ("characterStyleIDs", -4, true, 2),
                        ("styleOverrideTable", 20, true, 3),
                    ],
                ), // 19
                // 20: NodeChange (partial, test subset) — augmented by caller
                ("NodeChange", 2, {
                    let mut fields = vec![
                        nc("guid", 2, false, 1),
                        nc("phase", 0, false, 2),
                        nc("parentIndex", 21, false, 3),
                        nc("type", 1, false, 4),
                        nc("name", -6, false, 5),
                        nc("visible", -1, false, 6),
                        nc("opacity", -5, false, 7),
                        nc("size", 3, false, 8),
                        nc("transform", 5, false, 9),
                        nc("fillPaints", 6, true, 10),
                        nc("strokePaints", 6, true, 11),
                        nc("effects", 9, true, 12),
                        nc("mask", -1, false, 13),
                        nc("internalOnly", -1, false, 14),
                        nc("cornerRadius", -5, false, 15),
                        nc("rectangleTopLeftCornerRadius", -5, false, 16),
                        nc("rectangleTopRightCornerRadius", -5, false, 17),
                        nc("rectangleBottomRightCornerRadius", -5, false, 18),
                        nc("rectangleBottomLeftCornerRadius", -5, false, 19),
                        nc("cornerSmoothing", -5, false, 20),
                        nc("strokeWeight", -5, false, 21),
                        nc("strokeAlign", 22, false, 22),
                        nc("strokeCap", 11, false, 23),
                        nc("strokeJoin", 12, false, 24),
                        nc("dashPattern", -5, true, 25),
                        nc("borderStrokeWeightsIndependent", -1, false, 26),
                        nc("borderTopWeight", -5, false, 27),
                        nc("borderRightWeight", -5, false, 28),
                        nc("borderBottomWeight", -5, false, 29),
                        nc("borderLeftWeight", -5, false, 30),
                        nc("textData", 19, false, 31),
                        nc("fontSize", -5, false, 32),
                        nc("fontName", 18, false, 33),
                        nc("lineHeight", 17, false, 34),
                        nc("letterSpacing", 17, false, 35),
                        nc("textCase", 14, false, 36),
                        nc("textAlignHorizontal", 15, false, 37),
                        nc("textAlignVertical", 23, false, 38),
                        nc("textDecoration", 13, false, 39),
                        nc("paragraphSpacing", -5, false, 40),
                        nc("paragraphIndent", -5, false, 41),
                        nc("count", -4, false, 42),
                        nc("starInnerScale", -5, false, 43),
                        nc("booleanOperation", 24, false, 44),
                        nc("symbolData", 25, false, 45),
                        nc("maskType", 26, false, 46),
                        nc("frameMaskDisabled", -1, false, 47),
                        nc("backgroundColor", 4, false, 48),
                        nc("prototypeInteractions", 27, true, 49),
                        nc("styleID", -4, false, 50),
                        nc("overrideKey", 2, false, 51),
                        nc("guidPath", 28, false, 52),
                        nc("fillPaintsText", 6, true, 53),
                        // layout / constraints
                        nc("stackMode", 29, false, 60),
                        nc("stackSpacing", -5, false, 61),
                        nc("stackCounterSpacing", -5, false, 62),
                        nc("stackHorizontalPadding", -5, false, 63),
                        nc("stackVerticalPadding", -5, false, 64),
                        nc("stackPaddingRight", -5, false, 65),
                        nc("stackPaddingBottom", -5, false, 66),
                        nc("stackPadding", -5, false, 67),
                        nc("stackWrap", 30, false, 68),
                        nc("stackPrimaryAlignItems", 31, false, 69),
                        nc("stackCounterAlignItems", 32, false, 70),
                        nc("stackPrimarySizing", 33, false, 71),
                        nc("stackCounterSizing", 33, false, 72),
                        nc("stackPositioning", 34, false, 73),
                        nc("stackChildPrimaryGrow", -5, false, 74),
                        nc("stackChildAlignSelf", 43, false, 75),
                        nc("stackReverseZIndex", -1, false, 76),
                        nc("stackCounterAlign", 43, false, 77),
                        nc("stackJustify", 31, false, 78),
                        nc("stackAlign", 32, false, 79),
                        nc("stackWidth", 33, false, 80),
                        nc("stackHeight", 33, false, 81),
                        nc("stackCounterAlignContent", 35, false, 82),
                        nc("minSize", 36, false, 83),
                        nc("maxSize", 36, false, 84),
                        nc("horizontalConstraint", 37, false, 85),
                        nc("verticalConstraint", 37, false, 86),
                        // whiteboard / connector / table / component payloads
                        nc("shapeWithTextType", 44, false, 90),
                        nc("codeBlockLanguage", 45, false, 91),
                        nc("connectorStart", 46, false, 92),
                        nc("connectorEnd", 46, false, 93),
                        nc("connectorLineStyle", 48, false, 94),
                        nc("tableRowHeights", 50, false, 95),
                        nc("tableColumnWidths", 50, false, 96),
                        nc("componentKey", -6, false, 97),
                        nc("componentPropDefs", 55, true, 98),
                        nc("componentPropAssignments", 56, true, 99),
                        nc("toggledOnOTFeatures", 57, true, 100),
                        nc("toggledOffOTFeatures", 57, true, 101),
                        nc("fontVariations", 58, true, 102),
                    ];
                    fields.extend(nc_fields);
                    fields
                }),
                (
                    "ParentIndex",
                    1,
                    vec![("guid", 2, false, 0), ("position", -6, false, 1)],
                ), // 21
                (
                    "StrokeAlign",
                    0,
                    vec![
                        ("CENTER", 0, false, 0),
                        ("INSIDE", 0, false, 1),
                        ("OUTSIDE", 0, false, 2),
                    ],
                ), // 22
                (
                    "TextAlignVertical",
                    0,
                    vec![
                        ("TOP", 0, false, 0),
                        ("CENTER", 0, false, 1),
                        ("BOTTOM", 0, false, 2),
                    ],
                ), // 23
                (
                    "BooleanOperation",
                    0,
                    vec![
                        ("UNION", 0, false, 0),
                        ("INTERSECT", 0, false, 1),
                        ("SUBTRACT", 0, false, 2),
                        ("XOR", 0, false, 3),
                    ],
                ), // 24
                (
                    "SymbolData",
                    2,
                    vec![("symbolID", 2, false, 1), ("symbolOverrides", 20, true, 2)],
                ), // 25
                (
                    "MaskType",
                    0,
                    vec![
                        ("ALPHA", 0, false, 0),
                        ("OUTLINE", 0, false, 1),
                        ("LUMINANCE", 0, false, 2),
                    ],
                ), // 26
                (
                    "PrototypeInteraction",
                    2,
                    vec![
                        ("event", 38, false, 1),
                        ("actions", 39, true, 2),
                        ("isDeleted", -1, false, 3),
                    ],
                ), // 27
                ("GUIDPath", 2, vec![("guids", 2, true, 1)]), // 28
                (
                    "StackMode",
                    0,
                    vec![
                        ("NONE", 0, false, 0),
                        ("HORIZONTAL", 0, false, 1),
                        ("VERTICAL", 0, false, 2),
                        ("GRID", 0, false, 3),
                    ],
                ), // 29
                (
                    "StackWrap",
                    0,
                    vec![("NO_WRAP", 0, false, 0), ("WRAP", 0, false, 1)],
                ), // 30
                (
                    "StackJustify",
                    0,
                    vec![
                        ("MIN", 0, false, 0),
                        ("CENTER", 0, false, 1),
                        ("MAX", 0, false, 2),
                        ("SPACE_BETWEEN", 0, false, 3),
                        ("SPACE_EVENLY", 0, false, 4),
                    ],
                ), // 31
                (
                    "StackAlign",
                    0,
                    vec![
                        ("MIN", 0, false, 0),
                        ("CENTER", 0, false, 1),
                        ("MAX", 0, false, 2),
                        ("BASELINE", 0, false, 3),
                    ],
                ), // 32
                (
                    "StackSize",
                    0,
                    vec![
                        ("FIXED", 0, false, 0),
                        ("RESIZE_TO_FIT", 0, false, 1),
                        ("RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", 0, false, 2),
                    ],
                ), // 33
                (
                    "StackPositioning",
                    0,
                    vec![("AUTO", 0, false, 0), ("ABSOLUTE", 0, false, 1)],
                ), // 34
                (
                    "StackCounterAlignContent",
                    0,
                    vec![("AUTO", 0, false, 0), ("SPACE_BETWEEN", 0, false, 1)],
                ), // 35
                ("OptionalVector", 2, vec![("value", 3, false, 1)]), // 36
                (
                    "ConstraintType",
                    0,
                    vec![
                        ("MIN", 0, false, 0),
                        ("CENTER", 0, false, 1),
                        ("MAX", 0, false, 2),
                        ("STRETCH", 0, false, 3),
                        ("SCALE", 0, false, 4),
                        ("FIXED_MIN", 0, false, 5),
                    ],
                ), // 37
                ("PrototypeEvent", 2, vec![("interactionType", 40, false, 1)]), // 38
                (
                    "PrototypeAction",
                    2,
                    vec![
                        ("transitionNodeID", 2, false, 1),
                        ("transitionType", 41, false, 2),
                        ("transitionDuration", -5, false, 3),
                        ("navigationType", 42, false, 4),
                    ],
                ), // 39
                (
                    "InteractionType",
                    0,
                    vec![("ON_CLICK", 0, false, 0), ("MOUSE_ENTER", 0, false, 1)],
                ), // 40
                (
                    "TransitionType",
                    0,
                    vec![
                        ("INSTANT_TRANSITION", 0, false, 0),
                        ("DISSOLVE", 0, false, 1),
                    ],
                ), // 41
                (
                    "NavigationType",
                    0,
                    vec![("NAVIGATE", 0, false, 0), ("OVERLAY", 0, false, 1)],
                ), // 42
                (
                    "StackCounterAlign",
                    0,
                    vec![
                        ("MIN", 0, false, 0),
                        ("CENTER", 0, false, 1),
                        ("MAX", 0, false, 2),
                        ("STRETCH", 0, false, 3),
                        ("AUTO", 0, false, 4),
                        ("BASELINE", 0, false, 5),
                    ],
                ), // 43
                (
                    "ShapeWithTextType",
                    0,
                    vec![
                        ("SQUARE", 0, false, 0),
                        ("ELLIPSE", 0, false, 1),
                        ("DIAMOND", 0, false, 2),
                        ("TRIANGLE_UP", 0, false, 3),
                        ("TRIANGLE_DOWN", 0, false, 4),
                        ("ROUNDED_RECTANGLE", 0, false, 5),
                        ("PARALLELOGRAM_RIGHT", 0, false, 6),
                    ],
                ), // 45
                (
                    "CodeBlockLanguage",
                    0,
                    vec![
                        ("JAVASCRIPT", 0, false, 0),
                        ("TYPESCRIPT", 0, false, 1),
                        ("JSON", 0, false, 2),
                        ("PYTHON", 0, false, 3),
                        ("CPP", 0, false, 4),
                    ],
                ), // 46
                (
                    "ConnectorEndpoint",
                    2,
                    vec![
                        ("endpointNodeID", 2, false, 1),
                        ("position", 3, false, 2),
                        ("magnet", 47, false, 3),
                    ],
                ), // 46
                (
                    "ConnectorMagnet",
                    0,
                    vec![
                        ("NONE", 0, false, 0),
                        ("AUTO", 0, false, 1),
                        ("TOP", 0, false, 2),
                        ("RIGHT", 0, false, 3),
                    ],
                ), // 47
                (
                    "ConnectorLineStyle",
                    0,
                    vec![
                        ("ELBOWED", 0, false, 0),
                        ("STRAIGHT", 0, false, 1),
                        ("CURVED", 0, false, 2),
                    ],
                ), // 48
                (
                    "TableRowColumnSizeMapEntry",
                    1,
                    vec![("id", 2, false, 0), ("size", -5, false, 1)],
                ), // 49
                ("TableRowColumnSizeMap", 2, vec![("entries", 49, true, 1)]), // 50
                ("ImageRef", 2, vec![("dataRef", -6, false, 1)]), // 51
                (
                    "ScaleMode",
                    0,
                    vec![
                        ("FILL", 0, false, 0),
                        ("FIT", 0, false, 1),
                        ("TILE", 0, false, 2),
                        ("CROP", 0, false, 3),
                    ],
                ), // 52
                (
                    "ComponentPropType",
                    0,
                    vec![
                        ("BOOL", 0, false, 0),
                        ("TEXT", 0, false, 1),
                        ("COLOR", 0, false, 2),
                        ("INSTANCE_SWAP", 0, false, 3),
                    ],
                ), // 53
                (
                    "ComponentPropValue",
                    2,
                    vec![("boolValue", -1, false, 1), ("textValue", 19, false, 2)],
                ), // 54
                (
                    "ComponentPropDef",
                    2,
                    vec![
                        ("id", 2, false, 1),
                        ("name", -6, false, 2),
                        ("type", 53, false, 3),
                        ("initialValue", 54, false, 4),
                        ("isDeleted", -1, false, 5),
                    ],
                ), // 55
                (
                    "ComponentPropAssignment",
                    2,
                    vec![("defID", 2, false, 1), ("value", 54, false, 2)],
                ), // 56
                (
                    "OpenTypeFeature",
                    0,
                    vec![
                        ("LIGA", 0, false, 0),
                        ("CALT", 0, false, 1),
                        ("DLIG", 0, false, 2),
                    ],
                ), // 57
                (
                    "FontVariation",
                    1,
                    vec![
                        ("axisTag", -4, false, 0),
                        ("axisName", -6, false, 1),
                        ("value", -5, false, 2),
                    ],
                ), // 58
                ("Message", 2, vec![("nodeChanges", 20, true, 1)]), // 44
            ]
        }

        pub fn import_canvas(bytes: &[u8]) -> Result<Document, Error> {
            let tree = decode_canvas(bytes)?;
            document_from_canvas(&tree, BTreeMap::new(), Vec::new())
        }
    }

    mod conversion_tests {
        use super::kiwi_write::{canvas_with, import_canvas, test_schema};
        use super::*;
        use serde_json::json;

        fn guid(s: u64, l: u64) -> Value {
            json!({"sessionID": s, "localID": l})
        }

        fn base_change(fig_type: &str, session: u64, local: u64) -> Value {
            json!({
                "guid": guid(session, local),
                "phase": "CREATED",
                "type": fig_type,
                "name": format!("{fig_type}-{local}"),
                "parentIndex": {"guid": guid(0, 1), "position": "!"},
            })
        }

        fn doc_with(changes: Vec<Value>) -> Result<Document, Error> {
            let schema = test_schema(Vec::new());
            let canvas = canvas_with(&schema, &json!({"nodeChanges": changes}));
            import_canvas(&canvas)
        }

        fn canvas_only() -> Vec<Value> {
            vec![json!({
                "guid": guid(0, 1),
                "phase": "CREATED",
                "type": "CANVAS",
                "name": "Page 1",
                "parentIndex": {"guid": guid(0, 0), "position": ""},
            })]
        }

        fn node_of(doc: &Document, session: u64, local: u64) -> &Node {
            doc.nodes
                .get(&format!("fig-{session}-{local}"))
                .unwrap_or_else(|| panic!("node fig-{session}-{local} present"))
        }

        // ---------------- float wire format ----------------

        #[test]
        fn varfloat_decodes_with_kiwi_rotation() {
            // 3.0: f32 bits 0x40400000; kiwi writeVarFloat rotates left by 9
            // → 0x80000080 → wire bytes 80 00 00 80 (verified against
            // kiwi-schema's ByteBuffer.writeVarFloat/readVarFloat pair)
            let mut r = Reader {
                b: &[0x80, 0x00, 0x00, 0x80],
                p: 0,
            };
            assert_eq!(r.float().unwrap(), 3.0);
        }

        #[test]
        fn varfloat_zero_is_single_byte() {
            let mut r = Reader {
                b: &[0x00, 0x81],
                p: 0,
            };
            assert_eq!(r.float().unwrap(), 0.0);
        }

        #[test]
        fn real_world_color_value_decodes() {
            // 0.8509804010391235 as f32 (a real fill from the native fixture)
            let mut w = kiwi_write::W(Vec::new());
            w.float(0.8509804010391235);
            let mut r = Reader { b: &w.0, p: 0 };
            assert!((r.float().unwrap() - 0.8509804).abs() < 1e-6);
        }

        // ---------------- unknown node types ----------------

        #[test]
        fn unknown_node_type_is_rejected_by_name() {
            let mut changes = canvas_only();
            changes.push(base_change("WIDGET", 1, 10));
            let err = doc_with(changes).unwrap_err();
            match &err {
                Error::Unsupported(msg) => assert!(
                    msg.contains("WIDGET"),
                    "error must name the unknown type: {msg}"
                ),
                other => panic!("expected Unsupported, got {other:?}"),
            }
        }

        #[test]
        fn known_types_map_explicitly_and_documents_are_skipped() {
            let mut changes = vec![json!({
                "guid": guid(0, 0), "phase": "CREATED", "type": "DOCUMENT",
            })];
            changes.extend(canvas_only());
            for (i, t) in ["FRAME", "VECTOR", "TEXT", "SLICE", "SECTION"]
                .iter()
                .enumerate()
            {
                let mut c = base_change(t, 1, 10 + i as u64);
                c["parentIndex"] = json!({"guid": guid(0, 1), "position": "!"});
                changes.push(c);
            }
            let doc = doc_with(changes).unwrap();
            assert_eq!(node_of(&doc, 1, 10).kind, "frame");
            assert_eq!(node_of(&doc, 1, 11).kind, "path");
            assert_eq!(node_of(&doc, 1, 12).kind, "text");
            assert_eq!(node_of(&doc, 1, 13).kind, "slice");
            assert_eq!(node_of(&doc, 1, 14).kind, "section");
            assert!(!doc.nodes.contains_key("fig-0-0"), "DOCUMENT is not a node");
        }

        #[test]
        fn internal_only_records_are_skipped() {
            let mut changes = canvas_only();
            let mut c = base_change("WIDGET", 1, 9);
            c["internalOnly"] = json!(true);
            changes.push(c);
            assert!(doc_with(changes).is_ok());
        }

        // ---------------- autolayout ----------------

        #[test]
        fn vertical_stack_maps_layout_sizing_and_bounds() {
            let mut changes = canvas_only();
            let mut frame = base_change("FRAME", 1, 2);
            frame["size"] = json!({"x": 300, "y": 200});
            frame["stackMode"] = json!("VERTICAL");
            frame["stackSpacing"] = json!(10);
            frame["stackCounterSpacing"] = json!(6);
            frame["stackHorizontalPadding"] = json!(5);
            frame["stackVerticalPadding"] = json!(7);
            frame["stackPaddingRight"] = json!(9);
            frame["stackPaddingBottom"] = json!(11);
            frame["stackWrap"] = json!("WRAP");
            frame["stackPrimaryAlignItems"] = json!("SPACE_BETWEEN");
            frame["stackCounterAlignItems"] = json!("CENTER");
            frame["stackPrimarySizing"] = json!("RESIZE_TO_FIT");
            frame["stackCounterSizing"] = json!("FIXED");
            frame["minSize"] = json!({"value": {"x": 100, "y": 50}});
            frame["maxSize"] = json!({"value": {"x": 800, "y": 600}});
            changes.push(frame);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            let layout = n.layout.as_ref().expect("layout");
            assert_eq!(layout.mode, Flow::Vertical);
            assert!((layout.gap - 10.).abs() < 1e-9);
            assert!((layout.line_gap - 6.).abs() < 1e-9);
            // padding = [top, right, bottom, left]
            assert_eq!(layout.padding, [7., 9., 11., 5.]);
            assert!(layout.wrap);
            assert_eq!(layout.justify, Align::SpaceBetween);
            assert_eq!(layout.align, Align::Center);
            let sizing = n.sizing.as_ref().expect("sizing");
            // vertical stack: width = counter (fixed), height = primary (hug)
            assert_eq!(sizing.width, SizeMode::Fixed);
            assert_eq!(sizing.height, SizeMode::Hug);
            assert!((sizing.min_width - 100.).abs() < 1e-9);
            assert!((sizing.min_height - 50.).abs() < 1e-9);
            assert!((sizing.max_width - 800.).abs() < 1e-9);
            assert!((sizing.max_height - 600.).abs() < 1e-9);
        }

        #[test]
        fn horizontal_stack_primary_axis_is_width() {
            let mut changes = canvas_only();
            let mut frame = base_change("FRAME", 1, 2);
            frame["stackMode"] = json!("HORIZONTAL");
            frame["stackPrimarySizing"] = json!("FIXED");
            frame["stackCounterSizing"] = json!("RESIZE_TO_FIT");
            changes.push(frame);
            let doc = doc_with(changes).unwrap();
            let sizing = node_of(&doc, 1, 2).sizing.as_ref().unwrap();
            assert_eq!(sizing.width, SizeMode::Fixed);
            assert_eq!(sizing.height, SizeMode::Hug);
        }

        #[test]
        fn legacy_non_neutral_stack_fields_reject() {
            let mut changes = canvas_only();
            let mut frame = base_change("FRAME", 1, 2);
            frame["stackMode"] = json!("VERTICAL");
            frame["stackPadding"] = json!(5);
            changes.push(frame);
            let err = doc_with(changes).unwrap_err();
            assert!(matches!(err, Error::Unsupported(_)), "{err:?}");
        }

        #[test]
        fn grid_stack_mode_rejects_explicitly() {
            let mut changes = canvas_only();
            let mut frame = base_change("FRAME", 1, 2);
            frame["stackMode"] = json!("GRID");
            changes.push(frame);
            let err = doc_with(changes).unwrap_err();
            match err {
                Error::Unsupported(msg) => assert!(msg.contains("GRID"), "{msg}"),
                other => panic!("{other:?}"),
            }
        }

        #[test]
        fn baseline_counter_align_rejects_explicitly() {
            let mut changes = canvas_only();
            let mut frame = base_change("FRAME", 1, 2);
            frame["stackMode"] = json!("HORIZONTAL");
            frame["stackCounterAlignItems"] = json!("BASELINE");
            changes.push(frame);
            let err = doc_with(changes).unwrap_err();
            match err {
                Error::Unsupported(msg) => assert!(msg.contains("BASELINE"), "{msg}"),
                other => panic!("{other:?}"),
            }
        }

        #[test]
        fn inverted_min_max_bounds_reject() {
            let mut changes = canvas_only();
            let mut frame = base_change("FRAME", 1, 2);
            frame["stackMode"] = json!("VERTICAL");
            frame["minSize"] = json!({"value": {"x": 500, "y": 500}});
            frame["maxSize"] = json!({"value": {"x": 100, "y": 100}});
            changes.push(frame);
            assert!(matches!(doc_with(changes), Err(Error::Unsupported(_))));
        }

        #[test]
        fn child_grow_and_absolute_positioning_map_to_sizing() {
            let mut changes = canvas_only();
            let mut frame = base_change("FRAME", 1, 2);
            frame["size"] = json!({"x": 300, "y": 200});
            frame["stackMode"] = json!("VERTICAL");
            let mut child = base_change("RECTANGLE", 1, 3);
            child["parentIndex"] = json!({"guid": guid(1, 2), "position": "!"});
            child["stackChildPrimaryGrow"] = json!(1);
            child["stackChildAlignSelf"] = json!("STRETCH");
            let mut absolute = base_change("RECTANGLE", 1, 4);
            absolute["parentIndex"] = json!({"guid": guid(1, 2), "position": "\""});
            absolute["stackPositioning"] = json!("ABSOLUTE");
            changes.extend([frame, child, absolute]);
            let doc = doc_with(changes).unwrap();
            let child_sizing = node_of(&doc, 1, 3).sizing.as_ref().unwrap();
            // vertical parent: grow fills the height, STRETCH fills the width
            assert_eq!(child_sizing.height, SizeMode::Fill);
            assert_eq!(child_sizing.width, SizeMode::Fill);
            assert_eq!(child_sizing.align_self, Some(Align::Stretch));
            let abs = node_of(&doc, 1, 4).sizing.as_ref().unwrap();
            assert!(abs.absolute);
            // absolute children are excluded from stack sizing semantics
            assert_eq!(abs.width, SizeMode::Fixed);
            // frame children are ordered by position string
            let f = node_of(&doc, 1, 2);
            assert_eq!(
                f.children,
                vec!["fig-1-3".to_string(), "fig-1-4".to_string()]
            );
        }

        #[test]
        fn stack_reverse_z_index_reverses_children() {
            let mut changes = canvas_only();
            let mut frame = base_change("FRAME", 1, 2);
            frame["stackMode"] = json!("HORIZONTAL");
            frame["stackReverseZIndex"] = json!(true);
            let mut a = base_change("RECTANGLE", 1, 3);
            a["parentIndex"] = json!({"guid": guid(1, 2), "position": "!"});
            let mut b = base_change("RECTANGLE", 1, 4);
            b["parentIndex"] = json!({"guid": guid(1, 2), "position": "\""});
            changes.extend([frame, a, b]);
            let doc = doc_with(changes).unwrap();
            let f = node_of(&doc, 1, 2);
            assert_eq!(
                f.children,
                vec!["fig-1-4".to_string(), "fig-1-3".to_string()],
                "reverse z-index flips the authored order"
            );
            assert_eq!(
                f.bindings.get("figStackReverseZIndex").map(String::as_str),
                Some("true")
            );
        }

        // ---------------- constraints ----------------

        #[test]
        fn constraints_map_with_parent_reference_size() {
            let mut changes = canvas_only();
            let mut frame = base_change("FRAME", 1, 2);
            frame["size"] = json!({"x": 300, "y": 200});
            let mut child = base_change("RECTANGLE", 1, 3);
            child["parentIndex"] = json!({"guid": guid(1, 2), "position": "!"});
            child["horizontalConstraint"] = json!("CENTER");
            child["verticalConstraint"] = json!("STRETCH");
            changes.extend([frame, child]);
            let doc = doc_with(changes).unwrap();
            let c = node_of(&doc, 1, 3)
                .constraints
                .as_ref()
                .expect("constraints");
            assert_eq!(c.horizontal, Anchor::Center);
            assert_eq!(c.vertical, Anchor::Stretch);
            assert_eq!(c.reference_width, Some(300.));
            assert_eq!(c.reference_height, Some(200.));
        }

        #[test]
        fn fixed_min_constraint_rejects() {
            let mut changes = canvas_only();
            let mut frame = base_change("FRAME", 1, 2);
            frame["size"] = json!({"x": 300, "y": 200});
            let mut child = base_change("RECTANGLE", 1, 3);
            child["parentIndex"] = json!({"guid": guid(1, 2), "position": "!"});
            child["horizontalConstraint"] = json!("FIXED_MIN");
            changes.extend([frame, child]);
            let err = doc_with(changes).unwrap_err();
            match err {
                Error::Unsupported(msg) => assert!(msg.contains("FIXED_MIN"), "{msg}"),
                other => panic!("{other:?}"),
            }
        }

        // ---------------- strokes ----------------

        #[test]
        fn stroke_details_map_cap_join_dash_and_weight() {
            let mut changes = canvas_only();
            let mut rect = base_change("ROUNDED_RECTANGLE", 1, 2);
            rect["strokePaints"] = json!([{
                "type": "SOLID",
                "color": {"r": 1.0, "g": 0.0, "b": 0.0, "a": 1.0},
            }]);
            rect["strokeWeight"] = json!(2.5);
            rect["strokeCap"] = json!("ROUND");
            rect["strokeJoin"] = json!("BEVEL");
            rect["dashPattern"] = json!([4, 2]);
            changes.push(rect);
            let doc = doc_with(changes).unwrap();
            let s = node_of(&doc, 1, 2).strokes.first().expect("stroke");
            assert_eq!(s.cap, "round");
            assert_eq!(s.join, "bevel");
            assert_eq!(s.dash, "4 2");
            assert!((s.width - 2.5).abs() < 1e-9);
            assert_eq!(s.paint.color, "#ff0000");
        }

        #[test]
        fn independent_uniform_border_weights_use_single_width() {
            let mut changes = canvas_only();
            let mut rect = base_change("RECTANGLE", 1, 2);
            rect["strokePaints"] =
                json!([{"type": "SOLID", "color": {"r": 0., "g": 0., "b": 0., "a": 1.}}]);
            rect["borderStrokeWeightsIndependent"] = json!(true);
            rect["borderTopWeight"] = json!(3);
            rect["borderRightWeight"] = json!(3);
            rect["borderBottomWeight"] = json!(3);
            rect["borderLeftWeight"] = json!(3);
            changes.push(rect);
            let doc = doc_with(changes).unwrap();
            let s = node_of(&doc, 1, 2).strokes.first().unwrap();
            assert!((s.width - 3.).abs() < 1e-9);
            assert!(!node_of(&doc, 1, 2).bindings.contains_key("figUntranslated"));
        }

        #[test]
        fn non_uniform_border_weights_are_reported_not_silenced() {
            let mut changes = canvas_only();
            let mut rect = base_change("RECTANGLE", 1, 2);
            rect["strokePaints"] =
                json!([{"type": "SOLID", "color": {"r": 0., "g": 0., "b": 0., "a": 1.}}]);
            rect["borderStrokeWeightsIndependent"] = json!(true);
            rect["borderTopWeight"] = json!(3);
            rect["borderBottomWeight"] = json!(1);
            changes.push(rect);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            let note = n.bindings.get("figUntranslated").unwrap();
            assert!(note.contains("borderStrokeWeightsIndependent"), "{note}");
        }

        #[test]
        fn arrow_caps_map_to_end_markers_and_washi_reports() {
            let mut changes = canvas_only();
            let mut line = base_change("VECTOR", 1, 2);
            line["strokePaints"] =
                json!([{"type": "SOLID", "color": {"r": 0., "g": 0., "b": 0., "a": 1.}}]);
            line["strokeCap"] = json!("ARROW_LINES");
            changes.push(line);
            let mut washi = base_change("VECTOR", 1, 3);
            washi["strokePaints"] =
                json!([{"type": "SOLID", "color": {"r": 0., "g": 0., "b": 0., "a": 1.}}]);
            washi["strokeCap"] = json!("WASHI_TAPE_1");
            changes.push(washi);
            let doc = doc_with(changes).unwrap();
            assert_eq!(
                node_of(&doc, 1, 2).strokes[0].end_marker,
                crate::stroke::Marker::Arrow
            );
            let note = node_of(&doc, 1, 3).bindings.get("figUntranslated").unwrap();
            assert!(note.contains("WASHI_TAPE_1"), "{note}");
        }

        // ---------------- corners ----------------

        #[test]
        fn per_corner_radii_and_smoothing_map() {
            let mut changes = canvas_only();
            let mut rect = base_change("ROUNDED_RECTANGLE", 1, 2);
            rect["cornerRadius"] = json!(8);
            rect["rectangleTopLeftCornerRadius"] = json!(1);
            rect["rectangleTopRightCornerRadius"] = json!(2);
            rect["rectangleBottomRightCornerRadius"] = json!(3);
            rect["rectangleBottomLeftCornerRadius"] = json!(4);
            rect["cornerSmoothing"] = json!(0.6);
            changes.push(rect);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            assert_eq!(n.radii, [1., 2., 3., 4.]);
            assert!(
                (n.smoothing - 0.6).abs() < 1e-6,
                "smoothing {}",
                n.smoothing
            );
            // rects keep rounding in `radii`; corner_radius is polygon/star only
            assert_eq!(n.corner_radius, 0.);
        }

        #[test]
        fn scalar_corner_radius_fills_all_corners() {
            let mut changes = canvas_only();
            let mut rect = base_change("RECTANGLE", 1, 2);
            rect["cornerRadius"] = json!(12);
            changes.push(rect);
            let doc = doc_with(changes).unwrap();
            assert_eq!(node_of(&doc, 1, 2).radii, [12.; 4]);
        }

        // ---------------- effects ----------------

        #[test]
        fn all_four_effect_types_map_with_full_parameters() {
            let mut changes = canvas_only();
            let mut frame = base_change("FRAME", 1, 2);
            frame["effects"] = json!([
                {"type": "DROP_SHADOW", "color": {"r": 0.1, "g": 0.2, "b": 0.3, "a": 0.5},
                 "offset": {"x": 4, "y": 6}, "radius": 10, "spread": 2, "visible": true},
                {"type": "INNER_SHADOW", "color": {"r": 0.5, "g": 0.1, "b": 0.1, "a": 0.8},
                 "offset": {"x": -1, "y": -2}, "radius": 7, "spread": 3, "visible": true},
                {"type": "FOREGROUND_BLUR", "radius": 8, "visible": true},
                {"type": "BACKGROUND_BLUR", "radius": 12, "visible": false},
            ]);
            changes.push(frame);
            let doc = doc_with(changes).unwrap();
            let fx = &node_of(&doc, 1, 2).effects;
            assert_eq!(fx.len(), 4);
            assert_eq!(fx[0].kind, "shadow");
            assert!((fx[0].x - 4.).abs() < 1e-9 && (fx[0].y - 6.).abs() < 1e-9);
            assert!((fx[0].spread - 2.).abs() < 1e-9);
            assert_eq!(fx[0].color, "#1a334d");
            assert!((fx[0].opacity - 0.5).abs() < 1e-9);
            assert_eq!(fx[1].kind, "inner-shadow");
            assert_eq!(fx[1].color, "#801a1a");
            assert!((fx[1].spread - 3.).abs() < 1e-9, "inner shadow spread");
            assert!((fx[1].x + 1.).abs() < 1e-9 && (fx[1].y + 2.).abs() < 1e-9);
            assert_eq!(fx[2].kind, "blur", "FOREGROUND_BLUR is the layer blur");
            assert!((fx[2].radius - 8.).abs() < 1e-9);
            assert_eq!(fx[3].kind, "background-blur");
            assert!(!fx[3].visible);
        }

        // ---------------- text ----------------

        #[test]
        fn text_node_level_style_maps() {
            let mut changes = canvas_only();
            let mut text = base_change("TEXT", 1, 2);
            text["textData"] = json!({"characters": "hello"});
            text["fontSize"] = json!(18);
            text["fontName"] = json!({"family": "Inter", "style": "Semi Bold"});
            text["lineHeight"] = json!({"value": 150, "units": "PERCENT"});
            text["letterSpacing"] = json!({"value": 2, "units": "PIXELS"});
            text["textAlignHorizontal"] = json!("CENTER");
            text["paragraphSpacing"] = json!(4);
            text["textCase"] = json!("UPPER");
            changes.push(text);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            assert_eq!(n.text, "hello");
            assert!((n.font_size - 18.).abs() < 1e-9);
            let style = n.text_style.as_ref().unwrap();
            assert!((style.line_height - 1.5).abs() < 1e-9);
            assert!((style.letter_spacing - 2.).abs() < 1e-9);
            assert_eq!(style.align, "center");
            assert!((style.paragraph_spacing - 4.).abs() < 1e-9);
            assert!((style.weight - 600.).abs() < 1e-9);
            assert!(style.wrap);
            assert_eq!(style.text_case,crate::font::TextCase::Upper);
            assert_eq!(doc.schema_version,15);
            let note = n.bindings.get("figUntranslated").unwrap();
            assert!(!note.contains("textCase=UPPER"), "{note}");
            assert!(note.contains("fontName.family=Inter"), "{note}");
        }

        #[test]
        fn absolute_line_height_divides_by_font_size() {
            let mut changes = canvas_only();
            let mut text = base_change("TEXT", 1, 2);
            text["textData"] = json!({"characters": "x"});
            text["fontSize"] = json!(20);
            text["lineHeight"] = json!({"value": 30, "units": "PIXELS"});
            changes.push(text);
            let doc = doc_with(changes).unwrap();
            let style = node_of(&doc, 1, 2).text_style.as_ref().unwrap();
            assert!((style.line_height - 1.5).abs() < 1e-9);
        }

        #[test]
        fn per_segment_runs_carry_font_size_weight_color_decoration() {
            let mut changes = canvas_only();
            let mut text = base_change("TEXT", 1, 2);
            text["textData"] = json!({
                "characters": "abCD", // utf16 lengths: all 1
                "characterStyleIDs": [0, 1, 1, 2],
                "styleOverrideTable": [
                    {"styleID": 1, "fontSize": 24, "fontName": {"family": "Inter", "style": "Bold"},
                     "fillPaints": [{"type": "SOLID", "color": {"r": 1., "g": 0., "b": 0., "a": 1.}}],
                     "textDecoration": "UNDERLINE", "textCase": "LOWER"},
                    {"styleID": 2, "fontSize": 10, "textDecoration": "STRIKETHROUGH"},
                ],
            });
            text["fontSize"] = json!(16);
            changes.push(text);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            let runs = &n.text_runs;
            assert_eq!(runs.len(), 2, "segments: bC (style 1), D (style 2)");
            assert_eq!(runs[0].start, 1);
            assert_eq!(runs[0].end, 3);
            assert_eq!(runs[0].font_size, Some(24.));
            assert_eq!(runs[0].weight, Some(700.));
            assert_eq!(runs[0].color.as_deref(), Some("#ff0000"));
            assert!(runs[0].underline);
            assert_eq!(runs[1].start, 3);
            assert_eq!(runs[1].end, 4);
            assert_eq!(runs[1].font_size, Some(10.));
            assert!(runs[1].strikethrough);
            assert_eq!(runs[0].text_case,Some(crate::font::TextCase::Lower));
            assert!(!n.bindings.get("figUntranslated").is_some_and(|note|note.contains("textCase=")));
        }

        // ---------------- prototype ----------------

        #[test]
        fn prototype_interactions_bind_with_schema_field_names() {
            let mut changes = canvas_only();
            let mut frame = base_change("FRAME", 1, 2);
            frame["prototypeInteractions"] = json!([
                {"event": {"interactionType": "ON_CLICK"},
                 "actions": [{"transitionNodeID": {"sessionID": 1, "localID": 9},
                              "navigationType": "NAVIGATE", "transitionType": "DISSOLVE",
                              "transitionDuration": 0.3}]},
                {"event": {"interactionType": "MOUSE_ENTER"}, "actions": [], "isDeleted": true},
            ]);
            changes.push(frame);
            let doc = doc_with(changes).unwrap();
            let binding = node_of(&doc, 1, 2)
                .bindings
                .get("prototypeFlow")
                .expect("prototypeFlow binding");
            let flows: Vec<Value> = serde_json::from_str(binding).unwrap();
            assert_eq!(flows.len(), 1, "deleted interactions are skipped");
            assert_eq!(flows[0]["trigger"], "ON_CLICK");
            assert_eq!(flows[0]["destinationId"], "fig-1-9");
            assert_eq!(flows[0]["navigation"], "NAVIGATE");
            assert_eq!(flows[0]["transition"], "DISSOLVE");
            assert!((flows[0]["duration"].as_f64().unwrap() - 0.3).abs() < 1e-6);
        }

        // ---------------- transform ----------------

        #[test]
        fn horizontal_flip_passes_through_the_matrix() {
            let mut changes = canvas_only();
            let mut rect = base_change("RECTANGLE", 1, 2);
            rect["size"] = json!({"x": 40, "y": 20});
            rect["transform"] = json!({
                "m00": -1, "m01": 0, "m02": 100,
                "m10": 0, "m11": 1, "m12": 50,
            });
            changes.push(rect);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            // flip preserved: [-1, 0, 0, 1, 100, 50] — the old AABB path
            // rewrote this into a 180° rotation
            assert_eq!(n.transform.0, [-1., 0., 0., 1., 100., 50.]);
            assert!((n.width - 40.).abs() < 1e-9);
            assert!((n.height - 20.).abs() < 1e-9);
        }

        #[test]
        fn rotation_passes_through_without_aabb_rescaling() {
            let mut changes = canvas_only();
            let mut rect = base_change("RECTANGLE", 1, 2);
            rect["size"] = json!({"x": 40, "y": 20});
            // 90° CCW rotation about the node origin + translation
            rect["transform"] = json!({
                "m00": 0, "m01": -1, "m02": 200,
                "m10": 1, "m11": 0, "m12": 30,
            });
            changes.push(rect);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            assert_eq!(n.transform.0, [0., 1., -1., 0., 200., 30.]);
            assert!((n.width - 40.).abs() < 1e-9);
            assert!((n.height - 20.).abs() < 1e-9);
        }

        // ---------------- components ----------------

        #[test]
        fn symbol_maps_to_frame_with_component_binding() {
            let mut changes = canvas_only();
            let mut symbol = base_change("SYMBOL", 1, 2);
            symbol["size"] = json!({"x": 100, "y": 60});
            let mut child = base_change("RECTANGLE", 1, 3);
            child["parentIndex"] = json!({"guid": guid(1, 2), "position": "!"});
            changes.extend([symbol, child]);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            assert_eq!(
                n.kind, "frame",
                "SYMBOL is a component frame, not a bare group"
            );
            assert!(n.component.is_some());
            assert_eq!(
                n.bindings.get("symbolID").map(String::as_str),
                Some("fig-1-2")
            );
            assert_eq!(n.children, vec!["fig-1-3".to_string()]);
        }

        #[test]
        fn instance_maps_to_frame_with_component_id_and_overrides() {
            let mut changes = canvas_only();
            changes.push(base_change("SYMBOL", 1, 2));
            let mut instance = base_change("INSTANCE", 1, 5);
            instance["symbolData"] = json!({
                "symbolID": {"sessionID": 1, "localID": 2},
                "symbolOverrides": [
                    {"overrideKey": {"sessionID": 1, "localID": 3},
                     "fillPaints": [{"type": "SOLID", "color": {"r": 0., "g": 0., "b": 1., "a": 1.}}],
                     "fontSize": 12},
                ],
            });
            changes.push(instance);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 5);
            assert_eq!(n.kind, "frame");
            let instance = n.instance.as_ref().expect("instance");
            assert_eq!(instance.component_id, "fig-1-2");
            let fields = instance.overrides.get("fig-1-3").expect("override entry");
            // fillPaints translated to a kernel paint, fontSize kept raw
            let paints = fields.get("fillPaints").and_then(Value::as_array).unwrap();
            assert_eq!(paints[0]["color"], "#0000ff");
            assert_eq!(fields.get("fontSize"), Some(&json!(12.)));
        }

        // ---------------- pages / misc ----------------

        #[test]
        fn canvas_background_and_names_map() {
            let changes = vec![json!({
                "guid": guid(0, 1), "phase": "CREATED", "type": "CANVAS",
                "name": "Home", "backgroundColor": {"r": 0.2, "g": 0.4, "b": 0.6, "a": 1.0},
                "parentIndex": {"guid": guid(0, 0), "position": ""},
            })];
            let doc = doc_with(changes).unwrap();
            assert_eq!(doc.pages.len(), 1);
            assert_eq!(doc.pages[0].name, "Home");
            assert_eq!(doc.pages[0].background, "#336699");
        }

        #[test]
        fn updated_and_removed_phases_merge_by_guid() {
            let mut changes = canvas_only();
            let mut created = base_change("RECTANGLE", 1, 2);
            created["name"] = json!("before");
            let mut updated = created.clone();
            updated["phase"] = json!("UPDATED");
            updated["name"] = json!("after");
            let removed = {
                let mut r = base_change("RECTANGLE", 1, 3);
                r["phase"] = json!("REMOVED");
                r
            };
            changes.extend([created, updated, removed]);
            let doc = doc_with(changes).unwrap();
            assert_eq!(node_of(&doc, 1, 2).name, "after");
            assert!(!doc.nodes.contains_key("fig-1-3"), "REMOVED deletes");
        }

        #[test]
        fn frame_clips_unless_mask_disabled() {
            let mut changes = canvas_only();
            let mut frame = base_change("FRAME", 1, 2);
            frame["frameMaskDisabled"] = json!(true);
            changes.push(frame);
            changes.push(base_change("FRAME", 1, 3));
            let doc = doc_with(changes).unwrap();
            assert!(!node_of(&doc, 1, 2).clip);
            assert!(node_of(&doc, 1, 3).clip);
        }

        #[test]
        fn boolean_operation_maps_union_and_xor() {
            let mut changes = canvas_only();
            let mut op = base_change("BOOLEAN_OPERATION", 1, 2);
            op["booleanOperation"] = json!("XOR");
            changes.push(op);
            changes.push(base_change("BOOLEAN_OPERATION", 1, 3));
            let doc = doc_with(changes).unwrap();
            assert_eq!(
                node_of(&doc, 1, 2).boolean_operation,
                Some(crate::boolean::Operation::Exclude)
            );
            assert_eq!(
                node_of(&doc, 1, 3).boolean_operation,
                Some(crate::boolean::Operation::Union)
            );
        }

        #[test]
        fn star_inner_radius_reads_star_inner_scale() {
            let mut changes = canvas_only();
            let mut star = base_change("STAR", 1, 2);
            star["count"] = json!(6);
            star["starInnerScale"] = json!(0.42);
            changes.push(star);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            assert_eq!(n.points, 6);
            assert!(
                (n.inner_radius - 0.42).abs() < 1e-6,
                "inner {}",
                n.inner_radius
            );
        }

        #[test]
        fn luminance_mask_maps_and_outline_reports() {
            let mut changes = canvas_only();
            let mut a = base_change("ELLIPSE", 1, 2);
            a["mask"] = json!(true);
            a["maskType"] = json!("LUMINANCE");
            let mut b = base_change("ELLIPSE", 1, 3);
            b["mask"] = json!(true);
            b["maskType"] = json!("OUTLINE");
            changes.extend([a, b]);
            let doc = doc_with(changes).unwrap();
            assert_eq!(node_of(&doc, 1, 2).mask_type.as_deref(), Some("luminance"));
            let note = node_of(&doc, 1, 3).bindings.get("figUntranslated").unwrap();
            assert!(note.contains("maskType=OUTLINE"), "{note}");
        }

        #[test]
        fn layout_import_survives_document_validation() {
            let mut changes = canvas_only();
            let mut frame = base_change("FRAME", 1, 2);
            frame["size"] = json!({"x": 300, "y": 200});
            frame["stackMode"] = json!("VERTICAL");
            frame["stackSpacing"] = json!(8);
            let mut child = base_change("ROUNDED_RECTANGLE", 1, 3);
            child["parentIndex"] = json!({"guid": guid(1, 2), "position": "!"});
            child["cornerRadius"] = json!(4);
            child["fillPaints"] =
                json!([{"type": "SOLID", "color": {"r": 0.9, "g": 0.9, "b": 0.9, "a": 1.0}}]);
            changes.extend([frame, child]);
            let doc = doc_with(changes).unwrap();
            assert!(doc.validate().is_ok(), "{:?}", doc.validate().err());
            assert!(doc.schema_version >= 4);
        }

        // ---------------- new node types (21 号 gap list) ----------------

        #[test]
        fn sticky_maps_to_frame_with_board_content() {
            let mut changes = canvas_only();
            let mut sticky = base_change("STICKY", 1, 2);
            sticky["fillPaints"] =
                json!([{"type": "SOLID", "color": {"r": 1., "g": 0.9, "b": 0.2, "a": 1.}}]);
            sticky["textData"] = json!({"characters": "remember"});
            sticky["fontSize"] = json!(18);
            changes.push(sticky);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            assert_eq!(n.kind, "frame");
            let board = n.board.as_ref().expect("board");
            assert_eq!(board.kind, "sticky");
            assert_eq!(n.text, "remember");
            assert!((n.font_size - 18.).abs() < 1e-9);
            assert!(doc.validate().is_ok(), "{:?}", doc.validate().err());
            assert!(doc.schema_version >= 10);
        }

        #[test]
        fn sticky_imports_per_segment_runs_from_style_table() {
            // Multi-style sticky: "big small" with per-segment fontSize and
            // color via characterStyleIDs + styleOverrideTable; segments
            // without style data keep the whole-string fallback.
            let mut changes = canvas_only();
            let mut sticky = base_change("STICKY", 1, 2);
            sticky["textData"] = json!({
                "characters": "big small",
                "characterStyleIDs": [0, 0, 0, 1, 1, 1, 1, 1, 1],
                "styleOverrideTable": [
                    {"styleID": 1, "fontSize": 24,
                     "fillPaints": [{"type": "SOLID", "color": {"r": 1., "g": 0., "b": 0., "a": 1.}}],
                     "textDecoration": "UNDERLINE"}
                ]
            });
            changes.push(sticky);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            assert_eq!(n.board.as_ref().unwrap().kind, "sticky");
            assert_eq!(n.text, "big small");
            let runs = &n.text_runs;
            assert_eq!(runs.len(), 1, "only the styled segment becomes a run");
            assert_eq!((runs[0].start, runs[0].end), (3, 9));
            assert_eq!(runs[0].font_size, Some(24.));
            assert_eq!(runs[0].color.as_deref(), Some("#ff0000"));
            assert!(runs[0].underline);
            assert!(doc.validate().is_ok(), "{:?}", doc.validate().err());

            // Fallback: no style table at all → whole-string, no runs.
            let mut changes = canvas_only();
            let mut plain = base_change("STICKY", 1, 2);
            plain["textData"] = json!({"characters": "plain"});
            changes.push(plain);
            let doc = doc_with(changes).unwrap();
            assert!(node_of(&doc, 1, 2).text_runs.is_empty());
            assert!(doc.validate().is_ok(), "{:?}", doc.validate().err());
        }

        #[test]
        fn code_block_maps_language_and_characters() {
            let mut changes = canvas_only();
            let mut code = base_change("CODE_BLOCK", 1, 2);
            code["codeBlockLanguage"] = json!("PYTHON");
            code["textData"] = json!({"characters": "print(1)"});
            changes.push(code);
            let mut rust_unsupported = base_change("CODE_BLOCK", 1, 3);
            rust_unsupported["codeBlockLanguage"] = json!("CPP");
            changes.push(rust_unsupported);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            assert_eq!(n.board.as_ref().unwrap().kind, "code-block");
            assert_eq!(
                n.board.as_ref().unwrap().language.as_deref(),
                Some("python")
            );
            assert_eq!(n.text, "print(1)");
            let note = node_of(&doc, 1, 3)
                .bindings
                .get("figUntranslated")
                .expect("unsupported language reported");
            assert!(note.contains("codeBlockLanguage=CPP"), "{note}");
        }

        #[test]
        fn shape_with_text_maps_supported_shapes_and_rejects_the_rest() {
            let mut changes = canvas_only();
            let mut shape = base_change("SHAPE_WITH_TEXT", 1, 2);
            shape["shapeWithTextType"] = json!("DIAMOND");
            shape["textData"] = json!({"characters": "decision"});
            changes.push(shape);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            assert_eq!(n.board.as_ref().unwrap().kind, "shape-whiteboard-diamond");
            assert_eq!(n.text, "decision");
            assert!(doc.validate().is_ok(), "{:?}", doc.validate().err());

            // unsupported shape variants reject by name with the payload
            let mut changes = canvas_only();
            let mut bad = base_change("SHAPE_WITH_TEXT", 1, 2);
            bad["shapeWithTextType"] = json!("PARALLELOGRAM_RIGHT");
            changes.push(bad);
            let err = doc_with(changes).unwrap_err();
            match err {
                Error::Unsupported(msg) => assert!(msg.contains("PARALLELOGRAM_RIGHT"), "{msg}"),
                other => panic!("{other:?}"),
            }
        }

        #[test]
        fn table_maps_dimensions_and_cells_and_rejects_oversized() {
            let mut changes = canvas_only();
            let mut table = base_change("TABLE", 1, 2);
            table["size"] = json!({"x": 400, "y": 300});
            table["tableRowHeights"] = json!({"entries": [
                {"id": guid(1, 30), "size": 40.},
                {"id": guid(1, 31), "size": 40.},
            ]});
            table["tableColumnWidths"] = json!({"entries": [
                {"id": guid(1, 32), "size": 100.},
                {"id": guid(1, 33), "size": 100.},
                {"id": guid(1, 34), "size": 100.},
            ]});
            let mut cell = base_change("TABLE_CELL", 1, 3);
            cell["parentIndex"] = json!({"guid": guid(1, 2), "position": "!"});
            cell["textData"] = json!({"characters": "A1"});
            changes.extend([table, cell]);
            let doc = doc_with(changes).unwrap();
            let board = node_of(&doc, 1, 2).board.as_ref().unwrap();
            assert_eq!(board.kind, "table");
            assert_eq!(board.rows, Some(2));
            assert_eq!(board.columns, Some(3));
            assert_eq!(node_of(&doc, 1, 2).children, vec!["fig-1-3".to_string()]);
            assert_eq!(node_of(&doc, 1, 3).kind, "text");
            assert_eq!(node_of(&doc, 1, 3).text, "A1");
            assert!(doc.validate().is_ok(), "{:?}", doc.validate().err());

            // a 60-row table exceeds the kernel budget and rejects by name
            let mut changes = canvas_only();
            let mut huge = base_change("TABLE", 1, 2);
            let rows: Vec<Value> = (0..60)
                .map(|i| json!({"id": guid(2, i), "size": 20.}))
                .collect();
            huge["tableRowHeights"] = json!({"entries": rows});
            huge["tableColumnWidths"] = json!({"entries": [{"id": guid(2, 99), "size": 50.}]});
            changes.push(huge);
            let err = doc_with(changes).unwrap_err();
            match err {
                Error::Unsupported(msg) => assert!(msg.contains("TABLE"), "{msg}"),
                other => panic!("{other:?}"),
            }
        }

        #[test]
        fn connector_maps_endpoints_and_line_style() {
            let mut changes = canvas_only();
            // connector endpoints reference real nodes (kernel validate
            // requires attached endpoints to exist and carry an anchor)
            let mut left = base_change("RECTANGLE", 1, 5);
            left["parentIndex"] = json!({"guid": guid(0, 1), "position": "!"});
            let mut right = base_change("RECTANGLE", 1, 6);
            right["parentIndex"] = json!({"guid": guid(0, 1), "position": "\""});
            let mut connector = base_change("CONNECTOR", 1, 2);
            connector["parentIndex"] = json!({"guid": guid(0, 1), "position": "#"});
            connector["connectorStart"] = json!({
                "endpointNodeID": {"sessionID": 1, "localID": 5},
                "position": {"x": 10., "y": 20.},
                "magnet": "TOP"
            });
            connector["connectorEnd"] = json!({
                "endpointNodeID": {"sessionID": 1, "localID": 6},
                "position": {"x": 110., "y": 140.},
                "magnet": "RIGHT"
            });
            connector["connectorLineStyle"] = json!("ELBOWED");
            changes.extend([left, right, connector]);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            assert_eq!(n.kind, "vector");
            assert!(
                n.bindings.is_empty(),
                "exact magnet edges map without degradation notes"
            );
            let c = n.connector.as_ref().expect("connector");
            assert_eq!(c.style, "elbow");
            assert_eq!(c.from.node_id.as_deref(), Some("fig-1-5"));
            assert!((c.from.point.x - 10.).abs() < 1e-9);
            assert_eq!(c.to.node_id.as_deref(), Some("fig-1-6"));
            assert!((c.to.point.y - 140.).abs() < 1e-9);
            // magnet edges map onto the unit-side anchors
            let top = c.from.anchor.expect("attached endpoint anchor");
            assert!((top.x - 0.5).abs() < 1e-9 && (top.y - 0.).abs() < 1e-9);
            let side = c.to.anchor.expect("attached endpoint anchor");
            assert!((side.x - 1.).abs() < 1e-9 && (side.y - 0.5).abs() < 1e-9);
            assert!(doc.validate().is_ok(), "{:?}", doc.validate().err());
            assert!(doc.schema_version >= 10);
        }

        #[test]
        fn auto_magnet_connector_approximates_center_with_a_note() {
            let mut changes = canvas_only();
            let mut left = base_change("RECTANGLE", 1, 5);
            left["parentIndex"] = json!({"guid": guid(0, 1), "position": "!"});
            let mut connector = base_change("CONNECTOR", 1, 2);
            connector["parentIndex"] = json!({"guid": guid(0, 1), "position": "#"});
            connector["connectorStart"] = json!({
                "endpointNodeID": {"sessionID": 1, "localID": 5},
                "position": {"x": 0., "y": 0.},
                "magnet": "AUTO"
            });
            connector["connectorEnd"] = json!({"position": {"x": 50., "y": 50.}});
            changes.extend([left, connector]);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            let c = n.connector.as_ref().unwrap();
            let anchor = c.from.anchor.unwrap();
            assert!((anchor.x - 0.5).abs() < 1e-9 && (anchor.y - 0.5).abs() < 1e-9);
            let note = n.bindings.get("figUntranslated").unwrap();
            assert!(note.contains("connectorMagnet=AUTO->center"), "{note}");
        }

        #[test]
        fn curved_connector_degrades_with_a_note() {
            let mut changes = canvas_only();
            let mut connector = base_change("CONNECTOR", 1, 2);
            connector["connectorStart"] = json!({"position": {"x": 0., "y": 0.}});
            connector["connectorEnd"] = json!({"position": {"x": 50., "y": 50.}});
            connector["connectorLineStyle"] = json!("CURVED");
            changes.push(connector);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            assert_eq!(n.connector.as_ref().unwrap().style, "straight");
            let note = n.bindings.get("figUntranslated").unwrap();
            assert!(note.contains("connectorLineStyle=CURVED"), "{note}");
        }

        // ---------------- paint gap closures ----------------

        #[test]
        fn gradient_transform_maps_onto_paint_transform() {
            let mut changes = canvas_only();
            let mut rect = base_change("RECTANGLE", 1, 2);
            rect["fillPaints"] = json!([{
                "type": "GRADIENT_LINEAR",
                "stops": [
                    {"position": 0., "color": {"r": 0., "g": 0., "b": 0., "a": 1.}},
                    {"position": 1., "color": {"r": 1., "g": 1., "b": 1., "a": 1.}},
                ],
                "transform": {"m00": 0.7, "m01": -0.3, "m02": 0.2,
                               "m10": 0.3, "m11": 0.7, "m12": -0.1},
            }]);
            changes.push(rect);
            let doc = doc_with(changes).unwrap();
            let paint = &node_of(&doc, 1, 2).fills[0];
            assert_eq!(paint.kind, "linear");
            let t = paint.transform.expect("gradient transform").0;
            // kiwi floats are f32 on the wire
            for (got, want) in t.iter().zip([0.7, 0.3, -0.3, 0.7, 0.2, -0.1]) {
                assert!((got - want).abs() < 1e-6, "matrix {t:?}");
            }
        }

        #[test]
        fn image_scale_mode_maps_fill_and_fit() {
            let mut changes = canvas_only();
            let mut a = base_change("RECTANGLE", 1, 2);
            a["fillPaints"] = json!([{
                "type": "IMAGE",
                "image": {"dataRef": "missing-ref"},
                "imageScaleMode": "FILL",
            }]);
            let mut b = base_change("RECTANGLE", 1, 3);
            b["fillPaints"] = json!([{
                "type": "IMAGE",
                "image": {"dataRef": "missing-ref"},
                "imageScaleMode": "FIT",
            }]);
            let mut c = base_change("RECTANGLE", 1, 4);
            c["fillPaints"] = json!([{
                "type": "IMAGE",
                "image": {"dataRef": "missing-ref"},
                "imageScaleMode": "TILE",
            }]);
            let mut emoji = base_change("RECTANGLE", 1, 5);
            emoji["fillPaints"] = json!([{
                "type": "EMOJI",
                "emojiCodePoints": [128512],
            }]);
            changes.extend([a, b, c, emoji]);
            let doc = doc_with(changes).unwrap();
            assert_eq!(node_of(&doc, 1, 2).fills[0].fit, "stretch");
            assert_eq!(node_of(&doc, 1, 3).fills[0].fit, "contain");
            assert_eq!(node_of(&doc, 1, 4).fills[0].fit, "cover");
            let note = node_of(&doc, 1, 4)
                .bindings
                .get("figUntranslated")
                .expect("tile mode reported");
            assert!(note.contains("imageScaleMode=TILE"), "{note}");
            // TILE maps to the pattern-fill grid at the image's native size;
            // kiwi-side stagger/size/offset parameters do not exist in the
            // Paint table, so only the base behavior maps.
            let tile = node_of(&doc, 1, 4).fills[0].tile.as_ref().expect("grid tile");
            assert_eq!(tile.mode, "grid");
            assert_eq!(tile.size, [0., 0.], "0 = native patternTexSizePixels");
            assert_eq!(tile.offset, [0., 0.]);
            assert!(note.contains("不支持"), "{note}");
            // EMOJI paint must not masquerade as a solid fill
            assert!(node_of(&doc, 1, 5).fills.is_empty());
            let note = node_of(&doc, 1, 5)
                .bindings
                .get("figUntranslated")
                .expect("emoji paint reported");
            assert!(note.contains("paintType=EMOJI"), "{note}");
        }

        #[test]
        fn native_image_filters_use_shader_domain_values() {
            let importer=FigImporter {images:BTreeMap::new(),kiwi_blobs:vec![]};
            let mut untranslated=Vec::new();
            let paint=importer.paint(&json!({"type":"IMAGE","paintFilter":{
                "contrast":-0.09300000220537186,"vibrance":0.4699999988079071,"exposure":0.23000000417232513
            }}),&mut untranslated).unwrap();
            let adjust=paint.adjust.unwrap();
            assert_eq!(adjust.contrast,-0.09300000220537186);
            assert_eq!(adjust.color,0.4699999988079071);
            assert_eq!(adjust.exposure,0.23000000417232513);
            assert!(untranslated.is_empty());
            let identity=importer.paint(&json!({"type":"IMAGE","filterColorAdjust":{"exposure":0,"vignette":0.2}}),&mut untranslated).unwrap();
            assert!(identity.adjust.is_none());assert!(untranslated.iter().any(|s|s.contains("vignette")));
        }

        #[test]
        fn effect_blend_mode_and_shadow_behind_node_report() {
            let mut changes = canvas_only();
            let mut frame = base_change("FRAME", 1, 2);
            frame["effects"] = json!([
                {"type": "DROP_SHADOW", "radius": 4, "visible": true,
                 "blendMode": "MULTIPLY", "showShadowBehindNode": true},
            ]);
            changes.push(frame);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            assert_eq!(n.effects.len(), 1);
            let note = n.bindings.get("figUntranslated").unwrap();
            assert!(note.contains("effectBlendMode=MULTIPLY"), "{note}");
            assert!(note.contains("showShadowBehindNode"), "{note}");
        }

        // ---------------- text variants ----------------

        #[test]
        fn open_type_features_and_variations_map() {
            let mut changes = canvas_only();
            let mut text = base_change("TEXT", 1, 2);
            text["textData"] = json!({"characters": "fi"});
            text["toggledOnOTFeatures"] = json!(["LIGA", "CALT"]);
            text["toggledOffOTFeatures"] = json!(["DLIG"]);
            // 'wght' (0x77676874) stays reserved; 'slnt' (0x736c6e74) maps
            text["fontVariations"] = json!([
                {"axisTag": 0x77676874, "value": 700.},
                {"axisTag": 0x736c6e74, "value": -8.},
            ]);
            changes.push(text);
            let doc = doc_with(changes).unwrap();
            let style = node_of(&doc, 1, 2).text_style.as_ref().unwrap();
            assert_eq!(style.features, vec!["liga", "calt", "-dlig"]);
            assert_eq!(style.variations.len(), 1);
            assert_eq!(style.variations[0].tag, "slnt");
            assert!((style.variations[0].value + 8.).abs() < 1e-9);
            assert!(doc.validate().is_ok(), "{:?}", doc.validate().err());
        }

        #[test]
        fn node_level_decoration_covers_plain_text() {
            let mut changes = canvas_only();
            let mut text = base_change("TEXT", 1, 2);
            text["textData"] = json!({"characters": "note"});
            text["textDecoration"] = json!("UNDERLINE");
            changes.push(text);
            let doc = doc_with(changes).unwrap();
            let runs = &node_of(&doc, 1, 2).text_runs;
            assert_eq!(runs.len(), 1);
            assert_eq!(runs[0].start, 0);
            assert_eq!(runs[0].end, 4);
            assert!(runs[0].underline);
            assert!(!node_of(&doc, 1, 2).bindings.contains_key("figUntranslated"));
        }

        // ---------------- component properties (21 号 P2-14) ----------------

        #[test]
        fn symbol_component_key_and_prop_defs_map() {
            let mut changes = canvas_only();
            let mut symbol = base_change("SYMBOL", 1, 2);
            symbol["componentKey"] = json!("published-key-42");
            symbol["componentPropDefs"] = json!([
                {"id": {"sessionID": 1, "localID": 8}, "name": "state",
                 "type": "BOOL", "initialValue": {"boolValue": false}},
                {"id": {"sessionID": 1, "localID": 9}, "name": "label",
                 "type": "TEXT", "initialValue": {"textValue": {"characters": "hi"}}},
                {"id": {"sessionID": 1, "localID": 10}, "name": "tint",
                 "type": "COLOR", "initialValue": null},
            ]);
            changes.push(symbol);
            let doc = doc_with(changes).unwrap();
            let n = node_of(&doc, 1, 2);
            assert_eq!(n.component_key.as_deref(), Some("published-key-42"));
            let component = n.component.as_ref().unwrap();
            assert!(component.properties.contains_key("state"));
            assert!(component.properties.contains_key("label"));
            let prop = component.properties.get("state").unwrap();
            assert_eq!(prop.kind, crate::components::PropertyKind::Boolean);
            assert_eq!(prop.target_key, "fig-1-8");
            // COLOR has no kernel PropertyKind: reported, not silent
            let note = n.bindings.get("figUntranslated").unwrap();
            assert!(note.contains("componentPropType=COLOR"), "{note}");
        }

        #[test]
        fn instance_prop_assignments_map_to_property_values() {
            let mut changes = canvas_only();
            changes.push(base_change("SYMBOL", 1, 2));
            let mut instance = base_change("INSTANCE", 1, 5);
            instance["symbolData"] = json!({
                "symbolID": {"sessionID": 1, "localID": 2},
                "symbolOverrides": [],
            });
            instance["componentPropAssignments"] = json!([
                {"defID": {"sessionID": 1, "localID": 8}, "value": {"boolValue": true}},
            ]);
            changes.push(instance);
            let doc = doc_with(changes).unwrap();
            let inst = node_of(&doc, 1, 5).instance.as_ref().unwrap();
            assert_eq!(
                inst.property_values.get("fig-1-8"),
                Some(&json!({"boolValue": true}))
            );
        }
    }
}
