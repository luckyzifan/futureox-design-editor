//! Streaming JSON source indexing and copy-through export. This is a storage
//! representation, not a second scene model or a document-admission bypass.
//! Offsets are UTF-8 byte offsets (u64), including on wasm32. Only selected
//! fragments enter the ordinary typed scene/transaction implementation.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::sync::Arc;

/// Exact cross-process byte offsets, not a file-admission allowance. Native
/// callers supply a storage-derived policy; fragments stay independently bounded.
pub const MAX_SOURCE_OFFSET: u64 = 9_007_199_254_740_991;
pub const MAX_FRAGMENT_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub start: u64,
    pub end: u64,
}
impl Span {
    pub fn len(self) -> u64 {
        self.end - self.start
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Field {
    pub key: String,
    pub member: Span,
    pub value: Span,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub member: Span,
    pub id: String,
    pub name: String,
    pub kind: String,
    pub parent: Option<usize>,
    pub depth: usize,
    pub span: Span,
    pub fields: Vec<Field>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Index {
    pub bytes: u64,
    pub entries: Vec<Entry>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

// Fragment validation keeps only keys in currently active objects. Decoded
// UTF-8 key bytes plus their two source quotes cannot exceed the already
// admitted fragment length. Tracking both payload and key count bounds the
// BTreeSet bookkeeping by that same input, without imposing a smaller budget.
// This is a logical allocation bound, not an allocator/RSS measurement.
struct FragmentKeyBudget {
    limit: usize,
    bytes: usize,
    keys: usize,
}
impl FragmentKeyBudget {
    fn retain(&mut self, bytes: usize) -> io::Result<()> {
        let next_bytes = self.bytes.checked_add(bytes);
        let next_keys = self.keys.checked_add(1);
        let charge = next_keys
            .and_then(|keys| keys.checked_mul(2))
            .and_then(|quotes| next_bytes.and_then(|bytes| bytes.checked_add(quotes)));
        if charge.is_none_or(|charge| charge > self.limit) {
            return Err(invalid("JSON fragment key working-set limit exceeded"));
        }
        self.bytes = next_bytes.unwrap();
        self.keys = next_keys.unwrap();
        Ok(())
    }
    fn release(&mut self, bytes: usize, keys: usize) -> io::Result<()> {
        self.bytes = self
            .bytes
            .checked_sub(bytes)
            .ok_or_else(|| invalid("Invalid JSON fragment key accounting"))?;
        self.keys = self
            .keys
            .checked_sub(keys)
            .ok_or_else(|| invalid("Invalid JSON fragment key accounting"))?;
        Ok(())
    }
}

struct ObjectFrame {
    depth: usize, owner: Option<usize>, label: String, start: u64,
    member_start: Option<u64>, ordinal: usize, entry: Option<Entry>, select: bool,
    common_keys: u64, keys: HashSet<[u8; 32]>, fragment_keys: BTreeSet<Box<str>>,
    fragment_key_bytes: usize, field_bytes: usize, first: bool,
}
struct ValueFrame {
    depth: usize, parent: Option<usize>, select: bool, label: String,
    array_children: bool, member_start: Option<u64>,
}
struct ArrayFrame { depth: usize, parent: Option<usize>, select: bool, count: u64 }
enum ScanWork {
    Value(ValueFrame), Object(ObjectFrame), Field(ObjectFrame, Field), Array(ArrayFrame),
}

struct Scanner<R, F> {
    input: BufReader<R>,
    at: u64,
    limit: u64,
    sink: F,
    entries: usize,
    fragment_keys: Option<FragmentKeyBudget>,
    compact_keys: bool,
    short_names: HashMap<String,u8>,
}
impl<R: Read, F: FnMut(usize, Entry) -> io::Result<()>> Scanner<R, F> {
    fn peek(&mut self) -> io::Result<Option<u8>> {
        Ok(self.input.fill_buf()?.first().copied())
    }
    fn advance(&mut self, n: usize) -> io::Result<()> {
        if n as u64 > self.limit.saturating_sub(self.at) {
            return Err(invalid("JSON expanded-byte limit exceeded"));
        }
        self.input.consume(n);
        self.at += n as u64;
        Ok(())
    }
    fn byte(&mut self) -> io::Result<u8> {
        let value = self.peek()?.ok_or_else(|| invalid("Unexpected JSON EOF"))?;
        self.advance(1)?;
        Ok(value)
    }
    fn expect(&mut self, expected: u8) -> io::Result<()> {
        if self.byte()? != expected {
            return Err(invalid("Invalid JSON token"));
        }
        Ok(())
    }
    fn whitespace(&mut self) -> io::Result<()> {
        loop {
            let n = self
                .input
                .fill_buf()?
                .iter()
                .take_while(|b| matches!(b, b' ' | b'\n' | b'\r' | b'\t'))
                .count();
            if n == 0 {
                return Ok(());
            }
            self.advance(n)?;
        }
    }
    fn hex4(&mut self) -> io::Result<u32> {
        let mut n = 0;
        for _ in 0..4 {
            n = n * 16
                + (self.byte()? as char)
                    .to_digit(16)
                    .ok_or_else(|| invalid("Invalid JSON Unicode escape"))?;
        }
        Ok(n)
    }
    fn string(&mut self, capture: bool, max: usize) -> io::Result<Option<String>> {
        self.expect(b'"')?;
        let mut result = capture.then(String::new);
        loop {
            // The common ASCII run is consumed directly from the input buffer.
            // A multi-gigabyte string does not become a multi-gigabyte allocation.
            let bytes = self.input.fill_buf()?;
            let n = bytes
                .iter()
                .position(|b| *b < 32 || *b >= 128 || matches!(b, b'"' | b'\\'))
                .unwrap_or(bytes.len());
            if n > 0 {
                if let Some(out) = &mut result {
                    if out.len().saturating_add(n) > max {
                        return Err(invalid("JSON indexed string/key limit exceeded"));
                    }
                    out.try_reserve(n).map_err(io::Error::other)?;
                    out.push_str(std::str::from_utf8(&bytes[..n]).expect("ASCII run"));
                }
                self.advance(n)?;
            }
            let b = self.byte()?;
            let character = match b {
                b'"' => return Ok(result),
                b'\\' => match self.byte()? {
                    b'"' => '"',
                    b'\\' => '\\',
                    b'/' => '/',
                    b'b' => '\u{8}',
                    b'f' => '\u{c}',
                    b'n' => '\n',
                    b'r' => '\r',
                    b't' => '\t',
                    b'u' => {
                        let mut code = self.hex4()?;
                        if (0xd800..=0xdbff).contains(&code) {
                            self.expect(b'\\')?;
                            self.expect(b'u')?;
                            let low = self.hex4()?;
                            if !(0xdc00..=0xdfff).contains(&low) {
                                return Err(invalid("Invalid JSON surrogate pair"));
                            }
                            code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
                        }
                        char::from_u32(code)
                            .ok_or_else(|| invalid("Invalid JSON Unicode scalar"))?
                    }
                    _ => return Err(invalid("Invalid JSON escape")),
                },
                0..=31 => return Err(invalid("Unescaped JSON control character")),
                0xc2..=0xf4 => {
                    let size = if b < 0xe0 {
                        2
                    } else if b < 0xf0 {
                        3
                    } else {
                        4
                    };
                    let mut utf8 = [0u8; 4];
                    utf8[0] = b;
                    for item in utf8.iter_mut().take(size).skip(1) {
                        *item = self.byte()?;
                    }
                    std::str::from_utf8(&utf8[..size])
                        .map_err(|_| invalid("Invalid JSON UTF-8"))?
                        .chars()
                        .next()
                        .unwrap()
                }
                32..=127 => b as char,
                _ => return Err(invalid("Invalid JSON UTF-8")),
            };
            if let Some(out) = &mut result {
                if out.len() + character.len_utf8() > max {
                    return Err(invalid("JSON indexed string/key limit exceeded"));
                }
                out.try_reserve(character.len_utf8()).map_err(io::Error::other)?;
                out.push(character);
            }
        }
    }
    fn digits(&mut self) -> io::Result<usize> {
        let mut count = 0;
        while self.peek()?.is_some_and(|b| b.is_ascii_digit()) {
            self.byte()?;
            count += 1;
        }
        Ok(count)
    }
    fn number(&mut self) -> io::Result<()> {
        if self.peek()? == Some(b'-') {
            self.byte()?;
        }
        match self.byte()? {
            b'0' => {}
            b'1'..=b'9' => {
                self.digits()?;
            }
            _ => return Err(invalid("Invalid JSON number")),
        }
        if self.peek()? == Some(b'.') {
            self.byte()?;
            if self.digits()? == 0 {
                return Err(invalid("Invalid JSON fraction"));
            }
        }
        if matches!(self.peek()?, Some(b'e' | b'E')) {
            self.byte()?;
            if matches!(self.peek()?, Some(b'+' | b'-')) {
                self.byte()?;
            }
            if self.digits()? == 0 {
                return Err(invalid("Invalid JSON exponent"));
            }
        }
        Ok(())
    }
    /// Opaque nested objects have no field table. Keep only keys that can
    /// introduce indexed descendants, while still validating every source byte.
    /// Escapes, UTF-8 and buffer boundaries retain the original string parser.
    fn object_key(&mut self,keep:bool,max:usize)->io::Result<String>{
        if self.compact_keys&&!keep {
            let bytes=self.input.fill_buf()?;
            if bytes.first()==Some(&b'"') {
                let tail=&bytes[1..];
                if let Some(end)=tail.iter().position(|b|*b<32||*b>=128||matches!(b,b'"'|b'\\')) {
                    if tail[end]==b'"' {
                        let key=match &tail[..end] {b"layers"=>"layers",b"nodes"=>"nodes",_=>""};
                        let key=key.to_owned();self.advance(end+2)?;return Ok(key)
                    }
                }
            }
        }
        self.string(true,max).map(|key|key.unwrap())
    }
    fn finish_field(&mut self, object: &mut ObjectFrame, mut field: Field, text: Option<String>) {
        if let Some(item) = &mut object.entry {
            if let Some(text) = text {
                match field.key.as_str() {
                    "do_objectID" | "id" => item.id = text,
                    "name" => item.name = text,
                    "_class" | "kind" => item.kind = text,
                    _ => {}
                }
            }
            // This is a metadata cache window, not a source-content quota.
            // Cold fields remain in their original source byte ranges.
            if item.fields.len() < 4096 && object.field_bytes.saturating_add(96 + field.key.len()) <= 512 * 1024 {
                object.field_bytes += 96 + field.key.len();
                field.member.end = self.at; field.value.end = self.at;
                item.fields.push(field);
            }
        } else if self.fragment_keys.is_some() {
            object.fragment_keys.insert(field.key.into_boxed_str());
        }
        object.first = false;
    }
    fn close_object(&mut self, object: ObjectFrame) -> io::Result<()> {
        self.expect(b'}')?;
        if let Some(budget) = &mut self.fragment_keys {
            budget.release(object.fragment_key_bytes, object.fragment_keys.len())?;
        }
        if let Some(mut item) = object.entry {
            item.span = Span { start: object.start, end: self.at };
            item.member = Span { start: object.member_start.unwrap_or(object.start), end: self.at };
            (self.sink)(object.ordinal, item)?;
        }
        Ok(())
    }
    fn scalar(&mut self, token: Option<u8>) -> io::Result<()> {
        match token {
            Some(b'"') => { self.string(false, 0)?; }
            Some(b't') => { for b in b"true" { self.expect(*b)?; } }
            Some(b'f') => { for b in b"false" { self.expect(*b)?; } }
            Some(b'n') => { for b in b"null" { self.expect(*b)?; } }
            Some(b'-' | b'0'..=b'9') => self.number()?,
            _ => return Err(invalid("Invalid JSON value")),
        }
        Ok(())
    }
    fn value(&mut self, depth: usize, parent: Option<usize>, select: bool, label: &str,
        array_children: bool, member_start: Option<u64>) -> io::Result<Span> {
        use sha2::{Digest, Sha256};
        self.whitespace()?;
        let start = self.at;
        let string_limit = usize::try_from(self.limit).unwrap_or(usize::MAX);
        let mut work = vec![ScanWork::Value(ValueFrame { depth, parent, select, label: label.into(), array_children, member_start })];
        // Explicit heap frames make source nesting independent of the native
        // thread stack. No document-size/depth/count quota is used here.
        while let Some(task) = work.pop() {
            work.try_reserve(2).map_err(io::Error::other)?;
            match task {
                ScanWork::Value(value) => {
                    self.whitespace()?;
                    let start = self.at;
                    match self.peek()? {
                        Some(b'{') => {
                            self.byte()?;
                            let ordinal = self.entries;
                            let entry = if value.select {
                                self.entries = self.entries.checked_add(1).ok_or_else(|| invalid("JSON index address overflow"))?;
                                self.fragment_keys.is_none().then(|| Entry {
                                    member: Span::default(), id: format!("json:{start}"), name: value.label.clone(), kind: "object".into(),
                                    parent: value.parent, depth: value.depth, span: Span::default(), fields: Vec::new(),
                                })
                            } else { None };
                            work.push(ScanWork::Object(ObjectFrame { depth: value.depth,
                                owner: if value.select { Some(ordinal) } else { value.parent },
                                label: value.label, start, member_start: value.member_start, ordinal, entry, select: value.select,
                                common_keys:0, keys: HashSet::new(), fragment_keys: BTreeSet::new(), fragment_key_bytes: 0, field_bytes: 0, first: true }));
                        }
                        Some(b'[') => {
                            self.byte()?;
                            work.push(ScanWork::Array(ArrayFrame { depth: value.depth, parent: value.parent, select: value.array_children, count: 0 }));
                        }
                        scalar => self.scalar(scalar)?,
                    }
                }
                ScanWork::Array(mut array) => {
                    self.whitespace()?;
                    if self.peek()? == Some(b']') { self.byte()?; continue; }
                    if array.count > 0 { self.expect(b',')?; }
                    let value = ValueFrame { depth: array.depth.checked_add(1).ok_or_else(|| invalid("JSON depth address overflow"))?,
                        parent: array.parent, select: array.select, label: if array.select||!self.compact_keys {array.count.to_string()}else{String::new()}, array_children: false, member_start: None };
                    array.count = array.count.checked_add(1).ok_or_else(|| invalid("JSON array address overflow"))?;
                    work.push(ScanWork::Array(array)); work.push(ScanWork::Value(value));
                }
                ScanWork::Object(mut object) => {
                    self.whitespace()?;
                    if self.peek()? == Some(b'}') { self.close_object(object)?; continue; }
                    if !object.first { self.expect(b',')?; self.whitespace()?; }
                    let field_start = self.at;
                    let key = self.object_key(object.entry.is_some()||self.fragment_keys.is_some()||object.depth==0||object.label=="nodes",string_limit)?;
                    if let Some(budget) = &mut self.fragment_keys {
                        if object.fragment_keys.contains(key.as_str()) { return Err(invalid("Duplicate JSON object key in edit fragment")); }
                        budget.retain(key.len())?;
                        object.fragment_key_bytes = object.fragment_key_bytes.checked_add(key.len()).ok_or_else(|| invalid("JSON fragment key byte overflow"))?;
                    }
                    if object.entry.is_some() {
                        // Slots never move or expire within this scan, including while
                        // a parent object is suspended. Other names retain the old guard.
                        let slot=if let Some(slot)=self.short_names.get(&key) {Some(*slot)}
                            else if self.short_names.len()<u64::BITS as usize && key.len()<=64 {
                                let slot=self.short_names.len() as u8;
                                self.short_names.try_reserve(1).map_err(io::Error::other)?;
                                self.short_names.insert(key.clone(),slot);Some(slot)
                            } else {None};
                        let duplicate=if let Some(slot)=slot {
                            let bit=1u64<<slot;
                            let present=object.common_keys&bit!=0;object.common_keys|=bit;present
                        } else {
                            object.keys.try_reserve(1).map_err(io::Error::other)?;
                            !object.keys.insert(<[u8; 32]>::from(Sha256::digest(key.as_bytes())))
                        };
                        if duplicate { return Err(invalid("Duplicate indexed JSON object key")); }
                    }
                    self.whitespace()?; self.expect(b':')?; self.whitespace()?;
                    let field = Field { key, member: Span { start: field_start, end: 0 }, value: Span { start: self.at, end: 0 } };
                    let metadata = object.select && matches!(field.key.as_str(), "do_objectID" | "id" | "name" | "_class" | "kind");
                    if metadata && self.peek()? == Some(b'"') {
                        let text = self.string(true, string_limit)?;
                        self.finish_field(&mut object, field, text);
                        work.push(ScanWork::Object(object));
                    } else if !matches!(self.peek()?,Some(b'{'|b'[')) {
                        let token=self.peek()?;
                        self.scalar(token)?;
                        self.finish_field(&mut object,field,None);
                        work.push(ScanWork::Object(object));
                    } else {
                        let nested = (object.depth == 0 || object.label == "nodes") && self.peek()? == Some(b'{');
                        let value = ValueFrame { depth: object.depth.checked_add(1).ok_or_else(|| invalid("JSON depth address overflow"))?,
                            parent: object.owner, select: nested, label: field.key.clone(),
                            array_children: field.key == "layers" || object.depth == 0, member_start: Some(field_start) };
                        work.push(ScanWork::Field(object, field)); work.push(ScanWork::Value(value));
                    }
                }
                ScanWork::Field(mut object, field) => {
                    self.finish_field(&mut object, field, None);
                    work.push(ScanWork::Object(object));
                }
            }
        }
        Ok(Span { start, end: self.at })
    }

}

#[derive(Debug)]
pub struct ScanSummary {
    pub bytes: u64,
    pub entries: usize,
}
pub fn scan<R: Read, F: FnMut(usize, Entry) -> io::Result<()>>(
    reader: R,
    limit: u64,
    sink: F,
) -> io::Result<ScanSummary> {
    scan_at(reader, limit, 0, sink)
}
fn scan_at<R: Read, F: FnMut(usize, Entry) -> io::Result<()>>(
    reader: R,
    limit: u64,
    depth: usize,
    sink: F,
) -> io::Result<ScanSummary> {
    if limit == 0 || limit > MAX_SOURCE_OFFSET {
        return Err(invalid("Invalid JSON expanded-byte policy"));
    }
    let mut scanner = Scanner {
        input: BufReader::with_capacity(64 * 1024, reader),
        at: 0,
        limit,
        sink,
        entries: 0,
        fragment_keys: None,
        compact_keys:true,short_names:HashMap::new(),
    };
    scanner.value(depth, None, true, "JSON", true, None)?;
    scanner.whitespace()?;
    if scanner.peek()?.is_some() {
        return Err(invalid("Trailing JSON content"));
    }
    Ok(ScanSummary {
        bytes: scanner.at,
        entries: scanner.entries,
    })
}
/// Validate bounded new edit/replacement bytes without constructing a Value or
/// an index. Every object rejects duplicate decoded keys, independently of
/// navigation selection. Existing whole-source scan/index admission is unchanged.
/// Strings, arbitrary numeric lexemes, and all original bytes are left untouched.
pub fn validate_fragment(bytes: &[u8]) -> io::Result<()> {
    if bytes.len() as u64 > MAX_FRAGMENT_BYTES {
        return Err(invalid("JSON replacement fragment exceeds 4 MiB"));
    }
    let mut scanner = Scanner {
        input: BufReader::with_capacity(64 * 1024, bytes),
        at: 0,
        limit: MAX_FRAGMENT_BYTES,
        sink: |_, _| Ok(()),
        entries: 0,
        compact_keys:false,short_names:HashMap::new(),
        fragment_keys: Some(FragmentKeyBudget {
            limit: bytes.len(),
            bytes: 0,
            keys: 0,
        }),
    };
    scanner.value(0, None, true, "JSON", true, None)?;
    scanner.whitespace()?;
    if scanner.peek()?.is_some() {
        return Err(invalid("Trailing JSON content"));
    }
    Ok(())
}

pub fn index<R: Read>(reader: R, limit: u64) -> io::Result<Index> {
    index_subtree(reader, limit, 0)
}
/// Re-index a selected object at its original depth. Root-only metadata and
/// arrays must not become extra navigable nodes when a nested layer is edited.
pub fn index_subtree<R: Read>(reader: R, limit: u64, depth: usize) -> io::Result<Index> {
    let mut entries: Vec<Option<Entry>> = Vec::new();
    let mut retained = 0usize;
    let summary = scan_at(reader, limit, depth, |ordinal, entry| {
        retained = retained
            .saturating_add(128 + entry.fields.iter().map(|f| 96 + f.key.len()).sum::<usize>());
        if retained > 512 * 1024 * 1024 {
            return Err(invalid(
                "JSON in-memory index budget exceeded; use a streaming index sink",
            ));
        }
        if entries.len() <= ordinal {
            entries.resize_with(ordinal + 1, || None)
        }
        entries[ordinal] = Some(entry);
        Ok(())
    })?;
    Ok(Index {
        bytes: summary.bytes,
        entries: entries
            .into_iter()
            .map(|e| e.expect("completed JSON object"))
            .collect(),
    })
}

pub fn read_fragment<R: Read + Seek>(reader: &mut R, span: Span) -> io::Result<Vec<u8>> {
    if span.end < span.start || span.len() > MAX_FRAGMENT_BYTES {
        return Err(invalid(
            "Select a smaller JSON object or field (fragment limit is 4 MiB)",
        ));
    }
    reader.seek(SeekFrom::Start(span.start))?;
    let mut bytes = Vec::with_capacity(span.len() as usize);
    reader.take(span.len()).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != span.len() {
        return Err(invalid("Truncated indexed JSON source"));
    }
    Ok(bytes)
}

/// Immutable source pieces plus bounded additions. History shares added text;
/// editing never copies the complete source or retains complete JSON snapshots.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Piece {
    start: u64,
    length: u64,
    added: Option<Arc<String>>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Changes {
    pieces: Option<Vec<Piece>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Addition {
    pub span: Span,
    pub sha256: String,
}
impl Changes {
    pub fn is_pristine(&self) -> bool { self.pieces.is_none() }
    fn pieces(&self, source_bytes: u64) -> Vec<Piece> {
        self.pieces.clone().unwrap_or_else(|| {
            vec![Piece {
                start: 0,
                length: source_bytes,
                added: None,
            }]
        })
    }
    /// Reorder already indexed source spans without reading or retaining subtree bytes.
    /// None is a JSON array separator. The host validates both the typed topology
    /// and the new virtual JSON before publishing the result.
    pub fn compose_spans(&self, source_bytes: u64, ranges: &[Option<Span>]) -> io::Result<Self> {
        let old = self.pieces(source_bytes);
        let mut ends = Vec::with_capacity(old.len());
        let mut end = 0u64;
        for piece in &old {
            end = end.checked_add(piece.length).ok_or_else(|| invalid("JSON piece overflow"))?;
            ends.push(end);
        }
        let comma = Arc::new(",".to_owned());
        let mut output = Vec::new();
        for range in ranges {
            let Some(span) = range else {
                output.push(Piece { start:0, length:1, added:Some(comma.clone()) });
                continue;
            };
            if span.start > span.end || span.end > end { return Err(invalid("Invalid source composition span")); }
            let mut at = span.start;
            let mut i = ends.partition_point(|v| *v <= at);
            while at < span.end {
                let piece = &old[i];
                let start = ends[i] - piece.length;
                let length = span.end.min(ends[i]) - at;
                if length != 0 { output.push(Piece { start:piece.start + (at-start), length, added:piece.added.clone() }); }
                at += length; i += 1;
            }
        }
        let next = Self { pieces:Some(output) };
        if next.output_bytes(source_bytes)? > MAX_SOURCE_OFFSET {return Err(invalid("JSON piece budget exceeded"));}
        Ok(next)
    }
    pub fn retained_bytes(&self) -> usize {
        self.pieces
            .as_ref()
            .map(|p| {
                p.iter()
                    .filter_map(|p| p.added.as_ref())
                    .map(|s| s.len())
                    .sum()
            })
            .unwrap_or(0)
    }
    /// Append only new, bounded additions to a host-owned source spool. Old
    /// snapshots retain offsets, not in-memory copies of all edited text.
    pub fn spill_to<T: Read + Write + Seek>(&mut self, file: &mut T) -> io::Result<Vec<Addition>> {
        use sha2::{Digest, Sha256};
        let mut written = HashMap::new();
        let mut additions = Vec::new();
        if let Some(pieces) = &mut self.pieces {
            for piece in pieces {
                let Some(text) = piece.added.take() else {
                    continue;
                };
                let identity = Arc::as_ptr(&text) as usize;
                let offset = if let Some(offset) = written.get(&identity) {
                    *offset
                } else {
                    let start = file.seek(SeekFrom::End(0))?;
                    file.write_all(text.as_bytes())?;
                    additions.push(Addition {
                        span: Span {
                            start,
                            end: start + text.len() as u64,
                        },
                        sha256: format!("{:x}", Sha256::digest(text.as_bytes())),
                    });
                    written.insert(identity, start);
                    start
                };
                piece.start += offset;
            }
        }
        Ok(additions)
    }
    pub fn replace(&mut self, span: Span, json: Vec<u8>, source_bytes: u64) -> io::Result<()> {
        validate_fragment(json.as_slice())?;
        self.splice(span, json, source_bytes)
    }
    /// Host-verified structural splice. Callers must validate the resulting
    /// virtual JSON and typed edit before publishing this candidate.
    pub fn splice(&mut self, span: Span, json: Vec<u8>, source_bytes: u64) -> io::Result<()> {
        let current = self.output_bytes(source_bytes)?;
        if span.end < span.start || span.end > current || json.len() as u64 > MAX_FRAGMENT_BYTES {
            return Err(invalid("Invalid JSON replacement span/size"));
        }
        let text = Arc::new(
            String::from_utf8(json).map_err(|_| invalid("Invalid JSON replacement UTF-8"))?,
        );
        let next_len = current
            .checked_sub(span.len())
            .and_then(|n| n.checked_add(text.len() as u64))
            .ok_or_else(|| invalid("JSON byte overflow"))?;
        if next_len > MAX_SOURCE_OFFSET {
            return Err(invalid("JSON expanded-byte limit exceeded after edit"));
        }
        let mut pieces = Vec::new();
        let mut at = 0;
        let mut inserted = false;
        for piece in self.pieces(source_bytes) {
            let end = at + piece.length;
            if end <= span.start || at >= span.end {
                if !inserted && at >= span.end {
                    pieces.push(Piece {
                        start: 0,
                        length: text.len() as u64,
                        added: Some(text.clone()),
                    });
                    inserted = true;
                }
                pieces.push(piece);
            } else {
                if span.start > at {
                    pieces.push(Piece {
                        length: span.start - at,
                        ..piece.clone()
                    });
                }
                if !inserted {
                    pieces.push(Piece {
                        start: 0,
                        length: text.len() as u64,
                        added: Some(text.clone()),
                    });
                    inserted = true;
                }
                if span.end < end {
                    pieces.push(Piece {
                        start: piece.start + span.end - at,
                        length: end - span.end,
                        ..piece
                    });
                }
            }
            at = end;
        }
        if !inserted {
            pieces.push(Piece {
                start: 0,
                length: text.len() as u64,
                added: Some(text),
            });
        }
        pieces.retain(|p| p.length > 0);
        self.pieces = Some(pieces);
        Ok(())
    }
    pub fn output_bytes(&self, source_bytes: u64) -> io::Result<u64> {
        self.pieces
            .as_ref()
            .map(|p| {
                p.iter().try_fold(0u64, |n, p| {
                    n.checked_add(p.length)
                        .ok_or_else(|| invalid("JSON export byte overflow"))
                })
            })
            .unwrap_or(Ok(source_bytes))
    }
    pub fn reader<'a, R: Read + Seek>(
        &self,
        source: &'a mut R,
        source_bytes: u64,
    ) -> io::Result<PieceReader<'a, R>> {
        let pieces = self.pieces(source_bytes);
        let mut starts = Vec::with_capacity(pieces.len());
        let mut length = 0u64;
        let source_length = source.seek(SeekFrom::End(0))?;
        for piece in &pieces {
            starts.push(length);
            length = length
                .checked_add(piece.length)
                .ok_or_else(|| invalid("JSON byte overflow"))?;
            let end = piece
                .start
                .checked_add(piece.length)
                .ok_or_else(|| invalid("JSON piece overflow"))?;
            if end
                > piece
                    .added
                    .as_ref()
                    .map(|s| s.len() as u64)
                    .unwrap_or(source_length)
            {
                return Err(invalid("Invalid JSON piece reference"));
            }
        }
        if length > MAX_SOURCE_OFFSET {
            return Err(invalid("JSON piece budget exceeded"));
        }
        Ok(PieceReader {
            source,
            pieces,
            starts,
            length,
            at: 0,
        })
    }
    pub fn fragment<R: Read + Seek>(
        &self,
        reader: &mut R,
        span: Span,
        source_bytes: u64,
    ) -> io::Result<Vec<u8>> {
        read_fragment(&mut self.reader(reader, source_bytes)?, span)
    }
    pub fn export<R: Read + Seek, W: Write>(
        &self,
        reader: &mut R,
        writer: &mut W,
        source_bytes: u64,
    ) -> io::Result<u64> {
        let length = self.output_bytes(source_bytes)?;
        let mut source = self.reader(reader, source_bytes)?;
        if io::copy(&mut source, writer)? != length {
            return Err(invalid("Truncated JSON export"));
        }
        Ok(length)
    }
}
pub struct PieceReader<'a, R> {
    source: &'a mut R,
    pieces: Vec<Piece>,
    starts: Vec<u64>,
    length: u64,
    at: u64,
}
impl<R: Read + Seek> Read for PieceReader<'_, R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.at >= self.length || output.is_empty() {
            return Ok(0);
        }
        let i = self
            .starts
            .partition_point(|start| *start <= self.at)
            .saturating_sub(1);
        let piece = &self.pieces[i];
        let local = self.at - self.starts[i];
        let count = (piece.length - local).min(output.len() as u64) as usize;
        let count = if let Some(text) = &piece.added {
            let start = (piece.start + local) as usize;
            output[..count].copy_from_slice(&text.as_bytes()[start..start + count]);
            count
        } else {
            self.source.seek(SeekFrom::Start(piece.start + local))?;
            let count = self.source.read(&mut output[..count])?;
            if count == 0 {
                return Err(invalid("Truncated immutable JSON source"));
            }
            count
        };
        self.at += count as u64;
        Ok(count)
    }
}
impl<R: Read + Seek> Seek for PieceReader<'_, R> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let next = match position {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::End(n) => self.length as i128 + n as i128,
            SeekFrom::Current(n) => self.at as i128 + n as i128,
        };
        if !(0..=self.length as i128).contains(&next) {
            return Err(invalid("JSON seek outside source"));
        }
        self.at = next as u64;
        Ok(self.at)
    }
}

