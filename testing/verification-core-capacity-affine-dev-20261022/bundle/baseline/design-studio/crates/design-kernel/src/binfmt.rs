//! Compact binary document format.
//!
//! Schema-tagged binary encoding for transport and persistence: varint
//! headers, a deduplicated string table, per-node field tags with defaults
//! omitted.  Semantics stay defined by serde — the binary form is a
//! transparent, versioned re-encoding of the authored JSON model.
use crate::scene::Document;

pub const FORMAT_VERSION: u16 = 2;
pub const MAX_VALUE_BYTES: usize = 32 * 1024 * 1024;
pub const MAGIC: [u8; 4] = [b'F', b'X', b'D', b'K'];

#[derive(Debug)]
pub enum Error {
    Truncated,
    BadMagic,
    Malformed(String),
    UnsupportedVersion(u16),
    ChecksumMismatch,
    Json(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Truncated => write!(f, "binary document truncated"),
            Error::BadMagic => write!(f, "bad magic"),
            Error::Malformed(m) => write!(f, "malformed payload: {m}"),
            Error::UnsupportedVersion(v) => write!(f, "unsupported format version {v}"),
            Error::ChecksumMismatch => write!(f, "checksum mismatch"),
            Error::Json(e) => write!(f, "payload error: {e}"),
        }
    }
}

impl Writer {
    /// Raw body bytes written so far (for callers embedding fragments).
    pub fn body(&self) -> &[u8] {
        &self.out
    }
}

pub struct Writer {
    out: Vec<u8>,
    strings: Vec<String>,
    index: std::collections::HashMap<String, u32>,
}

impl Default for Writer {
    fn default() -> Self {
        Self::new()
    }
}

impl Writer {
    pub fn new() -> Self {
        Writer {
            out: Vec::new(),
            strings: Vec::new(),
            index: std::collections::HashMap::new(),
        }
    }

    pub fn u8(&mut self, value: u8) {
        self.out.push(value);
    }

    pub fn varuint(&mut self, mut value: u64) {
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                self.out.push(byte);
                break;
            }
            self.out.push(byte | 0x80);
        }
    }

    /// Zigzag varint keeps small negative deltas single-byte.
    pub fn varint(&mut self, value: i64) {
        self.varuint(((value << 1) ^ (value >> 63)) as u64);
    }

    pub fn f64(&mut self, value: f64) {
        self.out.extend_from_slice(&value.to_bits().to_le_bytes());
    }

    pub fn str_ref(&mut self, value: &str) {
        match self.index.get(value) {
            Some(&i) => self.varuint(i as u64),
            None => {
                let id = self.strings.len() as u32;
                self.index.insert(value.into(), id);
                self.strings.push(value.into());
                self.varuint(id as u64);
            }
        }
    }

    pub fn bytes(&mut self, value: &[u8]) {
        self.varuint(value.len() as u64);
        self.out.extend_from_slice(value);
    }

    pub fn finish(mut self) -> Vec<u8> {
        let mut body = std::mem::take(&mut self.out);
        let mut head = Vec::with_capacity(16 + body.len());
        head.extend_from_slice(&MAGIC);
        head.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        head.extend_from_slice(&[0; 8]);
        // string table first so the reader can resolve refs while scanning
        let mut table = Vec::new();
        let mut table_writer = Writer {
            out: Vec::new(),
            strings: Vec::new(),
            index: Default::default(),
        };
        table_writer.varuint(self.strings.len() as u64);
        for s in &self.strings {
            table_writer.bytes(s.as_bytes());
        }
        table.extend_from_slice(&table_writer.out);
        head.extend_from_slice(&table);
        head.append(&mut body);
        // Version 2 covers the string table as well as the typed body.
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(&head[14..]);
        head[6..14].copy_from_slice(&digest[..8]);
        head
    }
}

pub struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
    strings: Vec<String>,
}

impl<'a> Reader<'a> {
    /// Reader over a bare body fragment (no header, no string table).
    pub fn for_body(data: &'a [u8]) -> Self {
        Reader {
            data,
            pos: 0,
            strings: Vec::new(),
        }
    }

