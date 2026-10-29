//! Immutable, indexed native scene storage. Authored semantics remain Document
//! and Node; this is a storage representation, never a second mutation model.
//! The fixed-width disk index has a Merkle proof for every row. Opening never
//! scans all node records or loads the full index; reads authenticate their
//! own lookup path and payload, including file changes after opening.
use crate::scene::{Document, Node};
use serde::{Deserialize, Serialize, ser::SerializeStruct};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};

const MAGIC: &[u8; 8] = b"FXSCENE1";
const ROW_BYTES: u64 = 96;
const FOOTER_BYTES: u64 = 136;
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn check(cancel: &AtomicBool) -> io::Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(io::Error::other("Scene store operation cancelled"))
    } else {
        Ok(())
    }
}
fn sum(a: u64, b: u64) -> io::Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| invalid("Scene store offset overflow"))
}
fn sha(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
fn identity_hash(generation: &str, document: &str) -> [u8; 32] {
    // Strings only: exact unambiguous framing, independent of filesystem names.
    sha(&serde_json::to_vec(&(generation, document)).expect("scene identity strings"))
}
fn word(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

/// A trusted publisher holds this receipt. A file path alone cannot certify
/// another generation, document, footer or index. This is not an edit receipt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Descriptor {
    pub generation: String,
    pub document_id: String,
    pub nodes: u64,
    pub bytes: u64,
    pub footer_hash: [u8; 32],
}

// Borrow the authoritative model's metadata without cloning its node map or
// fonts. Exhaustive destructuring makes new Document fields a compile error.
struct Header<'a>(&'a Document);
impl Serialize for Header<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let Document {
            fd_compatibility,
            reviews,
            design_system,
            prototype,
            schema_version,
            color_management,
            raster_profile,
            id,
            name,
            pages,
            nodes: _,
            fonts,
            animations,
        } = self.0;
        let mut s = serializer.serialize_struct("Document", 13)?;
        s.serialize_field("fdCompatibility", fd_compatibility)?;
        s.serialize_field("reviews", reviews)?;
        s.serialize_field("designSystem", design_system)?;
        s.serialize_field("prototype", prototype)?;
        s.serialize_field("schemaVersion", schema_version)?;
        s.serialize_field("colorManagement", color_management)?;
        s.serialize_field("rasterProfile", raster_profile)?;
        s.serialize_field("id", id)?;
        s.serialize_field("name", name)?;
        s.serialize_field("pages", pages)?;
        s.serialize_field("nodes", &BTreeMap::<String, Node>::new())?;
        s.serialize_field("fonts", fonts)?;
        s.serialize_field("animations", animations)?;
        s.end()
    }
}
#[derive(Serialize)]
struct MetadataRef<'a> {
    generation: &'a str,
    document: Header<'a>,
    warnings: &'a [String],
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    generation: String,
    document: Document,
    warnings: Vec<String>,
}

