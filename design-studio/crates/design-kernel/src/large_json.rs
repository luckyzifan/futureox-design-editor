//! Streaming JSON source indexing and copy-through export. This is a storage
//! representation, not a second scene model or a document-admission bypass.
//! Offsets are UTF-8 byte offsets (u64), including on wasm32. Only selected
//! fragments enter the ordinary typed scene/transaction implementation.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::sync::Arc;

pub const MAX_EXPANDED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub const MAX_FRAGMENT_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_INDEX_VALUES: usize = 1_000_000;
const MAX_DEPTH: usize = 128;
const MAX_KEY_BYTES: usize = 16 * 1024;

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

struct Scanner<R, F> {
    input: BufReader<R>,
    at: u64,
    limit: u64,
    sink: F,
    entries: usize,
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
    fn value(
        &mut self,
        depth: usize,
        parent: Option<usize>,
        select: bool,
        label: &str,
        array_children: bool,
        member_start: Option<u64>,
    ) -> io::Result<Span> {
        if depth > MAX_DEPTH {
            return Err(invalid("JSON nesting limit exceeded"));
        }
        self.whitespace()?;
        let start = self.at;
        match self.peek()? {
            Some(b'{') => self.object(depth, parent, select, label, member_start)?,
            Some(b'[') => {
                self.byte()?;
                self.whitespace()?;
                if self.peek()? != Some(b']') {
                    let mut count = 0u64;
                    loop {
                        self.value(
                            depth + 1,
                            parent,
                            array_children,
                            &count.to_string(),
                            false,
                            None,
                        )?;
                        count += 1;
                        self.whitespace()?;
                        if self.peek()? != Some(b',') {
                            break;
                        }
                        self.byte()?;
                    }
                }
                self.expect(b']')?;
            }
            Some(b'"') => {
                self.string(false, 0)?;
            }
            Some(b't') => {
                for b in b"true" {
                    self.expect(*b)?;
                }
            }
            Some(b'f') => {
                for b in b"false" {
                    self.expect(*b)?;
                }
            }
            Some(b'n') => {
                for b in b"null" {
                    self.expect(*b)?;
                }
            }
            Some(b'-' | b'0'..=b'9') => self.number()?,
            _ => return Err(invalid("Invalid JSON value")),
        }
        Ok(Span {
            start,
            end: self.at,
        })
    }
    fn object(
        &mut self,
        depth: usize,
        parent: Option<usize>,
        select: bool,
        label: &str,
        member_start: Option<u64>,
    ) -> io::Result<()> {
        use sha2::{Digest, Sha256};
        let start = self.at;
        self.expect(b'{')?;
        let ordinal = self.entries;
        let mut entry = if select {
            if self.entries >= MAX_INDEX_VALUES {
                return Err(invalid("JSON index working-set limit exceeded"));
            }
            self.entries += 1;
            Some(Entry {
                member: Span::default(),
                id: format!("json:{start}"),
                name: label.into(),
                kind: "object".into(),
                parent,
                depth,
                span: Span::default(),
                fields: Vec::new(),
            })
        } else {
            None
        };
        let owner = if entry.is_some() {
            Some(ordinal)
        } else {
            parent
        };
        let mut keys = HashSet::new();
        let mut field_bytes = 0usize;
        self.whitespace()?;
        if self.peek()? != Some(b'}') {
            loop {
                self.whitespace()?;
                let field_start = self.at;
                let key = self.string(true, MAX_KEY_BYTES)?.unwrap();
                if entry.is_some()
                    && (!keys.insert(<[u8; 32]>::from(Sha256::digest(key.as_bytes())))
                        || keys.len() > MAX_INDEX_VALUES)
                {
                    return Err(invalid("Duplicate or excessive indexed JSON object keys"));
                }
                self.whitespace()?;
                self.expect(b':')?;
                self.whitespace()?;
                let value_start = self.at;
                let metadata = entry.is_some()
                    && matches!(
                        key.as_str(),
                        "do_objectID" | "id" | "name" | "_class" | "kind"
                    );
                let text = if metadata && self.peek()? == Some(b'"') {
                    self.string(true, MAX_KEY_BYTES)?
                } else {
                    None
                };
                if text.is_none() {
                    let nested = (depth == 0 || label == "nodes") && self.peek()? == Some(b'{');
                    self.value(
                        depth + 1,
                        owner,
                        nested,
                        &key,
                        key == "layers" || depth == 0,
                        Some(field_start),
                    )?;
                }
                if let Some(item) = &mut entry {
                    if let Some(text) = text {
                        match key.as_str() {
                            "do_objectID" | "id" => item.id = text,
                            "name" => item.name = text,
                            "_class" | "kind" => item.kind = text,
                            _ => {}
                        }
                    }
                    // A wide collection is navigated through child records, not
                    // an enormous in-memory field table on its parent.
                    if item.fields.len() < 4096
                        && field_bytes.saturating_add(96 + key.len()) <= 512 * 1024
                    {
                        field_bytes += 96 + key.len();
                        item.fields.push(Field {
                            key,
                            member: Span {
                                start: field_start,
                                end: self.at,
                            },
                            value: Span {
                                start: value_start,
                                end: self.at,
                            },
                        });
                    }
                }
                self.whitespace()?;
                if self.peek()? != Some(b',') {
                    break;
                }
                self.byte()?;
            }
        }
        self.expect(b'}')?;
        if let Some(mut item) = entry {
            item.span = Span {
                start,
                end: self.at,
            };
            item.member = Span {
                start: member_start.unwrap_or(start),
                end: self.at,
            };
            (self.sink)(ordinal, item)?;
        }
        Ok(())
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
    if limit == 0 || limit > MAX_EXPANDED_BYTES {
        return Err(invalid("Invalid JSON expanded-byte policy"));
    }
    let mut scanner = Scanner {
        input: BufReader::with_capacity(64 * 1024, reader),
        at: 0,
        limit,
        sink,
        entries: 0,
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
    fn pieces(&self, source_bytes: u64) -> Vec<Piece> {
        self.pieces.clone().unwrap_or_else(|| {
            vec![Piece {
                start: 0,
                length: source_bytes,
                added: None,
            }]
        })
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
        index(json.as_slice(), MAX_FRAGMENT_BYTES)?;
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
        if next_len > MAX_EXPANDED_BYTES {
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
        if length > MAX_EXPANDED_BYTES {
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
    use super::*;
    use std::io::Cursor;
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
        assert_eq!(MAX_EXPANDED_BYTES, 4_294_967_296);
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