    pub fn consumed(&self) -> usize {
        self.pos
    }

    pub fn new(data: &'a [u8]) -> Result<Self, Error> {
        if data.len() < 14 {
            return Err(Error::Truncated);
        }
        if data[..4] != MAGIC {
            return Err(Error::BadMagic);
        }
        let version = u16::from_le_bytes([data[4], data[5]]);
        if version != 1 && version != FORMAT_VERSION {
            return Err(Error::UnsupportedVersion(version));
        }
        let digest = &data[6..14];
        let mut reader = Reader {
            data,
            pos: 14,
            strings: Vec::new(),
        };
        let count = reader.varuint()? as usize;
        if count > data.len() {
            return Err(Error::Truncated);
        }
        for _ in 0..count {
            let raw = reader.blob()?;
            reader
                .strings
                .push(String::from_utf8(raw.to_vec()).map_err(|_| Error::Truncated)?);
        }
        let body_start = reader.pos;
        let body = &data[if version == 1 { body_start } else { 14 }..];
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(body);
        let computed = hasher.finalize();
        if computed[..8] != *digest {
            return Err(Error::ChecksumMismatch);
        }
        Ok(reader)
    }

    pub fn varuint(&mut self) -> Result<u64, Error> {
        let mut value = 0u64;
        let mut shift = 0;
        loop {
            let byte = *self.data.get(self.pos).ok_or(Error::Truncated)?;
            self.pos += 1;
            if shift == 63 && byte > 1 {
                return Err(Error::Malformed("varint overflow".into()));
            }
            value |= ((byte & 0x7f) as u64) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
            shift += 7;
            if shift >= 64 {
                return Err(Error::Truncated);
            }
        }
    }

    fn varint(&mut self) -> Result<i64, Error> {
        let raw = self.varuint()?;
        Ok(((raw >> 1) as i64) ^ -((raw & 1) as i64))
    }

    fn f64(&mut self) -> Result<f64, Error> {
        let bytes: [u8; 8] = self
            .data
            .get(self.pos..self.pos + 8)
            .ok_or(Error::Truncated)?
            .try_into()
            .map_err(|_| Error::Truncated)?;
        self.pos += 8;
        Ok(f64::from_bits(u64::from_le_bytes(bytes)))
    }

    fn blob(&mut self) -> Result<&'a [u8], Error> {
        let len = self.varuint()? as usize;
        let start = self.pos;
        self.pos = self.pos.checked_add(len).ok_or(Error::Truncated)?;
        self.data.get(start..self.pos).ok_or(Error::Truncated)
    }

    fn tag(&mut self) -> Result<u8, Error> {
        self.u8()
    }

    fn u8(&mut self) -> Result<u8, Error> {
        let byte = *self.data.get(self.pos).ok_or(Error::Truncated)?;
        self.pos += 1;
        Ok(byte)
    }

    #[cfg(test)]
    fn f64_vec(&mut self, count: usize) -> Result<Vec<f64>, Error> {
        (0..count).map(|_| self.f64()).collect()
    }
}

// ---------------------------------------------------------------------------
// Value-tree codec: documents serialize to a JSON value tree, then encode
// with typed tags, varints and the shared string table — every repeated key
// (`id`, `kind`, `fills`, …) and repeated string value is stored once.
// ---------------------------------------------------------------------------

use serde_json::Value;

const TAG_NULL: u8 = 0;
const TAG_FALSE: u8 = 1;
const TAG_TRUE: u8 = 2;
const TAG_UINT: u8 = 3;
const TAG_INT: u8 = 4;
const TAG_FLOAT: u8 = 5;
const TAG_STR: u8 = 6;
const TAG_ARRAY: u8 = 7;
const TAG_OBJECT: u8 = 8;

