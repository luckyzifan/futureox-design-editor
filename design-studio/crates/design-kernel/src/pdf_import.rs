//! Vector PDF import: parse a PDF file's cross-reference structure and page
//! content streams, and rebuild the painted geometry as editable design
//! documents (one `vector` node per painted path, `image` nodes for image
//! XObjects). The parser is written in-tree — no external PDF crate.
//!
//! v1 scope (explicit degradations, never silent masquerades):
//! - text content is not imported (BT/ET, Tj/TJ glyph runs are skipped);
//! - W/W* clipping is parsed as a no-op: clip geometry is dropped;
//! - sh shadings and form XObjects are skipped; only image XObjects run;
//! - ExtGState blend modes and soft masks are dropped; ca/CA map into
//!   node/paint opacity (when ca != CA the higher alpha is clamped);
//! - page /Rotate is not applied;
//! - image XObjects: DCTDecode JPEG passes through as a data URI,
//!   FlateDecode 8-bit DeviceRGB/DeviceGray becomes PNG; anything else
//!   (other filters, CMYK, non-8-bit, SMask) is skipped.
//!
//! Budgets: 64 MB decompressed per stream, 2,000,000 path commands and
//! 40,000 nodes per document — past those the import errors out.
use crate::export::encode_rgba;
use crate::math::{Point, Transform};
use crate::scene::{Document, Edge, Network, Node, Page, Paint, Stroke, Vertex};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

const MAX_STREAM_BYTES: usize = 64 * 1024 * 1024;
const MAX_PATH_COMMANDS: usize = 2_000_000;
const MAX_NODES: u64 = 40_000;
const MAX_XREF_ENTRIES: u64 = 1 << 20;
/// Scene networks admit 10,000 vertices / 20,000 edges; chunk with headroom.
const MAX_NETWORK_VERTICES: usize = 8000;
const SCENE_LIMIT: f64 = 1e7;

// ---------------------------------------------------------------------------
// format detection
// ---------------------------------------------------------------------------

fn header_offset(bytes: &[u8]) -> Option<usize> {
    let scan = &bytes[..bytes.len().min(1024)];
    scan.windows(5).position(|w| w == b"%PDF-")
}

/// A PDF carries a `%PDF-` header within its first 1024 bytes.
pub fn is_pdf_file(bytes: &[u8]) -> bool {
    header_offset(bytes).is_some()
}

