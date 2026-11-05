//! Immutable, indexed native scene storage. Authored semantics remain Document
//! and Node; this is a storage representation, never a second mutation model.
//! The legacy disk index has a Merkle proof for every row. Mapped mode loads a
//! bounded authenticated rkyv directory; neither open path scans node payloads.
//! Individual payload reads remain authenticated, including later file changes.
use crate::scene::{Document, Node};
use crate::vector_geometry::{GeometryKey,VectorGeometry,packed::PackedGeometry};
use serde::{Deserialize, Serialize, ser::SerializeStruct};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    borrow::Cow,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}},
};
mod record_node;
mod node_json;
mod archive_envelope;
#[cfg(feature="mapped-source-snapshot")]
pub(crate) mod archive;
#[cfg(feature="mapped-source-snapshot")]
mod render_metadata;
use node_json::Decoder;

const MAGIC: &[u8; 8] = b"FXSCENE4";
const GEOMETRY_MAGIC: &[u8;8]=b"FXSCENE3";
const IMAGE_MAGIC: &[u8; 8] = b"FXSCENE2";
const LEGACY_MAGIC: &[u8; 8] = b"FXSCENE1";
const ROW_BYTES: u64 = 96;
const FOOTER_BYTES: u64 = 136;
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn check(cancel: &AtomicBool) -> io::Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(io::Error::other("Scene store operation cancelled"))
    } else {
        crate::render_cancellation::checkpoint().map_err(io::Error::other)
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

// Image payloads remain authored Arc<str> values at every public boundary.
// On disk, a repeated paint references its first earlier node/paint slot.
// Both records use the existing Merkle-authenticated index. A cold node reads
// at most its own record plus the records containing its referenced images;
// it never loads a global image table or unrelated metadata.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ImageSlot { stroke: bool, index: usize }
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ImageAddress { node: String, slot: ImageSlot }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ImageReference { slot: ImageSlot, source: ImageAddress }
#[derive(Serialize)]
struct NodeRecordRef<'a> { #[serde(serialize_with="record_node::without_geometry")] node: Cow<'a, Node>, images: Vec<ImageReference>, #[serde(skip_serializing_if="Option::is_none")] geometry:Option<String>, #[serde(skip_serializing_if="Option::is_none")] vectors:Option<PackedGeometry> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeRecord { node: Node, images: Vec<ImageReference>, #[serde(default)] geometry:Option<String>, #[serde(default)] vectors:Option<PackedGeometry> }
type SharedImages = HashMap<ImageAddress, Arc<str>>;
type SharedGeometry=HashMap<String,Arc<VectorGeometry>>;
fn image_at<'a>(node:&'a Node,slot:&ImageSlot)->Option<&'a Arc<str>> {
    if slot.stroke {node.strokes.get(slot.index)?.paint.image.as_ref()}
    else {node.fills.get(slot.index)?.image.as_ref()}
}
fn image_at_mut<'a>(node:&'a mut Node,slot:&ImageSlot)->Option<&'a mut Option<Arc<str>>> {
    if slot.stroke {Some(&mut node.strokes.get_mut(slot.index)?.paint.image)}
    else {Some(&mut node.fills.get_mut(slot.index)?.image)}
}
fn inline_images(node:&Node)->impl Iterator<Item=(ImageSlot,&Arc<str>)> {
    node.fills.iter().enumerate().filter_map(|(index,p)|p.image.as_ref().map(|image|(ImageSlot{stroke:false,index},image)))
        .chain(node.strokes.iter().enumerate().filter_map(|(index,s)|s.paint.image.as_ref().map(|image|(ImageSlot{stroke:true,index},image))))
}
fn share_record<'a>(node:&'a Node,seen:&mut HashMap<Arc<str>,ImageAddress>,geometries:&mut HashMap<GeometryKey,String>)->io::Result<NodeRecordRef<'a>> {
    let mut record=NodeRecordRef{node:Cow::Borrowed(node),images:Vec::new(),geometry:None,vectors:None};
    if let Some(geometry)=&node.vector_geometry {
        let key=GeometryKey(geometry.clone());
        if let Some(source)=geometries.get(&key){record.geometry=Some(source.clone());}
        else{record.vectors=Some(PackedGeometry::new(geometry).map_err(invalid_owned)?);geometries.insert(key,node.id.clone());}
    }
    for (slot,image) in inline_images(node) {
        if let Some(source)=seen.get(image) {
            *image_at_mut(record.node.to_mut(),&slot).unwrap()=None;
            record.images.push(ImageReference{slot,source:source.clone()});
        }
    }
    for (slot,image) in inline_images(node) {
        seen.entry(image.clone()).or_insert_with(||ImageAddress{node:node.id.clone(),slot});
    }
    Ok(record)
}
fn unpack_record(mut record:NodeRecord)->io::Result<NodeRecord>{
    if let Some(vectors)=record.vectors.take(){
        if record.geometry.is_some()||record.node.vector_geometry.is_some(){return Err(invalid("Ambiguous packed scene geometry"));}
        record.node.vector_geometry=Some(Arc::new(vectors.unpack().map_err(invalid_owned)?));
    }
    record.node.compact_storage();
    Ok(record)
}
fn invalid_owned(message:String)->io::Error{invalid(&message)}
fn restore_record(mut record:NodeRecord,images:&mut SharedImages,geometries:&mut SharedGeometry)->io::Result<Node> {
    if let Some(source)=record.geometry {
        if source>=record.node.id||record.node.vector_geometry.is_some(){return Err(invalid("Invalid scene geometry reference"));}
        record.node.vector_geometry=Some(geometries.get(&source).ok_or_else(||invalid("Missing authenticated scene geometry"))?.clone());
    }else if let Some(geometry)=&record.node.vector_geometry {geometries.entry(record.node.id.clone()).or_insert_with(||geometry.clone());}

    let mut slots=HashSet::new();
    for reference in record.images {
        if reference.source.node>=record.node.id || !slots.insert(reference.slot.clone()) {
            return Err(invalid("Invalid scene image reference order"));
        }
        let target=image_at_mut(&mut record.node,&reference.slot).ok_or_else(||invalid("Missing scene image paint"))?;
        if target.is_some(){return Err(invalid("Ambiguous scene image paint"))}
        *target=Some(images.get(&reference.source).ok_or_else(||invalid("Missing authenticated scene image"))?.clone());
    }
    // References are not valid canonical sources. Only originally inline
    // payloads may be addressed, so chains/cycles cannot accumulate IO/work.
    for (slot,image) in inline_images(&record.node) {
        if !slots.contains(&slot) {images.entry(ImageAddress{node:record.node.id.clone(),slot}).or_insert_with(||image.clone());}
    }
    Ok(record.node)
}
fn read_node_record(source:impl Read,length:u64,hash:[u8;32],shared:bool,cancel:&AtomicBool,scratch:&mut Vec<u8>,decoder:Decoder)->io::Result<NodeRecord> {
    if shared {read_json_from(source,length,hash,cancel,scratch,decoder).and_then(unpack_record)}
    else {read_json_from(source,length,hash,cancel,scratch,decoder).map(|node|NodeRecord{node,images:vec![],geometry:None,vectors:None})}
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
    // Serde emits punctuation and numbers in very small writes. Hashing every
    // token separately made the authenticated store CPU bound even on an SSD.
    // Buffer inside the hashing layer: bytes, digest and cancellation contract
    // stay identical, with at most 64 KiB between cancellation checkpoints.
    {
        let mut buffered = BufWriter::with_capacity(64 * 1024, &mut writer);
        serde_json::to_writer(&mut buffered, value).map_err(io::Error::other)?;
        buffered.flush()?;
    }
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
    mut source: impl Read,
    length: u64,
    hash: [u8; 32],
    cancel: &AtomicBool,
    scratch: &mut Vec<u8>,
    decoder: Decoder,
) -> io::Result<T> {
    // Most scene records are small independent nodes. Slice parsing avoids
    // serde_json's byte-by-byte Read adapter without materializing the whole
    // source. Oversized metadata/images retain the bounded streaming reader.
    const SLICE_LIMIT: u64 = 8 * 1024 * 1024;
    const RETAIN_LIMIT: u64 = 256 * 1024;
    if length <= SLICE_LIMIT {
        check(cancel)?;
        // Keep only a small reusable input buffer per Reader. An unusually
        // large node/image record must not pin megabytes for later tiny reads.
        // DeserializeOwned ensures no returned node borrows this storage.
        let mut temporary = Vec::new();
        let bytes = if length <= RETAIN_LIMIT { scratch } else { &mut temporary };
        bytes.clear();
        bytes.try_reserve_exact(length as usize).map_err(io::Error::other)?;
        bytes.resize(length as usize, 0);
        for chunk in bytes.chunks_mut(64 * 1024) {
            check(cancel)?;
            source.read_exact(chunk)?;
        }
        if sha(&bytes) != hash { return Err(invalid("Scene record content changed")); }
        let value = decoder.parse(bytes)?;
        check(cancel)?;
        return Ok(value);
    }
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
    read_json_from(file, length, hash, cancel, &mut Vec::new(), Decoder::Serde)
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

/// Native source admission tied to the exact placed document. There is no
/// mutable access: taking the document back consumes the proof.
pub struct ValidatedSource(Document);
impl ValidatedSource {
    pub fn new(document: Document) -> Result<Self, String> {
        document.validate_native_source()?;
        Ok(Self(document))
    }
    pub fn into_document(self) -> Document { self.0 }
    pub fn write(&self, path: &Path, generation: &str, warnings: &[String], cancel: &AtomicBool) -> io::Result<Descriptor> {
        write_source(path, generation, SourceToWrite::Validated(self), warnings, cancel)
    }
}
impl std::ops::Deref for ValidatedSource {
    type Target = Document;
    fn deref(&self) -> &Document { &self.0 }
}
#[derive(Clone, Copy)]
enum SourceToWrite<'a> {
    Raw(&'a Document),
    Validated(&'a ValidatedSource),
}
impl<'a> SourceToWrite<'a> {
    fn document(self) -> &'a Document {
        match self { Self::Raw(doc) => doc, Self::Validated(doc) => doc }
    }
    #[cfg(feature="mapped-source-snapshot")]
    fn checked_document(self) -> io::Result<&'a Document> {
        if let Self::Raw(doc) = self {
            doc.validate_native_source().map_err(invalid_owned)?;
        }
        Ok(self.document())
    }
}