#[cfg(test)]
mod tests {
    // Historical boundary fixture; this is not the production source policy.
    const MAX_EXPANDED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
    use super::*;
    use std::io::Cursor;
    fn indexed_with_keys(source:&[u8],compact_keys:bool,capacity:usize)->serde_json::Value {
        let mut entries=std::collections::BTreeMap::new();
        {
            let mut scanner=Scanner{input:BufReader::with_capacity(capacity,source),at:0,limit:MAX_EXPANDED_BYTES,
                sink:|ordinal,entry|{entries.insert(ordinal,entry);Ok(())},entries:0,fragment_keys:None,compact_keys,short_names:HashMap::new()};
            scanner.value(0,None,true,"JSON",true,None).unwrap();scanner.whitespace().unwrap();assert!(scanner.peek().unwrap().is_none());
        }
        serde_json::to_value(entries).unwrap()
    }
    #[test]
    fn compact_opaque_keys_preserve_every_indexed_name_field_and_byte_range(){
        let source=br#"{"layers":[{"id":"a","name":"a","style":{"ordinary":{"numbers":[0,1,2.25,-0.0],"no\u0064es":{"named":{"kind":"rect"},"other":{"style":{"layers":[{"id":"deep"}]}}}},"escaped\u006bey":{"layers":[{"name":"unicode-\u96ea"}]}},"points":[{"x":1,"y":2,"nested":{"nodes":{"unnamed":{"foo":true}}}},{"x":3,"y":4}]}]}"#;
        let reference=indexed_with_keys(source,false,65536);
        for capacity in [1,2,3,7,16,64,1024,65536] {assert_eq!(indexed_with_keys(source,true,capacity),reference,"buffer={capacity}");}
        let names=reference.as_object().unwrap().values().filter_map(|v|v["name"].as_str()).collect::<Vec<_>>();
        assert!(names.contains(&"named")&&names.contains(&"unnamed")&&names.contains(&"unicode-雪"));
    }
    #[test]
    fn duplicate_index_keys_still_reject_after_short_name_slots_fill() {
        let entries=(0..80).map(|i|format!(r#""field{i}":null"#)).collect::<Vec<_>>().join(",");
        for repeated in [r#""field0":1"#, r#""field79":2"#, r#""\u0066ield1":false"#] {
            let source=format!("{{{entries},{repeated}}}");
            assert!(index(source.as_bytes(),MAX_EXPANDED_BYTES).unwrap_err().to_string().contains("Duplicate"));
        }
        let nested=format!(r#"{{"id":"outer","layers":[{{{entries}}}],"\u0069d":"again"}}"#);
        assert!(index(nested.as_bytes(),MAX_EXPANDED_BYTES).unwrap_err().to_string().contains("Duplicate"));
    }
    #[test]
    fn nested_subtree_index_keeps_source_context() {
        let source = br#"{"layers":[{"id":"a","frame":{"x":1},"points":[{"x":2}],"layers":[{"id":"b","frame":{"x":3}}]}]}"#;
        let full = index(&source[..], MAX_EXPANDED_BYTES).unwrap();
        let root = full.entries.iter().find(|e| e.id == "a").unwrap();
        let part = &source[root.span.start as usize..root.span.end as usize];
        let local = index_subtree(part, MAX_FRAGMENT_BYTES, root.depth).unwrap();
        assert_eq!(
            local
                .entries
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(local.entries[0].depth, root.depth);
        assert_eq!(local.entries[1].parent, Some(0));
        assert_eq!(full.entries.len(), local.entries.len() + 1);
    }
    #[test]
    fn indexed_offsets_keep_unicode_numbers_and_unknown_fields_exact() {
        let source = br#"{"_class":"page","do_objectID":"p","name":"\u96ea","unknown":1844674407370955161600000,"layers":[{"_class":"rectangle","do_objectID":"a","name":"before","frame":{"x":-0.0,"y":1e-200}}]}"#;
        let tree = index(&source[..], MAX_EXPANDED_BYTES).unwrap();
        let node = tree.entries.iter().find(|e| e.id == "a").unwrap();
        let name = node.fields.iter().find(|f| f.key == "name").unwrap().value;
        let mut changes = Changes::default();
        changes
            .replace(name, br#""after""#.to_vec(), tree.bytes)
            .unwrap();
        let mut output = Vec::new();
        changes
            .export(&mut Cursor::new(source), &mut output, tree.bytes)
            .unwrap();
        assert_eq!(
            String::from_utf8(output).unwrap(),
            String::from_utf8(source.to_vec())
                .unwrap()
                .replace("before", "after")
        );
        assert_eq!(tree.entries[0].name, "雪");
    }
    #[test]
    fn rejects_malformed_unicode_numbers_and_trailing_content() {
        for bad in [
            b"[01]".as_slice(),
            b"[1.]",
            b"[1e]",
            b"{\"a\":1,}",
            b"[true,]",
            b"true false",
            br#""\uD800""#,
            b"\"\xff\"",
            br#"{"a":1,"a":2}"#,
        ] {
            assert!(index(bad, 1024).is_err(), "{bad:?}");
        }
        let mut changes = Changes::default();
        changes
            .replace(Span { start: 1, end: 3 }, b"1".to_vec(), 10)
            .unwrap();
        changes
            .replace(Span { start: 1, end: 2 }, b"22".to_vec(), 10)
            .unwrap();
        assert_eq!(changes.output_bytes(10).unwrap(), 10);
    }
    #[test]
    fn exact_byte_budget_and_bounded_fragments() {
        assert_eq!(index(b"[0]".as_slice(), 3).unwrap().bytes, 3);
        assert!(index(b"[0] ".as_slice(), 3).is_err());
        // A host policy above the former 4 GiB ceiling is accepted; actual
        // bytes remain bounded by the passed policy, not by a wasm allocation.
        assert_eq!(index(b"null".as_slice(), 5 * 1024 * 1024 * 1024).unwrap().bytes, 4);
        assert!(index(b"null".as_slice(), MAX_SOURCE_OFFSET + 1).is_err());
        assert!(
            read_fragment(
                &mut Cursor::new([]),
                Span {
                    start: 0,
                    end: MAX_EXPANDED_BYTES
                }
            )
            .is_err()
        );
    }
}

#[cfg(test)]
#[path = "large_json/fragment_validation_tests.rs"]
mod fragment_validation_tests;