fn write_value(writer: &mut Writer, value: &Value) {
    match value {
        Value::Null => writer.u8(TAG_NULL),
        Value::Bool(false) => writer.u8(TAG_FALSE),
        Value::Bool(true) => writer.u8(TAG_TRUE),
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                writer.u8(TAG_UINT);
                writer.varuint(u);
            } else if let Some(i) = n.as_i64() {
                writer.u8(TAG_INT);
                writer.varint(i);
            } else {
                writer.u8(TAG_FLOAT);
                writer.f64(n.as_f64().unwrap_or_default());
            }
        }
        Value::String(s) => {
            writer.u8(TAG_STR);
            writer.str_ref(s);
        }
        Value::Array(items) => {
            writer.u8(TAG_ARRAY);
            writer.varuint(items.len() as u64);
            for item in items {
                write_value(writer, item);
            }
        }
        Value::Object(map) => {
            writer.u8(TAG_OBJECT);
            writer.varuint(map.len() as u64);
            for (key, item) in map {
                writer.str_ref(key);
                write_value(writer, item);
            }
        }
    }
}

fn read_value(reader: &mut Reader<'_>, depth: usize, budget: &mut usize) -> Result<Value, Error> {
    if depth > 128 {
        return Err(Error::Malformed("value nesting limit".into()));
    }
    *budget = budget
        .checked_sub(16)
        .ok_or_else(|| Error::Malformed("expanded value limit".into()))?;
    Ok(match reader.tag()? {
        TAG_NULL => Value::Null,
        TAG_FALSE => Value::Bool(false),
        TAG_TRUE => Value::Bool(true),
        TAG_UINT => Value::from(reader.varuint()?),
        TAG_INT => Value::from(reader.varint()?),
        TAG_FLOAT => {
            let n = reader.f64()?;
            if !n.is_finite() {
                return Err(Error::Malformed("non-finite number".into()));
            }
            Value::from(n)
        }
        TAG_STR => Value::String(read_string(reader, budget)?),
        TAG_ARRAY => {
            let len = reader.varuint()? as usize;
            if len > reader.data.len().saturating_sub(reader.pos) {
                return Err(Error::Truncated);
            }
            let mut items = Vec::with_capacity(len.min(4096));
            for _ in 0..len {
                items.push(read_value(reader, depth + 1, budget)?);
            }
            Value::Array(items)
        }
        TAG_OBJECT => {
            let len = reader.varuint()? as usize;
            if len > reader.data.len().saturating_sub(reader.pos) {
                return Err(Error::Truncated);
            }
            let mut map = serde_json::Map::with_capacity(len.min(4096));
            for _ in 0..len {
                let key = read_string(reader, budget)?;
                if map
                    .insert(key, read_value(reader, depth + 1, budget)?)
                    .is_some()
                {
                    return Err(Error::Malformed("duplicate key".into()));
                }
            }
            Value::Object(map)
        }
        other => return Err(Error::Malformed(format!("unknown value tag {other}"))),
    })
}

fn read_string(reader: &mut Reader<'_>, budget: &mut usize) -> Result<String, Error> {
    let id = reader.varuint()? as usize;
    let text = reader.strings.get(id).ok_or(Error::Truncated)?;
    *budget = budget
        .checked_sub(text.len())
        .ok_or_else(|| Error::Malformed("expanded string limit".into()))?;
    Ok(text.clone())
}

/// Preserve every authored field, including explicit nulls and extension data.
pub fn encode_value(value: &Value) -> Vec<u8> {
    let mut writer = Writer::new();
    write_value(&mut writer, value);
    writer.finish()
}
pub fn decode_value(data: &[u8]) -> Result<Value, Error> {
    if data.len() > MAX_VALUE_BYTES {
        return Err(Error::Malformed("file size limit".into()));
    }
    let mut reader = Reader::new(data)?;
    let value = read_value(&mut reader, 0, &mut (MAX_VALUE_BYTES * 4))?;
    if reader.consumed() != data.len() {
        return Err(Error::Malformed("trailing bytes".into()));
    }
    Ok(value)
}
/// Encode a typed document. Portable files use encode_value to retain extensions.
pub fn encode(document: &Document) -> Vec<u8> {
    encode_value(&serde_json::to_value(document).expect("document serializes"))
}
pub fn decode(data: &[u8]) -> Result<Document, Error> {
    serde_json::from_value(decode_value(data)?).map_err(|e| Error::Json(e.to_string()))
}