// ---------------------------------------------------------------------------
// object model + lexer
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum Obj {
    Null,
    /// Parsed for token correctness; never read (text content is skipped).
    Bool(#[allow(dead_code)] bool),
    Num(f64),
    /// Literal/hex strings are tokenized so operands stay in sync; the
    /// payload is unused because text content is not imported (v1).
    Str(#[allow(dead_code)] Vec<u8>),
    Name(String),
    Array(Vec<Obj>),
    Dict(Vec<(String, Obj)>),
    Ref(u32, u32),
    Keyword(String),
}

impl Obj {
    fn get(&self, key: &str) -> Option<&Obj> {
        let Obj::Dict(pairs) = self else {
            return None;
        };
        pairs.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    fn number(&self) -> Option<f64> {
        match self {
            Obj::Num(n) => Some(*n),
            _ => None,
        }
    }
    fn integer(&self) -> Option<i64> {
        self.number()
            .filter(|n| n.fract() == 0. && n.abs() <= 9.0e15)
            .map(|n| n as i64)
    }
    fn name(&self) -> Option<&str> {
        match self {
            Obj::Name(s) => Some(s),
            _ => None,
        }
    }
    fn array(&self) -> Option<&[Obj]> {
        match self {
            Obj::Array(v) => Some(v),
            _ => None,
        }
    }
    fn reference(&self) -> Option<(u32, u32)> {
        match self {
            Obj::Ref(n, g) => Some((*n, *g)),
            _ => None,
        }
    }
    fn is_name(&self, name: &str) -> bool {
        matches!(self, Obj::Name(s) if s == name)
    }
}

fn is_ws(c: u8) -> bool {
    matches!(c, 0 | b'\t' | b'\n' | 0x0c | b'\r' | b' ')
}

fn is_delim(c: u8) -> bool {
    matches!(
        c,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

fn hex_digit(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Byte-level cursor over PDF syntax (objects, streams and content streams
/// share one lexer).
struct Parser<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Parser<'a> {
    fn new(b: &'a [u8]) -> Self {
        Self { b, p: 0 }
    }
    fn eof(&self) -> bool {
        self.p >= self.b.len()
    }
    fn byte(&self) -> Option<u8> {
        self.b.get(self.p).copied()
    }
    fn skip_ws(&mut self) {
        while let Some(c) = self.byte() {
            if is_ws(c) {
                self.p += 1;
            } else if c == b'%' {
                while let Some(c) = self.byte()
                    && !matches!(c, b'\n' | b'\r')
                {
                    self.p += 1;
                }
            } else {
                break;
            }
        }
    }
    /// Run of regular characters (operators like `f*`, `Tj`, `obj`, `stream`).
    fn keyword(&mut self) -> String {
        let start = self.p;
        while let Some(c) = self.byte()
            && !is_ws(c)
            && !is_delim(c)
        {
            self.p += 1;
        }
        String::from_utf8_lossy(&self.b[start..self.p]).into_owned()
    }
    fn number(&mut self) -> Result<f64, String> {
        let start = self.p;
        if matches!(self.byte(), Some(b'+' | b'-')) {
            self.p += 1;
        }
        while matches!(self.byte(), Some(b'0'..=b'9')) {
            self.p += 1;
        }
        if self.byte() == Some(b'.') {
            self.p += 1;
            while matches!(self.byte(), Some(b'0'..=b'9')) {
                self.p += 1;
            }
        }
        let text = std::str::from_utf8(&self.b[start..self.p])
            .map_err(|_| "malformed pdf number".to_string())?;
        if text.is_empty() || text == "+" || text == "-" || text == "." {
            return Err("malformed pdf number".into());
        }
        text.parse::<f64>()
            .map_err(|_| "malformed pdf number".into())
    }
    fn name(&mut self) -> Result<String, String> {
        self.p += 1; // '/'
        let mut out = String::new();
        while let Some(c) = self.byte()
            && !is_ws(c)
            && !is_delim(c)
        {
            self.p += 1;
            if c == b'#'
                && let (Some(hi), Some(lo)) = (
                    self.byte().and_then(hex_digit),
                    self.b.get(self.p + 1).copied().and_then(hex_digit),
                )
            {
                self.p += 2;
                out.push((hi * 16 + lo) as char);
            } else {
                out.push(c as char);
            }
        }
        Ok(out)
    }
    fn literal_string(&mut self) -> Result<Vec<u8>, String> {
        self.p += 1; // '('
        let mut depth = 1u32;
        let mut out = Vec::new();
        while depth > 0 {
            let Some(c) = self.byte() else {
                return Err("unterminated pdf string".into());
            };
            self.p += 1;
            match c {
                b'(' => {
                    depth += 1;
                    out.push(b'(');
                }
                b')' => {
                    depth -= 1;
                    if depth > 0 {
                        out.push(b')');
                    }
                }
                b'\\' => {
                    let Some(e) = self.byte() else {
                        return Err("unterminated pdf string escape".into());
                    };
                    self.p += 1;
                    match e {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'(' | b')' | b'\\' => out.push(e),
                        b'0'..=b'7' => {
                            let mut v = u32::from(e - b'0');
                            let mut extra = 0;
                            while extra < 2
                                && let Some(d @ b'0'..=b'7') = self.byte()
                            {
                                v = v * 8 + u32::from(d - b'0');
                                self.p += 1;
                                extra += 1;
                            }
                            out.push((v & 0xff) as u8);
                        }
                        // line continuation
                        b'\n' => {}
                        b'\r' => {
                            if self.byte() == Some(b'\n') {
                                self.p += 1;
                            }
                        }
                        _ => out.push(e),
                    }
                }
                _ => out.push(c),
            }
        }
        Ok(out)
    }
    fn hex_string(&mut self) -> Result<Vec<u8>, String> {
        self.p += 1; // '<'
        let mut digits: Vec<u8> = Vec::new();
        let mut closed = false;
        while let Some(c) = self.byte() {
            self.p += 1;
            if c == b'>' {
                closed = true;
                break;
            }
            if let Some(v) = hex_digit(c) {
                digits.push(v);
            }
        }
        if !closed {
            return Err("unterminated pdf hex string".into());
        }
        if digits.len() % 2 == 1 {
            digits.push(0);
        }
        Ok(digits.chunks(2).map(|p| p[0] * 16 + p[1]).collect())
    }
    fn parse_object(&mut self) -> Result<Obj, String> {
        self.skip_ws();
        match self.byte() {
            None => Err("unexpected end of pdf data".into()),
            Some(b'[') => {
                self.p += 1;
                let mut items = Vec::new();
                loop {
                    self.skip_ws();
                    if self.byte() == Some(b']') {
                        self.p += 1;
                        break;
                    }
                    if self.eof() {
                        return Err("unterminated pdf array".into());
                    }
                    items.push(self.parse_value()?);
                }
                Ok(Obj::Array(items))
            }
            Some(b'<') if self.b.get(self.p + 1) == Some(&b'<') => {
                self.p += 2;
                let mut pairs = Vec::new();
                loop {
                    self.skip_ws();
                    if self.b[self.p.min(self.b.len())..].starts_with(b">>") {
                        self.p += 2;
                        break;
                    }
                    if self.eof() {
                        return Err("unterminated pdf dictionary".into());
                    }
                    if self.byte() != Some(b'/') {
                        return Err("pdf dictionary keys must be names".into());
                    }
                    let key = self.name()?;
                    let value = self.parse_value()?;
                    pairs.push((key, value));
                }
                Ok(Obj::Dict(pairs))
            }
            Some(b'/') => Ok(Obj::Name(self.name()?)),
            Some(b'(') => Ok(Obj::Str(self.literal_string()?)),
            Some(b'<') => Ok(Obj::Str(self.hex_string()?)),
            Some(c) if c == b'+' || c == b'-' || c == b'.' || c.is_ascii_digit() => {
                Ok(Obj::Num(self.number()?))
            }
            Some(_) => match self.keyword().as_str() {
                "true" => Ok(Obj::Bool(true)),
                "false" => Ok(Obj::Bool(false)),
                "null" => Ok(Obj::Null),
                "" => Err("malformed pdf token".into()),
                other => Ok(Obj::Keyword(other.into())),
            },
        }
    }
    /// Dictionary/array value: a direct object, or `num gen R` indirect ref.
    fn parse_value(&mut self) -> Result<Obj, String> {
        let first = self.parse_object()?;
        if let Obj::Num(n) = first
            && (0.0..=u32::MAX as f64).contains(&n)
            && n.fract() == 0.
        {
            let save = self.p;
            if let Ok(Obj::Num(g)) = self.parse_object()
                && (0.0..=u32::MAX as f64).contains(&g)
                && g.fract() == 0.
                && {
                    self.skip_ws();
                    self.byte() == Some(b'R')
                        && !self
                            .b
                            .get(self.p + 1)
                            .is_some_and(|&c| !is_ws(c) && !is_delim(c))
                }
            {
                self.p += 1;
                return Ok(Obj::Ref(n as u32, g as u32));
            }
            self.p = save;
        }
        Ok(first)
    }
}

// ---------------------------------------------------------------------------
// file structure: xref tables/streams, indirect objects, object streams
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum Entry {
    Offset(u64),
    Compressed { stream: u32, index: u32 },
}

enum PdfObject {
    Plain(Obj),
    Stream { dict: Obj, data: Rc<Vec<u8>> },
}

/// Cached decode result: (stream dict, decoded payload).
type DecodedStream = Rc<(Obj, Rc<Vec<u8>>)>;

struct PageSpec {
    media: [f64; 4],
    contents: Vec<u32>,
    resources: Obj,
}

struct PdfFile<'a> {
    bytes: &'a [u8],
    entries: BTreeMap<u32, Entry>,
    root: Option<(u32, u32)>,
    cache: HashMap<u32, Rc<PdfObject>>,
    decoded: HashMap<u32, DecodedStream>,
    busy: Vec<u32>,
    version: String,
}

impl<'a> PdfFile<'a> {
    fn new(bytes: &'a [u8]) -> Result<PdfFile<'a>, String> {
        let offset = header_offset(bytes).ok_or("missing pdf header")?;
        let mut end = offset + 5;
        while end < bytes.len()
            && end < offset + 13
            && (bytes[end].is_ascii_digit() || bytes[end] == b'.')
        {
            end += 1;
        }
        let version = std::str::from_utf8(&bytes[offset + 5..end]).unwrap_or("1.4");
        let version = if version.contains('.') {
            version.to_string()
        } else {
            "1.4".into()
        };
        let marker = bytes
            .windows(9)
            .rposition(|w| w == b"startxref")
            .ok_or("pdf missing startxref")?;
        let mut parser = Parser::new(bytes);
        parser.p = marker + 9;
        parser.skip_ws();
        let start = parser.number()? as u64;

        let mut file = PdfFile {
            bytes,
            entries: BTreeMap::new(),
            root: None,
            cache: HashMap::new(),
            decoded: HashMap::new(),
            busy: Vec::new(),
            version,
        };
        let mut trailer = file.load_xref(start)?;
        if trailer.get("Encrypt").is_some() {
            return Err("encrypted pdf documents are not supported".into());
        }
        if let Some(r) = trailer.get("Root").and_then(Obj::reference) {
            file.root = Some(r);
        }
        let mut prev = trailer.get("Prev").and_then(Obj::integer);
        let mut hops = 0;
        while let Some(p) = prev {
            hops += 1;
            if hops > 32 {
                return Err("pdf xref chain too long".into());
            }
            trailer = file.load_xref(p.max(0) as u64)?;
            if file.root.is_none()
                && let Some(r) = trailer.get("Root").and_then(Obj::reference)
            {
                file.root = Some(r);
            }
            prev = trailer.get("Prev").and_then(Obj::integer);
        }
        if file.root.is_none() {
            return Err("pdf trailer missing /Root".into());
        }
        Ok(file)
    }

    fn load_xref(&mut self, offset: u64) -> Result<Obj, String> {
        if offset as usize >= self.bytes.len() {
            return Err("pdf xref offset out of range".into());
        }
        let bytes = self.bytes;
        let mut parser = Parser::new(bytes);
        parser.p = offset as usize;
        parser.skip_ws();
        match parser.byte() {
            Some(b'x') => {
                if parser.keyword() != "xref" {
                    return Err("invalid pdf xref section".into());
                }
                self.classic_xref(&mut parser)
            }
            Some(c) if c.is_ascii_digit() => self.xref_stream(offset),
            _ => Err("invalid pdf xref section".into()),
        }
    }

    fn classic_xref(&mut self, parser: &mut Parser<'_>) -> Result<Obj, String> {
        let mut seen: u64 = 0;
        loop {
            parser.skip_ws();
            match parser.byte() {
                None => return Err("pdf xref table missing trailer".into()),
                Some(b't') => {
                    if parser.keyword() != "trailer" {
                        return Err("malformed pdf xref table".into());
                    }
                    let trailer = parser.parse_object()?;
                    // Hybrid-reference files keep extra entries in a stream.
                    if let Some(x) = trailer.get("XRefStm").and_then(Obj::integer) {
                        let _ = self.xref_stream(x.max(0) as u64)?;
                    }
                    return Ok(trailer);
                }
                Some(c) if c.is_ascii_digit() || c == b'+' || c == b'-' => {
                    let first = parser.number()?;
                    parser.skip_ws();
                    let count = parser.number()?;
                    if first < 0. || count < 0. {
                        return Err("malformed pdf xref subsection".into());
                    }
                    for i in 0..count as u64 {
                        parser.skip_ws();
                        let off = parser.number()?;
                        parser.skip_ws();
                        let _generation = parser.number()?;
                        parser.skip_ws();
                        seen += 1;
                        if seen > MAX_XREF_ENTRIES {
                            return Err("pdf xref entry budget exceeded".into());
                        }
                        match parser.byte() {
                            Some(b'n') => {
                                parser.p += 1;
                                let key = first as u64 + i;
                                if off >= 0. && key <= u32::MAX as u64 {
                                    self.entries
                                        .entry(key as u32)
                                        .or_insert(Entry::Offset(off as u64));
                                }
                            }
                            Some(b'f') => parser.p += 1,
                            _ => return Err("malformed pdf xref entry".into()),
                        }
                    }
                }
                _ => return Err("malformed pdf xref table".into()),
            }
        }
    }

    fn xref_stream(&mut self, offset: u64) -> Result<Obj, String> {
        let (_, object) = self.parse_indirect(offset)?;
        let PdfObject::Stream { dict, data } = object else {
            return Err("pdf cross-reference stream expected".into());
        };
        let widths: Vec<usize> = dict
            .get("W")
            .and_then(Obj::array)
            .map(|a| {
                a.iter()
                    .filter_map(|o| o.integer().map(|v| v.max(0) as usize))
                    .collect()
            })
            .unwrap_or_default();
        let row: usize = widths.iter().sum();
        if widths.len() != 3 || widths.iter().any(|w| *w > 8) || row == 0 {
            return Err("malformed pdf xref stream widths".into());
        }
        let decoded = decode_stream(&dict, &data).map_err(|e| {
            if e.starts_with("unsupported stream filter") {
                "Unsupported PDF cross-reference stream".to_string()
            } else {
                e
            }
        })?;
        let size = dict.get("Size").and_then(Obj::integer).unwrap_or(0).max(0);
        let mut index: Vec<i64> = dict
            .get("Index")
            .and_then(Obj::array)
            .map(|a| a.iter().filter_map(Obj::integer).collect())
            .unwrap_or_default();
        if index.is_empty() {
            index = vec![0, size];
        }
        let mut pos = 0usize;
        let mut seen: u64 = 0;
        for chunk in index.chunks(2) {
            if chunk.len() != 2 {
                return Err("malformed pdf xref stream index".into());
            }
            let first = chunk[0].max(0) as u64;
            for i in 0..chunk[1].max(0) as u64 {
                if pos + row > decoded.len() {
                    return Err("truncated pdf xref stream".into());
                }
                seen += 1;
                if seen > MAX_XREF_ENTRIES {
                    return Err("pdf xref entry budget exceeded".into());
                }
                let entry = &decoded[pos..pos + row];
                let kind = if widths[0] > 0 {
                    read_field(entry, 0, widths[0])
                } else {
                    1
                };
                let field1 = read_field(entry, widths[0], widths[1]);
                let field2 = read_field(entry, widths[0] + widths[1], widths[2]);
                let key = first + i;
                if key <= u32::MAX as u64 {
                    match kind {
                        1 => {
                            self.entries
                                .entry(key as u32)
                                .or_insert(Entry::Offset(field1));
                        }
                        2 => {
                            self.entries.entry(key as u32).or_insert(Entry::Compressed {
                                stream: field1.min(u32::MAX as u64) as u32,
                                index: field2.min(u32::MAX as u64) as u32,
                            });
                        }
                        _ => {}
                    }
                }
                pos += row;
            }
        }
        Ok(dict)
    }

    /// Read `num gen obj` at a byte offset; stream payloads are kept raw.
    fn parse_indirect(&mut self, offset: u64) -> Result<(u32, PdfObject), String> {
        let bytes = self.bytes;
        if offset as usize >= bytes.len() {
            return Err("pdf object offset out of range".into());
        }
        let mut parser = Parser::new(bytes);
        parser.p = offset as usize;
        parser.skip_ws();
        let num = parser.number()?;
        parser.skip_ws();
        let generation = parser.number()?;
        if !(0.0..=u32::MAX as f64).contains(&num) || num.fract() != 0. {
            return Err("malformed pdf object number".into());
        }
        let _ = generation;
        parser.skip_ws();
        if parser.keyword() != "obj" {
            return Err("malformed pdf object header".into());
        }
        parser.skip_ws();
        let body = parser.parse_object()?;
        parser.skip_ws();
        let object = if parser.byte() == Some(b's') && parser.keyword() == "stream" {
            if parser.byte() == Some(b'\r') {
                parser.p += 1;
            }
            if parser.byte() == Some(b'\n') {
                parser.p += 1;
            }
            let start = parser.p;
            let length = match body.get("Length") {
                Some(v) => Some(self.resolve_length(v)?),
                None => None,
            };
            let end = match length {
                Some(len) if start + len <= bytes.len() && stream_ends_at(bytes, start + len) => {
                    start + len
                }
                _ => bytes[start..]
                    .windows(9)
                    .position(|w| w == b"endstream")
                    .map(|i| start + i)
                    .ok_or("pdf stream missing endstream")?,
            };
            let mut data_end = end;
            if data_end > start && bytes[data_end - 1] == b'\n' {
                data_end -= 1;
            }
            if data_end > start && bytes[data_end - 1] == b'\r' {
                data_end -= 1;
            }
            PdfObject::Stream {
                dict: body,
                data: Rc::new(bytes[start..data_end].to_vec()),
            }
        } else {
            PdfObject::Plain(body)
        };
        Ok((num as u32, object))
    }

    fn resolve_length(&mut self, value: &Obj) -> Result<usize, String> {
        let resolved = self.resolve(value)?;
        resolved
            .integer()
            .filter(|v| *v >= 0)
            .map(|v| v as usize)
            .ok_or_else(|| "malformed pdf stream length".into())
    }

    fn object(&mut self, num: u32) -> Result<Rc<PdfObject>, String> {
        if let Some(hit) = self.cache.get(&num) {
            return Ok(hit.clone());
        }
        if self.busy.contains(&num) {
            return Err("cyclic pdf object reference".into());
        }
        if self.busy.len() > 64 {
            return Err("pdf object nesting too deep".into());
        }
        let entry = self
            .entries
            .get(&num)
            .cloned()
            .ok_or(format!("pdf object {num} not found"))?;
        self.busy.push(num);
        let result = match entry {
            Entry::Offset(off) => self.parse_indirect(off).map(|(_, o)| Rc::new(o)),
            Entry::Compressed { stream, index } => self.object_in_stream(stream, index),
        };
        self.busy.pop();
        let rc = result?;
        self.cache.insert(num, rc.clone());
        Ok(rc)
    }

    fn object_in_stream(&mut self, stream: u32, index: u32) -> Result<Rc<PdfObject>, String> {
        let payload = self.decoded_stream(stream)?;
        let (dict, data) = (&payload.0, &payload.1);
        let count = dict
            .get("N")
            .and_then(Obj::integer)
            .filter(|v| *v >= 0)
            .ok_or("pdf object stream missing /N")? as usize;
        let first = dict
            .get("First")
            .and_then(Obj::integer)
            .filter(|v| *v >= 0)
            .ok_or("pdf object stream missing /First")? as usize;
        let mut parser = Parser::new(data);
        let mut found = None;
        for member in 0..count {
            let num = parser.number()?;
            parser.skip_ws();
            let off = parser.number()?;
            if member as u32 == index && num.fract() == 0. && num >= 0. {
                found = Some(off as usize);
            }
        }
        let off = found.ok_or("pdf object stream index out of range")?;
        if first + off > data.len() {
            return Err("pdf object stream member out of range".into());
        }
        parser.p = first + off;
        let object = parser.parse_object()?;
        Ok(Rc::new(PdfObject::Plain(object)))
    }

    /// Fetch a stream object with its payload decoded (cached per object).
    fn decoded_stream(&mut self, num: u32) -> Result<DecodedStream, String> {
        if let Some(hit) = self.decoded.get(&num) {
            return Ok(hit.clone());
        }
        let object = self.object(num)?;
        let PdfObject::Stream { dict, data } = &*object else {
            return Err(format!("pdf object {num} is not a stream"));
        };
        let bytes = decode_stream(dict, data)?;
        let entry = Rc::new((dict.clone(), Rc::new(bytes)));
        self.decoded.insert(num, entry.clone());
        Ok(entry)
    }

    /// Follow one indirect-reference hop; stream targets resolve to their dict.
    fn resolve(&mut self, obj: &Obj) -> Result<Obj, String> {
        match obj {
            Obj::Ref(n, _) => {
                let rc = self.object(*n)?;
                match &*rc {
                    PdfObject::Plain(o) => Ok(o.clone()),
                    PdfObject::Stream { dict, .. } => Ok(dict.clone()),
                }
            }
            _ => Ok(obj.clone()),
        }
    }

    fn collect_pages(
        &mut self,
        node: &Obj,
        media: Option<[f64; 4]>,
        resources: Option<Obj>,
        out: &mut Vec<PageSpec>,
        depth: usize,
        seen: &mut HashSet<u32>,
    ) -> Result<(), String> {
        if depth > 64 {
            return Err("pdf page tree too deep".into());
        }
        let node = self.resolve(node)?;
        if !matches!(node, Obj::Dict(_)) {
            return Err("pdf page tree node must be a dictionary".into());
        }
        let media = match node.get("MediaBox").cloned() {
            Some(value) => {
                let resolved = self.resolve(&value)?;
                Some(parse_media_box(&resolved)?)
            }
            None => media,
        };
        let resources = match node.get("Resources").cloned() {
            Some(value) => Some(self.resolve(&value)?),
            None => resources,
        };
        if let Some(kids) = node.get("Kids").and_then(Obj::array) {
            for kid in kids {
                if let Some((num, _)) = kid.reference()
                    && !seen.insert(num)
                {
                    return Err("cyclic pdf page tree".into());
                }
                self.collect_pages(kid, media, resources.clone(), out, depth + 1, seen)?;
            }
            return Ok(());
        }
        let media = media.ok_or("pdf page missing media box")?;
        let mut contents = Vec::new();
        match node.get("Contents") {
            Some(Obj::Ref(n, _)) => contents.push(*n),
            Some(Obj::Array(items)) => {
                for item in items {
                    if let Some((n, _)) = item.reference() {
                        contents.push(n);
                    }
                }
            }
            _ => {}
        }
        out.push(PageSpec {
            media,
            contents,
            resources: resources.unwrap_or(Obj::Null),
        });
        Ok(())
    }
}

fn stream_ends_at(bytes: &[u8], pos: usize) -> bool {
    let mut p = pos;
    while matches!(bytes.get(p), Some(b'\r' | b'\n' | b' ' | b'\t' | &0)) {
        p += 1;
    }
    bytes[p..].starts_with(b"endstream")
}

fn parse_media_box(obj: &Obj) -> Result<[f64; 4], String> {
    let values = obj
        .array()
        .and_then(|a| {
            a.iter()
                .map(Obj::number)
                .collect::<Option<Vec<f64>>>()
                .filter(|v| v.len() == 4)
        })
        .ok_or("invalid pdf media box")?;
    if values.iter().any(|v| !v.is_finite())
        || values[2] <= values[0]
        || values[3] <= values[1]
        || values.iter().any(|v| v.abs() > SCENE_LIMIT)
    {
        return Err("invalid pdf media box".into());
    }
    Ok([values[0], values[1], values[2], values[3]])
}

fn read_field(row: &[u8], start: usize, len: usize) -> u64 {
    let mut v = 0u64;
    for i in 0..len {
        v = (v << 8) | row[start + i] as u64;
    }
    v
}

fn decode_stream(dict: &Obj, raw: &[u8]) -> Result<Vec<u8>, String> {
    let filter = match dict.get("Filter") {
        None => return Ok(raw.to_vec()),
        Some(Obj::Name(n)) => vec![n.clone()],
        Some(Obj::Array(items)) => items
            .iter()
            .filter_map(|o| o.name().map(str::to_string))
            .collect(),
        Some(_) => return Err("malformed pdf stream filter".into()),
    };
    if filter.len() != 1 || filter[0] != "FlateDecode" {
        return Err(format!("unsupported stream filter: {}", filter.join(" ")));
    }
    let mut data = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(raw, MAX_STREAM_BYTES)
        .map_err(|_| "pdf flate stream decompression failed".to_string())?;
    if let Some(parms) = dict.get("DecodeParms").or_else(|| dict.get("DP")) {
        let parms = match parms {
            Obj::Array(a) => a.first().cloned().unwrap_or(Obj::Null),
            other => other.clone(),
        };
        let predictor = parms.get("Predictor").and_then(Obj::integer).unwrap_or(1);
        let columns = parms
            .get("Columns")
            .and_then(Obj::integer)
            .unwrap_or(1)
            .max(1) as usize;
        let colors = parms
            .get("Colors")
            .and_then(Obj::integer)
            .unwrap_or(1)
            .max(1) as usize;
        let bpc = parms
            .get("BitsPerComponent")
            .and_then(Obj::integer)
            .unwrap_or(8)
            .max(1) as usize;
        match predictor {
            1 => {}
            12 => data = png_unpredict(&data, colors, bpc, columns)?,
            _ => return Err("unsupported pdf stream predictor".into()),
        }
    }
    Ok(data)
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let (a, b, c) = (i16::from(a), i16::from(b), i16::from(c));
    let p = a + b - c;
    let (pa, pb, pc) = ((p - a).abs(), (p - b).abs(), (p - c).abs());
    if pa <= pb && pa <= pc {
        a as u8
    } else if pb <= pc {
        b as u8
    } else {
        c as u8
    }
}

/// Undo PNG row predictors (xref streams with /Predictor 12).
fn png_unpredict(
    data: &[u8],
    colors: usize,
    bpc: usize,
    columns: usize,
) -> Result<Vec<u8>, String> {
    let bpp = (colors * bpc).div_ceil(8);
    let row_len = 1 + columns * bpp;
    if bpp == 0 || data.is_empty() || !data.len().is_multiple_of(row_len) {
        return Err("malformed predicted pdf stream".into());
    }
    let width = columns * bpp;
    let mut out = Vec::with_capacity(data.len() - data.len() / row_len);
    for row in data.chunks_exact(row_len) {
        let filter = row[0];
        let src = &row[1..];
        let prev_start = out.len().checked_sub(width);
        for (i, &v) in src.iter().enumerate() {
            let left = if i >= bpp { out[out.len() - bpp] } else { 0 };
            let (up, upper_left) = match prev_start {
                Some(base) => (
                    out[base + i],
                    if i >= bpp { out[base + i - bpp] } else { 0 },
                ),
                None => (0, 0),
            };
            let byte = match filter {
                0 => v,
                1 => v.wrapping_add(left),
                2 => v.wrapping_add(up),
                3 => v.wrapping_add(((u16::from(left) + u16::from(up)) / 2) as u8),
                4 => v.wrapping_add(paeth(left, up, upper_left)),
                _ => return Err("malformed pdf predictor".into()),
            };
            out.push(byte);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// content stream interpretation
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Space {
    Gray,
    Rgb,
    Cmyk,
    Unsupported,
}

#[derive(Clone)]
struct GraphicsState {
    ctm: Transform,
    fill: [f64; 3],
    stroke: [f64; 3],
    fill_space: Space,
    stroke_space: Space,
    line_width: f64,
    fill_alpha: f64,
    stroke_alpha: f64,
}

impl Default for GraphicsState {
    fn default() -> Self {
        // PDF initial color space is DeviceGray with black paint.
        Self {
            ctm: Transform::default(),
            fill: [0., 0., 0.],
            stroke: [0., 0., 0.],
            fill_space: Space::Gray,
            stroke_space: Space::Gray,
            line_width: 1.,
            fill_alpha: 1.,
            stroke_alpha: 1.,
        }
    }
}

#[derive(Clone)]
enum Segment {
    Line(Point),
    Cubic { c1: Point, c2: Point, to: Point },
}

#[derive(Clone)]
struct Subpath {
    start: Point,
    segments: Vec<Segment>,
    closed: bool,
}

#[derive(Clone, Copy)]
struct PaintOp {
    fill: bool,
    stroke: bool,
    close: bool,
    evenodd: bool,
}

enum Operand {
    Num(f64),
    Name(String),
    Other,
}

fn to_operand(obj: Obj) -> Operand {
    match obj {
        Obj::Num(n) => Operand::Num(n),
        Obj::Name(s) => Operand::Name(s),
        _ => Operand::Other,
    }
}

fn trailing_numbers(operands: &[Operand], count: usize) -> Option<Vec<f64>> {
    if operands.len() < count {
        return None;
    }
    operands[operands.len() - count..]
        .iter()
        .map(|o| match o {
            Operand::Num(n) => Some(*n),
            _ => None,
        })
        .collect()
}

fn clamp_unit(v: f64) -> f64 {
    v.clamp(0., 1.)
}

fn rgb_from_gray(v: f64) -> [f64; 3] {
    [v, v, v]
}

fn rgb_from_cmyk(c: f64, m: f64, y: f64, k: f64) -> [f64; 3] {
    let (c, m, y, k) = (clamp_unit(c), clamp_unit(m), clamp_unit(y), clamp_unit(k));
    [
        (1. - c) * (1. - k),
        (1. - m) * (1. - k),
        (1. - y) * (1. - k),
    ]
}

fn color_hex(rgb: [f64; 3]) -> String {
    let bytes = rgb.map(|c| (clamp_unit(c) * 255.).round() as u8);
    format!("#{:02x}{:02x}{:02x}", bytes[0], bytes[1], bytes[2])
}

fn solid_paint(color: [f64; 3], opacity: f64) -> Paint {
    Paint {
        transform: None,
        id: String::new(),
        kind: "solid".into(),
        color: color_hex(color),
        opacity: clamp_unit(opacity),
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

fn data_uri(mime: &str, bytes: &[u8]) -> String {
    use base64::Engine;
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

#[derive(Default)]
struct Builder {
    nodes: BTreeMap<String, Node>,
    next_id: u64,
    commands: usize,
}

impl Builder {
    fn fresh_id(&mut self) -> Result<String, String> {
        if self.next_id >= MAX_NODES {
            return Err("pdf node budget exceeded".into());
        }
        self.next_id += 1;
        Ok(format!("pdf-{}", self.next_id))
    }
}

struct Runner<'a, 'f> {
    file: &'f mut PdfFile<'a>,
    resources: Obj,
    /// PDF page space (y-up) → design page space (y-down).
    flip: Transform,
    builder: &'f mut Builder,
    children: &'f mut Vec<String>,
    state: GraphicsState,
    stack: Vec<GraphicsState>,
    path: Vec<Subpath>,
    pen: Option<Point>,
    last_c2: Option<Point>,
}

impl<'a, 'f> Runner<'a, 'f> {
    fn new(
        file: &'f mut PdfFile<'a>,
        resources: Obj,
        media: [f64; 4],
        builder: &'f mut Builder,
        children: &'f mut Vec<String>,
    ) -> Self {
        Self {
            file,
            resources,
            flip: Transform([1., 0., 0., -1., -media[0], media[3]]),
            builder,
            children,
            state: GraphicsState::default(),
            stack: Vec::new(),
            path: Vec::new(),
            pen: None,
            last_c2: None,
        }
    }

    fn run_stream(&mut self, num: u32) -> Result<(), String> {
        let payload = self.file.decoded_stream(num)?;
        let mut parser = Parser::new(&payload.1);
        let mut operands: Vec<Operand> = Vec::new();
        loop {
            parser.skip_ws();
            if parser.eof() {
                break;
            }
            let token = parser.parse_object()?;
            match token {
                Obj::Keyword(op) => {
                    if op == "BI" {
                        skip_inline_image(&mut parser)?;
                    } else {
                        self.execute(&op, &operands)?;
                    }
                    operands.clear();
                }
                other => operands.push(to_operand(other)),
            }
        }
        Ok(())
    }

    fn execute(&mut self, op: &str, operands: &[Operand]) -> Result<(), String> {
        match op {
            // graphics state
            "q" => self.stack.push(self.state.clone()),
            "Q" => {
                if let Some(state) = self.stack.pop() {
                    self.state = state;
                }
            }
            "cm" => {
                if let Some(n) = trailing_numbers(operands, 6)
                    && n.iter().all(|v| v.is_finite())
                {
                    let m = Transform([n[0], n[1], n[2], n[3], n[4], n[5]]);
                    // cm concatenates before the current CTM.
                    self.state.ctm = self.state.ctm.concat(m);
                }
            }
            "w" => {
                if let Some(n) = trailing_numbers(operands, 1) {
                    self.state.line_width = n[0];
                }
            }
            "gs" => {
                if let [.., Operand::Name(name)] = operands {
                    self.apply_extgstate(name)?;
                }
            }
            // color spaces and colors
            "cs" => {
                if let [.., Operand::Name(name)] = operands {
                    self.state.fill_space = self.space_of(name);
                }
            }
            "CS" => {
                if let [.., Operand::Name(name)] = operands {
                    self.state.stroke_space = self.space_of(name);
                }
            }
            "sc" | "scn" => self.set_space_color(operands, true),
            "SC" | "SCN" => self.set_space_color(operands, false),
            "rg" => {
                if let Some(n) = trailing_numbers(operands, 3) {
                    self.state.fill = [clamp_unit(n[0]), clamp_unit(n[1]), clamp_unit(n[2])];
                    self.state.fill_space = Space::Rgb;
                }
            }
            "RG" => {
                if let Some(n) = trailing_numbers(operands, 3) {
                    self.state.stroke = [clamp_unit(n[0]), clamp_unit(n[1]), clamp_unit(n[2])];
                    self.state.stroke_space = Space::Rgb;
                }
            }
            "g" => {
                if let Some(n) = trailing_numbers(operands, 1) {
                    self.state.fill = rgb_from_gray(clamp_unit(n[0]));
                    self.state.fill_space = Space::Gray;
                }
            }
            "G" => {
                if let Some(n) = trailing_numbers(operands, 1) {
                    self.state.stroke = rgb_from_gray(clamp_unit(n[0]));
                    self.state.stroke_space = Space::Gray;
                }
            }
            "k" => {
                if let Some(n) = trailing_numbers(operands, 4) {
                    self.state.fill = rgb_from_cmyk(n[0], n[1], n[2], n[3]);
                    self.state.fill_space = Space::Cmyk;
                }
            }
            "K" => {
                if let Some(n) = trailing_numbers(operands, 4) {
                    self.state.stroke = rgb_from_cmyk(n[0], n[1], n[2], n[3]);
                    self.state.stroke_space = Space::Cmyk;
                }
            }
            // path construction
            "m" => {
                if let Some(n) = trailing_numbers(operands, 2) {
                    self.op_move(Point::new(n[0], n[1]))?;
                }
            }
            "l" => {
                if let Some(n) = trailing_numbers(operands, 2) {
                    self.op_line(Point::new(n[0], n[1]))?;
                }
            }
            "c" => {
                if let Some(n) = trailing_numbers(operands, 6) {
                    self.op_cubic(
                        Point::new(n[0], n[1]),
                        Point::new(n[2], n[3]),
                        Point::new(n[4], n[5]),
                    )?;
                }
            }
            "v" => {
                if let Some(n) = trailing_numbers(operands, 4) {
                    let pen = self.pen.unwrap_or_default();
                    let c1 = self
                        .last_c2
                        .map(|c2| Point::new(2. * pen.x - c2.x, 2. * pen.y - c2.y))
                        .unwrap_or(pen);
                    self.op_cubic(c1, Point::new(n[0], n[1]), Point::new(n[2], n[3]))?;
                }
            }
            "y" => {
                if let Some(n) = trailing_numbers(operands, 4) {
                    let to = Point::new(n[2], n[3]);
                    self.op_cubic(Point::new(n[0], n[1]), to, to)?;
                }
            }
            "re" => {
                if let Some(n) = trailing_numbers(operands, 4) {
                    self.op_rect(n[0], n[1], n[2], n[3])?;
                }
            }
            "h" => self.op_close(),
            // path painting
            "f" | "F" => self.emit_path(PaintOp {
                fill: true,
                stroke: false,
                close: false,
                evenodd: false,
            })?,
            "f*" => self.emit_path(PaintOp {
                fill: true,
                stroke: false,
                close: false,
                evenodd: true,
            })?,
            "B" => self.emit_path(PaintOp {
                fill: true,
                stroke: true,
                close: false,
                evenodd: false,
            })?,
            "B*" => self.emit_path(PaintOp {
                fill: true,
                stroke: true,
                close: false,
                evenodd: true,
            })?,
            "b" => self.emit_path(PaintOp {
                fill: true,
                stroke: true,
                close: true,
                evenodd: false,
            })?,
            "b*" => self.emit_path(PaintOp {
                fill: true,
                stroke: true,
                close: true,
                evenodd: true,
            })?,
            "S" => self.emit_path(PaintOp {
                fill: false,
                stroke: true,
                close: false,
                evenodd: false,
            })?,
            "s" => self.emit_path(PaintOp {
                fill: false,
                stroke: true,
                close: true,
                evenodd: false,
            })?,
            "n" => self.path.clear(),
            // W/W* set a clip that v1 drops (see module docs); sh (shading),
            // text state/show operators and marked content are skipped.
            "W" | "W*" | "sh" | "BT" | "ET" | "Tj" | "TJ" | "Tf" | "Td" | "TD" | "Tm" | "T*"
            | "TL" | "Tc" | "Tw" | "Tz" | "Ts" | "Tr" | "'" | "\"" | "MP" | "DP" | "BMC"
            | "BDC" | "EMC" | "BX" | "EX" | "j" | "J" | "M" | "d" | "ri" | "i" => {}
            "Do" => {
                if let [.., Operand::Name(name)] = operands {
                    self.draw_xobject(name)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn resource_entry(&self, category: &str, name: &str) -> Option<Obj> {
        self.resources.get(category)?.get(name).cloned()
    }

    fn apply_extgstate(&mut self, name: &str) -> Result<(), String> {
        let Some(entry) = self.resource_entry("ExtGState", name) else {
            return Ok(());
        };
        let dict = self.file.resolve(&entry)?;
        if let Some(ca) = dict.get("ca").and_then(Obj::number) {
            self.state.fill_alpha = clamp_unit(ca);
        }
        if let Some(ca) = dict.get("CA").and_then(Obj::number) {
            self.state.stroke_alpha = clamp_unit(ca);
        }
        // Blend modes, soft masks and transfer functions are dropped (v1).
        Ok(())
    }

    fn space_of(&mut self, name: &str) -> Space {
        match name {
            "DeviceGray" | "CalGray" | "G" => return Space::Gray,
            "DeviceRGB" | "CalRGB" | "RGB" => return Space::Rgb,
            "DeviceCMYK" | "CMYK" => return Space::Cmyk,
            _ => {}
        }
        let Some(entry) = self.resource_entry("ColorSpace", name) else {
            return Space::Unsupported;
        };
        let Ok(resolved) = self.file.resolve(&entry) else {
            return Space::Unsupported;
        };
        match &resolved {
            Obj::Name(n) => match n.as_str() {
                "DeviceGray" | "CalGray" => Space::Gray,
                "DeviceRGB" | "CalRGB" => Space::Rgb,
                "DeviceCMYK" => Space::Cmyk,
                _ => Space::Unsupported,
            },
            Obj::Array(items) if items.first().is_some_and(|o| o.is_name("ICCBased")) => {
                // ICCBased falls back to its component count as RGB/CMYK/gray.
                match items.get(1).cloned() {
                    Some(inner) => match self.file.resolve(&inner) {
                        Ok(profile) if profile.get("N").and_then(Obj::integer) == Some(3) => {
                            Space::Rgb
                        }
                        Ok(profile) if profile.get("N").and_then(Obj::integer) == Some(4) => {
                            Space::Cmyk
                        }
                        Ok(profile) if profile.get("N").and_then(Obj::integer) == Some(1) => {
                            Space::Gray
                        }
                        _ => Space::Unsupported,
                    },
                    None => Space::Unsupported,
                }
            }
            _ => Space::Unsupported,
        }
    }

    fn set_space_color(&mut self, operands: &[Operand], fill: bool) {
        // A trailing name operand selects a pattern; keep the current color.
        if matches!(operands.last(), Some(Operand::Name(_))) {
            return;
        }
        let space = if fill {
            self.state.fill_space
        } else {
            self.state.stroke_space
        };
        let count = match space {
            Space::Gray => 1,
            Space::Rgb => 3,
            Space::Cmyk => 4,
            Space::Unsupported => return,
        };
        let Some(values) = trailing_numbers(operands, count) else {
            return;
        };
        let color = match space {
            Space::Gray => rgb_from_gray(clamp_unit(values[0])),
            Space::Rgb => [
                clamp_unit(values[0]),
                clamp_unit(values[1]),
                clamp_unit(values[2]),
            ],
            Space::Cmyk => rgb_from_cmyk(values[0], values[1], values[2], values[3]),
            Space::Unsupported => return,
        };
        if fill {
            self.state.fill = color;
        } else {
            self.state.stroke = color;
        }
    }

    fn path_command(&mut self) -> Result<(), String> {
        self.builder.commands += 1;
        if self.builder.commands > MAX_PATH_COMMANDS {
            return Err("pdf path command budget exceeded".into());
        }
        Ok(())
    }

    fn op_move(&mut self, p: Point) -> Result<(), String> {
        self.path_command()?;
        self.path.push(Subpath {
            start: p,
            segments: Vec::new(),
            closed: false,
        });
        self.pen = Some(p);
        self.last_c2 = None;
        Ok(())
    }

    fn op_line(&mut self, p: Point) -> Result<(), String> {
        self.path_command()?;
        if self.pen.is_some()
            && let Some(subpath) = self.path.last_mut()
        {
            subpath.segments.push(Segment::Line(p));
        } else if self.pen.is_none() {
            // Lenient fallback for content missing an initial m.
            self.path.push(Subpath {
                start: p,
                segments: Vec::new(),
                closed: false,
            });
        }
        self.pen = Some(p);
        self.last_c2 = None;
        Ok(())
    }

    fn op_cubic(&mut self, c1: Point, c2: Point, to: Point) -> Result<(), String> {
        self.path_command()?;
        if self.pen.is_some() {
            let pushed = self
                .path
                .last_mut()
                .map(|subpath| subpath.segments.push(Segment::Cubic { c1, c2, to }))
                .is_some();
            if pushed {
                self.pen = Some(to);
                self.last_c2 = Some(c2);
            }
        }
        Ok(())
    }

    fn op_rect(&mut self, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
        self.path_command()?;
        let (a, b) = (Point::new(x, y), Point::new(x + w, y));
        let (c, d) = (Point::new(x + w, y + h), Point::new(x, y + h));
        self.path.push(Subpath {
            start: a,
            segments: vec![Segment::Line(b), Segment::Line(c), Segment::Line(d)],
            closed: true,
        });
        self.pen = Some(a);
        self.last_c2 = None;
        Ok(())
    }

    fn op_close(&mut self) {
        let start = self.path.last_mut().map(|subpath| {
            subpath.closed = true;
            subpath.start
        });
        if let Some(start) = start {
            self.pen = Some(start);
        }
        self.last_c2 = None;
    }

    fn emit_path(&mut self, op: PaintOp) -> Result<(), String> {
        let mut subpaths = std::mem::take(&mut self.path);
        // Fill (and the close-then-paint ops) implicitly close subpaths.
        if op.fill || op.close {
            for subpath in &mut subpaths {
                subpath.closed = true;
            }
        }
        subpaths.retain(|s| !s.segments.is_empty());
        let mut index = 0;
        while index < subpaths.len() {
            let mut count = 0;
            let mut vertices = 0usize;
            while index + count < subpaths.len() {
                let need = 1 + subpaths[index + count].segments.len();
                if vertices + need > MAX_NETWORK_VERTICES {
                    break;
                }
                vertices += need;
                count += 1;
            }
            if count == 0 {
                // A single subpath larger than one network: split its run of
                // segments (continuity across chunks is lost at that scale).
                let take = MAX_NETWORK_VERTICES - 1;
                let source = &subpaths[index];
                let head = Subpath {
                    start: source.start,
                    segments: source.segments[..take].to_vec(),
                    closed: false,
                };
                let resume = match &source.segments[take - 1] {
                    Segment::Line(p) => *p,
                    Segment::Cubic { to, .. } => *to,
                };
                let tail = Subpath {
                    start: resume,
                    segments: source.segments[take..].to_vec(),
                    closed: source.closed,
                };
                self.emit_chunk(vec![head], op)?;
                if tail.segments.is_empty() {
                    index += 1;
                } else {
                    subpaths[index] = tail;
                }
                continue;
            }
            let chunk = subpaths[index..index + count].to_vec();
            self.emit_chunk(chunk, op)?;
            index += count;
        }
        Ok(())
    }

    fn emit_chunk(&mut self, chunk: Vec<Subpath>, op: PaintOp) -> Result<(), String> {
        // Local bounds over endpoints and curve controls (conservative for
        // curves; rectangles and lines are exact).
        let mut min = Point::new(f64::INFINITY, f64::INFINITY);
        let mut max = Point::new(f64::NEG_INFINITY, f64::NEG_INFINITY);
        let absorb = |p: Point, min: &mut Point, max: &mut Point| -> Result<(), String> {
            if !p.finite() {
                return Err("non-finite pdf path coordinates".into());
            }
            min.x = min.x.min(p.x);
            min.y = min.y.min(p.y);
            max.x = max.x.max(p.x);
            max.y = max.y.max(p.y);
            Ok(())
        };
        for subpath in &chunk {
            absorb(subpath.start, &mut min, &mut max)?;
            for segment in &subpath.segments {
                match segment {
                    Segment::Line(p) => absorb(*p, &mut min, &mut max)?,
                    Segment::Cubic { c1, c2, to } => {
                        absorb(*c1, &mut min, &mut max)?;
                        absorb(*c2, &mut min, &mut max)?;
                        absorb(*to, &mut min, &mut max)?;
                    }
                }
            }
        }
        if !min.finite() || !max.finite() {
            return Err("non-finite pdf path coordinates".into());
        }
        // Design documents are y-down; PDF user space is y-up, so the page
        // transform ends in a vertical flip and CTM placement maps into the
        // node transform with the path kept in local user-space units.
        let total = self.flip.concat(self.state.ctm);
        let transform = total.concat(Transform([1., 0., 0., 1., min.x, min.y]));
        if transform.0.iter().any(|v| !v.is_finite()) {
            return Err("non-finite pdf transform".into());
        }
        if transform.0.iter().any(|v| v.abs() > SCENE_LIMIT) {
            return Err("pdf transform exceeds scene limits".into());
        }
        // Singular CTMs paint nothing; skip instead of emitting invalid nodes.
        if transform.inverse().is_err() {
            return Ok(());
        }
        let local = |p: Point| -> Result<Point, String> {
            let p = Point::new(p.x - min.x, p.y - min.y);
            if !p.finite() || p.x.abs() > SCENE_LIMIT || p.y.abs() > SCENE_LIMIT {
                return Err("pdf path coordinates exceed scene limits".into());
            }
            Ok(p)
        };
        let mut vertices: Vec<Vertex> = Vec::new();
        let mut edges: Vec<Edge> = Vec::new();
        let mut next_vertex = 0usize;
        for subpath in &chunk {
            let start = local(subpath.start)?;
            let start_id = format!("v{next_vertex}");
            next_vertex += 1;
            vertices.push(Vertex {
                id: start_id.clone(),
                x: start.x,
                y: start.y,
            });
            let mut previous = start_id.clone();
            let mut last_point = subpath.start;
            for segment in &subpath.segments {
                let (to, c1, c2) = match segment {
                    Segment::Line(p) => (local(*p)?, None, None),
                    Segment::Cubic { c1, c2, to } => {
                        let (c1, c2) = (local(*c1)?, local(*c2)?);
                        (local(*to)?, Some(c1), Some(c2))
                    }
                };
                let id = format!("v{next_vertex}");
                next_vertex += 1;
                vertices.push(Vertex {
                    id: id.clone(),
                    x: to.x,
                    y: to.y,
                });
                edges.push(Edge {
                    id: format!("e{}", edges.len()),
                    from: previous,
                    to: id.clone(),
                    c1,
                    c2,
                });
                previous = id;
                last_point = match segment {
                    Segment::Line(p) => *p,
                    Segment::Cubic { to, .. } => *to,
                };
            }
            if subpath.closed && (last_point - subpath.start).length() > 1e-12 {
                edges.push(Edge {
                    id: format!("e{}", edges.len()),
                    from: previous,
                    to: start_id,
                    c1: None,
                    c2: None,
                });
            }
        }
        if edges.is_empty() {
            return Ok(());
        }
        let id = self.builder.fresh_id()?;
        let mut node = crate::facet::sample_node(&id, "vector");
        node.name = "path".into();
        node.width = (max.x - min.x).max(1e-3);
        node.height = (max.y - min.y).max(1e-3);
        node.transform = transform;
        // ca/CA map into one node opacity; the higher of the two is clamped.
        let node_alpha = match (op.fill, op.stroke) {
            (true, true) => self.state.fill_alpha.min(self.state.stroke_alpha),
            (true, false) => self.state.fill_alpha,
            _ => self.state.stroke_alpha,
        };
        node.opacity = clamp_unit(node_alpha);
        if op.fill {
            let ratio = if node_alpha > 0. {
                (self.state.fill_alpha / node_alpha).min(1.)
            } else {
                1.
            };
            node.fills.push(solid_paint(self.state.fill, ratio));
        }
        if op.stroke {
            let ratio = if node_alpha > 0. {
                (self.state.stroke_alpha / node_alpha).min(1.)
            } else {
                1.
            };
            let width = if self.state.line_width.is_finite() {
                self.state.line_width.clamp(0.01, SCENE_LIMIT)
            } else {
                1.
            };
            node.strokes.push(Stroke {
                start_marker: Default::default(),
                end_marker: Default::default(),
                id: String::new(),
                paint: solid_paint(self.state.stroke, ratio),
                width,
                align: "center".into(),
                cap: "butt".into(),
                join: "miter".into(),
                dash: String::new(),
                dash_offset: 0.,
                visible: true,
                width_profile: Vec::new(),
            });
        }
        node.network = Some(Network {
            filled_faces: None,
            vertices,
            edges,
            fill_rule: if op.evenodd { "evenodd" } else { "nonzero" }.into(),
        });
        self.builder.nodes.insert(id.clone(), node);
        self.children.push(id);
        Ok(())
    }

    fn draw_xobject(&mut self, name: &str) -> Result<(), String> {
        let Some(entry) = self.resource_entry("XObject", name) else {
            return Ok(());
        };
        let Some((num, _)) = entry.reference() else {
            return Ok(());
        };
        let object = self.file.object(num)?;
        let PdfObject::Stream { dict, data } = &*object else {
            return Ok(());
        };
        if !dict.get("Subtype").is_some_and(|s| s.is_name("Image")) {
            // Form and PostScript XObjects are not executed (v1).
            return Ok(());
        }
        let (Some(width), Some(height)) = (
            dict.get("Width").and_then(Obj::integer),
            dict.get("Height").and_then(Obj::integer),
        ) else {
            return Ok(());
        };
        if width <= 0 || height <= 0 || width as u64 * height as u64 > 16_777_216 {
            return Ok(());
        }
        let filter: Vec<String> = match dict.get("Filter") {
            Some(Obj::Name(n)) => vec![n.clone()],
            Some(Obj::Array(items)) => items
                .iter()
                .filter_map(|o| o.name().map(str::to_string))
                .collect(),
            _ => Vec::new(),
        };
        let uri = match filter.as_slice() {
            [single] if single == "DCTDecode" => Some(data_uri("image/jpeg", data)),
            [single] if single == "FlateDecode" => {
                self.flate_image_uri(dict, data, width as u32, height as u32)
            }
            _ => None, // other filters are skipped
        };
        let Some(uri) = uri else {
            return Ok(());
        };
        // The image fills the CTM-mapped unit square (axis-aligned bounds).
        let total = self.flip.concat(self.state.ctm);
        let corners = [
            total.point(Point::new(0., 0.)),
            total.point(Point::new(1., 0.)),
            total.point(Point::new(1., 1.)),
            total.point(Point::new(0., 1.)),
        ];
        if corners.iter().any(|p| !p.finite()) {
            return Err("non-finite pdf transform".into());
        }
        let mut min = Point::new(f64::INFINITY, f64::INFINITY);
        let mut max = Point::new(f64::NEG_INFINITY, f64::NEG_INFINITY);
        for corner in corners {
            min.x = min.x.min(corner.x);
            min.y = min.y.min(corner.y);
            max.x = max.x.max(corner.x);
            max.y = max.y.max(corner.y);
        }
        let id = self.builder.fresh_id()?;
        let mut node = crate::facet::sample_node(&id, "image");
        node.name = "image".into();
        node.width = (max.x - min.x).max(1e-3);
        node.height = (max.y - min.y).max(1e-3);
        node.transform = Transform([1., 0., 0., 1., min.x, min.y]);
        node.fills.push(Paint {
            transform: None,
            id: String::new(),
            kind: "image".into(),
            // Placeholder base color: authored image paints always carry one.
            color: "#000000".into(),
            opacity: 1.,
            visible: true,
            angle: 0.,
            stops: Vec::new(),
            image: Some(uri),
            fit: "stretch".into(),
            blend: "normal".into(),
            adjust: None,
            tile: None,
        });
        self.builder.nodes.insert(id.clone(), node);
        self.children.push(id);
        Ok(())
    }

    /// FlateDecode 8-bit DeviceRGB/DeviceGray (or ICCBased fallback) → PNG
    /// data URI. SMask alpha is dropped; other variants are skipped.
    fn flate_image_uri(
        &mut self,
        dict: &Obj,
        raw: &[u8],
        width: u32,
        height: u32,
    ) -> Option<String> {
        let bits = dict.get("BitsPerComponent").and_then(Obj::integer)?;
        if bits != 8 {
            return None;
        }
        let space = dict.get("ColorSpace").cloned()?;
        let resolved = self.file.resolve(&space).ok()?;
        let components = match &resolved {
            Obj::Name(n) => match n.as_str() {
                "DeviceRGB" | "CalRGB" => 3,
                "DeviceGray" | "CalGray" => 1,
                _ => return None,
            },
            Obj::Array(items) if items.first().is_some_and(|o| o.is_name("ICCBased")) => {
                let inner = items.get(1).cloned()?;
                let profile = self.file.resolve(&inner).ok()?;
                match profile.get("N").and_then(Obj::integer) {
                    Some(3) => 3,
                    Some(1) => 1,
                    _ => return None,
                }
            }
            _ => return None,
        };
        let decoded =
            miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(raw, MAX_STREAM_BYTES).ok()?;
        let expected = width as usize * height as usize * components;
        if decoded.len() != expected {
            return None;
        }
        let mut rgba = Vec::with_capacity(expected / components * 4);
        match components {
            3 => {
                for pixel in decoded.chunks_exact(3) {
                    rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
                }
            }
            _ => {
                for &gray in &decoded {
                    rgba.extend_from_slice(&[gray, gray, gray, 255]);
                }
            }
        }
        let png = encode_rgba(width, height, &rgba).ok()?;
        Some(data_uri("image/png", &png))
    }
}

fn skip_inline_image(parser: &mut Parser<'_>) -> Result<(), String> {
    let mut i = parser.p;
    loop {
        if i + 2 > parser.b.len() {
            return Err("unterminated pdf inline image".into());
        }
        if &parser.b[i..i + 2] == b"EI"
            && parser.b.get(i + 2).is_none_or(|&c| is_ws(c) || is_delim(c))
        {
            parser.p = i + 2;
            return Ok(());
        }
        i += 1;
    }
}

// ---------------------------------------------------------------------------
// document assembly
// ---------------------------------------------------------------------------

/// Import a vector PDF as an editable design document. See the module docs
/// for the v1 degradations (text, clipping, shadings are not imported).
pub fn import_pdf(bytes: &[u8]) -> Result<Document, String> {
    if !is_pdf_file(bytes) {
        return Err("missing pdf header".into());
    }
    let mut file = PdfFile::new(bytes)?;
    let Some(root) = file.root else {
        return Err("pdf trailer missing /Root".into());
    };
    let catalog = file.resolve(&Obj::Ref(root.0, root.1))?;
    let Some(pages_node) = catalog.get("Pages").cloned() else {
        return Err("pdf catalog missing /Pages".into());
    };
    let mut specs = Vec::new();
    file.collect_pages(&pages_node, None, None, &mut specs, 0, &mut HashSet::new())?;
    if specs.is_empty() {
        return Err("pdf has no pages".into());
    }
    let version = file.version.clone();
    let mut builder = Builder::default();
    let mut doc = Document {
        reviews: Vec::new(),
        design_system: None,
        prototype: None,
        schema_version: 1,
        color_management: None,
        raster_profile: None,
        id: "imported-pdf".into(),
        name: format!("Imported from PDF {version}"),
        pages: Vec::new(),
        nodes: BTreeMap::new(),
        fonts: BTreeMap::new(),
        animations: Vec::new(),
    };
    for (index, spec) in specs.iter().enumerate() {
        let page_name = format!("Page {}", index + 1);
        let mut children = Vec::new();
        {
            let mut runner = Runner::new(
                &mut file,
                spec.resources.clone(),
                spec.media,
                &mut builder,
                &mut children,
            );
            for content in &spec.contents {
                runner.run_stream(*content)?;
            }
        }
        // Authored documents keep pages only in `pages`: no page node joins
        // the nodes map (validation treats such a node as unreachable).
        doc.pages.push(Page {
            guides: vec![],
            id: format!("pdf-page-{}", index + 1),
            name: page_name,
            children,
            background: "#ffffff".into(),
        });
    }
    doc.nodes = builder.nodes;
    Ok(doc)
}