struct HashWriter<'a, W> {
    inner: W,
    bytes: u64,
    hash: Sha256,
    cancel: &'a AtomicBool,
}
impl<W: Write> Write for HashWriter<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        check(self.cancel)?;
        let n = self.inner.write(bytes)?;
        self.bytes = sum(self.bytes, n as u64)?;
        self.hash.update(&bytes[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}
fn write_json(
    writer: &mut impl Write,
    value: &impl Serialize,
    cancel: &AtomicBool,
) -> io::Result<(u64, [u8; 32])> {
    let mut writer = HashWriter {
        inner: writer,
        bytes: 0,
        hash: Sha256::new(),
        cancel,
    };
    serde_json::to_writer(&mut writer, value).map_err(io::Error::other)?;
    Ok((writer.bytes, writer.hash.finalize().into()))
}
struct HashReader<'a, R> {
    inner: R,
    bytes: u64,
    hash: Sha256,
    cancel: &'a AtomicBool,
}
impl<R: Read> Read for HashReader<'_, R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        check(self.cancel)?;
        let n = self.inner.read(bytes)?;
        self.bytes = sum(self.bytes, n as u64)?;
        self.hash.update(&bytes[..n]);
        Ok(n)
    }
}
fn read_json_from<T: serde::de::DeserializeOwned>(
    source: impl Read,
    length: u64,
    hash: [u8; 32],
    cancel: &AtomicBool,
) -> io::Result<T> {
    let mut reader = HashReader {
        inner: source.take(length),
        bytes: 0,
        hash: Sha256::new(),
        cancel,
    };
    let value = serde_json::from_reader(BufReader::new(&mut reader)).map_err(io::Error::other)?;
    if reader.bytes != length || <[u8; 32]>::from(reader.hash.finalize()) != hash {
        return Err(invalid("Scene record content changed"));
    }
    check(cancel)?;
    Ok(value)
}
fn read_json<T: serde::de::DeserializeOwned>(
    file: &mut File,
    offset: u64,
    length: u64,
    hash: [u8; 32],
    cancel: &AtomicBool,
) -> io::Result<T> {
    file.seek(SeekFrom::Start(offset))?;
    read_json_from(file, length, hash, cancel)
}
/// Independent cursors over one opened immutable file, without cloning a
/// platform file cursor or reopening a path that could now refer elsewhere.
struct RangeReader<'a> {
    file: &'a File,
    position: u64,
    end: u64,
}
impl Read for RangeReader<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let size = (self.end - self.position).min(bytes.len() as u64) as usize;
        if size == 0 {
            return Ok(0);
        }
        #[cfg(unix)]
        let n = std::os::unix::fs::FileExt::read_at(self.file, &mut bytes[..size], self.position)?;
        #[cfg(windows)]
        let n =
            std::os::windows::fs::FileExt::seek_read(self.file, &mut bytes[..size], self.position)?;
        #[cfg(not(any(unix, windows)))]
        let n = return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Positional scene reads unavailable",
        ));
        self.position += n as u64;
        Ok(n)
    }
}
struct MerkleFold {
    levels: [Option<[u8; 32]>; 64],
}
impl MerkleFold {
    fn new() -> Self {
        Self { levels: [None; 64] }
    }
    fn push(&mut self, mut hash: [u8; 32]) {
        for level in &mut self.levels {
            if let Some(left) = level.take() {
                hash = pair_hash(left, hash)
            } else {
                *level = Some(hash);
                return;
            }
        }
        unreachable!("checked tree address space")
    }
    fn root(&self) -> Option<[u8; 32]> {
        let mut values = self.levels.iter().flatten();
        let root = values.next().copied();
        if values.next().is_some() { None } else { root }
    }
}

