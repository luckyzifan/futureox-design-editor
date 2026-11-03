//! Only the outer Sketch page and material fields are needed for navigation.
//! The authoritative disk index still validates every member and nested field.
use super::super::{
    Result,
    canvas_layout::{self, Box2, Item},
    issue,
};
use serde::de::DeserializeOwned;
use std::{
    fs::File,
    io::{self, BufRead, Read},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

pub(in crate::large_document) struct Part {
    pub name: String,
    pub file: String,
    pub bytes: u64,
}
pub(super) struct Root {
    pub part: usize,
    pub start: u64,
    pub len: u64,
    pub symbol: Option<String>,
}
pub(super) struct Catalog {
    pub items: Vec<Item>,
    pub roots: Vec<Root>,
    pub pages: Vec<(String, String, usize)>,
    pub bounds: Box2,
}

struct Reader<'a, R: BufRead> {
    input: R,
    pos: u64,
    cancel: &'a AtomicBool,
}
fn bad() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid source preview JSON")
}
impl<R: BufRead> Reader<'_, R> {
    fn next(&mut self) -> io::Result<u8> {
        loop {
            let b = self.input.fill_buf()?;
            let n = b.iter().take_while(|v| v.is_ascii_whitespace()).count();
            let next = b.get(n).copied();
            self.input.consume(n);
            self.pos += n as u64;
            if let Some(next) = next {
                return Ok(next);
            }
            if n == 0 {
                return Err(bad());
            }
        }
    }
    fn take(&mut self, b: u8) -> io::Result<()> {
        if self.next()? != b {
            return Err(bad());
        }
        self.input.consume(1);
        self.pos += 1;
        Ok(())
    }
    // Seekable locators allow us to skip even a 60 MiB group in one bounded
    // scan and read its original bytes only if that material is requested.
    fn value(&mut self, keep: bool) -> io::Result<Vec<u8>> {
        let first = self.next()?;
        let complex = matches!(first, b'{' | b'[');
        let string = first == b'"';
        let mut out = Vec::new();
        let mut depth = 0usize;
        let mut quoted = false;
        let mut escaped = false;
        let mut seen = false;
        loop {
            if self.cancel.load(Ordering::Relaxed) {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "Cancelled source preview",
                ));
            }
            let buf = self.input.fill_buf()?;
            if buf.is_empty() {
                return Err(bad());
            }
            let mut n = 0;
            let mut done = false;
            for &b in buf {
                if !complex
                    && !string
                    && (b.is_ascii_whitespace() || matches!(b, b',' | b']' | b'}'))
                {
                    done = true;
                    break;
                }
                n += 1;
                if quoted {
                    if escaped {
                        escaped = false
                    } else if b == b'\\' {
                        escaped = true
                    } else if b == b'"' {
                        quoted = false;
                        if string {
                            done = true;
                            break;
                        }
                    }
                } else if b == b'"' {
                    quoted = true
                } else if complex {
                    match b {
                        b'{' | b'[' => depth = depth.checked_add(1).ok_or_else(bad)?,
                        b'}' | b']' => {
                            depth = depth.checked_sub(1).ok_or_else(bad)?;
                            if depth == 0 {
                                done = true;
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                seen = true;
            }
            if keep {
                if out.len() + n > 64 * 1024 {
                    return Err(bad());
                }
                out.extend_from_slice(&buf[..n])
            }
            self.input.consume(n);
            self.pos += n as u64;
            if done {
                if seen || n > 0 {
                    return Ok(out);
                }
                return Err(bad());
            }
        }
    }
    fn read<T: DeserializeOwned>(&mut self) -> io::Result<T> {
        serde_json::from_slice(&self.value(true)?).map_err(Into::into)
    }
    fn key(&mut self) -> io::Result<String> {
        let k = self.read()?;
        self.take(b':')?;
        Ok(k)
    }
    fn more(&mut self, end: u8) -> io::Result<bool> {
        if self.next()? == end {
            self.take(end)?;
            Ok(false)
        } else {
            self.take(b',')?;
            Ok(true)
        }
    }
    fn material(&mut self, part: usize) -> Result<(Item, Root)> {
        self.next().map_err(issue)?;
        let start = self.pos;
        self.take(b'{').map_err(issue)?;
        let (mut id, mut name, mut kind, mut symbol) =
            (String::new(), String::new(), String::new(), None);
        let mut frame = Box2::default();
        let mut rotation = 0.;
        loop {
            match self.key().map_err(issue)?.as_str() {
                "do_objectID" => id = self.read().map_err(issue)?,
                "name" => name = self.read().map_err(issue)?,
                "_class" => kind = self.read().map_err(issue)?,
                "symbolID" => symbol = self.read().map_err(issue)?,
                "frame" => frame = self.read().map_err(issue)?,
                "rotation" => rotation = self.read().map_err(issue)?,
                _ => {
                    self.value(false).map_err(issue)?;
                }
            }
            if !self.more(b'}').map_err(issue)? {
                break;
            }
        }
        if id.is_empty() || id.len() > 128 || kind.len() > 64 {
            return Err(issue("Invalid source preview identity"));
        }
        let len = self.pos - start;
        Ok((
            Item {
                key: String::new(),
                id,
                name: name.chars().take(160).collect(),
                kind,
                page_id: String::new(),
                page_name: String::new(),
                source: canvas_layout::rotated_bounds(frame, rotation)?,
                placed: Box2::default(),
                bytes: len,
            },
            Root {
                part,
                start,
                len,
                symbol,
            },
        ))
    }
}

pub(in crate::large_document) struct Page {
    id: String,
    name: String,
    rows: Vec<(Item, Root)>,
}

impl Page {
    pub(in crate::large_document) fn len(&self) -> usize {
        self.rows.len()
    }
}

pub(in crate::large_document) fn read_page(
    input: impl BufRead,
    index: usize,
    cancel: &AtomicBool,
) -> Result<Page> {
    let mut r = Reader {
        input,
        pos: 0,
        cancel,
    };
    let (mut id, mut name, mut kind) = (String::new(), String::new(), String::new());
    let mut rows = Vec::new();
    r.take(b'{').map_err(issue)?;
    loop {
        match r.key().map_err(issue)?.as_str() {
            "do_objectID" => id = r.read().map_err(issue)?,
            "name" => name = r.read().map_err(issue)?,
            "_class" => kind = r.read().map_err(issue)?,
            "layers" => {
                r.take(b'[').map_err(issue)?;
                if r.next().map_err(issue)? == b']' {
                    r.take(b']').map_err(issue)?
                } else {
                    loop {
                        if rows.len() >= 16_384 {
                            return Err(issue("Optional thumbnail catalogue is full"));
                        }
                        rows.push(r.material(index)?);
                        if !r.more(b']').map_err(issue)? {
                            break;
                        }
                    }
                }
            }
            _ => {
                r.value(false).map_err(issue)?;
            }
        }
        if !r.more(b'}').map_err(issue)? {
            break;
        }
    }
    if kind != "page" || id.is_empty() || id.len() > 128 {
        return Err(issue("Invalid source preview page"));
    }
    Ok(Page {
        id,
        name: name.chars().take(160).collect(),
        rows,
    })
}
pub(super) fn assemble(input: Vec<Page>) -> Result<Catalog> {
    let mut items = Vec::new();
    let mut roots = Vec::new();
    let mut pages = Vec::new();
    for page in input {
        if pages.len() >= 512
            || items.len() + page.rows.len() > 16_384
            || pages.iter().any(|(k, _, _)| k == &page.id)
        {
            return Err(issue("Optional source preview catalogue unavailable"));
        }
        let count = page.rows.len();
        for (mut item, root) in page.rows {
            item.key = format!("preview-{}", items.len());
            item.page_id = page.id.clone();
            item.page_name = page.name.clone();
            items.push(item);
            roots.push(root);
        }
        pages.push((page.id, page.name, count));
    }
    let bounds = canvas_layout::arrange(&mut items)?;
    Ok(Catalog {
        items,
        roots,
        pages,
        bounds,
    })
}
pub(super) fn read_at(dir: &Path, parts: &[Part], root: &Root) -> Result<serde_json::Value> {
    use std::io::{Seek, SeekFrom};
    if root.len > 64 * 1024 * 1024 {
        return Err(issue("Thumbnail conversion window exceeded"));
    }
    let mut file = File::open(dir.join(&parts[root.part].file)).map_err(issue)?;
    file.seek(SeekFrom::Start(root.start)).map_err(issue)?;
    let mut data = Vec::new();
    file.take(root.len).read_to_end(&mut data).map_err(issue)?;
    if data.len() as u64 != root.len {
        return Err(issue("Truncated thumbnail source"));
    }
    serde_json::from_slice(&data).map_err(issue)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fast_catalogue_uses_only_top_level_layers_and_keeps_original_byte_ranges() {
        let bytes=br#"{"metadata":{"layers":[{"name":"not a material"}]},"layers":[{"layers":[{"name":"quoted \" } ]"}],"name":"first","frame":{"x":1,"y":2,"width":8,"height":6},"rotation":90,"do_objectID":"a","_class":"artboard"},{"_class":"shapePath","do_objectID":"b","name":"second","frame":{"width":5,"height":3}}],"name":"source page","_class":"page","do_objectID":"p"}"#;
        let cancel = AtomicBool::new(false);
        let page = read_page(
            std::io::BufReader::with_capacity(7, bytes.as_slice()),
            4,
            &cancel,
        )
        .unwrap();
        let c = assemble(vec![page]).unwrap();
        assert_eq!(c.pages, vec![("p".into(), "source page".into(), 2)]);
        assert_eq!(c.items[0].id, "a");
        assert!((c.items[0].source.width - 6.).abs() < 1e-8);
        assert_eq!(c.roots[1].part, 4);
        let r = &c.roots[1];
        let original: serde_json::Value =
            serde_json::from_slice(&bytes[r.start as usize..(r.start + r.len) as usize]).unwrap();
        assert_eq!(original["do_objectID"], "b");
        assert!(read_page(bytes.as_slice(), 0, &AtomicBool::new(true)).is_err());
    }
}