#[cfg(test)]
pub(crate) mod test_access {
    use super::*;
    pub fn roundtrip_varint(reader: &mut Reader<'_>) -> i64 {
        reader.varint().unwrap()
    }
    pub fn write_varint(writer: &mut Writer, value: i64) {
        writer.varint(value);
    }
    pub fn write_f64s(writer: &mut Writer, values: &[f64]) {
        for v in values {
            writer.f64(*v);
        }
    }
    pub fn read_f64s(reader: &mut Reader<'_>, count: usize) -> Vec<f64> {
        reader.f64_vec(count).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facet::sample_node;

    fn document() -> Document {
        let mut doc = Document {
            reviews: Vec::new(),
            design_system: None,
            prototype: None,
            fd_compatibility: None,
            schema_version: 1,
            color_management: None,
            raster_profile: None,
            id: "d1".into(),
            name: "Doc".into(),
            pages: vec![crate::scene::Page {
                guides: vec![],
                id: "p1".into(),
                name: "Page 1".into(),
                children: vec!["n1".into()],
                background: "#ffffff".into(),
            }],
            nodes: Default::default(),
            fonts: Default::default(),
            animations: Vec::new(),
        };
        let mut page = sample_node("p1", "page");
        page.children = vec!["n1".into()];
        let mut frame = sample_node("n1", "frame");
        frame.name = "Hero".into();
        frame.fills.push(crate::scene::Paint {
            kind: "solid".into(),
            color: "#112233".into(),
            ..crate::scene::Paint {
                transform: None,
                id: String::new(),
                kind: "solid".into(),
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
        });
        doc.nodes.insert("p1".into(), page);
        doc.nodes.insert("n1".into(), frame);
        doc
    }

    #[test]
    fn fd_extensions_survive_typed_binary_admission_and_history() {
        let mut doc = document();
        doc.nodes.remove("p1"); // Codec fixture has a synthetic page node; authored graph must not.
        doc.fd_compatibility = Some(serde_json::from_value(serde_json::json!({
            "contractVersion":1,"requiredCapabilities":[],"extensions":{
                "org.example/metadata":{"array":[null,true,1.25,"文字"],"url":"file:///inert"}
            }
        })).unwrap());
        doc.validate().unwrap();
        let metadata = doc.fd_compatibility.clone();
        crate::layout::resolve(&mut doc, &crate::font::Fonts::new()).unwrap();
        assert_eq!(doc.fd_compatibility, metadata);
        crate::validate_document_json(&serde_json::to_string(&doc).unwrap()).unwrap();
        assert_eq!(decode(&encode(&doc)).unwrap().fd_compatibility, doc.fd_compatibility);
        let mut editor = crate::editing::DocumentEditor::new(doc.clone()).unwrap();
        let mut changed = doc.clone(); changed.name = "Renamed".into();
        editor.apply(0, crate::editing::DocumentPatch::between(&doc, &changed).unwrap()).unwrap();
        assert_eq!(editor.document().fd_compatibility, doc.fd_compatibility);
        editor.undo().unwrap(); editor.redo().unwrap();
        assert_eq!(editor.document().fd_compatibility, doc.fd_compatibility);
        // Envelope changes participate in typed history too; unknown required semantics cannot commit.
        let mut invalid = editor.document().clone();
        invalid.fd_compatibility.as_mut().unwrap().required_capabilities.push("org.example/render".into());
        let patch = crate::editing::DocumentPatch::between(editor.document(), &invalid).unwrap();
        assert!(editor.apply(editor.revision(), patch).is_err());
        assert_eq!(editor.document().fd_compatibility, doc.fd_compatibility);
        assert!(crate::validate_document_json(&serde_json::to_string(&invalid).unwrap()).is_err());
        let mut changed_metadata = editor.document().clone();
        changed_metadata.fd_compatibility.as_mut().unwrap().extensions.insert("org.example/new".into(), serde_json::json!({"safe":true}));
        editor.apply(editor.revision(), crate::editing::DocumentPatch::between(editor.document(), &changed_metadata).unwrap()).unwrap();
        assert_eq!(editor.document().fd_compatibility, changed_metadata.fd_compatibility);
        editor.undo().unwrap(); assert_eq!(editor.document().fd_compatibility, doc.fd_compatibility);
        editor.redo().unwrap(); assert_eq!(editor.document().fd_compatibility, changed_metadata.fd_compatibility);
    }

    #[test]
    fn portable_value_preserves_extensions_nulls_and_precision() {
        let value = serde_json::json!({"schemaVersion":9,"extensions":{"unicode":"玻璃🌈", "null":null,"negative":-0.0,"precise":0.12345678901234567,"large":u64::MAX}});
        assert_eq!(decode_value(&encode_value(&value)).unwrap(), value);
    }
    #[test]
    fn string_table_corruption_is_checked() {
        let mut data = encode_value(&serde_json::json!({"label":"unique-string"}));
        let at = data
            .windows(13)
            .position(|s| s == b"unique-string")
            .unwrap();
        data[at] = b'X';
        assert!(matches!(decode_value(&data), Err(Error::ChecksumMismatch)));
    }
    #[test]
    fn legacy_version_one_is_readable() {
        let value = serde_json::json!({"before":"legacy"});
        let mut data = encode_value(&value);
        let body = Reader::new(&data).unwrap().consumed();
        data[4..6].copy_from_slice(&1u16.to_le_bytes());
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(&data[body..]);
        data[6..14].copy_from_slice(&digest[..8]);
        assert_eq!(decode_value(&data).unwrap(), value);
    }
    #[test]
    fn malformed_value_limits_and_trailing_data_are_rejected() {
        let mut w = Writer::new();
        for _ in 0..130 {
            w.u8(TAG_ARRAY);
            w.varuint(1)
        }
        w.u8(TAG_NULL);
        assert!(decode_value(&w.finish()).is_err());
        let mut w = Writer::new();
        w.u8(TAG_NULL);
        w.u8(TAG_NULL);
        assert!(decode_value(&w.finish()).is_err());
        let mut w = Writer::new();
        w.u8(TAG_FLOAT);
        w.f64(f64::INFINITY);
        assert!(decode_value(&w.finish()).is_err());
        let mut r = Reader::for_body(&[255, 255, 255, 255, 255, 255, 255, 255, 255, 2]);
        assert!(r.varuint().is_err());
    }

    #[test]
    fn round_trips_document() {
        let doc = document();
        let bytes = encode(&doc);
        let decoded = decode(&bytes).unwrap();
        assert_eq!(decoded, doc);
    }

    #[test]
    fn rejects_corruption() {
        let bytes = encode(&document());
        let mut damaged = bytes.clone();
        let last = damaged.len() - 1;
        damaged[last] ^= 0xff;
        assert!(matches!(
            decode(&damaged),
            Err(Error::ChecksumMismatch) | Err(Error::Json(_))
        ));
    }

    #[test]
    fn rejects_bad_magic() {
        let mut bytes = encode(&document());
        bytes[0] = b'X';
        assert!(matches!(decode(&bytes), Err(Error::BadMagic)));
    }

    #[test]
    fn smaller_than_pretty_json_for_repetitive_docs() {
        let mut doc = document();
        for i in 0..60 {
            let mut node = sample_node(&format!("frame-{i}"), "frame");
            node.name = format!("Frame number {i} of the repeated set");
            node.kind = "frame".into();
            doc.nodes.insert(node.id.clone(), node);
        }
        let binary = encode(&doc).len();
        let json = serde_json::to_vec(&doc).unwrap().len();
        assert!(
            binary < json,
            "binary {binary} should beat json {json} on a repetitive document"
        );
    }

    #[test]
    fn varint_helpers_round_trip() {
        use test_access::*;
        let mut writer = Writer::new();
        write_varint(&mut writer, -42);
        write_f64s(&mut writer, &[1.5, -2.5]);
        let bytes = writer.finish();
        let mut reader = Reader::new(&bytes).unwrap();
        assert_eq!(roundtrip_varint(&mut reader), -42);
        assert_eq!(read_f64s(&mut reader, 2), vec![1.5, -2.5]);
    }
}