/// Create a new derived store. Never overwrites an existing path. Publication
/// is the returned descriptor after all records/index/footer have been flushed;
/// failed or cancelled writes remove only their own newly-created files.
pub fn write(
    path:&Path,generation:&str,document:&Document,warnings:&[String],cancel:&AtomicBool,
) -> io::Result<Descriptor> {
    write_source(path, generation, SourceToWrite::Raw(document), warnings, cancel)
}
fn write_source(
    path:&Path,generation:&str,source:SourceToWrite<'_>,warnings:&[String],cancel:&AtomicBool,
) -> io::Result<Descriptor> {
    let mapped=match std::env::var("CORE_SOURCE_SNAPSHOT_FORMAT").as_deref() {
        Err(std::env::VarError::NotPresent)|Ok("legacy")=>false,
        Ok("mapped")=>true,_=>return Err(invalid("Invalid CORE_SOURCE_SNAPSHOT_FORMAT")),
    };
    #[cfg(not(feature="mapped-source-snapshot"))]
    if mapped {return Err(invalid("Mapped source snapshot support was not compiled"));}
    let base=write_legacy(path,generation,source.document(),warnings,cancel)?;
    #[cfg(feature="mapped-source-snapshot")]
    if mapped {
        return match archive::append(path,base,source,cancel) {
            Ok(descriptor)=>Ok(descriptor),Err(error)=>{let _=fs::remove_file(path);Err(error)},
        };
    }
    Ok(base)
}