#[derive(Clone, Copy)]
struct Row {
    key_offset: u64,
    key_bytes: u64,
    value_offset: u64,
    value_bytes: u64,
    key_hash: [u8; 32],
    value_hash: [u8; 32],
}
impl Row {
    fn encode(self) -> [u8; 96] {
        let mut bytes = [0; 96];
        for (i, value) in [
            self.key_offset,
            self.key_bytes,
            self.value_offset,
            self.value_bytes,
        ]
        .iter()
        .enumerate()
        {
            bytes[i * 8..i * 8 + 8].copy_from_slice(&value.to_le_bytes());
        }
        bytes[32..64].copy_from_slice(&self.key_hash);
        bytes[64..96].copy_from_slice(&self.value_hash);
        bytes
    }
    fn decode(bytes: [u8; 96]) -> Self {
        Self {
            key_offset: word(&bytes, 0),
            key_bytes: word(&bytes, 8),
            value_offset: word(&bytes, 16),
            value_bytes: word(&bytes, 24),
            key_hash: bytes[32..64].try_into().unwrap(),
            value_hash: bytes[64..96].try_into().unwrap(),
        }
    }
}
struct OwnedFile {
    path: PathBuf,
    published: bool,
}
impl Drop for OwnedFile {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_file(&self.path);
        }
    }
}
fn index_staging(parent: &Path) -> io::Result<(File, OwnedFile)> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    loop {
        let path = parent.join(format!(
            ".scene-index-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => {
                return Ok((
                    file,
                    OwnedFile {
                        path,
                        published: false,
                    },
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}

fn index_layout(nodes: u64) -> io::Result<(u64, u64, u64)> {
    let bytes = nodes
        .checked_mul(ROW_BYTES)
        .ok_or_else(|| invalid("Scene index size overflow"))?;
    let leaves = nodes
        .max(1)
        .checked_next_power_of_two()
        .ok_or_else(|| invalid("Scene index address overflow"))?;
    let tree = leaves
        .checked_mul(2)
        .and_then(|n| n.checked_sub(1))
        .and_then(|n| n.checked_mul(32))
        .ok_or_else(|| invalid("Scene tree address overflow"))?;
    Ok((bytes, leaves, tree))
}
fn pair_hash(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(left);
    hash.update(right);
    hash.finalize().into()
}
/// Build each tree level with bounded sequential buffers. No node-count-sized
/// index/tree allocation is required at publication or at reader creation.
fn build_tree(
    file: &mut File,
    path: &Path,
    nodes: u64,
    index_bytes: u64,
    leaves: u64,
    cancel: &AtomicBool,
) -> io::Result<()> {
    let mut source = BufReader::new(File::open(path)?);
    file.seek(SeekFrom::Start(sum(index_bytes, (leaves - 1) * 32)?))?;
    {
        let mut output = BufWriter::new(&mut *file);
        for _ in 0..nodes {
            check(cancel)?;
            let mut row = [0; 96];
            source.read_exact(&mut row)?;
            output.write_all(&sha(&row))?;
        }
        for _ in nodes..leaves {
            check(cancel)?;
            output.write_all(&[0; 32])?;
        }
        output.flush()?;
    }
    let mut count = leaves / 2;
    while count > 0 {
        let start = count - 1;
        source.seek(SeekFrom::Start(sum(index_bytes, (2 * start + 1) * 32)?))?;
        file.seek(SeekFrom::Start(sum(index_bytes, start * 32)?))?;
        let mut output = BufWriter::new(&mut *file);
        for _ in 0..count {
            check(cancel)?;
            let mut pair = [0; 64];
            source.read_exact(&mut pair)?;
            output.write_all(&pair_hash(
                pair[..32].try_into().unwrap(),
                pair[32..].try_into().unwrap(),
            ))?;
        }
        output.flush()?;
        count /= 2;
    }
    Ok(())
}

/// Create a new derived store. Never overwrites an existing path. Publication
/// is the returned descriptor after all records/index/footer have been flushed;
/// failed or cancelled writes remove only their own newly-created files.
pub fn write(
    path: &Path,
    generation: &str,
    document: &Document,
    warnings: &[String],
    cancel: &AtomicBool,
) -> io::Result<Descriptor> {
    check(cancel)?;
    let file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let mut owner = OwnedFile {
        path: path.into(),
        published: false,
    };
    let mut output = BufWriter::new(file);
    let (index_file, _index_owner) =
        index_staging(path.parent().unwrap_or_else(|| Path::new(".")))?;
    let mut index = BufWriter::new(index_file);
    output.write_all(MAGIC)?;
    let (metadata_bytes, metadata_hash) = write_json(
        &mut output,
        &MetadataRef {
            generation,
            document: Header(document),
            warnings,
        },
        cancel,
    )?;
    let mut position = sum(8, metadata_bytes)?;
    for (key, node) in &document.nodes {
        check(cancel)?;
        if key != &node.id {
            return Err(invalid("Scene node key does not match its identity"));
        }
        let key_offset = position;
        let key_bytes = key.len() as u64;
        output.write_all(key.as_bytes())?;
        position = sum(position, key_bytes)?;
        let value_offset = position;
        let (value_bytes, value_hash) = write_json(&mut output, node, cancel)?;
        position = sum(position, value_bytes)?;
        let bytes = Row {
            key_offset,
            key_bytes,
            value_offset,
            value_bytes,
            key_hash: sha(key.as_bytes()),
            value_hash,
        }
        .encode();
        index.write_all(&bytes)?;
    }
    let index_offset = position;
    index.flush()?;
    let mut index_file = index.into_inner().map_err(io::Error::other)?;
    let nodes = document.nodes.len() as u64;
    let (index_bytes, leaf_base, tree_bytes) = index_layout(nodes)?;
    build_tree(
        &mut index_file,
        &_index_owner.path,
        nodes,
        index_bytes,
        leaf_base,
        cancel,
    )?;
    index_file.seek(SeekFrom::Start(index_bytes))?;
    let mut index_root = [0; 32];
    index_file.read_exact(&mut index_root)?;
    index_file.seek(SeekFrom::Start(0))?;
    let mut buffer = [0; 64 * 1024];
    loop {
        check(cancel)?;
        let n = index_file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        output.write_all(&buffer[..n])?;
        position = sum(position, n as u64)?;
    }
    if position != sum(sum(index_offset, index_bytes)?, tree_bytes)? {
        return Err(invalid("Incomplete scene index"));
    }
    let mut footer = [0; FOOTER_BYTES as usize];
    footer[0..8].copy_from_slice(&nodes.to_le_bytes());
    footer[8..16].copy_from_slice(&index_offset.to_le_bytes());
    footer[16..24].copy_from_slice(&metadata_bytes.to_le_bytes());
    footer[24..56].copy_from_slice(&metadata_hash);
    footer[56..88].copy_from_slice(&index_root);
    footer[88..96].copy_from_slice(&sum(index_offset, index_bytes)?.to_le_bytes());
    footer[96..128].copy_from_slice(&identity_hash(generation, &document.id));
    footer[128..136].copy_from_slice(MAGIC);
    check(cancel)?;
    output.write_all(&footer)?;
    output.flush()?;
    check(cancel)?;
    let bytes = sum(position, FOOTER_BYTES)?;
    if output.get_ref().metadata()?.len() != bytes {
        return Err(invalid("Scene store write was incomplete"));
    }
    owner.published = true;
    Ok(Descriptor {
        generation: generation.into(),
        document_id: document.id.clone(),
        nodes,
        bytes,
        footer_hash: sha(&footer),
    })
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReadStats {
    pub metadata_reads: u64,
    pub metadata_bytes: u64,
    pub index_bytes_verified: u64,
    pub node_reads: u64,
    pub node_bytes: u64,
    pub key_reads: u64,
}
pub struct Reader {
    file: File,
    index_offset: u64,
    tree_offset: u64,
    leaf_base: u64,
    index_root: [u8; 32],
    metadata_end: u64,
    metadata_hash: [u8; 32],
    generation: String,
    document_id: String,
    nodes: u64,
    metadata: Option<Metadata>,
    stats: ReadStats,
}
impl Reader {
    pub fn open(path: &Path, expected: &Descriptor, cancel: &AtomicBool) -> io::Result<Self> {
        check(cancel)?;
        if !fs::symlink_metadata(path)?.is_file() {
            return Err(invalid("Scene store must be a regular file"));
        }
        let mut file = File::open(path)?;
        if file.metadata()?.len() != expected.bytes || expected.bytes < 8 + FOOTER_BYTES {
            return Err(invalid("Scene store size changed"));
        }
        let mut magic = [0; 8];
        file.read_exact(&mut magic)?;
        if &magic != MAGIC {
            return Err(invalid("Invalid scene store format"));
        }
        file.seek(SeekFrom::Start(expected.bytes - FOOTER_BYTES))?;
        let mut footer = [0; FOOTER_BYTES as usize];
        file.read_exact(&mut footer)?;
        if sha(&footer) != expected.footer_hash
            || &footer[128..] != MAGIC
            || footer[96..128] != identity_hash(&expected.generation, &expected.document_id)
        {
            return Err(invalid("Scene store footer changed"));
        }
        let nodes = word(&footer, 0);
        let index_offset = word(&footer, 8);
        let metadata_bytes = word(&footer, 16);
        let (index_bytes, leaf_base, tree_bytes) = index_layout(nodes)?;
        let tree_offset = word(&footer, 88);
        let metadata_end = sum(8, metadata_bytes)?;
        if nodes != expected.nodes
            || sum(sum(tree_offset, tree_bytes)?, FOOTER_BYTES)? != expected.bytes
            || tree_offset != sum(index_offset, index_bytes)?
            || metadata_end > index_offset
        {
            return Err(invalid("Invalid scene store ranges"));
        }
        let index_root = footer[56..88].try_into().unwrap();
        Ok(Self {
            file,
            index_offset,
            tree_offset,
            leaf_base,
            index_root,
            metadata_end,
            metadata_hash: footer[24..56].try_into().unwrap(),
            generation: expected.generation.clone(),
            document_id: expected.document_id.clone(),
            nodes,
            metadata: None,
            stats: ReadStats::default(),
        })
    }
    pub fn stats(&self) -> ReadStats {
        self.stats
    }
    pub fn node_count(&self) -> u64 {
        self.nodes
    }
    /// Metadata is independently lazy: an ID lookup never reads all page,
    /// font or foreign-format metadata. This header is not a renderable model.
    pub fn metadata(&mut self, cancel: &AtomicBool) -> io::Result<&Document> {
        self.ensure_metadata(cancel)?;
        Ok(&self.metadata.as_ref().unwrap().document)
    }
    fn ensure_metadata(&mut self, cancel: &AtomicBool) -> io::Result<()> {
        check(cancel)?;
        if self.metadata.is_none() {
            let bytes = self.metadata_end - 8;
            let metadata: Metadata =
                read_json(&mut self.file, 8, bytes, self.metadata_hash, cancel)?;
            if metadata.generation != self.generation
                || metadata.document.id != self.document_id
                || !metadata.document.nodes.is_empty()
            {
                return Err(invalid("Scene store identity changed"));
            }
            self.stats.metadata_reads += 1;
            self.stats.metadata_bytes = sum(self.stats.metadata_bytes, bytes)?;
            self.metadata = Some(metadata);
        }
        Ok(())
    }
    fn row(&mut self, ordinal: u64, cancel: &AtomicBool) -> io::Result<Row> {
        check(cancel)?;
        if ordinal >= self.nodes {
            return Err(invalid("Invalid scene node ordinal"));
        }
        self.file
            .seek(SeekFrom::Start(self.index_offset + ordinal * ROW_BYTES))?;
        let mut bytes = [0; 96];
        self.file.read_exact(&mut bytes)?;
        let mut digest = sha(&bytes);
        self.stats.index_bytes_verified = sum(self.stats.index_bytes_verified, ROW_BYTES)?;
        let mut at = self.leaf_base - 1 + ordinal;
        while at > 0 {
            check(cancel)?;
            let sibling = if at % 2 == 1 { at + 1 } else { at - 1 };
            self.file
                .seek(SeekFrom::Start(self.tree_offset + sibling * 32))?;
            let mut other = [0; 32];
            self.file.read_exact(&mut other)?;
            self.stats.index_bytes_verified = sum(self.stats.index_bytes_verified, 32)?;
            digest = if at % 2 == 1 {
                pair_hash(digest, other)
            } else {
                pair_hash(other, digest)
            };
            at = (at - 1) / 2;
        }
        if digest != self.index_root {
            return Err(invalid("Scene store index changed"));
        }
        let row = Row::decode(bytes);
        if row.key_offset < self.metadata_end
            || row.key_bytes == 0
            || row.value_bytes == 0
            || sum(row.key_offset, row.key_bytes)? != row.value_offset
            || sum(row.value_offset, row.value_bytes)? > self.index_offset
        {
            return Err(invalid("Invalid scene node range"));
        }
        Ok(row)
    }
    fn key(&mut self, row: Row, cancel: &AtomicBool) -> io::Result<String> {
        check(cancel)?;
        let length =
            usize::try_from(row.key_bytes).map_err(|_| invalid("Scene key cannot be addressed"))?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(length).map_err(io::Error::other)?;
        bytes.resize(length, 0);
        self.file.seek(SeekFrom::Start(row.key_offset))?;
        self.file.read_exact(&mut bytes)?;
        check(cancel)?;
        if sha(&bytes) != row.key_hash {
            return Err(invalid("Scene node key changed"));
        }
        self.stats.key_reads += 1;
        String::from_utf8(bytes).map_err(io::Error::other)
    }
    fn node(&mut self, key: &str, row: Row, cancel: &AtomicBool) -> io::Result<Node> {
        let node: Node = read_json(
            &mut self.file,
            row.value_offset,
            row.value_bytes,
            row.value_hash,
            cancel,
        )?;
        if node.id != key {
            return Err(invalid("Scene node identity changed"));
        }
        self.stats.node_reads += 1;
        self.stats.node_bytes = sum(self.stats.node_bytes, row.value_bytes)?;
        Ok(node)
    }
    /// Binary-search disk index; no other node payload is decoded or loaded.
    pub fn read_node(&mut self, id: &str, cancel: &AtomicBool) -> io::Result<Option<Node>> {
        let (mut lo, mut hi) = (0, self.nodes);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let row = self.row(mid, cancel)?;
            let key = self.key(row, cancel)?;
            match key.as_str().cmp(id) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => return self.node(id, row, cancel).map(Some),
            }
        }
        check(cancel)?;
        Ok(None)
    }
    /// Compatibility consumer for existing complete-window conversion. Later
    /// demand loaders use read_node and never need this all-node materialization.
    pub fn into_document(mut self, cancel: &AtomicBool) -> io::Result<(Document, Vec<String>)> {
        self.ensure_metadata(cancel)?;
        let Metadata {
            mut document,
            warnings,
            ..
        } = self.metadata.take().unwrap();
        let mut index = BufReader::new(RangeReader {
            file: &self.file,
            position: self.index_offset,
            end: self.tree_offset,
        });
        let mut data = BufReader::new(RangeReader {
            file: &self.file,
            position: self.metadata_end,
            end: self.index_offset,
        });
        let mut previous = None;
        let mut end = self.metadata_end;
        let mut merkle = MerkleFold::new();
        for _ in 0..self.nodes {
            check(cancel)?;
            let mut bytes = [0; 96];
            index.read_exact(&mut bytes)?;
            merkle.push(sha(&bytes));
            let row = Row::decode(bytes);
            if row.key_offset != end
                || row.key_bytes == 0
                || row.value_bytes == 0
                || sum(row.key_offset, row.key_bytes)? != row.value_offset
            {
                return Err(invalid("Noncontiguous scene records"));
            }
            end = sum(row.value_offset, row.value_bytes)?;
            if end > self.index_offset {
                return Err(invalid("Scene node overlaps index"));
            }
            let size = usize::try_from(row.key_bytes)
                .map_err(|_| invalid("Scene key cannot be addressed"))?;
            let mut key = Vec::new();
            key.try_reserve_exact(size).map_err(io::Error::other)?;
            key.resize(size, 0);
            data.read_exact(&mut key)?;
            if sha(&key) != row.key_hash {
                return Err(invalid("Scene node key changed"));
            }
            let key = String::from_utf8(key).map_err(io::Error::other)?;
            if previous.as_ref().is_some_and(|old: &String| old >= &key) {
                return Err(invalid("Scene index order changed"));
            }
            let node: Node = read_json_from(&mut data, row.value_bytes, row.value_hash, cancel)?;
            if node.id != key {
                return Err(invalid("Scene node identity changed"));
            }
            previous = Some(key.clone());
            document.nodes.insert(key, node);
        }
        for _ in self.nodes..self.leaf_base {
            check(cancel)?;
            merkle.push([0; 32]);
        }
        if end != self.index_offset || merkle.root() != Some(self.index_root) {
            return Err(invalid("Scene store index changed"));
        }
        check(cancel)?;
        Ok((document, warnings))
    }
}

#[cfg(test)]
mod tests;