/// Explicit migration writes a fresh destination. The source is never
/// modified, and the authenticated complete representation is retained.
#[cfg(feature="mapped-source-snapshot")]
pub fn migrate(source:&Path,expected:&Descriptor,destination:&Path,cancel:&AtomicBool)->io::Result<Descriptor> {
    let source=Reader::open(source,expected,cancel)?;let base=source.prefix.clone();
    let mut output=OpenOptions::new().write(true).create_new(true).open(destination)?;
    let mut owned=OwnedFile{path:destination.into(),published:false};
    let mut input=RangeReader{file:&source.file,position:0,end:base.bytes};let mut buffer=[0u8;64*1024];
    loop {check(cancel)?;let n=input.read(&mut buffer)?;if n==0 {break;}output.write_all(&buffer[..n])?;}
    output.sync_all()?;drop(output);
    // Validate the copied prefix, not a prior view of a mutable source path.
    // All original bytes (including unknown/provenance fields) stay unchanged.
    let (document,_)=Reader::open(destination,&base,cancel)?.into_document(cancel)?;
    let descriptor=archive::append(destination,base,SourceToWrite::Raw(&document),cancel)?;owned.published=true;Ok(descriptor)
}

fn write_legacy(
    path: &Path,
    generation: &str,
    document: &Document,
    warnings: &[String],
    cancel: &AtomicBool,
) -> io::Result<Descriptor> {
    write_format(path,generation,document,warnings,cancel,true)
}
fn write_format(path:&Path,generation:&str,document:&Document,warnings:&[String],cancel:&AtomicBool,shared:bool)->io::Result<Descriptor> {
    let magic=if shared {MAGIC}else{LEGACY_MAGIC};
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
    output.write_all(magic)?;
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
    let mut images=HashMap::new();let mut geometries=HashMap::new();
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
        let (value_bytes, value_hash) = if shared {write_json(&mut output,&share_record(node,&mut images,&mut geometries)?,cancel)?}
            else {write_json(&mut output,node,cancel)?};
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
    footer[128..136].copy_from_slice(magic);
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
impl ReadStats {
    pub(crate) fn since(self,before:Self)->Self {Self{metadata_reads:self.metadata_reads.saturating_sub(before.metadata_reads),
        metadata_bytes:self.metadata_bytes.saturating_sub(before.metadata_bytes),index_bytes_verified:self.index_bytes_verified.saturating_sub(before.index_bytes_verified),
        node_reads:self.node_reads.saturating_sub(before.node_reads),node_bytes:self.node_bytes.saturating_sub(before.node_bytes),key_reads:self.key_reads.saturating_sub(before.key_reads)}}
}
pub struct Reader {
    file: File,
    prefix: Descriptor,
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
    #[cfg(feature="mapped-source-snapshot")]
    render_metadata: Option<Document>,
    stats: ReadStats,
    shared: bool,
    images: SharedImages,
    geometries:SharedGeometry,
    record_scratch: Vec<u8>,
    node_decoder: Decoder,
    archive_format: bool,
    envelope: Option<archive_envelope::Envelope>,
    #[cfg(feature="mapped-source-snapshot")]
    directory: Option<Arc<archive::Directory>>,
    archive_decline: Option<String>,
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
        let envelope=archive_envelope::open(&file,expected,cancel)?;
        let mut archive_decline=None;
        #[cfg(feature="mapped-source-snapshot")]
        let directory=if std::env::var("CORE_SOURCE_LAZY_LOAD").as_deref()==Ok("0") {
            if envelope.is_some(){archive_decline=Some("lazy-loading-disabled".into());}None
        } else if let Some(envelope)=&envelope {
            match archive::Directory::open(&file,envelope,cancel) {
                Ok(directory)=>{if directory.is_none(){archive_decline=Some("archive-index-unavailable".into());}directory},
                Err(error)=>{check(cancel)?;archive_decline=Some(format!("archive-index-declined: {error}"));None},
            }
        } else {None};
        #[cfg(not(feature="mapped-source-snapshot"))]
        if envelope.is_some() {archive_decline=Some("archive-feature-disabled".into());}
        let archive_format=envelope.is_some();
        let expected=envelope.as_ref().map_or(expected,|envelope|&envelope.base);
        let mut magic = [0; 8];
        file.read_exact(&mut magic)?;
        if &magic != MAGIC && &magic != GEOMETRY_MAGIC && &magic != IMAGE_MAGIC && &magic != LEGACY_MAGIC {
            return Err(invalid("Invalid scene store format"));
        }
        file.seek(SeekFrom::Start(expected.bytes - FOOTER_BYTES))?;
        let mut footer = [0; FOOTER_BYTES as usize];
        file.read_exact(&mut footer)?;
        if sha(&footer) != expected.footer_hash
            || footer[128..] != magic
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
            prefix: expected.clone(),
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
            #[cfg(feature="mapped-source-snapshot")]
            render_metadata: None,
            stats: ReadStats::default(),
            shared: &magic!=LEGACY_MAGIC,
            images:HashMap::new(),
            geometries:HashMap::new(),
            record_scratch: Vec::new(),
            node_decoder: Decoder::configured()?,
            archive_format,
            envelope: envelope.clone(),
            #[cfg(feature="mapped-source-snapshot")]
            directory,
            archive_decline,
        })
    }
    pub fn stats(&self) -> ReadStats {
        self.stats
    }
    pub fn node_count(&self) -> u64 {
        self.nodes
    }
    pub fn is_mapped_format(&self)->bool {self.archive_format}
    pub fn archive_fallback_reason(&self)->Option<&str> {self.archive_decline.as_deref()}
    #[cfg(feature="mapped-source-snapshot")]
    pub(crate) fn directory(&self)->Option<Arc<archive::Directory>> {self.directory.clone()}
    #[cfg(feature="mapped-source-snapshot")]
    pub(crate) fn reload_directory(&mut self,cancel:&AtomicBool)->io::Result<()> {
        if self.directory.is_none() && std::env::var("CORE_SOURCE_LAZY_LOAD").as_deref()!=Ok("0") {
            if let Some(envelope)=&self.envelope {
                self.directory=match archive::Directory::open(&self.file,envelope,cancel) {
                    Ok(directory)=>directory,Err(error)=>{check(cancel)?;self.archive_decline=Some(format!("archive-index-declined: {error}"));None},
                };
            }
        }
        Ok(())
    }
    pub(crate) fn release_directory(&mut self) {
        #[cfg(feature="mapped-source-snapshot")]
        {self.directory=None;self.render_metadata=None;}
        self.clear_payload_cache();
    }
    #[cfg(feature="mapped-source-snapshot")]
    pub(crate) fn render_metadata(&mut self,cancel:&AtomicBool)->io::Result<&Document> {
        if self.render_metadata.is_none() {
            let metadata:render_metadata::RenderMetadata=read_json(&mut self.file,8,self.metadata_end-8,self.metadata_hash,cancel)?;
            if metadata.generation!=self.generation {return Err(invalid("Render metadata generation changed"));}
            let document=metadata.document();
            if document.id!=self.document_id {return Err(invalid("Render metadata identity changed"));}
            self.stats.metadata_reads+=1;self.stats.metadata_bytes=sum(self.stats.metadata_bytes,self.metadata_end-8)?;
            self.render_metadata=Some(document);
        }
        Ok(self.render_metadata.as_ref().unwrap())
    }
    /// A demand owns the decoded Arc payloads after return. The reader must
    /// not pin every image/geometry encountered across all past viewports.
    pub(crate) fn clear_payload_cache(&mut self) {self.images.clear();self.geometries.clear();}
    pub(crate) fn read_demand(&mut self,ids:Vec<String>,cancel:&AtomicBool)->io::Result<BTreeMap<String,Node>> {
        self.clear_payload_cache();
        let result=(||{let mut nodes=BTreeMap::new();for id in ids {
            check(cancel)?;let node=self.read_node(&id,cancel)?.ok_or_else(||invalid("Missing demanded source record"))?;nodes.insert(id,node);
        }Ok(nodes)})();
        self.clear_payload_cache();result
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
    fn raw_node(&mut self, key:&str,row:Row,cancel:&AtomicBool)->io::Result<NodeRecord> {
        self.file.seek(SeekFrom::Start(row.value_offset))?;
        let record=read_node_record(&mut self.file,row.value_bytes,row.value_hash,self.shared,cancel,&mut self.record_scratch,self.node_decoder)?;
        if record.node.id!=key {return Err(invalid("Scene node identity changed"));}
        self.stats.node_reads+=1;self.stats.node_bytes=sum(self.stats.node_bytes,row.value_bytes)?;
        Ok(record)
    }
    fn node(&mut self,key:&str,row:Row,cancel:&AtomicBool)->io::Result<Node> {
        let record=self.raw_node(key,row,cancel)?;
        for reference in &record.images {
            check(cancel)?;
            if reference.source.node.as_str()>=key {return Err(invalid("Invalid scene image reference order"));}
            if self.images.contains_key(&reference.source){continue}
            let row=self.find_row(&reference.source.node,cancel)?.ok_or_else(||invalid("Missing scene image source node"))?;
            let source=self.raw_node(&reference.source.node,row,cancel)?;
            if source.images.iter().any(|r|r.slot==reference.source.slot){return Err(invalid("Indirect scene image reference"));}
            let image=image_at(&source.node,&reference.source.slot).ok_or_else(||invalid("Missing scene image source paint"))?;
            self.images.insert(reference.source.clone(),image.clone());
        }
        if let Some(source_id)=&record.geometry {
            if source_id.as_str()>=key{return Err(invalid("Invalid scene geometry reference order"));}
            if !self.geometries.contains_key(source_id) {
                let row=self.find_row(source_id,cancel)?.ok_or_else(||invalid("Missing scene geometry source"))?;
                let source=self.raw_node(source_id,row,cancel)?;
                if source.geometry.is_some(){return Err(invalid("Indirect scene geometry reference"));}
                let geometry=source.node.vector_geometry.ok_or_else(||invalid("Missing inline scene geometry"))?;
                self.geometries.insert(source_id.clone(),geometry);
            }
        }
        restore_record(record,&mut self.images,&mut self.geometries)
    }
    /// Binary-search disk index; no other node payload is decoded or loaded.
    pub fn read_node(&mut self, id: &str, cancel: &AtomicBool) -> io::Result<Option<Node>> {
        match self.find_row(id,cancel)? {Some(row)=>self.node(id,row,cancel).map(Some),None=>Ok(None)}
    }
    fn find_row(&mut self,id:&str,cancel:&AtomicBool)->io::Result<Option<Row>> {
        #[cfg(feature="mapped-source-snapshot")]
        if let Some(directory)=&self.directory {check(cancel)?;return Ok(directory.row(id));}
        let (mut lo, mut hi) = (0, self.nodes);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let row = self.row(mid, cancel)?;
            let key = self.key(row, cancel)?;
            match key.as_str().cmp(id) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => return Ok(Some(row)),
            }
        }
        check(cancel)?;
        Ok(None)
    }
    /// Dense demand fallback: sequential authenticated node records without
    /// decoding global metadata, building a JSON string or N binary searches.
    pub fn read_all_nodes(&mut self, cancel: &AtomicBool) -> io::Result<BTreeMap<String, Node>> {
        let mut nodes = BTreeMap::new();
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
            let record=read_node_record(&mut data,row.value_bytes,row.value_hash,self.shared,cancel,&mut self.record_scratch,self.node_decoder)?;
            let node=restore_record(record,&mut self.images,&mut self.geometries)?;
            if node.id != key {
                return Err(invalid("Scene node identity changed"));
            }
            previous = Some(key.clone());
            self.stats.key_reads += 1;
            self.stats.node_reads += 1;
            self.stats.node_bytes = sum(self.stats.node_bytes, row.value_bytes)?;
            nodes.insert(key, node);
        }
        for _ in self.nodes..self.leaf_base {
            check(cancel)?;
            merkle.push([0; 32]);
        }
        if end != self.index_offset || merkle.root() != Some(self.index_root) {
            return Err(invalid("Scene store index changed"));
        }
        check(cancel)?;
        self.stats.index_bytes_verified =
            sum(self.stats.index_bytes_verified, self.nodes * ROW_BYTES)?;
        Ok(nodes)
    }
    /// Complete consumers explicitly acquire metadata and every node.
    pub fn into_document(mut self, cancel: &AtomicBool) -> io::Result<(Document, Vec<String>)> {
        self.ensure_metadata(cancel)?;
        let Metadata {
            mut document,
            warnings,
            ..
        } = self.metadata.take().unwrap();
        document.nodes = self.read_all_nodes(cancel)?.into();
        Ok((document, warnings))
    }
    /// Explicit complete fallback for a shared lazy reader. Metadata owns no
    /// node payloads; cloning it cannot accidentally publish a partial model.
    pub(crate) fn complete_document(&mut self,cancel:&AtomicBool)->io::Result<Document> {
        #[cfg(feature="mapped-source-snapshot")]
        {self.render_metadata=None;}
        self.ensure_metadata(cancel)?;let mut document=self.metadata.take().unwrap().document;
        self.clear_payload_cache();let nodes=self.read_all_nodes(cancel);self.clear_payload_cache();document.nodes=nodes?.into();Ok(document)
    }
}

#[cfg(test)]
mod tests;
